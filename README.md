# a11y DevTools

Advanced Chrome extension for web accessibility testing, powered by [axe-core](https://github.com/dequelabs/axe-core).

> **Disclaimer:** This is an independent open-source project. It is not affiliated with, endorsed by, or associated with Deque Systems or any of their products.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![axe-core](https://img.shields.io/badge/axe--core-4.11.3-green)
![License](https://img.shields.io/badge/license-MIT-gray)

---

## Features

- **Accessibility scan** — runs axe-core against WCAG 2.1/2.2 AA + best-practice rules
- **Score 0–100** with letter grade (A–F) and per-impact breakdown
- **DOM highlighting** — colored overlays with tooltips directly on the page
- **DevTools panel** — three-column UI with issue list, detail panel, and keyboard navigation
- **Popup** — quick score summary with animated ring
- **Filters** — by impact level (critical / serious / moderate / minor) and free-text search
- **Navigate elements** — Prev/Next buttons and ↑↓←→ keyboard shortcuts
- **Element picker** — click any element on the page to scope a scan to it
- **Custom scan** — select specific axe rules or tags to run
- **Preset scans** — WCAG A, AA, compliance + best-practices presets
- **AI fix suggestions** — Chrome Built-in AI or a11y DevTools API backend
- **Export JSON** — download full axe results
- **Internationalization** — UI available in English, Spanish, French, German, and Portuguese
- **Result cache** — last scan is kept in memory per tab

---

## Project structure

```ini
a11y-ext/
├── manifest.json
├── background.js            Service worker — routes messages, runs scans, caches results
├── background/
│   ├── ai-service.js        AI provider orchestration and port-based streaming
│   ├── ai-settings.js       Settings/secrets storage (chrome.storage.local)
│   └── backend-client.js    a11y DevTools API auth and connection management
├── shared/
│   ├── messaging.js         MSG.* constants shared across all contexts
│   └── ai-common.js         Prompt builder, response parser, secret redaction
├── content/
│   ├── content.js           DOM overlay engine (highlights, tooltips, scroll)
│   ├── picker.js            Element picker with Shadow DOM isolation
│   └── auth-bridge.js       Relays external auth token to background
├── core/
│   ├── scoring.js           Weighted pass-rate score + grade
│   └── formatter.js         Normalizes & sorts axe results
├── i18n/
│   ├── i18n.js              i18n utility (load, translate, apply to DOM)
│   └── {en,es,fr,de,pt}.json  Translation files
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── devtools/
│   ├── devtools.html        DevTools entry point (registers the panel)
│   ├── devtools.js
│   ├── panel.html
│   ├── panel.css
│   └── panel.js
├── axe/
│   └── GET_AXE.md           Instructions to download axe.min.js
└── icons/
    └── generate.html        In-browser icon generator
```

---

## Installation

### 1. Download axe-core

```bash
cd axe
npm install axe-core --save-dev
cp node_modules/axe-core/axe.min.js .
```

### 2. Generate icons

Open `icons/generate.html` in Chrome. Right-click each canvas and save as:

- `icons/icon16.png`
- `icons/icon48.png`
- `icons/icon128.png`

### 3. Load the extension

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this folder

---

## Usage

### Popup

Click the extension icon in the toolbar. Hit **Run Scan** to get a quick score summary.

### DevTools panel

1. Open Chrome DevTools (`F12`)
2. Find the **a11y** tab
3. Click **Run Scan**

| Action | How |
|--------|-----|
| Scan the page | Click **Run Scan** |
| Filter by impact | Dropdown or click a counter badge |
| Search issues | Type in the search box |
| Highlight element | Click any issue row |
| Navigate elements | **Prev / Next** buttons or ← → keys |
| Navigate issues | ↑ ↓ arrow keys |
| Scroll to element | Click **↗ Scroll** inside detail panel |
| Clear highlights | Click **Clear** inside detail panel |
| Export results | Click **Export JSON** |

---

## Scoring

Lighthouse-style weighted pass rate: `score = (Σ weight_passing) / (Σ weight_total) × 100`

Each rule contributes one weight unit regardless of how many elements matched.

| Impact | Weight |
|--------|--------|
| Critical | 10 |
| Serious | 7 |
| Moderate | 4 |
| Minor | 1 |

| Grade | Score |
|-------|-------|
| A | 90–100 |
| B | 75–89 |
| C | 50–74 |
| D | 25–49 |
| F | 0–24 |

---

## Architecture notes

**Message flow:**

```ini
Popup / DevTools panel
        │  chrome.runtime.sendMessage
        ▼
   background.js (service worker)
        │  chrome.scripting.executeScript  →  axe.run() in page context (world: MAIN)
        │  chrome.tabs.sendMessage         →  content.js (DOM highlights)
        ▼
   Results cached per tabId
```

**Why `world: "MAIN"`?**
axe-core needs to run in the page's main JavaScript context so it can access framework-rendered DOM and shadow roots. MV3's `chrome.scripting.executeScript` with `world: "MAIN"` handles this cleanly.

**Content script scope:**
`content.js` runs in the isolated world (no access to page JS), which is correct — it only manipulates the DOM to draw overlays, nothing more.

---

## Browser compatibility

| Browser | Support |
|---------|---------|
| Chrome 112+ | Full |
| Edge 112+ | Full |
| Firefox | Not supported (MV3 differences) |

---

## License

This project is licensed under the **MIT License**.

### Third-party dependencies

| Dependency | License | Notes |
|------------|---------|-------|
| [axe-core](https://github.com/dequelabs/axe-core) | [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/) | Not bundled — downloaded separately by the user |

axe-core is a trademark of Deque Systems, Inc. This project is not affiliated with or endorsed by Deque Systems.
