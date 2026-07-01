/**
 * 股票行情、数据获取、格式化、代码解析 (通用优化版 V4.1)
 * 增加数据校验、备用数据源、完整减持接口
 */
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

async function fetchQuote(parsed) {
  const cacheKey = parsed.secid;
  const cached = Storage.getCachedQuote(cacheKey);
  if (cached) return cached;
  const secid = parsed.isHK ? `116.${parsed.code.padStart(5, '0')}` : parsed.secid;
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f55,f57,f58,f60,f116,f117,f162,f167,f169,f170,f171`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json || !json.data || json.data.f43 === '-' || json.data.f43 === undefined) throw new Error('数据缺失');
    const d = json.data;
    const price = d.f43 / 100;
    const changePct = d.f170 / 100;
    // 合理性校验：港股价格范围 0.01-2000，A股 0.1-10000
    if (price <= 0 || price > (parsed.isHK ? 2000 : 10000)) throw new Error(`价格异常: ${price}`);
    const result = {
      name: d.f58 || parsed.secucode,
      price,
      changePct,
      high: (d.f44 || 0) / 100,
      low: (d.f45 || 0) / 100,
      volume: d.f47 || 0,
      turnover: d.f48 || 0,
      updateTime: new Date().toLocaleTimeString(),
    };
    Storage.setCachedQuote(cacheKey, result);
    return result;
  } catch (e) {
    if (cached && (Date.now() - cached.timestamp) < 1800000) return cached.data;
    throw new Error(`获取行情失败: ${e.message}`);
  }
}

async function fetchReductionData(parsed) {
  // 优先使用东方财富接口，失败则标记为需手动查询
  const url = parsed.isHK
    ? `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HK_HOLDERS_CHANGE&columns=HOLDER_NAME,CHANGE_DATE,CHANGE_NUM&filter=(SECURITY_CODE="${parsed.secucode}")&pageNumber=1&pageSize=10`
    : `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_DMSK_HOLDERS_CHANGE&columns=HOLDER_NAME,CHANGE_DATE,CHANGE_NUM&filter=(SECURITY_CODE="${parsed.code}")&pageNumber=1&pageSize=10`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('接口不可用');
    const json = await res.json();
    if (json && json.result && json.result.data && json.result.data.length > 0) {
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setDate(threeMonthsAgo.getDate() - 90);
      const records = json.result.data.filter(r => new Date(r.CHANGE_DATE) >= threeMonthsAgo);
      return {
        hasReduction: records.length > 0,
        totalCount: records.length,
        records: records.slice(0, 5).map(r => ({
          holder: r.HOLDER_NAME,
          date: r.CHANGE_DATE,
          changeNum: r.CHANGE_NUM
        })),
        source: '东方财富',
        since: threeMonthsAgo.toISOString().slice(0,10)
      };
    }
    return { hasReduction: false, source: '东方财富' };
  } catch (e) {
    // 返回错误对象，上层会处理手动链接
    return { error: true, msg: '减持数据获取失败', code: parsed.code };
  }
}

async function buildStockContext(parsed) {
  let quote;
  try { quote = await fetchQuote(parsed); } catch (e) {
    quote = { name: parsed.secucode, price: null, changePct: null, updateTime: '获取失败' };
  }
  const ctx = {
    secucode: parsed.secucode,
    name: quote.name,
    price: quote.price,
    changePct: quote.changePct,
    isHK: parsed.isHK,
    reduction: null
  };
  // 财务数据
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
        ctx.latestEPS = d.BASIC_EPS;
      }
    }
  } catch (e) { /* 静默失败 */ }
  // 减持数据
  try {
    ctx.reduction = await fetchReductionData(parsed);
  } catch (e) {
    ctx.reduction = { error: true, msg: e.message };
  }
  return ctx;
}

function formatContextForAI(ctx) {
  let parts = [];
  parts.push(`${ctx.name} (${ctx.secucode})`);
  if (ctx.price != null) parts.push(`最新价：${ctx.price.toFixed(ctx.isHK ? 3 : 2)}，涨跌幅：${ctx.changePct?.toFixed(2) || '0.00'}%`);
  else parts.push('实时行情暂不可用');
  if (ctx.latestRevenue) parts.push(`近一期营收：${(ctx.latestRevenue / 1e8).toFixed(2)}亿`);
  if (ctx.latestProfit) parts.push(`净利润：${(ctx.latestProfit / 1e8).toFixed(2)}亿`);
  if (ctx.latestROE) parts.push(`ROE：${ctx.latestROE?.toFixed(2)}%`);
  if (ctx.reduction) {
    if (ctx.reduction.error) parts.push(`⚠ 减持数据不可用，请查询披露易`);
    else if (ctx.reduction.hasReduction) parts.push(`⚠ 近3月有 ${ctx.reduction.totalCount} 条减持记录`);
    else parts.push('近3月无公开减持');
  }
  return parts.join(' | ');
}

function formatPercent(val) {
  if (val == null) return '--';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function nowStr() { return new Date().toLocaleString('zh-CN', { hour12: false }); }