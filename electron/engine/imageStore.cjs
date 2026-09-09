'use strict';

const fs = require('fs');
const path = require('path');
const { assertImageId } = require('./validation.cjs');

const IMAGE_FILE_RE = /^(img-[a-z0-9]+-[a-z0-9]{6})\.(png|bin)$/;

function imagesDir(userDataDir) {
  return path.join(userDataDir, 'images');
}

function imagePath(userDataDir, imageId, mime = 'image/png') {
  assertImageId(imageId);
  return path.join(imagesDir(userDataDir), `${imageId}.${mime === 'image/png' ? 'png' : 'bin'}`);
}

function saveImage(userDataDir, buffer, ext = 'png') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Cannot save an empty image.');
  if (!['png', 'bin'].includes(ext)) throw new Error('Unsupported image extension.');
  const dir = imagesDir(userDataDir);
  fs.mkdirSync(dir, { recursive: true });
  const id = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(path.join(dir, `${id}.${ext}`), buffer, { mode: 0o600 });
  return id;
}

function loadImageAsDataUrl(userDataDir, imageId, mime = 'image/png') {
  if (!imageId) return null;
  const file = imagePath(userDataDir, imageId, mime);
  if (!fs.existsSync(file)) return null;
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

function deleteImage(userDataDir, imageId, mime = 'image/png') {
  if (!imageId) return false;
  const file = imagePath(userDataDir, imageId, mime);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

function referencedImageIds(state) {
  const ids = new Set();
  const add = (id) => { if (typeof id === 'string') ids.add(id); };
  if (!state) return ids;
  add(state.character && state.character.portraitImageId);
  for (const connection of state.connections || []) add(connection.imageId);
  for (const illustration of state.illustrations || []) add(illustration.imageId);
  for (const sector of Object.values(state.sectors || {})) {
    for (const cell of Object.values(sector.cells || {})) add(cell.imageId);
  }
  return ids;
}

function campaignStateReferencesImage(state, imageId) {
  return referencedImageIds(state).has(imageId);
}

/**
 * Deletes files that no supplied campaign record references. Callers must supply every
 * persisted and loaded record; if any record could not be read, pass `complete: false` and the
 * collector safely refuses to delete anything.
 */
function collectOrphanImages(userDataDir, records, { complete = true } = {}) {
  const dir = imagesDir(userDataDir);
  const result = { scanned: 0, deleted: [], skipped: [], complete };
  if (!complete || !fs.existsSync(dir)) return result;
  const referenced = new Set();
  for (const record of records) {
    for (const id of referencedImageIds(record && record.state)) referenced.add(id);
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = IMAGE_FILE_RE.exec(entry.name);
    if (!match) { result.skipped.push(entry.name); continue; }
    result.scanned += 1;
    if (!referenced.has(match[1])) {
      fs.unlinkSync(path.join(dir, entry.name));
      result.deleted.push(match[1]);
    }
  }
  return result;
}

module.exports = {
  IMAGE_FILE_RE,
  imagesDir,
  imagePath,
  saveImage,
  loadImageAsDataUrl,
  deleteImage,
  referencedImageIds,
  campaignStateReferencesImage,
  collectOrphanImages,
};
