'use strict';
const fs = require('fs');
const path = require('path');

function configPath(userDataDir) {
  return path.join(userDataDir, 'config.json');
}

function campaignPath(userDataDir, campaignId = 'default') {
  return path.join(userDataDir, 'campaigns', `${campaignId}.json`);
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
  const p = campaignPath(userDataDir, campaignId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

module.exports = {
  configPath,
  campaignPath,
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
};
