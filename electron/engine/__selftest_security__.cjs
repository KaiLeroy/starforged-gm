'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store.cjs');
const validation = require('./validation.cjs');
const credentials = require('./credentials.cjs');
const network = require('./network.cjs');
const state = require('./state.cjs');

let passed = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (error) { console.error(`FAIL  - ${name}\n        ${error.stack || error.message}`); process.exitCode = 1; }
}

(async () => {
  await check('campaign and image identifiers cannot escape their storage directories', () => {
    assert.throws(() => validation.assertCampaignId('../outside'), /valid campaign id/i);
    assert.throws(() => validation.assertCampaignId('a/b'), /valid campaign id/i);
    assert.throws(() => validation.assertImageId('../secret'), /valid image id/i);
  });

  await check('IPC validation rejects oversized, prototype-bearing, and invalid config payloads', () => {
    assert.throws(() => validation.validateIpcPayload('chat:send', { campaignId: 'default', text: 'x'.repeat(300000) }), /oversized|string/i);
    assert.throws(() => validation.validateIpcPayload('config:set', { model: '', comfyUrl: '', comfyWorkflow: '', temperature: 3, topP: null, moveChoiceThreshold: 'likely', debugLogging: false }), /model|temperature/i);
    const polluted = Object.create({ inherited: true });
    polluted.campaignId = 'default';
    assert.throws(() => validation.validateIpcPayload('chat:send', polluted), /must be an object/i);
  });

  await check('campaign and character imports enforce structure, versions, and bounds', () => {
    assert.throws(() => validation.assertCampaignRecord({ state: {}, messages: [] }), /character/i);
    assert.throws(() => validation.assertCharacterExport({ kind: 'starforged-character-export', version: 99, character: {} }), /version/i);
    const campaign = { state: state.newCampaignState(), messages: [], pendingChoice: null };
    validation.assertCampaignRecord(campaign);
  });

  await check('API keys migrate to encrypted storage and are redacted from renderer config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgm-credentials-'));
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(`sealed:${text}`),
      decryptString: (buffer) => buffer.toString().replace(/^sealed:/, ''),
    };
    try {
      store.saveConfig(dir, { apiKey: 'secret', model: 'm' });
      const publicValue = credentials.publicConfig(store, dir, fakeSafeStorage);
      assert.strictEqual(publicValue.apiKey, '');
      assert.strictEqual(publicValue.hasApiKey, true);
      const disk = JSON.parse(fs.readFileSync(store.configPath(dir), 'utf8'));
      assert.ok(disk.apiKeyCiphertext);
      assert.ok(!('apiKey' in disk));
      assert.strictEqual(credentials.runtimeConfig(store, dir, fakeSafeStorage).apiKey, 'secret');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await check('API keys are never written through Electron basic_text fallback storage', () => {
    const unsafeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'basic_text',
      encryptString: () => Buffer.from('plaintext'),
    };
    assert.throws(() => credentials.encryptApiKey(unsafeStorage, 'secret'), /unavailable/i);
  });

  await check('revision-aware campaign saves reject stale writers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfgm-revision-'));
    try {
      const first = { revision: 0, state: state.newCampaignState(), messages: [] };
      store.saveCampaignRecord(dir, 'campaign-test', first, { expectedRevision: 0 });
      assert.strictEqual(first.revision, 1);
      const stale = { revision: 0, state: state.newCampaignState(), messages: [] };
      assert.throws(() => store.saveCampaignRecord(dir, 'campaign-test', stale, { expectedRevision: 0 }), /changed on disk/i);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await check('bounded response reader rejects declared and actual oversized bodies', async () => {
    await assert.rejects(() => network.readResponseBuffer({ headers: { get: () => '100' }, arrayBuffer: async () => Buffer.alloc(1) }, 10), /exceeds/i);
    await assert.rejects(() => network.readResponseBuffer({ headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(11) }, 10), /exceeds/i);
  });

  await check('network deadlines abort a stalled request', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    try {
      await assert.rejects(() => network.fetchWithTimeout('https://example.invalid', {}, { timeoutMs: 5 }), /timed out/i);
    } finally { global.fetch = originalFetch; }
  });

  console.log(`\n${passed}/${total} security checks passed.`);
  if (passed !== total) process.exitCode = 1;
})();
