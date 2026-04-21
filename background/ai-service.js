(function (global) {
  'use strict';

  const Common = global.A11yAICommon;
  const SettingsStore = global.A11yAISettingsStore;

  class AIRequestError extends Error {
    constructor(code, message, options) {
      super(message);
      this.name = 'AIRequestError';
      this.code = code;
      this.status = options && options.status;
      this.canFallback = Boolean(options && options.canFallback);
      this.details = options && options.details;
    }
  }

  function postPortMessage(port, message) {
    try {
      port.postMessage(message);
    } catch (_) {
      // Ignore disconnected port.
    }
  }

  async function getBuiltInAvailability() {
    if (!global.LanguageModel) {
      return { state: 'unavailable', label: 'Chrome Built-in AI unavailable', available: false, downloadable: false };
    }

    try {
      const state = await global.LanguageModel.availability();
      return {
        state,
        label: state === 'available'
          ? 'Chrome Built-in AI available'
          : state === 'downloadable'
            ? 'Chrome Built-in AI downloadable'
            : 'Chrome Built-in AI unavailable',
        available: state === 'available',
        downloadable: state === 'downloadable',
      };
    } catch (_) {
      return { state: 'unavailable', label: 'Chrome Built-in AI unavailable', available: false, downloadable: false };
    }
  }

  function getExecutionPlan(settings) {
    switch (settings.fallbackMode) {
      case 'remote_only':
        return [settings.selectedProvider];
      case 'builtin_then_remote':
        return settings.selectedProvider === 'builtin'
          ? ['builtin']
          : ['builtin', settings.selectedProvider];
      case 'builtin_only':
      default:
        return ['builtin'];
    }
  }

  function toPublicError(error, secrets) {
    const fallbackMessage = 'Unable to generate a fix suggestion.';
    const message = Common.redactSecrets(error && error.message ? error.message : fallbackMessage, secrets);
    return {
      code: error && error.code ? error.code : 'unknown-error',
      message: message || fallbackMessage,
      status: error && error.status ? error.status : undefined,
      details: error && error.details ? error.details : undefined,
    };
  }

  async function fetchJsonWithTimeout(url, options, timeoutMs, secrets) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      const text = await response.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch (_) {
          json = null;
        }
      }

      if (!response.ok) {
        const providerMessage = json && json.error
          ? (json.error.message || json.error.type || JSON.stringify(json.error))
          : text;
        let code = 'provider-error';
        if (response.status === 401) code = 'unauthorized';
        else if (response.status === 403) code = 'forbidden';
        else if (response.status === 429) code = 'rate-limited';

        throw new AIRequestError(code, Common.redactSecrets(providerMessage || `Request failed with status ${response.status}.`, secrets), {
          status: response.status,
        });
      }

      return { response, json, text };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new AIRequestError('timeout', 'The AI provider request timed out.', { canFallback: true });
      }

      if (error instanceof AIRequestError) {
        throw error;
      }

      throw new AIRequestError('network-error', Common.redactSecrets(error && error.message ? error.message : 'Network request failed.', secrets), {
        canFallback: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function buildOpenAIChatPayload(model, prompts) {
    return {
      model,
      messages: [
        { role: 'system', content: prompts.systemPrompt },
        { role: 'user', content: prompts.userPrompt },
      ],
      temperature: 0.2,
    };
  }

  function extractOpenAIText(json) {
    const content = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : '';
    if (Array.isArray(content)) {
      return content.map((item) => item && item.text ? item.text : '').join('\n').trim();
    }
    return String(content || '').trim();
  }

  function extractAnthropicText(json) {
    if (!json || !Array.isArray(json.content)) return '';
    return json.content
      .filter((item) => item && item.type === 'text' && item.text)
      .map((item) => item.text)
      .join('\n')
      .trim();
  }

  async function runBuiltInProvider(prompts, settings, port) {
    if (!global.LanguageModel) {
      throw new AIRequestError('not-available', 'Chrome Built-in AI is not available.', { canFallback: true });
    }

    const availability = await global.LanguageModel.availability();
    if (availability === 'unavailable') {
      throw new AIRequestError('not-available', 'Chrome Built-in AI is not available.', { canFallback: true });
    }

    const createOptions = { systemPrompt: prompts.systemPrompt };
    if (availability === 'downloadable') {
      postPortMessage(port, { type: 'downloading', loaded: 0, total: 1 });
      createOptions.monitor = (monitor) => {
        monitor.addEventListener('downloadprogress', (event) => {
          postPortMessage(port, { type: 'downloading', loaded: event.loaded, total: event.total });
        });
      };
    }

    const session = await global.LanguageModel.create(createOptions);
    postPortMessage(port, { type: 'status', message: 'Generating fix with Chrome Built-in AI…' });

    try {
      const stream = session.promptStreaming(prompts.userPrompt);
      const reader = stream.getReader();
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (typeof value === 'string') {
          if (value.startsWith(fullText)) fullText = value;
          else fullText += value;
          postPortMessage(port, { type: 'chunk', text: fullText });
        }
      }

      if (!fullText.trim()) {
        throw new AIRequestError('empty-response', 'Chrome Built-in AI returned an empty response.', { canFallback: true });
      }

      return {
        providerId: 'builtin',
        rawText: fullText,
        normalized: Common.parseAIResponse(fullText),
      };
    } finally {
      session.destroy();
    }
  }

  async function runOpenAICompatibleProvider(providerId, settings, secrets, prompts, endpoint, extraHeaders) {
    const provider = Common.getProviderConfig(settings, providerId);
    const secretKey = Common.getSecretKey(providerId);
    const apiKey = secrets[secretKey];

    if (!provider.model) {
      throw new AIRequestError('setup-required', `${Common.getProviderLabel(providerId)} model is required.`);
    }
    if (!apiKey) {
      throw new AIRequestError('setup-required', `${Common.getProviderLabel(providerId)} API key is required.`);
    }

    const result = await fetchJsonWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(extraHeaders || {}),
      },
      body: JSON.stringify(buildOpenAIChatPayload(provider.model, prompts)),
    }, settings.timeoutMs, secrets);

    const text = extractOpenAIText(result.json);
    if (!text) {
      throw new AIRequestError('empty-response', `${Common.getProviderLabel(providerId)} returned an empty response.`);
    }

    return {
      providerId,
      rawText: text,
      normalized: Common.parseAIResponse(text),
    };
  }

  async function runAnthropicProvider(settings, secrets, prompts) {
    const provider = Common.getProviderConfig(settings, 'anthropic');
    const apiKey = secrets.anthropicApiKey;

    if (!provider.model) {
      throw new AIRequestError('setup-required', 'Anthropic model is required.');
    }
    if (!apiKey) {
      throw new AIRequestError('setup-required', 'Anthropic API key is required.');
    }

    const result = await fetchJsonWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: provider.model,
        system: prompts.systemPrompt,
        max_tokens: 900,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompts.userPrompt }],
      }),
    }, settings.timeoutMs, secrets);

    const text = extractAnthropicText(result.json);
    if (!text) {
      throw new AIRequestError('empty-response', 'Anthropic returned an empty response.');
    }

    return {
      providerId: 'anthropic',
      rawText: text,
      normalized: Common.parseAIResponse(text),
    };
  }

  async function runBackendProvider(settings, violationContext, lang) {
    const cfg = Common.getProviderConfig(settings, 'a11y_backend');
    if (!cfg.connectionId) {
      throw new AIRequestError('setup-required', 'Select a backend connection in AI Settings.');
    }
    if (!cfg.model) {
      throw new AIRequestError('setup-required', 'Enter a model name for the a11y DevTools API.');
    }

    let result;
    try {
      result = await global.A11yBackendClient.callAccessibilitySuggest(
        cfg.connectionId,
        cfg.model,
        violationContext,
        lang,
      );
    } catch (error) {
      const status = error && error.status;
      if (status === 401 || status === 403) {
        throw new AIRequestError('unauthorized', 'Backend session expired. Sign in again in AI Settings.');
      }
      if (status === 429) {
        throw new AIRequestError('rate-limited', 'Backend rate limit reached. Try again later.');
      }
      if (status === 400 || status === 422) {
        throw new AIRequestError('validation-error', error && error.message ? error.message : 'Request validation failed.');
      }
      throw new AIRequestError(
        'network-error',
        error && error.message ? error.message : 'Backend request failed.',
        { canFallback: true }
      );
    }

    // Backend returns AccessibilitySuggestOutput — map directly, do NOT run through Common.parseAIResponse
    const normalized = {
      shortExplanation: result.shortExplanation || '',
      userImpact: result.userImpact || '',
      recommendedFix: result.recommendedFix || '',
      codeExample: result.codeExample || '',
      confidence: result.confidence || 'medium',
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      rawText: result.recommendedFix || '',
    };

    return { providerId: 'a11y_backend', rawText: result.recommendedFix || '', normalized };
  }

  async function runRemoteProvider(providerId, settings, secrets, prompts, violationContext, lang) {
    switch (providerId) {
      case 'openai':
        return runOpenAICompatibleProvider(
          'openai',
          settings,
          secrets,
          prompts,
          'https://api.openai.com/v1/chat/completions'
        );
      case 'openrouter':
        return runOpenAICompatibleProvider(
          'openrouter',
          settings,
          secrets,
          prompts,
          'https://openrouter.ai/api/v1/chat/completions',
          {
            'HTTP-Referer': 'https://github.com/EliasrmDev/a11y-devtools-ext',
            'X-Title': 'a11y DevTools',
          }
        );
      case 'custom': {
        const customEndpoint = Common.normalizeChatCompletionsBaseUrl(Common.getProviderConfig(settings, 'custom').baseUrl);
        if (!customEndpoint) {
          throw new AIRequestError('setup-required', 'Custom OpenAI-compatible base URL is required.');
        }
        return runOpenAICompatibleProvider('custom', settings, secrets, prompts, customEndpoint);
      }
      case 'anthropic':
        return runAnthropicProvider(settings, secrets, prompts);
      case 'a11y_backend':
        return runBackendProvider(settings, violationContext, lang);
      default:
        throw new AIRequestError('setup-required', 'Choose a supported AI provider.');
    }
  }

  async function executeProvider(providerId, settings, secrets, prompts, port, violationContext, lang) {
    const model = providerId !== 'builtin'
      ? (Common.getProviderConfig(settings, providerId).model || '')
      : '';
    const label = Common.getProviderLabel(providerId);
    const statusMsg = model ? `Using ${label} — ${model}…` : `Using ${label}…`;
    postPortMessage(port, { type: 'status', message: statusMsg });
    if (providerId === 'builtin') {
      return runBuiltInProvider(prompts, settings, port);
    }
    return runRemoteProvider(providerId, settings, secrets, prompts, violationContext, lang);
  }

  async function generateFix(payload, port) {
    const stored = await SettingsStore.readStoredConfig();
    const settings = stored.settings;
    const secrets = stored.secrets;

    if (!settings.enabled) {
      throw new AIRequestError('ai-disabled', 'AI suggestions are disabled. Open AI settings to enable them.');
    }

    const plan = getExecutionPlan(settings);
    const lang = payload.lang || 'en';
    const prompts = Common.buildPromptMessages(payload.finding || {}, lang);
    const violationContext = payload.finding || {};   // extract for backend provider
    let lastError = null;

    for (let index = 0; index < plan.length; index += 1) {
      const providerId = plan[index];
      try {
        const result = await executeProvider(providerId, settings, secrets, prompts, port, violationContext, lang);
        return result;
      } catch (error) {
        lastError = error;
        const canTryNext = index < plan.length - 1 && error && error.canFallback;
        if (canTryNext) {
          postPortMessage(port, {
            type: 'status',
            message: `${Common.getProviderLabel(providerId)} unavailable, trying fallback provider…`,
          });
          continue;
        }
        break;
      }
    }

    throw lastError || new AIRequestError('unknown-error', 'Unable to generate a fix suggestion.');
  }

  async function testProvider(draft) {
    const stored = await SettingsStore.readStoredConfig();
    const merged = SettingsStore.withDraftConfig(stored, draft);
    const settings = merged.settings;
    const secrets = merged.secrets;

    if (settings.selectedProvider === 'builtin' || settings.fallbackMode === 'builtin_only') {
      return {
        ok: (await getBuiltInAvailability()).state !== 'unavailable',
        providerId: 'builtin',
        message: (await getBuiltInAvailability()).label,
      };
    }

    const providerId = settings.selectedProvider;
    const prompts = Common.buildPromptMessages({
      ruleId: 'color-contrast',
      help: 'Elements must have sufficient color contrast',
      description: 'Background and foreground colors do not have a sufficient contrast ratio.',
      impact: 'serious',
      selector: '.demo-button',
      htmlSnippet: '<button class="demo-button">Continue</button>',
      failureSummary: 'Fix contrast ratio and keep the label readable.',
      checks: [],
    });

    if (providerId === 'a11y_backend') {
      const testViolation = {
        ruleId: 'color-contrast',
        help: 'Elements must have sufficient color contrast',
        description: 'Background and foreground colors do not have a sufficient contrast ratio.',
        impact: 'serious',
        selector: '.demo-button',
        htmlSnippet: '<button class="demo-button">Continue</button>',
        failureSummary: 'Fix contrast ratio and keep the label readable.',
        checks: [],
      };
      const result = await runBackendProvider(merged.settings, testViolation);
      return {
        ok: true,
        providerId,
        message: 'a11y DevTools API connection succeeded.',
        sample: result.normalized.shortExplanation || 'OK',
      };
    }

    const result = await runRemoteProvider(providerId, settings, secrets, prompts);
    return {
      ok: true,
      providerId,
      message: `${Common.getProviderLabel(providerId)} connection succeeded.`,
      sample: result.normalized.shortExplanation || result.normalized.recommendedFix || 'OK',
    };
  }

  async function getPublicSettingsPayload() {
    const stored = await SettingsStore.readStoredConfig();
    const builtIn = await getBuiltInAvailability();
    return {
      settings: SettingsStore.buildPublicSettings(stored.settings, stored.secrets),
      builtIn,
      providers: Common.PROVIDERS.map((providerId) => ({
        id: providerId,
        label: Common.getProviderLabel(providerId),
      })),
    };
  }

  async function fetchModelsList(url, headers) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { json = null; }
      if (!response.ok) {
        const errMsg = json && json.error
          ? (json.error.message || JSON.stringify(json.error))
          : `Request failed (${response.status})`;
        throw new AIRequestError('provider-error', errMsg, { status: response.status });
      }
      return json;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new AIRequestError('timeout', 'Models list request timed out.');
      }
      if (error instanceof AIRequestError) throw error;
      throw new AIRequestError('network-error', error && error.message ? error.message : 'Network request failed.');
    } finally {
      clearTimeout(timeout);
    }
  }

  async function listProviderModels(providerId, candidateApiKey) {
    const stored = await SettingsStore.readStoredConfig();
    const secretKey = Common.getSecretKey(providerId);
    const apiKey = (candidateApiKey && candidateApiKey.trim()) || (secretKey && stored.secrets[secretKey]) || '';

    if (!apiKey) {
      throw new AIRequestError('no-api-key', 'Enter an API key to browse available models.');
    }

    if (providerId === 'openai') {
      const json = await fetchModelsList('https://api.openai.com/v1/models', {
        Authorization: `Bearer ${apiKey}`,
      });
      const chatModels = (json.data || [])
        .filter((m) => /^(gpt-|o\d|chatgpt)/i.test(m.id))
        .sort((a, b) => a.id.localeCompare(b.id));
      return chatModels.map((m) => ({ id: m.id, name: m.id }));
    }

    if (providerId === 'anthropic') {
      const json = await fetchModelsList('https://api.anthropic.com/v1/models?limit=1000', {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      });
      const models = (json.data || json.models || []).slice().sort((a, b) => a.id.localeCompare(b.id));
      return models.map((m) => ({ id: m.id, name: m.display_name || m.id }));
    }

    if (providerId === 'openrouter') {
      const json = await fetchModelsList('https://openrouter.ai/api/v1/models', {
        Authorization: `Bearer ${apiKey}`,
      });
      const models = (json.data || []).slice().sort((a, b) => a.id.localeCompare(b.id));
      return models.map((m) => ({ id: m.id, name: m.name || m.id }));
    }

    throw new AIRequestError('unsupported', `Model listing is not supported for provider: ${providerId}`);
  }

  async function handleMessage(msg) {
    switch (msg.type) {
      case 'GET_AI_SETTINGS':
        return getPublicSettingsPayload();
      case 'SAVE_AI_SETTINGS': {
        const saved = await SettingsStore.saveConfig(msg.payload || {});
        return {
          settings: saved,
          builtIn: await getBuiltInAvailability(),
          ok: true,
        };
      }
      case 'CLEAR_AI_SECRET': {
        const updated = await SettingsStore.clearSecret(msg.providerId);
        return {
          settings: updated,
          builtIn: await getBuiltInAvailability(),
          ok: true,
        };
      }
      case 'TEST_AI_PROVIDER': {
        const result = await testProvider(msg.payload || {});
        return {
          ok: result.ok,
          providerId: result.providerId,
          message: result.message,
          sample: result.sample || '',
        };
      }
      case 'GET_BACKEND_AUTH_STATUS': {
        const status = await global.A11yBackendClient.getAuthStatus();
        return { ok: true, ...status };
      }
      case 'LOGIN_BACKEND': {
        const auth = await global.A11yBackendClient.loginWithExternalToken(msg.token);
        return { ok: true, user: auth.user };
      }
      case 'LOGOUT_BACKEND': {
        await global.A11yBackendClient.logout();
        return { ok: true };
      }
      case 'LIST_BACKEND_CONNECTIONS': {
        const result = await global.A11yBackendClient.listConnections();
        console.log('Connections: ', result);
        return { ok: true, data: result.data || [] };
      }
      case 'CREATE_BACKEND_CONNECTION': {
        const conn = await global.A11yBackendClient.createConnection(msg.payload);
        return { ok: true, connection: conn };
      }
      case 'DELETE_BACKEND_CONNECTION': {
        await global.A11yBackendClient.deleteConnection(msg.connectionId);
        return { ok: true };
      }
      case 'LIST_BACKEND_MODELS': {
        const result = await global.A11yBackendClient.listModels(msg.connectionId || '');
        return { ok: true, data: result.data || [] };
      }
      case 'LIST_PROVIDER_MODELS': {
        const models = await listProviderModels(msg.providerId, msg.apiKey || '');
        return { ok: true, data: models };
      }
      default:
        return null;
    }
  }

  function handlePort(port) {
    if (port.name !== 'ai-fix') return false;

    port.onMessage.addListener(async (message) => {
      try {
        const result = await generateFix(message || {}, port);
        postPortMessage(port, {
          type: 'result',
          providerId: result.providerId,
          text: result.rawText,
          normalized: result.normalized,
        });
        postPortMessage(port, { type: 'done' });
      } catch (error) {
        const stored = await SettingsStore.readStoredConfig();
        const publicError = toPublicError(error, stored.secrets);
        postPortMessage(port, {
          type: 'error',
          error: publicError.message,
          errorCode: publicError.code,
          details: publicError.details,
          status: publicError.status,
        });
      }
    });

    return true;
  }

  global.A11yAIService = {
    getBuiltInAvailability,
    handleMessage,
    handlePort,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);