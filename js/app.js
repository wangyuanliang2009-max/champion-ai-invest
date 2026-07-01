/**
 * 冠军模式 AI 投资助手 - 主应用逻辑 (V3.1 稳定版)
 * 适配新版界面，包含内循环自校验、防幻觉、多模式等功能
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

  // 文件上传（暂时仅提示，豆包API未实现）
  const uploadLabel = document.querySelector('.upload-label');
  if (uploadLabel) {
    uploadLabel.addEventListener('click', () => {
      setStatus('文件分析功能即将上线');
    });
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

    // 构建严格系统提示词（含防幻觉）
    const strictSystemPrompt = buildSystemPrompt() + '\n\n【最高优先级：防幻觉规则】\n1. 只回答有可靠信源的问题，不懂就明确说“不知道”，拒绝猜测。\n2. 在给出判断前，先展示推理过程。\n3. 基于原文引用回答，并标注信息来源。';

    // Maker-Verifier 内循环
    let finalReply = '';
    for (let i = 0; i < MAX_SELF_CORRECT_LOOP; i++) {
      const makerMessages = [
        { role: 'system', content: strictSystemPrompt },
        ...chatHistory.filter(m => m.role === 'user' || m.role === 'assistant').slice(-5).map(m => ({ role: m.role, content: m.content }))
      ];
      const draftReply = await callDeepSeek(makerMessages);

      const verifierMessages = [
        { role: 'system', content: '你是严格的分析结果校验者。请检查以下AI回复，看是否违反了以下规则：\n1. 是否做到了客观冷静，不迎合用户？\n2. 是否标注了数据来源和时间？\n3. 是否存在逻辑漏洞或过度推测？\n如果发现任何问题，请直接给出具体的修改意见。如果没有问题，请只回复"PASS"。\n\n【待校验的回复】\n' + draftReply }
      ];
      const checkResult = await callDeepSeek(verifierMessages);

      if (checkResult.trim().toUpperCase() === 'PASS') {
        finalReply = draftReply;
        break;
      } else {
        chatHistory.push({
          id: genId(),
          role: 'user',
          content: `【系统自动校验反馈】\n${checkResult}\n\n请根据以上反馈，修正你的分析报告。`
        });
        setStatus(`第${i+1}轮自我校验未通过，正在修正...`);
      }
    }
    if (!finalReply) finalReply = '分析过程达到最大迭代次数，但仍存在潜在缺陷，仅供参考。';

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

  // 添加A股减持和利空链接
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

// ===== UZI 超级指令构建 =====
function buildUziPrompt(command, stockCode) {
  // ... (保持之前实现，此处省略，可在实际文件中补全)
  return `请分析 ${stockCode}`;
}

// ===== 辅助函数 =====
function setStatus(text) { statusTextEl.textContent = text; }
function showLoading(show) { loadingOverlay.classList.toggle('hidden', !show); }
function scrollToBottom() { chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight; }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escapeHtml(str) { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ===== 语音管理（简化版，保留原有 SpeechManager 代码） =====
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

// ===== A股减持与利空链接 =====
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