'use strict';
const fs = require('fs');
const path = require('path');

function configPath(userDataDir) {
  return path.join(userDataDir, 'config.json');
}

function campaignPath(userDataDir, campaignId = 'default') {
  return path.join(userDataDir, 'campaigns', `${campaignId}.json`);
}

function campaignBackupPath(userDataDir, campaignId = 'default') {
  return `${campaignPath(userDataDir, campaignId)}.bak`;
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Replaces a file through a sibling temporary file so a process interruption leaves either the
 * old complete file or the new complete file, never a partially-written JSON document.
 */
function replaceFileAtomically(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf-8', flag: 'wx' });
    fsyncFile(temporary);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Saves a complete campaign atomically and retains the previous valid version as `.bak`. */
function saveCampaignRecord(userDataDir, campaignId, record) {
  const file = campaignPath(userDataDir, campaignId);
  const backup = campaignBackupPath(userDataDir, campaignId);
  const serialized = JSON.stringify(record, null, 2);
  // Prove the value can be parsed before it replaces anything. JSON.stringify can only produce
  // JSON-safe output here, but this also guards future serializer changes at the write boundary.
  JSON.parse(serialized);

  if (fs.existsSync(file)) {
    const previous = fs.readFileSync(file, 'utf-8');
    try {
      JSON.parse(previous);
      replaceFileAtomically(backup, previous);
    } catch {
      // Never replace a known-good backup with an already-corrupt primary file.
    }
  }
  replaceFileAtomically(file, serialized);
  return file;
}

/**
 * Loads a campaign, automatically restoring the last known-good backup if the primary JSON is
 * unreadable. The broken primary is retained as `.corrupt` for diagnosis.
 */
function loadCampaignRecord(userDataDir, campaignId) {
  const file = campaignPath(userDataDir, campaignId);
  const primaryText = fs.readFileSync(file, 'utf-8');
  try {
    return { record: JSON.parse(primaryText), recoveredFromBackup: false };
  } catch (primaryError) {
    const backup = campaignBackupPath(userDataDir, campaignId);
    if (!fs.existsSync(backup)) throw primaryError;
    const backupText = fs.readFileSync(backup, 'utf-8');
    const record = JSON.parse(backupText);
    try {
      replaceFileAtomically(`${file}.corrupt`, primaryText);
    } catch {
      // Recovery must not be blocked merely because the diagnostic copy could not be written.
    }
    replaceFileAtomically(file, backupText);
    return { record, recoveredFromBackup: true };
  }
}

function imagesDir(userDataDir) {
  return path.join(userDataDir, 'images');
}

function debugLogsDir(userDataDir) {
  return path.join(userDataDir, 'debug-logs');
}

function debugLogPath(userDataDir, campaignId = 'default') {
  return path.join(debugLogsDir(userDataDir), `${campaignId}.jsonl`);
}

/**
 * Appends one complete turn's diagnostic record to a per-campaign JSON Lines log --
 * requested directly, to help tell apart an app bug (wrong/missing guidance in the system
 * prompt, a broken tool) from a model failure (ignoring or misreading guidance that was
 * actually correct) for any specific turn. Each entry is still appended independently (no
 * need to read, parse, and rewrite the whole -- potentially large, over a long campaign --
 * file on every single turn the way a single top-level array would require), but pretty-
 * printed and separated by a blank line, rather than one compact, unreadable line per entry --
 * a real turn's own systemPrompt field alone commonly runs past 100,000 characters, and a
 * single giant escaped line is unreadable directly in an editor even with the rest of the
 * object indented nicely around it. Still one genuine, self-contained JSON value per entry
 * (parse with JSON.parse on the text between blank-line boundaries, or split the whole file on
 * /\n\n(?=\{)/), just no longer one single physical line -- that tradeoff is deliberate here,
 * since actual readability mattered more than the strict one-line-per-record JSONL convention.
 * Entirely opt-in (see config.debugLogging in main.cjs) -- never written unless the player has
 * actually turned it on, since this captures the complete system prompt text (which changes
 * with campaign state, so it's genuinely useful to see the exact version a specific turn
 * actually received) and could otherwise grow large silently for players who never asked for it.
 */
function appendDebugLog(userDataDir, campaignId, entry) {
  const dir = debugLogsDir(userDataDir);
  fs.mkdirSync(dir, { recursive: true });
  const record = JSON.stringify({ timestamp: new Date().toISOString(), campaignId, ...entry }, null, 2);
  fs.appendFileSync(debugLogPath(userDataDir, campaignId), record + '\n\n', 'utf-8');
}

/** Saves generated image bytes to disk and returns an id to reference it by (not the raw path --
 *  the renderer never touches the filesystem directly; it asks for a data URL via IPC instead). */
function saveImage(userDataDir, buffer, ext = 'png') {
  const dir = imagesDir(userDataDir);
  fs.mkdirSync(dir, { recursive: true });
  const id = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(path.join(dir, `${id}.${ext}`), buffer);
  return id;
}

function loadImageAsDataUrl(userDataDir, imageId, mime = 'image/png') {
  if (!imageId) return null;
  const ext = mime === 'image/png' ? 'png' : 'bin';
  const file = path.join(imagesDir(userDataDir), `${imageId}.${ext}`);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function deleteImage(userDataDir, imageId, mime = 'image/png') {
  if (!imageId) return;
  const ext = mime === 'image/png' ? 'png' : 'bin';
  const file = path.join(imagesDir(userDataDir), `${imageId}.${ext}`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function campaignStateReferencesImage(state, imageId) {
  if (!state || !imageId) return false;
  if (state.character && state.character.portraitImageId === imageId) return true;
  if ((state.connections || []).some((connection) => connection.imageId === imageId)) return true;
  if ((state.illustrations || []).some((illustration) => illustration.imageId === imageId)) return true;
  return Object.values(state.sectors || {}).some((sector) =>
    Object.values(sector.cells || {}).some((cell) => cell.imageId === imageId)
  );
}

/** Checks both loaded records and saves that have not been loaded into this process. */
function imageReferencedByAnyCampaign(userDataDir, imageId, loadedCampaigns = new Map()) {
  const checked = new Set();
  for (const [campaignId, record] of loadedCampaigns) {
    checked.add(campaignId);
    if (campaignStateReferencesImage(record && record.state, imageId)) return true;
  }
  for (const campaignId of listCampaigns(userDataDir)) {
    if (checked.has(campaignId)) continue;
    try {
      const { record } = loadCampaignRecord(userDataDir, campaignId);
      if (campaignStateReferencesImage(record && record.state, imageId)) return true;
    } catch {
      // A corrupt unrelated campaign cannot prove a reference. Its own recovery remains available
      // when it is opened; do not make every image operation fail because of it.
    }
  }
  return false;
}


function loadConfig(userDataDir) {
  const p = configPath(userDataDir);
  if (!fs.existsSync(p)) return { apiKey: '', model: 'anthropic/claude-sonnet-4.5', comfyUrl: 'http://127.0.0.1:8188', comfyWorkflow: '', temperature: null, topP: null, moveChoiceThreshold: 'almost_certain', debugLogging: false };
  const config = JSON.parse(fs.readFileSync(p, 'utf-8'));
  // temperature/topP default to null (use the model's own default, not sent to OpenRouter at
  // all) both for a genuinely fresh config above and for one saved before these fields existed --
  // an old config.json on disk simply won't have the keys, so the spread below leaves them
  // undefined without this explicit fallback, and undefined here would behave differently from
  // the deliberate every-other-load "null" a user gets by clearing the field in Settings.
  // moveChoiceThreshold defaults to 'almost_certain' -- the most permissive setting, meaning
  // present_choice fires even when the AI is almost certain which move applies, matching the
  // existing "ask by default, gated only by triviality" policy exactly. A genuinely fresh
  // install and an old config predating this setting should both start there, not at some
  // narrower default that would silently change established behavior without the player asking.
  // debugLogging defaults to false -- opt-in only, both for a fresh install and an old config
  // predating this field, since it captures the full system prompt text every turn and
  // shouldn't start writing to disk for anyone who never asked for it.
  return { comfyUrl: 'http://127.0.0.1:8188', comfyWorkflow: '', temperature: null, topP: null, moveChoiceThreshold: 'almost_certain', debugLogging: false, ...config };
}

function saveConfig(userDataDir, config) {
  const p = configPath(userDataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8');
}

function listCampaigns(userDataDir) {
  const dir = path.join(userDataDir, 'campaigns');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

function deleteCampaign(userDataDir, campaignId) {
  const primary = campaignPath(userDataDir, campaignId);
  for (const file of [primary, campaignBackupPath(userDataDir, campaignId), `${primary}.corrupt`]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

module.exports = {
  configPath,
  campaignPath,
  campaignBackupPath,
  saveCampaignRecord,
  loadCampaignRecord,
  imagesDir,
  debugLogsDir,
  debugLogPath,
  appendDebugLog,
  loadConfig,
  saveConfig,
  listCampaigns,
  deleteCampaign,
  saveImage,
  loadImageAsDataUrl,
  deleteImage,
  campaignStateReferencesImage,
  imageReferencedByAnyCampaign,
};
