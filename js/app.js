/**
 * 冠军模式 AI 投资助手 - 主应用逻辑 (V3.0 重构版)
 * 架构：信息输入 → 自动分类 → 双AI交叉分析 → 自校验 → 多角色辩论 → 报告输出
 */

// ===== 全局配置 =====
const MAX_SELF_CORRECT_LOOP = 2; // Maker-Verifier 自校验最大循环次数
const DOUBAO_API_ENABLED = true; // 是否启用豆包API进行交叉分析

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
const quickActionsEl = $('#quickActions');
const fileUploadArea = $('#fileUploadArea');
const fileInput = $('#fileInput');

let selectedStock = null;
let chatHistory = [];
let watchlist = [];
let currentMode = 'chat'; // chat | premarket | postmarket | info

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
  // ...（原有事件绑定：深色模式、设置、自选股等基本保持不变）...
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

  // 新模式：分析模式切换
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode));
  });

  // 新模式：快速操作芯片
  quickActionsEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('action-chip')) {
      const action = e.target.dataset.action;
      handleQuickAction(action);
    }
  });

  // 新模式：文件上传
  fileUploadArea.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileUpload);
}

function switchMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.mode-tab[data-mode="${mode}"]`).classList.add('active');
  chatInputEl.placeholder = {
    'chat': '输入股票代码或分析指令...',
    'premarket': '盘前速览模式：自动抓取自选股异动...',
    'postmarket': '盘后体检模式：对持仓进行深度复查...',
    'info': '粘贴产业新闻、研报或投资信息...'
  }[mode];
  setStatus(`已切换到${document.querySelector(`.mode-tab[data-mode="${mode}"]`).textContent}模式`);
}

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

async function handleFileUpload(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;
  
  for (const file of files) {
    setStatus(`正在用豆包分析 ${file.name} ...`);
    try {
      const base64 = await fileToBase64(file);
      const analysis = await callDoubaoForVision(base64); // 调用豆包视觉分析
      chatInputEl.value += `\n[豆包分析: ${file.name}] ${analysis}`;
      setStatus(`已提取 ${file.name} 的内容`);
    } catch (err) {
      setStatus(`文件分析失败: ${err.message}`);
    }
  }
  fileInput.value = ''; // 清空input，允许重复上传相同文件
}

// ===== 核心：发送消息并执行 Maker-Verifier 内循环 =====
async function sendMessage() {
  const text = chatInputEl.value.trim();
  if (!text) return;

  if (!Storage.getApiKey()) { openSettings(); setStatus('请先配置 DeepSeek API 密钥'); return; }

  SpeechManager.stop();
  const userMsg = { id: genId(), role: 'user', content: text, time: nowStr(), stockCodes: [] };
  chatHistory.push(userMsg);
  Storage.setChatHistory(chatHistory);
  appendMessageUI(userMsg);
  chatInputEl.value = '';
  scrollToBottom();

  showLoading(true);
  setStatus('正在执行 Maker-Verifier 自校验循环...');

  try {
    // Step 1: 构建包含防幻觉规则的严格系统提示词
    const strictSystemPrompt = buildSystemPrompt() + `\n\n【最高优先级：防幻觉规则】\n1. 只回答有可靠信源的问题，不懂就明确说“不知道”，拒绝猜测。\n2. 在给出判断前，先展示推理过程。\n3. 基于原文引用回答，并标注信息来源。`;

    // Step 2: 执行 Maker-Verifier 内循环
    let finalReply = '';
    for (let i = 0; i < MAX_SELF_CORRECT_LOOP; i++) {
      // 2a. Maker：生成回复
      const makerMessages = [
        { role: 'system', content: strictSystemPrompt },
        ...chatHistory.filter(m => m.role === 'user' || m.role === 'assistant').slice(-5).map(m => ({ role: m.role, content: m.content }))
      ];
      const draftReply = await callDeepSeek(makerMessages);
      
      // 2b. Verifier：自动校验
      const verifierMessages = [
        { role: 'system', content: `你是严格的分析结果校验者。请检查以下AI回复，看是否违反了以下规则：\n1. 是否做到了客观冷静，不迎合用户？\n2. 是否标注了数据来源和时间？\n3. 是否存在逻辑漏洞或过度推测？\n如果发现任何问题，请直接给出具体的修改意见。如果没有问题，请只回复"PASS"。\n\n【待校验的回复】\n${draftReply}` },
      ];
      const checkResult = await callDeepSeek(verifierMessages);
      
      if (checkResult.trim().toUpperCase() === 'PASS') {
        finalReply = draftReply;
        break;
      } else {
        // 校验失败，将修改意见加入对话，重新生成
        chatHistory.push({ id: genId(), role: 'user', content: `【系统自动校验反馈】\n${checkResult}\n\n请根据以上反馈，修正你的分析报告。` });
        setStatus(`第${i+1}轮自我校验未通过，正在修正...`);
      }
    }
    if (!finalReply) finalReply = '分析过程达到最大迭代次数，但仍存在潜在缺陷，仅供参考。';

    // Step 3: 如果有豆包API，则进行交叉分析（可选项）
    if (DOUBAO_API_ENABLED && Storage.getDoubaoApiKey()) {
      const doubaoOpinion = await callDoubaoForCrossCheck(text);
      finalReply += `\n\n---\n**🤖 豆包AI的独立交叉分析**\n${doubaoOpinion}`;
    }

    const assistantMsg = { id: genId(), role: 'assistant', content: finalReply, dataContext: null, time: nowStr(), stockCodes: [] };
    chatHistory.push(assistantMsg);
    appendMessageUI(assistantMsg);
    setStatus('分析完成（经内循环校验）');
  } catch (err) {
    // ...（错误处理保持不变）...
  } finally {
    showLoading(false);
    scrollToBottom();
  }
}

// ===== 新函数：调用豆包API进行视觉分析 =====
async function callDoubaoForVision(base64Data) {
  const apiKey = Storage.getDoubaoApiKey();
  if (!apiKey) throw new Error('豆包API密钥未配置');
  // ...（调用豆包视觉API的逻辑，返回提取的文字内容）...
}

// ===== 新函数：调用豆包API进行交叉分析 =====
async function callDoubaoForCrossCheck(originalQuery) {
  // ...（调用豆包API，基于相同输入进行独立分析，返回分析结果）...
}

// ===== 以下保留原有函数（辅助函数、UI更新、减持核查等） =====
// ...（保持与之前版本一致）...