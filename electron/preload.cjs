'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('game', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (config) => ipcRenderer.invoke('config:set', config),
  getDefaultNarrativeRules: () => ipcRenderer.invoke('config:get-default-narrative-rules'),

  listCampaigns: () => ipcRenderer.invoke('campaign:list'),
  getCampaignSummaries: () => ipcRenderer.invoke('campaign:summaries'),
  getCampaign: (campaignId) => ipcRenderer.invoke('campaign:get', campaignId),
  deleteCampaign: (campaignId) => ipcRenderer.invoke('campaign:delete', campaignId),
  renameCampaign: (payload) => ipcRenderer.invoke('campaign:rename', payload),
  duplicateCampaign: (payload) => ipcRenderer.invoke('campaign:duplicate', payload),
  exportCampaign: (payload) => ipcRenderer.invoke('campaign:export', payload),
  exportCampaignStory: (payload) => ipcRenderer.invoke('campaign:export-story', payload),
  openExternalLink: (url) => ipcRenderer.invoke('shell:open-external', url),
  revealDebugLog: (campaignId) => ipcRenderer.invoke('debugLog:reveal', { campaignId }),
  importCampaign: () => ipcRenderer.invoke('campaign:import'),
  exportCharacter: (payload) => ipcRenderer.invoke('character:export', payload),
  importCharacter: () => ipcRenderer.invoke('character:import'),
  applyImportedCharacter: (payload) => ipcRenderer.invoke('campaign:apply_imported_character', payload),
  newCampaign: (payload) => ipcRenderer.invoke('campaign:new', payload),
  getStartingAssets: () => ipcRenderer.invoke('assets:starting'),
  getAssetCatalog: () => ipcRenderer.invoke('assets:catalog'),
  getMoves: () => ipcRenderer.invoke('moves:list'),
  getOracles: () => ipcRenderer.invoke('oracles:list'),
  rollOracle: (payload) => ipcRenderer.invoke('oracles:roll', payload),

  updateSectorCell: (payload) => ipcRenderer.invoke('sector:update-cell', payload),
  addSectorFeature: (payload) => ipcRenderer.invoke('sector:add-feature', payload),
  removeSectorFeature: (payload) => ipcRenderer.invoke('sector:remove-feature', payload),
  setSectorCurrent: (payload) => ipcRenderer.invoke('sector:set-current', payload),
  setSectorInfo: (payload) => ipcRenderer.invoke('sector:set-info', payload),
  createPassage: (payload) => ipcRenderer.invoke('sector:create-passage', payload),
  removePassage: (payload) => ipcRenderer.invoke('sector:remove-passage', payload),
  linkPassage: (payload) => ipcRenderer.invoke('sector:link-passage', payload),
  createSector: (payload) => ipcRenderer.invoke('sector:create', payload),
  switchSector: (payload) => ipcRenderer.invoke('sector:switch', payload),

  getTruthsCatalog: () => ipcRenderer.invoke('truths:catalog'),
  rollTruth: (payload) => ipcRenderer.invoke('truths:roll', payload),
  chooseTruth: (payload) => ipcRenderer.invoke('truths:choose', payload),
  clearTruth: (payload) => ipcRenderer.invoke('truths:clear', payload),

  addConnection: (payload) => ipcRenderer.invoke('connections:add', payload),
  updateConnection: (payload) => ipcRenderer.invoke('connections:update', payload),
  removeConnection: (payload) => ipcRenderer.invoke('connections:remove', payload),

  addLogEntry: (payload) => ipcRenderer.invoke('log:add', payload),

  createClock: (payload) => ipcRenderer.invoke('clocks:create', payload),
  advanceClock: (payload) => ipcRenderer.invoke('clocks:advance', payload),
  stopClock: (payload) => ipcRenderer.invoke('clocks:stop', payload),

  setAboardVehicle: (payload) => ipcRenderer.invoke('character:set-aboard-vehicle', payload),
  setVehicleCondition: (payload) => ipcRenderer.invoke('character:set-vehicle-condition', payload),
  discardAssetManual: (payload) => ipcRenderer.invoke('character:discard-asset', payload),

  updateCharacterFlavorManual: (payload) => ipcRenderer.invoke('character:update-flavor', payload),
  updateCharacterStatsManual: (payload) => ipcRenderer.invoke('character:update-stats', payload),

  toggleImpactManual: (payload) => ipcRenderer.invoke('impacts:toggle', payload),
  addOtherImpactManual: (payload) => ipcRenderer.invoke('impacts:add-other', payload),
  removeOtherImpactManual: (payload) => ipcRenderer.invoke('impacts:remove-other', payload),

  addFlagManual: (payload) => ipcRenderer.invoke('flags:add', payload),
  removeFlagManual: (payload) => ipcRenderer.invoke('flags:remove', payload),
  addCampaignElementManual: (payload) => ipcRenderer.invoke('campaignElements:add', payload),
  removeCampaignElementManual: (payload) => ipcRenderer.invoke('campaignElements:remove', payload),
  getCampaignElementCategories: () => ipcRenderer.invoke('campaignElements:categories'),

  testComfyConnection: () => ipcRenderer.invoke('comfy:test-connection'),
  getImage: (imageId) => ipcRenderer.invoke('images:get', { imageId }),
  generatePortrait: (payload) => ipcRenderer.invoke('images:generate-portrait', payload),
  generateLocationImage: (payload) => ipcRenderer.invoke('images:generate-location', payload),
  generateConnectionImage: (payload) => ipcRenderer.invoke('images:generate-connection', payload),
  generateIllustration: (payload) => ipcRenderer.invoke('images:generate-illustration', payload),
  removeIllustration: (payload) => ipcRenderer.invoke('images:remove-illustration', payload),
  deleteImage: (payload) => ipcRenderer.invoke('images:delete', payload),

  sendMessage: (campaignId, text) => ipcRenderer.invoke('chat:send', { campaignId, text }),
  undoLastTurn: (campaignId) => ipcRenderer.invoke('chat:undo', { campaignId }),
  resolveChoice: (campaignId, chosenText) => ipcRenderer.invoke('chat:resolve-choice', { campaignId, chosenText }),
  composeImagePrompt: (payload) => ipcRenderer.invoke('image:compose-prompt', payload),

  onChatEvent: (callback) => {
    const listener = (_evt, event) => callback(event);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
});

contextBridge.exposeInMainWorld('updater', {
  getVersion: () => ipcRenderer.invoke('updater:get-version'),
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  install: () => ipcRenderer.invoke('updater:install'),
  onStatus: (callback) => {
    const listener = (_evt, status) => callback(status);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
});
