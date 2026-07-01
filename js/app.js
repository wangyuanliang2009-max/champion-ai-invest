/**
 * 冠军模式 AI 投资助手 - 主应用逻辑 (V4.0 稳定版)
 * 包含：深度分析框架、内循环自校验、防幻觉、多模式、UZI指令、减持与利空链接
 */

// ===== 全局配置 =====
const MAX_SELF_CORRECT_LOOP = 2; // 内循环最大迭代次数

// ===== 快捷选择器 =====
const $ = (sel) => document.querySelector(sel);

// ===== DOM 引用 =====
const watchlistEl = $('#watchlist');
const chatMessagesEl = $('#chatMessages');
const chatInputEl = $('#chatInput');
const stockInputEl = $('#stockInput');
const statusTextEl = $('#statusText');
const statusTimeEl = $('#statusTime');
const reductionAlertEl = $('#reductionAlert');
const loadingOverlay = $('#loadingOverlay');
const quickActionsEl = $('#quickActions');
const fileInput = $('#fileInput');
const rulesBadgeEl = $('#rulesBadge');

let selectedStock = null;
let chatHistory = [];
let watchlist = [];
let currentMode = 'chat';

// ===== 初始化 =====
function init() {
  applyTheme(Storage.isDarkMode());
  watchlist = Storage.getWatchlist();
  chatHistory = Storage.getChatHistory();

  renderWatchlist();
  renderChatHistory();
  bindEvents();
  RulesManager.init();

  if (watchlist.length > 0) refreshAllQuotes();
  setStatus('就绪 | 选择分析模式开始');
}

function bindEvents() {
  // 基础操作
  $('#btnDarkMode').addEventListener('click', toggleDarkMode);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnAddStock').addEventListener('click', addStock);
  stockInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') addStock(); });
  $('#btnRefreshWatchlist').addEventListener('click', refreshAllQuotes);
  $('#btnSend').addEventListener('click', () => sendMessage());
  chatInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('#btnClearChat').addEventListener('click', clearChat);

  // 模式切换
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode));
  });

  // 快速操作芯片
  quickActionsEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('chip')) {
      handleQuickAction(e.target.dataset.action);
    }
  });

  // 文件上传（暂提示）
  const uploadLabel = document.querySelector('.upload-label');
  if (uploadLabel) {
    uploadLabel.addEventListener('click', () => setStatus('文件分析功能即将上线'));
  }

  // 自选股右键移除
  watchlistEl.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.watchlist-item');
    if (item) {
      e.preventDefault();
      const secid = item.dataset.secid;
      if (confirm('从自选列表移除？')) removeStock(secid);
    }
  });

  // 点击自选股带入对话
  watchlistEl.addEventListener('click', (e) => {
    const item = e.target.closest('.watchlist-item');
    if (item) selectStock(item.dataset.secid);
  });

  // 移动端导航
  $('#navChat')?.addEventListener('click', () => RulesManager.showView('chat'));
  $('#navRules')?.addEventListener('click', () => RulesManager.showView('rules'));
}

// ===== 模式切换 =====
function switchMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-mode="${mode}"]`).classList.add('active');
  chatInputEl.placeholder = {
    'chat': '输入股票代码或分析指令...',
    'premarket': '盘前速览：自动扫描自选股异动...',
    'postmarket': '盘后体检：对持仓进行全面复查...',
    'info': '粘贴产业新闻、研报或投资信息...'
  }[mode] || '输入分析指令...';
  setStatus(`已切换到${document.querySelector(`.tab[data-mode="${mode}"]`).textContent}模式`);
}

// ===== 快速操作处理 =====
async function handleQuickAction(action) {
  const stock = selectedStock?.secucode || watchlist[0]?.secucode || '';
  if (!stock && ['deep_analyze', 'quick_scan', 'risk_check', 'valuation'].includes(action)) {
    setStatus('请先在左侧选择或添加一只股票');
    return;
  }
  const prompts = {
    'deep_analyze': `/deep_analyze ${stock}`,
    'quick_scan': `/quick_scan ${stock}`,
    'risk_check': `/risk_check ${stock}`,
    'valuation': `/valuation ${stock}`,
    'debate': `请对 ${stock} 进行一次多空辩论，列出至少3条看多理由和3条看空理由。`,
    'info_extract': '请从以下内容中提取所有可能受益的A股/港股标的，并给出逻辑链条：\n\n' + chatInputEl.value
  };
  chatInputEl.value = prompts[action] || '';
  if (action === 'info_extract' && chatInputEl.value.trim()) sendMessage();
  else if (action !== 'info_extract') sendMessage();
}

// ===== 自选股管理 =====
function addStock() {
  const raw = stockInputEl.value.trim();
  const parsed = parseStockCode(raw);
  if (!parsed) {
    setStatus('无效股票代码，格式如 002409.SZ 或 00148.HK');
    return;
  }
  if (watchlist.some(s => s.secid === parsed.secid)) {
    setStatus('该股票已在自选列表中');
    return;
  }
  watchlist.push({
    secid: parsed.secid,
    secucode: parsed.secucode,
    code: parsed.code,
    name: parsed.secucode,
    isHK: parsed.isHK,
  });
  Storage.setWatchlist(watchlist);
  stockInputEl.value = '';
  renderWatchlist();
  refreshQuote(parsed.secid);
  setStatus(`已添加 ${parsed.secucode}`);
}

function removeStock(secid) {
  watchlist = watchlist.filter(s => s.secid !== secid);
  Storage.setWatchlist(watchlist);
  if (selectedStock?.secid === secid) selectedStock = null;
  renderWatchlist();
}

function selectStock(secid) {
  selectedStock = watchlist.find(s => s.secid === secid);
  renderWatchlist();
  const code = selectedStock?.secucode || '';
  chatInputEl.value = chatInputEl.value || `请分析 ${code} `;
  chatInputEl.focus();
}

async function refreshQuote(secid) {
  const item = watchlist.find(s => s.secid === secid);
  if (!item) return;
  try {
    const parsed = parseStockCode(item.secucode);
    const quote = await fetchQuote(parsed);
    item.name = quote.name;
    item.price = quote.price;
    item.changePct = quote.changePct;
    item.updateTime = quote.updateTime;
    Storage.setWatchlist(watchlist);
    renderWatchlist();
    statusTimeEl.textContent = `数据更新时间：${quote.updateTime}`;
  } catch (err) {
    setStatus(`刷新 ${item.secucode} 失败: ${err.message}`);
  }
}

async function refreshAllQuotes() {
  setStatus('正在刷新行情…');
  for (const item of watchlist) {
    await refreshQuote(item.secid);
    await sleep(300);
  }
  setStatus('行情刷新完成');
}

function renderWatchlist() {
  if (watchlist.length === 0) {
    watchlistEl.innerHTML = '<li class="watchlist-empty">暂无自选股<br>添加代码开始追踪</li>';
    return;
  }
  watchlistEl.innerHTML = watchlist.map(s => {
    const changeClass = (s.changePct || 0) >= 0 ? 'up' : 'down';
    const priceStr = s.price != null ? s.price.toFixed(s.isHK ? 3 : 2) : '--';
    const changeStr = s.changePct != null ? formatPercent(s.changePct) : '--';
    const active = selectedStock?.secid === s.secid ? ' active' : '';
    return `
      <li class="watchlist-item${active}" data-secid="${s.secid}">
        <span class="stock-name">${escapeHtml(s.name)}</span>
        <span class="stock-code">${s.secucode}</span>
        <span class="stock-price">${priceStr}</span>
        <span class="stock-change ${changeClass}">${changeStr}</span>
      </li>`;
  }).join('');
}

// ===== 核心：发送消息 + 内循环自校验 =====
async function sendMessage() {
  const text = chatInputEl.value.trim();
  if (!text) return;

  if (!Storage.getApiKey()) {
    openSettings();
    setStatus('请先配置 DeepSeek API 密钥');
    return;
  }

  SpeechManager.stop();

  const userMsg = {
    id: genId(),
    role: 'user',
    content: text,
    time: nowStr(),
    stockCodes: []
  };
  chatHistory.push(userMsg);
  Storage.setChatHistory(chatHistory);
  appendMessageUI(userMsg);
  chatInputEl.value = '';
  scrollToBottom();

  showLoading(true);
  setStatus('正在执行 Maker-Verifier 自校验循环...');

  try {
    const codes = extractStockCodes(text);
    if (selectedStock && !codes.some(c => c.secid === selectedStock.secid)) {
      codes.unshift(parseStockCode(selectedStock.secucode));
    }
    userMsg.stockCodes = codes.map(c => c.secucode);

    let dataContext = '';
    let reductionInfo = null;
    if (codes.length > 0) {
      const contexts = [];
      for (const parsed of codes.slice(0, 3)) {
        try {
          const ctx = await buildStockContext(parsed);
          contexts.push(formatContextForAI(ctx));
          if (parsed.isHK && ctx.reduction) reductionInfo = ctx.reduction;
          else if (!parsed.isHK && ctx.reduction) reductionInfo = ctx.reduction;
          statusTimeEl.textContent = `数据更新时间：${nowStr()}`;
        } catch (err) {
          contexts.push(`【${parsed.secucode}】数据获取失败: ${err.message}`);
        }
      }
      dataContext = contexts.join('\n\n');
    }

    showReductionAlert(reductionInfo, codes);

    const userContent = dataContext
      ? `${text}\n\n--- 系统自动附加的实时数据 ---\n${dataContext}`
      : text;

    // 构建系统提示词（防幻觉 + 规则）
    const systemPrompt = buildSystemPrompt();

    // 检测UZI指令，添加深度分析框架
    let enhancedUserContent = userContent;
    const uziMatch = text.match(/^\/(deep_analyze|quick_scan|risk_check|valuation)\s+(\w+)/);
    if (uziMatch) {
      enhancedUserContent = buildUziPrompt(uziMatch[1], uziMatch[2]) + '\n\n' + userContent;
    }

    // Maker-Verifier 内循环
    let finalReply = '';
    for (let i = 0; i < MAX_SELF_CORRECT_LOOP; i++) {
      const makerMessages = [
        { role: 'system', content: systemPrompt },
        ...chatHistory.filter(m => m.role === 'user' || m.role === 'assistant').slice(-5).map(m => ({ role: m.role, content: m.content }))
      ];
      // 将最后一条user消息替换为带增强数据的内容
      makerMessages[makerMessages.length - 1] = { role: 'user', content: enhancedUserContent };

      const draftReply = await callDeepSeek(makerMessages);

      const verifierMessages = [
        { role: 'system', content: '你是严格的分析结果校验者。请检查以下AI回复是否符合所有规则，尤其注意：是否引用了不存在的价格/数据？是否在数据缺失时强行编造？是否明确说明了数据来源？请给出具体的修改意见，如果完全合规请回复PASS。' },
        { role: 'user', content: draftReply }
      ];
      const checkResult = await callDeepSeek(verifierMessages);

      if (checkResult.trim().toUpperCase() === 'PASS') {
        finalReply = draftReply;
        break;
      } else {
        enhancedUserContent += `\n\n【系统校验反馈（第${i+1}轮）】\n${checkResult}\n请修正分析。`;
        setStatus(`第${i+1}轮自我校验未通过，正在修正...`);
      }
    }
    if (!finalReply) finalReply = '分析过程达到最大迭代次数，但仍可能存在缺陷。';

    const assistantMsg = {
      id: genId(),
      role: 'assistant',
      content: finalReply,
      dataContext: dataContext || null,
      time: nowStr(),
      stockCodes: userMsg.stockCodes
    };
    chatHistory.push(assistantMsg);
    Storage.setChatHistory(chatHistory);
    appendMessageUI(assistantMsg);
    setStatus('分析完成（经内循环校验）');
  } catch (err) {
    const errMsg = {
      id: genId(),
      role: 'assistant',
      content: `分析失败: ${err.message}`,
      time: nowStr(),
      stockCodes: []
    };
    chatHistory.push(errMsg);
    appendMessageUI(errMsg);
    setStatus(`错误: ${err.message}`);
  } finally {
    showLoading(false);
    scrollToBottom();
  }
}

// ===== UZI 深度分析框架（66位评审团） =====
function buildUziPrompt(command, stockCode) {
  // 通用分析框架
  const framework = `
【深度分析框架：66位评审团×9大流派×22维数据】
你将扮演由66位投资大师组成的评审团，对股票【${stockCode}】进行全面分析。评审团包括价值派、成长派、趋势派、量化派、游资派、逆向派、事件驱动派、宏观对冲派和技术派，各派别必须独立表达观点。

请严格遵循以下结构输出报告（使用Markdown格式）：

## 一、公司速览
- 主营业务、行业地位、市值规模
- 实际控制人与管理层稳定性
- 近期重大事件（减持、回购、诉讼等）

## 二、财务深度透视
- 近3年营收/净利润/现金流趋势
- 盈利能力（毛利率、ROE、净利率）及变化原因
- 资产负债结构与偿债能力
- 应收账款/存货异常风险

## 三、行业与竞争格局
- 赛道景气度（政策支持、市场需求）
- 竞争对手对比（市占率、技术壁垒）
- 上游议价与下游定价权

## 四、估值与预期
- 当前PE/PB/PS历史分位
- DCF现金流折现估算（假设条件）
- 与国内外同行估值对比
- 未来两年盈利预期及增长驱动

## 五、多空辩论（必选）
至少3条看多理由 vs 3条看空理由，每条需注明代表流派（如：价值派看空，因为PB高于行业均值）。

## 六、风险评估
- 大股东减持/质押风险
- 行业政策风险
- 技术替代风险
- 财务造假/暴雷概率

## 七、投资建议
- 综合评分（1-10分）
- 红绿灯评级：🟢强烈看好 / 🟡谨慎看好 / ⚪中性 / 🟠存在风险 / 🔴强烈回避
- 适合什么类型的投资者（长线价值/波段趋势/短线游资）

【重要原则】
- 所有数据必须标注来源（如“根据2025年年报”、“东方财富实时行情”）。
- 如果实时数据缺失，必须明确说明“当前无法获取该数据”，然后基于最近一期公开财报分析。
- 估值部分必须列出假设条件，避免给出不负责任的精确数字。
- 严禁使用训练数据中的过时股价或财务信息。
`;

  switch (command) {
    case 'deep_analyze':
      return framework + '\n请进行最详尽的深度分析，报告不少于2000字。';
    case 'quick_scan':
      return `请对【${stockCode}】进行30秒快速扫描，只输出：当前价格、涨跌幅、核心风险指标、1句话建议。`;
    case 'risk_check':
      return `请扮演审计师，专门排查【${stockCode}】的潜在风险：财务异常、大股东掏空、监管处罚、行业利空等，输出风险清单。`;
    case 'valuation':
      return `请使用DCF、PE、PB、PS等多种方法对【${stockCode}】进行估值，给出合理估值区间，并说明假设。`;
    default:
      return `请分析 ${stockCode}`;
  }
}

// ===== 消息展示 =====
function appendMessageUI(msg, animate = true) {
  const div = document.createElement('div');
  div.className = `message ${msg.role}`;
  if (!animate) div.style.animation = 'none';

  let actionsHtml = '';
  if (msg.role === 'assistant') {
    actionsHtml = `
      <div class="message-actions speech-controls" data-msg-id="${msg.id}">
        <button class="btn btn-sm btn-speech-start" data-action="start">🔊 朗读</button>
        <button class="btn btn-sm btn-speech-pause" data-action="pause" disabled>⏸ 暂停</button>
        <button class="btn btn-sm btn-speech-stop" data-action="stop" disabled>⏹ 停止</button>
      </div>`;
  }

  let contextHtml = '';
  if (msg.dataContext) {
    contextHtml = `<div class="data-context">${escapeHtml(msg.dataContext)}</div>`;
  }

  let manualLinksHtml = '';
  if (msg.stockCodes && msg.stockCodes.length > 0) {
    msg.stockCodes.forEach(code => {
      if (code.includes('.SZ') || code.includes('.SH')) {
        manualLinksHtml += getAShareShareholding(code) + '<br>';
      }
      manualLinksHtml += getNegativeNews(code) + '<br>';
    });
  }

  div.innerHTML = `
    <div class="message-bubble">${escapeHtml(msg.content)}${contextHtml}${manualLinksHtml ? '<hr>' + manualLinksHtml : ''}</div>
    <div class="message-meta">${msg.time || ''}</div>
    ${actionsHtml}`;

  chatMessagesEl.appendChild(div);

  if (msg.role === 'assistant') {
    const controls = div.querySelector('.speech-controls');
    controls.querySelector('[data-action="start"]').addEventListener('click', () => {
      SpeechManager.speak(msg.content, msg.id);
    });
    controls.querySelector('[data-action="pause"]').addEventListener('click', () => SpeechManager.pause());
    controls.querySelector('[data-action="stop"]').addEventListener('click', () => SpeechManager.stop());
  }
}

function renderChatHistory() {
  chatMessagesEl.innerHTML = '';
  if (chatHistory.length === 0) {
    chatMessagesEl.innerHTML = '<div class="chat-placeholder">输入股票代码或分析指令开始</div>';
  } else {
    chatHistory.forEach(msg => appendMessageUI(msg, false));
  }
  scrollToBottom();
}

// ===== 减持与利空提示 =====
function showReductionAlert(reduction, codes) {
  if (!reduction || !codes.some(c => c.isHK)) {
    reductionAlertEl.classList.add('hidden');
    return;
  }
  reductionAlertEl.classList.remove('hidden');
  if (reduction.error) {
    const hkCodeNum = (codes[0]?.code || '').replace('.HK', '');
    const hkexUrl = `https://sc.hkexnews.hk/TuniS/di.hkex.com.hk/di/NSSrchCorp.aspx?src=MAIN&lang=ZH&g_lang=zh-HK&stockid=${hkCodeNum}`;
    reductionAlertEl.innerHTML = `
      <strong>港股减持核查</strong>：自动数据获取失败。<br>
      <a href="${hkexUrl}" target="_blank">点击查询港交所披露易（${hkCodeNum}）</a>
      <br><small>（通常于交易日 16:30-23:00 更新）</small>`;
    return;
  }
  if (reduction.hasReduction) {
    const list = reduction.records.slice(0, 3).map(r => `${r.holder} (${r.noticeDate})`).join('；');
    reductionAlertEl.innerHTML = `
      <strong>⚠ 减持警示</strong>：近3个月发现 ${reduction.totalCount} 条大股东/机构减持记录。${list}
      <br><small>数据来源：${reduction.source}</small>`;
  } else {
    reductionAlertEl.innerHTML = `<strong>减持核查</strong>：近3个月未发现大股东减持记录。`;
  }
}

// ===== 辅助函数 =====
function setStatus(text) { statusTextEl.textContent = text; }
function showLoading(show) { loadingOverlay.classList.toggle('hidden', !show); }
function scrollToBottom() { chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight; }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escapeHtml(str) { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ===== 语音管理 =====
const SpeechManager = {
  utterance: null, currentMsgId: null, state: 'idle',
  speak(text, msgId) {
    if (!('speechSynthesis' in window)) return;
    if (this.state === 'speaking' && this.currentMsgId === msgId) { this.pause(); return; }
    if (this.state === 'paused' && this.currentMsgId === msgId) { this.resume(); return; }
    this.stop();
    const clean = text.replace(/\[来源:[^\]]+\]/g,'').trim();
    this.utterance = new SpeechSynthesisUtterance(clean);
    this.utterance.lang = 'zh-CN'; this.utterance.rate = 1;
    this.currentMsgId = msgId;
    this.utterance.onend = () => this._setState('idle');
    window.speechSynthesis.speak(this.utterance);
    this._setState('speaking');
  },
  pause() { window.speechSynthesis.pause(); this._setState('paused'); },
  resume() { window.speechSynthesis.resume(); this._setState('speaking'); },
  stop() { window.speechSynthesis.cancel(); this._setState('idle'); },
  _setState(s) { this.state = s; },
};

// ===== 链接生成 =====
function getAShareShareholding(stockCode) {
  const codeNumber = stockCode.split('.')[0];
  return `<a href="https://data.eastmoney.com/dxf/q/${codeNumber}.html" target="_blank">东方财富股东减持（${codeNumber}）</a>`;
}
function getNegativeNews(stockCode) {
  let url;
  if (stockCode.includes('.SZ') || stockCode.includes('.SH')) {
    url = `https://search.eastmoney.com/search?m=1&t=1&k=${stockCode.split('.')[0]}+利空`;
  } else if (stockCode.includes('.HK')) {
    url = `https://sina.com.hk/news/search/search.html?k=${stockCode.split('.')[0]}+利空`;
  }
  return url ? `<a href="${url}" target="_blank">查询利空新闻（${stockCode}）</a>` : '';
}

// ===== 主题 =====
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  $('#btnDarkMode').textContent = dark ? '☀️' : '🌙';
}
function toggleDarkMode() { const d = !Storage.isDarkMode(); Storage.setDarkMode(d); applyTheme(d); }

// ===== 设置 =====
function openSettings() { $('#settingsModal').classList.remove('hidden'); }
function closeSettings() { $('#settingsModal').classList.add('hidden'); }
function saveSettings() {
  Storage.setApiKey($('#apiKeyInput').value.trim());
  Storage.setModel($('#modelSelect').value);
  closeSettings();
  setStatus('设置已保存');
}

// ===== 清理对话 =====
function clearChat() {
  if (!confirm('确定清空所有对话记录？')) return;
  chatHistory = [];
  Storage.setChatHistory([]);
  chatMessagesEl.innerHTML = '<div class="chat-placeholder">输入股票代码或分析指令开始</div>';
  reductionAlertEl.classList.add('hidden');
  SpeechManager.stop();
  setStatus('对话已清空');
}

// ===== 启动 =====
document.addEventListener('DOMContentLoaded', init);