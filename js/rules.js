/**
 * 全局规则动态管理 + 语音输入
 */

const RulesManager = {
  rules: [],
  saveTimer: null,

  init() {
    this.rules = Storage.getRules();
    
    // 补全默认规则：如果首次使用或规则数量不足，自动补齐10条核心规则
    if (!this.rules || this.rules.length < 10) {
      const essentialRules = [
        "永远客观冷静，不迎合，不安抚用户情绪。",
        "分析任何标的之前，必须核查大股东近3个月减持记录（港股用披露易，A股用东方财富/巨潮资讯网）。",
        "分析港股标的之前，必须核查近20日日均成交额，低于1亿港元自动警告。",
        "数据必须标注来源和获取时间，禁止凭记忆或推算给出数据。",
        "永远基于事实和逻辑进行分析，不凭感觉。",
        "当用户判断与事实不符时，直接指出，不委婉，不回避。",
        "在港股，永远选择最纯粹的标的。能买子公司，不买母公司。",
        "当某个板块或标的短期内涨幅超过20%且没有新的基本面催化剂时，禁止追高加仓。",
        "港股流动性差，存在结构性折价，大股东减持会放大跌幅，必须警惕。",
        "必须核查公司是否有大股东/管理层近期减持行为，若有则高度警惕。"
      ];
      
      // 用核心规则覆盖初始化，确保用户从完整的投资纪律开始
      this.rules = essentialRules.map((content, index) => ({
        id: 'default_rule_' + index,
        content: content,
        enabled: true
      }));
      this.persist();
    }
    
    this.render();
    this.bindEvents();
    this.initSpeechInput();
    this.updateRulesBadge();
    this.scheduleSelfRefine(); 
  },

  genId() {
    return 'rule_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  },

  bindEvents() {
    $('#navChat')?.addEventListener('click', () => this.showView('chat'));
    $('#navRules')?.addEventListener('click', () => this.showView('rules'));
    $('#btnCloseRules')?.addEventListener('click', () => this.showView('chat'));
    $('#btnAddRule')?.addEventListener('click', () => this.addRuleFromInput());
    $('#newRuleInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.addRuleFromInput();
      }
    });
  },

  showView(view) {
    const isRules = view === 'rules';
    $('#rulesPanel')?.classList.toggle('hidden', !isRules);
    $('#navChat')?.classList.toggle('active', !isRules);
    $('#navRules')?.classList.toggle('active', isRules);
    $('.main')?.classList.toggle('hidden', isRules);
    if (isRules) this.render();
  },

  addRuleFromInput() {
    const input = $('#newRuleInput');
    const content = input?.value.trim() || '';
    this.rules.push({ id: this.genId(), content, enabled: true });
    if (input) input.value = '';
    this.persist();
    this.render();
    const last = $('#rulesList')?.querySelector('.rule-item:last-child .rule-content');
    last?.focus();
    setStatus(content ? '规则已添加' : '已添加空白规则，请编辑内容');
  },

  updateRule(id, field, value) {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return;
    rule[field] = value;
    this.persistDebounced();
    this.updateRulesBadge();
  },

  deleteRule(id) {
    this.rules = this.rules.filter((r) => r.id !== id);
    this.persist();
    this.render();
    this.updateRulesBadge();
    setStatus('规则已删除');
  },

  persistDebounced() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 400);
  },

  persist() {
    Storage.setRules(this.rules);
    this.updateRulesBadge();
  },

  updateRulesBadge() {
    const badge = $('.rules-badge');
    if (!badge) return;
    const enabled = this.rules.filter((r) => r.enabled && r.content.trim()).length;
    badge.textContent = enabled > 0 ? `冠军模式已启用 (${enabled}条规则)` : '冠军模式已启用';
  },

  render() {
    const list = $('#rulesList');
    if (!list) return;

    list.innerHTML = '';

    if (this.rules.length === 0) {
      list.innerHTML = '<p class="rules-empty">暂无规则，点击下方「新增规则」添加</p>';
      return;
    }

    this.rules.forEach((rule, index) => {
      const item = document.createElement('div');
      item.className = 'rule-item';
      item.dataset.id = rule.id;

      const header = document.createElement('div');
      header.className = 'rule-item-header';

      const idx = document.createElement('span');
      idx.className = 'rule-index';
      idx.textContent = `#${index + 1}`;

      const label = document.createElement('label');
      label.className = 'toggle-switch';
      label.title = rule.enabled ? '已启用' : '已禁用';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'rule-toggle';
      toggle.dataset.id = rule.id;
      toggle.checked = rule.enabled;

      const slider = document.createElement('span');
      slider.className = 'toggle-slider';

      label.appendChild(toggle);
      label.appendChild(slider);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-ghost btn-sm rule-delete';
      delBtn.dataset.id = rule.id;
      delBtn.title = '删除';
      delBtn.textContent = '🗑';

      header.appendChild(idx);
      header.appendChild(label);
      header.appendChild(delBtn);

      const textarea = document.createElement('textarea');
      textarea.className = 'rule-content';
      textarea.dataset.id = rule.id;
      textarea.rows = 2;
      textarea.placeholder = '输入规则内容…';
      textarea.value = rule.content;

      item.appendChild(header);
      item.appendChild(textarea);
      list.appendChild(item);

      textarea.addEventListener('input', (e) => {
        this.updateRule(e.target.dataset.id, 'content', e.target.value);
      });
      toggle.addEventListener('change', (e) => {
        this.updateRule(e.target.dataset.id, 'enabled', e.target.checked);
      });
      delBtn.addEventListener('click', () => {
        if (confirm('确定删除这条规则？')) this.deleteRule(rule.id);
      });
    });
  },

  initSpeechInput() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = $('#btnRuleMic');
    const input = $('#newRuleInput');

    if (!SpeechRecognition || !btn) {
      btn?.classList.add('hidden');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;

    let listening = false;

    const stopListening = () => {
      if (!listening) return;
      listening = false;
      btn.classList.remove('recording');
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
    };

    btn.addEventListener('click', () => {
      if (listening) {
        stopListening();
        return;
      }
      if (SpeechManager.state === 'speaking' || SpeechManager.state === 'paused') {
        SpeechManager.stop();
      }
      listening = true;
      btn.classList.add('recording');
      setStatus('正在聆听，请说话…');
      try {
        recognition.start();
      } catch {
        stopListening();
        setStatus('无法启动语音识别，请重试');
      }
    });

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      if (input) {
        const base = input.value.trim();
        input.value = base ? base + transcript : transcript;
      }
    };

    recognition.onend = () => {
      if (listening) {
        listening = false;
        btn.classList.remove('recording');
        setStatus('语音识别完成');
      }
    };

    recognition.onerror = (event) => {
      stopListening();
      if (event.error !== 'aborted') {
        setStatus(`语音识别失败: ${event.error}`);
      }
    };
  },

  // ===== 外层循环：每日自动复盘进化 =====
  scheduleSelfRefine() {
    const now = new Date();
    const targetHour = 18;
    let triggerTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), targetHour, 0, 0);
    if (now > triggerTime) triggerTime.setDate(triggerTime.getDate() + 1);
    
    const msUntilTrigger = triggerTime - now;
    setTimeout(() => {
      this.runOuterSelfRefineLoop();
      setInterval(() => this.runOuterSelfRefineLoop(), 24 * 60 * 60 * 1000);
    }, msUntilTrigger);
  },

  async runOuterSelfRefineLoop() {
    if (!Storage.getApiKey()) return;
    setStatus('外层循环复盘：正在总结投资经验...');
    const allHistory = Storage.getChatHistory();
    if (!allHistory || allHistory.length === 0) return;

    const messages = [
      { 
        role: 'system', 
        content: '你是冠军模式投资助手的系统进化师。请复盘以下最近的投资对话，找出高频错误或可优化的分析模式，直接给出2-3条具体的、可执行的优化建议，每条建议都以"规则："开头。' 
      },
      { 
        role: 'user', 
        content: JSON.stringify(allHistory.slice(-30)) 
      }
    ];
    
    try {
      const reply = await callDeepSeek(messages);
      const reportMsg = {
        id: 'refine_' + Date.now(),
        role: 'assistant',
        content: `**📈 每日进化建议**\n${reply}\n\n（可将建议手动添加到规则面板）`,
        time: nowStr()
      };
      const chatHistory = Storage.getChatHistory();
      chatHistory.push(reportMsg);
      Storage.setChatHistory(chatHistory);
    } catch (e) {
      // 静默失败，不影响主流程
    }
  },
};

/**
 * 构建完整系统提示词：基础框架 + 已启用规则
 */
function buildSystemPrompt() {
  const enabled = Storage.getEnabledRules();
  let prompt = CONFIG.CHAMPION_SYSTEM_PROMPT;

  if (enabled.length > 0) {
    const rulesText = enabled.map((r, i) => `${i + 1}. ${r.content.trim()}`).join('\n');
    prompt += `\n\n【必须严格遵守的规则】\n${rulesText}`;
  }

  return prompt;
}