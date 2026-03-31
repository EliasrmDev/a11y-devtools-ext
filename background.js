importScripts('shared/messaging.js');

// tabId → { results, timestamp }
const scanCache = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case MSG.SCAN_REQUEST:
      handleScan(msg.tabId, {
        filterType: msg.filterType,
        selectedRuleIds: msg.selectedRuleIds,
        selectedTags: msg.selectedTags,
      })
        .then(data => sendResponse({ type: MSG.SCAN_RESULT, ...data }))
        .catch(err => sendResponse({ type: MSG.SCAN_ERROR, error: err.message }));
      return true; // keep message channel open for async

    case MSG.GET_AXE_RULES:
      handleGetAxeRules(msg.tabId)
        .then(data => sendResponse({ type: MSG.AXE_RULES_RESULT, ...data }))
        .catch(err => sendResponse({ type: MSG.SCAN_ERROR, error: err.message }));
      return true;

    case MSG.GET_CACHED_RESULTS: {
      const cached = scanCache.get(msg.tabId) || null;
      sendResponse({ cached });
      break;
    }

    case MSG.HIGHLIGHT_ELEMENT:
    case MSG.UNHIGHLIGHT_ALL:
    case MSG.SCROLL_TO_ELEMENT:
      chrome.tabs.sendMessage(msg.tabId, msg).catch(() => {});
      sendResponse({ ok: true });
      break;
  }
  return false;
});

async function ensureTabIsScannable(tabId) {
  // Verify tab is accessible
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    throw new Error('Cannot scan browser internal pages.');
  }

  return tab;
}

async function ensureAxeInjected(tabId) {
  // Inject axe-core into the page (idempotent — axe checks if already loaded)
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['axe/axe.min.js'],
    world: 'MAIN',
  });
}

async function handleGetAxeRules(tabId) {
  await ensureTabIsScannable(tabId);
  await ensureAxeInjected(tabId);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      if (!window.axe) throw new Error('axe-core not loaded');

      const rules = axe.getRules().map(rule => ({
        id: rule.ruleId || rule.id,
        description: rule.description || '',
        help: rule.help || '',
        tags: Array.isArray(rule.tags) ? rule.tags : [],
      }));

      const tags = Array.from(new Set(rules.flatMap(rule => rule.tags))).sort();
      return { rules, tags };
    },
  });

  return result;
}

async function handleScan(tabId, scanSelection = {}) {
  await ensureTabIsScannable(tabId);
  await ensureAxeInjected(tabId);

  const selectedRuleIds = Array.isArray(scanSelection.selectedRuleIds)
    ? scanSelection.selectedRuleIds.filter(id => typeof id === 'string' && id.trim().length > 0)
    : [];
  const selectedTags = Array.isArray(scanSelection.selectedTags)
    ? scanSelection.selectedTags.filter(tag => typeof tag === 'string' && tag.trim().length > 0)
    : [];
  const filterType = scanSelection.filterType === 'tag' ? 'tag' : 'rule';
  const defaultTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

  const runOnly = filterType === 'tag'
    ? { type: 'tag', values: selectedTags }
    : { type: 'rule', values: selectedRuleIds };

  if (!runOnly.values.length) {
    runOnly.type = 'tag';
    runOnly.values = defaultTags;
  }

  const runOptions = {
    reporter: 'v2',
    runOnly,
  };

  // Run axe in the page context and collect results
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [runOptions],
    func: (options) =>
      new Promise((resolve, reject) => {
        if (!window.axe) return reject(new Error('axe-core not loaded'));
        axe.run(
          document,
          options,
          (err, results) => {
            if (err) return reject(err);
            resolve({
              violations:   results.violations,
              passes:       results.passes,
              incomplete:   results.incomplete,
              inapplicable: results.inapplicable,
              timestamp:    new Date().toISOString(),
              url:          location.href,
            });
          }
        );
      }),
  });

  const entry = { results: result, scannedAt: Date.now() };
  scanCache.set(tabId, entry);
  return entry;
}
