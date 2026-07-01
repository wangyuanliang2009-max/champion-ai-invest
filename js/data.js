/**
 * 股票行情、数据获取、格式化、代码解析 (通用优化版)
 * 依赖：js/config.js, js/api.js
 */

// 解析用户输入的股票代码，返回标准化对象
function parseStockCode(raw) {
  if (!raw) return null;
  const clean = raw.trim().toUpperCase().replace(/\s+/g, '');
  
  // 港股模式：5位数字.HK 或纯数字自动加HK
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

  // 确保secid格式正确：港股 116.XXXXX，A股 0.XXXXXX 或 1.XXXXXX
  const secid = parsed.isHK ? `116.${parsed.code.padStart(5, '0')}` : parsed.secid;
  
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f55,f57,f58,f60,f116,f117,f162,f167,f169,f170,f171`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    
    if (!json || !json.data || json.data.f43 === '-') {
      throw new Error('行情数据返回异常');
    }

    const d = json.data;
    const price = d.f43 / 100;
    const changePct = d.f170 / 100;
    const name = d.f58 || parsed.secucode;
    
    // 合理性校验：价格不应为负或极端值
    if (price <= 0 || price > 1e6) {
      throw new Error(`价格异常: ${price}`);
    }
    
    const result = {
      name,
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
    // 如果有缓存且数据较新（30分钟内），使用缓存
    if (cached && (Date.now() - cached.timestamp) < 1800000) {
      return cached.data;
    }
    throw new Error(`获取 ${parsed.secucode} 行情失败: ${e.message}`);
  }
}

// 构建发送给AI的股票数据上下文
async function buildStockContext(parsed) {
  let quote;
  try {
    quote = await fetchQuote(parsed);
  } catch (e) {
    // 行情失败时返回基本信息，不中断流程
    return {
      secucode: parsed.secucode,
      name: parsed.secucode,
      price: null,
      changePct: null,
      isHK: parsed.isHK,
      financeError: true,
      reduction: { error: true, msg: '行情获取失败' }
    };
  }
  
  let ctx = {
    secucode: parsed.secucode,
    name: quote.name,
    price: quote.price,
    changePct: quote.changePct,
    isHK: parsed.isHK,
  };

  // 获取财务数据（尝试东方财富数据接口）
  try {
    const finUrl = parsed.isHK
      ? `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HK_F10_FINANCE_MAININDICATOR&columns=REPORT_DATE,BASIC_EPS,WEIGHTAVG_ROE,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT&filter=(SECURITY_CODE="${parsed.secucode}")&pageNumber=1&pageSize=4&sortTypes=-1&sortColumns=REPORT_DATE`
      : `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_DMSK_FN_MAININDICATOR&columns=REPORT_DATE,BASIC_EPS,WEIGHTAVG_ROE,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT&filter=(SECURITY_CODE="${parsed.code}")&pageNumber=1&pageSize=4&sortTypes=-1&sortColumns=REPORT_DATE`;
    
    const finRes = await fetch(finUrl);
    if (finRes.ok) {
      const finJson = await finRes.json();
      if (finJson && finJson.result && finJson.result.data && finJson.result.data.length > 0) {
        const latest = finJson.result.data[0];
        ctx.latestRevenue = latest.TOTAL_OPERATE_INCOME;
        ctx.latestProfit = latest.PARENT_NETPROFIT;
        ctx.latestROE = latest.WEIGHTAVG_ROE;
        ctx.latestEPS = latest.BASIC_EPS;
      }
    }
  } catch (e) {
    ctx.financeError = true;
  }

  // 获取减持数据
  try {
    ctx.reduction = await fetchReductionData(parsed);
  } catch (e) {
    ctx.reduction = { error: true, msg: '减持数据查询失败' };
  }

  return ctx;
}

// 获取减持数据（东方财富接口）
async function fetchReductionData(parsed) {
  // 尝试使用东方财富股东变动接口
  const url = parsed.isHK
    ? `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HK_HOLDERS_CHANGE&columns=HOLDER_NAME,CHANGE_DATE,CHANGE_NUM&filter=(SECURITY_CODE="${parsed.secucode}")&pageNumber=1&pageSize=10`
    : `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_DMSK_HOLDERS_CHANGE&columns=HOLDER_NAME,CHANGE_DATE,CHANGE_NUM&filter=(SECURITY_CODE="${parsed.code}")&pageNumber=1&pageSize=10`;
  
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('接口不可用');
    const json = await res.json();
    if (json && json.result && json.result.data && json.result.data.length > 0) {
      // 筛选近3个月（90天）的记录
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setDate(threeMonthsAgo.getDate() - 90);
      const recentRecords = json.result.data.filter(r => {
        const noticeDate = new Date(r.CHANGE_DATE);
        return noticeDate >= threeMonthsAgo;
      });
      if (recentRecords.length > 0) {
        return {
          hasReduction: true,
          totalCount: recentRecords.length,
          records: recentRecords.slice(0, 5).map(r => ({
            holder: r.HOLDER_NAME,
            noticeDate: r.CHANGE_DATE,
            changeNum: r.CHANGE_NUM,
          })),
          source: '东方财富',
          since: threeMonthsAgo.toISOString().slice(0,10),
        };
      }
      return { hasReduction: false, source: '东方财富' };
    }
    return { error: true, msg: '数据格式异常' };
  } catch (e) {
    return { error: true, msg: e.message };
  }
}

// 格式化用于AI的上下文
function formatContextForAI(ctx) {
  let parts = [];
  parts.push(`股票：${ctx.name}（${ctx.secucode}）`);
  if (ctx.price != null) {
    parts.push(`最新价：${ctx.price.toFixed(ctx.isHK ? 3 : 2)}，涨跌幅：${ctx.changePct?.toFixed(2)}%`);
  } else {
    parts.push('实时行情暂不可用');
  }
  
  if (ctx.latestRevenue) {
    parts.push(`最近一期营收：${(ctx.latestRevenue / 1e8).toFixed(2)}亿`);
  }
  if (ctx.latestProfit) {
    parts.push(`最近一期净利润：${(ctx.latestProfit / 1e8).toFixed(2)}亿`);
  }
  if (ctx.latestROE) {
    parts.push(`ROE：${ctx.latestROE.toFixed(2)}%`);
  }
  
  if (ctx.reduction) {
    if (ctx.reduction.error) {
      parts.push(`⚠ 减持数据获取失败，请手动查询港交所披露易`);
    } else if (ctx.reduction.hasReduction) {
      parts.push(`⚠ 近期存在大股东减持记录（${ctx.reduction.totalCount}条）`);
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