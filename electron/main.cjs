'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./engine/store.cjs');
const stateMod = require('./engine/state.cjs');
const dataMod = require('./engine/data.cjs');
const dice = require('./engine/dice.cjs');
const comfyui = require('./engine/comfyui.cjs');
const { executeTool } = require('./engine/tools.cjs');
const { buildSystemPrompt, DEFAULT_NARRATIVE_RULES } = require('./engine/systemPrompt.cjs');
const { runTurn } = require('./engine/openrouter.cjs');
const summarizer = require('./engine/summarizer.cjs');
const promptComposer = require('./engine/promptComposer.cjs');
const updater = require('./updater.cjs');

const isDev = !app.isPackaged;

/** The app's single window. Tracked at module level (not just createWindow's local scope) so
 *  other subsystems -- the auto-updater below, chiefly -- have somewhere to send events without
 *  needing their own window-management logic. Cleared on close rather than left dangling. */
let mainWindow = null;

/** In-memory campaign cache: campaignId -> { state, messages } */
const campaigns = new Map();

/** In-memory only, deliberately never persisted to the save file: campaignId -> { messages,
 *  state, undoneUserText } snapshot of everything as it was immediately before the most recent
 *  chat:send turn. Powers Undo/Edit/Regenerate (see chat:undo below) -- single-level by design,
 *  overwritten by the next chat:send, and cleared once used so a second undo attempt fails
 *  cleanly rather than silently doing nothing. Kept out of `campaigns`/saveCampaign entirely so
 *  there's no risk of a stale snapshot ever leaking into a persisted save file. Does not survive
 *  an app restart -- an accepted tradeoff for a first version of this feature, not an oversight. */
const undoCheckpoints = new Map();

function userDataDir() {
  return app.getPath('userData');
}

/** Builds the `{baseUrl, workflowTemplate, saveImage}` shape tools.cjs's generate_image expects,
 *  or null if ComfyUI isn't configured -- generate_image reports that cleanly rather than throwing. */
function buildImageGen() {
  const config = store.loadConfig(userDataDir());
  if (!config.comfyUrl || !config.comfyWorkflow) return null;
  let workflowTemplate;
  try {
    workflowTemplate = JSON.parse(config.comfyWorkflow);
  } catch {
    return null; // invalid JSON in the saved template -- treated the same as "not configured"
  }
  return {
    baseUrl: config.comfyUrl,
    workflowTemplate,
    saveImage: (buffer) => store.saveImage(userDataDir(), buffer),
  };
}

/**
 * Writes one complete turn's diagnostic record -- the exact system prompt the model actually
 * received, alongside exactly what it did in response (every tool call, its result, and the
 * final narration) -- to the opt-in debug log, if the player has turned that setting on. This
 * is the whole point of the feature: with both halves of a specific turn side by side, it
 * becomes possible to tell whether a given problem was the app's fault (the prompt itself was
 * wrong or missing guidance for the situation) or the model's fault (the guidance was correct
 * and the model didn't follow it) -- something that's much harder to determine from the
 * player-facing chat log alone, since that only shows the outcome, not what the model was
 * actually told going in. Never throws on its own account -- a logging failure (disk full, a
 * permissions issue) shouldn't ever break the actual turn it's trying to record.
 */
function logDebugTurn(config, campaignId, { trigger, userInput, systemPrompt, events, updated, pendingChoice }) {
  if (!config.debugLogging) return;
  try {
    const finalAssistant = [...updated].reverse().find((m) => m.role === 'assistant' && m.content);
    store.appendDebugLog(userDataDir(), campaignId, {
      trigger,
      userInput,
      model: config.model,
      temperature: config.temperature,
      topP: config.topP,
      events,
      // Field order matters here: the most useful-to-scan fields come first, with systemPrompt
      // last since it's overwhelmingly the largest part of the entry (commonly 100,000+
      // characters, often 10x everything else combined) and the least likely to differ from
      // the previous turn's -- reading top to bottom shouldn't mean wading through it just to
      // reach what actually happened. Split into an array of lines, one string per line, rather
      // than left as a single string -- JSON can't represent a real line break inside a string
      // value at all, only an escaped \n, so a single massive string is one unreadable line
      // even in an otherwise nicely pretty-printed object; an array of lines lets
      // JSON.stringify's own pretty-printing put each line on its own real line instead.
      // '\n'.join(entry.systemPrompt) reconstructs the original string when needed
      // programmatically, e.g. Array.isArray(entry.systemPrompt) ? entry.systemPrompt.join('\n') : entry.systemPrompt.
      finalReply: (finalAssistant ? finalAssistant.content : '').split('\n'),
      pendingChoice: pendingChoice || null,
      systemPrompt: systemPrompt.split('\n'),
    });
  } catch (err) {
    console.error('Debug logging failed (turn itself is unaffected):', err.message);
  }
}

/** Shared by the manual (non-AI) image-generation IPC handlers below. Throws with a clear
 *  message on misconfiguration rather than the generic tools.cjs "not configured" error, since
 *  these paths aren't mediated by the GM explaining it in narration. */
async function manualGenerateImage(prompt) {
  const config = store.loadConfig(userDataDir());
  if (!config.comfyUrl) throw new Error('No ComfyUI server URL configured -- set one in Settings first.');
  if (!config.comfyWorkflow) throw new Error('No ComfyUI workflow template configured -- paste one into Settings first.');
  let workflowTemplate;
  try {
    workflowTemplate = JSON.parse(config.comfyWorkflow);
  } catch {
    throw new Error('The saved ComfyUI workflow template is not valid JSON -- check it in Settings.');
  }
  const buffer = await comfyui.generateImage({ baseUrl: config.comfyUrl, workflowTemplate, prompt });
  return store.saveImage(userDataDir(), buffer);
}

function loadCampaign(campaignId) {
  if (campaigns.has(campaignId)) return campaigns.get(campaignId);
  const file = store.campaignPath(userDataDir(), campaignId);
  let record;
  if (fs.existsSync(file)) {
    record = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } else {
    record = { state: stateMod.newCampaignState(), messages: [], pendingChoice: null };
  }
  // Backward compatibility: sectors saved before passages existed won't have the field at all.
  // Normalized here, once, at load time -- this is the single most central point every other
  // code path (including campaign:get, which returns the raw record with no other processing)
  // passes through, rather than defensively re-checking for it in the renderer or in every
  // individual tool handler.
  if (record.state && record.state.sectors) {
    for (const sector of Object.values(record.state.sectors)) {
      if (!sector.passages) sector.passages = [];
    }
  }
  // Backward compatibility: campaigns saved before campaignElements existed won't have the
  // field at all -- same normalization pattern as sector.passages above.
  if (record.state && !record.state.campaignElements) {
    record.state.campaignElements = [];
  }
  // Backward compatibility: campaignElements upgraded from a single freeform string ({id, text})
  // into a real, categorized shape ({id, category, name, description}) -- an old entry has no
  // way to know which category it actually belongs in (that information was never captured),
  // so it goes to 'Other' rather than guessing, with its old text becoming the new name. The
  // player can freely re-add it under a better category later if they want; this only needs to
  // not crash the UI or the tool handlers that now expect the new shape.
  if (record.state && record.state.campaignElements) {
    for (const el of record.state.campaignElements) {
      if (!('category' in el)) {
        el.category = 'Other';
        el.name = el.text;
        el.description = '';
        delete el.text;
      }
    }
  }
  // Backward compatibility: campaigns saved before present_choice/pendingChoice existed won't
  // have the field at all -- default to null (no choice pending), same pattern as above. Note
  // this lives on `record` itself, not `record.state` -- it's about the conversation/turn
  // mechanics, not game state.
  if (!('pendingChoice' in record)) {
    record.pendingChoice = null;
  }
  // Backward compatibility: campaigns saved before Vehicle Troubles moved onto individual
  // vehicle assets. Two things to migrate, once, here: (1) any existing Command/Support Vehicle
  // assets that predate this change won't have battered/cursed fields at all -- add them,
  // false by default, so setVehicleCondition and the momentum calculation don't choke on a
  // missing field. Support vehicles only ever get battered (never cursed), matching addAsset's
  // own rule for newly-created ones. (2) the actual OLD data: a single shared
  // character.impacts['Current Vehicle'] (now removed from DEFAULT_IMPACTS entirely) and a
  // boolean character.aboardVehicle (now an asset id or null) -- migrate whatever was marked
  // onto the character's command vehicle specifically, since that's what the old shared toggle
  // most often represented in practice, then delete the old fields so they don't linger as dead
  // data alongside the new ones.
  if (record.state && record.state.character) {
    const character = record.state.character;
    if (character.assets) {
      for (const asset of character.assets) {
        if (asset.category === 'Command Vehicle') {
          if (!('battered' in asset)) asset.battered = false;
          if (!('cursed' in asset)) asset.cursed = false;
        } else if (asset.category === 'Support Vehicle' && !('battered' in asset)) {
          asset.battered = false;
        }
      }
    }
    if (character.impacts && character.impacts['Current Vehicle']) {
      const old = character.impacts['Current Vehicle'];
      const wasBattered = old.some((i) => i.name === 'Battered' && i.marked);
      const wasCursed = old.some((i) => i.name === 'Cursed' && i.marked);
      const commandVehicle = (character.assets || []).find((a) => a.category === 'Command Vehicle');
      if (commandVehicle && (wasBattered || wasCursed)) {
        if (wasBattered) commandVehicle.battered = true;
        if (wasCursed) commandVehicle.cursed = true;
      }
      delete character.impacts['Current Vehicle'];
    }
    if ('aboardVehicle' in character) {
      const commandVehicle = (character.assets || []).find((a) => a.category === 'Command Vehicle');
      character.aboardVehicleId = character.aboardVehicle && commandVehicle ? commandVehicle.id : null;
      delete character.aboardVehicle;
    }
    if (character.assets) stateMod.applyImpactEffects(record.state);
  }
  campaigns.set(campaignId, record);
  return record;
}

function saveCampaign(campaignId) {
  const record = campaigns.get(campaignId);
  if (!record) return;
  const file = store.campaignPath(userDataDir(), campaignId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf-8');
}

function buildAppMenu() {
  const template = [
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        // Explicit accelerators rather than the 'zoomIn'/'zoomOut' roles' defaults: Electron's
        // default zoom-in binding is "CmdOrCtrl+Plus", which only fires by actually producing a
        // "+" character -- meaning Shift+= on a standard keyboard (or numpad +), NOT the
        // unshifted "=" key most people press without thinking about it. That makes the
        // intuitive Ctrl+= do nothing, while Ctrl+Shift+= works, backwards from every other app's
        // convention. Binding explicitly to "CmdOrCtrl+=" fixes that; a second entry keeps
        // numpad-plus working too, without it being the primary/visible binding.
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: (_item, win) => win && win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5) },
        { label: 'Zoom In (numpad)', visible: false, acceleratorWorksWhenHidden: true, accelerator: 'CmdOrCtrl+Plus', click: (_item, win) => win && win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5) },
        { role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
        { role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Dev convenience: set SCREENSHOT_PATH to have the app capture its first render
  // and quit -- useful for automated smoke tests without a human watching the window.
  if (process.env.SCREENSHOT_PATH) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(process.env.SCREENSHOT_PATH, image.toPNG());
        app.quit();
      }, 1200);
    });
  }
}

app.whenReady().then(() => {
  buildAppMenu();
  createWindow();
  updater.setup({ ipcMain, isDev, getMainWindow: () => mainWindow, app });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: config ----
ipcMain.handle('config:get', () => store.loadConfig(userDataDir()));
ipcMain.handle('config:set', (_evt, config) => {
  store.saveConfig(userDataDir(), config);
  return true;
});
// Exposes the built-in narrative-rules text so the Settings UI has a real starting point to
// show/edit and a real value to reset back to -- not a second, hand-copied version of the same
// text that could quietly drift from systemPrompt.cjs's own copy over time.
ipcMain.handle('config:get-default-narrative-rules', () => DEFAULT_NARRATIVE_RULES);

// ---- IPC: campaigns ----
ipcMain.handle('campaign:list', () => store.listCampaigns(userDataDir()));

ipcMain.handle('campaign:summaries', () => {
  return store.listCampaigns(userDataDir()).map((campaignId) => {
    const file = store.campaignPath(userDataDir(), campaignId);
    let name = '';
    let campaignName = null;
    let sectorName = '';
    let updatedAt = null;
    let lastPlayedAt = null;
    try {
      const record = campaigns.has(campaignId) ? campaigns.get(campaignId) : JSON.parse(fs.readFileSync(file, 'utf-8'));
      name = record.state.character.name || '';
      campaignName = record.state.campaignName || null;
      const currentSector = record.state.sectors && record.state.sectors[record.state.currentSectorId];
      sectorName = (currentSector && currentSector.name) || '';
      updatedAt = fs.statSync(file).mtime.toISOString();
      // Distinct from updatedAt on purpose -- updatedAt is the file's own mtime, which moves on
      // ANY save (a migration running on load, one of the manual, non-AI edit IPC handlers like
      // campaignElements:add or images:delete), not just real play. lastPlayedAt only
      // moves via markPlayed(), called specifically on an actual chat:send/resolve-choice turn --
      // a more meaningful answer to "when did I last actually play this" than the file's own
      // technical last-write time.
      lastPlayedAt = record.state.lastPlayedAt || null;
    } catch {
      // Corrupt or unreadable file -- still list it so the user can see and delete it.
    }
    return { campaignId, name, campaignName, sectorName, updatedAt, lastPlayedAt };
  });
});

ipcMain.handle('campaign:get', (_evt, campaignId = 'default') => {
  return loadCampaign(campaignId);
});

ipcMain.handle('campaign:delete', (_evt, campaignId) => {
  campaigns.delete(campaignId);
  store.deleteCampaign(userDataDir(), campaignId);
  return true;
});

ipcMain.handle('campaign:rename', (_evt, { campaignId, name }) => {
  const record = loadCampaign(campaignId);
  stateMod.setCampaignName(record.state, name);
  saveCampaign(campaignId);
  return true;
});

ipcMain.handle('campaign:duplicate', (_evt, { campaignId }) => {
  const original = loadCampaign(campaignId);
  const newId = `campaign-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Deep clone via JSON round-trip -- campaign state is already fully JSON-serializable (it's
  // written to disk the same way), so this is safe and avoids the two campaigns ever sharing
  // mutable object references. Image files aren't duplicated -- they're immutable once
  // generated and content-addressed by id, so both campaigns can safely reference the same ones.
  const clonedState = JSON.parse(JSON.stringify(original.state));
  const baseName = clonedState.campaignName || clonedState.character.name || 'Unnamed Ironsworn';
  clonedState.campaignName = `${baseName} (copy)`;
  const clonedMessages = JSON.parse(JSON.stringify(original.messages));
  // Carries over an in-progress pendingChoice too, if one exists -- the cloned messages already
  // include its own unresolved tool_calls message (see below), so the duplicate needs to know
  // about the pending choice as well, or its own UI would have no way to show the picker for a
  // conversation state it already has.
  const record = { state: clonedState, messages: clonedMessages, pendingChoice: original.pendingChoice ? JSON.parse(JSON.stringify(original.pendingChoice)) : null };
  campaigns.set(newId, record);
  saveCampaign(newId);
  return { campaignId: newId };
});

ipcMain.handle('campaign:export', async (_evt, { campaignId }) => {
  const record = loadCampaign(campaignId);
  const win = BrowserWindow.getFocusedWindow();
  const defaultName = (record.state.campaignName || record.state.character.name || 'campaign').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'campaign';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Campaign',
    defaultPath: `${defaultName}.json`,
    filters: [{ name: 'Campaign save', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  // Exports the full save (state + chat history) as JSON. Generated images are NOT included --
  // they live as separate files, referenced by id, not embedded in this save -- so an imported
  // campaign on another machine (or after clearing image files) will have working mechanics but
  // missing pictures. Worth being upfront about rather than silently losing them.
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
  return { canceled: false, filePath };
});

// A second, genuinely different export: not the re-importable save (state + raw message array,
// meant for this app to read back in), but a plain-language document meant for a person to
// actually read -- share with a friend, print, keep as a memento once a campaign wraps. Reuses
// the same role-filtering logic the renderer's own parseDisplayMessages already applies for the
// chat log display (user messages and non-empty assistant content are the readable story;
// system/tool messages and tool_calls are internal mechanics, not narration) rather than
// reinventing it differently here.
ipcMain.handle('campaign:export-story', async (_evt, { campaignId }) => {
  const record = loadCampaign(campaignId);
  const { character, campaignName } = record.state;
  const win = BrowserWindow.getFocusedWindow();
  const defaultName = (campaignName || character.name || 'campaign').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'campaign';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Readable Story',
    defaultPath: `${defaultName}.md`,
    filters: [{ name: 'Markdown document', extensions: ['md'] }],
  });
  if (canceled || !filePath) return { canceled: true };

  const lines = [];
  lines.push(`# ${campaignName || character.name || 'Untitled Campaign'}`);
  if (campaignName && character.name) lines.push(`### ${character.name}`);
  lines.push('');
  lines.push(`*Exported ${new Date().toLocaleDateString()}*`);
  lines.push('');
  const flavorLine = [character.callsign, character.pronouns].filter(Boolean).join(' · ');
  if (flavorLine) lines.push(`**${flavorLine}**`);
  if (character.description) {
    lines.push('');
    lines.push(character.description);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const msg of record.messages) {
    if (msg.role === 'user' && msg.content) {
      lines.push(`**You:** ${msg.content}`);
      lines.push('');
    } else if (msg.role === 'assistant' && msg.content) {
      lines.push(msg.content);
      lines.push('');
    }
    // system and tool messages, and assistant messages that are only tool_calls with no
    // narration content, are deliberately skipped -- internal mechanics, not the story itself.
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return { canceled: false, filePath };
});

ipcMain.handle('campaign:import', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Campaign',
    filters: [{ name: 'Campaign save', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return { canceled: true };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
  } catch {
    throw new Error('That file isn\'t valid JSON -- it doesn\'t look like a campaign export.');
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.state || !parsed.state.character) {
    throw new Error('That file doesn\'t look like a campaign export (missing character state).');
  }
  const newId = `campaign-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const record = { state: parsed.state, messages: Array.isArray(parsed.messages) ? parsed.messages : [], pendingChoice: parsed.pendingChoice || null };
  campaigns.set(newId, record);
  saveCampaign(newId);
  return { canceled: false, campaignId: newId };
});

// A lighter export than campaign:export -- just the character build and setting truths, not the
// whole campaign (progress tracks, connections, sector, log, chat history). For reusing a
// character/truths setup as a starting point for a NEW campaign, rather than replaying character
// creation and re-rolling truths from scratch every time.
ipcMain.handle('character:export', async (_evt, { campaignId }) => {
  const record = loadCampaign(campaignId);
  const win = BrowserWindow.getFocusedWindow();
  const defaultName = (record.state.character.name || 'character').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'character';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Character',
    defaultPath: `${defaultName} (character).json`,
    filters: [{ name: 'Character export', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  // The background vow lives as its own progress track (id 'vow-background'), not on the
  // character object itself -- pull its name out separately so a full re-import can recreate it.
  const backgroundVowTrack = record.state.progressTracks.find((t) => t.id === 'vow-background');
  const exportData = {
    kind: 'starforged-character-export',
    version: 1,
    character: record.state.character,
    truths: record.state.truths,
    backgroundVow: backgroundVowTrack ? backgroundVowTrack.name : null,
  };
  fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2), 'utf-8');
  return { canceled: false, filePath };
});

// Reads and validates a character export file, returning its contents for the renderer to apply
// (via campaign:apply_imported_character) once the player confirms. Doesn't touch any campaign
// state itself -- mirrors campaign:import's shape, but returns data instead of creating a record,
// since the caller needs to decide which in-progress campaign (if any) to apply it to.
ipcMain.handle('character:import', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Character',
    filters: [{ name: 'Character export', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return { canceled: true };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
  } catch {
    throw new Error('That file isn\'t valid JSON -- it doesn\'t look like a character export.');
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.character || !parsed.character.stats || typeof parsed.character.name !== 'string') {
    throw new Error('That file doesn\'t look like a character export (missing character data).');
  }
  return {
    canceled: false,
    character: parsed.character,
    truths: parsed.truths && typeof parsed.truths === 'object' ? parsed.truths : {},
    backgroundVow: typeof parsed.backgroundVow === 'string' ? parsed.backgroundVow : null,
  };
});

// Applies a previously-imported character + truths (+ optional background vow) wholesale to a
// campaign -- a full replacement, not a merge, since this is meant for a campaign that hasn't
// really started yet (Session Zero, before character creation). Deliberately does NOT grant a
// free Starship or anything else campaign:new normally adds -- the imported character is already
// complete exactly as it was exported, so nothing should be layered on top of it.
ipcMain.handle('campaign:apply_imported_character', (_evt, { campaignId, character, truths, backgroundVow }) => {
  campaignId = campaignId || `campaign-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const record = loadCampaign(campaignId);
  const state = record.state;
  state.character = character;
  state.truths = truths || {};
  if (backgroundVow && backgroundVow.trim() && !state.progressTracks.some((t) => t.id === 'vow-background')) {
    state.progressTracks.push({ id: 'vow-background', name: backgroundVow.trim(), type: 'vow', rank: 'epic', ticks: 0 });
  }
  campaigns.set(campaignId, record);
  saveCampaign(campaignId);
  return { campaignId, ...record };
});

ipcMain.handle('campaign:new', (_evt, { campaignId, character, startingAssetIds = [], backgroundVow }) => {
  campaignId = campaignId || `campaign-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Reuse whatever record already exists for this campaignId rather than building a fresh one --
  // Session Zero Truths runs BEFORE character creation and mutates a real backend record for
  // this same campaignId (rolling/setting truths via the ordinary IPC path), so a truly fresh
  // state here would silently discard everything the player already chose. loadCampaign()
  // correctly falls back to a brand-new state if this campaignId genuinely has no record yet
  // (e.g. Session Zero was skipped entirely).
  const record = loadCampaign(campaignId);
  const state = record.state;
  if (character) {
    state.character.name = character.name || '';
    stateMod.updateCharacterFlavor(state, { callsign: character.callsign, pronouns: character.pronouns, description: character.description });
    if (character.stats) {
      stateMod.updateCharacterStats(state, character.stats);
    }
  }

  // Every Starforged character starts with a Starship (Command Vehicle asset) for free.
  // Guarded against duplicates -- now that this handler reuses an existing record rather than
  // always building a fresh one, a repeat call (e.g. an accidental double-click on "Begin
  // Campaign") must not grant a second Starship.
  const starship = dataMod.findAsset('Starship');
  if (starship && !state.character.assets.some((a) => a.id === starship.$id)) {
    stateMod.addAsset(state, { id: starship.$id, name: starship.Name, category: 'Command Vehicle' });
    // Matches the old default (character.aboardVehicle started true) -- a fresh character is
    // assumed aboard their own new ship until the fiction says otherwise.
    stateMod.setAboardVehicle(state, starship.$id);
  }

  // Chosen starting assets (2 Path + 1 final asset from Module/Support Vehicle/Companion/Path --
  // not Deed, which every official Deed asset gates behind an in-play milestone like "once you
  // Forge a Bond..." or "once you fill N legacy-track boxes", making it impossible to have one
  // before the campaign starts) are free at character creation. The frontend enforces the 2+1
  // split.
  for (const id of startingAssetIds) {
    const asset = dataMod.findAsset(id);
    if (asset && !state.character.assets.some((a) => a.id === asset.$id)) {
      stateMod.addAsset(state, { id: asset.$id, name: asset.Name, category: (asset['Asset Type'] || '').split('/').pop() });
    }
  }

  // Step 4 of character creation: write a background vow. It's always epic rank, and per the
  // rulebook you don't actually make the Swear an Iron Vow move for it -- it's already sworn as
  // part of the character's history, so this just creates the track directly at 0 progress.
  // Also guarded against duplicates for the same reason as the Starship above.
  if (backgroundVow && backgroundVow.trim() && !state.progressTracks.some((t) => t.id === 'vow-background')) {
    state.progressTracks.push({ id: 'vow-background', name: backgroundVow.trim(), type: 'vow', rank: 'epic', ticks: 0 });
  }

  campaigns.set(campaignId, record);
  saveCampaign(campaignId);
  return { campaignId, ...record };
});

// ---- IPC: asset catalog (for the character-creation asset picker) ----
ipcMain.handle('assets:starting', () => {
  const { assets } = dataMod.loadData();
  // Per the rulebook: choose exactly 2 Path assets, then 1 final asset from Module, Support
  // Vehicle, Companion, or Path (not Deed -- see the README for why). The frontend enforces the
  // "2 Paths, then 1 more" structure; this just returns every eligible category.
  const startingCategories = ['Path', 'Module', 'Support Vehicle', 'Companion'];
  const official = assets
    .filter((cat) => startingCategories.includes(cat.Name))
    .map((cat) => ({
      category: cat.Name,
      assets: (cat.Assets || []).map((a) => ({
        id: a.$id,
        name: a.Name,
        color: (a.Display && a.Display.Color) || null,
        abilities: (a.Abilities || []).map((ab) => dataMod.stripCrossRefLinks(ab.Text)),
      })),
    }));

  return official;
});

// ---- IPC: opening a link from GM narration in the OS's real browser, not this window ----
// Markdown-rendered chat content can technically contain a link (rare for GM narration, but a
// real markdown renderer needs to handle every element type sensibly, not just the common
// ones) -- a plain <a href> inside an Electron BrowserWindow would otherwise navigate this
// window itself away from the app on click, which is not recoverable without a restart.
ipcMain.handle('shell:open-external', (_evt, url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { opened: false, error: 'Only http/https links can be opened.' };
    }
  } catch {
    return { opened: false, error: 'Not a valid URL.' };
  }
  shell.openExternal(url);
  return { opened: true };
});

ipcMain.handle('debugLog:reveal', (_evt, { campaignId = 'default' } = {}) => {
  const logPath = store.debugLogPath(userDataDir(), campaignId);
  if (fs.existsSync(logPath)) {
    shell.showItemInFolder(logPath);
    return { opened: true, path: logPath };
  }
  // Nothing logged yet for this campaign (debug logging just turned on, or never triggered a
  // turn since) -- reveal the containing folder instead of failing outright, so the player can
  // still see where the file will appear once a turn actually happens.
  const dir = store.debugLogsDir(userDataDir());
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { opened: true, path: dir, fileNotYetCreated: true };
});

// ---- IPC: full asset catalog, every category, for looking up an OWNED asset's ability text
// on the character sheet (assets:starting above is deliberately scoped to only the categories
// eligible at character creation, missing Deed and Command Vehicle -- both real, ownable
// categories mid-campaign, e.g. the auto-granted Starship or a Deed bought via Advance) ----
ipcMain.handle('assets:catalog', () => {
  const { assets } = dataMod.loadData();
  const official = [];
  for (const category of assets) {
    for (const a of category.Assets || []) {
      official.push({
        id: a.$id,
        name: a.Name,
        category: category.Name,
        color: (a.Display && a.Display.Color) || null,
        abilities: (a.Abilities || []).map((ab) => dataMod.stripCrossRefLinks(ab.Text)),
      });
    }
  }
  return official;
});

// ---- IPC: sector map (direct manual edits -- these don't touch the AI/chat loop) ----
ipcMain.handle('sector:update-cell', (_evt, { campaignId = 'default', sectorId = null, cell, name, notes }) => {
  const record = loadCampaign(campaignId);
  stateMod.updateCell(record.state, sectorId, cell, { name, notes });
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('sector:add-feature', (_evt, { campaignId = 'default', sectorId = null, cell, type, name, description }) => {
  const record = loadCampaign(campaignId);
  stateMod.addFeature(record.state, sectorId, cell, { type, name, description });
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('sector:remove-feature', (_evt, { campaignId = 'default', sectorId = null, cell, featureId }) => {
  const record = loadCampaign(campaignId);
  stateMod.removeFeature(record.state, sectorId, cell, featureId);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('sector:set-current', (_evt, { campaignId = 'default', sectorId = null, cell }) => {
  const record = loadCampaign(campaignId);
  stateMod.setCurrentCell(record.state, sectorId, cell);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('sector:create-passage', (_evt, { campaignId = 'default', sectorId = null, fromCell, toCell, notes }) => {
  const record = loadCampaign(campaignId);
  stateMod.createPassage(record.state, sectorId, { fromCell, toCell: toCell || null, notes });
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('sector:remove-passage', (_evt, { campaignId = 'default', sectorId = null, passageId }) => {
  const record = loadCampaign(campaignId);
  stateMod.removePassage(record.state, sectorId, passageId);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('sector:link-passage', (_evt, { campaignId = 'default', sectorId = null, passageId, toSectorId }) => {
  const record = loadCampaign(campaignId);
  stateMod.linkPassageToSector(record.state, sectorId, passageId, toSectorId);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('sector:set-info', (_evt, { campaignId = 'default', sectorId = null, name, region, factionControl, notes }) => {
  const record = loadCampaign(campaignId);
  stateMod.setSectorInfo(record.state, sectorId, { name, region, factionControl, notes });
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('sector:create', (_evt, { campaignId = 'default', name, region, factionControl }) => {
  const record = loadCampaign(campaignId);
  stateMod.createSector(record.state, { name, region, factionControl });
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('sector:switch', (_evt, { campaignId = 'default', sectorId }) => {
  const record = loadCampaign(campaignId);
  stateMod.switchSector(record.state, sectorId);
  saveCampaign(campaignId);
  return record.state;
});

// ---- IPC: character editing (post-creation, manual, non-AI -- name/flavor/stat corrections) ----
ipcMain.handle('character:update-flavor', (_evt, { campaignId = 'default', name, callsign, pronouns, description }) => {
  const record = loadCampaign(campaignId);
  stateMod.updateCharacterFlavor(record.state, { name, callsign, pronouns, description });
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('character:update-stats', (_evt, { campaignId = 'default', stats }) => {
  const record = loadCampaign(campaignId);
  stateMod.correctCharacterStats(record.state, stats);
  saveCampaign(campaignId);
  return record.state;
});

// ---- IPC: impacts (manual, non-AI edits) ----
ipcMain.handle('impacts:toggle', (_evt, { campaignId = 'default', category, name }) => {
  const record = loadCampaign(campaignId);
  stateMod.toggleImpact(record.state, category, name);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('impacts:add-other', (_evt, { campaignId = 'default', name }) => {
  const record = loadCampaign(campaignId);
  stateMod.addOtherImpact(record.state, name);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('impacts:remove-other', (_evt, { campaignId = 'default', name }) => {
  const record = loadCampaign(campaignId);
  stateMod.removeOtherImpact(record.state, name);
  saveCampaign(campaignId);
  return record.state;
});

// ---- IPC: setting truths (catalog for the Truths tab, plus manual roll/choose/clear) ----
ipcMain.handle('truths:catalog', () => {
  const { truths } = dataMod.loadData();
  return truths.map((cat) => ({
    category: cat.Name,
    options: cat.Table.map((row) => ({
      result: row.Result,
      description: row.Description || '',
      questStarter: row['Quest Starter'] || '',
      subtable: Array.isArray(row.Subtable) ? row.Subtable.map((s) => s.Result) : null,
    })),
  }));
});

ipcMain.handle('truths:roll', async (_evt, { campaignId = 'default', category }) => {
  const record = loadCampaign(campaignId);
  const result = await executeTool('roll_setting_truth', { category }, record.state);
  saveCampaign(campaignId);
  return { result, state: record.state };
});

ipcMain.handle('truths:choose', (_evt, { campaignId = 'default', category, result, subtableResult, description, questStarter }) => {
  const record = loadCampaign(campaignId);
  stateMod.setTruth(record.state, category, { result, subtableResult, description, questStarter, source: 'chosen' });
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('truths:clear', (_evt, { campaignId = 'default', category }) => {
  const record = loadCampaign(campaignId);
  stateMod.clearTruth(record.state, category);
  saveCampaign(campaignId);
  return record.state;
});

// ---- IPC: connections (manual edits) ----
ipcMain.handle('connections:add', (_evt, { campaignId = 'default', name, notes, location }) => {
  const record = loadCampaign(campaignId);
  stateMod.addConnection(record.state, { name, notes, location });
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('connections:update', (_evt, { campaignId = 'default', id, name, notes, location }) => {
  const record = loadCampaign(campaignId);
  stateMod.updateConnection(record.state, id, { name, notes, location });
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('connections:remove', (_evt, { campaignId = 'default', id }) => {
  const record = loadCampaign(campaignId);
  stateMod.removeConnection(record.state, id);
  saveCampaign(campaignId);
  return record.state;
});

// ---- IPC: campaign log (manual entries) ----
ipcMain.handle('log:add', (_evt, { campaignId = 'default', text }) => {
  const record = loadCampaign(campaignId);
  stateMod.addLogEntry(record.state, text);
  saveCampaign(campaignId);
  return record.state;
});

// ---- IPC: content flags (manual, non-AI edits) ----
ipcMain.handle('flags:add', (_evt, { campaignId = 'default', text }) => {
  const record = loadCampaign(campaignId);
  stateMod.addFlag(record.state, text);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('flags:remove', (_evt, { campaignId = 'default', text }) => {
  const record = loadCampaign(campaignId);
  stateMod.removeFlag(record.state, text);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('campaignElements:categories', () => stateMod.CAMPAIGN_ELEMENT_CATEGORIES);

ipcMain.handle('campaignElements:add', (_evt, { campaignId = 'default', category, name, description }) => {
  const record = loadCampaign(campaignId);
  stateMod.addCampaignElement(record.state, category, name, description);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('campaignElements:remove', (_evt, { campaignId = 'default', id }) => {
  const record = loadCampaign(campaignId);
  stateMod.removeCampaignElement(record.state, id);
  saveCampaign(campaignId);
  return record.state;
});

// ---- IPC: clocks (manual, non-AI edits) ----
ipcMain.handle('clocks:create', (_evt, { campaignId = 'default', name, type, segments }) => {
  const record = loadCampaign(campaignId);
  stateMod.createClock(record.state, { name, type, segments });
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('clocks:advance', (_evt, { campaignId = 'default', id, amount }) => {
  const record = loadCampaign(campaignId);
  stateMod.advanceClock(record.state, id, amount);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('clocks:stop', (_evt, { campaignId = 'default', id }) => {
  const record = loadCampaign(campaignId);
  stateMod.stopClock(record.state, id);
  saveCampaign(campaignId);
  return record.state;
});

// ---- IPC: character (aboard-vehicle toggle, vehicle conditions, companion hits -- manual, non-AI edits) ----
ipcMain.handle('character:set-aboard-vehicle', (_evt, { campaignId = 'default', assetId }) => {
  const record = loadCampaign(campaignId);
  stateMod.setAboardVehicle(record.state, assetId || null);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('character:set-vehicle-condition', (_evt, { campaignId = 'default', assetId, condition, marked }) => {
  const record = loadCampaign(campaignId);
  stateMod.setVehicleCondition(record.state, assetId, condition, marked);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('character:discard-asset', (_evt, { campaignId = 'default', assetId }) => {
  const record = loadCampaign(campaignId);
  stateMod.removeAsset(record.state, assetId);
  saveCampaign(campaignId);
  return record.state;
});

// ---- IPC: moves catalog (for the clickable moves panel) ----
ipcMain.handle('moves:list', () => {
  const { moves } = dataMod.loadData();
  const out = [];
  for (const category of moves) {
    for (const move of category.Moves || []) {
      out.push({
        id: move.$id,
        name: move.Name,
        category: (move.Category || '').split('/').pop(),
        color: (move.Display && move.Display.Color) || null,
        triggerText: dataMod.stripCrossRefLinks((move.Trigger && move.Trigger.Text) || ''),
        options: (move.Trigger && move.Trigger.Options ? move.Trigger.Options : []).map((o) => ({
          text: dataMod.stripCrossRefLinks(o.Text),
          using: o.Using || [],
        })),
        outcomes: move.Outcomes
          ? {
              strongHit: move.Outcomes['Strong Hit'] ? dataMod.stripCrossRefLinks(move.Outcomes['Strong Hit'].Text) : null,
              weakHit: move.Outcomes['Weak Hit'] ? dataMod.stripCrossRefLinks(move.Outcomes['Weak Hit'].Text) : null,
              miss: move.Outcomes['Miss'] ? dataMod.stripCrossRefLinks(move.Outcomes['Miss'].Text) : null,
            }
          : null,
      });
    }
  }
  return out;
});

// ---- IPC: oracles (manual, player-initiated rolls -- separate from roll_oracle, which is the
//      AI's own tool for weaving a result into ongoing narration; these are for a player who
//      wants a quick, direct answer without waiting on or paying for a full AI turn) ----
ipcMain.handle('oracles:list', () =>
  dataMod.flattenOracles().map((o) => ({ id: o.id, name: o.name, path: o.path, displayTitle: o.displayTitle, description: o.description }))
);

ipcMain.handle('oracles:roll', (_evt, { oracleId }) => {
  const oracle = dataMod.findOracle(oracleId);
  if (!oracle) throw new Error(`No oracle found matching id "${oracleId}".`);
  const result = dice.rollOracleTable(oracle.table);
  return {
    oracle: { id: oracle.id, name: oracle.name, path: oracle.path },
    roll: result.roll,
    isMatch: result.is_match,
    result: result.row ? dataMod.stripCrossRefLinks(result.row.Result) : null,
  };
});

// ---- IPC: images (portraits, locations, connections, story illustrations) ----
ipcMain.handle('comfy:test-connection', async () => {
  const config = store.loadConfig(userDataDir());
  return comfyui.testConnection(config.comfyUrl);
});

ipcMain.handle('images:get', (_evt, { imageId }) => {
  return store.loadImageAsDataUrl(userDataDir(), imageId);
});

ipcMain.handle('images:generate-portrait', async (_evt, { campaignId = 'default', prompt }) => {
  const record = loadCampaign(campaignId);
  const imageId = await manualGenerateImage(prompt);
  stateMod.setPortraitImage(record.state, imageId);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('images:generate-location', async (_evt, { campaignId = 'default', sectorId = null, cell, prompt }) => {
  const record = loadCampaign(campaignId);
  const imageId = await manualGenerateImage(prompt);
  stateMod.setCellImage(record.state, sectorId, cell, imageId);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('images:generate-connection', async (_evt, { campaignId = 'default', connectionId, prompt }) => {
  const record = loadCampaign(campaignId);
  const imageId = await manualGenerateImage(prompt);
  stateMod.setConnectionImage(record.state, connectionId, imageId);
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('images:generate-illustration', async (_evt, { campaignId = 'default', prompt, caption }) => {
  const record = loadCampaign(campaignId);
  const imageId = await manualGenerateImage(prompt);
  stateMod.addIllustration(record.state, { imageId, caption });
  saveCampaign(campaignId);
  return record.state;
});

ipcMain.handle('images:remove-illustration', (_evt, { campaignId = 'default', id }) => {
  const record = loadCampaign(campaignId);
  // Look up the image id before removing the entry, so the underlying file can be deleted too --
  // previously this only cleared the state reference, leaving the actual file orphaned on disk
  // forever.
  const illustration = record.state.illustrations.find((i) => i.id === id);
  stateMod.removeIllustration(record.state, id);
  if (illustration) store.deleteImage(userDataDir(), illustration.imageId);
  saveCampaign(campaignId);
  return record.state;
});

// Deletes an image from wherever it's actually referenced (portrait, a connection, a sector
// cell, or an illustration) and removes the underlying file -- store.deleteImage already existed
// for this but was never actually wired up to anything before this. Used by the Image Gallery,
// which is the one place every category of generated image is shown side by side and a "delete"
// action needs to work the same regardless of which kind of image it's looking at.
ipcMain.handle('images:delete', (_evt, { campaignId = 'default', imageId }) => {
  const record = loadCampaign(campaignId);
  const cleared = stateMod.removeImageEverywhere(record.state, imageId);
  if (cleared.length === 0) throw new Error(`No image reference found for id "${imageId}".`);
  store.deleteImage(userDataDir(), imageId);
  saveCampaign(campaignId);
  return record.state;
});

// ---- IPC: chat turn ----
ipcMain.handle('chat:send', async (evt, { campaignId = 'default', text }) => {
  const config = store.loadConfig(userDataDir());
  if (!config.apiKey) {
    throw new Error('No OpenRouter API key configured. Set one in Settings first.');
  }

  const record = loadCampaign(campaignId);

  // Snapshot everything as it is RIGHT NOW, before this turn's user message is even added --
  // this is what Undo/Edit/Regenerate roll back to. Deep-cloned via JSON round-trip (the same
  // approach the rest of this engine already uses for state, nothing fancier needed since
  // campaignState is plain, serializable data). Deliberately overwrites any earlier checkpoint:
  // undo is single-level, always referring to the most recently completed turn, not a stack.
  undoCheckpoints.set(campaignId, {
    messages: JSON.parse(JSON.stringify(record.messages)),
    state: JSON.parse(JSON.stringify(record.state)),
    undoneUserText: text,
  });

  record.messages.push({ role: 'user', content: text });

  // Regenerate the system prompt fresh every turn so it always reflects current state.
  // Compute the session gap BEFORE updating lastPlayedAt, so it reflects the gap since the
  // previous turn, not this one -- then mark this turn as "now" for the next comparison.
  const systemMessage = { role: 'system', content: buildSystemPrompt(record.state, config.moveChoiceThreshold, config.narrativeRules) };
  stateMod.markPlayed(record.state);
  const withSystem = [systemMessage, ...record.messages];

  // Collected unconditionally (the overhead is trivial) but only ever written to disk if
  // config.debugLogging is actually on -- see logDebugTurn below.
  const capturedEvents = [];
  const sendEvent = (event) => {
    capturedEvents.push(event);
    evt.sender.send('chat:event', { campaignId, ...event });
  };

  const { messages: updated, pendingChoice } = await runTurn({
    apiKey: config.apiKey,
    model: config.model,
    messages: withSystem,
    campaignState: record.state,
    imageGen: buildImageGen(),
    temperature: config.temperature,
    topP: config.topP,
    onEvent: sendEvent,
  });

  // Store everything after the system message (index 0) back as history;
  // the system message itself is rebuilt fresh next turn.
  // Exception: if the turn ended with a genuinely empty final response (no narration, no tool
  // calls -- the AI failed to generate anything at all), don't persist that empty message. It
  // would just sit in the transcript as a blank, confusing bubble forever; the player already
  // saw a clear error via the 'error' event above and can just try sending again. This never
  // fires when pendingChoice is set -- that last message genuinely does have tool_calls (the
  // present_choice call itself), so it's real, wanted history, not an empty one to discard.
  const trimmedMessages = updated.slice(1);
  const lastMessage = trimmedMessages[trimmedMessages.length - 1];
  if (lastMessage && lastMessage.role === 'assistant' && !(lastMessage.content || '').trim() && (!lastMessage.tool_calls || lastMessage.tool_calls.length === 0)) {
    trimmedMessages.pop();
  }
  record.messages = trimmedMessages;
  record.pendingChoice = pendingChoice;

  logDebugTurn(config, campaignId, { trigger: 'chat:send', userInput: text, systemPrompt: systemMessage.content, events: capturedEvents, updated, pendingChoice });

  if (pendingChoice) {
    // The turn genuinely hasn't finished -- present_choice deferred the rest of it to the
    // player. Skip compaction (nothing gained from summarizing mid-turn, and it can safely wait
    // one more turn) and skip the "what did the GM say" reply extraction below, since there
    // isn't a real narration yet -- just save what's there and hand the choice itself back to
    // the renderer so it can show the picker instead of treating this as a completed turn.
    saveCampaign(campaignId);
    return { reply: '', state: record.state, pendingChoice };
  }

  // Multi-layer context compaction: if the raw message history has grown past the verbatim
  // window, fold the oldest chunk into campaignState.storySummary (see summarizer.cjs for the
  // full tiering scheme). Runs every turn but is a no-op below the threshold, and never throws --
  // a failed summarization call just leaves history untouched for this turn and gets retried
  // next time, rather than blocking the player's turn on a maintenance step.
  await summarizer.maybeCompact({ apiKey: config.apiKey, model: config.model, record, campaignState: record.state });

  saveCampaign(campaignId);

  const lastAssistant = [...updated].reverse().find((m) => m.role === 'assistant' && m.content);
  return { reply: lastAssistant ? lastAssistant.content : '', state: record.state, pendingChoice: null };
});

// Continues a turn that present_choice paused, now that the player has actually answered --
// see runTurn's own doc comment in openrouter.cjs for the full design. Appends a real tool-role
// response for the present_choice call using the player's answer as content, defensively
// resolves any OTHER tool_calls from that same batch that never got a response either (a
// well-behaved model calls present_choice alone, per its own tool description, but this keeps
// the conversation valid even if one doesn't), then re-enters the normal turn loop to let the
// GM continue narrating from here -- which may itself end in another pendingChoice, handled
// exactly the same way as the first.
ipcMain.handle('chat:resolve-choice', async (evt, { campaignId = 'default', chosenText }) => {
  const config = store.loadConfig(userDataDir());
  if (!config.apiKey) {
    throw new Error('No OpenRouter API key configured. Set one in Settings first.');
  }
  const record = loadCampaign(campaignId);
  if (!record.pendingChoice) {
    throw new Error('No choice is currently pending for this campaign.');
  }
  const pending = record.pendingChoice;

  const lastMessage = record.messages[record.messages.length - 1];
  const alreadyResolvedIds = new Set(record.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  const toolResults = [];
  for (const call of (lastMessage && lastMessage.tool_calls) || []) {
    if (alreadyResolvedIds.has(call.id)) continue;
    if (call.id === pending.toolCallId) {
      toolResults.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ player_chose: chosenText }) });
    } else {
      // A tool call bundled after present_choice in the same batch, never executed -- give it a
      // real, honest placeholder rather than leaving the conversation permanently invalid.
      toolResults.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'Skipped -- a player choice had to be resolved first.' }) });
    }
  }

  record.messages = [...record.messages, ...toolResults];
  record.pendingChoice = null;

  const systemMessage = { role: 'system', content: buildSystemPrompt(record.state, config.moveChoiceThreshold, config.narrativeRules) };
  const withSystem = [systemMessage, ...record.messages];

  const capturedEvents = [];
  const sendEvent = (event) => {
    capturedEvents.push(event);
    evt.sender.send('chat:event', { campaignId, ...event });
  };

  const { messages: updated, pendingChoice: nextPendingChoice } = await runTurn({
    apiKey: config.apiKey,
    model: config.model,
    messages: withSystem,
    campaignState: record.state,
    imageGen: buildImageGen(),
    temperature: config.temperature,
    topP: config.topP,
    onEvent: sendEvent,
  });

  const trimmedMessages = updated.slice(1);
  const lastUpdated = trimmedMessages[trimmedMessages.length - 1];
  if (lastUpdated && lastUpdated.role === 'assistant' && !(lastUpdated.content || '').trim() && (!lastUpdated.tool_calls || lastUpdated.tool_calls.length === 0)) {
    trimmedMessages.pop();
  }
  record.messages = trimmedMessages;
  record.pendingChoice = nextPendingChoice;

  logDebugTurn(config, campaignId, { trigger: 'chat:resolve-choice', userInput: chosenText, systemPrompt: systemMessage.content, events: capturedEvents, updated, pendingChoice: nextPendingChoice });

  if (nextPendingChoice) {
    saveCampaign(campaignId);
    return { reply: '', state: record.state, pendingChoice: nextPendingChoice };
  }

  await summarizer.maybeCompact({ apiKey: config.apiKey, model: config.model, record, campaignState: record.state });
  saveCampaign(campaignId);

  const lastAssistant = [...updated].reverse().find((m) => m.role === 'assistant' && m.content);
  return { reply: lastAssistant ? lastAssistant.content : '', state: record.state, pendingChoice: null };
});

// Powers Undo, Regenerate, and Edit in the UI -- all three share this one primitive. Regenerate
// calls this then immediately re-sends the returned undoneUserText via chat:send unmodified;
// Edit calls this and lets the player change the text before resending; a bare Undo just stops
// here and leaves the composer empty. Single-level by design (see the undoCheckpoints comment
// above) -- errors clearly if there's nothing to undo, rather than silently no-op-ing, so the UI
// can disable the button correctly instead of the player wondering why nothing happened.
// Composes an image-generation prompt via a small, focused, non-conversational OpenRouter call
// (see promptComposer.cjs) -- built server-side from real campaign context (character
// description, notable assets, a recent-story slice, or the specific connection/location's own
// fields) rather than the frontend's old plain string template, and rather than routing through
// the main GM conversation loop, which would clutter the actual campaign transcript with
// "please write me an image prompt" exchanges that aren't part of the story.
ipcMain.handle('image:compose-prompt', async (_evt, { campaignId = 'default', kind, subjectId }) => {
  const config = store.loadConfig(userDataDir());
  if (!config.apiKey) {
    throw new Error('No OpenRouter API key configured. Set one in Settings first.');
  }
  const record = loadCampaign(campaignId);
  const state = record.state;

  // Prefer the compressed recent-tier story summary when one exists -- it's already a tight,
  // curated recap (see summarizer.cjs) -- and fall back to the last few raw log entries early in
  // a campaign, before enough has happened to have compacted anything yet.
  const recentStory = state.storySummary.recent || state.log.slice(-3).map((e) => e.text).join(' ');

  let context = {};
  if (kind === 'portrait') {
    context = {
      name: state.character.name,
      pronouns: state.character.pronouns,
      description: state.character.description,
      assetNames: state.character.assets.map((a) => a.name),
      recentStory,
    };
  } else if (kind === 'connection') {
    const conn = (state.connections || []).find((c) => c.id === subjectId);
    context = conn
      ? { name: conn.name, role: [conn.role, conn.secondRole].filter(Boolean).join(' / '), notes: conn.notes, recentStory }
      : { recentStory };
  } else if (kind === 'location') {
    const sector = state.sectors[state.currentSectorId];
    const cell = sector && sector.cells[subjectId];
    context = cell
      ? { name: cell.name, notes: cell.notes, features: (cell.features || []).map((f) => `${f.type}: ${f.name}`), sectorNotes: sector.notes }
      : {};
  } else {
    context = { recentStory, characterName: state.character.name, characterDescription: state.character.description };
  }

  return promptComposer.composeImagePrompt({ apiKey: config.apiKey, model: config.model, kind, context, temperature: config.temperature, topP: config.topP });
});

ipcMain.handle('chat:undo', (_evt, { campaignId = 'default' }) => {
  const checkpoint = undoCheckpoints.get(campaignId);
  if (!checkpoint) {
    throw new Error('Nothing to undo -- either no turn has been sent yet, or the last one was already undone.');
  }
  const record = loadCampaign(campaignId);
  record.messages = checkpoint.messages;
  record.state = checkpoint.state;
  undoCheckpoints.delete(campaignId);
  saveCampaign(campaignId);
  return { state: record.state, messages: record.messages, undoneUserText: checkpoint.undoneUserText };
});
