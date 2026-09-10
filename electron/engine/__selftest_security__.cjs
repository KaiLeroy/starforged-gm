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
const data = require('./data.cjs');

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
    assert.doesNotThrow(() => validation.validateIpcPayload('campaign:new', { character: { name: 'Nova', callsign: '', pronouns: '', description: '', stats: { edge: 3, heart: 2, iron: 2, shadow: 1, wits: 1 } }, startingAssetIds: ['one', 'two', 'three'] }));
  });

  await check('campaign and character imports enforce structure, versions, and bounds', () => {
    assert.throws(() => validation.assertCampaignRecord({ state: {}, messages: [] }), /character/i);
    assert.throws(() => validation.assertCharacterExport({ kind: 'starforged-character-export', version: 99, character: {} }), /version/i);
    const campaign = { state: state.newCampaignState(), messages: [], pendingChoice: null };
    validation.assertCampaignRecord(campaign);
  });

  await check('v1 campaign fixtures migrate completely to canonical v2 before validation', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'campaign-import-v1.json'), 'utf8'));
    const migrated = validation.assertCampaignRecord(fixture);
    assert.strictEqual(migrated.version, 2);
    assert.strictEqual(migrated.state.version, 2);
    assert.deepStrictEqual(migrated.state.progressTracks.slice(0, 3).map((track) => track.id).sort(), ['legacy-bonds', 'legacy-discoveries', 'legacy-quests']);
    assert.deepStrictEqual(migrated.state.campaignElements[0], { id: 'element-old', category: 'Other', name: 'The Silent Armada', description: '' });
    assert.strictEqual(migrated.state.sectors['sector-old'].cells['0,0'].imageId, null);
    assert.deepStrictEqual(migrated.state.sectors['sector-old'].passages, []);
    assert.ok(!('provider_metadata' in migrated.messages[0]));
    assert.ok(!('reasoning' in migrated.messages[1]));
    assert.strictEqual(fixture.version, 1, 'migration must not mutate the caller\'s parsed object');
    fixture.revision = 27;
    assert.strictEqual(validation.assertCampaignRecord(fixture, { resetRevision: true }).revision, 0, 'an imported copy starts a new revision history');
  });

  await check('current campaign schema rejects missing, unknown, and malformed nested fields', () => {
    const makeRecord = () => ({ version: 2, revision: 0, state: state.newCampaignState(), messages: [], pendingChoice: null });
    const missing = makeRecord(); delete missing.state.log;
    assert.throws(() => validation.assertCampaignRecord(missing), /state\.log.*required/i);
    const unknown = makeRecord(); unknown.state.unversionedJunk = true;
    assert.throws(() => validation.assertCampaignRecord(unknown), /not supported.*schema v2/i);
    const feature = makeRecord(); feature.state.sectors['sector-1'].cells['0,0'] = { name: '', notes: '', imageId: null, features: [{ id: 'f1', type: 'not-real', name: '', description: '' }] };
    assert.throws(() => validation.assertCampaignRecord(feature), /features\[0\]\.type/i);
    const meter = makeRecord(); meter.state.character.meters.health = 6;
    assert.throws(() => validation.assertCampaignRecord(meter), /meters\.health/i);
  });

  await check('campaign schema validates every persisted cross-reference', () => {
    const makeRecord = () => ({ version: 2, revision: 0, state: state.newCampaignState(), messages: [], pendingChoice: null });
    const currentSector = makeRecord(); currentSector.state.currentSectorId = 'missing';
    assert.throws(() => validation.assertCampaignRecord(currentSector), /currentSectorId references a missing sector/i);
    const passage = makeRecord(); passage.state.sectors['sector-1'].passages.push({ id: 'p1', fromCell: '0,0', toCell: null, notes: '', toSectorId: null });
    assert.throws(() => validation.assertCampaignRecord(passage), /fromCell references a missing cell/i);
    const scene = makeRecord(); scene.state.progressTracks.push({ id: 'scene', name: 'Escape', type: 'scene_challenge', rank: 'dangerous', ticks: 0, linkedClockId: 'missing' });
    assert.throws(() => validation.assertCampaignRecord(scene), /reciprocally linked clock/i);
    const vehicle = makeRecord(); vehicle.state.character.aboardVehicleId = 'missing';
    assert.throws(() => validation.assertCampaignRecord(vehicle), /asset the character does not own/i);
    const roll = makeRecord();
    const result = { outcome: 'weak_hit', is_match: false };
    state.recordRoll(roll.state, { kind: 'progress', moveName: 'Fulfill Your Vow', trackId: 'missing', progressScore: 5, challengeDice: [3, 8], outcome: result.outcome, isMatch: result.is_match });
    assert.throws(() => validation.assertCampaignRecord(roll), /trackId references a missing track/i);
  });

  await check('roll-ledger imports recompute outcomes and reject forged modifier entitlements', () => {
    const record = { version: 2, revision: 0, state: state.newCampaignState(), messages: [], pendingChoice: null };
    const artist = data.findAsset('Artist');
    state.addAsset(record.state, { id: artist.$id, name: artist.Name, category: (artist['Asset Type'] || '').split('/').pop() });
    const rollId = state.recordRoll(record.state, { kind: 'action', moveName: 'Face Danger', stat: 'edge', statValue: 1, valueSource: 'character', adds: 0, actionDie: 4, momentum: 2, negativeMomentumApplied: false, actionDieMode: 'normal', actionScore: 5, challengeDice: [3, 8], outcome: 'weak_hit', isMatch: false });
    assert.strictEqual(validation.assertCampaignRecord(record).state.rollLedger.order[0], rollId);
    const entitlement = Object.values(record.state.rollLedger.entries[rollId].modifierEntitlements)[0];
    entitlement.modifier = 'roll_bonus_challenge_dice';
    assert.throws(() => validation.assertCampaignRecord(record), /not authorized by its owned, unlocked source ability/i);
    entitlement.modifier = 'reroll_action_die';
    record.state.rollLedger.entries[rollId].currentOutcome = 'strong_hit';
    assert.throws(() => validation.assertCampaignRecord(record), /current outcome does not match/i);
  });

  await check('message/tool-call graph and pending choices are validated as one transcript', () => {
    const makeRecord = () => ({ version: 2, revision: 0, state: state.newCampaignState(), messages: [], pendingChoice: null });
    const danglingTool = makeRecord(); danglingTool.messages.push({ role: 'tool', tool_call_id: 'call-1', content: '{}' });
    assert.throws(() => validation.assertCampaignRecord(danglingTool), /no earlier assistant tool call/i);
    const pending = makeRecord();
    pending.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call-choice', type: 'function', function: { name: 'present_choice', arguments: '{"prompt":"Choose","options":[{"label":"A"}],"allow_custom":false}' } }] });
    pending.pendingChoice = { toolCallId: 'call-choice', prompt: 'Choose', options: [{ label: 'A' }], allowCustom: false };
    assert.strictEqual(validation.assertCampaignRecord(pending).pendingChoice.toolCallId, 'call-choice');
    pending.messages.push({ role: 'tool', tool_call_id: 'call-choice', content: '{}' });
    assert.throws(() => validation.assertCampaignRecord(pending), /pendingChoice must reference one unresolved/i);
  });

  await check('character exports migrate v1 and enforce the full v2 character shape', () => {
    const migrated = validation.assertCharacterExport({ kind: 'starforged-character-export', version: 1, character: { name: 'Old Hand', stats: { edge: 3, heart: 2, iron: 2, shadow: 1, wits: 1 } } });
    assert.strictEqual(migrated.version, 2);
    assert.deepStrictEqual(migrated.character.assets, []);
    const current = { kind: 'starforged-character-export', version: 2, character: state.newCampaignState().character, truths: {}, backgroundVow: null };
    delete current.character.impacts;
    assert.throws(() => validation.assertCharacterExport(current), /character\.impacts.*required/i);
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
