'use strict';
const fs = require('fs');
const path = require('path');
const { assertCampaignId, MAX_IMPORT_BYTES } = require('./validation.cjs');
const imageStore = require('./imageStore.cjs');
const debugLog = require('./debugLog.cjs');

function configPath(userDataDir) {
  return path.join(userDataDir, 'config.json');
}

function campaignPath(userDataDir, campaignId = 'default') {
  assertCampaignId(campaignId);
  return path.join(userDataDir, 'campaigns', `${campaignId}.json`);
}

function campaignBackupPath(userDataDir, campaignId = 'default') {
  return `${campaignPath(userDataDir, campaignId)}.bak`;
}

function fsyncFile(file) {
  // Windows requires a writable handle for FlushFileBuffers; r+ works there and on POSIX.
  const fd = fs.openSync(file, 'r+');
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
function saveCampaignRecord(userDataDir, campaignId, record, { expectedRevision } = {}) {
  const file = campaignPath(userDataDir, campaignId);
  const backup = campaignBackupPath(userDataDir, campaignId);
  if (expectedRevision !== undefined) {
    let currentRevision = 0;
    if (fs.existsSync(file)) {
      const current = JSON.parse(fs.readFileSync(file, 'utf-8'));
      currentRevision = Number.isInteger(current.revision) ? current.revision : 0;
    }
    if (currentRevision !== expectedRevision) {
      throw new Error(`Campaign changed on disk (expected revision ${expectedRevision}, found ${currentRevision}). Reload and retry.`);
    }
    record.revision = currentRevision + 1;
  }
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
  if (fs.statSync(file).size > MAX_IMPORT_BYTES) throw new Error('Campaign save exceeds the 20 MB safety limit.');
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

function allCampaignRecords(userDataDir, loadedCampaigns = new Map()) {
  const records = [];
  const checked = new Set();
  let complete = true;
  for (const [campaignId, record] of loadedCampaigns) {
    checked.add(campaignId);
    records.push(record);
  }
  for (const campaignId of listCampaigns(userDataDir)) {
    if (!checked.has(campaignId)) {
      try { records.push(loadCampaignRecord(userDataDir, campaignId).record); }
      catch { complete = false; }
    }
    // Recovery backups are reference roots too. Keeping their images means restoring a campaign
    // after a later primary-file failure cannot resurrect dangling image IDs. The next successful
    // save rotates the backup and makes superseded images collectible.
    const backup = campaignBackupPath(userDataDir, campaignId);
    if (fs.existsSync(backup)) {
      try {
        if (fs.statSync(backup).size > MAX_IMPORT_BYTES) throw new Error('Oversized campaign backup.');
        records.push(JSON.parse(fs.readFileSync(backup, 'utf8')));
      } catch { complete = false; }
    }
  }
  return { records, complete };
}

function imageReferencedByAnyCampaign(userDataDir, imageId, loadedCampaigns = new Map()) {
  const { records, complete } = allCampaignRecords(userDataDir, loadedCampaigns);
  if (!complete) return true;
  return records.some((record) => imageStore.campaignStateReferencesImage(record && record.state, imageId));
}

function collectOrphanImages(userDataDir, loadedCampaigns = new Map()) {
  const { records, complete } = allCampaignRecords(userDataDir, loadedCampaigns);
  return imageStore.collectOrphanImages(userDataDir, records, { complete });
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
    .map((f) => f.replace(/\.json$/, ''))
    .filter((id) => {
      try { assertCampaignId(id); return true; } catch { return false; }
    });
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
  ...imageStore,
  ...debugLog,
  loadConfig,
  saveConfig,
  listCampaigns,
  deleteCampaign,
  imageReferencedByAnyCampaign,
  collectOrphanImages,
};
