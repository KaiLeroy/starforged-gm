'use strict';

const fs = require('fs');
const path = require('path');
const { assertCampaignId } = require('./validation.cjs');

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATIONS = 3;
const MAX_LOG_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function debugLogsDir(userDataDir) {
  return path.join(userDataDir, 'debug-logs');
}

function debugLogPath(userDataDir, campaignId = 'default', rotation = 0) {
  assertCampaignId(campaignId);
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > MAX_ROTATIONS) throw new Error('Invalid debug-log rotation.');
  return path.join(debugLogsDir(userDataDir), `${campaignId}.jsonl${rotation ? `.${rotation}` : ''}`);
}

function restrictPermissions(target, mode) {
  try { fs.chmodSync(target, mode); } catch { /* Best effort on filesystems without POSIX modes. */ }
}

function clearExpiredLogs(userDataDir, campaignId, now = Date.now()) {
  const removed = [];
  for (let rotation = 0; rotation <= MAX_ROTATIONS; rotation += 1) {
    const file = debugLogPath(userDataDir, campaignId, rotation);
    if (fs.existsSync(file) && now - fs.statSync(file).mtimeMs > MAX_LOG_AGE_MS) {
      fs.unlinkSync(file);
      removed.push(file);
    }
  }
  return removed;
}

function rotate(userDataDir, campaignId) {
  const oldest = debugLogPath(userDataDir, campaignId, MAX_ROTATIONS);
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (let rotation = MAX_ROTATIONS - 1; rotation >= 0; rotation -= 1) {
    const from = debugLogPath(userDataDir, campaignId, rotation);
    if (fs.existsSync(from)) fs.renameSync(from, debugLogPath(userDataDir, campaignId, rotation + 1));
  }
}

function appendDebugLog(userDataDir, campaignId, entry, now = Date.now()) {
  const dir = debugLogsDir(userDataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictPermissions(dir, 0o700);
  clearExpiredLogs(userDataDir, campaignId, now);
  const timestamp = new Date(now).toISOString();
  const record = `${JSON.stringify({ timestamp, campaignId, ...entry }, null, 2)}\n\n`;
  const bytes = Buffer.byteLength(record, 'utf8');
  if (bytes > MAX_LOG_BYTES) throw new Error('One debug entry exceeds the 5 MB log limit.');
  const current = debugLogPath(userDataDir, campaignId);
  if (fs.existsSync(current) && fs.statSync(current).size + bytes > MAX_LOG_BYTES) rotate(userDataDir, campaignId);
  fs.appendFileSync(current, record, { encoding: 'utf8', mode: 0o600 });
  restrictPermissions(current, 0o600);
  return debugLogStatus(userDataDir, campaignId);
}

function debugLogFiles(userDataDir, campaignId) {
  const files = [];
  for (let rotation = MAX_ROTATIONS; rotation >= 0; rotation -= 1) {
    const file = debugLogPath(userDataDir, campaignId, rotation);
    if (fs.existsSync(file)) files.push(file);
  }
  return files;
}

function debugLogStatus(userDataDir, campaignId) {
  const files = debugLogFiles(userDataDir, campaignId);
  return {
    exists: files.length > 0,
    fileCount: files.length,
    sizeBytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0),
    maxBytesPerFile: MAX_LOG_BYTES,
    maxFiles: MAX_ROTATIONS + 1,
    maxAgeDays: Math.round(MAX_LOG_AGE_MS / (24 * 60 * 60 * 1000)),
  };
}

function clearDebugLogs(userDataDir, campaignId) {
  const files = debugLogFiles(userDataDir, campaignId);
  for (const file of files) fs.unlinkSync(file);
  return { deleted: files.length };
}

function pruneExpiredDebugLogs(userDataDir, now = Date.now()) {
  const dir = debugLogsDir(userDataDir);
  const removed = [];
  if (!fs.existsSync(dir)) return removed;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.jsonl(?:\.[1-3])?$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (now - fs.statSync(file).mtimeMs > MAX_LOG_AGE_MS) {
      fs.unlinkSync(file);
      removed.push(file);
    }
  }
  return removed;
}

function exportDebugLogs(userDataDir, campaignId, destination) {
  const files = debugLogFiles(userDataDir, campaignId);
  if (files.length === 0) throw new Error('No debug log exists for this campaign yet.');
  const content = files.map((file) => fs.readFileSync(file, 'utf8').trimEnd()).join('\n\n');
  fs.writeFileSync(destination, `${content}\n`, { encoding: 'utf8', mode: 0o600 });
  restrictPermissions(destination, 0o600);
  return { filePath: destination, fileCount: files.length };
}

module.exports = {
  MAX_LOG_BYTES,
  MAX_ROTATIONS,
  MAX_LOG_AGE_MS,
  debugLogsDir,
  debugLogPath,
  appendDebugLog,
  debugLogStatus,
  clearDebugLogs,
  clearExpiredLogs,
  pruneExpiredDebugLogs,
  exportDebugLogs,
};
