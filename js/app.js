// js/app.js - V5.0 深度报告 + 豆包消息 + 减持强制 + 手动核查

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
const manualCheckBtn = $('#btnManualCheck');

let selectedStock = null;
let chatHistory = [];
let watchlist = [];
let currentMode = 'chat';

// ---------- 初始化 ----------
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
  manualCheckBtn.addEventListener('click', openManualReductionCheck);
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

// ---------- 手动核查窗口 ----------
function openManualReductionCheck() {
  const codes = watchlist.length > 0 ? watchlist.map(s => s.secucode) : (selectedStock ? [selectedStock.secucode] : []);
  if (codes.length === 0) { alert('请先添加自选股或选择股票'); return; }
  let urls = '';
  codes.forEach(code => {
    const parsed = parseStockCode(code);
    if (!parsed) return;
    if (parsed.isHK) {
      urls += `<a href="https://sc.hkexnews.hk/TuniS/di.hkex.com.hk/di/NSSrchCorp.aspx?src=MAIN&lang=ZH&g_lang=zh-HK&stockid=${parsed.code}" target="_blank">港交所披露易 (${parsed.code})</a><br>`;
    } else {
      urls += `<a href="https://data.eastmoney.com/dxf/q/${parsed.code}.html" target="_blank">东方财富减持 (${parsed.code})</a><br>`;
      urls += `<a href="http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice&stockCode=${parsed.code}" target="_blank">巨潮资讯网 (${parsed.code})</a><br>`;
    }
  });
  const win = window.open('', '_blank', 'width=800,height=600');
  win.document.write(`<h3>手动核查减持记录</h3>${urls}<p>（页面将保留，可随时切换查看）</p>`);
}

// ---------- 深度分析框架 ----------
function getDeepAnalysisFramework(code) {
  return `
【深度分析框架：66评审团 × 9大流派 × 22维数据】
请按以下Markdown结构输出 ${code} 的分析报告：

## 📊 股票深度分析报告
**分析时间**：${nowStr()}

### ⚠️ 风险速览（最重要，放最前）
- 大股东减持/流动性/技术替代等近期核心风险

### 📰 消息面舆情（豆包搜索，DeepSeek验证）
- 🟢 利空：[核实后的新闻标题与来源]
- 🔴 利好：[核实后的新闻标题与来源]

### 一、公司速览
### 二、财务深度透视
### 三、行业与竞争格局
### 四、估值与预期
### 五、多空辩论（至少3 vs 3，标注流派）
### 六、投资建议
- 综合评分 / 10
- 红绿灯：🟢🟡⚪🟠🔴
- 适合投资者类型

### 📋 数据溯源
- 股价、财务、新闻等来源

【防幻觉铁律】只能使用提供的实时数据，缺失时明确说“暂不可用”；所有新闻必须标注核实状态。`;
}

function buildUziPrompt(cmd, code) {
  switch (cmd) {
    case 'deep_analyze': return getDeepAnalysisFramework(code);
    case 'quick_scan': return `快速扫描 ${code}：现价、涨跌、核心风险、一句话建议。`;
    case 'risk_check': return `审计 ${code} 所有潜在风险。`;
    case 'valuation': return `对 ${code} 进行DCF/PE/PB估值，给出合理区间。`;
    default: return '';
  }
}

// ---------- 核心发送 ----------
async function sendMessage() {
  const text = chatInputEl.value.trim();
  if (!text) return;
  if (!Storage.getApiKey()) { openSettings(); return; }
  const userMsg = { id: genId(), role:'user', content: text, time: nowStr(), stockCodes: [] };
  chatHistory.push(userMsg);
  appendMessageUI(userMsg);
  chatInputEl.value = '';
  showLoading(true);
  try {
    const codes = extractStockCodes(text);
    if (selectedStock && !codes.some(c=>c.secid===selectedStock.secid)) codes.unshift(parseStockCode(selectedStock.secucode));
    userMsg.stockCodes = codes.map(c=>c.secucode);
    
    let contexts = [];
    let newsJson = [];
    for (const parsed of codes.slice(0,3)) {
      try {
        const ctx = await buildStockContext(parsed);
        contexts.push(formatContextForAI(ctx));
        const news = await fetchNewsFromDoubao(parsed);
        if (news.length > 0) newsJson.push({ code: parsed.secucode, news });
      } catch(e) { contexts.push(`${parsed.secucode} 数据错误`); }
    }
    
    let reductionCmd = '';
    codes.forEach(c => {
      if (c.isHK) {
        reductionCmd += `\n【⚠️ 港股减持强制核查：${c.code}】请务必提醒用户手动查询披露易：https://sc.hkexnews.hk/TuniS/di.hkex.com.hk/di/NSSrchCorp.aspx?src=MAIN&lang=ZH&g_lang=zh-HK&stockid=${c.code}`;
      } else {
        reductionCmd += `\n【⚠️ A股减持强制核查：${c.code}】请提醒查询东方财富 http://data.eastmoney.com/dxf/q/${c.code}.html 和巨潮资讯网`;
      }
    });
    
    let finalPrompt = text;
    const uziMatch = text.match(/^\/(deep_analyze|quick_scan|risk_check|valuation)\s+(\w+)/);
    if (uziMatch) finalPrompt = buildUziPrompt(uziMatch[1], uziMatch[2]) + '\n' + finalPrompt;
    
    if (newsJson.length > 0) {
      finalPrompt += `\n\n【豆包新闻原始数据（需验证）】\n${JSON.stringify(newsJson)}\n请验证真实性并用于“消息面舆情”模块，利空绿字、利好红字。`;
    }
    
    finalPrompt += `\n\n--- 实时行情 ---\n${contexts.join('\n')}${reductionCmd}`;
    
    const system = buildSystemPrompt() + '\n【防幻觉】只能使用提供的实时数据，缺失时明确告知。';
    let finalReply = '';
    for (let i=0; i<MAX_SELF_CORRECT_LOOP; i++) {
      const msgs = [
        { role:'system', content: system },
        ...chatHistory.slice(-4).map(m=>({role:m.role,content:m.content}))
      ];
      msgs.push({ role:'user', content: finalPrompt });
      const draft = await callDeepSeek(msgs);
      const verify = await callDeepSeek([
        { role:'system', content:'校验回复是否合规（无编造、标源）。是回PASS，否给修改意见。' },
        { role:'user', content: draft }
      ]);
      if (verify.trim().toUpperCase()==='PASS') { finalReply = draft; break; }
      finalPrompt += `\n[校验反馈]${verify}\n请修正。`;
    }
    if (!finalReply) finalReply = '分析未通过校验。';
    
    const asst = { id: genId(), role:'assistant', content: finalReply, time: nowStr(), stockCodes: codes.map(c=>c.secucode) };
    chatHistory.push(asst);
    appendMessageUI(asst);
  } catch(e) {
    const err = { id: genId(), role:'assistant', content: `错误: ${e.message}`, time: nowStr() };
    chatHistory.push(err);
    appendMessageUI(err);
  } finally { showLoading(false); scrollToBottom(); }
}

// ---------- UI ----------
function appendMessageUI(msg) {
  const div = document.createElement('div');
  div.className = `message ${msg.role}`;
  let actions = '';
  if (msg.role === 'assistant') actions = `<div class="msg-acts"><button onclick="SpeechManager.speak('${escapeHtml(msg.content).replace(/'/g,"\\'")}','${msg.id}')">🔊</button></div>`;
  div.innerHTML = `<div class="bubble">${escapeHtml(msg.content)}</div><div class="meta">${msg.time}</div>${actions}`;
  chatMessagesEl.appendChild(div);
}

function renderChatHistory() {
  chatMessagesEl.innerHTML = chatHistory.length ? '' : '<div class="chat-placeholder">输入指令开始</div>';
  chatHistory.forEach(m => appendMessageUI(m));
}

// ---------- 辅助函数 ----------
function setStatus(t) { statusTextEl.textContent = t; }
function showLoading(s) { loadingOverlay.classList.toggle('hidden', !s); }
function scrollToBottom() { chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight; }
function genId() { return Date.now().toString(36)+Math.random().toString(36).slice(2); }
function escapeHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// 主题
function applyTheme(d) { document.documentElement.setAttribute('data-theme',d?'dark':'light'); $('#btnDarkMode').textContent=d?'☀️':'🌙'; }
function toggleDarkMode() { const d=!Storage.isDarkMode(); Storage.setDarkMode(d); applyTheme(d); }

// 设置
function openSettings() {
  $('#apiKeyInput').value = Storage.getApiKey();
  $('#doubaoApiKeyInput').value = localStorage.getItem('doubao_api_key') || '';
  $('#settingsModal').classList.remove('hidden');
}
function closeSettings() { $('#settingsModal').classList.add('hidden'); }
function saveSettings() {
  Storage.setApiKey($('#apiKeyInput').value.trim());
  localStorage.setItem('doubao_api_key', $('#doubaoApiKeyInput').value.trim());
  closeSettings();
  setStatus('设置已保存');
}

// 清理
function clearChat() {
  chatHistory = [];
  Storage.setChatHistory([]);
  chatMessagesEl.innerHTML = '';
}

// ---------- 自选股管理 ----------
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
async function refreshQuote(secid) {
  const item = watchlist.find(s=>s.secid===secid);
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
  } catch(e) { setStatus(`刷新失败: ${e.message}`); }
}
async function refreshAllQuotes() {
  for (const item of watchlist) await refreshQuote(item.secid);
}
function renderWatchlist() {
  if (watchlist.length===0) { watchlistEl.innerHTML = '<li class="watchlist-empty">无自选股</li>'; return; }
  watchlistEl.innerHTML = watchlist.map(s => {
    const changeClass = (s.changePct||0)>=0 ? 'up' : 'down';
    const priceStr = s.price!=null ? s.price.toFixed(s.isHK?3:2) : '--';
    const changeStr = s.changePct!=null ? formatPercent(s.changePct) : '--';
    const active = selectedStock?.secid===s.secid ? ' active' : '';
    return `<li class="watchlist-item${active}" data-secid="${s.secid}">${s.secucode} ${priceStr} <span class="${changeClass}">${changeStr}</span></li>`;
  }).join('');
}

// 盘前速览
function switchMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-mode="${mode}"]`).classList.add('active');
  if (mode === 'premarket') runPreMarketScan();
}
async function runPreMarketScan() {
  if (watchlist.length === 0) return;
  setStatus('盘前扫描中...');
  const codes = watchlist.map(s => parseStockCode(s.secucode));
  const results = [];
  for (const parsed of codes) {
    try {
      const ctx = await buildStockContext(parsed);
      results.push(formatContextForAI(ctx));
      if (parsed.isHK) results.push(`→ 核查披露易：https://sc.hkexnews.hk/TuniS/di.hkex.com.hk/di/NSSrchCorp.aspx?src=MAIN&lang=ZH&g_lang=zh-HK&stockid=${parsed.code}`);
    } catch(e) { results.push(`${parsed.secucode} 错误`); }
  }
  chatInputEl.value = `盘前扫描 (${new Date().toLocaleDateString()})\n${results.join('\n')}\n请重点提示减持风险。`;
  sendMessage();
}

// 快速操作
async function handleQuickAction(action) {
  const stock = selectedStock?.secucode || watchlist[0]?.secucode || '';
  if (!stock && ['deep_analyze','quick_scan','risk_check','valuation'].includes(action)) { setStatus('请选择股票'); return; }
  const prompts = {
    'deep_analyze': `/deep_analyze ${stock}`,
    'quick_scan': `/quick_scan ${stock}`,
    'risk_check': `/risk_check ${stock}`,
    'valuation': `/valuation ${stock}`,
    'debate': `请对 ${stock} 进行多空辩论`,
    'info_extract': '请提取标的：' + chatInputEl.value
  };
  chatInputEl.value = prompts[action] || '';
  if (action !== 'info_extract') sendMessage();
}

// 启动
document.addEventListener('DOMContentLoaded', init);