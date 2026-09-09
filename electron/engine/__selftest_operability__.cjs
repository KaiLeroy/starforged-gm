'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const store = require('./store.cjs');
const imageStore = require('./imageStore.cjs');
const debugLog = require('./debugLog.cjs');
const { installIpcBoundary } = require('./ipcBoundary.cjs');

let passed = 0;
let total = 0;
async function check(label, fn) {
  total += 1;
  await fn();
  passed += 1;
  console.log(`  ok  - ${label}`);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starforged-p2-'));
  try {
    await check('image GC preserves shared references and removes only true orphans', () => {
      const shared = imageStore.saveImage(tmp, Buffer.from('shared'));
      const orphan = imageStore.saveImage(tmp, Buffer.from('orphan'));
      const records = [
        { state: { character: { portraitImageId: shared }, connections: [], illustrations: [], sectors: {} } },
        { state: { character: {}, connections: [{ imageId: shared }], illustrations: [], sectors: {} } },
      ];
      const result = imageStore.collectOrphanImages(tmp, records);
      assert.deepStrictEqual(result.deleted, [orphan]);
      assert.ok(fs.existsSync(imageStore.imagePath(tmp, shared)));
    });

    await check('image GC fails closed when the campaign scan is incomplete', () => {
      const id = imageStore.saveImage(tmp, Buffer.from('unknown'));
      const result = imageStore.collectOrphanImages(tmp, [], { complete: false });
      assert.deepStrictEqual(result.deleted, []);
      assert.ok(fs.existsSync(imageStore.imagePath(tmp, id)));
    });

    await check('debug logs rotate at the byte limit, expire by age, and can be cleared', () => {
      const campaignId = 'debug-test';
      const payload = { systemPrompt: ['x'.repeat(3 * 1024 * 1024)] };
      debugLog.appendDebugLog(tmp, campaignId, payload);
      debugLog.appendDebugLog(tmp, campaignId, payload);
      let status = debugLog.debugLogStatus(tmp, campaignId);
      assert.strictEqual(status.fileCount, 2);
      assert.ok(fs.statSync(debugLog.debugLogPath(tmp, campaignId)).size <= debugLog.MAX_LOG_BYTES);
      const old = Date.now() - debugLog.MAX_LOG_AGE_MS - 1000;
      fs.utimesSync(debugLog.debugLogPath(tmp, campaignId, 1), old / 1000, old / 1000);
      debugLog.appendDebugLog(tmp, campaignId, { event: 'fresh' });
      assert.strictEqual(debugLog.debugLogStatus(tmp, campaignId).fileCount, 1);
      assert.strictEqual(debugLog.clearDebugLogs(tmp, campaignId).deleted, 1);
      assert.strictEqual(debugLog.debugLogStatus(tmp, campaignId).exists, false);
    });

    await check('debug-log export includes retained rotations in chronological order', () => {
      const campaignId = 'export-test';
      fs.mkdirSync(debugLog.debugLogsDir(tmp), { recursive: true });
      fs.writeFileSync(debugLog.debugLogPath(tmp, campaignId, 1), 'older\n');
      fs.writeFileSync(debugLog.debugLogPath(tmp, campaignId), 'newer\n');
      const destination = path.join(tmp, 'export.jsonl');
      debugLog.exportDebugLogs(tmp, campaignId, destination);
      assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'older\n\nnewer\n');
    });

    await check('an injected final-rename failure leaves the previous campaign readable', () => {
      const record = { version: 1, revision: 0, state: { marker: 'old' }, messages: [] };
      store.saveCampaignRecord(tmp, 'fault-test', record);
      const originalRename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to === store.campaignPath(tmp, 'fault-test')) throw new Error('injected rename failure');
        return originalRename(from, to);
      };
      try {
        assert.throws(() => store.saveCampaignRecord(tmp, 'fault-test', { ...record, state: { marker: 'new' } }), /injected/);
      } finally {
        fs.renameSync = originalRename;
      }
      assert.strictEqual(store.loadCampaignRecord(tmp, 'fault-test').record.state.marker, 'old');
    });

    await check('IPC validation failures never reach handlers or mutation queues', async () => {
      let registered;
      let handled = 0;
      let serialized = 0;
      const ipcMain = { handle: (_channel, listener) => { registered = listener; } };
      installIpcBoundary(ipcMain, {
        validate: () => { throw new Error('bad payload'); },
        isMutating: () => true,
        serialize: async (_id, run) => { serialized += 1; return run(); },
        onMutationError: () => {},
      });
      ipcMain.handle('campaign:rename', () => { handled += 1; });
      await assert.rejects(registered({}, { campaignId: '../escape' }), /bad payload/);
      assert.strictEqual(handled, 0);
      assert.strictEqual(serialized, 0);
    });

    await check('settings parsing rejects partial numbers and enforces both UI ranges', async () => {
      const settings = await import(pathToFileURL(path.resolve('src/settingsValidation.ts')).href);
      assert.match(settings.validateSamplingSettings('1abc', '0.9').error, /Temperature/);
      assert.match(settings.validateSamplingSettings('1', '1.1').error, /Top P/);
      assert.deepStrictEqual(settings.validateSamplingSettings(' 1.25 ', ''), { temperature: 1.25, topP: null, error: null });
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed}/${total} operability checks passed.`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
