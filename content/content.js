/**
 * Content script: DOM highlighting & scroll.
 * Runs in the page's isolated world but shares the DOM.
 */

if (window.__a11yExtContentLoaded) { /* already injected */ } else {
window.__a11yExtContentLoaded = true;

const OVERLAY_CLASS   = 'a11y-ext-overlay';
const TOOLTIP_CLASS   = 'a11y-ext-tooltip';
const ACTIVE_CLASS    = 'a11y-ext-active';

const IMPACT_COLORS = {
  critical: { border: '#d93025', bg: 'rgba(217,48,37,0.12)' },
  serious:  { border: '#f57c00', bg: 'rgba(245,124,0,0.12)'  },
  moderate: { border: '#f9a825', bg: 'rgba(249,168,37,0.12)' },
  minor:    { border: '#1a73e8', bg: 'rgba(26,115,232,0.12)' },
};

// Inject overlay stylesheet once
(function injectStyles() {
  if (document.getElementById('a11y-ext-styles')) return;
  const style = document.createElement('style');
  style.id = 'a11y-ext-styles';
  style.textContent = `
    .${OVERLAY_CLASS} {
      position: absolute;
      pointer-events: none;
      z-index: 2147483640;
      box-sizing: border-box;
      border-radius: 2px;
      transition: opacity 0.15s;
    }
    .${OVERLAY_CLASS}.${ACTIVE_CLASS} {
      z-index: 2147483647;
      box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--a11y-border);
    }
    .${TOOLTIP_CLASS} {
      position: absolute;
      z-index: 2147483648;
      background: #202124;
      color: #e8eaed;
      font: 11px/1.4 'Roboto Mono', monospace;
      padding: 6px 8px;
      border-radius: 4px;
      max-width: 320px;
      word-break: break-word;
      pointer-events: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      white-space: pre-wrap;
    }
    .a11y-ext-impact-badge {
      display: inline-block;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 1px 4px;
      border-radius: 2px;
      margin-bottom: 3px;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
})();

const overlays = new Map(); // selector → {overlay, tooltip}

function getRect(el) {
  const r = el.getBoundingClientRect();
  return {
    top:    r.top    + window.scrollY,
    left:   r.left   + window.scrollX,
    width:  r.width,
    height: r.height,
  };
}

function createOverlay(selector, impact, description, help) {
  let target;
  try { target = document.querySelector(selector); } catch (_) { return; }
  if (!target) return;

  const colors = IMPACT_COLORS[impact] || IMPACT_COLORS.minor;
  const rect   = getRect(target);

  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.style.cssText = `
    top: ${rect.top}px;
    left: ${rect.left}px;
    width: ${Math.max(rect.width, 4)}px;
    height: ${Math.max(rect.height, 4)}px;
    border: 2px solid ${colors.border};
    background: ${colors.bg};
    --a11y-border: ${colors.border};
  `;
  overlay.dataset.selector = selector;

  const tooltip = document.createElement('div');
  tooltip.className = TOOLTIP_CLASS;
  tooltip.style.display = 'none';

  const impactColor = {
    critical: '#ea4335', serious: '#fa7b17', moderate: '#fbbc04', minor: '#4285f4'
  }[impact] || '#aaa';

  tooltip.innerHTML =
    `<span class="a11y-ext-impact-badge" style="background:${impactColor};color:#fff">${impact || 'unknown'}</span>\n` +
    `<strong>${escHtml(description || '')}</strong>\n${escHtml(help || '')}`;

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(tooltip);
  overlays.set(selector, { overlay, tooltip, target });

  // Position tooltip on hover
  overlay.addEventListener('mouseenter', () => positionTooltip(overlay, tooltip, rect));
  overlay.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

function positionTooltip(overlay, tooltip, rect) {
  tooltip.style.display = 'block';
  const tipH = tooltip.offsetHeight;
  const tipW = tooltip.offsetWidth;
  const top  = rect.top - tipH - 6;
  tooltip.style.top  = `${top < window.scrollY ? rect.top + rect.height + 4 : top}px`;
  tooltip.style.left = `${Math.min(rect.left, window.innerWidth + window.scrollX - tipW - 8)}px`;
}

function unhighlightAll() {
  for (const { overlay, tooltip } of overlays.values()) {
    overlay.remove();
    tooltip.remove();
  }
  overlays.clear();
}

function activateOverlay(selector) {
  for (const [sel, { overlay }] of overlays) {
    overlay.classList.toggle(ACTIVE_CLASS, sel === selector);
  }
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Message listener (MSG constants inlined to avoid importScripts complexity)
chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'HIGHLIGHT_ELEMENT':
      createOverlay(msg.selector, msg.impact, msg.description, msg.help);
      activateOverlay(msg.selector);
      try {
        const el = document.querySelector(msg.selector);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (_) {}
      break;

    case 'UNHIGHLIGHT_ALL':
      unhighlightAll();
      break;

    case 'SCROLL_TO_ELEMENT':
      activateOverlay(msg.selector);
      try {
        const el = document.querySelector(msg.selector);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (_) {}
      break;
  }
});

} // end __a11yExtContentLoaded guard
