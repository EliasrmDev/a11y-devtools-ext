importScripts(
  'shared/messaging.js',
  'shared/ai-common.js',
  'background/ai-settings.js',
  'background/ai-service.js'
);

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
        .then(data => {
          chrome.runtime.sendMessage({
            type: MSG.SCAN_UPDATED,
            tabId: msg.tabId,
            results: data.results,
            scanTarget: 'full-page',
          }).catch(() => {});
          sendResponse({ type: MSG.SCAN_RESULT, ...data });
        })
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

    case MSG.GET_AI_SETTINGS:
    case MSG.SAVE_AI_SETTINGS:
    case MSG.TEST_AI_PROVIDER:
    case MSG.CLEAR_AI_SECRET:
      A11yAIService.handleMessage(msg)
        .then(data => sendResponse(data))
        .catch(err => sendResponse({
          ok: false,
          error: err?.message || String(err),
          details: err?.details,
        }));
      return true;

    case MSG.SCAN_ELEMENT:
      handleScanElement(msg.tabId, msg.selector, {
        filterType: msg.filterType,
        selectedRuleIds: msg.selectedRuleIds,
        selectedTags: msg.selectedTags,
      })
        .then(data => {
          chrome.runtime.sendMessage({
            type: MSG.SCAN_UPDATED,
            tabId: msg.tabId,
            results: data.results,
            scanTarget: 'element',
            selector: msg.selector,
          }).catch(() => {});
          sendResponse({ type: MSG.SCAN_RESULT, ...data });
        })
        .catch(err => sendResponse({ type: MSG.SCAN_ERROR, error: err.message }));
      return true;

    case MSG.HIGHLIGHT_ELEMENT:
    case MSG.HIGHLIGHT_NO_SCROLL:
    case MSG.UNHIGHLIGHT_ALL:
    case MSG.SCROLL_TO_ELEMENT:
      ensureContentScript(msg.tabId)
        .then(() => chrome.tabs.sendMessage(msg.tabId, msg))
        .catch(() => {});
      sendResponse({ ok: true });
      return true;

    // ── Picker: panel → content ──
    case MSG.PICKER_START:
    case MSG.PICKER_STOP:
      ensurePickerScript(msg.tabId)
        .then(() => chrome.tabs.sendMessage(msg.tabId, msg))
        .catch(() => {});
      sendResponse({ ok: true });
      return true;

    // ── Picker: content → panel (relayed via background) ──
    case MSG.PICKER_SELECTED:
    case MSG.PICKER_SCOPE_CHANGED:
    case MSG.PICKER_SCAN:
    case MSG.PICKER_CANCELLED:
      // Only relay if from content script (has sender.tab), not from self
      if (sender.tab) {
        chrome.runtime.sendMessage(msg).catch(() => {});
      }
      break;
  }
  return false;
});

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js'],
    });
  } catch (_) { /* tab may not be scriptable */ }
}

async function ensurePickerScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/picker.js'],
    });
  } catch (_) { /* tab may not be scriptable */ }
}

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

async function handleScanElement(tabId, selector, scanSelection = {}) {
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

  const runOptions = { reporter: 'v2', runOnly };

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [selector, runOptions],
    func: (sel, options) =>
      new Promise((resolve, reject) => {
        if (!window.axe) return reject(new Error('axe-core not loaded'));
        let target;
        try { target = document.querySelector(sel); } catch (_) {}
        if (!target) return reject(new Error('Element not found: ' + sel));

        // Run axe on the entire document to catch landmark and iframe issues
        axe.run(
          document,
          options,
          (err, results) => {
            if (err) return reject(err);

            // Filter results to only include violations/passes/etc that affect the target element or its children
            function filterResultsForTarget(resultArray) {
              return resultArray.map(item => {
                // Filter nodes to only include those within the target element
                const filteredNodes = item.nodes.filter(node => {
                  return node.target.some(targetSelector => {
                    try {
                      const nodeElement = document.querySelector(targetSelector);
                      return nodeElement && (target === nodeElement || target.contains(nodeElement));
                    } catch (_) {
                      return false;
                    }
                  });
                });

                // Return item with filtered nodes, or null if no nodes match
                return filteredNodes.length > 0 ? { ...item, nodes: filteredNodes } : null;
              }).filter(Boolean);
            }

            resolve({
              violations:   filterResultsForTarget(results.violations),
              passes:       filterResultsForTarget(results.passes),
              incomplete:   filterResultsForTarget(results.incomplete),
              inapplicable: filterResultsForTarget(results.inapplicable),
              timestamp:    new Date().toISOString(),
              url:          location.href,
              elementSelector: sel,
            });
          }
        );
      }),
  });

  return { results: result, scannedAt: Date.now() };
}

// ── AI Suggest Fix (Chrome Built-in AI via port) ──

chrome.runtime.onConnect.addListener(port => {
  A11yAIService.handlePort(port);
});
