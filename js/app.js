// js/app.js - V4.3 减持自动提醒 + 深度框架

const MAX_SELF_CORRECT_LOOP = 2;
const $ = (sel) => document.querySelector(sel);

const watchlistEl = $('#watchlist');
const chatMessagesEl = $('#chatMessages');
const chatInputEl = $('#chatInput');
const stockInputEl = $('#stockInput');
const statusTextEl = $('#statusText');
const statusTimeEl = $('#statusTime');
const reductionAlertEl = $('#reductionAlert');
const loadingOverlay = $('#loadingOverlay');
const quickActionsEl = $('#quickActions');

let selectedStock = null;
let chatHistory = [];
let watchlist = [];
let currentMode = 'chat';

function init() {
  applyTheme(Storage.isDarkMode());
  watchlist = Storage.getWatchlist();
  chatHistory = Storage.getChatHistory();
  renderWatchlist();
  renderChatHistory();
  bindEvents();
  RulesManager.init();
  if (watchlist.length > 0) refreshAllQuotes();
  setStatus('就绪');
}

function bindEvents() {
  $('#btnDarkMode').addEventListener('click', toggleDarkMode);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnAddStock').addEventListener('click', addStock);
  stockInputEl.addEventListener('keydown', e => { if (e.key==='Enter') addStock(); });
  $('#btnRefreshWatchlist').addEventListener('click', refreshAllQuotes);
  $('#btnSend').addEventListener('click', () => sendMessage());
  chatInputEl.addEventListener('keydown', e => {
    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('#btnClearChat').addEventListener('click', clearChat);
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchMode(t.dataset.mode)));
  quickActionsEl.addEventListener('click', e => {
    if (e.target.classList.contains('chip')) handleQuickAction(e.target.dataset.action);
  });
  document.querySelector('.upload-label')?.addEventListener('click', () => setStatus('文件分析即将上线'));
  watchlistEl.addEventListener('contextmenu', e => {
    const item = e.target.closest('.watchlist-item');
    if (item) { e.preventDefault(); if (confirm('移除？')) removeStock(item.dataset.secid); }
  });
  watchlistEl.addEventListener('click', e => {
    const item = e.target.closest('.watchlist-item');
    if (item) selectStock(item.dataset.secid);
  });
  $('#navChat')?.addEventListener('click', () => RulesManager.showView('chat'));
  $('#navRules')?.addEventListener('click', () => RulesManager.showView('rules'));
}

function switchMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-mode="${mode}"]`).classList.add('active');
  chatInputEl.placeholder = { chat: '输入代码或问题...', premarket: '盘前速览...', postmarket: '盘后体检...', info: '粘贴新闻...' }[mode];
  if (mode === 'premarket') runPreMarketScan();
}

// ---- 盘前速览 ----
async function runPreMarketScan() {
  if (watchlist.length === 0) return;
  setStatus('盘前扫描中...');
  const codes = watchlist.map(s => parseStockCode(s.secucode));
  const results = [];
  for (const parsed of codes) {
    try {
      const ctx = await buildStockContext(parsed);
      results.push(formatContextForAI(ctx));
      if (parsed.isHK) {
        // 港股减持提醒直接加入结果
        results.push(`→ 请核查披露易：https://sc.hkexnews.hk/TuniS/di.hkex.com.hk/di/NSSrchCorp.aspx?src=MAIN&lang=ZH&g_lang=zh-HK&stockid=${parsed.code}`);
      }
    } catch (e) { results.push(`${parsed.secucode} 数据错误`); }
  }
  chatInputEl.value = `盘前扫描 (${new Date().toLocaleDateString()})\n${results.join('\n')}\n请重点提示减持风险。`;
  sendMessage();
}

// ---- 深度分析框架 ----
function getDeepAnalysisFramework(code) {
  return `
【深度分析框架：66评审团 × 9大流派 × 22维数据】
请按以下结构输出 ${code} 的分析报告（Markdown）：

## 一、公司速览
## 二、财务深度透视
## 三、行业与竞争
## 四、估值与预期
## 五、多空辩论 (至少3 vs 3)
## 六、风险评估 (必含减持/流动性)
## 七、投资建议 (评分+红绿灯)

**原则**：数据标源；缺失明示；禁用过时信息。`;
}

function buildUziPrompt(cmd, code) {
  switch (cmd) {
    case 'deep_analyze': return getDeepAnalysisFramework(code);
    case 'quick_scan': return `快速扫描 ${code}：现价、涨跌、核心风险、一句话。`;
    case 'risk_check': return `审计 ${code} 所有潜在风险。`;
    case 'valuation': return `对 ${code} DCF/PE/PB 估值。`;
    default: return '';
  }
}

// ---- 核心发送 ----
async function sendMessage() {
  const text = chatInputEl.value.trim();
  if (!text) return;
  if (!Storage.getApiKey()) { openSettings(); return; }
  const userMsg = { id: genId(), role:'user', content: text, time: nowStr(), stockCodes: [] };
  chatHistory.push(userMsg);
  appendMessageUI(userMsg);
  chatInputEl.value = '';
  showLoading(true);
  setStatus('分析中...');
  try {
    const codes = extractStockCodes(text);
    if (selectedStock && !codes.some(c=>c.secid===selectedStock.secid)) codes.unshift(parseStockCode(selectedStock.secucode));
    userMsg.stockCodes = codes.map(c=>c.secucode);
    let contexts = [];
    for (const parsed of codes.slice(0,3)) {
      try {
        const ctx = await buildStockContext(parsed);
        contexts.push(formatContextForAI(ctx));
        // 港股强制减持提醒
        if (parsed.isHK && ctx.reduction && ctx.reduction.error) {
          contexts.push(`⚠ 减持需手动查询：https://sc.hkexnews.hk/TuniS/di.hkex.com.hk/di/NSSrchCorp.aspx?src=MAIN&lang=ZH&g_lang=zh-HK&stockid=${parsed.code}`);
        }
      } catch(e) { contexts.push(`${parsed.secucode} 数据错误`); }
    }
    let dataBlock = contexts.length ? `\n\n--- 实时数据 ---\n${contexts.join('\n')}` : '';
    let enhanced = text;
    const uzi = text.match(/^\/(deep_analyze|quick_scan|risk_check|valuation)\s+(\w+)/);
    if (uzi) enhanced = buildUziPrompt(uzi[1], uzi[2]) + '\n' + enhanced;

    // 强制追加减持查询提示到用户消息中
    const hkCodes = codes.filter(c => c.isHK);
    if (hkCodes.length > 0) {
      enhanced += `\n\n【系统提示：请务必核查以下港股的大股东减持记录（链接见数据区），并在报告中明确说明。】`;
    }

    const system = buildSystemPrompt() + '\n【防幻觉】只能使用提供的数据，缺失时明确告知。';
    let finalReply = '';
    for (let i=0; i<MAX_SELF_CORRECT_LOOP; i++) {
      const msgs = [
        { role:'system', content: system },
        ...chatHistory.slice(-4).map(m=>({role:m.role,content:m.content}))
      ];
      msgs.push({ role:'user', content: enhanced + dataBlock });
      const draft = await callDeepSeek(msgs);
      const verify = await callDeepSeek([
        { role:'system', content:'校验以下回复是否合规（无编造，标源）。是回复PASS，否则给修改意见。' },
        { role:'user', content: draft }
      ]);
      if (verify.trim().toUpperCase()==='PASS') { finalReply = draft; break; }
      enhanced += `\n[校验反馈]${verify}\n请修正。`;
    }
    if (!finalReply) finalReply = '分析未通过校验。';
    const asst = { id: genId(), role:'assistant', content: finalReply, time: nowStr(), stockCodes: userMsg.stockCodes };
    chatHistory.push(asst);
    appendMessageUI(asst);
  } catch(e) {
    const err = { id: genId(), role:'assistant', content: `错误: ${e.message}`, time: nowStr() };
    chatHistory.push(err);
    appendMessageUI(err);
  } finally { showLoading(false); scrollToBottom(); }
}

// ---- 消息UI ----
function appendMessageUI(msg) {
  const div = document.createElement('div');
  div.className = `message ${msg.role}`;
  let actions = '';
  if (msg.role === 'assistant') actions = `<div class="msg-acts"><button onclick="SpeechManager.speak('${escapeHtml(msg.content).replace(/'/g,"\\'")}','${msg.id}')">🔊</button></div>`;
  let contextHtml = '';
  if (msg.stockCodes && msg.stockCodes.length > 0) {
    msg.stockCodes.forEach(code => {
      if (code.includes('.HK')) {
        const num = code.split('.')[0];
        contextHtml += `<div style="margin-top:6px;"><a href="https://sc.hkexnews.hk/TuniS/di.hkex.com.hk/di/NSSrchCorp.aspx?src=MAIN&lang=ZH&g_lang=zh-HK&stockid=${num}" target="_blank">查询披露易 (${num})</a></div>`;
      }
    });
  }
  div.innerHTML = `<div class="bubble">${escapeHtml(msg.content)}${contextHtml}</div><div class="meta">${msg.time}</div>${actions}`;
  chatMessagesEl.appendChild(div);
}

function renderChatHistory() {
  chatMessagesEl.innerHTML = chatHistory.length ? '' : '<div class="chat-placeholder">输入指令开始</div>';
  chatHistory.forEach(m => appendMessageUI(m));
}

// ---- 辅助函数 ----
function setStatus(t) { statusTextEl.textContent = t; }
function showLoading(s) { loadingOverlay.classList.toggle('hidden', !s); }
function scrollToBottom() { chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight; }
function genId() { return Date.now().toString(36)+Math.random().toString(36).slice(2); }
function escapeHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// 主题/设置等简略
function applyTheme(d) { document.documentElement.setAttribute('data-theme',d?'dark':'light'); $('#btnDarkMode').textContent=d?'☀️':'🌙'; }
function toggleDarkMode() { const d=!Storage.isDarkMode(); Storage.setDarkMode(d); applyTheme(d); }
function openSettings() { $('#settingsModal').classList.remove('hidden'); }
function closeSettings() { $('#settingsModal').classList.add('hidden'); }
function saveSettings() { Storage.setApiKey($('#apiKeyInput').value.trim()); closeSettings(); }
function clearChat() { chatHistory=[]; Storage.setChatHistory([]); chatMessagesEl.innerHTML=''; }

// ---- 自选股管理（使用之前的完整代码，这里简写示例） ----
function addStock() {
  const raw = stockInputEl.value.trim();
  const parsed = parseStockCode(raw);
  if (!parsed) { setStatus('无效代码'); return; }
  if (watchlist.find(s=>s.secid===parsed.secid)) { setStatus('已存在'); return; }
  watchlist.push({ secid:parsed.secid, secucode:parsed.secucode, code:parsed.code, name:parsed.secucode, isHK:parsed.isHK });
  Storage.setWatchlist(watchlist);
  stockInputEl.value = '';
  renderWatchlist();
  refreshQuote(parsed.secid);
}
function removeStock(secid) { watchlist = watchlist.filter(s=>s.secid!==secid); Storage.setWatchlist(watchlist); renderWatchlist(); }
function selectStock(secid) { selectedStock = watchlist.find(s=>s.secid===secid); renderWatchlist(); chatInputEl.value = `请分析 ${selectedStock.secucode} `; chatInputEl.focus(); }
async function refreshQuote(secid) { /* 略，可用之前的代码 */ }
async function refreshAllQuotes() { for (const item of watchlist) await refreshQuote(item.secid); }
function renderWatchlist() {
  if (watchlist.length===0) { watchlistEl.innerHTML = '<li class="watchlist-empty">无自选</li>'; return; }
  watchlistEl.innerHTML = watchlist.map(s=>`<li class="watchlist-item${selectedStock?.secid===s.secid?' active':''}" data-secid="${s.secid}">${s.secucode}</li>`).join('');
}

// 启动
document.addEventListener('DOMContentLoaded', init);