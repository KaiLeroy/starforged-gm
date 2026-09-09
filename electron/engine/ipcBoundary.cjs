'use strict';

/** Installs one validation/serialization boundary around Electron IPC registration. */
function installIpcBoundary(ipcMain, { validate, isMutating, serialize, onMutationError }) {
  const nativeHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => nativeHandle(channel, async (event, ...args) => {
    for (const arg of args) validate(channel, arg);
    const run = () => listener(event, ...args);
    if (!isMutating(channel)) return run();
    const payload = args[0];
    const campaignId = typeof payload === 'string' ? payload : (payload && payload.campaignId) || '__new_campaign__';
    try { return await serialize(campaignId, run); }
    catch (error) {
      onMutationError(campaignId, error);
      throw error;
    }
  });
}

module.exports = { installIpcBoundary };
