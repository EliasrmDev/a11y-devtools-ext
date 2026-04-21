(function (global) {
  'use strict';

  // ⚠️  BACKEND_URL must point to the API worker, NOT the landing page.
  //     Landing page:  https://a11y.eliasrm.dev          ← NO
  //     API worker:    https://api.a11y.eliasrm.dev       ← YES
  const BACKEND_URL = 'https://api.a11y.eliasrm.dev';
  const AUTH_KEY = 'backend_auth_v1';

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      try { chrome.storage.local.get(keys, resolve); }
      catch (e) { reject(e); }
    });
  }

  function storageSet(value) {
    return new Promise((resolve, reject) => {
      try { chrome.storage.local.set(value, resolve); }
      catch (e) { reject(e); }
    });
  }

  async function readAuth() {
    const data = await storageGet([AUTH_KEY]);
    return data[AUTH_KEY] || null;
  }

  async function writeAuth(auth) {
    await storageSet({ [AUTH_KEY]: auth });
  }

  async function clearAuth() {
    await storageSet({ [AUTH_KEY]: null });
  }

  async function refreshTokens(refreshToken) {
    const res = await fetch(`${BACKEND_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) throw new Error('Token refresh failed');
    const data = await res.json();
    const auth = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + data.expiresIn * 1000,
      user: data.user,
    };
    await writeAuth(auth);
    return auth;
  }

  async function getAccessToken() {
    const auth = await readAuth();
    if (!auth || !auth.accessToken) {
      throw new Error('Not authenticated with a11y DevTools API.');
    }
    // Refresh if token expires within 60 seconds
    if (auth.expiresAt && Date.now() >= auth.expiresAt - 60_000) {
      try {
        const refreshed = await refreshTokens(auth.refreshToken);
        return refreshed.accessToken;
      } catch (_) {
        await clearAuth();
        throw new Error('Session expired. Please sign in again.');
      }
    }
    return auth.accessToken;
  }

  async function backendFetch(path, options) {
    const token = await getAccessToken();
    const res = await fetch(`${BACKEND_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...((options && options.headers) || {}),
      },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json && json.error) ? json.error : `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async function loginWithExternalToken(externalToken) {
    const res = await fetch(`${BACKEND_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: externalToken }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json && json.error) ? json.error : `Login failed (${res.status})`;
      throw new Error(msg);
    }
    const auth = {
      accessToken: json.accessToken,
      refreshToken: json.refreshToken,
      expiresAt: Date.now() + json.expiresIn * 1000,
      user: json.user,
    };
    await writeAuth(auth);
    return auth;
  }

  async function logout() {
    try {
      const token = await getAccessToken();
      await fetch(`${BACKEND_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
    } catch (_) { /* best-effort */ }
    await clearAuth();
  }

  async function getAuthStatus() {
    const auth = await readAuth();
    if (!auth || !auth.accessToken) return { authenticated: false, user: null };
    return { authenticated: true, user: auth.user || null };
  }

  function listConnections() {
    return backendFetch('/api/v1/providers/connections');
  }

  function listModels(connectionId) {
    if (!connectionId) return Promise.resolve({ data: [] });
    return backendFetch(`/api/v1/providers/connections/${encodeURIComponent(connectionId)}/models`);
  }

  function createConnection(data) {
    return backendFetch('/api/v1/providers/connections', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  function deleteConnection(id) {
    return backendFetch(`/api/v1/providers/connections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  function callAccessibilitySuggest(connectionId, model, violation, lang) {
    const payload = {
      connectionId,
      model,
      ruleId:         violation.ruleId         || '',
      help:           violation.help            || '',
      description:    violation.description     || '',
      impact:         violation.impact          || '',
      selector:       violation.selector        || '',
      htmlSnippet:    violation.htmlSnippet     || '',
      failureSummary: violation.failureSummary  || 'No failure summary available.',
      checks:         Array.isArray(violation.checks) ? violation.checks : [],
      ...(lang && lang !== 'en' ? { lang } : {}),
    };
    return backendFetch('/api/v1/accessibility/suggest', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  global.A11yBackendClient = {
    loginWithExternalToken,
    logout,
    getAuthStatus,
    listConnections,
    listModels,
    createConnection,
    deleteConnection,
    callAccessibilitySuggest,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);