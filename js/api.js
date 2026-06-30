/**
 * API 调用层：东方财富 + DeepSeek，含重试与缓存
 */

/**
 * 带一次重试的 fetch
 */
async function fetchWithRetry(url, options = {}, retries = 1) {
  let lastError;
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, options);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp;
    } catch (err) {
      lastError = err;
      if (i < retries) await sleep(800);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 获取实时行情
 */
async function fetchQuote(parsed) {
  const cached = Storage.getCachedQuote(parsed.secid);
  if (cached) return { ...cached, fromCache: true };

  const fields = 'f43,f44,f45,f46,f47,f48,f57,f58,f59,f116,f162,f167,f170,f171';
  const url = `${CONFIG.EASTMONEY.QUOTE}?secid=${parsed.secid}&fields=${fields}&_=${Date.now()}`;

  const resp = await fetchWithRetry(url);
  const json = await resp.json();
  const d = json.data;
  if (!d || d.f43 == null) throw new Error(`无法获取 ${parsed.secucode} 行情`);

  const precision = d.f59 != null ? d.f59 : parsed.isHK ? 3 : 2;
  const divisor = Math.pow(10, precision);

  const quote = {
    code: d.f57 || parsed.code,
    name: d.f58 || parsed.secucode,
    price: d.f43 / divisor,
    change: d.f171 != null ? d.f171 / divisor : (d.f170 != null ? d.f170 / 100 : 0),
    changePct: d.f170 != null ? d.f170 / 100 : 0,
    volume: d.f47,
    amount: d.f48,
    marketCap: d.f116,
    pe: d.f162 != null ? d.f162 / 100 : null,
    pb: d.f167 != null ? d.f167 / 100 : null,
    secucode: parsed.secucode,
    secid: parsed.secid,
    isHK: parsed.isHK,
    updateTime: nowStr(),
    source: '东方财富 push2.eastmoney.com',
  };

  Storage.setCachedQuote(parsed.secid, quote);
  return quote;
}

/**
 * 获取近 N 日日均成交额
 */
async function fetchAvgVolume(parsed, days = CONFIG.AVG_VOLUME_DAYS) {
  const url = `${CONFIG.EASTMONEY.KLINE}?secid=${parsed.secid}&klt=101&fqt=0&lmt=${days + 1}&fields1=f1&fields2=f51,f57&_=${Date.now()}`;

  const resp = await fetchWithRetry(url);
  const json = await resp.json();
  const klines = json.data?.klines;
  if (!klines || klines.length === 0) return null;

  const amounts = klines.slice(-days).map((line) => {
    const parts = line.split(',');
    return parseFloat(parts[parts.length - 1]) || 0;
  });

  const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  return {
    days: amounts.length,
    avgAmount: avg,
    avgAmountStr: formatNumber(avg),
    source: '东方财富 push2his.eastmoney.com',
    updateTime: nowStr(),
  };
}

/**
 * 获取 A 股最新财务摘要
 */
async function fetchAShareFinancial(parsed) {
  const filter = encodeURIComponent(`(SECURITY_CODE="${parsed.code}")`);
  const url = `${CONFIG.EASTMONEY.DATACENTER}?reportName=RPT_LICO_FN_CPD&columns=SECUCODE,SECURITY_CODE,SECURITY_NAME,REPORT_DATE,NETPROFIT,PARENTNETPROFIT,ROE,GROSSPROFIT_RATIO,OPERATE_INCOME&filter=${filter}&pageNumber=1&pageSize=3&sortTypes=-1&sortColumns=REPORT_DATE&source=WEB&client=WEB&_=${Date.now()}`;

  try {
    const resp = await fetchWithRetry(url);
    const json = await resp.json();
    const rows = json.result?.data;
    if (!rows || rows.length === 0) return null;

    return rows.map((r) => ({
      reportDate: r.REPORT_DATE?.slice(0, 10),
      netProfit: r.NETPROFIT ?? r.PARENTNETPROFIT,
      revenue: r.OPERATE_INCOME,
      roe: r.ROE,
      grossMargin: r.GROSSPROFIT_RATIO,
    }));
  } catch {
    return null;
  }
}

/**
 * 获取港股最新财务摘要
 */
async function fetchHKFinancial(parsed) {
  const filter = encodeURIComponent(`(SECUCODE="${parsed.secucode}")`);
  const url = `${CONFIG.EASTMONEY.DATACENTER}?reportName=RPT_HKF10_FN_MAININDICATOR&columns=SECUCODE,SECURITY_CODE,SECURITY_NAME,REPORT_DATE,NETPROFIT,OPERATE_INCOME,ROE,GROSS_PROFIT_RATIO&filter=${filter}&pageNumber=1&pageSize=3&sortTypes=-1&sortColumns=REPORT_DATE&source=F10&client=PC&_=${Date.now()}`;

  try {
    const resp = await fetchWithRetry(url);
    const json = await resp.json();
    const rows = json.result?.data;
    if (!rows || rows.length === 0) return null;

    return rows.map((r) => ({
      reportDate: r.REPORT_DATE?.slice(0, 10),
      netProfit: r.NETPROFIT,
      revenue: r.OPERATE_INCOME,
      roe: r.ROE,
      grossMargin: r.GROSS_PROFIT_RATIO,
    }));
  } catch {
    return null;
  }
}

/**
 * 核查大股东减持（港股机构持仓变动，数据源自港交所披露经东方财富汇总）
 */
async function fetchHKReduction(parsed) {
  const since = monthsAgo(CONFIG.REDUCTION_MONTHS);
  const filter = `(SECURITY_CODE="${parsed.code}")(NOTICE_DATE>='${since}')`;
  const reportNames = ['RPT_HK_HOLDER', 'RPT_HKF10_HOLDER_CHANGE', 'RPT_HK_ORG_HLDCHG'];

  for (const reportName of reportNames) {
    try {
      const params = new URLSearchParams({
        reportName,
        columns: 'SECUCODE,SECURITY_CODE,SECURITY_NAME,ORG_NAME,HOLDER_NAME,CHANGE_TYPE,CHANGE_NUM,AFTER_HOLD_NUM,AFTER_HOLD_RATIO,NOTICE_DATE',
        filter,
        pageNumber: '1',
        pageSize: '50',
        sortTypes: '-1',
        sortColumns: 'NOTICE_DATE',
        source: 'WEB',
        client: 'WEB',
        _: Date.now().toString(),
      });
      const resp = await fetchWithRetry(`${CONFIG.EASTMONEY.DATACENTER}?${params}`);
      const json = await resp.json();
      const rows = json.result?.data;
      if (!rows || rows.length === 0) continue;

      const reductions = rows.filter((r) => {
        const type = (r.CHANGE_TYPE || '').toString();
        return type.includes('减') || (r.CHANGE_NUM && parseFloat(r.CHANGE_NUM) < 0);
      });

      return {
        hasReduction: reductions.length > 0,
        records: reductions.slice(0, 10).map((r) => ({
          holder: r.ORG_NAME || r.HOLDER_NAME || '未知股东',
          changeType: r.CHANGE_TYPE,
          changeNum: r.CHANGE_NUM,
          afterRatio: r.AFTER_HOLD_RATIO,
          noticeDate: r.NOTICE_DATE?.slice(0, 10),
        })),
        totalCount: reductions.length,
        since,
        source: '东方财富（港交所披露易汇总）',
        hkexUrl: CONFIG.HKEX_DISCLOSURE_URL,
        updateTime: nowStr(),
      };
    } catch {
      continue;
    }
  }

  return {
    hasReduction: null,
    records: [],
    error: true,
    source: '港交所披露易',
    hkexUrl: CONFIG.HKEX_DISCLOSURE_URL,
    updateTime: nowStr(),
  };
}

/**
 * A 股大股东减持
 */
async function fetchAShareReduction(parsed) {
  const since = monthsAgo(CONFIG.REDUCTION_MONTHS);
  const filter = encodeURIComponent(
    `(SECURITY_CODE="${parsed.code}")(NOTICE_DATE>='${since}')`
  );
  const url = `${CONFIG.EASTMONEY.DATACENTER}?reportName=RPT_SHAREHOLDER_REDUCED&columns=SECUCODE,SECURITY_CODE,SECURITY_NAME,HOLDER_NAME,CHANGE_NUM,AFTER_HOLDNUM,AFTER_HOLD_RATIO,NOTICE_DATE&filter=${filter}&pageNumber=1&pageSize=50&sortTypes=-1&sortColumns=NOTICE_DATE&source=WEB&client=WEB&_=${Date.now()}`;

  try {
    const resp = await fetchWithRetry(url);
    const json = await resp.json();
    const rows = json.result?.data || [];

    return {
      hasReduction: rows.length > 0,
      records: rows.slice(0, 10).map((r) => ({
        holder: r.HOLDER_NAME || '未知股东',
        changeNum: r.CHANGE_NUM,
        afterRatio: r.AFTER_HOLD_RATIO,
        noticeDate: r.NOTICE_DATE?.slice(0, 10),
      })),
      totalCount: rows.length,
      since,
      source: '东方财富 datacenter-web.eastmoney.com',
      updateTime: nowStr(),
    };
  } catch {
    return { hasReduction: null, records: [], error: true, updateTime: nowStr() };
  }
}

/**
 * 聚合标的数据上下文
 */
async function buildStockContext(parsed) {
  const [quote, avgVol, financial, reduction] = await Promise.all([
    fetchQuote(parsed),
    fetchAvgVolume(parsed),
    parsed.isHK ? fetchHKFinancial(parsed) : fetchAShareFinancial(parsed),
    parsed.isHK ? fetchHKReduction(parsed) : fetchAShareReduction(parsed),
  ]);

  return { quote, avgVol, financial, reduction, parsed };
}

/**
 * 将数据上下文格式化为文本供 AI 使用
 */
function formatContextForAI(ctx) {
  const lines = [];
  const { quote, avgVol, financial, reduction } = ctx;

  lines.push(`【实时行情】${quote.name} (${quote.secucode})`);
  lines.push(`  最新价: ${quote.price.toFixed(quote.isHK ? 3 : 2)} | 涨跌幅: ${formatPercent(quote.changePct)}`);
  lines.push(`  市值: ${formatNumber(quote.marketCap)} | PE: ${quote.pe != null ? quote.pe.toFixed(2) : '--'}`);
  lines.push(`  [来源: ${quote.source}, 时间: ${quote.updateTime}${quote.fromCache ? ', 缓存' : ''}]`);

  if (avgVol) {
    lines.push(`\n【近${avgVol.days}日日均成交额】${avgVol.avgAmountStr}`);
    lines.push(`  [来源: ${avgVol.source}, 时间: ${avgVol.updateTime}]`);
    if (quote.isHK && avgVol.avgAmount < 5e7) {
      lines.push(`  ⚠ 流动性警示: 日均成交额低于5000万港元`);
    }
  }

  if (financial && financial.length > 0) {
    lines.push('\n【最新财务数据】');
    financial.forEach((f) => {
      lines.push(`  报告期 ${f.reportDate}: 净利润 ${formatNumber(f.netProfit)} | 营收 ${formatNumber(f.revenue)} | ROE ${f.roe != null ? f.roe + '%' : '--'}`);
    });
    lines.push(`  [来源: 东方财富 datacenter-web.eastmoney.com, 时间: ${nowStr()}]`);
  } else {
    lines.push('\n【最新财务数据】暂无可用数据');
  }

  lines.push('\n【大股东减持核查（近3个月）】');
  if (reduction.error) {
    lines.push(`  数据获取失败，请人工核查港交所披露易: ${CONFIG.HKEX_DISCLOSURE_URL}`);
  } else if (reduction.hasReduction) {
    lines.push(`  ⚠ 发现 ${reduction.totalCount} 条减持记录:`);
    reduction.records.forEach((r) => {
      lines.push(`  - ${r.holder}: ${r.changeType || '减持'} ${r.changeNum || ''} (${r.noticeDate})`);
    });
  } else if (reduction.hasReduction === false) {
    lines.push('  近3个月未发现大股东减持记录');
  } else {
    lines.push('  减持数据暂不可用');
  }
  lines.push(`  [来源: ${reduction.source}, 核查起始: ${reduction.since}, 时间: ${reduction.updateTime}]`);

  return lines.join('\n');
}

/**
 * 调用 DeepSeek API
 */
async function callDeepSeek(messages) {
  const apiKey = Storage.getApiKey();
  if (!apiKey) throw new Error('请先在设置中配置 DeepSeek API 密钥');

  const body = {
    model: Storage.getModel(),
    messages,
    temperature: 0.3,
    max_tokens: 4096,
  };

  const resp = await fetchWithRetry(CONFIG.DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || 'DeepSeek API 错误');

  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回内容为空');
  return content;
}
