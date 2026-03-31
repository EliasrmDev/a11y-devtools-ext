/**
 * Element Picker — real-time hover highlight, click-to-select, smart scope detection.
 * Injected on demand via chrome.scripting.executeScript.
 * Single overlay root, RAF-driven, zero layout thrashing.
 */

if (!window.__a11yPickerLoaded) {
window.__a11yPickerLoaded = true;

(function () {
  'use strict';

  // ─────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────
  const ROOT_ID     = '__a11y-picker-root';
  const NS          = '__a11y-picker';
  const Z_BASE      = 2147483640;

  const COLORS = {
    hover:    { border: '#1a73e8', bg: 'rgba(26,115,232,0.08)',  label: '#1a73e8' },
    selected: { border: '#0d652d', bg: 'rgba(13,101,45,0.10)',   label: '#0d652d' },
    scope:    { border: '#e8710a', bg: 'rgba(232,113,10,0.07)',  label: '#e8710a' },
  };

  // ─────────────────────────────────────────
  // State
  // ─────────────────────────────────────────
  let active       = false;
  let hoverEl      = null;
  let selectedEl   = null;
  let scopeEl      = null;
  let scopeReason  = '';
  let rafId        = null;
  let lastHoverRect = null;

  // ─────────────────────────────────────────
  // Shadow-DOM overlay root (isolation)
  // ─────────────────────────────────────────
  let root, shadow;

  function ensureRoot() {
    if (document.getElementById(ROOT_ID)) {
      root   = document.getElementById(ROOT_ID);
      shadow = root.shadowRoot;
      return;
    }
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:' + Z_BASE + ';pointer-events:none;';
    shadow = root.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .box {
        position: fixed;
        pointer-events: none;
        box-sizing: border-box;
        border-radius: 2px;
        transition: opacity 0.1s ease;
        will-change: transform, width, height;
      }
      .box[data-role="scope"]    { z-index: 1; }
      .box[data-role="selected"] { z-index: 2; }
      .box[data-role="hover"]    { z-index: 3; }
      .label {
        position: fixed;
        pointer-events: none;
        font: 600 11px/1.35 'SF Mono','Menlo','Consolas','Roboto Mono',monospace;
        padding: 3px 7px;
        border-radius: 3px;
        white-space: nowrap;
        max-width: 460px;
        overflow: hidden;
        text-overflow: ellipsis;
        box-shadow: 0 2px 8px rgba(0,0,0,0.35);
        will-change: transform;
      }
      .label[data-label-for="scope"]    { z-index: 4; }
      .label[data-label-for="selected"] { z-index: 5; }
      .label[data-label-for="hover"]    { z-index: 6; }
      .scope-controls {
        position: fixed;
        pointer-events: auto;
        display: flex;
        gap: 4px;
        z-index: 10;
      }
      .scope-btn {
        font: 600 10px/1 'SF Mono','Menlo','Consolas',monospace;
        padding: 4px 8px;
        border-radius: 3px;
        border: 1px solid rgba(255,255,255,0.15);
        cursor: pointer;
        transition: background 0.1s;
        color: #fff;
      }
      .scope-btn:hover { filter: brightness(1.15); }
      .scope-btn.scan    { background: #e8710a; }
      .scope-btn.scan-el { background: #0d652d; }
      .scope-btn.cancel  { background: #555; }
    `;
    shadow.appendChild(style);

    // Boxes: hover, selected, scope
    for (const key of ['hover', 'selected', 'scope']) {
      const box = document.createElement('div');
      box.className = 'box';
      box.dataset.role = key;
      box.style.display = 'none';
      shadow.appendChild(box);

      const lbl = document.createElement('div');
      lbl.className = 'label';
      lbl.dataset.labelFor = key;
      lbl.style.display = 'none';
      shadow.appendChild(lbl);
    }

    // Scope controls container
    const controls = document.createElement('div');
    controls.className = 'scope-controls';
    controls.dataset.role = 'scope-controls';
    controls.style.display = 'none';
    controls.innerHTML = `
      <button class="scope-btn scan"    data-action="scan-scope" title="Scan the current scope">⚡ Scan Scope</button>
      <button class="scope-btn scan-el" data-action="scan-element" title="Scan the selected element">⚡ Scan Element</button>
      <button class="scope-btn cancel"  data-action="cancel"  title="Cancel picker">✕ Cancel</button>
    `;
    controls.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      if (!action) return;
      e.stopPropagation();
      e.preventDefault();
      handleScopeAction(action);
    });
    shadow.appendChild(controls);

    document.documentElement.appendChild(root);
  }

  // ─────────────────────────────────────────
  // DOM helpers
  // ─────────────────────────────────────────
  function getBox(role)   { return shadow.querySelector(`.box[data-role="${role}"]`); }
  function getLabel(role) { return shadow.querySelector(`.label[data-label-for="${role}"]`); }
  function getControls()  { return shadow.querySelector('[data-role="scope-controls"]'); }

  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ─────────────────────────────────────────
  // Selector generation
  // ─────────────────────────────────────────
  function buildSelector(el) {
    if (!el || el === document || el === document.documentElement || el === document.body) return null;

    // Prefer id
    if (el.id) return '#' + CSS.escape(el.id);

    // Prefer data-testid
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

    // Build path
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      let tag = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) {
          tag += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(tag);
      cur = parent;
    }
    return parts.join(' > ') || null;
  }

  // ─────────────────────────────────────────
  // Element label
  // ─────────────────────────────────────────
  function elementLabel(el) {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    const id  = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : '';
    const role = el.getAttribute('role');
    const roleStr = role ? `  role="${role}"` : '';
    return `<${escHtml(tag + id + cls)}>${roleStr}`;
  }

  // ─────────────────────────────────────────
  // Scope detection heuristics
  // ─────────────────────────────────────────
  function detectScope(el) {
    if (!el) return { root: el, reason: 'fallback' };

    const checks = [
      { attr: '[data-testid]',     reason: 'data-testid' },
      { attr: '[data-component]',  reason: 'data-component' },
      { attr: '[role]',            reason: 'role' },
      { sel: 'section, article, main, form, nav, aside, header, footer, dialog', reason: 'semantic' },
    ];

    for (const c of checks) {
      const found = c.attr ? el.closest(c.attr) : el.closest(c.sel);
      if (found && found !== document.body && found !== document.documentElement) {
        return { root: found, reason: c.reason };
      }
    }
    return { root: el, reason: 'fallback' };
  }

  // ─────────────────────────────────────────
  // Position overlay + label
  // ─────────────────────────────────────────
  // labelSlot: vertical offset multiplier (0, 1, 2) to stack labels without overlap
  function positionBox(box, label, el, colors, labelSlot) {
    if (!el || !el.isConnected) {
      box.style.display = 'none';
      label.style.display = 'none';
      return;
    }

    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      box.style.display = 'none';
      label.style.display = 'none';
      return;
    }

    box.style.display   = 'block';
    box.style.left      = r.left + 'px';
    box.style.top       = r.top + 'px';
    box.style.width     = Math.max(r.width, 2) + 'px';
    box.style.height    = Math.max(r.height, 2) + 'px';
    box.style.border    = '2px solid ' + colors.border;
    box.style.background = colors.bg;

    // Label — stack using slot offset so labels don't overlap
    label.style.display    = 'block';
    label.style.background = colors.label;
    label.style.color      = '#fff';

    const slot    = labelSlot || 0;
    const labelH  = 22;
    const gap     = 4;
    const slotOff = slot * (labelH + 2);  // extra offset per slot
    const above   = r.top - labelH - gap - slotOff;
    if (above >= 0) {
      label.style.top = above + 'px';
    } else {
      label.style.top = (r.bottom + gap + slotOff) + 'px';
    }
    label.style.left = Math.max(0, Math.min(r.left, window.innerWidth - 460)) + 'px';
  }

  function positionControls(el) {
    const ctrl = getControls();
    if (!el || !el.isConnected) { ctrl.style.display = 'none'; return; }

    const r = el.getBoundingClientRect();
    ctrl.style.display = 'flex';

    // Show/hide context-dependent buttons
    const scanScopeBtn  = ctrl.querySelector('[data-action="scan-scope"]');
    if (scanScopeBtn)  scanScopeBtn.style.display  = selectedEl !== scopeEl ? '' : 'none';

    // Measure controls width to center horizontally
    const ctrlW = ctrl.offsetWidth || 200;
    const ctrlH = ctrl.offsetHeight || 28;
    const gap = 6;
    const below = r.bottom + gap;
    const above = r.top - ctrlH - gap;

    // Vertical: prefer below the element, fall back to above
    ctrl.style.top = (below + ctrlH < window.innerHeight ? below : Math.max(0, above)) + 'px';

    // Horizontal: center on the element
    const centerX = r.left + r.width / 2 - ctrlW / 2;
    ctrl.style.left = Math.max(0, Math.min(centerX, window.innerWidth - ctrlW)) + 'px';
  }

  // ─────────────────────────────────────────
  // Render loop (RAF)
  // ─────────────────────────────────────────
  function renderFrame() {
    if (!active) return;

    // Determine which layers are visible to calculate label slots
    const hasScope    = scopeEl && scopeEl !== selectedEl;
    const hasSelected = !!selectedEl;
    const hasHover    = hoverEl && hoverEl !== selectedEl;

    // Scope (bottom layer — label to the right of the box)
    const scBox = getBox('scope');
    const scLbl = getLabel('scope');
    if (hasScope) {
      positionBox(scBox, scLbl, scopeEl, COLORS.scope, 0);
      scLbl.textContent = '⚡ Scope: ' + elementLabel(scopeEl) + (scopeReason ? '  (' + scopeReason + ')' : '');
      // Reposition scope label to the right of the element
      const sr  = scopeEl.getBoundingClientRect();
      const gap = 6;
      const lblW = scLbl.getBoundingClientRect().width + 20; // add some padding to prevent touching the box border
      scLbl.style.left = Math.min(sr.right + gap, window.innerWidth - lblW) + 'px';
      positionControls(scopeEl);
    } else if (scopeEl && scopeEl === selectedEl) {
      scBox.style.display  = 'none';
      scLbl.style.display  = 'none';
      positionControls(selectedEl);
    } else {
      scBox.style.display  = 'none';
      scLbl.style.display  = 'none';
      getControls().style.display = 'none';
    }

    // Selected (middle layer)
    const sBox  = getBox('selected');
    const sLbl  = getLabel('selected');
    const selSlot = hasScope ? -1 : 0;
    if (hasSelected) {
      positionBox(sBox, sLbl, selectedEl, COLORS.selected, selSlot);
      sLbl.textContent = elementLabel(selectedEl);
    } else {
      sBox.style.display  = 'none';
      sLbl.style.display = 'none';
    }

    // Hover (top layer — always visible above others)
    const hBox  = getBox('hover');
    const hLbl  = getLabel('hover');
    const hoverSlot = (hasScope ? -1 : 0) + (hasSelected ? 1 : 0);
    if (hasHover) {
      positionBox(hBox, hLbl, hoverEl, COLORS.hover, hoverSlot);
      hLbl.textContent = elementLabel(hoverEl);
    } else {
      hBox.style.display  = 'none';
      hLbl.style.display = 'none';
    }

    rafId = requestAnimationFrame(renderFrame);
  }

  // ─────────────────────────────────────────
  // Event handlers
  // ─────────────────────────────────────────
  function isOwnUI(el) {
    return el && (el === root || root.contains(el));
  }

  function onMouseMove(e) {
    if (!active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOwnUI(el) || el === document.documentElement || el === document.body) {
      hoverEl = null;
      return;
    }
    if (el !== hoverEl) {
      hoverEl = el;
    }
  }

  function onClick(e) {
    if (!active) return;
    if (isOwnUI(e.target)) return; // let scope buttons work

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === document.documentElement || el === document.body) return;

    selectedEl = el;
    hoverEl    = null;

    // Detect scope
    const scope = detectScope(selectedEl);
    scopeEl     = scope.root;
    scopeReason = scope.reason;

    notifyPanel('PICKER_SELECTED', {
      selector:      buildSelector(selectedEl),
      scopeSelector: buildSelector(scopeEl),
      scopeReason:   scope.reason,
      label:         elementLabel(selectedEl),
      scopeLabel:    elementLabel(scopeEl),
    });
  }

  function onKeyDown(e) {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      deactivate();
      notifyPanel('PICKER_CANCELLED');
    }
  }

  // ─────────────────────────────────────────
  // Scope actions
  // ─────────────────────────────────────────
  function handleScopeAction(action) {
    if (action === 'scan-scope') {
      const target = scopeEl || selectedEl;
      const selector = buildSelector(target);
      deactivate();
      notifyPanel('PICKER_SCAN', {
        selector: selector,
        label:    elementLabel(target),
      });
    } else if (action === 'scan-element' && selectedEl) {
      const selector = buildSelector(selectedEl);
      deactivate();
      notifyPanel('PICKER_SCAN', {
        selector: selector,
        label:    elementLabel(selectedEl),
      });
    } else if (action === 'cancel') {
      deactivate();
      notifyPanel('PICKER_CANCELLED');
    }
  }

  // ─────────────────────────────────────────
  // Communicate with panel via background
  // ─────────────────────────────────────────
  function notifyPanel(type, data) {
    try {
      chrome.runtime.sendMessage({ type, ...data });
    } catch (_) { /* extension context may be gone */ }
  }

  // ─────────────────────────────────────────
  // Activate / deactivate
  // ─────────────────────────────────────────
  function activate() {
    if (active) return;
    ensureRoot();
    active = true;
    hoverEl = selectedEl = scopeEl = null;
    scopeReason = '';
    document.body.style.cursor = 'crosshair';

    document.addEventListener('mousemove', onMouseMove, { passive: true, capture: true });
    document.addEventListener('click',     onClick,     { capture: true });
    document.addEventListener('keydown',   onKeyDown,   { capture: true });

    rafId = requestAnimationFrame(renderFrame);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    document.body.style.cursor = '';

    document.removeEventListener('mousemove', onMouseMove, { capture: true });
    document.removeEventListener('click',     onClick,     { capture: true });
    document.removeEventListener('keydown',   onKeyDown,   { capture: true });

    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

    // Hide all overlays
    for (const role of ['hover', 'selected', 'scope']) {
      const box = getBox(role);
      const lbl = getLabel(role);
      if (box) box.style.display = 'none';
      if (lbl) lbl.style.display = 'none';
    }
    getControls().style.display = 'none';

    hoverEl = selectedEl = scopeEl = null;
  }

  // ─────────────────────────────────────────
  // Message listener
  // ─────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'PICKER_START':
        activate();
        break;
      case 'PICKER_STOP':
        deactivate();
        break;

    }
  });

})();
} // end __a11yPickerLoaded guard
