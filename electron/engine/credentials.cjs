'use strict';

const CIPHERTEXT_KEY = 'apiKeyCiphertext';

function encryptApiKey(safeStorage, apiKey) {
  const insecureBackend = safeStorage?.getSelectedStorageBackend?.() === 'basic_text';
  if (!safeStorage || !safeStorage.isEncryptionAvailable() || insecureBackend) {
    throw new Error('Secure credential storage is unavailable on this system; the API key was not saved.');
  }
  return safeStorage.encryptString(apiKey).toString('base64');
}

function decryptApiKey(safeStorage, ciphertext) {
  if (!ciphertext) return '';
  const insecureBackend = safeStorage?.getSelectedStorageBackend?.() === 'basic_text';
  if (!safeStorage || !safeStorage.isEncryptionAvailable() || insecureBackend) {
    throw new Error('Secure credential storage is unavailable, so the saved API key cannot be read.');
  }
  return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
}

function runtimeConfig(store, userDataDir, safeStorage) {
  const persisted = store.loadConfig(userDataDir);
  let apiKey = '';
  if (persisted[CIPHERTEXT_KEY]) apiKey = decryptApiKey(safeStorage, persisted[CIPHERTEXT_KEY]);
  else if (persisted.apiKey) {
    // One-time migration from releases that stored the key as plaintext.
    apiKey = persisted.apiKey;
    const migrated = { ...persisted, [CIPHERTEXT_KEY]: encryptApiKey(safeStorage, apiKey) };
    delete migrated.apiKey;
    store.saveConfig(userDataDir, migrated);
  }
  return { ...persisted, apiKey };
}

function publicConfig(store, userDataDir, safeStorage) {
  const runtime = runtimeConfig(store, userDataDir, safeStorage);
  const { apiKey, [CIPHERTEXT_KEY]: _ciphertext, ...config } = runtime;
  return { ...config, apiKey: '', hasApiKey: Boolean(apiKey) };
}

function savePublicConfig(store, userDataDir, safeStorage, incoming) {
  const current = store.loadConfig(userDataDir);
  const saved = { ...incoming };
  delete saved.hasApiKey;
  delete saved.clearApiKey;
  if (incoming.clearApiKey) delete saved[CIPHERTEXT_KEY];
  else if (incoming.apiKey && incoming.apiKey.trim()) saved[CIPHERTEXT_KEY] = encryptApiKey(safeStorage, incoming.apiKey.trim());
  else if (current[CIPHERTEXT_KEY]) saved[CIPHERTEXT_KEY] = current[CIPHERTEXT_KEY];
  else if (current.apiKey) saved[CIPHERTEXT_KEY] = encryptApiKey(safeStorage, current.apiKey);
  delete saved.apiKey;
  store.saveConfig(userDataDir, saved);
  return publicConfig(store, userDataDir, safeStorage);
}

module.exports = { encryptApiKey, decryptApiKey, runtimeConfig, publicConfig, savePublicConfig, CIPHERTEXT_KEY };
