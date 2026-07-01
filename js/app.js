/**
 * 冠军模式 AI 投资助手 - V4.2 深度分析+盘前速览+防幻觉
 */
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
  setStatus('就绪 | 选择模式开始');
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
  chatInputEl.placeholder = {
    'chat': '输入代码或问题...',
    'premarket': '盘前速览：自动扫描自选股异动...',
    'postmarket': '盘后体检：复查持仓...',
    'info': '粘贴新闻/研报...'
  }[mode];
  if (mode === 'premarket') runPreMarketScan();
  if (mode === 'postmarket') chatInputEl.value = '请对我的自选股进行盘后体检，包括估值、技术面和消息面';
  setStatus(`已切换到${document.querySelector(`.tab[data-mode="${mode}"]`).textContent}模式`);
}

// ---- 盘前速览 ----
async function runPreMarketScan() {
  if (watchlist.length === 0) { setStatus('自选股为空，无法扫描'); return; }
  setStatus('正在执行盘前扫描...');
  const codes = watchlist.map(s => parseStockCode(s.secucode));
  const results = [];
  for (const parsed of codes) {
    try {
      const ctx = await buildStockContext(parsed);
      results.push(formatContextForAI(ctx));
    } catch (e) { results.push(`${parsed.secucode} 数据获取失败`); }
  }
  const prompt = `盘前速览报告（${new Date().toLocaleDateString()}）\n自选股扫描结果：\n${results.join('\n')}\n\n请总结异动，特别提示有减持信号的股票。`;
  chatInputEl.value = prompt;
  sendMessage();
}

// ---- 深度分析提示词 ----
function getDeepAnalysisFramework(stockCode) {
  return `
【深度分析框架：66评审团 × 9大流派 × 22维数据】
请以资深投资大师的身份，对 ${stockCode} 出具结构化报告。必须严格按照以下模板输出（使用Markdown）：

## 一、公司速览
- 主营业务、行业地位、市值规模
- 实际控制人与近期重大事件

## 二、财务深度透视
- 近3年营收/净利润/现金流趋势
- 盈利能力（毛利率、ROE、净利率）
- 资产负债与偿债风险

## 三、行业与竞争格局
- 赛道景气度、政策支持
- 竞争对手比较、护城河

## 四、估值与预期
- 当前PE/PB/PS在历史中的分位
- DCF等绝对估值假设
- 与国内外同行对比

## 五、多空辩论
- 至少3条看多理由 vs 3条看空理由，注明流派

## 六、风险评估
- 大股东减持/质押、政策、技术替代、财务风险

## 七、投资建议
- 综合评分（1-10）
- 红绿灯：🟢🟡⚪🟠🔴
- 适合投资者类型

**核心原则**：数据必须标注来源；缺失时明确说明；禁止使用过时或编造数字。`;
}

function buildUziPrompt(cmd, code) {
  switch (cmd) {
    case 'deep_analyze': return getDeepAnalysisFramework(code);
    case 'quick_scan': return `快速扫描 ${code}：价格、涨跌、核心风险、一句话建议。`;
    case 'risk_check': return `审计 ${code}，列出所有可能风险点。`;
    case 'valuation': return `对 ${code} 进行DCF、PE、PB估值，给出合理区间。`;
    default: return '';
  }
}

// ---- 核心发送 ----
async function sendMessage() {
  const text = chatInputEl.value.trim();
  if (!text) return;
  if (!Storage.getApiKey()) { openSettings(); return; }
  const userMsg = { id: genId(), role: 'user', content: text, time: nowStr(), stockCodes: [] };
  chatHistory.push(userMsg);
  appendMessageUI(userMsg);
  chatInputEl.value = '';
  showLoading(true);
  try {
    const codes = extractStockCodes(text);
    if (selectedStock && !codes.some(c => c.secid === selectedStock.secid)) codes.unshift(parseStockCode(selectedStock.secucode));
    userMsg.stockCodes = codes.map(c => c.secucode);
    let contexts = [];
    for (const parsed of codes.slice(0, 3)) {
      try {
        const ctx = await buildStockContext(parsed);
        contexts.push(formatContextForAI(ctx));
      } catch (e) { contexts.push(`${parsed.secucode} 数据错误`); }
    }
    const dataBlock = contexts.length ? `\n\n--- 实时数据 ---\n${contexts.join('\n')}` : '';
    let enhanced = text;
    const uzi = text.match(/^\/(deep_analyze|quick_scan|risk_check|valuation)\s+(\w+)/);
    if (uzi) enhanced = buildUziPrompt(uzi[1], uzi[2]) + '\n' + enhanced;
    const system = buildSystemPrompt();
    let finalReply = '';
    for (let i=0; i<MAX_SELF_CORRECT_LOOP; i++) {
      const msgs = [
        { role:'system', content: system },
        ...chatHistory.slice(-4).map(m=>({role:m.role,content:m.content}))
      ];
      msgs.push({ role:'user', content: enhanced + dataBlock });
      const draft = await callDeepSeek(msgs);
      const verify = await callDeepSeek([
        { role:'system', content:'校验以下回复是否完全合规（无编造数据、标注来源）。是回复PASS，否则给出修改意见。' },
        { role:'user', content: draft }
      ]);
      if (verify.trim().toUpperCase()==='PASS') { finalReply = draft; break; }
      enhanced += `\n[校验反馈]${verify}\n请修正。`;
    }
    if (!finalReply) finalReply = '分析未通过校验，请重试。';
    const asst = { id: genId(), role:'assistant', content: finalReply, time: nowStr(), stockCodes: userMsg.stockCodes };
    chatHistory.push(asst);
    appendMessageUI(asst);
  } catch (e) {
    const err = { id: genId(), role:'assistant', content: `错误: ${e.message}`, time: nowStr() };
    chatHistory.push(err);
    appendMessageUI(err);
  } finally { showLoading(false); scrollToBottom(); }
}

// ---- 辅助UI ----
function appendMessageUI(msg) {
  const div = document.createElement('div');
  div.className = `message ${msg.role}`;
  let actions = '';
  if (msg.role === 'assistant') actions = `<div class="msg-acts"><button onclick="SpeechManager.speak('${msg.content.replace(/'/g,"\\'")}','${msg.id}')">🔊</button></div>`;
  div.innerHTML = `<div class="bubble">${escapeHtml(msg.content)}</div><div class="meta">${msg.time}</div>${actions}`;
  chatMessagesEl.appendChild(div);
}

function renderChatHistory() {
  chatMessagesEl.innerHTML = chatHistory.length ? '' : '<div class="chat-placeholder">输入指令开始</div>';
  chatHistory.forEach(m => appendMessageUI(m));
}
function setStatus(t) { statusTextEl.textContent = t; }
function showLoading(s) { loadingOverlay.classList.toggle('hidden', !s); }
function scrollToBottom() { chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight; }
function genId() { return Date.now().toString(36)+Math.random().toString(36).slice(2); }
function escapeHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// 主题/设置/自选列表等（保持简洁，必要时补全）
function applyTheme(d) { document.documentElement.setAttribute('data-theme',d?'dark':'light'); $('#btnDarkMode').textContent=d?'☀️':'🌙'; }
function toggleDarkMode() { const d=!Storage.isDarkMode(); Storage.setDarkMode(d); applyTheme(d); }
function openSettings() { $('#settingsModal').classList.remove('hidden'); }
function closeSettings() { $('#settingsModal').classList.add('hidden'); }
function saveSettings() { Storage.setApiKey($('#apiKeyInput').value.trim()); closeSettings(); }
function clearChat() { chatHistory=[]; Storage.setChatHistory([]); chatMessagesEl.innerHTML=''; }

// 自选股相关（使用先前代码，略作整合）
function addStock() { /* 同前，略 */ }
function removeStock(id) { /* 略 */ }
function selectStock(id) { /* 略 */ }
function renderWatchlist() { /* 略 */ }
async function refreshQuote(secid) { /* 略 */ }
async function refreshAllQuotes() { /* 略 */ }

// 请将原来完整的 addStock/removeStock/selectStock/renderWatchlist/refreshQuote/refreshAllQuotes 代码复制回来，
// 此处因长度限制省略，确保功能正常。