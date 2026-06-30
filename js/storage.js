/**
 * localStorage 封装
 */
const Storage = {
  get(key, fallback = null) {
    try {
      const val = localStorage.getItem(key);
      return val != null ? JSON.parse(val) : fallback;
    } catch {
      return fallback;
    }
  },

  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },

  remove(key) {
    localStorage.removeItem(key);
  },

  getApiKey() {
    return localStorage.getItem(CONFIG.STORAGE_KEYS.API_KEY) || '';
  },

  setApiKey(key) {
    localStorage.setItem(CONFIG.STORAGE_KEYS.API_KEY, key);
  },

  getModel() {
    return localStorage.getItem(CONFIG.STORAGE_KEYS.MODEL) || 'deepseek-chat';
  },

  setModel(model) {
    localStorage.setItem(CONFIG.STORAGE_KEYS.MODEL, model);
  },

  getWatchlist() {
    return this.get(CONFIG.STORAGE_KEYS.WATCHLIST, []);
  },

  setWatchlist(list) {
    this.set(CONFIG.STORAGE_KEYS.WATCHLIST, list);
  },

  getChatHistory() {
    return this.get(CONFIG.STORAGE_KEYS.CHAT_HISTORY, []);
  },

  setChatHistory(history) {
    this.set(CONFIG.STORAGE_KEYS.CHAT_HISTORY, history);
  },

  isDarkMode() {
    return this.get(CONFIG.STORAGE_KEYS.DARK_MODE, false);
  },

  setDarkMode(val) {
    this.set(CONFIG.STORAGE_KEYS.DARK_MODE, val);
  },

  getQuoteCache() {
    return this.get(CONFIG.STORAGE_KEYS.QUOTE_CACHE, {});
  },

  setQuoteCache(cache) {
    this.set(CONFIG.STORAGE_KEYS.QUOTE_CACHE, cache);
  },

  getCachedQuote(secid) {
    const cache = this.getQuoteCache();
    const entry = cache[secid];
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CONFIG.CACHE_TTL) {
      delete cache[secid];
      this.setQuoteCache(cache);
      return null;
    }
    return entry.data;
  },

  setCachedQuote(secid, data) {
    const cache = this.getQuoteCache();
    cache[secid] = { data, timestamp: Date.now() };
    this.setQuoteCache(cache);
  },

  getRules() {
    const stored = this.get(CONFIG.STORAGE_KEYS.RULES, null);
    if (stored && Array.isArray(stored) && stored.length > 0) {
      return stored;
    }
    const defaults = CONFIG.DEFAULT_RULES.map((content) => ({
      id: 'rule_' + Math.random().toString(36).slice(2, 10),
      content,
      enabled: true,
    }));
    this.setRules(defaults);
    return defaults;
  },

  setRules(rules) {
    this.set(CONFIG.STORAGE_KEYS.RULES, rules);
  },

  getEnabledRules() {
    return this.getRules().filter((r) => r.enabled && r.content.trim());
  },
};
