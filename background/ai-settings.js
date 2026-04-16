(function (global) {
  'use strict';

  const Common = global.A11yAICommon;
  const SETTINGS_KEY = 'ai_settings_v1';
  const SECRETS_KEY = 'ai_secrets_v1';

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(keys, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  function storageSet(value) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(value, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  async function readStoredConfig() {
    const data = await storageGet([SETTINGS_KEY, SECRETS_KEY]);
    const settings = Common.mergeSettings(data[SETTINGS_KEY]);
    const secrets = Common.mergeSecrets(data[SECRETS_KEY]);

    const currentSettings = JSON.stringify(settings);
    const storedSettings = JSON.stringify(data[SETTINGS_KEY] || {});
    const currentSecrets = JSON.stringify(secrets);
    const storedSecrets = JSON.stringify(data[SECRETS_KEY] || {});

    if (currentSettings !== storedSettings || currentSecrets !== storedSecrets) {
      await storageSet({
        [SETTINGS_KEY]: settings,
        [SECRETS_KEY]: secrets,
      });
    }

    return { settings, secrets };
  }

  async function writeStoredConfig(settings, secrets) {
    await storageSet({
      [SETTINGS_KEY]: settings,
      [SECRETS_KEY]: secrets,
    });
    return { settings, secrets };
  }

  function buildPublicSettings(settings, secrets) {
    const providers = {};

    Common.PROVIDERS.forEach((providerId) => {
      const provider = Common.getProviderConfig(settings, providerId);
      const providerState = Common.getProviderConfigState(providerId, settings, secrets);
      providers[providerId] = {
        model: provider.model || '',
        baseUrl: provider.baseUrl || '',
        hasApiKey: providerState.hasApiKey,
        maskedApiKey: providerState.maskedApiKey,
        configured: providerState.configured,
        missing: providerState.missing || [],
        reason: providerState.reason,
      };
    });

    return {
      version: settings.version,
      enabled: settings.enabled,
      selectedProvider: settings.selectedProvider,
      fallbackMode: settings.fallbackMode,
      timeoutMs: settings.timeoutMs,
      providers,
    };
  }

  function withDraftConfig(stored, draft) {
    const settings = Common.mergeSettings(draft && draft.settings ? {
      ...stored.settings,
      ...draft.settings,
      providers: {
        ...stored.settings.providers,
        ...(draft.settings.providers || {}),
      },
    } : stored.settings);

    const secrets = Common.mergeSecrets({
      ...stored.secrets,
      ...((draft && draft.secrets) || {}),
    });

    return { settings, secrets };
  }

  async function saveConfig(draft) {
    const stored = await readStoredConfig();
    const merged = withDraftConfig(stored, draft);
    const errors = Common.validateSettings(merged.settings, merged.secrets);

    if (errors.length) {
      const error = new Error(errors[0].message);
      error.code = 'validation-error';
      error.details = errors;
      throw error;
    }

    await writeStoredConfig(merged.settings, merged.secrets);
    return buildPublicSettings(merged.settings, merged.secrets);
  }

  async function clearSecret(providerId) {
    const stored = await readStoredConfig();
    const secretKey = Common.getSecretKey(providerId);
    if (!secretKey) {
      return buildPublicSettings(stored.settings, stored.secrets);
    }

    const secrets = Common.mergeSecrets({
      ...stored.secrets,
      [secretKey]: '',
    });

    await writeStoredConfig(stored.settings, secrets);
    return buildPublicSettings(stored.settings, secrets);
  }

  global.A11yAISettingsStore = {
    buildPublicSettings,
    clearSecret,
    readStoredConfig,
    saveConfig,
    withDraftConfig,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);