'use strict';

const $ = id => document.getElementById(id);

const states = {
  idle:    $('state-idle'),
  loading: $('state-loading'),
  error:   $('state-error'),
  results: $('state-results'),
};

let expandedViolationIdx = -1;

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
  const scoring   = computeScore(results.violations);
  const counts    = countsByImpact(formatted.violations);
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

  // Violations list (similar to DevTools list, only violations)
  const listEl = $('violations-list');
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
        renderResults(results);

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

  showState('results');
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
