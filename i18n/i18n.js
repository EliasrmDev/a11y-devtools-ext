'use strict';

/**
 * Lightweight i18n system for the a11y DevTools extension.
 *
 * Usage:
 *   await i18n.initI18n();      // call once on page load
 *   i18n.applyDOM();            // translate data-i18n elements
 *   i18n.t('key');              // get a translation
 *   i18n.t('key', { n: 42 });  // with variable interpolation
 */
(function () {
  const SUPPORTED = ['en', 'es', 'fr', 'de', 'pt'];

  /** Cached translations map for the active language. */
  let _cache = {};

  /** Resolved language code (set after initI18n). */
  let _lang = 'en';

  // ─── Language Detection ───────────────────────────────────────────────────

  function detectLang() {
    try {
      // chrome.i18n.getUILanguage works in all extension contexts
      if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) {
        const raw = chrome.i18n.getUILanguage();
        const short = raw.split('-')[0].toLowerCase();
        return SUPPORTED.includes(short) ? short : 'en';
      }
    } catch (_) { /* ignore */ }

    try {
      // Fallback for contexts without chrome.i18n
      const raw = navigator.language || 'en';
      const short = raw.split('-')[0].toLowerCase();
      return SUPPORTED.includes(short) ? short : 'en';
    } catch (_) { /* ignore */ }

    return 'en';
  }

  // ─── Storage helpers ──────────────────────────────────────────────────────

  /** Read a manually saved language override from chrome.storage. */
  function getSavedLang() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get('i18n_lang', data => {
          resolve((data && data.i18n_lang) || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  /** Persist a manual language override. */
  function setLang(lang) {
    if (!SUPPORTED.includes(lang)) return;
    return new Promise(resolve => {
      try {
        chrome.storage.local.set({ i18n_lang: lang }, resolve);
      } catch (_) {
        resolve();
      }
    });
  }

  // ─── JSON loader ──────────────────────────────────────────────────────────

  async function loadLang(lang) {
    const url = chrome.runtime.getURL(`i18n/${lang}.json`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`i18n: failed to load ${lang}.json (${resp.status})`);
    return resp.json();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Initialize translations. Must be awaited before calling t() or applyDOM().
   * @param {string} [overrideLang] - Force a specific language code.
   */
  async function initI18n(overrideLang) {
    const saved = await getSavedLang();
    _lang = overrideLang || saved || detectLang();

    try {
      _cache = await loadLang(_lang);
    } catch (_) {
      // Fallback to English if the target language file fails to load
      if (_lang !== 'en') {
        try {
          _cache = await loadLang('en');
          _lang  = 'en';
        } catch (_) {
          _cache = {};
        }
      } else {
        _cache = {};
      }
    }
  }

  /**
   * Return a translated string, with optional {variable} interpolation.
   * Falls back to the key itself when not found.
   *
   * @param {string} key
   * @param {Record<string, string|number>} [vars]
   * @returns {string}
   */
  function t(key, vars) {
    let str = _cache[key];

    if (str === undefined) {
      // Key not found — return the raw key as a last resort
      return key;
    }

    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.split(`{${k}}`).join(String(v));
      }
    }

    return str;
  }

  /**
   * Walk the DOM and replace text/attributes using data-i18n* attributes.
   *
   *   data-i18n="key"              → sets textContent
   *   data-i18n-placeholder="key" → sets placeholder attribute
   *   data-i18n-title="key"       → sets title attribute
   *   data-i18n-aria-label="key"  → sets aria-label attribute
   *
   * @param {Element|Document} [root]  Defaults to the whole document.
   */
  function applyDOM(root) {
    const ctx = root || document;

    ctx.querySelectorAll('[data-i18n]').forEach(el => {
      const val = t(el.dataset.i18n);
      if (val !== el.dataset.i18n) el.textContent = val;
    });

    ctx.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const val = t(el.dataset.i18nPlaceholder);
      if (val !== el.dataset.i18nPlaceholder) el.placeholder = val;
    });

    ctx.querySelectorAll('[data-i18n-title]').forEach(el => {
      const val = t(el.dataset.i18nTitle);
      if (val !== el.dataset.i18nTitle) el.title = val;
    });

    ctx.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
      const val = t(el.dataset.i18nAriaLabel);
      if (val !== el.dataset.i18nAriaLabel) el.setAttribute('aria-label', val);
    });
  }

  /** Return the currently active language code. */
  function getLang() { return _lang; }

  // ─── Expose on globalThis ─────────────────────────────────────────────────
  // Using globalThis works in window (popup/panel) and service worker contexts.
  const ns = typeof globalThis !== 'undefined' ? globalThis : self;
  ns.i18n = { initI18n, t, applyDOM, getLang, setLang, SUPPORTED };
})();
