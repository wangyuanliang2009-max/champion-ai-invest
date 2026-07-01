/**
 * 股票行情、数据获取、格式化、代码解析
 * 依赖：js/config.js, js/api.js
 */

// 解析用户输入的股票代码，返回标准化对象
function parseStockCode(raw) {
  if (!raw) return null;
  const clean = raw.trim().toUpperCase().replace(/\s+/g, '');
  
  // 港股模式：5位数字.HK 或纯5位数字自动加HK
  const hkMatch = clean.match(/^(\d{1,5})(\.HK)?$/);
  if (hkMatch) {
    const codeNum = hkMatch[1].padStart(5, '0');
    return {
      secucode: `${codeNum}.HK`,
      secid: `116.${codeNum}`,
      code: codeNum,
      isHK: true,
    };
  }
  
  // A股模式：6位数字.SZ/SH 或纯6位数字
  const aMatch = clean.match(/^(\d{6})(\.(SZ|SH))?$/);
  if (aMatch) {
    const codeNum = aMatch[1];
    const market = aMatch[3] || (codeNum.startsWith('0') || codeNum.startsWith('3') ? 'SZ' : 'SH');
    const exchange = market === 'SZ' ? '0' : '1';
    return {
      secucode: `${codeNum}.${market}`,
      secid: `${exchange}.${codeNum}`,
      code: codeNum,
      isHK: false,
    };
  }
  
  return null;
}

// 从文本中提取所有可能的股票代码
function extractStockCodes(text) {
  if (!text) return [];
  const seen = new Set();
  const codes = [];
  
  // 港股模式
  const hkRegex = /\b(\d{1,5})\s*\.?\s*HK\b/gi;
  let match;
  while ((match = hkRegex.exec(text)) !== null) {
    const parsed = parseStockCode(match[0]);
    if (parsed && !seen.has(parsed.secid)) {
      seen.add(parsed.secid);
      codes.push(parsed);
    }
  }
  
  // A股模式
  const aRegex = /\b(\d{6})\s*\.?\s*(SZ|SH)\b/gi;
  while ((match = aRegex.exec(text)) !== null) {
    const parsed = parseStockCode(match[0]);
    if (parsed && !seen.has(parsed.secid)) {
      seen.add(parsed.secid);
      codes.push(parsed);
    }
  }
  
  return codes;
}

// 获取实时行情 (通过东方财富API)
async function fetchQuote(parsed) {
  const cacheKey = parsed.secid;
  const cached = Storage.getCachedQuote(cacheKey);
  if (cached) return cached;

  const url = parsed.isHK
    ? `https://push2.eastmoney.com/api/qt/stock/get?secid=${parsed.secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f55,f57,f58,f60,f116,f117,f162,f167,f169,f170,f171`
    : `https://push2.eastmoney.com/api/qt/stock/get?secid=${parsed.secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f55,f57,f58,f60,f116,f117,f162,f167,f169,f170,f171`;

  const res = await fetch(url);
  const json = await res.json();
  
  if (!json || !json.data) {
    throw new Error('行情数据获取失败');
  }

  const d = json.data;
  const price = d.f43 / 100;
  const changePct = d.f170 / 100; // 涨跌幅
  const name = d.f58 || parsed.secucode;
  
  const result = {
    name,
    price,
    changePct,
    high: d.f44 / 100,
    low: d.f45 / 100,
    volume: d.f47,
    turnover: d.f48,
    updateTime: new Date().toLocaleTimeString(),
  };

  Storage.setCachedQuote(cacheKey, result);
  return result;
}

// 构建发送给AI的股票数据上下文
async function buildStockContext(parsed) {
  const quote = await fetchQuote(parsed);
  
  let ctx = {
    secucode: parsed.secucode,
    name: quote.name,
    price: quote.price,
    changePct: quote.changePct,
    isHK: parsed.isHK,
  };

  // 尝试获取财务摘要（东方财富接口）
  try {
    const finUrl = parsed.isHK
      ? `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HK_F10_FINANCE_MAININDICATOR&columns=REPORT_DATE,BASIC_EPS,WEIGHTAVG_ROE,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT&filter=(SECURITY_CODE="${parsed.secucode}")&pageNumber=1&pageSize=4&sortTypes=-1&sortColumns=REPORT_DATE`
      : `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_DMSK_FN_MAININDICATOR&columns=REPORT_DATE,BASIC_EPS,WEIGHTAVG_ROE,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT&filter=(SECURITY_CODE="${parsed.code}")&pageNumber=1&pageSize=4&sortTypes=-1&sortColumns=REPORT_DATE`;
    
    const finRes = await fetch(finUrl);
    const finJson = await finRes.json();
    if (finJson && finJson.result && finJson.result.data) {
      const latest = finJson.result.data[0];
      if (latest) {
        ctx.latestRevenue = latest.TOTAL_OPERATE_INCOME;
        ctx.latestProfit = latest.PARENT_NETPROFIT;
        ctx.latestROE = latest.WEIGHTAVG_ROE;
      }
    }
  } catch (e) {
    // 财务数据获取失败不影响主流程
    ctx.financeError = true;
  }

  // 尝试获取减持数据（模拟实现，具体可优化）
  try {
    const reduction = await fetchReductionData(parsed);
    ctx.reduction = reduction;
  } catch (e) {
    ctx.reduction = { error: true, msg: '减持数据暂不可用' };
  }

  return ctx;
}

// 获取减持数据（调用东方财富或港交所）
async function fetchReductionData(parsed) {
  // 简化实现，实际可调用港交所披露易或东方财富股东减持接口
  const url = parsed.isHK
    ? `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HK_HOLDERS_CHANGE&columns=HOLDER_NAME,CHANGE_DATE,CHANGE_NUM&filter=(SECURITY_CODE="${parsed.secucode}")&pageNumber=1&pageSize=10`
    : `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_DMSK_HOLDERS_CHANGE&columns=HOLDER_NAME,CHANGE_DATE,CHANGE_NUM&filter=(SECURITY_CODE="${parsed.code}")&pageNumber=1&pageSize=10`;
  
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (json && json.result && json.result.data && json.result.data.length > 0) {
      const records = json.result.data.slice(0, 5).map(r => ({
        holder: r.HOLDER_NAME,
        noticeDate: r.CHANGE_DATE,
        changeNum: r.CHANGE_NUM,
      }));
      return {
        hasReduction: true,
        totalCount: json.result.data.length,
        records,
        source: '东方财富',
        since: new Date(Date.now() - 90*24*60*60*1000).toISOString().slice(0,10),
      };
    }
    return { hasReduction: false, source: '东方财富' };
  } catch (e) {
    return { error: true, msg: '减持数据查询失败' };
  }
}

// 格式化用于AI的上下文
function formatContextForAI(ctx) {
  let parts = [];
  parts.push(`股票：${ctx.name}（${ctx.secucode}）`);
  parts.push(`最新价：${ctx.price?.toFixed(ctx.isHK ? 3 : 2)}，涨跌幅：${ctx.changePct?.toFixed(2)}%`);
  
  if (ctx.latestRevenue) {
    parts.push(`最近一期营收：${(ctx.latestRevenue / 1e8).toFixed(2)}亿`);
  }
  if (ctx.latestProfit) {
    parts.push(`最近一期净利润：${(ctx.latestProfit / 1e8).toFixed(2)}亿`);
  }
  if (ctx.latestROE) {
    parts.push(`ROE：${ctx.latestROE.toFixed(2)}%`);
  }
  
  if (ctx.reduction && !ctx.reduction.error) {
    if (ctx.reduction.hasReduction) {
      parts.push(`⚠ 近期存在大股东减持记录`);
    }
  }
  
  return parts.join('\n');
}

// 格式化百分比
function formatPercent(val) {
  if (val == null) return '--';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

// 休眠函数
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 获取当前时间字符串
function nowStr() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}