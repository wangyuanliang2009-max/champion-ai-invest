/**
 * 冠军模式 AI 投资助手 - 主应用逻辑 (集成 UZI-Skill 分析指令)
 */

// ===== 语音播报管理 =====
const SpeechManager = {
  // ...（此部分代码与之前保持一致，无改动）...
  utterance: null,
  currentMsgId: null,
  state: 'idle',

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

  pause() { /* ...保持不变... */ },
  resume() { /* ...保持不变... */ },
  stop() { /* ...保持不变... */ },
  _setState(s) { this.state = s; },
  _updateButtons() { /* ...保持不变... */ },
};

// ===== DOM 引用 =====
// ...（此部分代码与之前保持一致，无改动）...
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
// ...（此部分代码与之前保持一致，无改动）...
function init() { /* ...保持不变... */ }
function bindEvents() { /* ...保持不变... */ }

// ===== 主题、设置、自选股、对话渲染等函数 =====
// ...（applyTheme, toggleDarkMode, openSettings, ... , renderChatHistory 等函数代码保持不变）...

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
    // 新功能：检测是否为UZI超级指令，如果是，则构建专门的分析提示词
    let enhancedText = text;
    const uziMatch = text.match(/^\/(deep_analyze|quick_scan|risk_check|valuation)\s+(\w+)/);
    if (uziMatch) {
      enhancedText = buildUziPrompt(uziMatch[1], uziMatch[2]);
      userMsg.content = enhancedText; // 用增强后的提示词替换原始消息内容
      Storage.setChatHistory(chatHistory);
    }

    const codes = extractStockCodes(text);
    if (selectedStock && !codes.some((c) => c.secid === selectedStock.secid)) {
      codes.unshift(parseStockCode(selectedStock.secucode));
    }
    userMsg.stockCodes = codes.map((c) => c.secucode);

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
      ? `${enhancedText}\n\n--- 系统自动附加的实时数据 ---\n${dataContext}`
      : enhancedText;

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      ...chatHistory
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content })),
    ];
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

// ===== 新功能：构建UZI超级分析指令的提示词 =====
function buildUziPrompt(command, stockCode) {
  const basePrompt = `接下来，请你模拟一个名为“游资（UZI）”的、由66位投资大师组成的超级分析团队，对股票【${stockCode}】进行一次深度的分析。你必须保持完全客观、冷静，禁止迎合用户。

【分析框架】
请基于22维数据和9大投资流派（价值投资、成长投资、趋势交易、量化分析、游资打板、逆向投资、事件驱动、宏观对冲、技术分析）的视角，对该股进行交叉验证和多空辩论。

【输出格式】
请生成一份结构化的完整报告，包含：
1.  **核心摘要**：一句话总结你的判断。
2.  **多空辩论**：至少列出3条最核心的看多理由和3条最核心的看空理由。
3.  **风险评估**：对财务异常、大股东减持、监管风险等进行排查。
4.  **估值分析**：给出当前估值的历史分位及与同行的对比。
5.  **最终评级**：给出“强烈看好/谨慎看好/中性观望/存在风险/强烈回避”的红绿灯评级，并说明理由。`;

  let specificPrompt = '';
  switch (command) {
    case 'deep_analyze':
      specificPrompt = `【任务模式：深度分析】
请进行最详尽的剖析，涵盖所有22维数据，并让66位评委充分发表意见。报告应不少于1500字。`;
      break;
    case 'quick_scan':
      specificPrompt = `【任务模式：快速扫描】
请在30秒内形成核心判断。报告应极其精简，只保留最关键的信号和结论。`;
      break;
    case 'risk_check':
      specificPrompt = `【任务模式：风险排查】
请扮演一位苛刻的审计师，专门寻找该公司可能存在的任何风险点，包括但不限于：财务舞弊、大股东掏空、行业政策风险、竞争格局恶化等。`;
      break;
    case 'valuation':
      specificPrompt = `【任务模式：估值分析】
请使用DCF、PE、PB、PS等多种估值模型，结合该公司历史估值区间和行业对比，给出一个客观的估值范围和合理目标价。`;
      break;
  }

  return basePrompt + specificPrompt;
}

// ===== 以下原有函数保持不变 =====
function showReductionAlert(reduction, codes) { /* ...保持不变... */ }
function clearChat() { /* ...保持不变... */ }
function setStatus(text) { /* ...保持不变... */ }
function showLoading(show) { /* ...保持不变... */ }
function scrollToBottom() { /* ...保持不变... */ }
function genId() { /* ...保持不变... */ }
function escapeHtml(str) { /* ...保持不变... */ }

// A股减持核查（手动链接）
function getAShareShareholding(stockCode) { /* ...保持不变... */ }

// 利空新闻查询
function getNegativeNews(stockCode) { /* ...保持不变... */ }

document.addEventListener('DOMContentLoaded', init);