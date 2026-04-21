(function (global) {
  'use strict';

  const SCHEMA_VERSION = 1;
  // const PROVIDERS = ['builtin', 'openai', 'anthropic', 'openrouter', 'custom'];
  const PROVIDERS = ['builtin', 'openai', 'anthropic', 'openrouter', 'custom', 'a11y_backend'];
  const REMOTE_PROVIDERS = ['openai', 'anthropic', 'openrouter', 'custom'];
  const FALLBACK_MODES = ['builtin_only', 'remote_only', 'builtin_then_remote'];
  const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];

  const DEFAULT_SETTINGS = {
    version: SCHEMA_VERSION,
    enabled: true,
    selectedProvider: 'builtin',
    fallbackMode: 'builtin_only',
    timeoutMs: 20000,
    providers: {
      builtin: {},
      openai: { model: 'gpt-4.1-mini' },
      anthropic: { model: 'claude-3-5-haiku-latest' },
      openrouter: { model: 'openai/gpt-4.1-mini' },
      custom: { model: '', baseUrl: '' },
      a11y_backend: { connectionId: '', model: '' },
    },
  };

  const DEFAULT_SECRETS = {
    openaiApiKey: '',
    anthropicApiKey: '',
    openrouterApiKey: '',
    customApiKey: '',
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function trimString(value, maxLen) {
    if (value === null || value === undefined) return '';
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (!maxLen || text.length <= maxLen) return text;
    return text.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…';
  }

  function trimMultiline(value, maxLen) {
    if (value === null || value === undefined) return '';
    const text = String(value).replace(/\r\n/g, '\n').trim();
    if (!maxLen || text.length <= maxLen) return text;
    return text.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…';
  }

  function normalizeEnum(value, allowed, fallbackValue) {
    return allowed.includes(value) ? value : fallbackValue;
  }

  function normalizeTimeout(timeoutMs) {
    const parsed = Number(timeoutMs);
    if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.timeoutMs;
    return Math.min(60000, Math.max(5000, Math.round(parsed)));
  }

  function normalizeBaseUrl(baseUrl) {
    const value = trimString(baseUrl, 512);
    if (!value) return '';

    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) return '';
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    } catch (_) {
      return '';
    }
  }

  function getSecretKey(providerId) {
    if (!providerId || providerId === 'builtin' || providerId === 'a11y_backend') return '';
    return `${providerId}ApiKey`;
  }

  function maskSecret(secret) {
    const value = trimString(secret);
    if (!value) return '';
    if (value.length <= 8) return '••••••••';
    return `${value.slice(0, 3)}••••${value.slice(-4)}`;
  }

  function mergeSettings(rawSettings) {
    const merged = clone(DEFAULT_SETTINGS);
    const input = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const inputProviders = input.providers && typeof input.providers === 'object' ? input.providers : {};

    merged.version = SCHEMA_VERSION;
    merged.enabled = input.enabled !== false;
    merged.selectedProvider = normalizeEnum(input.selectedProvider, PROVIDERS, DEFAULT_SETTINGS.selectedProvider);
    merged.fallbackMode = normalizeEnum(input.fallbackMode, FALLBACK_MODES, DEFAULT_SETTINGS.fallbackMode);
    merged.timeoutMs = normalizeTimeout(input.timeoutMs);

    PROVIDERS.forEach((providerId) => {
      const source = inputProviders[providerId] && typeof inputProviders[providerId] === 'object'
        ? inputProviders[providerId]
        : {};
      if (providerId !== 'builtin') {
        merged.providers[providerId].model = trimString(source.model, 120);
      }
      if (providerId === 'custom') {
        merged.providers.custom.baseUrl = normalizeBaseUrl(source.baseUrl);
      }
      if (providerId === 'a11y_backend') {
        merged.providers.a11y_backend.connectionId = trimString(source.connectionId, 200);
      }
    });

    return merged;
  }

  function mergeSecrets(rawSecrets) {
    const merged = clone(DEFAULT_SECRETS);
    const input = rawSecrets && typeof rawSecrets === 'object' ? rawSecrets : {};

    Object.keys(merged).forEach((key) => {
      merged[key] = trimString(input[key], 400);
    });

    return merged;
  }

  function getProviderConfig(settings, providerId) {
    const provider = settings && settings.providers ? settings.providers[providerId] : null;
    return provider && typeof provider === 'object' ? provider : {};
  }

  function isRemoteProvider(providerId) {
    return REMOTE_PROVIDERS.includes(providerId);
  }

  function getProviderLabel(providerId) {
    switch (providerId) {
      case 'builtin': return 'Chrome Built-in AI';
      case 'openai': return 'OpenAI';
      case 'anthropic': return 'Anthropic';
      case 'openrouter': return 'OpenRouter';
      case 'custom': return 'Custom OpenAI-compatible';
      case 'a11y_backend': return 'a11y DevTools API';
      default: return 'Unknown provider';
    }
  }

  function validateSettings(settings, secrets) {
    const errors = [];

    if (settings.fallbackMode !== 'builtin_only' && settings.selectedProvider === 'builtin') {
      errors.push({ field: 'selectedProvider', message: 'Choose a remote provider for remote fallback modes.' });
    }

    const requiredRemoteProvider = settings.fallbackMode === 'builtin_only'
      ? ''
      : settings.selectedProvider;

    REMOTE_PROVIDERS.forEach((providerId) => {
      const provider = getProviderConfig(settings, providerId);
      const secretKey = getSecretKey(providerId);
      const hasKey = Boolean(secrets[secretKey]);

      if (requiredRemoteProvider !== providerId) return;

      if (!provider.model) {
        errors.push({ field: `${providerId}.model`, message: `${getProviderLabel(providerId)} model is required.` });
      }

      if (!hasKey) {
        errors.push({ field: `${providerId}.apiKey`, message: `${getProviderLabel(providerId)} API key is required.` });
      }

      if (providerId === 'custom' && !provider.baseUrl) {
        errors.push({ field: 'custom.baseUrl', message: 'Custom OpenAI-compatible base URL is required.' });
      }
    });

    if (settings.selectedProvider === 'a11y_backend') {
      const cfg = getProviderConfig(settings, 'a11y_backend');
      if (!cfg.connectionId) {
        errors.push({ field: 'a11y_backend.connectionId', message: 'Select a backend connection.' });
      }
      if (!cfg.model) {
        errors.push({ field: 'a11y_backend.model', message: 'a11y DevTools API model is required.' });
      }
    }

    return errors;
  }

  function getProviderConfigState(providerId, settings, secrets) {
    const provider = getProviderConfig(settings, providerId);
    const secretKey = getSecretKey(providerId);
    const hasApiKey = Boolean(secretKey && secrets[secretKey]);

    if (providerId === 'builtin') {
      return {
        configured: true,
        hasApiKey: false,
        maskedApiKey: '',
        model: '',
        baseUrl: '',
        reason: 'local',
      };
    }

    if (providerId === 'a11y_backend') {
      const connectionId = (provider && provider.connectionId) || '';
      const model = (provider && provider.model) || '';
      const configured = Boolean(connectionId && model);
      return {
        configured,
        hasApiKey: false,
        maskedApiKey: '',
        model,
        baseUrl: '',
        connectionId,
        missing: [
          ...(!connectionId ? ['connectionId'] : []),
          ...(!model ? ['model'] : []),
        ],
        reason: configured ? 'ready' : 'missing:connectionId,model',
      };
    }

    const missing = [];
    if (!provider.model) missing.push('model');
    if (!hasApiKey) missing.push('apiKey');
    if (providerId === 'custom' && !provider.baseUrl) missing.push('baseUrl');

    return {
      configured: missing.length === 0,
      hasApiKey,
      maskedApiKey: hasApiKey ? maskSecret(secrets[secretKey]) : '',
      model: provider.model || '',
      baseUrl: provider.baseUrl || '',
      missing,
      reason: missing.length ? `missing:${missing.join(',')}` : 'ready',
    };
  }

  function pickRelevantChecks(node) {
    const groups = Array.isArray(node && node.checks) ? node.checks : [];
    const output = [];

    for (const group of groups.slice(0, 3)) {
      const checks = Array.isArray(group.checks) ? group.checks.slice(0, 4) : [];
      checks.forEach((check) => {
        const item = {
          group: trimString(group.type || 'unknown', 40),
          id: trimString(check.id || 'unknown', 80),
          impact: trimString(check.impact || node.impact || '', 20),
          message: trimString(check.message || '', 240),
        };

        if (check.data && typeof check.data === 'object') {
          const data = {};
          Object.entries(check.data).slice(0, 6).forEach(([key, value]) => {
            if (value === null || value === undefined || value === '') return;
            data[trimString(key, 40)] = trimString(typeof value === 'object' ? JSON.stringify(value) : value, 200);
          });
          if (Object.keys(data).length) item.data = data;
        }

        if (Array.isArray(check.relatedNodes) && check.relatedNodes.length) {
          item.relatedNodes = check.relatedNodes.slice(0, 2).map((relatedNode) => ({
            target: trimString(relatedNode.target || relatedNode.selector || '', 160),
            html: trimMultiline(relatedNode.html || '', 220),
          }));
        }

        output.push(item);
      });
    }

    return output;
  }

  function createFixRequest(rule, node) {
    return {
      ruleId: trimString(rule && rule.id, 80),
      help: trimString(rule && rule.help, 220),
      description: trimString(rule && rule.description, 220),
      helpUrl: trimString(rule && rule.helpUrl, 260),
      impact: trimString((rule && rule.impact) || (node && node.impact), 20),
      selector: trimString((node && (node.primarySelector || node.selector)) || '', 220),
      htmlSnippet: trimMultiline(node && node.html, 900),
      failureSummary: trimMultiline(node && node.failureSummary, 500),
      checks: pickRelevantChecks(node || {}),
    };
  }

  const LANG_NAMES = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese' };

  function buildPromptMessages(request, lang) {
    const payload = {
      ruleId: request.ruleId || 'unknown',
      help: request.help || '',
      description: request.description || '',
      impact: request.impact || '',
      selector: request.selector || '',
      htmlSnippet: request.htmlSnippet || '',
      failureSummary: request.failureSummary || '',
      checks: Array.isArray(request.checks) ? request.checks : [],
    };

    const langName = (lang && LANG_NAMES[lang]) || 'English';
    const langInstruction = langName !== 'English'
      ? `Write all text fields (shortExplanation, userImpact, recommendedFix, warnings) in ${langName}. Keep codeExample in the original programming language without translation.`
      : '';

    const systemPrompt = [
      'You are an accessibility remediation assistant for axe-core findings.',
      'Use only the provided finding payload.',
      'Prefer minimal, valid fixes.',
      'Do not invent DOM outside the snippet.',
      'Return JSON only with this exact shape:',
      '{"shortExplanation":"","userImpact":"","recommendedFix":"","codeExample":"","confidence":"low|medium|high","warnings":[]}',
      'warnings must be an array of short strings.',
      'If the snippet is insufficient, explain the limitation in warnings and still provide the safest concrete fix guidance.',
      langInstruction,
    ].filter(Boolean).join(' ');

    const userPrompt = [
      'Generate an accessibility fix suggestion for this finding payload.',
      'Keep it concise and implementation-ready.',
      'Payload:',
      JSON.stringify(payload, null, 2),
    ].join('\n');

    return { systemPrompt, userPrompt };
  }

  function stripCodeFence(text) {
    const trimmed = String(text || '').trim();
    const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fencedMatch ? fencedMatch[1].trim() : trimmed;
  }

  function extractJsonBlock(text) {
    const stripped = stripCodeFence(text);
    if (!stripped) return '';

    const firstBrace = stripped.indexOf('{');
    const lastBrace = stripped.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return stripped.slice(firstBrace, lastBrace + 1);
    }

    return '';
  }

  function extractCodeBlock(text) {
    const match = String(text || '').match(/```(?:\w+)?\n([\s\S]*?)```/);
    return match ? trimMultiline(match[1], 1600) : '';
  }

  function parseMarkdownSections(text) {
    const source = stripCodeFence(text);
    const lines = source.split(/\n+/);
    const sections = {};
    let currentKey = '';

    lines.forEach((line) => {
      const normalized = line.trim();
      const match = normalized.match(/^(short explanation|user impact|recommended fix|code example|confidence|warnings)\s*:\s*(.*)$/i);
      if (match) {
        currentKey = match[1].toLowerCase().replace(/\s+/g, '');
        sections[currentKey] = match[2] ? [match[2]] : [];
        return;
      }
      if (currentKey) {
        if (!sections[currentKey]) sections[currentKey] = [];
        sections[currentKey].push(normalized);
      }
    });

    return sections;
  }

  function normalizeAIResult(input, rawText) {
    const source = input && typeof input === 'object' ? input : {};
    const warnings = Array.isArray(source.warnings)
      ? source.warnings.map((warning) => trimString(warning, 160)).filter(Boolean)
      : [];

    const normalized = {
      shortExplanation: trimString(source.shortExplanation, 320),
      userImpact: trimString(source.userImpact, 320),
      recommendedFix: trimMultiline(source.recommendedFix, 1200),
      codeExample: trimMultiline(source.codeExample, 2400),
      confidence: normalizeEnum(trimString(source.confidence, 20).toLowerCase(), CONFIDENCE_LEVELS, 'medium'),
      warnings,
      rawText: trimMultiline(rawText || '', 4000),
    };

    if (!normalized.codeExample) {
      normalized.codeExample = extractCodeBlock(rawText);
    }

    if (!normalized.recommendedFix && normalized.rawText) {
      normalized.recommendedFix = trimMultiline(normalized.rawText, 1200);
      if (!normalized.warnings.includes('Response was not fully structured; review before applying.')) {
        normalized.warnings.push('Response was not fully structured; review before applying.');
      }
    }

    return normalized;
  }

  function parseAIResponse(rawText) {
    const text = trimMultiline(rawText, 12000);
    const candidate = extractJsonBlock(text);

    if (candidate) {
      try {
        const parsed = JSON.parse(candidate);
        return normalizeAIResult(parsed, text);
      } catch (_) {
        // Fall through to markdown parsing.
      }
    }

    const sections = parseMarkdownSections(text);
    if (Object.keys(sections).length) {
      return normalizeAIResult({
        shortExplanation: (sections.shortexplanation || []).join(' ').trim(),
        userImpact: (sections.userimpact || []).join(' ').trim(),
        recommendedFix: (sections.recommendedfix || []).join('\n').trim(),
        codeExample: (sections.codeexample || []).join('\n').trim(),
        confidence: (sections.confidence || []).join(' ').trim(),
        warnings: (sections.warnings || []).join('\n').split(/\n|;/).map((item) => item.replace(/^[-*]\s*/, '').trim()).filter(Boolean),
      }, text);
    }

    return normalizeAIResult({}, text);
  }

  function redactSecrets(value, secrets) {
    let output = String(value || '');
    const source = secrets && typeof secrets === 'object' ? secrets : {};

    Object.values(source).forEach((secret) => {
      if (!secret) return;
      output = output.split(secret).join('[redacted]');
    });

    return output;
  }

  function normalizeChatCompletionsBaseUrl(baseUrl) {
    const value = normalizeBaseUrl(baseUrl);
    if (!value) return '';
    if (/\/chat\/completions$/i.test(value)) return value;
    return value.replace(/\/$/, '') + '/chat/completions';
  }

  global.A11yAICommon = {
    SCHEMA_VERSION,
    PROVIDERS,
    REMOTE_PROVIDERS,
    FALLBACK_MODES,
    DEFAULT_SETTINGS,
    DEFAULT_SECRETS,
    buildPromptMessages,
    createFixRequest,
    getProviderConfig,
    getProviderConfigState,
    getProviderLabel,
    getSecretKey,
    isRemoteProvider,
    maskSecret,
    mergeSettings,
    mergeSecrets,
    normalizeAIResult,
    normalizeBaseUrl,
    normalizeChatCompletionsBaseUrl,
    parseAIResponse,
    redactSecrets,
    trimMultiline,
    trimString,
    validateSettings,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);