/**
 * 冠军模式 AI 投资助手 - 主应用逻辑
 */

// ===== 语音播报管理 =====
const SpeechManager = {
  utterance: null,
  currentMsgId: null,
  state: 'idle', // idle | speaking | paused

  speak(text, msgId) {
    if (!('speechSynthesis' in window)) {
      alert('当前浏览器不支持语音播报');
      return;
    }

    if (this.state === 'speaking' && this.currentMsgId === msgId) {
      this.pause();
      return;
    }
    if (this.state === 'paused' && this.currentMsgId === msgId) {
      this.resume();
      return;
    }

    this.stop();
    const clean = text.replace(/\[来源:[^\]]+\]/g, '').replace(/⚠/g, '警告').trim();
    this.utterance = new SpeechSynthesisUtterance(clean);
    this.utterance.lang = 'zh-CN';
    this.utterance.rate = 1;
    this.currentMsgId = msgId;

    this.utterance.onend = () => this._setState('idle');
    this.utterance.onerror = () => this._setState('idle');

    window.speechSynthesis.speak(this.utterance);
    this._setState('speaking');
    this._updateButtons();
  },

  pause() {
    if (this.state !== 'speaking') return;
    window.speechSynthesis.pause();
    this._setState('paused');
    this._updateButtons();
  },

  resume() {
    if (this.state !== 'paused') return;
    window.speechSynthesis.resume();
    this._setState('speaking');
    this._updateButtons();
  },

  stop() {
    window.speechSynthesis.cancel();
    this._setState('idle');
    this.currentMsgId = null;
    this.utterance = null;
    this._updateButtons();
  },

  _setState(s) {
    this.state = s;
  },

  _updateButtons() {
    document.querySelectorAll('.speech-controls').forEach((el) => {
      const msgId = el.dataset.msgId;
      const btnStart = el.querySelector('.btn-speech-start');
      const btnPause = el.querySelector('.btn-speech-pause');
      const btnStop = el.querySelector('.btn-speech-stop');

      const isCurrent = msgId === this.currentMsgId;
      if (btnStart) {
        btnStart.classList.toggle('active', isCurrent && this.state === 'speaking');
        btnStart.textContent = isCurrent && this.state === 'paused' ? '▶ 继续' : '🔊 朗读';
      }
      if (btnPause) btnPause.disabled = !isCurrent || this.state !== 'speaking';
      if (btnStop) btnStop.disabled = !isCurrent || this.state === 'idle';
    });
  },
};

// ===== DOM 引用 =====
const $ = (sel) => document.querySelector(sel);
const watchlistEl = $('#watchlist');
const chatMessagesEl = $('#chatMessages');
const chatInputEl = $('#chatInput');
const stockInputEl = $('#stockInput');
const statusTextEl = $('#statusText');
const statusTimeEl = $('#statusTime');
const reductionAlertEl = $('#reductionAlert');
const loadingOverlay = $('#loadingOverlay');

let selectedStock = null;
let chatHistory = [];
let watchlist = [];

// ===== 初始化 =====
function init() {
  applyTheme(Storage.isDarkMode());
  watchlist = Storage.getWatchlist();
  chatHistory = Storage.getChatHistory();

  renderWatchlist();
  renderChatHistory();

  bindEvents();
  RulesManager.init();

  if (watchlist.length > 0) {
    refreshAllQuotes();
  }

  setStatus('就绪');
}

function bindEvents() {
  $('#btnDarkMode').addEventListener('click', toggleDarkMode);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('.modal-backdrop').addEventListener('click', closeSettings);
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnAddStock').addEventListener('click', addStock);
  stockInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addStock();
  });
  $('#btnRefreshWatchlist').addEventListener('click', refreshAllQuotes);
  $('#btnSend').addEventListener('click', sendMessage);
  chatInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  $('#btnClearChat').addEventListener('click', clearChat);
}

// ===== 主题 =====
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  $('#btnDarkMode').textContent = dark ? '☀️' : '🌙';
}

function toggleDarkMode() {
  const dark = !Storage.isDarkMode();
  Storage.setDarkMode(dark);
  applyTheme(dark);
}

// ===== 设置 =====
function openSettings() {
  $('#apiKeyInput').value = Storage.getApiKey();
  $('#modelSelect').value = Storage.getModel();
  $('#settingsModal').classList.remove('hidden');
}

function closeSettings() {
  $('#settingsModal').classList.add('hidden');
}

function saveSettings() {
  const key = $('#apiKeyInput').value.trim();
  Storage.setApiKey(key);
  Storage.setModel($('#modelSelect').value);
  closeSettings();
  setStatus('设置已保存');
}

// ===== 自选股 =====
function addStock() {
  const raw = stockInputEl.value.trim();
  const parsed = parseStockCode(raw);
  if (!parsed) {
    setStatus('无效股票代码，格式如 002409.SZ 或 00148.HK');
    return;
  }

  if (watchlist.some((s) => s.secid === parsed.secid)) {
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
  watchlist = watchlist.filter((s) => s.secid !== secid);
  Storage.setWatchlist(watchlist);
  if (selectedStock?.secid === secid) selectedStock = null;
  renderWatchlist();
}

async function refreshQuote(secid) {
  const item = watchlist.find((s) => s.secid === secid);
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

  watchlistEl.innerHTML = watchlist
    .map((s) => {
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
    })
    .join('');

  watchlistEl.querySelectorAll('.watchlist-item').forEach((el) => {
    el.addEventListener('click', () => selectStock(el.dataset.secid));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (confirm('从自选列表移除？')) removeStock(el.dataset.secid);
    });
  });
}

function selectStock(secid) {
  selectedStock = watchlist.find((s) => s.secid === secid);
  renderWatchlist();
  const code = selectedStock?.secucode || '';
  chatInputEl.value = chatInputEl.value
    ? chatInputEl.value
    : `请分析 ${code} `;
  chatInputEl.focus();
}

// ===== 对话 =====
function renderChatHistory() {
  chatMessagesEl.innerHTML = '';
  chatHistory.forEach((msg) => appendMessageUI(msg, false));
  scrollToBottom();
}

function appendMessageUI(msg, animate = true) {
  const div = document.createElement('div');
  div.className = `message ${msg.role}`;
  if (!animate) div.style.animation = 'none';

  let actionsHtml = '';
  if (msg.role === 'assistant') {
    actionsHtml = `
      <div class="message-actions speech-controls" data-msg-id="${msg.id}">
        <button class="btn btn-speech btn-speech-start" data-action="start">🔊 朗读</button>
        <button class="btn btn-speech btn-speech-pause" data-action="pause" disabled>⏸ 暂停</button>
        <button class="btn btn-speech btn-speech-stop" data-action="stop" disabled>⏹ 停止</button>
      </div>`;
  }

  let contextHtml = '';
  if (msg.dataContext) {
    contextHtml = `<div class="data-context">${escapeHtml(msg.dataContext)}</div>`;
  }

  // 新增：添加A股减持和利空新闻链接
  let manualLinksHtml = '';
  if (msg.stockCodes && msg.stockCodes.length > 0) {
    msg.stockCodes.forEach((code) => {
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
    controls.querySelector('[data-action="pause"]').addEventListener('click', () => {
      SpeechManager.pause();
    });
    controls.querySelector('[data-action="stop"]').addEventListener('click', () => {
      SpeechManager.stop();
    });
  }
}

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
    stockCodes: [],
  };
  chatHistory.push(userMsg);
  Storage.setChatHistory(chatHistory);
  appendMessageUI(userMsg);
  chatInputEl.value = '';
  scrollToBottom();

  showLoading(true);
  setStatus('正在获取数据并分析…');

  try {
    const codes = extractStockCodes(text);
    if (selectedStock && !codes.some((c) => c.secid === selectedStock.secid)) {
      codes.unshift(parseStockCode(selectedStock.secucode));
    }

    // 记录涉及的股票代码，用于后续显示手动查询链接
    userMsg.stockCodes = codes.map((c) => c.secucode);

    let dataContext = '';
    let reductionInfo = null;

    if (codes.length > 0) {
      const contexts = [];
      for (const parsed of codes.slice(0, 3)) {
        try {
          const ctx = await buildStockContext(parsed);
          contexts.push(formatContextForAI(ctx));
          if (parsed.isHK && ctx.reduction) {
            reductionInfo = ctx.reduction;
          } else if (!parsed.isHK && ctx.reduction) {
            reductionInfo = ctx.reduction;
          }
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

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      ...chatHistory
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content })),
    ];

    // 替换最后一条 user 消息为带数据的版本
    messages[messages.length - 1] = { role: 'user', content: userContent };

    const reply = await callDeepSeek(messages);

    const assistantMsg = {
      id: genId(),
      role: 'assistant',
      content: reply,
      dataContext: dataContext || null,
      time: nowStr(),
      stockCodes: userMsg.stockCodes,
    };
    chatHistory.push(assistantMsg);
    Storage.setChatHistory(chatHistory);
    appendMessageUI(assistantMsg);
    setStatus('分析完成');
  } catch (err) {
    const errMsg = {
      id: genId(),
      role: 'assistant',
      content: `分析失败: ${err.message}`,
      time: nowStr(),
      stockCodes: [],
    };
    chatHistory.push(errMsg);
    appendMessageUI(errMsg);
    setStatus(`错误: ${err.message}`);
  } finally {
    showLoading(false);
    scrollToBottom();
  }
}

function showReductionAlert(reduction, codes) {
  if (!reduction || !codes.some((c) => c.isHK)) {
    reductionAlertEl.classList.add('hidden');
    return;
  }

  reductionAlertEl.classList.remove('hidden', 'danger');

  if (reduction.error) {
    const hkCodeNum = (codes[0]?.code || stockCode || '').replace('.HK', '').replace('.hk', '');
    const hkexUrl = `https://sc.hkexnews.hk/TuniS/di.hkex.com.hk/di/NSSrchCorp.aspx?src=MAIN&lang=ZH&g_lang=zh-HK&stockid=${hkCodeNum}`;
    reductionAlertEl.innerHTML = `
      <strong>港股减持核查</strong>：自动数据获取失败。<br>
      <a href="${hkexUrl}" target="_blank" rel="noopener">
        点击这里直接查询港交所披露易（${hkCodeNum}）
      </a>
      <br><small>（港交所权益披露通常于交易日 16:30-23:00 更新）</small>`;
    return;
  }

  if (reduction.hasReduction) {
    reductionAlertEl.classList.add('danger');
    const list = reduction.records
      .slice(0, 3)
      .map((r) => `${r.holder} (${r.noticeDate})`)
      .join('；');
    reductionAlertEl.innerHTML = `
      <strong>⚠ 减持警示</strong>：近3个月发现 ${reduction.totalCount} 条大股东/机构减持记录。
      ${list}
      <br><small>数据来源：${reduction.source} | 核查起始：${reduction.since}</small>`;
  } else {
    reductionAlertEl.innerHTML = `
      <strong>减持核查</strong>：近3个月未发现大股东减持记录。
      <small>（数据来源：${reduction.source}，请以<a href="${CONFIG.HKEX_DISCLOSURE_URL}" target="_blank" rel="noopener">港交所披露易</a>为准）</small>`;
  }
}

function clearChat() {
  if (!confirm('确定清空所有对话记录？')) return;
  chatHistory = [];
  Storage.setChatHistory([]);
  chatMessagesEl.innerHTML = '';
  reductionAlertEl.classList.add('hidden');
  SpeechManager.stop();
  setStatus('对话已清空');
}

// ===== 工具 =====
function setStatus(text) {
  statusTextEl.textContent = text;
}

function showLoading(show) {
  loadingOverlay.classList.toggle('hidden', !show);
  $('#btnSend').disabled = show;
}

function scrollToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== A股减持核查（手动链接） =====
function getAShareShareholding(stockCode) {
  const codeNumber = stockCode.split('.')[0];
  const eastmoneyUrl = `https://data.eastmoney.com/dxf/q/${codeNumber}.html`;
  const cninfoUrl = `http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice&stockCode=${codeNumber}`;
  return `
    <strong>A股减持核查</strong>：请手动查询<br>
    <a href="${eastmoneyUrl}" target="_blank" rel="noopener">东方财富股东减持（${codeNumber}）</a><br>
    <a href="${cninfoUrl}" target="_blank" rel="noopener">巨潮资讯网公告（${codeNumber}）</a>`;
}

// ===== 利空新闻查询 =====
function getNegativeNews(stockCode) {
  let url;
  if (stockCode.includes('.SZ') || stockCode.includes('.SH')) {
    const codeNumber = stockCode.split('.')[0];
    url = `https://search.eastmoney.com/search?m=1&t=1&k=${codeNumber}+利空`;
  } else if (stockCode.includes('.HK')) {
    const codeNumber = stockCode.split('.')[0];
    url = `https://sina.com.hk/news/search/search.html?k=${codeNumber}+利空`;
  }
  if (url) {
    return `<a href="${url}" target="_blank" rel="noopener">查询利空新闻（${stockCode}）</a>`;
  }
  return '';
}

document.addEventListener('DOMContentLoaded', init);