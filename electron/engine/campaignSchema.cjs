'use strict';

const stateMod = require('./state.cjs');
const dataMod = require('./data.cjs');
const diceMod = require('./dice.cjs');

const CAMPAIGN_SCHEMA_VERSION = 2;
const CHARACTER_SCHEMA_VERSION = 2;
const IMAGE_ID_RE = /^img-[a-z0-9]+-[a-z0-9]{6}$/;
const CELL_ID_RE = /^(?:[0-9]|1[01]),[0-7]$/;
const RANKS = ['troublesome', 'dangerous', 'formidable', 'extreme', 'epic'];
const TRACK_TYPES = ['vow', 'combat', 'expedition', 'connection', 'legacy', 'scene_challenge'];
const FEATURE_TYPES = ['star', 'planet', 'settlement', 'derelict', 'vault', 'starship', 'npc', 'creature', 'faction', 'sighting', 'other'];
const ELEMENT_CATEGORIES = ['People', 'Factions', 'Locations', 'Threads', 'Items & Vehicles', 'Themes', 'Other'];
const OUTCOMES = ['strong_hit', 'weak_hit', 'miss'];
const MAX = { collection: 10000, messages: 5000, text: 256 * 1024, id: 500, assets: 100, ledger: 200 };
const LEGACY_TRACKS = [
  { id: 'legacy-quests', name: 'Quests' },
  { id: 'legacy-bonds', name: 'Bonds' },
  { id: 'legacy-discoveries', name: 'Discoveries' },
];

function fail(message) { throw new Error(`Invalid input: ${message}`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${label} must be a plain object.`);
  return value;
}
function keys(value, label, allowed, required = allowed) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}.${key} is not supported by schema v${CAMPAIGN_SCHEMA_VERSION}.`);
  for (const key of required) if (!(key in value)) fail(`${label}.${key} is required.`);
}
function string(value, label, { min = 0, max = MAX.text } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(`${label} must be a string between ${min} and ${max} characters.`);
}
function nullableString(value, label, options) { if (value !== null) string(value, label, options); }
function bool(value, label) { if (typeof value !== 'boolean') fail(`${label} must be boolean.`); }
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be an integer from ${min} to ${max}.`);
}
function enumeration(value, label, choices, nullable = false) {
  if (nullable && value === null) return;
  if (!choices.includes(value)) fail(`${label} must be one of: ${choices.join(', ')}${nullable ? ', null' : ''}.`);
}
function array(value, label, max = MAX.collection) {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be an array with at most ${max} items.`);
  return value;
}
function id(value, label) { string(value, label, { min: 1, max: MAX.id }); }
function imageId(value, label) { if (value !== null && (typeof value !== 'string' || !IMAGE_ID_RE.test(value))) fail(`${label} is not a valid image id or null.`); }
function unique(items, getId, label) {
  const seen = new Set();
  for (const item of items) {
    const value = getId(item);
    if (seen.has(value)) fail(`${label} contains duplicate id "${value}".`);
    seen.add(value);
  }
  return seen;
}
function jsonClone(value) { return JSON.parse(JSON.stringify(value)); }

function validateAsset(asset, index) {
  const label = `character.assets[${index}]`;
  keys(asset, label, ['id', 'name', 'category', 'abilities_unlocked', 'health', 'battered', 'cursed', 'resource', 'broken'], ['id', 'name', 'category', 'abilities_unlocked']);
  id(asset.id, `${label}.id`); string(asset.name, `${label}.name`, { min: 1, max: 200 }); string(asset.category, `${label}.category`, { min: 1, max: 100 });
  const official = dataMod.findAsset(asset.id);
  if (!official || official.$id !== asset.id) fail(`${label}.id must be an exact official asset id.`);
  if (asset.name !== official.Name || asset.category !== (official['Asset Type'] || '').split('/').pop()) fail(`${label} name/category do not match asset "${asset.id}".`);
  array(asset.abilities_unlocked, `${label}.abilities_unlocked`, 3);
  unique(asset.abilities_unlocked, (n) => n, `${label}.abilities_unlocked`);
  if (asset.abilities_unlocked.length < 1) fail(`${label}.abilities_unlocked must not be empty.`);
  asset.abilities_unlocked.forEach((n, i) => integer(n, `${label}.abilities_unlocked[${i}]`, 1, 3));
  if ('health' in asset) integer(asset.health, `${label}.health`, 0, 5);
  for (const field of ['battered', 'cursed', 'broken']) if (field in asset) bool(asset[field], `${label}.${field}`);
  if (asset.category === 'Command Vehicle' && (!('battered' in asset) || !('cursed' in asset))) fail(`${label} must contain both Command Vehicle condition fields.`);
  if (asset.category === 'Support Vehicle' && !('battered' in asset)) fail(`${label} must contain its Support Vehicle condition field.`);
  if ('broken' in asset && asset.category !== 'Module') fail(`${label}.broken is only valid for a Module.`);
  if ('health' in asset && asset.category !== 'Companion' && asset.name !== 'Symbiote') fail(`${label}.health is only valid for a Companion or Symbiote.`);
  if ((asset.category === 'Companion' || asset.name === 'Symbiote') && !('health' in asset)) fail(`${label}.health is required for this asset.`);
  if (Boolean(stateMod.ASSET_RESOURCES[asset.name]) !== ('resource' in asset)) fail(`${label}.resource presence does not match the official asset definition.`);
  if ('cursed' in asset && asset.category !== 'Command Vehicle') fail(`${label}.cursed is only valid for a Command Vehicle.`);
  if ('battered' in asset && !['Command Vehicle', 'Support Vehicle'].includes(asset.category)) fail(`${label}.battered is only valid for a vehicle.`);
  if ('resource' in asset) {
    keys(asset.resource, `${label}.resource`, ['current', 'max', 'label']);
    integer(asset.resource.max, `${label}.resource.max`, 1, 100);
    integer(asset.resource.current, `${label}.resource.current`, 0, asset.resource.max);
    string(asset.resource.label, `${label}.resource.label`, { min: 1, max: 100 });
    if (asset.resource.label !== stateMod.ASSET_RESOURCES[asset.name].label) fail(`${label}.resource.label does not match the official asset definition.`);
  }
}

function validateCharacter(character) {
  keys(character, 'character', ['name', 'callsign', 'pronouns', 'description', 'portraitImageId', 'stats', 'statsCorrected', 'meters', 'experience', 'assets', 'impacts', 'aboardVehicleId', 'combatPosition', 'combatRange']);
  string(character.name, 'character.name', { max: 200 });
  string(character.callsign, 'character.callsign', { max: 200 });
  string(character.pronouns, 'character.pronouns', { max: 200 });
  string(character.description, 'character.description', { max: 10000 });
  imageId(character.portraitImageId, 'character.portraitImageId');
  keys(character.stats, 'character.stats', ['edge', 'heart', 'iron', 'shadow', 'wits']);
  for (const stat of ['edge', 'heart', 'iron', 'shadow', 'wits']) integer(character.stats[stat], `character.stats.${stat}`, 1, 3);
  bool(character.statsCorrected, 'character.statsCorrected');
  keys(character.meters, 'character.meters', ['health', 'spirit', 'supply', 'integrity', 'momentum', 'momentum_max', 'momentum_min', 'momentum_reset']);
  for (const meter of ['health', 'spirit', 'supply', 'integrity']) integer(character.meters[meter], `character.meters.${meter}`, 0, 5);
  integer(character.meters.momentum, 'character.meters.momentum', -6, 10);
  integer(character.meters.momentum_max, 'character.meters.momentum_max', 0, 10);
  integer(character.meters.momentum_min, 'character.meters.momentum_min', -6, -6);
  integer(character.meters.momentum_reset, 'character.meters.momentum_reset', 0, 3);
  keys(character.experience, 'character.experience', ['earned', 'spent']);
  integer(character.experience.earned, 'character.experience.earned', 0, 1000000);
  integer(character.experience.spent, 'character.experience.spent', 0, character.experience.earned);
  array(character.assets, 'character.assets', MAX.assets).forEach(validateAsset);
  const assetIds = unique(character.assets, (asset) => asset.id, 'character.assets');
  keys(character.impacts, 'character.impacts', ['Misfortunes', 'Lasting Effects', 'Burdens', 'Other Impacts']);
  const expected = stateMod.newCampaignState().character.impacts;
  for (const category of ['Misfortunes', 'Lasting Effects', 'Burdens']) {
    const entries = array(character.impacts[category], `character.impacts.${category}`, 10);
    if (entries.length !== expected[category].length) fail(`character.impacts.${category} has the wrong number of entries.`);
    entries.forEach((impact, index) => {
      keys(impact, `character.impacts.${category}[${index}]`, ['name', 'marked', 'permanent']);
      if (impact.name !== expected[category][index].name || impact.permanent !== expected[category][index].permanent) fail(`character.impacts.${category}[${index}] does not match the canonical impact definition.`);
      bool(impact.marked, `character.impacts.${category}[${index}].marked`);
    });
  }
  array(character.impacts['Other Impacts'], 'character.impacts.Other Impacts', 100).forEach((impact, index) => {
    keys(impact, `character.impacts.Other Impacts[${index}]`, ['name', 'marked', 'permanent']);
    string(impact.name, `character.impacts.Other Impacts[${index}].name`, { min: 1, max: 200 });
    if (impact.marked !== true || impact.permanent !== false) fail(`character.impacts.Other Impacts[${index}] must be marked and non-permanent.`);
  });
  unique(character.impacts['Other Impacts'], (impact) => impact.name, 'character.impacts.Other Impacts');
  if (character.aboardVehicleId !== null) {
    id(character.aboardVehicleId, 'character.aboardVehicleId');
    if (!assetIds.has(character.aboardVehicleId)) fail('character.aboardVehicleId references an asset the character does not own.');
    const vehicle = character.assets.find((asset) => asset.id === character.aboardVehicleId);
    if (!['Command Vehicle', 'Support Vehicle'].includes(vehicle.category)) fail('character.aboardVehicleId must reference a vehicle asset.');
  }
  enumeration(character.combatPosition, 'character.combatPosition', ['in_control', 'bad_spot'], true);
  enumeration(character.combatRange, 'character.combatRange', ['close', 'distance'], true);
}

function validateTracks(tracks, clocksById) {
  array(tracks, 'state.progressTracks');
  const ids = unique(tracks, (track) => track.id, 'state.progressTracks');
  tracks.forEach((track, index) => {
    const label = `state.progressTracks[${index}]`;
    keys(track, label, ['id', 'name', 'type', 'rank', 'ticks', 'legacyCleared', 'linkedClockId'], ['id', 'name', 'type', 'rank', 'ticks']);
    id(track.id, `${label}.id`); string(track.name, `${label}.name`, { max: 1000 }); enumeration(track.type, `${label}.type`, TRACK_TYPES);
    enumeration(track.rank, `${label}.rank`, RANKS, track.type === 'legacy');
    integer(track.ticks, `${label}.ticks`, 0, 40);
    if (track.type === 'legacy') {
      if (!('legacyCleared' in track)) fail(`${label}.legacyCleared is required for legacy tracks.`);
      bool(track.legacyCleared, `${label}.legacyCleared`);
    } else if ('legacyCleared' in track) fail(`${label}.legacyCleared is only valid for legacy tracks.`);
    if (track.type === 'scene_challenge') {
      if (!('linkedClockId' in track)) fail(`${label}.linkedClockId is required for scene challenges.`);
      id(track.linkedClockId, `${label}.linkedClockId`);
      const clock = clocksById.get(track.linkedClockId);
      if (!clock || clock.linkedTrackId !== track.id) fail(`${label}.linkedClockId must reference a reciprocally linked clock.`);
    } else if ('linkedClockId' in track) fail(`${label}.linkedClockId is only valid for scene challenges.`);
  });
  for (const required of LEGACY_TRACKS) {
    const track = tracks.find((candidate) => candidate.id === required.id);
    if (!track || track.name !== required.name || track.type !== 'legacy' || track.rank !== null) fail(`state.progressTracks must contain canonical ${required.id}.`);
  }
  return ids;
}

function validateState(state) {
  keys(state, 'state', ['version', 'character', 'progressTracks', 'connections', 'truths', 'sectors', 'currentSectorId', 'illustrations', 'clocks', 'flags', 'campaignElements', 'lastPlayedAt', 'campaignName', 'storySummary', 'rollLedger', 'log']);
  if (state.version !== CAMPAIGN_SCHEMA_VERSION) fail(`state.version must be ${CAMPAIGN_SCHEMA_VERSION}.`);
  validateCharacter(state.character);

  array(state.clocks, 'state.clocks');
  const clockIds = unique(state.clocks, (clock) => clock.id, 'state.clocks');
  const clocksById = new Map(state.clocks.map((clock) => [clock.id, clock]));
  state.clocks.forEach((clock, index) => {
    const label = `state.clocks[${index}]`;
    keys(clock, label, ['id', 'name', 'type', 'segments', 'filled', 'linkedTrackId'], ['id', 'name', 'type', 'segments', 'filled']);
    id(clock.id, `${label}.id`); string(clock.name, `${label}.name`, { max: 1000 }); enumeration(clock.type, `${label}.type`, ['campaign', 'tension']);
    enumeration(clock.segments, `${label}.segments`, [4, 6, 8, 10]); integer(clock.filled, `${label}.filled`, 0, clock.segments);
    if ('linkedTrackId' in clock) id(clock.linkedTrackId, `${label}.linkedTrackId`);
  });
  const trackIds = validateTracks(state.progressTracks, clocksById);
  for (const clock of state.clocks) if ('linkedTrackId' in clock) {
    const track = state.progressTracks.find((candidate) => candidate.id === clock.linkedTrackId);
    if (!track) fail(`clock "${clock.id}" references missing track "${clock.linkedTrackId}".`);
    if (track.linkedClockId !== clock.id) fail(`clock "${clock.id}" must be reciprocally linked to track "${clock.linkedTrackId}".`);
  }

  array(state.connections, 'state.connections');
  unique(state.connections, (connection) => connection.id, 'state.connections');
  state.connections.forEach((connection, index) => {
    const label = `state.connections[${index}]`;
    keys(connection, label, ['id', 'name', 'notes', 'location', 'imageId', 'rank', 'progressTicks', 'bonded', 'role', 'secondRole', 'roleBonus', 'benefitsSuspended']);
    id(connection.id, `${label}.id`); string(connection.name, `${label}.name`, { max: 1000 }); string(connection.notes, `${label}.notes`); string(connection.location, `${label}.location`, { max: 1000 });
    imageId(connection.imageId, `${label}.imageId`); enumeration(connection.rank, `${label}.rank`, RANKS, true); integer(connection.progressTicks, `${label}.progressTicks`, 0, 40);
    bool(connection.bonded, `${label}.bonded`); nullableString(connection.role, `${label}.role`, { max: 1000 }); nullableString(connection.secondRole, `${label}.secondRole`, { max: 1000 });
    enumeration(connection.roleBonus, `${label}.roleBonus`, [1, 2]); bool(connection.benefitsSuspended, `${label}.benefitsSuspended`);
  });

  object(state.truths, 'state.truths');
  if (Object.keys(state.truths).length > 100) fail('state.truths has too many entries.');
  for (const [category, truth] of Object.entries(state.truths)) {
    string(category, 'truth category', { min: 1, max: 200 });
    if (!dataMod.truthCategoryNames().includes(category)) fail(`state.truths contains unknown category "${category}".`);
    keys(truth, `state.truths.${category}`, ['result', 'subtableResult', 'description', 'questStarter', 'source']);
    string(truth.result, `state.truths.${category}.result`, { max: 10000 }); nullableString(truth.subtableResult, `state.truths.${category}.subtableResult`, { max: 10000 });
    string(truth.description, `state.truths.${category}.description`, { max: 10000 }); string(truth.questStarter, `state.truths.${category}.questStarter`, { max: 10000 });
    enumeration(truth.source, `state.truths.${category}.source`, ['rolled', 'chosen']);
  }

  object(state.sectors, 'state.sectors');
  const sectorIds = new Set(Object.keys(state.sectors));
  if (sectorIds.size < 1 || sectorIds.size > 1000) fail('state.sectors must contain between 1 and 1000 sectors.');
  for (const [sectorKey, sector] of Object.entries(state.sectors)) {
    const label = `state.sectors.${sectorKey}`;
    id(sectorKey, `${label} key`); keys(sector, label, ['id', 'name', 'region', 'factionControl', 'notes', 'cells', 'passages', 'currentCell']);
    if (sector.id !== sectorKey) fail(`${label}.id must match its map key.`);
    for (const field of ['name', 'region', 'factionControl', 'notes']) string(sector[field], `${label}.${field}`, { max: field === 'notes' ? MAX.text : 1000 });
    object(sector.cells, `${label}.cells`); if (Object.keys(sector.cells).length > 96) fail(`${label}.cells has too many entries.`);
    for (const [cellId, cell] of Object.entries(sector.cells)) {
      const cellLabel = `${label}.cells.${cellId}`;
      if (!CELL_ID_RE.test(cellId)) fail(`${cellLabel} key is outside the 12x8 sector grid.`);
      keys(cell, cellLabel, ['name', 'notes', 'features', 'imageId']); string(cell.name, `${cellLabel}.name`, { max: 1000 }); string(cell.notes, `${cellLabel}.notes`); imageId(cell.imageId, `${cellLabel}.imageId`);
      array(cell.features, `${cellLabel}.features`, 1000); unique(cell.features, (feature) => feature.id, `${cellLabel}.features`);
      cell.features.forEach((feature, index) => {
        const featureLabel = `${cellLabel}.features[${index}]`;
        keys(feature, featureLabel, ['id', 'type', 'name', 'description']); id(feature.id, `${featureLabel}.id`); enumeration(feature.type, `${featureLabel}.type`, FEATURE_TYPES);
        string(feature.name, `${featureLabel}.name`, { max: 1000 }); string(feature.description, `${featureLabel}.description`);
      });
    }
    nullableString(sector.currentCell, `${label}.currentCell`, { min: 1, max: 5 });
    if (sector.currentCell !== null && !Object.hasOwn(sector.cells, sector.currentCell)) fail(`${label}.currentCell references a missing cell.`);
    array(sector.passages, `${label}.passages`, 1000); unique(sector.passages, (passage) => passage.id, `${label}.passages`);
    sector.passages.forEach((passage, index) => {
      const passageLabel = `${label}.passages[${index}]`;
      keys(passage, passageLabel, ['id', 'fromCell', 'toCell', 'notes', 'toSectorId']); id(passage.id, `${passageLabel}.id`);
      if (!Object.hasOwn(sector.cells, passage.fromCell)) fail(`${passageLabel}.fromCell references a missing cell.`);
      if (passage.toCell !== null && !Object.hasOwn(sector.cells, passage.toCell)) fail(`${passageLabel}.toCell references a missing cell.`);
      string(passage.notes, `${passageLabel}.notes`); nullableString(passage.toSectorId, `${passageLabel}.toSectorId`, { min: 1, max: MAX.id });
      if (passage.toCell !== null && passage.toSectorId !== null) fail(`${passageLabel} cannot have both toCell and toSectorId.`);
      if (passage.toSectorId === sectorKey) fail(`${passageLabel}.toSectorId cannot reference its own sector.`);
    });
  }
  id(state.currentSectorId, 'state.currentSectorId');
  if (!sectorIds.has(state.currentSectorId)) fail('state.currentSectorId references a missing sector.');
  for (const [sectorKey, sector] of Object.entries(state.sectors)) for (const passage of sector.passages) {
    if (passage.toSectorId !== null && !sectorIds.has(passage.toSectorId)) fail(`passage "${passage.id}" in sector "${sectorKey}" references missing sector "${passage.toSectorId}".`);
  }

  array(state.illustrations, 'state.illustrations'); unique(state.illustrations, (entry) => entry.id, 'state.illustrations');
  state.illustrations.forEach((entry, index) => {
    const label = `state.illustrations[${index}]`; keys(entry, label, ['id', 'imageId', 'caption', 'createdAt']); id(entry.id, `${label}.id`); imageId(entry.imageId, `${label}.imageId`);
    if (entry.imageId === null) fail(`${label}.imageId cannot be null.`); string(entry.caption, `${label}.caption`); string(entry.createdAt, `${label}.createdAt`, { min: 1, max: 50 });
    if (!Number.isFinite(Date.parse(entry.createdAt))) fail(`${label}.createdAt must be an ISO date string.`);
  });
  array(state.flags, 'state.flags', 1000).forEach((flag, index) => string(flag, `state.flags[${index}]`, { min: 1, max: 10000 })); unique(state.flags, (flag) => flag, 'state.flags');
  array(state.campaignElements, 'state.campaignElements'); unique(state.campaignElements, (entry) => entry.id, 'state.campaignElements');
  state.campaignElements.forEach((entry, index) => { const label = `state.campaignElements[${index}]`; keys(entry, label, ['id', 'category', 'name', 'description']); id(entry.id, `${label}.id`); enumeration(entry.category, `${label}.category`, ELEMENT_CATEGORIES); string(entry.name, `${label}.name`, { min: 1, max: 1000 }); string(entry.description, `${label}.description`); });
  nullableString(state.lastPlayedAt, 'state.lastPlayedAt', { min: 1, max: 50 }); if (state.lastPlayedAt !== null && !Number.isFinite(Date.parse(state.lastPlayedAt))) fail('state.lastPlayedAt must be an ISO date string or null.');
  nullableString(state.campaignName, 'state.campaignName', { max: 1000 });
  keys(state.storySummary, 'state.storySummary', ['recent', 'distant']); string(state.storySummary.recent, 'state.storySummary.recent'); string(state.storySummary.distant, 'state.storySummary.distant');
  array(state.log, 'state.log'); state.log.forEach((entry, index) => { const label = `state.log[${index}]`; keys(entry, label, ['timestamp', 'text']); string(entry.timestamp, `${label}.timestamp`, { min: 1, max: 50 }); if (!Number.isFinite(Date.parse(entry.timestamp))) fail(`${label}.timestamp must be an ISO date string.`); string(entry.text, `${label}.text`); });
  validateRollLedger(state.rollLedger, trackIds, state.character.assets);
}

function dicePair(value, label) { array(value, label, 2); if (value.length !== 2) fail(`${label} must contain exactly two dice.`); value.forEach((die, index) => integer(die, `${label}[${index}]`, 1, 10)); }
function validateRollLedger(ledger, trackIds, assets) {
  keys(ledger, 'state.rollLedger', ['order', 'entries']); array(ledger.order, 'state.rollLedger.order', MAX.ledger); object(ledger.entries, 'state.rollLedger.entries');
  const orderIds = unique(ledger.order, (value) => value, 'state.rollLedger.order'); ledger.order.forEach((value, index) => id(value, `state.rollLedger.order[${index}]`));
  if (Object.keys(ledger.entries).length !== ledger.order.length) fail('state.rollLedger.entries must contain exactly the rolls listed in order.');
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  for (const [rollKey, roll] of Object.entries(ledger.entries)) {
    if (!orderIds.has(rollKey)) fail(`state.rollLedger.entries contains unlisted roll "${rollKey}".`);
    const label = `state.rollLedger.entries.${rollKey}`;
    const common = ['id', 'kind', 'moveName', 'challengeDice', 'outcome', 'isMatch', 'authorizedActionScores', 'authorizedChallengeDice', 'appliedAssetEffects', 'momentumBurned', 'resolutionStatus', 'modifierEntitlements', 'currentActionScore', 'currentChallengeDice', 'currentOutcome', 'currentIsMatch'];
    const action = ['stat', 'statValue', 'valueSource', 'adds', 'actionDie', 'momentum', 'negativeMomentumApplied', 'actionDieMode', 'actionScore'];
    const progress = ['trackId', 'progressScore'];
    keys(roll, label, [...common, ...action, ...progress], common);
    if (roll.id !== rollKey) fail(`${label}.id must match its map key.`); enumeration(roll.kind, `${label}.kind`, ['action', 'progress']); nullableString(roll.moveName, `${label}.moveName`, { max: 1000 });
    dicePair(roll.challengeDice, `${label}.challengeDice`); enumeration(roll.outcome, `${label}.outcome`, OUTCOMES); bool(roll.isMatch, `${label}.isMatch`);
    const baseScore = roll.kind === 'action' ? roll.actionScore : roll.progressScore;
    integer(baseScore, `${label}.${roll.kind === 'action' ? 'actionScore' : 'progressScore'}`, 0, 10);
    if (roll.kind === 'progress') { id(roll.trackId, `${label}.trackId`); if (!trackIds.has(roll.trackId)) fail(`${label}.trackId references a missing track.`); }
    if (roll.kind === 'action') {
      nullableString(roll.stat ?? null, `${label}.stat`, { max: 100 }); integer(roll.statValue, `${label}.statValue`, 0, 10); integer(roll.adds, `${label}.adds`, -100, 100);
      if (roll.actionDie !== null) integer(roll.actionDie, `${label}.actionDie`, 1, 6); integer(roll.momentum, `${label}.momentum`, -6, 10);
      if ('negativeMomentumApplied' in roll) bool(roll.negativeMomentumApplied, `${label}.negativeMomentumApplied`); enumeration(roll.actionDieMode, `${label}.actionDieMode`, ['normal', 'preset', 'zero']);
    }
    const initial = diceMod.determineOutcome(baseScore, roll.challengeDice);
    const validOutcome = (computed, actual, kind) => computed === actual || (kind === 'progress' && ((computed === 'strong_hit' && actual === 'weak_hit') || (computed === 'weak_hit' && actual === 'miss')));
    if (!validOutcome(initial.outcome, roll.outcome, roll.kind) || initial.is_match !== roll.isMatch) fail(`${label} initial outcome does not match its score and challenge dice.`);
    array(roll.authorizedActionScores, `${label}.authorizedActionScores`, 100).forEach((score, index) => integer(score, `${label}.authorizedActionScores[${index}]`, 0, 10));
    array(roll.authorizedChallengeDice, `${label}.authorizedChallengeDice`, 100).forEach((pair, index) => dicePair(pair, `${label}.authorizedChallengeDice[${index}]`));
    if (!roll.authorizedActionScores.includes(roll.currentActionScore)) fail(`${label}.currentActionScore is not authorized.`);
    if (!roll.authorizedChallengeDice.some((pair) => pair[0] === roll.currentChallengeDice[0] && pair[1] === roll.currentChallengeDice[1])) fail(`${label}.currentChallengeDice is not authorized.`);
    integer(roll.currentActionScore, `${label}.currentActionScore`, 0, 10); dicePair(roll.currentChallengeDice, `${label}.currentChallengeDice`); enumeration(roll.currentOutcome, `${label}.currentOutcome`, OUTCOMES); bool(roll.currentIsMatch, `${label}.currentIsMatch`);
    const current = diceMod.determineOutcome(roll.currentActionScore, roll.currentChallengeDice);
    if (!validOutcome(current.outcome, roll.currentOutcome, roll.kind) || current.is_match !== roll.currentIsMatch) fail(`${label} current outcome does not match its score and challenge dice.`);
    object(roll.appliedAssetEffects, `${label}.appliedAssetEffects`);
    if (Object.keys(roll.appliedAssetEffects).length > 100) fail(`${label}.appliedAssetEffects has too many entries.`);
    for (const effectKey of Object.keys(roll.appliedAssetEffects)) {
      const separator = effectKey.lastIndexOf(':'); const sourceId = effectKey.slice(0, separator); const ability = Number(effectKey.slice(separator + 1)); const asset = assetsById.get(sourceId);
      if (separator < 1 || !asset || !asset.abilities_unlocked.includes(ability)) fail(`${label}.appliedAssetEffects contains an effect without an owned, unlocked source ability.`);
      object(roll.appliedAssetEffects[effectKey], `${label}.appliedAssetEffects.${effectKey}`);
    }
    bool(roll.momentumBurned, `${label}.momentumBurned`); enumeration(roll.resolutionStatus, `${label}.resolutionStatus`, ['open', 'resolved']);
    if (roll.momentumBurned && roll.resolutionStatus !== 'resolved') fail(`${label} cannot have burned momentum while still open.`);
    object(roll.modifierEntitlements, `${label}.modifierEntitlements`);
    for (const [entitlementKey, entitlement] of Object.entries(roll.modifierEntitlements)) {
      const entLabel = `${label}.modifierEntitlements.${entitlementKey}`; keys(entitlement, entLabel, ['id', 'rollId', 'sourceId', 'sourceName', 'abilityNumber', 'modifier', 'maxExtraDice', 'used']);
      if (entitlement.id !== entitlementKey || entitlement.rollId !== roll.id) fail(`${entLabel} has inconsistent identity.`);
      id(entitlement.sourceId, `${entLabel}.sourceId`); string(entitlement.sourceName, `${entLabel}.sourceName`, { min: 1, max: 200 }); integer(entitlement.abilityNumber, `${entLabel}.abilityNumber`, 1, 3);
      enumeration(entitlement.modifier, `${entLabel}.modifier`, ['reroll_action_die', 'roll_extra_challenge_die', 'roll_bonus_challenge_dice', 'reroll_challenge_dice', 'kinetic_plus_2', 'exosuit_integrity_die', 'revenant_zero']);
      if (entitlement.maxExtraDice !== null) integer(entitlement.maxExtraDice, `${entLabel}.maxExtraDice`, 1, 10); bool(entitlement.used, `${entLabel}.used`);
      const asset = assetsById.get(entitlement.sourceId);
      if (!stateMod.isValidRollModifierEntitlement(roll, asset, entitlement)) fail(`${entLabel} is not authorized by its owned, unlocked source ability for this roll.`);
    }
  }
}

function validateMessages(messages, pendingChoice) {
  array(messages, 'campaign messages', MAX.messages);
  const calls = new Map(); const resolved = new Set();
  messages.forEach((message, index) => {
    const label = `messages[${index}]`; object(message, label);
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) fail(`${label}.role is invalid.`);
    if (message.role === 'tool') {
      keys(message, label, ['role', 'tool_call_id', 'content']); id(message.tool_call_id, `${label}.tool_call_id`); string(message.content, `${label}.content`);
      if (!calls.has(message.tool_call_id)) fail(`${label}.tool_call_id references no earlier assistant tool call.`);
      if (resolved.has(message.tool_call_id)) fail(`${label}.tool_call_id was already resolved.`); resolved.add(message.tool_call_id); return;
    }
    keys(message, label, message.role === 'assistant' ? ['role', 'content', 'tool_calls'] : ['role', 'content'], ['role', 'content']);
    if (message.role === 'assistant') nullableString(message.content, `${label}.content`);
    else string(message.content, `${label}.content`);
    if (message.role === 'assistant' && 'tool_calls' in message) {
      array(message.tool_calls, `${label}.tool_calls`, 100);
      message.tool_calls.forEach((call, callIndex) => {
        const callLabel = `${label}.tool_calls[${callIndex}]`; keys(call, callLabel, ['id', 'type', 'function']); id(call.id, `${callLabel}.id`);
        if (calls.has(call.id)) fail(`${callLabel}.id is duplicated.`); if (call.type !== 'function') fail(`${callLabel}.type must be function.`);
        keys(call.function, `${callLabel}.function`, ['name', 'arguments']); string(call.function.name, `${callLabel}.function.name`, { min: 1, max: 200 }); string(call.function.arguments, `${callLabel}.function.arguments`);
        try { object(JSON.parse(call.function.arguments || '{}'), `${callLabel}.function.arguments JSON`); } catch (error) { if (/^Invalid input:/.test(error.message)) throw error; fail(`${callLabel}.function.arguments must be a JSON object.`); }
        calls.set(call.id, { call, messageIndex: index });
      });
    }
    if (message.role === 'assistant' && !(message.content || '').trim() && (!message.tool_calls || message.tool_calls.length === 0)) fail(`${label} must contain narration or at least one tool call.`);
  });
  if (pendingChoice === null) return;
  keys(pendingChoice, 'pendingChoice', ['toolCallId', 'prompt', 'options', 'allowCustom']); id(pendingChoice.toolCallId, 'pendingChoice.toolCallId'); string(pendingChoice.prompt, 'pendingChoice.prompt', { min: 1, max: 10000 });
  array(pendingChoice.options, 'pendingChoice.options', 100).forEach((option, index) => {
    const label = `pendingChoice.options[${index}]`; keys(option, label, ['label', 'description'], ['label']); string(option.label, `${label}.label`, { min: 1, max: 1000 });
    if ('description' in option) string(option.description, `${label}.description`, { max: 10000 });
  }); bool(pendingChoice.allowCustom, 'pendingChoice.allowCustom');
  const linked = calls.get(pendingChoice.toolCallId);
  if (!linked || linked.call.function.name !== 'present_choice' || resolved.has(pendingChoice.toolCallId)) fail('pendingChoice must reference one unresolved present_choice tool call.');
  const args = JSON.parse(linked.call.function.arguments || '{}');
  const expected = { prompt: args.prompt || 'Choose one:', options: Array.isArray(args.options) ? args.options : [], allowCustom: args.allow_custom !== false };
  if (pendingChoice.prompt !== expected.prompt || JSON.stringify(pendingChoice.options) !== JSON.stringify(expected.options) || pendingChoice.allowCustom !== expected.allowCustom) fail('pendingChoice must exactly match its present_choice tool arguments.');
  const sameBatchIds = new Set(linked.call ? messages[linked.messageIndex].tool_calls.map((call) => call.id) : []);
  if (messages.slice(linked.messageIndex + 1).some((message) => message.role !== 'tool' || !sameBatchIds.has(message.tool_call_id))) fail('pendingChoice may only be followed by tool results from its own assistant batch.');
}

function migrateCharacter(character) {
  const defaults = stateMod.newCampaignState().character;
  object(character, 'character');
  const input = jsonClone(character);
  const migrated = { ...defaults, ...input, stats: { ...defaults.stats, ...(input.stats || {}) }, meters: { ...defaults.meters, ...(input.meters || {}) }, experience: { ...defaults.experience, ...(input.experience || {}) }, impacts: { ...defaults.impacts, ...(input.impacts || {}) }, assets: Array.isArray(input.assets) ? input.assets : [] };
  for (const asset of migrated.assets) {
    const oldId = asset.id;
    const official = dataMod.findAsset(oldId); if (!official) fail(`character asset id references unknown asset "${oldId}".`);
    asset.id = official.$id; asset.name = official.Name; asset.category = (official['Asset Type'] || '').split('/').pop();
    if (input.aboardVehicleId === oldId) migrated.aboardVehicleId = asset.id;
    asset.abilities_unlocked = [...new Set(asset.abilities_unlocked || [1])];
    if (asset.category === 'Command Vehicle') { if (!('battered' in asset)) asset.battered = false; if (!('cursed' in asset)) asset.cursed = false; }
    else if (asset.category === 'Support Vehicle' && !('battered' in asset)) asset.battered = false;
    if (asset.category !== 'Module') delete asset.broken;
    if (asset.category !== 'Companion' && asset.name !== 'Symbiote') delete asset.health;
    if ((asset.category === 'Companion' || asset.name === 'Symbiote') && !('health' in asset)) asset.health = asset.name === 'Symbiote' ? 2 : 5;
    if (stateMod.ASSET_RESOURCES[asset.name] && !asset.resource) {
      const resource = stateMod.ASSET_RESOURCES[asset.name]; asset.resource = { current: resource.start, max: resource.max, label: resource.label };
    }
  }
  if (migrated.impacts['Current Vehicle']) {
    const command = migrated.assets.find((asset) => asset.category === 'Command Vehicle');
    if (command) { command.battered ||= migrated.impacts['Current Vehicle'].some((impact) => impact.name === 'Battered' && impact.marked); command.cursed ||= migrated.impacts['Current Vehicle'].some((impact) => impact.name === 'Cursed' && impact.marked); }
    delete migrated.impacts['Current Vehicle'];
  }
  if ('aboardVehicle' in migrated) { const command = migrated.assets.find((asset) => asset.category === 'Command Vehicle'); migrated.aboardVehicleId = migrated.aboardVehicle && command ? command.id : null; delete migrated.aboardVehicle; }
  return migrated;
}

function migrateV1Record(record) {
  const defaults = stateMod.newCampaignState(); const input = object(jsonClone(record), 'campaign import'); const incoming = object(input.state, 'campaign state');
  const messages = Array.isArray(input.messages) ? input.messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content };
    if (message.role === 'assistant') {
      const canonical = { role: 'assistant', content: message.content ?? null };
      if (message.tool_calls !== undefined) canonical.tool_calls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => ({ id: call && call.id, type: call && call.type, function: call && call.function ? { name: call.function.name, arguments: call.function.arguments } : call && call.function })) : message.tool_calls;
      return canonical;
    }
    return { role: message.role, content: message.content };
  }) : [];
  const migrated = { version: CAMPAIGN_SCHEMA_VERSION, revision: Number.isInteger(input.revision) && input.revision >= 0 ? input.revision : 0, state: { ...defaults, ...incoming, version: CAMPAIGN_SCHEMA_VERSION, character: migrateCharacter(incoming.character), storySummary: { ...defaults.storySummary, ...(incoming.storySummary || {}) }, rollLedger: incoming.rollLedger || { order: [], entries: {} } }, messages, pendingChoice: input.pendingChoice || null };
  for (const [sectorId, oldSector] of Object.entries(migrated.state.sectors || {})) migrated.state.sectors[sectorId] = { ...stateMod.newSector(sectorId), ...oldSector, id: sectorId };
  for (const sector of Object.values(migrated.state.sectors || {})) {
    for (const [cellId, cell] of Object.entries(sector.cells || {})) sector.cells[cellId] = { name: '', notes: '', features: [], imageId: null, ...cell };
    for (const passage of sector.passages || []) if (!('toSectorId' in passage)) passage.toSectorId = null;
  }
  migrated.state.connections = (migrated.state.connections || []).map((connection) => ({ imageId: null, rank: null, progressTicks: 0, bonded: false, role: null, secondRole: null, roleBonus: 1, benefitsSuspended: false, location: '', ...connection }));
  migrated.state.campaignElements = (migrated.state.campaignElements || []).map((entry) => 'category' in entry ? entry : { id: entry.id, category: 'Other', name: entry.text, description: '' });
  for (const required of LEGACY_TRACKS) if (!migrated.state.progressTracks.some((track) => track.id === required.id)) migrated.state.progressTracks.unshift({ ...required, type: 'legacy', rank: null, ticks: 0, legacyCleared: false });
  for (const track of migrated.state.progressTracks) if (track.type === 'legacy' && !('legacyCleared' in track)) track.legacyCleared = false;
  for (const roll of Object.values(migrated.state.rollLedger.entries || {})) {
    if (!roll.resolutionStatus) roll.resolutionStatus = roll.momentumBurned ? 'resolved' : 'open'; if (!roll.modifierEntitlements) roll.modifierEntitlements = {};
  }
  stateMod.applyImpactEffects(migrated.state);
  return migrated;
}

function normalizeCampaignRecord(value, { resetRevision = false } = {}) {
  object(value, 'campaign import');
  const version = value.version === undefined ? 1 : value.version;
  if (!Number.isInteger(version) || version < 1 || version > CAMPAIGN_SCHEMA_VERSION) fail(`unsupported campaign schema version ${String(version)}.`);
  const record = version === 1 ? migrateV1Record(value) : jsonClone(value);
  keys(record, 'campaign import', ['version', 'revision', 'state', 'messages', 'pendingChoice']);
  if (record.version !== CAMPAIGN_SCHEMA_VERSION) fail(`campaign import.version must be ${CAMPAIGN_SCHEMA_VERSION}.`);
  integer(record.revision, 'campaign import.revision', 0, Number.MAX_SAFE_INTEGER);
  validateState(record.state); validateMessages(record.messages, record.pendingChoice);
  stateMod.applyImpactEffects(record.state);
  if (resetRevision) record.revision = 0;
  return record;
}

function normalizeCharacterExport(value) {
  object(value, 'character import');
  if (value.kind !== 'starforged-character-export') fail('unsupported character export format.');
  if (!Number.isInteger(value.version) || value.version < 1 || value.version > CHARACTER_SCHEMA_VERSION) fail(`unsupported character export version ${String(value.version)}.`);
  const migrated = value.version === 1 ? { kind: value.kind, version: CHARACTER_SCHEMA_VERSION, character: migrateCharacter(value.character), truths: value.truths || {}, backgroundVow: value.backgroundVow ?? null } : jsonClone(value);
  keys(migrated, 'character import', ['kind', 'version', 'character', 'truths', 'backgroundVow']);
  validateCharacter(migrated.character); object(migrated.truths, 'character import.truths'); nullableString(migrated.backgroundVow, 'character import.backgroundVow', { max: 1000 });
  // Reuse the campaign truth schema without admitting unrelated campaign data.
  const shell = stateMod.newCampaignState(); shell.version = CAMPAIGN_SCHEMA_VERSION; shell.character = migrated.character; shell.truths = migrated.truths;
  validateState(shell);
  return migrated;
}

module.exports = { CAMPAIGN_SCHEMA_VERSION, CHARACTER_SCHEMA_VERSION, normalizeCampaignRecord, normalizeCharacterExport, validateCharacter };
