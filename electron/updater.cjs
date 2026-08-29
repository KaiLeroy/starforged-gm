/**
 * Auto-update wiring, built around electron-updater and GitHub Releases as the publish target
 * (see package.json's build.publish -- the owner/repo there are placeholders until a real repo
 * exists to publish releases to; nothing here breaks if they're never filled in, checks just
 * fail cleanly with a real error surfaced to the UI rather than a silent no-op).
 *
 * Deliberately conservative for a personal desktop app: autoDownload and autoInstallOnAppQuit
 * are both off. A check finding an update doesn't download anything on its own, and a completed
 * download doesn't install itself on next quit -- both are explicit user actions from the
 * Settings UI, not something that happens in the background without the user asking for it.
 *
 * Only meaningful in a packaged build. electron-updater expects real release metadata
 * (latest.yml) next to a real installed app; running it against a dev checkout has nothing to
 * check against and will only ever error. setup() is a genuine no-op when isDev is true --
 * doesn't register IPC handlers named differently, just doesn't wire the feature up at all, so
 * a renderer calling window.updater.check() in dev mode gets a clean, honest "not available in
 * development" response rather than a mysterious failure.
 *
 * electron-updater's own autoUpdater is a lazily-instantiated singleton that throws immediately
 * on first property access outside a real, running Electron app (it reaches for electron's own
 * app.getVersion() as soon as it's touched, not just once actually used) -- requiring it at this
 * module's top level, or even in a plain try/catch around a destructure, isn't enough to make
 * this module safely loadable from a test runner. Requiring it lazily inside setup() itself, and
 * accepting an optional override in its place, keeps the real app's behavior identical (it never
 * passes an override, so it always gets the real thing) while letting tests supply a plain
 * EventEmitter-based fake instead -- the only way to actually exercise the event-forwarding
 * logic below without a real Electron process.
 */

function setup({ ipcMain, isDev, getMainWindow, app, autoUpdater: autoUpdaterOverride }) {
  const send = (status) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('updater:status', status);
  };

  let autoUpdater = autoUpdaterOverride || null;
  if (!autoUpdater && !isDev) {
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch {
      // Not installed, or genuinely unavailable in this environment -- falls through to the
      // "unavailable" branch below the same as the isDev case, rather than throwing.
    }
  }

  if (isDev || !autoUpdater) {
    const reason = isDev ? 'Auto-update is only available in a packaged build, not this development session.' : 'electron-updater is not available in this build.';
    ipcMain.handle('updater:check', () => ({ status: 'unavailable', message: reason }));
    ipcMain.handle('updater:download', () => ({ status: 'unavailable', message: reason }));
    ipcMain.handle('updater:install', () => ({ status: 'unavailable', message: reason }));
    ipcMain.handle('updater:get-version', () => app.getVersion());
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // Guards against listener buildup if setup() were ever accidentally called more than once
  // (it isn't, in main.cjs's own single call from app.whenReady() -- this is defensive, not a
  // fix for an existing real bug) -- this module owns all of autoUpdater's event handling
  // exclusively, so clearing everything first is safe rather than selectively removing.
  autoUpdater.removeAllListeners();

  autoUpdater.on('checking-for-update', () => send({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ status: 'available', version: info.version, releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null }));
  autoUpdater.on('update-not-available', (info) => send({ status: 'not-available', version: info.version }));
  autoUpdater.on('download-progress', (progress) => send({ status: 'downloading', percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', (info) => send({ status: 'downloaded', version: info.version }));
  // electron-updater's own error event fires for network failures, a missing/unpublished feed,
  // and genuine update-package problems alike -- surfaced as-is rather than guessing which case
  // applied, since the message text itself is usually the most useful signal for a personal app
  // with no support team to interpret a coded error for the user.
  autoUpdater.on('error', (err) => send({ status: 'error', message: err && err.message ? err.message : String(err) }));

  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdates();
      return { status: 'ok' };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { status: 'ok' };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('updater:install', () => {
    // quitAndInstall itself tears the app down -- nothing meaningful to return to the renderer
    // after this call succeeds, since the process is on its way out.
    autoUpdater.quitAndInstall();
    return { status: 'ok' };
  });

  ipcMain.handle('updater:get-version', () => app.getVersion());
}

module.exports = { setup };
