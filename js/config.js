/**
 * 冠军模式规则与全局配置
 */
const CONFIG = {
  DEEPSEEK_URL: 'https://api.deepseek.com/v1/chat/completions',
  CACHE_TTL: 5 * 60 * 1000, // 5分钟
  REDUCTION_MONTHS: 3,
  AVG_VOLUME_DAYS: 20,

  STORAGE_KEYS: {
    API_KEY: 'champ_ai_api_key',
    MODEL: 'champ_ai_model',
    WATCHLIST: 'champ_ai_watchlist',
    CHAT_HISTORY: 'champ_ai_chat_history',
    DARK_MODE: 'champ_ai_dark_mode',
    QUOTE_CACHE: 'champ_ai_quote_cache',
    RULES: 'champ_ai_rules',
  },

  CHAMPION_SYSTEM_PROMPT: `你是「冠军模式AI投资助手」。每次回复必须严格遵守系统规则，不可违背。

回复结构建议：
- 核心结论（1-2句，不含安慰性语言）
- 数据核查（减持/成交额/财务，逐项列出）
- 风险点
- 逻辑推演

注意：你收到的用户消息中可能包含系统自动附加的实时行情与财务数据，请优先使用这些数据进行分析。`,

  EASTMONEY: {
    QUOTE: 'https://push2.eastmoney.com/api/qt/stock/get',
    KLINE: 'https://push2his.eastmoney.com/api/qt/stock/kline/get',
    DATACENTER: 'https://datacenter-web.eastmoney.com/api/data/v1/get',
    SEARCH: 'https://searchapi.eastmoney.com/api/suggest/get',
  },

  HKEX_DISCLOSURE_URL: 'https://www.hkexnews.hk/index.htm',

  DEFAULT_RULES: [
    '永远客观冷静，不迎合，不安抚用户情绪。',
    '分析任何标的之前，必须核查大股东近3个月减持记录。',
    '分析港股标的之前，必须核查近20日日均成交额，低于1亿港元自动警告。',
    '数据必须标注来源和获取时间，禁止凭记忆或推算给出数据。',
    '永远基于事实和逻辑进行分析，不凭感觉。',
    '当用户判断与事实不符时，直接指出，不委婉，不回避。',
    '在港股，永远选择最纯粹的标的。能买子公司，不买母公司。',
    '当某个板块或标的短期内涨幅超过20%且没有新的基本面催化剂时，禁止追高加仓。',
  ],
};

/**
 * 解析股票代码为 secid 与市场信息
 * @param {string} input - 如 002409.SZ, 600000.SH, 00148.HK, 00700
 * @returns {{ secid: string, market: string, code: string, secucode: string, isHK: boolean } | null}
 */
function parseStockCode(input) {
  const raw = input.trim().toUpperCase();
  if (!raw) return null;

  const suffixMatch = raw.match(/^(\d{4,6})\.(SZ|SH|HK)$/);
  if (suffixMatch) {
    const [, code, suffix] = suffixMatch;
    if (suffix === 'HK') {
      const hkCode = code.padStart(5, '0');
      return {
        secid: `116.${hkCode}`,
        market: 'HK',
        code: hkCode,
        secucode: `${hkCode}.HK`,
        isHK: true,
      };
    }
    const mkt = suffix === 'SZ' ? '0' : '1';
    return {
      secid: `${mkt}.${code}`,
      market: suffix,
      code,
      secucode: `${code}.${suffix}`,
      isHK: false,
    };
  }

  // 纯数字：5位默认港股，6位默认A股
  if (/^\d{5}$/.test(raw)) {
    return {
      secid: `116.${raw}`,
      market: 'HK',
      code: raw,
      secucode: `${raw}.HK`,
      isHK: true,
    };
  }
  if (/^\d{6}$/.test(raw)) {
    const mkt = raw.startsWith('6') ? '1' : '0';
    const suffix = mkt === '1' ? 'SH' : 'SZ';
    return {
      secid: `${mkt}.${raw}`,
      market: suffix,
      code: raw,
      secucode: `${raw}.${suffix}`,
      isHK: false,
    };
  }

  return null;
}

/**
 * 从文本中提取股票代码
 */
function extractStockCodes(text) {
  const patterns = [
    /\d{6}\.(SZ|SH)/gi,
    /\d{4,5}\.HK/gi,
    /\b\d{5}\b/g,
    /\b[036]\d{5}\b/g,
  ];
  const found = new Set();
  for (const p of patterns) {
    const matches = text.match(p);
    if (matches) matches.forEach((m) => found.add(m.toUpperCase()));
  }
  return [...found].map(parseStockCode).filter(Boolean);
}

/**
 * 格式化数字
 */
function formatNumber(num, decimals = 2) {
  if (num == null || isNaN(num)) return '--';
  if (Math.abs(num) >= 1e8) return (num / 1e8).toFixed(2) + '亿';
  if (Math.abs(num) >= 1e4) return (num / 1e4).toFixed(2) + '万';
  return Number(num).toFixed(decimals);
}

function formatPercent(val) {
  if (val == null || isNaN(val)) return '--';
  const prefix = val > 0 ? '+' : '';
  return prefix + Number(val).toFixed(2) + '%';
}

function nowStr() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}
