'use strict';

const $ = id => document.getElementById(id);

const states = {
  idle:    $('state-idle'),
  loading: $('state-loading'),
  error:   $('state-error'),
  results: $('state-results'),
};

let expandedViolationIdx = -1;
let expandedIncompleteIdx = -1;
let activeTab = 'violations';
let lastFormatted = null;

function showState(name) {
  for (const [k, el] of Object.entries(states)) el.classList.toggle('hidden', k !== name);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeImpact(impact) {
  return ['critical', 'serious', 'moderate', 'minor'].includes(impact) ? impact : 'null';
}

async function highlightSelector(selector, impact, description, help) {
  const tab = await getActiveTab();
  if (!tab || !selector) return;

  chrome.runtime.sendMessage({ type: MSG.UNHIGHLIGHT_ALL, tabId: tab.id }, () => {
    chrome.runtime.sendMessage({
      type: MSG.HIGHLIGHT_ELEMENT,
      tabId: tab.id,
      selector,
      impact,
      description,
      help,
    });
  });
}

async function runScan() {
  const tab = await getActiveTab();
  if (!tab) return showError(i18n.t('no_active_tab'));

  $('btn-scan').disabled = true;
  showState('loading');

  chrome.runtime.sendMessage({ type: MSG.SCAN_REQUEST, tabId: tab.id }, (resp) => {
    $('btn-scan').disabled = false;
    if (chrome.runtime.lastError) return showError(chrome.runtime.lastError.message);
    if (!resp || resp.type === MSG.SCAN_ERROR) return showError(resp?.error || i18n.t('scan_failed'));
    renderResults(resp.results);
  });
}

function renderResults(results) {
  const formatted = formatResults(results);
  lastFormatted = formatted;
  const scoring   = computeScore(results.violations);
  const score     = typeof scoring === 'number' ? scoring : scoring.score;
  const grade     = typeof scoring === 'object' ? scoring.grade : '';
  const breakdown = typeof scoring === 'object' ? scoring.breakdown : {};

  // Score ring
  const CIRCUMFERENCE = 150.8;
  const offset = CIRCUMFERENCE - (score / 100) * CIRCUMFERENCE;
  const ring = $('ring-progress');
  ring.style.strokeDashoffset = offset;
  ring.style.stroke = scoreColor(score);
  $('score-value').textContent = Math.round(score);
  $('score-grade').textContent = grade;

  // Breakdown
  for (const imp of ['critical', 'serious', 'moderate', 'minor']) {
    $(`cnt-${imp}`).textContent = breakdown[imp] || 0;
  }

  // Stats
  $('stat-violations').textContent = formatted.violations.length;
  $('stat-passes').textContent     = formatted.passes.length;
  $('stat-incomplete').textContent = formatted.incomplete.length;

  // Meta
  $('scan-url').textContent  = results.url || '';
  $('scan-time').textContent = results.timestamp ? new Date(results.timestamp).toLocaleString() : '';

  // Sync tab button active state
  for (const t of ['violations', 'passes', 'incomplete']) {
    document.getElementById(`tab-${t}`)?.classList.toggle('active', t === activeTab);
  }

  renderList(formatted);
  showState('results');
}

function renderList(formatted) {
  const titleMap = {
    violations: 'Results (Violations)',
    passes:     'Results (Passes)',
    incomplete: 'Results (Incomplete)',
  };
  document.querySelector('.popup-results-title').textContent = titleMap[activeTab];

  // Clear-highlights only relevant for violations / incomplete
  $('btn-clear-highlights').style.display = activeTab === 'passes' ? 'none' : '';

  const listEl = $('violations-list');

  if (activeTab === 'violations') {
    if (formatted.violations.length === 0) {
      listEl.innerHTML = `<div class="viol-empty">${i18n.t('no_violations')}</div>`;
      listEl.onclick = null;
    } else {
      listEl.innerHTML = formatted.violations.map((rule, idx) => `
        <div class="viol-item ${expandedViolationIdx === idx ? 'expanded' : ''}" data-rule-idx="${idx}">
          <button class="viol-head" data-action="toggle" data-rule-idx="${idx}">
            <div class="viol-head-top">
              <span class="viol-impact ${normalizeImpact(rule.impact)}"></span>
              <span class="viol-id">${escHtml(rule.id)}</span>
              <span class="viol-count">${rule.nodeCount}</span>
              <span class="viol-chevron">${expandedViolationIdx === idx ? '▾' : '▸'}</span>
            </div>
            <div class="viol-desc">${escHtml(rule.description || rule.help || '')}</div>
          </button>
          <div class="viol-nodes ${expandedViolationIdx === idx ? '' : 'hidden'}">
            ${rule.nodes.map((node, nIdx) => `
              <button
                class="viol-node-btn"
                data-action="highlight"
                data-rule-idx="${idx}"
                data-node-idx="${nIdx}"
                title="Click to highlight"
              >${escHtml(node.primarySelector || node.selector || '(no selector)')}</button>
            `).join('')}
          </div>
        </div>
      `).join('');

      listEl.onclick = async (e) => {
        const toggleBtn = e.target.closest('[data-action="toggle"]');
        if (toggleBtn) {
          const idx = Number(toggleBtn.dataset.ruleIdx);
          expandedViolationIdx = expandedViolationIdx === idx ? -1 : idx;
          const tab = await getActiveTab();
          chrome.runtime.sendMessage({ type: MSG.UNHIGHLIGHT_ALL, tabId: tab.id });
          renderList(formatted);
          return;
        }
        const hlBtn = e.target.closest('[data-action="highlight"]');
        if (hlBtn) {
          const rIdx = Number(hlBtn.dataset.ruleIdx);
          const nIdx = Number(hlBtn.dataset.nodeIdx);
          const rule = formatted.violations[rIdx];
          const node = rule?.nodes?.[nIdx];
          if (rule && node?.primarySelector) {
            await highlightSelector(node.primarySelector, rule.impact, rule.description, rule.help);
          }
        }
      };
    }

  } else if (activeTab === 'passes') {
    if (formatted.passes.length === 0) {
      listEl.innerHTML = '<div class="viol-empty">No passes found.</div>';
      listEl.onclick = null;
    } else {
      listEl.innerHTML = formatted.passes.map(rule => `
        <div class="viol-item">
          <div class="viol-head-top">
            <span class="viol-impact" style="background:var(--c-pass)"></span>
            <span class="viol-id">${escHtml(rule.id)}</span>
            <span class="viol-count">${rule.nodeCount}</span>
          </div>
          <div class="viol-desc">${escHtml(rule.description || rule.help || '')}</div>
        </div>
      `).join('');
      listEl.onclick = null;
    }

  } else if (activeTab === 'incomplete') {
    if (formatted.incomplete.length === 0) {
      listEl.innerHTML = '<div class="viol-empty">No incomplete checks found.</div>';
      listEl.onclick = null;
    } else {
      listEl.innerHTML = formatted.incomplete.map((rule, idx) => `
        <div class="viol-item ${expandedIncompleteIdx === idx ? 'expanded' : ''}" data-rule-idx="${idx}">
          <button class="viol-head" data-action="toggle-incomplete" data-rule-idx="${idx}">
            <div class="viol-head-top">
              <span class="viol-impact ${normalizeImpact(rule.impact)}"></span>
              <span class="viol-id">${escHtml(rule.id)}</span>
              <span class="viol-count">${rule.nodeCount}</span>
              <span class="viol-chevron">${expandedIncompleteIdx === idx ? '▾' : '▸'}</span>
            </div>
            <div class="viol-desc">${escHtml(rule.description || rule.help || '')}</div>
          </button>
          <div class="viol-nodes ${expandedIncompleteIdx === idx ? '' : 'hidden'}">
            ${rule.nodes.map((node, nIdx) => `
              <button
                class="viol-node-btn"
                data-action="highlight-incomplete"
                data-rule-idx="${idx}"
                data-node-idx="${nIdx}"
                title="Click to highlight"
              >${escHtml(node.primarySelector || node.selector || '(no selector)')}</button>
            `).join('')}
          </div>
        </div>
      `).join('');

      listEl.onclick = async (e) => {
        const toggleBtn = e.target.closest('[data-action="toggle-incomplete"]');
        if (toggleBtn) {
          const idx = Number(toggleBtn.dataset.ruleIdx);
          expandedIncompleteIdx = expandedIncompleteIdx === idx ? -1 : idx;
          renderList(formatted);
          return;
        }
        const hlBtn = e.target.closest('[data-action="highlight-incomplete"]');
        if (hlBtn) {
          const rIdx = Number(hlBtn.dataset.ruleIdx);
          const nIdx = Number(hlBtn.dataset.nodeIdx);
          const rule = formatted.incomplete[rIdx];
          const node = rule?.nodes?.[nIdx];
          if (rule && node?.primarySelector) {
            await highlightSelector(node.primarySelector, rule.impact, rule.description, rule.help);
          }
        }
      };
    }
  }
}

function showError(msg) {
  $('error-msg').textContent = msg;
  showState('error');
}

// Bootstrap: init i18n, apply DOM translations, then load cached results
(async () => {
  await i18n.initI18n();
  i18n.applyDOM();

  $('btn-scan').addEventListener('click', runScan);

  for (const t of ['violations', 'passes', 'incomplete']) {
    document.getElementById(`tab-${t}`)?.addEventListener('click', () => {
      activeTab = t;
      if (lastFormatted) renderList(lastFormatted);
      for (const s of ['violations', 'passes', 'incomplete']) {
        document.getElementById(`tab-${s}`)?.classList.toggle('active', s === t);
      }
    });
  }

  $('btn-clear-highlights').addEventListener('click', async () => {
    const t = await getActiveTab();
    if (t) chrome.runtime.sendMessage({ type: MSG.UNHIGHLIGHT_ALL, tabId: t.id });
  });

  const tab = await getActiveTab();
  if (!tab) return;

  // Always clear previous overlays when popup opens.
  chrome.runtime.sendMessage({ type: MSG.UNHIGHLIGHT_ALL, tabId: tab.id });

  chrome.runtime.sendMessage({ type: MSG.GET_CACHED_RESULTS, tabId: tab.id }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp?.cached?.results) renderResults(resp.cached.results);
  });

  let cleanedOnClose = false;
  const clearOnClose = () => {
    if (cleanedOnClose) return;
    cleanedOnClose = true;
    chrome.runtime.sendMessage({ type: MSG.UNHIGHLIGHT_ALL, tabId: tab.id });
  };

  window.addEventListener('pagehide', clearOnClose);
  window.addEventListener('beforeunload', clearOnClose);
  window.addEventListener('unload', clearOnClose);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') clearOnClose();
  });
})();
