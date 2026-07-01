// js/data.js - V5.0 多源行情 + 豆包消息 + 减持手动链接

// ---------- 代码解析 ----------
function parseStockCode(raw) {
  if (!raw) return null;
  const clean = raw.trim().toUpperCase().replace(/\s+/g, '');
  const hkMatch = clean.match(/^(\d{1,5})(\.HK)?$/);
  if (hkMatch) {
    const codeNum = hkMatch[1].padStart(5, '0');
    return { secucode: `${codeNum}.HK`, secid: `116.${codeNum}`, code: codeNum, isHK: true };
  }
  const aMatch = clean.match(/^(\d{6})(\.(SZ|SH))?$/);
  if (aMatch) {
    const codeNum = aMatch[1];
    const market = aMatch[3] || (codeNum.startsWith('0') || codeNum.startsWith('3') ? 'SZ' : 'SH');
    const exchange = market === 'SZ' ? '0' : '1';
    return { secucode: `${codeNum}.${market}`, secid: `${exchange}.${codeNum}`, code: codeNum, isHK: false };
  }
  return null;
}

function extractStockCodes(text) {
  if (!text) return [];
  const seen = new Set();
  const codes = [];
  const hkRegex = /\b(\d{1,5})\s*\.?\s*HK\b/gi;
  let match;
  while ((match = hkRegex.exec(text)) !== null) {
    const parsed = parseStockCode(match[0]);
    if (parsed && !seen.has(parsed.secid)) { seen.add(parsed.secid); codes.push(parsed); }
  }
  const aRegex = /\b(\d{6})\s*\.?\s*(SZ|SH)\b/gi;
  while ((match = aRegex.exec(text)) !== null) {
    const parsed = parseStockCode(match[0]);
    if (parsed && !seen.has(parsed.secid)) { seen.add(parsed.secid); codes.push(parsed); }
  }
  return codes;
}

// ---------- 多级行情获取 ----------
async function fetchQuote(parsed) {
  const cacheKey = parsed.secid;
  const cached = Storage.getCachedQuote(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 60000)) return cached;

  const sources = [
    () => fetchQuoteFromDoubao(parsed),
    () => fetchQuoteFromSina(parsed),
    () => fetchQuoteFromTencent(parsed)
  ];
  for (const fn of sources) {
    try {
      const result = await fn();
      if (result && result.price > 0 && result.price < (parsed.isHK ? 2000 : 10000)) {
        Storage.setCachedQuote(cacheKey, result);
        return result;
      }
    } catch (e) {}
  }
  if (cached) return cached;
  throw new Error('所有行情源均不可用');
}

// 豆包联网搜索
async function fetchQuoteFromDoubao(parsed) {
  const apiKey = localStorage.getItem('doubao_api_key') || '';
  if (!apiKey) throw new Error('豆包API未配置');
  const prompt = `请搜索股票 ${parsed.secucode} 的最新行情，返回JSON：{"price":当前价,"changePct":涨跌幅,"source":"豆包","time":"更新时间"}。仅JSON。`;
  const res = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'doubao-lite-32k', // 用户需换成实际模型ID
      messages: [{ role: 'user', content: prompt }],
      enable_search: true,
      stream: false
    })
  });
  const json = await res.json();
  const text = json.choices[0].message.content.trim();
  const data = JSON.parse(text);
  return {
    name: parsed.secucode,
    price: Number(data.price),
    changePct: Number(data.changePct),
    source: '豆包联网',
    updateTime: data.time || new Date().toLocaleTimeString()
  };
}

// 新浪财经
async function fetchQuoteFromSina(parsed) {
  const code = parsed.isHK ? `rt_hk${parsed.code}` : `${parsed.secucode.replace('.','').toLowerCase()}`;
  const res = await fetch(`https://hq.sinajs.cn/list=${code}`);
  const text = await res.text();
  const arr = text.split('=')[1].replace(/"/g,'').split(',');
  if (!arr || arr.length < 5) throw new Error('新浪数据异常');
  return {
    name: arr[0],
    price: parseFloat(arr[3]),
    changePct: parseFloat(arr[4]),
    source: '新浪财经',
    updateTime: new Date().toLocaleTimeString()
  };
}

// 腾讯财经
async function fetchQuoteFromTencent(parsed) {
  const code = parsed.isHK ? `hk${parsed.code}` : `${parsed.secucode.replace('.','').toLowerCase()}`;
  const res = await fetch(`https://qt.gtimg.cn/q=${code}`);
  const text = await res.text();
  const arr = text.split('~');
  if (!arr || arr.length < 10) throw new Error('腾讯数据异常');
  return {
    name: arr[1],
    price: parseFloat(arr[3]),
    changePct: parseFloat(arr[32]),
    source: '腾讯财经',
    updateTime: new Date().toLocaleTimeString()
  };
}

// ---------- 豆包新闻搜索 ----------
async function fetchNewsFromDoubao(parsed) {
  const apiKey = localStorage.getItem('doubao_api_key') || '';
  if (!apiKey) return [];
  const prompt = `请搜索股票 ${parsed.secucode} 最近5条重要新闻，每条包含：标题、来源、摘要、情绪（利好/利空/中性）。返回JSON数组：[{"title":"...","source":"...","summary":"...","sentiment":"利好"}]。`;
  const res = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'doubao-lite-32k',
      messages: [{ role: 'user', content: prompt }],
      enable_search: true,
      stream: false
    })
  });
  const json = await res.json();
  const text = json.choices[0].message.content.trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    return [];
  }
}

// ---------- 构建上下文 ----------
async function buildStockContext(parsed) {
  let quote;
  try { quote = await fetchQuote(parsed); } catch (e) { quote = { name: parsed.secucode, price: null, changePct: null }; }
  const ctx = {
    secucode: parsed.secucode,
    name: quote.name,
    price: quote.price,
    changePct: quote.changePct,
    isHK: parsed.isHK,
    source: quote.source || '未知'
  };
  try {
    const finUrl = parsed.isHK
      ? `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HK_F10_FINANCE_MAININDICATOR&columns=REPORT_DATE,BASIC_EPS,WEIGHTAVG_ROE,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT&filter=(SECURITY_CODE="${parsed.secucode}")&pageNumber=1&pageSize=4`
      : `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_DMSK_FN_MAININDICATOR&columns=REPORT_DATE,BASIC_EPS,WEIGHTAVG_ROE,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT&filter=(SECURITY_CODE="${parsed.code}")&pageNumber=1&pageSize=4`;
    const finRes = await fetch(finUrl);
    if (finRes.ok) {
      const json = await finRes.json();
      if (json?.result?.data?.[0]) {
        const d = json.result.data[0];
        ctx.latestRevenue = d.TOTAL_OPERATE_INCOME;
        ctx.latestProfit = d.PARENT_NETPROFIT;
        ctx.latestROE = d.WEIGHTAVG_ROE;
      }
    }
  } catch (e) {}
  return ctx;
}

function formatContextForAI(ctx) {
  let parts = [`${ctx.name} (${ctx.secucode})`];
  if (ctx.price != null) parts.push(`最新价：${ctx.price.toFixed(ctx.isHK ? 3 : 2)}（来源：${ctx.source}），涨跌：${ctx.changePct?.toFixed(2)}%`);
  if (ctx.latestRevenue) parts.push(`近一期营收：${(ctx.latestRevenue / 1e8).toFixed(2)}亿`);
  return parts.join(' | ');
}

function formatPercent(val) {
  if (val == null) return '--';
  return `${val > 0 ? '+' : ''}${val.toFixed(2)}%`;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function nowStr() { return new Date().toLocaleString('zh-CN', { hour12: false }); }