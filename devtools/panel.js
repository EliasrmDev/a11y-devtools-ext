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
  availableRules:  [],
  availableTags:   [],
  customMode:      false,
  selectedPresetIds: new Set(),
  scanFilterType:  'rule',
  selectedRuleIds: new Set(),
  selectedTags:    new Set(),
  customExtraTags: new Set(),
  rulesSearchText: '',
  rulesTagFilter:  '',
  selectedRuleIdx: -1,
  selectedNodeIdx: -1,
  expandedGroups:  new Set(),
  collapsedTagGroups: new Set(),
  highlightedSelectors: new Set(),
  elementScope: null,
  previousResults: null,   // for compare
  pickerActive: false,
  pickerSelector: null,
  pickerLabel: '',
  pickerScopeSelector: null,
  pickerScopeReason: '',
  pickerScopeLabel: '',
  lastScanTarget: null,
  lastScanConfig: null,
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const tabId = () => chrome.devtools.inspectedWindow.tabId;

const RECOMMENDED_PRESETS = [
  {
    id: 'wcag-minimo-a',
    name: 'WCAG Minimo A',
    description: 'Cobertura base de cumplimiento A',
    checked: false,
    usageLevel: 'medium',
    filterType: 'tag',
    values: ['wcag2a', 'wcag21a'],
  },
  {
    id: 'wcag-recomendado-aa',
    name: 'WCAG Recomendado AA',
    description: 'Combinacion recomendada para la mayoria de productos',
    checked: false,
    usageLevel: 'medium',
    filterType: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  },
  {
    id: 'cumplimiento-y-buenas-practicas',
    name: 'Cumplimiento y Buenas Practicas',
    description: 'AA mas best-practice para calidad extendida',
    checked: true,
    usageLevel: 'top',
    filterType: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
  },
  {
    id: 'teclado-y-foco',
    name: 'Teclado y Foco',
    description: 'Navegacion por teclado y estados de foco',
    checked: false,
    usageLevel: 'low',
    filterType: 'tag',
    values: ['cat.keyboard'],
  },
  {
    id: 'formularios-y-nombre-rol-valor',
    name: 'Formularios y Etiquetas',
    description: 'Errores de formularios, labels y nombre/rol/valor',
    checked: false,
    usageLevel: 'medium',
    filterType: 'tag',
    values: ['cat.forms', 'cat.name-role-value'],
  },
  {
    id: 'color-y-contraste',
    name: 'Color y Contraste',
    description: 'Revision centrada en color, contraste y senales visuales',
    checked: false,
    usageLevel: 'low',
    filterType: 'tag',
    values: ['cat.color', 'cat.sensory-and-visual-cues'],
  },
];

const TAG_GROUPS = [
  { id: 'wcag20',        label: 'WCAG 2.0',               match: t => /^wcag2a{1,3}$/.test(t) },
  { id: 'wcag21',        label: 'WCAG 2.1',               match: t => /^wcag21a{1,2}$/.test(t) },
  { id: 'wcag22',        label: 'WCAG 2.2',               match: t => /^wcag22a{1,2}$/.test(t) },
  { id: 'wcag-sc',       label: 'WCAG Success Criteria',  match: t => /^wcag\d{3,}$/.test(t) },
  { id: 'wcag-obsolete', label: 'WCAG Obsolete',          match: t => t.endsWith('-obsolete') },
  { id: 'best-practice', label: 'Best Practices',         match: t => t === 'best-practice' },
  { id: 'act',           label: 'ACT Rules',              match: t => /^ACT$/i.test(t) },
  { id: 'section508',    label: 'Section 508',            match: t => t.startsWith('section508') },
  { id: 'ttv5',          label: 'Trusted Tester v5',      match: t => /^TT/i.test(t) },
  { id: 'en301549',      label: 'EN 301 549',             match: t => /^EN/i.test(t) },
  { id: 'rgaa',          label: 'RGAA',                   match: t => /^RGAA/i.test(t) },
  { id: 'experimental',  label: 'Experimental',           match: t => t === 'experimental' },
  { id: 'cat',           label: 'Categories (Deque)',     match: t => t.startsWith('cat.') },
  { id: 'other',         label: 'Other',                  match: () => true },
];

function classifyTag(tag) {
  for (const group of TAG_GROUPS) {
    if (group.match(tag)) return group;
  }
  return TAG_GROUPS[TAG_GROUPS.length - 1];
}

function groupTags(tags) {
  const grouped = new Map();
  tags.forEach(tag => {
    const group = classifyTag(tag);
    if (!grouped.has(group.id)) grouped.set(group.id, { label: group.label, tags: [] });
    grouped.get(group.id).tags.push(tag);
  });
  return grouped;
}

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
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
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
function runScan(filterType, selectedValues) {
  const mode = filterType === 'tag' ? 'tag' : 'rule';
  const selected = Array.isArray(selectedValues) ? selectedValues : [];
  if (!selected.length) {
    setStatus(`Select at least one ${mode === 'tag' ? 'tag' : 'rule'} before scanning.`, 'warning');
    return;
  }

  showLoading(true);
  $('btn-scan').disabled = true;
  $('btn-export').disabled = true;
  setStatus(`Scanning ${selected.length} ${mode}${selected.length !== 1 ? 's' : ''}...`);

  state.lastScanConfig = {
    filterType: mode,
    selectedRuleIds: mode === 'rule' ? selected : [],
    selectedTags: mode === 'tag' ? selected : [],
  };

  safeSendMessage({
    type: MSG.SCAN_REQUEST,
    tabId: tabId(),
    ...state.lastScanConfig,
  }, (resp) => {
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
      if (!resp.results) {
        setStatus('Scan returned no results', 'warning');
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
      updateScanTargetBar('Full page');
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

function getSelectedElementSelector() {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      `(function() {
        var el = $0;
        if (!el || el === document || el === document.documentElement || el === document.body) return null;
        var parts = [];
        while (el && el !== document.body && el !== document.documentElement) {
          var tag = el.tagName.toLowerCase();
          if (el.id) { parts.unshift(tag + '#' + el.id); break; }
          var parent = el.parentElement;
          if (parent) {
            var sibs = Array.from(parent.children).filter(function(c) { return c.tagName === el.tagName; });
            if (sibs.length > 1) {
              tag += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
            }
          }
          parts.unshift(tag);
          el = parent;
        }
        return parts.join(' > ');
      })()`,
      (result, error) => {
        if (error || !result) resolve(null);
        else resolve(result);
      }
    );
  });
}

// ─────────────────────────────────────────────
// Element Picker
// ─────────────────────────────────────────────
function startPicker() {
  state.pickerActive = true;
  state.pickerSelector = null;
  state.pickerScopeSelector = null;
  state.pickerScopeReason = '';
  state.pickerScopeLabel = '';
  updatePickerUI();
  safeSendMessage({ type: MSG.PICKER_START, tabId: tabId() });
  setStatus('Picker active — click an element on the page', 'info');
}

function stopPicker() {
  state.pickerActive = false;
  updatePickerUI();
  safeSendMessage({ type: MSG.PICKER_STOP, tabId: tabId() });
  setStatus('Picker cancelled');
}

function togglePicker() {
  if (state.pickerActive) stopPicker();
  else startPicker();
}

function onPickerSelected(data) {
  state.pickerSelector      = data.selector;
  state.pickerLabel         = data.label || data.selector;
  state.pickerScopeSelector = data.scopeSelector;
  state.pickerScopeReason   = data.scopeReason || '';
  state.pickerScopeLabel    = data.scopeLabel || data.scopeSelector;
  updatePickerUI();
  setStatus(`Selected: ${data.label || data.selector}`, 'success');
}

function onPickerScopeChanged(data) {
  state.pickerScopeSelector = data.scopeSelector;
  state.pickerScopeReason   = data.scopeReason || '';
  state.pickerScopeLabel    = data.scopeLabel || data.scopeSelector;
  updatePickerUI();
}

function onPickerScan(data) {
  state.pickerActive = false;
  updatePickerUI();
  // Use the scope selector to run an element scan
  const selector = data.selector;
  if (!selector) {
    setStatus('No scope selected for scan', 'warning');
    return;
  }
  runPickerScan(selector, data.label);
}

function onPickerCancelled() {
  state.pickerActive        = false;
  state.pickerSelector      = null;
  state.pickerScopeSelector = null;
  state.pickerScopeReason   = '';
  state.pickerScopeLabel    = '';
  updatePickerUI();
  setStatus('Picker cancelled');
}

function pickerScanScope() {
  const selector = state.pickerScopeSelector;
  if (!selector) return;
  safeSendMessage({ type: MSG.PICKER_STOP, tabId: tabId() });
  state.pickerActive = false;
  updatePickerUI();
  runPickerScan(selector, state.pickerScopeLabel);
}

function pickerScanElement() {
  const selector = state.pickerSelector;
  if (!selector) return;
  safeSendMessage({ type: MSG.PICKER_STOP, tabId: tabId() });
  state.pickerActive = false;
  updatePickerUI();
  runPickerScan(selector, state.pickerLabel);
}

function pickerClearScope() {
  safeSendMessage({ type: MSG.PICKER_STOP, tabId: tabId() });
  onPickerCancelled();
}

function runPickerScan(selector, label) {
  state.elementScope = selector;
  updateScanTargetBar(label || selector, selector);

  showLoading(true);
  $('btn-export').disabled = true;
  setStatus(`Scanning scope: ${label || selector}...`);

  const defaultTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];
  safeSendMessage({
    type: MSG.SCAN_ELEMENT,
    tabId: tabId(),
    selector: selector,
    filterType: 'tag',
    selectedTags: defaultTags,
    selectedRuleIds: [],
  }, (resp) => {
    try {
      showLoading(false);

      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      if (!resp || resp.type === MSG.SCAN_ERROR) {
        setStatus('Scan error: ' + (resp?.error || 'unknown'), 'error');
        return;
      }
      if (!resp.results) {
        setStatus('Scan returned no results', 'warning');
        return;
      }

      state.previousResults  = state.rawResults;
      state.rawResults       = resp.results;
      state.formattedResults = formatResults(resp.results);
      state.selectedRuleIdx  = -1;
      state.selectedNodeIdx  = -1;
      clearHighlights();

      $('btn-export').disabled = false;
      renderAll();
      setStatus(`Scope scan complete — ${label || selector} at ${new Date(resp.results.timestamp).toLocaleTimeString()}`, 'success');
    } catch (e) {
      showLoading(false);
      if (e?.message?.includes('Extension context invalidated')) {
        setStatus('Extension reloaded — please close and reopen DevTools.');
      } else {
        throw e;
      }
    }
  });
}

function updatePickerUI() {
  const btn        = $('btn-picker');
  const scopeBar   = $('picker-scope-bar');
  const scopeSel   = $('picker-scope-selector');
  const scopeReason = $('picker-scope-reason');

  // Toggle button
  if (btn) btn.classList.toggle('picker-active', state.pickerActive);

  // Scope bar visibility
  if (state.pickerScopeSelector) {
    scopeBar.classList.remove('hidden');
    scopeSel.textContent    = state.pickerScopeLabel || state.pickerScopeSelector;
    scopeReason.textContent = state.pickerScopeReason ? '(' + state.pickerScopeReason + ')' : '';

    // Show/hide Scan Element button based on whether an element is selected
    const scanElBtn = $('btn-scope-scan-el');
    if (scanElBtn) scanElBtn.style.display = state.pickerSelector ? '' : 'none';

    // Hide Scan Scope when scope is the same as selectedEl
    const isSameAsSelected = state.pickerScopeSelector && state.pickerSelector
      && state.pickerScopeSelector === state.pickerSelector;
    const scopeScanBtn = $('btn-scope-scan');
    if (scopeScanBtn) scopeScanBtn.style.display = isSameAsSelected ? 'none' : '';
  } else {
    scopeBar.classList.add('hidden');
  }
}

// Listen for picker messages from background (relayed from content)
chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case MSG.PICKER_SELECTED:
      onPickerSelected(msg);
      break;
    case MSG.PICKER_SCOPE_CHANGED:
      onPickerScopeChanged(msg);
      break;
    case MSG.PICKER_SCAN:
      onPickerScan(msg);
      break;
    case MSG.PICKER_CANCELLED:
      onPickerCancelled();
      break;
  }
});

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

function fetchAxeRules() {
  return new Promise((resolve, reject) => {
    safeSendMessage({ type: MSG.GET_AXE_RULES, tabId: tabId() }, (resp) => {
      try {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp || resp.type === MSG.SCAN_ERROR) {
          reject(new Error(resp?.error || 'Unable to fetch rules'));
          return;
        }
        resolve({
          rules: Array.isArray(resp.rules) ? resp.rules : [],
          tags: Array.isArray(resp.tags) ? resp.tags : [],
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function filteredModalRules() {
  const query = state.rulesSearchText.toLowerCase();
  const filter = state.rulesTagFilter;
  const isGroupFilter = filter.startsWith('group:');
  const groupId = isGroupFilter ? filter.slice(6) : '';

  return state.availableRules.filter(rule => {
    if (filter) {
      if (isGroupFilter) {
        if (!rule.tags.some(t => classifyTag(t).id === groupId)) return false;
      } else {
        if (!rule.tags.includes(filter)) return false;
      }
    }
    if (!query) return true;
    return (
      rule.id.toLowerCase().includes(query)
      || rule.help.toLowerCase().includes(query)
      || rule.tags.some(tag => tag.toLowerCase().includes(query))
    );
  });
}

function filteredModalTags() {
  const query = state.rulesSearchText.toLowerCase();
  const filter = state.rulesTagFilter;
  const isGroupFilter = filter.startsWith('group:');
  const groupId = isGroupFilter ? filter.slice(6) : '';

  return state.availableTags.filter(tag => {
    if (filter) {
      if (isGroupFilter) {
        if (classifyTag(tag).id !== groupId) return false;
      } else {
        if (tag !== filter) return false;
      }
    }
    if (!query) return true;
    return tag.toLowerCase().includes(query);
  });
}

function getSelectedSet() {
  if (!state.customMode) return state.selectedTags;
  return state.scanFilterType === 'tag' ? state.selectedTags : state.selectedRuleIds;
}

function getVisibleItems() {
  return state.scanFilterType === 'tag' ? filteredModalTags() : filteredModalRules();
}

function updateRuleSelectionCount() {
  const selected = getSelectedSet().size;
  const label = (!state.customMode || state.scanFilterType === 'tag') ? 'tag' : 'rule';
  $('rules-count').textContent = `${selected} ${label}${selected !== 1 ? 's' : ''} selected`;
  $('btn-scan-run-selected').disabled = selected === 0;
}

function updateModalControlsForFilterType() {
  const titleEl = $('scan-modal-title');
  const controlsEl = $('scan-modal-controls');
  const rulesListEl = $('rules-list');
  const rulesSearchEl = $('rules-search');
  const backBtnEl = $('btn-back-to-presets');
  const customBtnEl = $('btn-enter-custom-mode');
  const panelEl = document.querySelector('.scan-modal-panel');
  if (!titleEl || !controlsEl || !rulesListEl || !rulesSearchEl) return;

  if (!state.customMode) {
    titleEl.textContent = 'Select Presets To Scan';
    controlsEl.classList.add('hidden');
    rulesListEl.classList.add('hidden');
    if (backBtnEl) backBtnEl.classList.add('hidden');
    if (customBtnEl) customBtnEl.classList.remove('hidden');
    if (panelEl) panelEl.classList.remove('custom-mode');
    return;
  }

  const byTagMode = state.scanFilterType === 'tag';
  titleEl.textContent = byTagMode ? 'Custom: Select Tags To Scan' : 'Custom: Select Rules To Scan';
  controlsEl.classList.remove('hidden');
  rulesListEl.classList.remove('hidden');
  if (backBtnEl) backBtnEl.classList.remove('hidden');
  if (customBtnEl) customBtnEl.classList.add('hidden');
  if (panelEl) panelEl.classList.add('custom-mode');
  rulesSearchEl.placeholder = byTagMode ? 'Search tags...' : 'Search rules or tags...';
}

function renderPresetOptions() {
  const presetList = $('scan-preset-list');
  if (!presetList) return;

  // Initialize default checked presets only when user has not selected any yet
  if (state.selectedPresetIds.size === 0) {
    RECOMMENDED_PRESETS.forEach(preset => {
      if (preset.checked) state.selectedPresetIds.add(preset.id);
    });
  }

  // Keep tag selection/count in sync with checked presets in preset mode
  const presetTags = getPresetDerivedTags();
  state.selectedTags.clear();
  presetTags.forEach(tag => state.selectedTags.add(tag));
  state.customExtraTags.forEach(tag => state.selectedTags.add(tag));
  updateRuleSelectionCount();

  const html = RECOMMENDED_PRESETS.map(preset => {
      const checked = state.selectedPresetIds.has(preset.id) ? 'checked' : '';
      const level = preset.usageLevel || 'medium';
      return `
        <label class="preset-option preset-usage-${escHtml(level)}">
          <input type="checkbox" data-preset-id="${escHtml(preset.id)}" ${checked}>
          <span class="preset-meta">
            <span class="preset-name">${escHtml(preset.name)}</span>
            <span class="preset-desc">${escHtml(preset.description)}</span>
          </span>
        </label>
      `;
    }).join('');

  presetList.innerHTML = html;

  presetList.querySelectorAll('input[data-preset-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.selectedPresetIds.add(cb.dataset.presetId);
      else state.selectedPresetIds.delete(cb.dataset.presetId);

      state.customMode = false;
      applySelectedPresets();
      updateModalControlsForFilterType();
    });
  });

  $('preset-help').textContent = '';
}

function getPresetDerivedTags() {
  const tags = new Set();
  RECOMMENDED_PRESETS
    .filter(p => state.selectedPresetIds.has(p.id))
    .forEach(p => p.values.forEach(v => {
      if (state.availableTags.includes(v)) tags.add(v);
    }));
  return tags;
}

function applySelectedPresets() {
  const selectedPresets = RECOMMENDED_PRESETS.filter(item => state.selectedPresetIds.has(item.id));
  const targetValues = new Set();

  selectedPresets.forEach(preset => {
    preset.values.forEach(value => {
      if (state.availableTags.includes(value)) targetValues.add(value);
    });
  });

  state.scanFilterType = 'tag';
  $('scan-filter-type').value = state.scanFilterType;
  state.selectedTags.clear();
  targetValues.forEach(value => state.selectedTags.add(value));
  state.customExtraTags.forEach(tag => state.selectedTags.add(tag));

  const names = selectedPresets.map(preset => preset.name).join(' + ');
  const extraCount = state.customExtraTags.size;
  const extraLabel = extraCount > 0 ? ` + ${extraCount} custom tag${extraCount !== 1 ? 's' : ''}` : '';
  $('preset-help').textContent = (names || 'Choose one or more presets') + extraLabel;
  updateRuleSelectionCount();
  renderRulesModal();

  if (!selectedPresets.length && !extraCount) {
    setStatus('Select at least one preset, or choose Custom.', 'warning');
    return;
  }

  if (!targetValues.size && !extraCount) {
    setStatus('Selected presets do not match tags available in this page.', 'warning');
    return;
  }

  setStatus(`Preset combo applied (${selectedPresets.length})${extraLabel}`, 'success');
}

function enterCustomMode() {
  state.customMode = true;
  const presetsEl = $('scan-modal-presets');
  const presetHelpEl = $('preset-help');
  if (presetsEl) presetsEl.classList.add('hidden');
  if (presetHelpEl) presetHelpEl.textContent = '';
  updateModalControlsForFilterType();
  updateRuleSelectionCount();
  renderRulesModal();
}

function exitCustomModeToPresets() {
  // Snapshot extra tags added manually beyond preset-derived ones
  const presetTags = getPresetDerivedTags();
  state.customExtraTags.clear();
  state.selectedTags.forEach(tag => {
    if (!presetTags.has(tag)) state.customExtraTags.add(tag);
  });

  state.customMode = false;
  const presetsEl = $('scan-modal-presets');
  if (presetsEl) presetsEl.classList.remove('hidden');
  updateModalControlsForFilterType();
  renderPresetOptions();
  applySelectedPresets();
}

function renderRulesModal() {
  const list = $('rules-list');
  const selectedSet = getSelectedSet();
  const items = getVisibleItems();

  if (!items.length) {
    list.innerHTML = `<div class="rules-empty">No ${state.scanFilterType === 'tag' ? 'tags' : 'rules'} match current filters.</div>`;
    updateRuleSelectionCount();
    return;
  }

  const html = state.scanFilterType === 'tag'
    ? (() => {
      const grouped = groupTags(items);
      let out = '';
      for (const [groupId, group] of grouped) {
        // Singleton group: render as plain item, no header
        if (group.tags.length === 1) {
          const tag = group.tags[0];
          const checked = selectedSet.has(tag) ? 'checked' : '';
          out += `
            <label class="rule-option">
              <input type="checkbox" data-tag="${escHtml(tag)}" ${checked}>
              <span class="rule-meta">
                <span class="rule-id">${escHtml(tag)}</span>
              </span>
            </label>
          `;
          continue;
        }
        const collapsed = state.collapsedTagGroups.has(groupId);
        const allSelected = group.tags.every(t => selectedSet.has(t));
        const someSelected = !allSelected && group.tags.some(t => selectedSet.has(t));
        const chevron = collapsed ? '▸' : '▾';
        out += `<div class="tag-group-header" data-group-id="${escHtml(groupId)}">`;
        out += `<span class="tag-group-toggle" data-group-id="${escHtml(groupId)}">${chevron}</span>`;
        out += `<input type="checkbox" class="tag-group-cb" data-group-id="${escHtml(groupId)}" ${allSelected ? 'checked' : ''}${someSelected ? ' data-indeterminate' : ''}>`;
        out += `<span class="tag-group-label">${escHtml(group.label)}</span>`;
        out += `<span class="tag-group-count">${group.tags.filter(t => selectedSet.has(t)).length}/${group.tags.length}</span>`;
        out += `</div>`;
        if (!collapsed) {
          out += group.tags.map(tag => {
            const checked = selectedSet.has(tag) ? 'checked' : '';
            return `
              <label class="rule-option" data-parent-group="${escHtml(groupId)}">
                <input type="checkbox" data-tag="${escHtml(tag)}" ${checked}>
                <span class="rule-meta">
                  <span class="rule-id">${escHtml(tag)}</span>
                </span>
              </label>
            `;
          }).join('');
        }
      }
      return out;
    })()
    : items.map(rule => {
      const checked = selectedSet.has(rule.id) ? 'checked' : '';
      const tags = rule.tags.join(', ');
      return `
        <label class="rule-option">
          <input type="checkbox" data-rule-id="${escHtml(rule.id)}" ${checked}>
          <span class="rule-meta">
            <span class="rule-id">${escHtml(rule.id)}</span>
            <span class="rule-help">${escHtml(rule.help || rule.description || 'No description')}</span>
            <span class="rule-tags" title="${escHtml(tags)}">${escHtml(tags)}</span>
          </span>
        </label>
      `;
    }).join('');

  list.innerHTML = html;

  // Set indeterminate state for group checkboxes
  list.querySelectorAll('.tag-group-cb[data-indeterminate]').forEach(cb => {
    cb.indeterminate = true;
  });

  // Accordion toggles
  list.querySelectorAll('.tag-group-toggle').forEach(toggle => {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const gid = toggle.dataset.groupId;
      if (state.collapsedTagGroups.has(gid)) state.collapsedTagGroups.delete(gid);
      else state.collapsedTagGroups.add(gid);
      renderRulesModal();
    });
  });

  // Group select/deselect checkboxes
  list.querySelectorAll('.tag-group-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const gid = cb.dataset.groupId;
      const grouped = groupTags(items);
      const group = grouped.get(gid);
      if (!group) return;
      group.tags.forEach(tag => {
        if (cb.checked) selectedSet.add(tag);
        else selectedSet.delete(tag);
      });
      renderRulesModal();
    });
  });

  // Click on group header label area toggles accordion
  list.querySelectorAll('.tag-group-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.classList.contains('tag-group-cb')) return;
      const gid = header.dataset.groupId;
      if (state.collapsedTagGroups.has(gid)) state.collapsedTagGroups.delete(gid);
      else state.collapsedTagGroups.add(gid);
      renderRulesModal();
    });
  });

  // Individual tag/rule checkboxes
  list.querySelectorAll('input[data-tag], input[data-rule-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.ruleId || cb.dataset.tag;
      if (!id) return;
      if (cb.checked) selectedSet.add(id);
      else selectedSet.delete(id);
      updateRuleSelectionCount();
      // Update parent group header state without full re-render
      const label = cb.closest('[data-parent-group]');
      if (label) {
        const gid = label.dataset.parentGroup;
        const headerCb = list.querySelector(`.tag-group-cb[data-group-id="${gid}"]`);
        const countEl = list.querySelector(`.tag-group-header[data-group-id="${gid}"] .tag-group-count`);
        if (headerCb) {
          const grouped = groupTags(items);
          const group = grouped.get(gid);
          if (group) {
            const allSel = group.tags.every(t => selectedSet.has(t));
            const someSel = group.tags.some(t => selectedSet.has(t));
            headerCb.checked = allSel;
            headerCb.indeterminate = !allSel && someSel;
            if (countEl) countEl.textContent = `${group.tags.filter(t => selectedSet.has(t)).length}/${group.tags.length}`;
          }
        }
      }
    });
  });

  updateRuleSelectionCount();
}

function setAllVisibleRules(selected) {
  const selectedSet = getSelectedSet();
  const items = getVisibleItems();
  items.forEach(item => {
    const value = state.scanFilterType === 'tag' ? item : item.id;
    if (selected) selectedSet.add(value);
    else selectedSet.delete(value);
  });
  renderRulesModal();
}

function openScanModal() {
  const presetsEl = $('scan-modal-presets');
  const scanModalEl = $('scan-modal');
  if (!scanModalEl) return;

  if (!state.customMode && presetsEl) {
    presetsEl.classList.remove('hidden');
  }
  scanModalEl.classList.remove('hidden');
  updateModalControlsForFilterType();
  renderPresetOptions();
  renderRulesModal();
}

function closeScanModal() {
  const scanModalEl = $('scan-modal');
  if (scanModalEl) scanModalEl.classList.add('hidden');
}

function openScanModalFlow() {
  if (state.availableRules.length > 0) {
    openScanModal();
    return;
  }

  $('btn-scan').disabled = true;
  setStatus('Loading axe rules...');
  fetchAxeRules()
    .then(({ rules, tags }) => {
      state.availableRules = rules.sort((a, b) => a.id.localeCompare(b.id));
      state.availableTags = tags;
      state.customMode = false;
      state.selectedPresetIds.clear();
      state.scanFilterType = 'rule';
      state.selectedRuleIds = new Set(state.availableRules.map(rule => rule.id));
      state.selectedTags = new Set();
      state.customExtraTags = new Set();

      const tagFilter = $('rules-tag-filter');
      const grouped = groupTags(state.availableTags);
      let tagFilterHtml = '<option value="">All tags</option>';
      for (const [groupId, group] of grouped) {
        if (group.tags.length === 1) {
          tagFilterHtml += `<option value="${escHtml(group.tags[0])}">${escHtml(group.tags[0])}</option>`;
          continue;
        }
        tagFilterHtml += `<optgroup label="${escHtml(group.label)}">`;
        tagFilterHtml += `<option value="group:${escHtml(groupId)}">★ All ${escHtml(group.label)}</option>`;
        tagFilterHtml += group.tags.map(tag => `<option value="${escHtml(tag)}">${escHtml(tag)}</option>`).join('');
        tagFilterHtml += '</optgroup>';
      }
      tagFilter.innerHTML = tagFilterHtml;
      tagFilter.value = '';
      state.rulesSearchText = '';
      state.rulesTagFilter = '';
      $('rules-search').value = '';
      $('scan-filter-type').value = state.scanFilterType;
      updateModalControlsForFilterType();
      renderPresetOptions();

      setStatus(`Loaded ${state.availableRules.length} axe rules`, 'success');
      openScanModal();
    })
    .catch(err => {
      setStatus('Error loading rules: ' + err.message, 'error');
    })
    .finally(() => {
      $('btn-scan').disabled = false;
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
  clearHighlights();
  safeSendMessage({
    type: MSG.HIGHLIGHT_ELEMENT,
    tabId: tabId(), selector, impact, description, help,
  });
  state.highlightedSelectors.add(selector);
}

function inspectInDomTree(selector) {
  const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  chrome.devtools.inspectedWindow.eval(
    `inspect(document.querySelector('${escaped}'))`
  );
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
        `;
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
  }

  renderIssueList();
  renderDetail();
}

// ─────────────────────────────────────────────
// AI Suggest Fix (Chrome Built-in AI / Prompt API)
// ─────────────────────────────────────────────
function buildFixPrompt(rule, node, domContext) {
  const messages = [];
  for (const group of (node.checks || [])) {
    for (const c of group.checks) {
      messages.push(`[${group.type}] ${c.message}`);
    }
  }

  return `You are an accessibility expert. Fix the issue with minimal output.

Rule: ${rule.id} — ${rule.description}
HTML: ${node.html || 'N/A'}
Selector: ${node.selector || 'N/A'}
Issues:
${messages.join('; ')}

Output:
- 1 short explanation (max 15 words)
- 1 fix (code or steps)

Rules:
- Be direct, no extra text
- Prefer code fix if possible
- Use valid HTML`
}

function suggestAIFix(rule, node, containerEl) {
  const outputEl = containerEl.querySelector('.ai-fix-output');
  const btnEl = containerEl.querySelector('.ai-fix-btn');

  // If already has content, toggle visibility
  if (outputEl.dataset.loaded === 'true') {
    outputEl.classList.toggle('hidden');
    return;
  }

  btnEl.disabled = true;
  btnEl.textContent = '⏳ Generating…';
  outputEl.classList.remove('hidden');
  outputEl.textContent = 'Waiting for AI model…';
  _startAIFix(rule, node, containerEl, outputEl, btnEl);
}

function _startAIFix(rule, node, containerEl, outputEl, btnEl, domContext) {
  const prompt = buildFixPrompt(rule, node);
  const systemPrompt = 'You are a concise web accessibility remediation assistant. Respond only with the fix. Use markdown.';

  const port = chrome.runtime.connect({ name: 'ai-fix' });

  let logHtml = '';

  port.onMessage.addListener((msg) => {
    if (msg.type === 'downloading') {
      const pct = msg.total > 0 ? Math.round((msg.loaded / msg.total) * 100) : 0;
      outputEl.innerHTML = `<div class="ai-download-progress">
        <span>Downloading AI model… ${pct}%</span>
        <div class="ai-progress-bar"><div class="ai-progress-fill" style="width:${pct}%"></div></div>
      </div>`;
      btnEl.textContent = '⏳ Downloading…';
    } else if (msg.type === 'status') {
      outputEl.innerHTML = logHtml + `<div class="ai-fix-status"><span class="ai-status-spinner"></span> ${escHtml(msg.message)}</div>`;
      btnEl.textContent = '⏳ Working…';
    } else if (msg.type === 'chunk') {
      outputEl.innerHTML = logHtml + `<div class="ai-fix-preview">${formatAIResponse(msg.text)}</div>`;
      btnEl.textContent = '⏳ Generating…';
    } else if (msg.type === 'result') {
      const disclaimer = '<div class="ai-fix-disclaimer">⚠ This is only a suggestion/example. Links are for reference only. The solution may not be correct for your context. Always review and test before applying.</div>';
      outputEl.innerHTML = logHtml + disclaimer + formatAIResponse(msg.text);
    } else if (msg.type === 'done') {
      outputEl.dataset.loaded = 'true';
      btnEl.textContent = '🤖 Suggest Fix';
      btnEl.disabled = false;
      try { port.disconnect(); } catch (_) {}
    } else if (msg.type === 'error') {
      if (msg.error === 'not-available') {
        outputEl.innerHTML = `<div class="ai-fix-error">
          <strong>Chrome Built-in AI not available.</strong><br>
          <span>Enable <code>chrome://flags/#prompt-api-for-gemini-nano</code> and <code>chrome://flags/#optimization-guide-on-device-model</code>, then restart Chrome.</span>
        </div>`;
      } else {
        outputEl.innerHTML = `<div class="ai-fix-error">Error: ${escHtml(msg.error)}</div>`;
      }
      btnEl.textContent = '🤖 Suggest Fix';
      btnEl.disabled = false;
      try { port.disconnect(); } catch (_) {}
    }
  });

  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      outputEl.innerHTML = `<div class="ai-fix-error">Error: ${escHtml(chrome.runtime.lastError.message)}</div>`;
      btnEl.textContent = '🤖 Suggest Fix';
      btnEl.disabled = false;
    }
  });

  port.postMessage({ prompt, systemPrompt });
}

function formatAIResponse(text) {
  // Minimal markdown → HTML: code blocks, inline code, bold, line breaks
  let html = escHtml(text);
  // Code blocks: ```lang\n...\n```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre class="ai-code-block"><button class="ai-copy-btn" title="Copy code">📋</button><code>${code.trim()}</code></pre>`
  );
  // Markdown links: [text](url) → <a href="url" target="_blank">text</a>
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Line breaks (outside pre)
  html = html.replace(/\n/g, '<br>');
  // Fix <br> inside <pre>
  html = html.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/g, (_, attrs, inner) =>
    `<pre${attrs}>${inner.replace(/<br>/g, '\n')}</pre>`
  );
  return html;
}

// ─────────────────────────────────────────────
// Render checks detail (any/all/none with data & relatedNodes)
// ─────────────────────────────────────────────
function renderChecksSection(node) {
  if (!node.checks || !node.checks.length) return '';

  return node.checks.map(group => {
    const checksHtml = group.checks.map(check => {
      const impactTag = check.impact
        ? `<span class="check-impact ${check.impact}">${check.impact}</span>`
        : '';

      const dataHtml = check.data ? renderCheckData(check.data) : '';

      const relHtml = check.relatedNodes.length
        ? `<div class="check-related">
            <span class="check-related-label">Related elements:</span>
            ${check.relatedNodes.map(rn => `
              <div class="check-related-node">
                <code class="check-related-sel" data-hl-sel="${escHtml(rn.target)}" title="Click to highlight">${escHtml(rn.target)}</code>
                <span style="flex:1"></span>
                <button class="nd-inspect-btn" data-action="inspect" data-sel="${escHtml(rn.target)}" title="Inspect in DOM">➡ DOM</button>
                ${rn.html ? `<div class="check-related-html" data-hl-sel="${escHtml(rn.target)}" title="Click to highlight">${escHtml(rn.html)}</div>` : ''}
              </div>
            `).join('')}
          </div>`
        : '';

      return `
        <div class="check-item">
          <div class="check-msg">
            ${impactTag}
            <code class="check-id">${escHtml(check.id)}</code>
            <span>${escHtml(check.message)}</span>
          </div>
          ${dataHtml}
          ${relHtml}
        </div>`;
    }).join('');

    const groupColor = group.type === 'any' ? 'var(--c-warn)' : group.type === 'all' ? 'var(--c-critical)' : 'var(--c-pass)';

    return `
      <div class="checks-group">
        <div class="checks-group-label" style="border-left-color:${groupColor}">${escHtml(group.label)}</div>
        ${checksHtml}
      </div>`;
  }).join('');
}

function renderCheckData(data) {
  if (typeof data === 'string') {
    return `<div class="check-data"><span class="check-data-label">Data:</span> ${escHtml(data)}</div>`;
  }
  if (typeof data !== 'object' || data === null) return '';

  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '';

  const rows = entries.map(([key, val]) => {
    const display = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return `<div class="check-data-row"><span class="check-data-key">${escHtml(key)}:</span> <span class="check-data-val">${escHtml(display)}</span></div>`;
  }).join('');

  return `<div class="check-data">${rows}</div>`;
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
          <button class="nd-hl-btn" data-hl-sel="${escHtml(node.primarySelector)}" title="Click to highlight">${escHtml(node.primarySelector || node.selector)}</button>
          <span style="flex:1"></span>
          <button class="nd-nav" data-action="inspect" data-sel="${escHtml(node.primarySelector)}" style="display:inline;padding:1px 5px;font-size:9px;border:1px solid var(--c-border);border-radius:2px;background:var(--c-surface);color:var(--c-text);cursor:pointer">➡ DOM</button>
        </div>
        ${node.html ? `<div class="nd-html" data-hl-sel="${escHtml(node.primarySelector)}" title="Click to highlight">${escHtml(node.html)}</div>` : ''}
        ${node.failureSummary ? `<div class="nd-failure">${escHtml(node.failureSummary)}</div>` : ''}
        ${isActive ? renderChecksSection(node) : ''}
        ${isActive ? `<div class="ai-fix-section" data-node-idx="${i}">
          <button class="ai-fix-btn">🤖 Suggest Fix</button>
          <div class="ai-fix-output hidden"></div>
        </div>` : ''}
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
      if (e.target.closest('.ai-fix-section')) return;
      const i = parseInt(el.dataset.nodeIdx);
      selectNode(state.selectedRuleIdx, i);
    });
  });

  // Highlight on nd-hl-btn, nd-html, and relatedNodes click
  content.querySelectorAll('[data-hl-sel]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      e.stopPropagation();
      const sel = el.dataset.hlSel;
      if (sel) highlightSelector(sel, rule.impact, rule.description, rule.help);
    });
  });

  // Inspect in DOM tree buttons
  content.querySelectorAll('[data-action="inspect"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      inspectInDomTree(btn.dataset.sel);
    });
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

  // AI Suggest Fix buttons
  content.querySelectorAll('.ai-fix-section').forEach(section => {
    const nIdx = parseInt(section.dataset.nodeIdx);
    const node = rule.nodes[nIdx];
    if (!node) return;
    section.querySelector('.ai-fix-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      suggestAIFix(rule, node, section);
    });
    // Copy code buttons (delegated since content is dynamic)
    section.querySelector('.ai-fix-output').addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.ai-copy-btn');
      if (!copyBtn) return;
      e.stopPropagation();
      const code = copyBtn.closest('.ai-code-block')?.querySelector('code')?.textContent || '';
      navigator.clipboard.writeText(code).then(() => {
        copyBtn.textContent = '✅';
        setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
      });
    });
  });
}

// ─────────────────────────────────────────────
// Render all
// ─────────────────────────────────────────────
function renderAll() {
  renderTopBar();
  renderIssueList();
  renderDetail();
}

function updateScanTargetBar(label, selector) {
  const bar = $('scan-target-bar');
  const sel = $('scan-target-selector');
  if (!bar || !sel) return;
  state.lastScanTarget = label || null;
  state.lastScanTargetSelector = selector || null;
  if (label) {
    bar.classList.remove('hidden');
    sel.textContent = label;
    if (selector) {
      sel.dataset.hlSel = selector;
      sel.title = 'Click to highlight';
      sel.style.cursor = 'pointer';
      sel.onclick = () => highlightSelector(selector, null, null, null);
    } else {
      delete sel.dataset.hlSel;
      sel.title = '';
      sel.style.cursor = '';
      sel.onclick = null;
    }
  } else {
    bar.classList.add('hidden');
    sel.textContent = '';
    sel.onclick = null;
  }
}

function clearScanTarget() {
  state.elementScope = null;
  state.lastScanTarget = null;
  updateScanTargetBar(null);
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

$('btn-scan').addEventListener('click', openScanModalFlow);
$('btn-export').addEventListener('click', exportJSON);

// Picker
$('btn-picker').addEventListener('click', togglePicker);
$('btn-scope-scan').addEventListener('click', pickerScanScope);
$('btn-scope-scan-el').addEventListener('click', pickerScanElement);
$('btn-scope-clear').addEventListener('click', pickerClearScope);
$('btn-clear-target').addEventListener('click', clearScanTarget);

$('btn-scan-modal-close').addEventListener('click', closeScanModal);
$('btn-scan-cancel').addEventListener('click', closeScanModal);
$('btn-enter-custom-mode').addEventListener('click', enterCustomMode);
$('btn-back-to-presets').addEventListener('click', exitCustomModeToPresets);
$('btn-scan-run-selected').addEventListener('click', () => {
  const selected = Array.from(getSelectedSet());
  const mode = state.customMode ? state.scanFilterType : 'tag';
  closeScanModal();
  runScan(mode, selected);
});

$('scan-filter-type').addEventListener('change', e => {
  if (!state.customMode) return;
  state.scanFilterType = e.target.value === 'tag' ? 'tag' : 'rule';
  updateModalControlsForFilterType();
  renderRulesModal();
});

$('rules-search').addEventListener('input', e => {
  state.rulesSearchText = e.target.value.trim();
  renderRulesModal();
});

$('rules-tag-filter').addEventListener('change', e => {
  state.rulesTagFilter = e.target.value;
  renderRulesModal();
});

$('btn-rules-select-all').addEventListener('click', () => setAllVisibleRules(true));
$('btn-rules-clear-all').addEventListener('click', () => setAllVisibleRules(false));

$('scan-modal').addEventListener('click', (e) => {
  if (e.target.id === 'scan-modal') closeScanModal();
});

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
  const scanModalEl = $('scan-modal');
  if (scanModalEl && !scanModalEl.classList.contains('hidden') && e.key === 'Escape') {
    e.preventDefault();
    closeScanModal();
    return;
  }

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
// Cleanup on DevTools close
// ─────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  clearHighlights();
  if (state.pickerActive) {
    safeSendMessage({ type: MSG.PICKER_STOP, tabId: tabId() });
  }
});

// ─────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────
loadCachedResults();
