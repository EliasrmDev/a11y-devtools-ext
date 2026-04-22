# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

No build system. Vanilla JS loaded directly into Chrome.

**One-time setup:**
```bash
cd axe && npm install axe-core --save-dev && cp node_modules/axe-core/axe.min.js .
```

**Load extension for development:**
Chrome → `chrome://extensions` → Developer mode → Load unpacked → select project root

**Pack for distribution:**
```bash
bash pack.sh   # validates required files, copies to dist/a11y-devtools/
```

**Icon generation (one-time):** Open `icons/generate.html` in Chrome, right-click each canvas, save as `icons/icon16.png`, `icon48.png`, `icon128.png`.

No linting or test commands — no test suite exists.

## Architecture

MV3 Chrome extension. No bundler, no transpilation.

### Components & Message Flow

```
DevTools Panel / Popup
  └── chrome.runtime.sendMessage() / connect()
        └── background.js (service worker — router, scan cache, AI routing)
              ├── chrome.scripting.executeScript (world: MAIN) → axe.run() in page context
              └── chrome.tabs.sendMessage → content/content.js (DOM overlays)
```

- **`background.js`** — central message router. Maintains `Map<tabId, results>` cache. Injects axe-core idempotently into MAIN world so it can access framework-rendered DOM and Shadow DOM.
- **`content/content.js`** — runs in isolated world. Renders positioned overlays (impact-colored divs + tooltips) on top of page elements. Stateless, event-driven.
- **`content/picker.js`** — element picker injected on demand. Uses Shadow DOM to isolate its own UI from the page. Detects landmark scopes and iframe boundaries.
- **`devtools/panel.js`** — ~2500 lines, single-file UI. One `state` object drives all DOM updates. Handles keyboard nav (↑↓ issues, ←→ elements), custom rule/tag filtering, and AI fix suggestions via a long-lived port to background.
- **`popup/popup.js`** — minimal scan trigger; reads cached results from background, links to DevTools.

All message type constants are in **`shared/messaging.js`** — always use `MSG.*` constants, never raw strings.

### AI Fix Suggestions

AI requests flow: panel opens `chrome.runtime.connect()` port → `background/ai-service.js` routes to provider → streams response back.

- **`shared/ai-common.js`** — prompt construction (`buildPromptMessages`), response parsing (`parseAIResponse`), secret redaction (`redactSecrets`). Normalize all AI responses through `parseAIResponse` before display.
- **`background/ai-settings.js`** — settings in `ai_settings_v1`, secrets in `ai_secrets_v1` (local storage only, never synced). `buildPublicSettings()` masks keys before sending to UI.
- **`background/backend-client.js`** — authenticates against `https://api.a11y.eliasrm.dev`. Auth flow: external page redirects → `chrome.runtime.sendMessageExternal()` → stored tokens with auto-refresh 60s before expiry.

Providers: Chrome Built-in AI (Gemini Nano, no key) and a11y DevTools backend. Fallback modes: `builtin_only`, `remote_only`, `builtin_then_remote`.

### Scoring & Formatting

**`core/scoring.js`** — Lighthouse-style weighted pass rate. Impact weights: critical=10, serious=7, moderate=4, minor=1. Grades: A≥90, B≥75, C≥50, D≥25, F<25.

**`core/formatter.js`** — normalizes raw axe results: sorts by impact, extracts check groups, flattens selectors to `primarySelector`.

### i18n

5 languages (en/es/fr/de/pt), ~500 keys each in `i18n/{lang}.json`.

```javascript
await i18n.initI18n()     // call once on context init
i18n.t('key')             // get translation
i18n.t('key', { var })    // with interpolation
i18n.applyDOM(root)       // apply data-i18n* attributes in bulk
```

HTML attributes: `data-i18n`, `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-aria-label`. Always use these for any new UI text — never hardcode strings.

Language override stored in `chrome.storage.local['i18n_lang']`; falls back to `chrome.i18n.getUILanguage()`.

## Key Conventions

- **MAIN vs isolated world**: axe-core and `core/` utilities run in MAIN world. Content scripts run in isolated world. Never mix — MAIN world code cannot use `chrome.*` APIs.
- **State in panel.js**: All UI state lives in the single `state` object. Mutate state, then call the relevant render function — don't manipulate DOM directly outside render paths.
- **Secret handling**: API keys go only in `ai_secrets_v1` storage key. Always pass through `redactSecrets()` before including in error messages or logs.
- **Overlay z-index**: Base 2147483640, active 2147483647, tooltip 2147483648. Don't use arbitrary z-index values in content scripts.
- **pack.sh whitelist**: Distribution uses an explicit file list. Add new files to `pack.sh` when adding new source files, or they won't be included in builds.
