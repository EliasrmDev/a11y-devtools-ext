importScripts('shared/messaging.js');

// tabId → { results, timestamp }
const scanCache = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case MSG.SCAN_REQUEST:
      handleScan(msg.tabId)
        .then(data => sendResponse({ type: MSG.SCAN_RESULT, ...data }))
        .catch(err => sendResponse({ type: MSG.SCAN_ERROR, error: err.message }));
      return true; // keep message channel open for async

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

async function handleScan(tabId) {
  // Verify tab is accessible
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    throw new Error('Cannot scan browser internal pages.');
  }

  // Inject axe-core into the page (idempotent — axe checks if already loaded)
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['axe/axe.min.js'],
    world: 'MAIN',
  });

  // Run axe in the page context and collect results
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () =>
      new Promise((resolve, reject) => {
        if (!window.axe) return reject(new Error('axe-core not loaded'));
        axe.run(
          document,
          {
            reporter: 'v2',
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
          },
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
