'use strict';
/* global MSG, computeScore, scoreColor, formatResults, countsByImpact */

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
const state = {
  activeTab:       'violations',
  filterImpact:    '',
  filterText:      '',
  formattedResults: null,
  rawResults:      null,
  selectedRuleIdx: -1,
  selectedNodeIdx: -1,
  expandedGroups:  new Set(),
  highlightedSelectors: new Set(),
  previousResults: null,   // for compare
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const tabId = () => chrome.devtools.inspectedWindow.tabId;

function inferStatusTone(msg) {
  const text = String(msg || '').toLowerCase();
  if (text.includes('error') || text.includes('reloaded')) return 'error';
  if (text.includes('complete') || text.includes('loaded')) return 'success';
  return 'info';
}

function setStatus(msg, tone) {
  const statusEl = $('statusbar');
  if (!statusEl) return;
  statusEl.textContent = msg;
  const statusTone = tone || inferStatusTone(msg);
  statusEl.classList.remove('status-info', 'status-success', 'status-warning', 'status-error');
  statusEl.classList.add(`status-${statusTone}`);
}

function showLoading(show) {
  let overlay = document.querySelector('.loading-overlay');
  if (show) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'loading-overlay';
      overlay.innerHTML = '<div class="spinner"></div><span>Analyzing page…</span>';
      document.body.appendChild(overlay);
    }
  } else {
    overlay && overlay.remove();
  }
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function impactDot(impact) {
  return `<span class="impact-dot ${impact || 'null'}"></span>`;
}

function impactBadge(impact) {
  return `<span class="detail-impact-badge ${impact || ''}">${impact || 'n/a'}</span>`;
}

// ─────────────────────────────────────────────
// Scan
// ─────────────────────────────────────────────
function runScan() {
  showLoading(true);
  $('btn-scan').disabled = true;
  $('btn-export').disabled = true;
  setStatus('Scanning…');

  safeSendMessage({ type: MSG.SCAN_REQUEST, tabId: tabId() }, (resp) => {
    try {
      showLoading(false);
      $('btn-scan').disabled = false;

      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      if (!resp || resp.type === MSG.SCAN_ERROR) {
        setStatus('Scan error: ' + (resp?.error || 'unknown'));
        return;
      }

      state.previousResults = state.rawResults;
      state.rawResults      = resp.results;
      state.formattedResults = formatResults(resp.results);
      state.selectedRuleIdx = -1;
      state.selectedNodeIdx = -1;

      // Clear old highlights
      clearHighlights();

      $('btn-export').disabled = false;
      renderAll();
      setStatus(`Scan complete — ${resp.results.url || ''} at ${new Date(resp.results.timestamp).toLocaleTimeString()}`);
    } catch (e) {
      showLoading(false);
      $('btn-scan').disabled = false;
      if (e?.message?.includes('Extension context invalidated')) {
        setStatus('Extension reloaded — please close and reopen DevTools.');
      } else {
        throw e;
      }
    }
  });
}

function loadCachedResults() {
  safeSendMessage({ type: MSG.GET_CACHED_RESULTS, tabId: tabId() }, (resp) => {
    try {
      if (chrome.runtime.lastError || !resp?.cached?.results) return;
      state.rawResults       = resp.cached.results;
      state.formattedResults = formatResults(resp.cached.results);
      $('btn-export').disabled = false;
      renderAll();
      setStatus('Loaded cached results');
    } catch (e) {
      if (!e?.message?.includes('Extension context invalidated')) throw e;
    }
  });
}

// ─────────────────────────────────────────────
// Messaging helper — guards against invalidated extension context
// ─────────────────────────────────────────────
function safeSendMessage(msg, callback) {
  if (!chrome.runtime?.id) {
    setStatus('Extension reloaded — please close and reopen DevTools.');
    return;
  }
  try {
    if (callback) {
      chrome.runtime.sendMessage(msg, callback);
    } else {
      chrome.runtime.sendMessage(msg);
    }
  } catch (e) {
    if (e.message && e.message.includes('Extension context invalidated')) {
      setStatus('Extension reloaded — please close and reopen DevTools.');
    } else {
      throw e;
    }
  }
}

// ─────────────────────────────────────────────
// Highlight helpers
// ─────────────────────────────────────────────
function highlightSelector(selector, impact, description, help) {
  safeSendMessage({
    type: MSG.HIGHLIGHT_ELEMENT,
    tabId: tabId(), selector, impact, description, help,
  });
  state.highlightedSelectors.add(selector);
}

function scrollToSelector(selector) {
  safeSendMessage({ type: MSG.SCROLL_TO_ELEMENT, tabId: tabId(), selector });
}

function clearHighlights() {
  safeSendMessage({ type: MSG.UNHIGHLIGHT_ALL, tabId: tabId() });
  state.highlightedSelectors.clear();
}

// ─────────────────────────────────────────────
// Render top bar
// ─────────────────────────────────────────────
function renderTopBar() {
  const { formattedResults } = state;
  if (!formattedResults) return;

  const scoring  = computeScore(state.rawResults.violations);
  const score    = typeof scoring === 'number' ? scoring : scoring.score;
  const grade    = typeof scoring === 'object' ? scoring.grade : '';
  const breakdown = typeof scoring === 'object' ? scoring.breakdown : {};

  $('score-display').textContent = Math.round(score);
  $('score-display').style.color = scoreColor(score);
  $('grade-display').textContent = grade;

  for (const imp of ['critical','serious','moderate','minor']) {
    $(`c-${imp}`).textContent = breakdown[imp] || 0;
  }

  $('tb-violations').textContent = formattedResults.violations.length;
  $('tb-passes').textContent     = formattedResults.passes.length;
  $('tb-incomplete').textContent = formattedResults.incomplete.length;
}

// ─────────────────────────────────────────────
// Render issue list
// ─────────────────────────────────────────────
function getActiveRules() {
  if (!state.formattedResults) return [];
  const rules = state.formattedResults[state.activeTab] || [];
  return rules.filter(r => {
    if (state.filterImpact && r.impact !== state.filterImpact) return false;
    if (state.filterText) {
      const q = state.filterText.toLowerCase();
      return r.id.includes(q) || r.description.toLowerCase().includes(q) || r.help.toLowerCase().includes(q);
    }
    return true;
  });
}

function renderIssueList() {
  const list  = $('issue-list');
  const empty = $('empty-state');
  const rules = getActiveRules();

  if (!state.formattedResults || rules.length === 0) {
    list.innerHTML = '';
    empty.style.display = state.formattedResults ? 'flex' : 'flex';
    if (state.formattedResults && rules.length === 0) {
      empty.innerHTML = '<div class="empty-icon">✓</div><p>No issues found for current filter</p>';
    }
    return;
  }

  empty.style.display = 'none';

  const frag = document.createDocumentFragment();

  rules.forEach((rule, rIdx) => {
    const isExpanded = state.expandedGroups.has(rIdx);
    const isSelected = state.selectedRuleIdx === rIdx;

    const item = document.createElement('div');
    item.className = 'issue-item' + (isSelected ? ' selected' : '');
    item.dataset.ruleIdx = rIdx;
    item.innerHTML = `
      ${impactDot(rule.impact)}
      <div class="issue-body">
        <div class="issue-id">${escHtml(rule.id)}</div>
        <div class="issue-desc" title="${escHtml(rule.description)}">${escHtml(rule.description)}</div>
        <div class="issue-meta">${rule.nodeCount} element${rule.nodeCount !== 1 ? 's' : ''}</div>
      </div>
      <span style="font-size:9px;color:var(--c-sub);margin-left:4px">${isExpanded ? '▾' : '▸'}</span>
    `;
    item.addEventListener('click', () => selectRule(rIdx));
    frag.appendChild(item);

    // Expanded nodes
    if (isExpanded && rule.nodes.length > 0) {
      rule.nodes.forEach((node, nIdx) => {
        const ni = document.createElement('div');
        ni.className = 'issue-node-item' + (isSelected && state.selectedNodeIdx === nIdx ? ' selected' : '');
        ni.dataset.ruleIdx = rIdx;
        ni.dataset.nodeIdx = nIdx;
        ni.innerHTML = `
          <span class="node-selector" title="${escHtml(node.selector)}">${escHtml(node.primarySelector || node.selector)}</span>
          <button class="node-highlight-btn" title="Highlight">◎</button>
        `;
        ni.querySelector('.node-highlight-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          highlightSelector(node.primarySelector, rule.impact, rule.description, rule.help);
          scrollToSelector(node.primarySelector);
        });
        ni.addEventListener('click', () => selectNode(rIdx, nIdx));
        frag.appendChild(ni);
      });
    }
  });

  list.innerHTML = '';
  list.appendChild(frag);
}

function selectRule(rIdx) {
  const wasExpanded = state.expandedGroups.has(rIdx);
  const wasSelected = state.selectedRuleIdx === rIdx;

  // Collapse previously expanded
  if (!wasSelected || !wasExpanded) {
    state.expandedGroups.clear();
    state.expandedGroups.add(rIdx);
  } else {
    state.expandedGroups.delete(rIdx);
  }

  state.selectedRuleIdx = rIdx;
  state.selectedNodeIdx = -1;
  renderIssueList();
  renderDetail();

  // Auto-highlight all nodes for this rule
  const rules = getActiveRules();
  const rule  = rules[rIdx];
  if (rule) {
    clearHighlights();
    rule.nodes.forEach(n => highlightSelector(n.primarySelector, rule.impact, rule.description, rule.help));
  }
}

function selectNode(rIdx, nIdx) {
  state.selectedRuleIdx = rIdx;
  state.selectedNodeIdx = nIdx;

  const rules = getActiveRules();
  const rule  = rules[rIdx];
  const node  = rule?.nodes[nIdx];
  if (node) {
    clearHighlights();
    highlightSelector(node.primarySelector, rule.impact, rule.description, rule.help);
    scrollToSelector(node.primarySelector);
  }

  renderIssueList();
  renderDetail();
}

// ─────────────────────────────────────────────
// Render detail panel
// ─────────────────────────────────────────────
function renderDetail() {
  const placeholder = $('detail-placeholder');
  const content     = $('detail-content');
  const rules       = getActiveRules();
  const rule        = rules[state.selectedRuleIdx];

  if (!rule) {
    placeholder.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }

  placeholder.classList.add('hidden');
  content.classList.remove('hidden');

  const activeNodeIdx = state.selectedNodeIdx >= 0 ? state.selectedNodeIdx : 0;

  const tagsHtml = rule.tags.length
    ? `<div class="tags-row">${rule.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>`
    : '';

  const nodesHtml = rule.nodes.map((node, i) => {
    const isActive = i === activeNodeIdx;
    return `
      <div class="node-detail-item ${isActive ? 'active-node' : ''}" data-node-idx="${i}">
        <div class="nd-selector">
          <span style="color:var(--c-sub)">#${i+1}</span>
          ${escHtml(node.primarySelector || node.selector)}
          <span style="flex:1"></span>
          <button class="nd-nav" data-action="scroll" data-sel="${escHtml(node.primarySelector)}" style="display:inline;padding:1px 5px;font-size:9px;border:1px solid var(--c-border);border-radius:2px;background:var(--c-surface);color:var(--c-text);cursor:pointer">↗ Scroll</button>
        </div>
        ${node.html ? `<div class="nd-html">${escHtml(node.html)}</div>` : ''}
        ${node.failureSummary ? `<div class="nd-failure">${escHtml(node.failureSummary)}</div>` : ''}
      </div>`;
  }).join('');

  content.innerHTML = `
    <div class="detail-header">
      <div class="detail-rule-id">
        ${impactBadge(rule.impact)}
        <code>${escHtml(rule.id)}</code>
        ${rule.helpUrl ? `<a class="detail-link" href="${escHtml(rule.helpUrl)}" target="_blank">Docs ↗</a>` : ''}
      </div>
      <div class="detail-title">${escHtml(rule.description)}</div>
      <div class="detail-help">${escHtml(rule.help)}</div>
      ${tagsHtml}
    </div>

    ${rule.nodes.length > 0 ? `
    <div class="detail-section">
      <div class="detail-section-title">Elements (${rule.nodes.length})</div>
      <div class="nd-nav" style="margin-bottom:6px;justify-content:flex-start;gap:4px;">
        <button id="btn-prev-node" ${activeNodeIdx === 0 ? 'disabled' : ''}>◀ Prev</button>
        <span class="nav-position">${activeNodeIdx+1} / ${rule.nodes.length}</span>
        <button id="btn-next-node" ${activeNodeIdx === rule.nodes.length-1 ? 'disabled' : ''}>Next ▶</button>
        <button id="btn-highlight-all" style="margin-left:6px">Highlight All</button>
        <button id="btn-clear-hl">Clear</button>
      </div>
      ${nodesHtml}
    </div>` : '<div class="detail-section"><div class="detail-section-title">No elements</div></div>'}
  `;

  // Node click → select
  content.querySelectorAll('.node-detail-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const i = parseInt(el.dataset.nodeIdx);
      selectNode(state.selectedRuleIdx, i);
    });
  });

  // Scroll buttons
  content.querySelectorAll('[data-action="scroll"]').forEach(btn => {
    btn.addEventListener('click', () => scrollToSelector(btn.dataset.sel));
  });

  // Prev / Next node
  const btnPrev = $('btn-prev-node');
  const btnNext = $('btn-next-node');
  if (btnPrev) btnPrev.addEventListener('click', () => selectNode(state.selectedRuleIdx, activeNodeIdx - 1));
  if (btnNext) btnNext.addEventListener('click', () => selectNode(state.selectedRuleIdx, activeNodeIdx + 1));

  // Highlight all
  const btnHl = $('btn-highlight-all');
  if (btnHl) btnHl.addEventListener('click', () => {
    clearHighlights();
    rule.nodes.forEach(n => highlightSelector(n.primarySelector, rule.impact, rule.description, rule.help));
  });

  const btnCl = $('btn-clear-hl');
  if (btnCl) btnCl.addEventListener('click', clearHighlights);
}

// ─────────────────────────────────────────────
// Render all
// ─────────────────────────────────────────────
function renderAll() {
  renderTopBar();
  renderIssueList();
  renderDetail();
}

// ─────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────
function exportJSON() {
  if (!state.rawResults) return;
  const json = JSON.stringify(state.rawResults, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const ts   = new Date().toISOString().replace(/[:.]/g, '-');
  a.href     = url;
  a.download = `a11y-results-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────
// Event wiring
// ─────────────────────────────────────────────

// Remove all highlights when DevTools is closed
window.addEventListener('beforeunload', () => {
  clearHighlights();
});

$('btn-scan').addEventListener('click', runScan);
$('btn-export').addEventListener('click', exportJSON);

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.activeTab       = tab.dataset.tab;
    state.selectedRuleIdx = -1;
    state.selectedNodeIdx = -1;
    state.expandedGroups.clear();
    clearHighlights();
    renderIssueList();
    renderDetail();
  });
});

// Filters
$('filter-impact').addEventListener('change', e => {
  state.filterImpact    = e.target.value;
  state.selectedRuleIdx = -1;
  state.selectedNodeIdx = -1;
  state.expandedGroups.clear();
  renderIssueList();
  renderDetail();
});

let searchTimer;
$('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filterText      = e.target.value.trim();
    state.selectedRuleIdx = -1;
    state.selectedNodeIdx = -1;
    state.expandedGroups.clear();
    renderIssueList();
    renderDetail();
  }, 200);
});

// Impact counter click → quick filter
['critical','serious','moderate','minor'].forEach(imp => {
  $(`nav-${imp}`).addEventListener('click', () => {
    const isActive = state.filterImpact === imp;
    state.filterImpact = isActive ? '' : imp;
    $('filter-impact').value = state.filterImpact;
    document.querySelectorAll('.counter').forEach(c => c.classList.remove('active'));
    if (!isActive) $(`nav-${imp}`).classList.add('active');
    state.selectedRuleIdx = -1;
    state.expandedGroups.clear();
    renderIssueList();
    renderDetail();
  });
});

// ─────────────────────────────────────────────
// Resizable sidebar
// ─────────────────────────────────────────────
const resizeHandle = $('resize-handle');
const sidebar      = document.querySelector('.sidebar');
let   dragging     = false;
let   startX       = 0;
let   startW       = 0;

resizeHandle.addEventListener('mousedown', e => {
  dragging = true;
  startX   = e.clientX;
  startW   = sidebar.offsetWidth;
  resizeHandle.classList.add('dragging');
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const w = Math.max(180, Math.min(startW + e.clientX - startX, window.innerWidth * 0.7));
  sidebar.style.width = w + 'px';
});
document.addEventListener('mouseup', () => {
  dragging = false;
  resizeHandle.classList.remove('dragging');
});

// ─────────────────────────────────────────────
// Keyboard navigation
// ─────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const rules = getActiveRules();
  if (!rules.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = Math.min(state.selectedRuleIdx + 1, rules.length - 1);
    selectRule(next);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = Math.max(state.selectedRuleIdx - 1, 0);
    selectRule(prev);
  } else if (e.key === 'ArrowRight' && state.selectedRuleIdx >= 0) {
    e.preventDefault();
    const rule = rules[state.selectedRuleIdx];
    if (rule && state.selectedNodeIdx < rule.nodes.length - 1) {
      selectNode(state.selectedRuleIdx, state.selectedNodeIdx + 1);
    }
  } else if (e.key === 'ArrowLeft' && state.selectedNodeIdx > 0) {
    e.preventDefault();
    selectNode(state.selectedRuleIdx, state.selectedNodeIdx - 1);
  }
});

// ─────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────
loadCachedResults();
