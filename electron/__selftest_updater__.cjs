'use strict';
/**
 * Tests for updater.cjs. setup() takes ipcMain/isDev/getMainWindow/app/autoUpdater as plain
 * parameters rather than importing electron (or electron-updater) itself, specifically so this
 * is testable with fakes instead of a real Electron process. electron-updater's real autoUpdater
 * is a lazily-instantiated singleton that throws on first property access outside a genuine,
 * running Electron app -- there's no safe way to require it directly in a plain node test run,
 * which is exactly why setup() accepts an injectable override in its place. The "packaged mode"
 * tests below supply a minimal EventEmitter-based fake instead, and check the module's own
 * event-forwarding logic against it directly, never touching the real library at all.
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const updater = require('./updater.cjs');

let passed = 0;
let total = 0;
async function check(label, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${label}`);
  } catch (err) {
    console.error(`FAIL  - ${label}\n        ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

/** A minimal fake of the slice of ipcMain this module actually uses -- records handlers by
 *  channel name so a test can invoke them directly without a real IPC transport. */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`No handler registered for "${channel}"`);
      return fn(null, ...args);
    },
    has: (channel) => handlers.has(channel),
  };
}

function fakeApp(version) {
  return { getVersion: () => version };
}

function fakeWindow() {
  const sent = [];
  return {
    win: {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    },
    sent,
  };
}

/** A minimal, genuinely-safe-to-instantiate stand-in for electron-updater's real autoUpdater --
 *  just enough surface (an EventEmitter plus the three methods this module actually calls) to
 *  exercise setup()'s own wiring logic, with no dependency on a real Electron process at all. */
function fakeAutoUpdater() {
  const emitter = new EventEmitter();
  emitter.autoDownload = true; // deliberately starts true, so the "gets turned off" assertion is real
  emitter.autoInstallOnAppQuit = true;
  emitter.checkForUpdates = async () => {};
  emitter.downloadUpdate = async () => {};
  emitter.quitAndInstall = () => {};
  return emitter;
}

(async () => {
  console.log('updater.setup -- development mode');

  await check('registers all four IPC handlers even in dev mode, so the renderer never sees a missing handler', () => {
    const ipc = fakeIpcMain();
    updater.setup({ ipcMain: ipc, isDev: true, getMainWindow: () => null, app: fakeApp('0.1.0') });
    assert.ok(ipc.has('updater:check'));
    assert.ok(ipc.has('updater:download'));
    assert.ok(ipc.has('updater:install'));
    assert.ok(ipc.has('updater:get-version'));
  });

  await check('check/download/install all report a clean, honest "unavailable" status in dev mode, not a thrown error or silent no-op', async () => {
    const ipc = fakeIpcMain();
    updater.setup({ ipcMain: ipc, isDev: true, getMainWindow: () => null, app: fakeApp('0.1.0') });
    for (const channel of ['updater:check', 'updater:download', 'updater:install']) {
      const result = await ipc.invoke(channel);
      assert.strictEqual(result.status, 'unavailable');
      assert.ok(/development/i.test(result.message), `expected a development-mode message for ${channel}, got: ${result.message}`);
    }
  });

  await check('get-version works in dev mode too, and returns the real app version untouched', async () => {
    const ipc = fakeIpcMain();
    updater.setup({ ipcMain: ipc, isDev: true, getMainWindow: () => null, app: fakeApp('1.2.3') });
    const version = await ipc.invoke('updater:get-version');
    assert.strictEqual(version, '1.2.3');
  });

  await check('dev mode never even attempts to touch electron-updater -- an override is ignored entirely when isDev is true, confirming the dev guard runs first', async () => {
    const ipc = fakeIpcMain();
    const fake = fakeAutoUpdater();
    updater.setup({ ipcMain: ipc, isDev: true, getMainWindow: () => null, app: fakeApp('0.1.0'), autoUpdater: fake });
    const result = await ipc.invoke('updater:check');
    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(fake.listenerCount('checking-for-update'), 0, 'no listeners should have been attached to the override in dev mode');
  });

  console.log('\nupdater.setup -- packaged mode (against an injected fake autoUpdater, never the real electron-updater library)');

  await check('registers all four IPC handlers in packaged mode too', () => {
    const ipc = fakeIpcMain();
    updater.setup({ ipcMain: ipc, isDev: false, getMainWindow: () => null, app: fakeApp('0.1.0'), autoUpdater: fakeAutoUpdater() });
    assert.ok(ipc.has('updater:check'));
    assert.ok(ipc.has('updater:download'));
    assert.ok(ipc.has('updater:install'));
    assert.ok(ipc.has('updater:get-version'));
  });

  await check('autoDownload and autoInstallOnAppQuit are both explicitly turned off -- nothing downloads or installs without a real user action from the UI', () => {
    const ipc = fakeIpcMain();
    const fake = fakeAutoUpdater();
    assert.strictEqual(fake.autoDownload, true, 'the fake must start true so turning it off is a real, observed change, not just an unset default');
    updater.setup({ ipcMain: ipc, isDev: false, getMainWindow: () => null, app: fakeApp('0.1.0'), autoUpdater: fake });
    assert.strictEqual(fake.autoDownload, false);
    assert.strictEqual(fake.autoInstallOnAppQuit, false);
  });

  await check('every real autoUpdater event forwards to the renderer as a correctly-shaped updater:status message', () => {
    const ipc = fakeIpcMain();
    const { win, sent } = fakeWindow();
    const fake = fakeAutoUpdater();
    updater.setup({ ipcMain: ipc, isDev: false, getMainWindow: () => win, app: fakeApp('0.1.0'), autoUpdater: fake });

    fake.emit('checking-for-update');
    fake.emit('update-available', { version: '9.9.9' });
    fake.emit('update-not-available', { version: '0.1.0' });
    fake.emit('download-progress', { percent: 42.7 });
    fake.emit('update-downloaded', { version: '9.9.9' });
    fake.emit('error', new Error('feed not found'));

    const statuses = sent.filter((s) => s.channel === 'updater:status').map((s) => s.payload);
    assert.deepStrictEqual(statuses[0], { status: 'checking' });
    assert.deepStrictEqual(statuses[1], { status: 'available', version: '9.9.9', releaseNotes: null });
    assert.deepStrictEqual(statuses[2], { status: 'not-available', version: '0.1.0' });
    assert.deepStrictEqual(statuses[3], { status: 'downloading', percent: 43 });
    assert.deepStrictEqual(statuses[4], { status: 'downloaded', version: '9.9.9' });
    assert.deepStrictEqual(statuses[5], { status: 'error', message: 'feed not found' });
  });

  await check('a destroyed window is never sent to, rather than throwing on a stale webContents reference', () => {
    const ipc = fakeIpcMain();
    const fake = fakeAutoUpdater();
    const destroyedWin = { isDestroyed: () => true, webContents: { send: () => { throw new Error('should never be called'); } } };
    updater.setup({ ipcMain: ipc, isDev: false, getMainWindow: () => destroyedWin, app: fakeApp('0.1.0'), autoUpdater: fake });
    assert.doesNotThrow(() => fake.emit('checking-for-update'));
  });

  await check('updater:check/download genuinely call through to the fake autoUpdater\'s real methods and report ok, and a thrown error from those methods is caught and reported rather than propagating', async () => {
    const ipc = fakeIpcMain();
    let checkCalled = false;
    let downloadCalled = false;
    const fake = fakeAutoUpdater();
    fake.checkForUpdates = async () => { checkCalled = true; };
    fake.downloadUpdate = async () => { downloadCalled = true; };
    updater.setup({ ipcMain: ipc, isDev: false, getMainWindow: () => null, app: fakeApp('0.1.0'), autoUpdater: fake });

    const checkResult = await ipc.invoke('updater:check');
    assert.strictEqual(checkCalled, true);
    assert.strictEqual(checkResult.status, 'ok');

    const downloadResult = await ipc.invoke('updater:download');
    assert.strictEqual(downloadCalled, true);
    assert.strictEqual(downloadResult.status, 'ok');

    const failing = fakeAutoUpdater();
    failing.checkForUpdates = async () => { throw new Error('network unreachable'); };
    const ipc2 = fakeIpcMain();
    updater.setup({ ipcMain: ipc2, isDev: false, getMainWindow: () => null, app: fakeApp('0.1.0'), autoUpdater: failing });
    const errorResult = await ipc2.invoke('updater:check');
    assert.strictEqual(errorResult.status, 'error');
    assert.strictEqual(errorResult.message, 'network unreachable');
  });

  await check('updater:install genuinely calls quitAndInstall on the real autoUpdater instance', async () => {
    const ipc = fakeIpcMain();
    let installCalled = false;
    const fake = fakeAutoUpdater();
    fake.quitAndInstall = () => { installCalled = true; };
    updater.setup({ ipcMain: ipc, isDev: false, getMainWindow: () => null, app: fakeApp('0.1.0'), autoUpdater: fake });
    await ipc.invoke('updater:install');
    assert.strictEqual(installCalled, true);
  });

  await check('falls back to the same "unavailable" status as dev mode when no override is given and electron-updater genuinely cannot be loaded in this environment -- the real-world behavior this whole design exists to guarantee', async () => {
    const ipc = fakeIpcMain();
    updater.setup({ ipcMain: ipc, isDev: false, getMainWindow: () => null, app: fakeApp('0.1.0') });
    const result = await ipc.invoke('updater:check');
    assert.strictEqual(result.status, 'unavailable');
    assert.ok(/electron-updater is not available/i.test(result.message));
  });

  console.log(`\n${passed}/${total} checks passed.`);
  if (passed !== total) process.exit(1);
})();
