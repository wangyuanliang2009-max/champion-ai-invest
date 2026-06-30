/**
 * 全局规则动态管理 + 语音输入
 */

const RulesManager = {
  rules: [],
  saveTimer: null,

  init() {
    this.rules = Storage.getRules();
    this.render();
    this.bindEvents();
    this.initSpeechInput();
    this.updateRulesBadge();
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
