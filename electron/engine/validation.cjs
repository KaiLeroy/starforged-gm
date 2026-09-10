'use strict';

const campaignSchema = require('./campaignSchema.cjs');

const CAMPAIGN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const IMAGE_ID_RE = /^img-[a-z0-9]+-[a-z0-9]{6}$/;
const MAX_IPC_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGES = 5000;
const MAX_MESSAGE_CHARS = 256 * 1024;

function fail(message) {
  throw new Error(`Invalid input: ${message}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertPlainObject(value, label = 'payload') {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  return value;
}

function assertString(value, label, { min = 0, max = 10000 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(`${label} must be a string between ${min} and ${max} characters.`);
  }
  return value;
}

function assertCampaignId(value, label = 'campaignId') {
  if (typeof value !== 'string' || !CAMPAIGN_ID_RE.test(value)) fail(`${label} is not a valid campaign id.`);
  return value;
}

function assertImageId(value, label = 'imageId') {
  if (typeof value !== 'string' || !IMAGE_ID_RE.test(value)) fail(`${label} is not a valid image id.`);
  return value;
}

function assertLoopbackHttpUrl(value, label = 'URL') {
  assertString(value, label, { min: 1, max: 2048 });
  let url;
  try { url = new URL(value); } catch { fail(`${label} must be a valid URL.`); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || !(host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host))) {
    fail(`${label} must be an HTTP(S) loopback URL.`);
  }
  return value;
}

function assertJsonSafe(value, label = 'payload', depth = 0) {
  if (depth > 40) fail(`${label} is nested too deeply.`);
  if (value === undefined) return;
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > MAX_MESSAGE_CHARS) fail(`${label} contains an oversized string.`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10000) fail(`${label} contains too many items.`);
    value.forEach((item, index) => assertJsonSafe(item, `${label}[${index}]`, depth + 1));
    return;
  }
  assertPlainObject(value, label);
  const keys = Object.keys(value);
  if (keys.length > 10000) fail(`${label} contains too many fields.`);
  for (const key of keys) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail(`${label} contains a forbidden key.`);
    assertJsonSafe(value[key], `${label}.${key}`, depth + 1);
  }
}

function assertBoundedJson(value, label = 'payload', maxBytes = MAX_IPC_BYTES) {
  assertJsonSafe(value, label);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) fail(`${label} is too large.`);
  return value;
}

function assertConfig(config) {
  assertPlainObject(config, 'config');
  const allowed = new Set(['apiKey', 'clearApiKey', 'model', 'comfyUrl', 'comfyWorkflow', 'temperature', 'topP', 'moveChoiceThreshold', 'debugLogging', 'narrativeRules', 'hasApiKey']);
  for (const key of Object.keys(config)) if (!allowed.has(key)) fail(`config.${key} is not supported.`);
  if ('apiKey' in config) assertString(config.apiKey, 'config.apiKey', { max: 512 });
  if ('clearApiKey' in config && typeof config.clearApiKey !== 'boolean') fail('config.clearApiKey must be boolean.');
  assertString(config.model, 'config.model', { min: 1, max: 200 });
  assertString(config.comfyUrl, 'config.comfyUrl', { max: 2048 });
  if (config.comfyUrl) {
    assertLoopbackHttpUrl(config.comfyUrl, 'config.comfyUrl');
  }
  assertString(config.comfyWorkflow, 'config.comfyWorkflow', { max: 1024 * 1024 });
  for (const [key, min, max] of [['temperature', 0, 2], ['topP', 0, 1]]) {
    const value = config[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)) {
      fail(`config.${key} must be null or between ${min} and ${max}.`);
    }
  }
  if (!['almost_certain', 'likely', '50_50', 'unlikely', 'small_chance'].includes(config.moveChoiceThreshold)) fail('config.moveChoiceThreshold is invalid.');
  if (typeof config.debugLogging !== 'boolean') fail('config.debugLogging must be boolean.');
  if (config.narrativeRules !== undefined) assertString(config.narrativeRules, 'config.narrativeRules', { max: 20000 });
  return config;
}

function assertCharacter(character) {
  assertPlainObject(character, 'character');
  const allowed = new Set(['name', 'callsign', 'pronouns', 'description', 'stats']);
  for (const key of Object.keys(character)) if (!allowed.has(key)) fail(`character.${key} is not supported during character creation.`);
  assertString(character.name, 'character.name', { max: 200 });
  for (const field of ['callsign', 'pronouns', 'description']) if (character[field] !== undefined) assertString(character[field], `character.${field}`, { max: field === 'description' ? 10000 : 200 });
  if (character.stats !== undefined) {
    assertPlainObject(character.stats, 'character.stats');
    const stats = ['edge', 'heart', 'iron', 'shadow', 'wits'];
    if (Object.keys(character.stats).length !== stats.length) fail('character.stats must contain all five stats and no other fields.');
    for (const stat of stats) if (!Number.isInteger(character.stats[stat]) || character.stats[stat] < 1 || character.stats[stat] > 3) fail(`character.stats.${stat} must be an integer from 1 to 3.`);
  }
  return character;
}

function assertCampaignRecord(record, options) {
  assertBoundedJson(record, 'campaign import', MAX_IMPORT_BYTES);
  return campaignSchema.normalizeCampaignRecord(record, options);
}

function assertCharacterExport(value) {
  assertBoundedJson(value, 'character import', MAX_IMPORT_BYTES);
  return campaignSchema.normalizeCharacterExport(value);
}

function validateIpcPayload(channel, payload) {
  if (payload === undefined) return payload;
  assertBoundedJson(payload);
  if (channel === 'config:set') return assertConfig(payload);
  if (channel === 'campaign:get' || channel === 'campaign:delete') return assertCampaignId(payload);
  if (channel === 'shell:open-external') {
    const url = new URL(assertString(payload, 'url', { min: 1, max: 2048 }));
    if (!['https:', 'http:'].includes(url.protocol)) fail('only HTTP(S) links may be opened.');
    return payload;
  }
  if (channel === 'comfy:test-connection') {
    assertPlainObject(payload);
    assertLoopbackHttpUrl(payload.comfyUrl, 'comfyUrl');
    return payload;
  }
  if (isPlainObject(payload)) {
    if (payload.campaignId !== undefined) assertCampaignId(payload.campaignId);
    if (payload.imageId !== undefined) assertImageId(payload.imageId);
    const requiredStrings = new Set(['imageId', 'text', 'prompt', 'name', 'id', 'chosenText', 'oracleId', 'cell', 'featureId', 'passageId', 'assetId', 'connectionId', 'category', 'kind']);
    const optionalStrings = new Set(['sectorId', 'toSectorId', 'toCell', 'notes', 'description', 'caption', 'location', 'region', 'factionControl', 'callsign', 'pronouns', 'backgroundVow', 'subjectId', 'result', 'subtableResult', 'questStarter', 'type', 'condition']);
    for (const [key, value] of Object.entries(payload)) {
      if (requiredStrings.has(key)) assertString(value, key, { min: 1, max: key === 'text' || key === 'prompt' ? 50000 : 10000 });
      if (optionalStrings.has(key) && value != null) assertString(value, key, { max: 10000 });
      if (['marked'].includes(key) && typeof value !== 'boolean') fail(`${key} must be boolean.`);
      if (['amount', 'segments'].includes(key) && !Number.isInteger(value)) fail(`${key} must be an integer.`);
    }
    if (payload.startingAssetIds !== undefined) {
      if (!Array.isArray(payload.startingAssetIds) || payload.startingAssetIds.length !== 3 || new Set(payload.startingAssetIds).size !== 3) fail('startingAssetIds must contain exactly three unique ids.');
      payload.startingAssetIds.forEach((id, i) => assertString(id, `startingAssetIds[${i}]`, { min: 1, max: 500 }));
    }
    if (channel === 'campaign:new' && payload.character) assertCharacter(payload.character);
    if (channel === 'campaign:apply_imported_character') {
      assertCharacterExport({ kind: 'starforged-character-export', version: campaignSchema.CHARACTER_SCHEMA_VERSION, character: payload.character, truths: payload.truths || {}, backgroundVow: payload.backgroundVow || null });
    }
  }
  return payload;
}

module.exports = {
  CAMPAIGN_ID_RE,
  IMAGE_ID_RE,
  MAX_IMPORT_BYTES,
  assertCampaignId,
  assertImageId,
  assertLoopbackHttpUrl,
  assertConfig,
  assertCampaignRecord,
  assertCharacterExport,
  CAMPAIGN_SCHEMA_VERSION: campaignSchema.CAMPAIGN_SCHEMA_VERSION,
  CHARACTER_SCHEMA_VERSION: campaignSchema.CHARACTER_SCHEMA_VERSION,
  validateIpcPayload,
};
