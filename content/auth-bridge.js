/**
 * auth-bridge.js — injected into https://api.a11y.eliasrm.dev/*
 *
 * Bridges window.postMessage from the auth-callback page to
 * chrome.runtime.sendMessage (same-extension). This removes the need
 * to hardcode extension IDs on the auth-callback page.
 *
 * Flow:
 *   auth-callback.js  →  postMessage(A11Y_LOGIN_REQUEST)
 *       → content script (this file) → chrome.runtime.sendMessage(LOGIN_BACKEND)
 *       → background.js onMessage → A11yBackendClient.loginWithExternalToken
 *       → content script → postMessage(A11Y_LOGIN_RESPONSE)
 *   auth-callback.js receives A11Y_LOGIN_RESPONSE and updates the UI.
 */
(function () {
  'use strict';

  window.addEventListener('message', function (event) {
    // Only accept messages from the same frame/origin
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'A11Y_LOGIN_REQUEST') return;

    var token = event.data.token;
    if (!token || typeof token !== 'string') return;

    chrome.runtime.sendMessage(
      { type: 'LOGIN_BACKEND', token: token },
      function (response) {
        if (chrome.runtime.lastError) {
          window.postMessage({
            type: 'A11Y_LOGIN_RESPONSE',
            ok: false,
            error: chrome.runtime.lastError.message,
          }, '*');
          return;
        }
        window.postMessage({
          type: 'A11Y_LOGIN_RESPONSE',
          ok: !!(response && response.ok),
          user: response && response.user,
          error: response && response.error,
        }, '*');
      }
    );
  });
})();
