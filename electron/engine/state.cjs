'use strict';
const dice = require('./dice.cjs');

const METER_BOUNDS = {
  health: [0, 5],
  spirit: [0, 5],
  supply: [0, 5],
  integrity: [0, 5], // command vehicle condition
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * The four Impact categories and their named debuffs, exactly as printed on the character
 * sheet. Marking any impact reduces max momentum by 1; the momentum reset value drops to 1
 * with one impact marked, and to 0 with two or more.
 *
 * `permanent: true` impacts (Cursed, Permanently Harmed, Traumatized) can never be cleared
 * once marked -- the rulebook is explicit about this ("Lasting effects are permanent... Cursed
 * is a permanent impact and will forever plague your STARSHIP"), unlike Misfortunes (cleared by
 * a successful recover move) or Burdens (cleared by resolving the associated quest).
 *
 * Vehicle Troubles (Battered/Cursed) are NOT tracked here -- per the rulebook, these are marked
 * directly on the specific vehicle's own asset card, not as a single character-wide condition.
 * A character with both a Starship and a Support Vehicle can have one battered and the other
 * not; a single shared toggle here couldn't express that. See `battered`/`cursed` fields on
 * vehicle-category assets themselves, and `character.aboardVehicleId` for which one currently
 * counts toward the momentum penalty ("these impacts are only a factor when you are piloting or
 * aboard that vehicle").
 */
const DEFAULT_IMPACTS = {
  Misfortunes: [
    { name: 'Wounded', permanent: false },
    { name: 'Shaken', permanent: false },
    { name: 'Unprepared', permanent: false },
  ],
  'Lasting Effects': [
    { name: 'Permanently Harmed', permanent: true },
    { name: 'Traumatized', permanent: true },
  ],
  Burdens: [
    { name: 'Doomed', permanent: false },
    { name: 'Tormented', permanent: false },
    { name: 'Indebted', permanent: false },
  ],
};

function newImpacts() {
  const out = {};
  for (const [category, defs] of Object.entries(DEFAULT_IMPACTS)) {
    out[category] = defs.map((d) => ({ name: d.name, marked: false, permanent: d.permanent }));
  }
  // "Other Impacts": certain assets impose an ongoing impact-equivalent penalty as a drawback
  // (e.g. Oathbreaker "counts as an impact until you fulfill that vow") -- unlike the four fixed
  // categories above, this one is a dynamic, freely-named list: entries exist only while the
  // condition applies, added/removed via addOtherImpact/removeOtherImpact rather than toggled.
  out['Other Impacts'] = [];
  return out;
}

/** Adds a freeform "Other Impact" (from an asset ability, e.g. Oathbreaker), which counts
 *  toward the momentum penalty like any other impact for as long as it's present. */
function addOtherImpact(state, name) {
  const list = state.character.impacts['Other Impacts'];
  if (list.some((i) => i.name === name)) throw new Error(`"${name}" is already an active Other Impact.`);
  list.push({ name, marked: true, permanent: false });
  applyImpactEffects(state);
  return { name };
}

/** Removes a previously-added Other Impact once its source condition resolves. */
function removeOtherImpact(state, name) {
  const list = state.character.impacts['Other Impacts'];
  const before = list.length;
  state.character.impacts['Other Impacts'] = list.filter((i) => i.name !== name);
  if (state.character.impacts['Other Impacts'].length === before) throw new Error(`No active Other Impact named "${name}".`);
  applyImpactEffects(state);
}

/** Counts marked impacts toward the momentum penalty, including Vehicle Troubles from whichever
 *  vehicle asset the character is currently aboard (if any) -- those live on the vehicle itself,
 *  not in the shared impacts object, so they're passed in separately rather than found by
 *  category name. */
/** Survivor lets exactly one marked Lasting Effect (Traumatized or Permanently Harmed, not both)
 *  stop counting toward the momentum penalty -- "you are learning to live with this impact."
 *  Deterministic when both happen to be marked: exempts Permanently Harmed first, matching the
 *  order the rulebook itself lists them in. */
function countMarkedImpacts(impacts, currentVehicleTroubleCount = 0, ownsSurvivor = false) {
  let n = currentVehicleTroubleCount;
  let survivorExemptionUsed = false;
  for (const [category, list] of Object.entries(impacts)) {
    for (const impact of list) {
      if (!impact.marked) continue;
      if (ownsSurvivor && !survivorExemptionUsed && category === 'Lasting Effects') {
        survivorExemptionUsed = true;
        continue;
      }
      n++;
    }
  }
  return n;
}

/** Vehicle Troubles (Battered/Cursed) live on whichever vehicle asset the character currently
 *  owns and is aboard, not as a shared character-wide flag -- returns how many of those two are
 *  currently marked on that specific vehicle (0, 1, or 2), or 0 if the character isn't aboard
 *  any vehicle right now. */
function currentVehicleTroubleCount(state) {
  if (!state.character.aboardVehicleId) return 0;
  const vehicle = state.character.assets.find((a) => a.id === state.character.aboardVehicleId);
  if (!vehicle) return 0;
  return (vehicle.battered ? 1 : 0) + (vehicle.cursed ? 1 : 0);
}

/** Recomputes momentum_max/momentum_reset from marked impacts, then reclamps momentum. Also
 *  accounts for Veteran's "when you are in a fight, increase your momentum reset by 1" -- unlike
 *  Voidborn's similar space/planetside bonus (which depends on fictional context this engine
 *  doesn't track as state), "in a fight" already has a real, persistent state signal
 *  (combatPosition/combatRange), so this can be a genuine automatic modifier rather than
 *  something left to GM judgment. */
function applyImpactEffects(state) {
  const marked = countMarkedImpacts(state.character.impacts, currentVehicleTroubleCount(state), state.character.assets.some((a) => a.name === 'Survivor'));
  const meters = state.character.meters;
  meters.momentum_max = 10 - marked;
  meters.momentum_reset = marked === 0 ? 2 : marked === 1 ? 1 : 0;
  const inFight = state.character.combatPosition !== null || state.character.combatRange !== null;
  if (inFight && state.character.assets.some((a) => a.name === 'Veteran')) {
    meters.momentum_reset += 1;
  }
  meters.momentum = clamp(meters.momentum, meters.momentum_min, meters.momentum_max);
}

/** Sets which vehicle asset (by id) the character is currently aboard, or null if aboard none --
 *  affects whether THAT specific vehicle's Battered/Cursed troubles count toward the momentum
 *  penalty. Call this when the fiction has the character board or leave a vehicle, or switch
 *  from one to another (e.g. their Starship to a Support Vehicle). */
function setAboardVehicle(state, assetId) {
  if (assetId) {
    const vehicle = state.character.assets.find((a) => a.id === assetId);
    if (!vehicle) throw new Error(`Character doesn't have a vehicle asset with id "${assetId}".`);
    if (!('battered' in vehicle)) throw new Error(`"${vehicle.name}" isn't a vehicle asset (no battered/cursed tracking).`);
  }
  state.character.aboardVehicleId = assetId || null;
  applyImpactEffects(state);
  return state.character.aboardVehicleId;
}

/** Marks or clears Battered or Cursed directly on a specific vehicle asset -- per the rulebook,
 *  these are tracked on the vehicle's own card, not as a single character-wide condition. Cursed
 *  is permanent once marked (matching the same rule Lasting Effects follow) -- trying to clear it
 *  is an error, not a silent no-op, so a mistaken call surfaces immediately instead of hiding a
 *  real rules violation. */
function setVehicleCondition(state, assetId, condition, marked) {
  if (condition !== 'battered' && condition !== 'cursed') throw new Error(`Unknown vehicle condition "${condition}" -- must be "battered" or "cursed".`);
  const vehicle = state.character.assets.find((a) => a.id === assetId);
  if (!vehicle) throw new Error(`Character doesn't have an asset with id "${assetId}".`);
  if (!('battered' in vehicle)) throw new Error(`"${vehicle.name}" isn't a vehicle asset (no battered/cursed tracking).`);
  if (condition === 'cursed' && !('cursed' in vehicle)) throw new Error(`"${vehicle.name}" is a support vehicle -- only the command vehicle can be cursed.`);
  if (condition === 'cursed' && vehicle.cursed && !marked) throw new Error(`Cursed is permanent -- "${vehicle.name}" cannot be un-cursed.`);
  vehicle[condition] = Boolean(marked);
  applyImpactEffects(state);
  return { assetId, name: vehicle.name, battered: vehicle.battered, cursed: vehicle.cursed };
}

/**
 * Combat position: "in control" (proactive/offensive moves) vs "in a bad spot" (reactive/
 * defensive moves). Per the rulebook's default guideline, a strong hit puts you in control and
 * a weak hit or miss puts you in a bad spot -- but it's explicitly a fiction-first judgment call
 * ("unless a move tells you otherwise"), not a strict formula, so this is set deliberately by
 * the GM rather than auto-derived from every roll.
 */
function setCombatPosition(state, position) {
  if (![null, 'in_control', 'bad_spot'].includes(position)) {
    throw new Error('combatPosition must be "in_control", "bad_spot", or null.');
  }
  state.character.combatPosition = position;
  applyImpactEffects(state); // re-checks Veteran's "+1 momentum reset while in a fight" against the new combat state
  return position;
}

/** Combat range: "close" (+iron for Strike/Clash) or "distance" (+edge). */
function setCombatRange(state, range) {
  if (![null, 'close', 'distance'].includes(range)) {
    throw new Error('combatRange must be "close", "distance", or null.');
  }
  state.character.combatRange = range;
  applyImpactEffects(state); // same as setCombatPosition -- either one can start/end "being in a fight" for Veteran's bonus
  return range;
}

function toggleImpact(state, category, name) {
  const list = state.character.impacts[category];
  if (!list) throw new Error(`Unknown impact category "${category}". Expected one of: ${Object.keys(DEFAULT_IMPACTS).join(', ')}`);
  const impact = list.find((i) => i.name === name);
  if (!impact) throw new Error(`Unknown impact "${name}" in category "${category}".`);
  if (impact.marked && impact.permanent) {
    throw new Error(`"${name}" is a permanent impact and cannot be cleared once marked.`);
  }
  impact.marked = !impact.marked;
  applyImpactEffects(state);
  return { category, name, marked: impact.marked, momentum_max: state.character.meters.momentum_max, momentum_reset: state.character.meters.momentum_reset };
}

/** The three permanent legacy tracks, modeled as ordinary progress tracks (type 'legacy')
 *  so every existing progress-track tool (mark_progress_track, roll_progress_move) already
 *  works on them without special-casing. */
const LEGACY_TRACKS = [
  { id: 'legacy-quests', name: 'Quests' },
  { id: 'legacy-bonds', name: 'Bonds' },
  { id: 'legacy-discoveries', name: 'Discoveries' },
];

/** A fresh, blank character/campaign state. The renderer's character-creation flow fills this in. */
function newCampaignState() {
  return {
    version: 1,
    character: {
      name: '',
      callsign: '',
      pronouns: '',
      description: '', // appearance, personality, mannerisms -- freeform flavor text the GM can draw on
      portraitImageId: null,
      stats: { edge: 1, heart: 1, iron: 1, shadow: 1, wits: 1 },
      statsCorrected: false, // true once the post-creation "fix a mistake" stat editor has been used -- one-time only, see correctCharacterStats
      meters: {
        health: 5,
        spirit: 5,
        supply: 5,
        integrity: 5,
        momentum: 2,
        momentum_max: 10,
        momentum_min: -6,
        momentum_reset: 2,
      },
      experience: { earned: 0, spent: 0 },
      assets: [], // { id, name, category, abilities_unlocked: [1], health? } -- health only present for Companion-category assets
      impacts: newImpacts(),
      aboardVehicleId: null, // asset id of whichever vehicle (if any) the character is currently aboard -- Battered/Cursed on THAT vehicle count toward the momentum penalty while true, per-vehicle rather than a single shared flag
      combatPosition: null, // 'in_control' | 'bad_spot' | null (not currently in a fight)
      combatRange: null, // 'close' | 'distance' | null -- determines Strike/Clash stat (iron vs edge)
    },
    progressTracks: LEGACY_TRACKS.map((t) => ({ id: t.id, name: t.name, type: 'legacy', rank: null, ticks: 0, legacyCleared: false })),
    // progressTracks entries otherwise: { id, name, type: 'vow'|'combat'|'expedition'|'connection'|'legacy', rank, ticks }
    connections: [], // { id, name, notes }
    truths: {}, // { categoryName: { result, subtableResult, description, questStarter, source } }
    sectors: { 'sector-1': newSector('sector-1') },
    currentSectorId: 'sector-1',
    illustrations: [], // { id, imageId, caption, createdAt } -- general story-illustration gallery
    clocks: [], // { id, name, type: 'campaign'|'tension', segments, filled }
    flags: [], // string[] -- content the player has asked to avoid or handle carefully (Set a Flag)
    // A player-curated table of story ingredients specific to THIS campaign (people, factions,
    // locations, troubles, quests, themes) -- distinct from the book's own fixed oracle tables.
    // Rolling on it answers "what does this connect to?" with something already established in
    // the story, rather than generating something wholly new. Optional; empty until the player
    // (or the AI, with the player's buy-in) starts building one. { id, text }[] -- kept as a
    // simple equal-weight list rather than replicating the book's d100-range table structure,
    // since the book's own ranges just distribute entries roughly evenly across 1-100 in
    // practice, and the AI can just pick one at random when rolling on it.
    campaignElements: [],
    lastPlayedAt: null, // ISO timestamp of the previous turn -- used to nudge toward Begin a Session after a real gap
    campaignName: null, // optional player-set nickname for this campaign, distinct from the character's name; null falls back to the character's name in the UI
    storySummary: { recent: '', distant: '' }, // multi-layer context compaction -- see summarizer.cjs. recent: moderate-detail recap of aged-out messages. distant: further-compressed long-term recap, folded in once recent grows large.
    log: [], // { timestamp, text } -- free-form campaign notes, appended for continuity across sessions
  };
}

/** Updates the character's flavor fields (name/callsign/pronouns/description). Doesn't touch stats. */
function updateCharacterFlavor(state, { name, callsign, pronouns, description }) {
  if (name !== undefined) state.character.name = name;
  if (callsign !== undefined) state.character.callsign = callsign;
  if (pronouns !== undefined) state.character.pronouns = pronouns;
  if (description !== undefined) state.character.description = description;
  return state.character;
}

/** Validates and applies the standard array (3/2/2/1/1, one value per stat) -- used both at
 *  character creation and for the post-creation "fix a mistake" editing path. Not a normal
 *  in-fiction action; Starforged doesn't support rebalancing stats mid-campaign, this is purely
 *  an administrative correction tool. */
function updateCharacterStats(state, stats) {
  const values = Object.values(stats).slice().sort((a, b) => a - b);
  const expected = [1, 1, 2, 2, 3];
  const valid = values.length === 5 && values.every((v, i) => v === expected[i]);
  if (!valid) {
    throw new Error('Stats must be exactly the standard array (3, 2, 2, 1, 1), one value per stat.');
  }
  Object.assign(state.character.stats, stats);
  return state.character.stats;
}

/** The post-creation "fix a chargen mistake" path -- unlike updateCharacterStats itself (used
 *  freely by campaign:new during character creation), this is deliberately usable only ONCE per
 *  character. Without that limit, nothing would stop a player from reassigning stats before
 *  every single roll to maximize whatever's about to be tested, then swapping back after --
 *  the same shape of mechanical lever as the combat-position and companion-health controls that
 *  were removed for exactly this reason. A one-time correction still serves the tool's actual
 *  purpose (fixing a real mistake) without allowing that. */
function correctCharacterStats(state, stats) {
  if (state.character.statsCorrected) {
    throw new Error('Stats have already been manually corrected once for this character. Further changes should happen in play, through the fiction, not by editing them directly.');
  }
  updateCharacterStats(state, stats);
  state.character.statsCorrected = true;
  return state.character.stats;
}

/** A campaign's own nickname, distinct from the character's name -- lets you tell two
 *  campaigns with similarly-named characters apart, or just call it something you like. */
function setCampaignName(state, name) {
  state.campaignName = name && name.trim() ? name.trim() : null;
  return state.campaignName;
}

/** These three meters overflow excess reduction into momentum loss when they hit 0 -- per the
 *  rulebook: "If your health is reduced to 0, or was already at 0, you must Lose Momentum and
 *  apply any remaining -health to your momentum meter" (and identically for spirit and
 *  integrity). Supply has no such rule -- it just marks Unprepared at 0. */
const OVERFLOW_TO_MOMENTUM_METERS = ['health', 'spirit', 'integrity'];

/** Returns { value, momentumOverflow }. momentumOverflow is the amount (positive number) that
 *  spilled into momentum loss because the meter was already at 0 or hit 0 partway through this
 *  reduction -- 0 when nothing overflowed, or for supply/momentum/positive deltas. */
/** Per the rulebook, a meter cannot be increased at all while its matching misfortune is marked --
 *  "when you mark wounded, you cannot regain health until you successfully Heal and clear that
 *  impact," and identically for shaken/spirit and unprepared/supply. Confirmed directly against
 *  all three rulebook pages, not assumed to generalize from just one. This is the meter side of
 *  that rule -- clearing the impact itself is a separate toggleImpact call the GM makes first
 *  (matching the rulebook's own sequencing: "clear the impact and take +2 health," clear then
 *  grant, not simultaneous), enforced here so a positive delta silently landing while the
 *  misfortune is still marked isn't possible even if that first step gets missed. */
const MISFORTUNE_BLOCKING_METER = { health: 'Wounded', spirit: 'Shaken', supply: 'Unprepared' };

/** Returns { value, momentumOverflow, unresolvedOverflow }. momentumOverflow is how much
 *  actually came off momentum. unresolvedOverflow is any remainder momentum couldn't absorb
 *  because it was already at its -6 floor -- per the rulebook, "if you must Lose Momentum, and
 *  your momentum is already at its minimum... apply the cost in some other way" (a condition
 *  meter, or a setback in a quest). That's a GM judgment call, so this just surfaces the number
 *  rather than guessing which meter should eat it. */
function updateMeter(state, meterName, delta) {
  const meters = state.character.meters;
  if (meterName === 'momentum') {
    meters.momentum = clamp(meters.momentum + delta, meters.momentum_min, meters.momentum_max);
    return { value: meters.momentum, momentumOverflow: 0, unresolvedOverflow: 0 };
  }
  const bounds = METER_BOUNDS[meterName];
  if (!bounds) throw new Error(`Unknown meter "${meterName}"`);
  if (delta > 0 && MISFORTUNE_BLOCKING_METER[meterName]) {
    const misfortuneName = MISFORTUNE_BLOCKING_METER[meterName];
    const misfortune = (state.character.impacts.Misfortunes || []).find((i) => i.name === misfortuneName);
    if (misfortune && misfortune.marked) {
      throw new Error(`Can't increase ${meterName} while ${misfortuneName} is marked -- clear that impact first (toggle_impact), per the rulebook's own "when you mark ${misfortuneName.toLowerCase()}, you cannot regain ${meterName} until you successfully clear that impact."`);
    }
  }
  const before = meters[meterName];
  const after = clamp(before + delta, bounds[0], bounds[1]);
  meters[meterName] = after;

  let momentumOverflow = 0;
  let unresolvedOverflow = 0;
  if (delta < 0 && OVERFLOW_TO_MOMENTUM_METERS.includes(meterName)) {
    const absorbed = before - after; // how much the meter actually had left to give
    const requestedOverflow = -delta - absorbed; // damage beyond what the meter could absorb
    if (requestedOverflow > 0) {
      const momentumBefore = meters.momentum;
      meters.momentum = clamp(meters.momentum - requestedOverflow, meters.momentum_min, meters.momentum_max);
      momentumOverflow = momentumBefore - meters.momentum; // what momentum actually gave up
      unresolvedOverflow = requestedOverflow - momentumOverflow; // couldn't be absorbed -- momentum was already at -6
    }
  }
  return { value: after, momentumOverflow, unresolvedOverflow };
}

/** Ranks map to how many ticks a progress move marks (out of 40 ticks = 10 boxes). */
const RANK_TICKS = {
  troublesome: 12,
  dangerous: 8,
  formidable: 4,
  extreme: 2,
  epic: 1,
};

function progressBoxes(ticks) {
  return Math.floor(clamp(ticks, 0, 40) / 4);
}

/**
 * Core tick-application logic, shared by markProgress (rank-based) and anything that needs to
 * apply an exact tick amount instead (e.g. bond rewards, which use a different table entirely).
 * Implements the Earn Experience move for legacy tracks automatically (see markProgress's own
 * comment) and the box-10 clearing rule.
 */
function applyTicksToTrack(state, track, delta) {
  const boxesBefore = progressBoxes(track.ticks);
  track.ticks = clamp(track.ticks + delta, 0, 40);
  const boxesAfter = progressBoxes(track.ticks);

  const result = { ticks: track.ticks, boxes: boxesAfter, experienceEarned: 0, legacyCleared: false };

  if (track.type === 'legacy') {
    const newBoxes = boxesAfter - boxesBefore;
    if (newBoxes > 0) {
      const xpPerBox = track.legacyCleared ? 1 : 2;
      result.experienceEarned = newBoxes * xpPerBox;
      earnExperience(state, result.experienceEarned);
    }
    if (boxesAfter >= 10) {
      result.boxes = 10;
      result.legacyCleared = true;
      track.ticks = 0;
      track.legacyCleared = true;
    }
  }

  return result;
}

/**
 * Marks progress on a track. For legacy tracks specifically, this also implements the Earn
 * Experience move: "When you fill a box (four ticks) on any legacy track, take 2 experience"
 * (1 experience per box instead, at the reduced rate, once the track has been cleared once) --
 * automatically, since it's a deterministic side effect of the rules rather than something that
 * needs GM judgment. It also implements clearing: "Once you completely fill the tenth box on any
 * legacy track, clear that track... If you make a progress roll against this track, resolve the
 * outcome as if at 10 progress" -- ticks reset to 0, but `legacyCleared` stays true forever,
 * which roll_progress_move uses to always treat the track's score as 10 from then on.
 */
function markProgress(state, trackId, rank) {
  const track = state.progressTracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`No progress track with id "${trackId}"`);
  const delta = RANK_TICKS[rank];
  if (delta === undefined) throw new Error(`Unknown rank "${rank}". Expected one of: ${Object.keys(RANK_TICKS).join(', ')}`);
  return applyTicksToTrack(state, track, delta);
}

/** Applies an exact tick amount instead of a rank-derived one -- used for bond rewards, which
 *  use a completely different table than ordinary progress marking (see BOND_REWARD_TICKS). */
function markProgressExact(state, trackId, ticks) {
  const track = state.progressTracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`No progress track with id "${trackId}"`);
  return applyTicksToTrack(state, track, ticks);
}

/** Removes a progress track entirely -- "clear the vow" (Forsake Your Vow), "clear the
 *  objective" (Face Defeat), and similar. Not for legacy tracks (those clear themselves at their
 *  10th box automatically and should never be deleted outright). */
function removeProgressTrack(state, trackId) {
  const track = state.progressTracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`No progress track with id "${trackId}".`);
  if (track.type === 'legacy') throw new Error('Legacy tracks (quests/bonds/discoveries) are never removed -- they clear themselves automatically at their 10th box.');
  state.progressTracks = state.progressTracks.filter((t) => t.id !== trackId);
  return { removed: trackId, name: track.name };
}

function burnMomentum(state) {
  const meters = state.character.meters;
  const value = meters.momentum;
  meters.momentum = meters.momentum_reset;
  return { burned: value, resetTo: meters.momentum };
}

// ---- Assets ----

/** Adds an asset the character doesn't already have, with its first ability unlocked. */
// Assets with their own trackable numeric resource pool -- ammo, cargo, shields, and similar --
// distinct from the character's own meters. Each maps to { max, label, start }; `start` is the
// value the asset begins with when added (shields starts unraised at 0; everything else starts
// at its stated full capacity). Fleet Commander's ability 2 raises max to 5 -- that's handled as
// an ability-unlock effect, not here, since this only covers the asset's initial state.
const ASSET_RESOURCES = {
  'Missile Array': { max: 5, label: 'ammo', start: 5 },
  Archer: { max: 6, label: 'ammo', start: 6 },
  'Expanded Hold': { max: 3, label: 'cargo', start: 0 },
  Shields: { max: 4, label: 'shields', start: 0 },
  'Fleet Commander': { max: 4, label: 'power', start: 4 },
  Blademaster: { max: 1, label: 'oathbound blade charge', start: 0 },
  Courier: { max: 5, label: 'safety', start: 5 },
  Firebrand: { max: 5, label: 'fire', start: 0 },
  Gearhead: { max: 1, label: 'prepared device (one-time, non-recharging)', start: 1 },
  'Crew Commander': { max: 4, label: 'command', start: 2 },
};

/** Marks (or clears) an owned asset as broken -- specifically for modules per Withstand Damage's
 *  own miss consequence ("mark a module as broken... a broken module cannot be used until you
 *  successfully Repair it"), though not hard-restricted to the module category at the state
 *  layer since the rules nuance of *when* this applies is better enforced by guidance than by
 *  blocking it here. A real mechanical restriction, not just a narrative note -- an asset's
 *  abilities shouldn't be usable while this is true. */
function setAssetBroken(state, assetId, broken) {
  const asset = state.character.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(`Character doesn't have an asset with id "${assetId}".`);
  asset.broken = Boolean(broken);
  return { assetId, name: asset.name, broken: asset.broken };
}

function addAsset(state, { id, name, category }) {
  if (state.character.assets.some((a) => a.id === id)) {
    throw new Error(`Character already has "${name}".`);
  }
  const asset = { id, name, category, abilities_unlocked: [1] };
  // Companion assets have their own health meter (0-5), separate from the character's, per
  // the Companion Takes a Hit move -- "Companion asset cards have a health meter."
  if (category === 'Companion') asset.health = 5;
  // Symbiote is a Path asset, not Companion, but has the exact same kind of mechanic ("You are
  // physically bound to a being with 2 health" -- explicitly resolved via Companion Takes a Hit
  // per its own ability text) -- reuses the same health field and tooling rather than a separate
  // system, just with its own (lower, asset-specific) starting value.
  if (name === 'Symbiote') asset.health = 2;
  // Vehicle Troubles (Battered/Cursed) are tracked directly on the specific vehicle, not as a
  // single character-wide flag -- per the rulebook, "these impacts are only a factor when you
  // are piloting or aboard that vehicle," and a character with two vehicles can have one
  // battered and the other not. Support vehicles can only ever be battered, never cursed --
  // the rulebook specifically ties Cursed to the command vehicle ("will forever plague your
  // STARSHIP"), and Withstand Damage's own miss menu only offers "mark battered" (no cursed
  // option at all) for support vehicles.
  if (category === 'Command Vehicle') {
    asset.battered = false;
    asset.cursed = false;
  } else if (category === 'Support Vehicle') {
    asset.battered = false;
  }
  if (ASSET_RESOURCES[name]) {
    const r = ASSET_RESOURCES[name];
    asset.resource = { current: r.start, max: r.max, label: r.label };
  }
  state.character.assets.push(asset);
  // Recompute momentum caps immediately -- covers Survivor's momentum-cap exemption taking
  // effect right away if a Lasting Effect was already marked before Survivor was gained (not
  // just the next time some unrelated event happens to trigger a recompute), and is a general
  // safety net for any future asset with a similar always-on effect.
  applyImpactEffects(state);
  return asset;
}

/** Adjusts an owned asset's own resource pool (ammo, cargo, shields, etc.) by a relative amount,
 *  clamped to [0, max]. For assets with no resource pool at all, throws -- there's nothing to
 *  adjust, and silently no-op-ing would hide a real mistake (wrong asset, or an ability that
 *  doesn't actually have this kind of mechanic). */
function adjustAssetResource(state, assetId, delta) {
  const asset = state.character.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(`Character doesn't have an asset with id "${assetId}".`);
  if (!asset.resource) throw new Error(`"${asset.name}" doesn't have a tracked resource pool.`);
  asset.resource.current = clamp(asset.resource.current + delta, 0, asset.resource.max);
  return { assetId, resource: asset.resource };
}

/** Sets an owned asset's resource to an absolute value (Shields being set to 2/3/4 by a roll,
 *  Fleet Commander's max being raised to 5) rather than adjusted by a relative delta. Can also
 *  raise max itself (Fleet Commander's "set your max power to 5"), keeping current clamped to
 *  whatever the (possibly new) max allows. */
function setAssetResource(state, assetId, { current, max }) {
  const asset = state.character.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(`Character doesn't have an asset with id "${assetId}".`);
  if (!asset.resource) throw new Error(`"${asset.name}" doesn't have a tracked resource pool.`);
  if (typeof max === 'number') asset.resource.max = max;
  if (typeof current === 'number') asset.resource.current = clamp(current, 0, asset.resource.max);
  return { assetId, resource: asset.resource };
}

/**
 * The Companion Takes a Hit move: reduces a companion asset's health by the harm suffered,
 * with the same overflow-to-momentum rule as Health/Spirit/Integrity ("If your companion's
 * health is reduced to 0, or was already at 0, you must Lose Momentum and apply any remaining
 * -health to your momentum meter"). Returns whether the companion is now out of action (health
 * 0) so the caller/GM knows to narrate that, without deciding life-or-death for them --
 * "dead or destroyed" only happens on a miss with a match on the follow-up roll, which is a
 * fictional/mechanical judgment call for the move itself, not something this function assumes.
 */
/** Symbiote (a Path asset that works like a Companion, see addAsset) has its own, lower max
 *  health -- 2 normally, 3 once its third ability is unlocked -- unlike every real Companion-
 *  category asset, which is always 5. Shared by every function that needs to clamp a companion's
 *  health correctly, so this only needs to be right in one place. */
function companionMaxHealth(asset) {
  if (asset.name === 'Symbiote') return asset.abilities_unlocked.includes(3) ? 3 : 2;
  return 5;
}

function companionTakesAHit(state, assetId, harmDelta) {
  const asset = state.character.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(`No owned asset with id "${assetId}".`);
  if (asset.category !== 'Companion' && asset.name !== 'Symbiote') throw new Error(`"${asset.name}" is not a Companion asset (it's ${asset.category}) and has no health meter.`);
  if (harmDelta >= 0) throw new Error('harmDelta must be negative (this move only reduces companion health).');

  const before = asset.health;
  const after = clamp(before + harmDelta, 0, companionMaxHealth(asset));
  asset.health = after;

  const absorbed = before - after;
  const requestedOverflow = -harmDelta - absorbed;
  let momentumOverflow = 0;
  let unresolvedOverflow = 0;
  if (requestedOverflow > 0) {
    const meters = state.character.meters;
    const momentumBefore = meters.momentum;
    meters.momentum = clamp(meters.momentum - requestedOverflow, meters.momentum_min, meters.momentum_max);
    momentumOverflow = momentumBefore - meters.momentum;
    unresolvedOverflow = requestedOverflow - momentumOverflow;
  }
  return { assetId, name: asset.name, health: asset.health, maxHealth: companionMaxHealth(asset), momentumOverflow, unresolvedOverflow, outOfAction: asset.health === 0 };
}

/** The positive counterpart to companionTakesAHit -- there was previously no way to increase a
 *  companion's health at all (that function explicitly rejects a non-negative delta by design,
 *  matching its own name), even though several real mechanics need to: the Companion Takes a
 *  Hit move's own strong/weak hit results, Repair's "+1 health for a mechanical companion,"
 *  Sprite's free full heal, Rockhorn's bonus health on a match. Clamped to the correct per-asset
 *  max via the same shared helper companionTakesAHit uses. */
function healCompanion(state, assetId, amount) {
  const asset = state.character.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(`No owned asset with id "${assetId}".`);
  if (asset.category !== 'Companion' && asset.name !== 'Symbiote') throw new Error(`"${asset.name}" is not a Companion asset (it's ${asset.category}) and has no health meter.`);
  if (amount <= 0) throw new Error('amount must be positive (use companion_takes_a_hit to reduce health instead).');
  const before = asset.health;
  asset.health = clamp(before + amount, 0, companionMaxHealth(asset));
  return { assetId, name: asset.name, health: asset.health, maxHealth: companionMaxHealth(asset), healed: asset.health - before };
}

/** Removes an owned asset entirely -- used when it's destroyed, lost, or discarded (e.g.
 *  Overcome Destruction: "you must discard the asset, along with any modules and docked
 *  support vehicles"). Unlike unlocking abilities, this can't be undone by spending experience. */
function removeAsset(state, assetId) {
  const before = state.character.assets.length;
  const asset = state.character.assets.find((a) => a.id === assetId);
  state.character.assets = state.character.assets.filter((a) => a.id !== assetId);
  if (state.character.assets.length === before) throw new Error(`Character doesn't have an asset with id "${assetId}".`);
  return { removed: asset.name };
}

/** Unlocks ability 2 or 3 on an asset the character already owns. */
function unlockAssetAbility(state, id, abilityNumber) {
  const asset = state.character.assets.find((a) => a.id === id);
  if (!asset) throw new Error(`Character doesn't have an asset with id "${id}".`);
  if (![2, 3].includes(abilityNumber)) throw new Error('abilityNumber must be 2 or 3 (the first is unlocked automatically on purchase).');
  if (!asset.abilities_unlocked.includes(abilityNumber)) asset.abilities_unlocked.push(abilityNumber);
  return asset;
}

// ---- Experience ----

function availableExperience(state) {
  return state.character.experience.earned - state.character.experience.spent;
}

function earnExperience(state, amount) {
  if (amount <= 0) throw new Error('Experience earned must be positive.');
  state.character.experience.earned += amount;
  return availableExperience(state);
}

/** Throws if the character can't afford it; otherwise spends and returns the remaining total. */
function spendExperience(state, amount) {
  if (availableExperience(state) < amount) {
    throw new Error(`Not enough experience: has ${availableExperience(state)}, needs ${amount}.`);
  }
  state.character.experience.spent += amount;
  return availableExperience(state);
}

const ASSET_PURCHASE_COST = 3;
const ASSET_UPGRADE_COST = 2;

// ---- Sector map (a campaign can have multiple sectors -- "as you head out into the unknown,
// you can discover, explore, and name new sectors," per the rulebook) ----

/** Fixed grid size per sector, matching roughly the density of the physical Sector Worksheet. */
const SECTOR_COLS = 12;
const SECTOR_ROWS = 8;

function newSector(id, { name = '', region = '', factionControl = '' } = {}) {
  return {
    id,
    name,
    region,
    factionControl,
    notes: '', // overarching sector-level context, e.g. the rolled Sector Trouble
    cells: {}, // cellId ("col,row") -> { name, notes, features: [{id,type,name,description}], imageId }
    passages: [], // { id, fromCell, toCell: string|null (null = leads off-map to another sector), notes }
    currentCell: null,
  };
}

/** Resolves a sector by id, or the campaign's current sector if id is null/undefined. */
function getSector(state, sectorId) {
  const id = sectorId || state.currentSectorId;
  const sector = state.sectors[id];
  if (!sector) throw new Error(`No sector with id "${id}".`);
  if (!sector.passages) sector.passages = []; // backward compatibility: sectors saved before passages existed
  return sector;
}

let sectorCounter = 0;
/** Creates a new sector (doesn't switch to it -- call switchSector separately once the party
 *  actually arrives). Starts empty; populate it with reveal_location/add_location_feature. */
function createSector(state, { name, region, factionControl }) {
  const id = `sector-${Date.now().toString(36)}${(sectorCounter++).toString(36)}`;
  const sector = newSector(id, { name, region, factionControl });
  state.sectors[id] = sector;
  return sector;
}

/** Switches which sector is "current" -- the one the sector map displays and the one
 *  set_current_location/reveal_location operate on by default. */
function switchSector(state, sectorId) {
  if (!state.sectors[sectorId]) throw new Error(`No sector with id "${sectorId}".`);
  state.currentSectorId = sectorId;
  return sectorId;
}

function validCellId(cellId) {
  const m = /^(\d+),(\d+)$/.exec(cellId);
  if (!m) return false;
  const col = Number(m[1]);
  const row = Number(m[2]);
  return col >= 0 && col < SECTOR_COLS && row >= 0 && row < SECTOR_ROWS;
}

function assertValidCell(cellId) {
  if (!validCellId(cellId)) {
    throw new Error(`"${cellId}" isn't a valid sector cell. Use "col,row" with col 0-${SECTOR_COLS - 1} and row 0-${SECTOR_ROWS - 1}.`);
  }
}

function setSectorInfo(state, sectorId, { name, region, factionControl, notes }) {
  const sector = getSector(state, sectorId);
  if (name !== undefined) sector.name = name;
  if (region !== undefined) sector.region = region;
  if (factionControl !== undefined) sector.factionControl = factionControl;
  if (notes !== undefined) sector.notes = notes;
  return sector;
}

function getOrCreateCell(state, sectorId, cellId) {
  assertValidCell(cellId);
  const sector = getSector(state, sectorId);
  if (!sector.cells[cellId]) {
    sector.cells[cellId] = { name: '', notes: '', features: [], imageId: null };
  }
  return sector.cells[cellId];
}

function updateCell(state, sectorId, cellId, { name, notes }) {
  const cell = getOrCreateCell(state, sectorId, cellId);
  if (name !== undefined) cell.name = name;
  if (notes !== undefined) cell.notes = notes;
  return cell;
}

const FEATURE_TYPES = ['star', 'planet', 'settlement', 'derelict', 'vault', 'starship', 'npc', 'creature', 'faction', 'sighting', 'other'];

let featureCounter = 0;
function addFeature(state, sectorId, cellId, { type, name, description }) {
  if (!FEATURE_TYPES.includes(type)) {
    throw new Error(`Unknown feature type "${type}". Expected one of: ${FEATURE_TYPES.join(', ')}`);
  }
  const cell = getOrCreateCell(state, sectorId, cellId);
  const feature = { id: `f${Date.now().toString(36)}${(featureCounter++).toString(36)}`, type, name, description: description || '' };
  cell.features.push(feature);
  return feature;
}

function removeFeature(state, sectorId, cellId, featureId) {
  const sector = getSector(state, sectorId);
  const cell = sector.cells[cellId];
  if (!cell) throw new Error(`No cell "${cellId}".`);
  const before = cell.features.length;
  cell.features = cell.features.filter((f) => f.id !== featureId);
  if (cell.features.length === before) throw new Error(`No feature "${featureId}" in cell "${cellId}".`);
  return cell;
}

function setCurrentCell(state, sectorId, cellId) {
  getOrCreateCell(state, sectorId, cellId); // ensures it exists so the map shows "you are here" even if undetailed
  const sector = getSector(state, sectorId);
  sector.currentCell = cellId;
  return cellId;
}

function setCellImage(state, sectorId, cellId, imageId) {
  const cell = getOrCreateCell(state, sectorId, cellId);
  cell.imageId = imageId;
  return cell;
}

let passageCounter = 0;
/** A passage is a charted route between two known locations (or between a known location and
 *  the edge of the map, implying travel onward to another sector) -- per "Build a Starting
 *  Sector," Step 7: "Connect two settlements" or "Connect a settlement to the edge of your
 *  sector map." Both endpoints must already be real, discovered cells (an empty hex isn't a
 *  destination anyone's charted a route to) -- toCell may be null for the map-edge case, but if
 *  given, it's validated the same way as fromCell. Passages are undirected: a route from A to B
 *  is the same route as B to A, so creating one that already exists (in either direction) just
 *  returns the existing one rather than duplicating it. */
function createPassage(state, sectorId, { fromCell, toCell, notes }) {
  const sector = getSector(state, sectorId);
  assertValidCell(fromCell);
  if (!sector.cells[fromCell]) throw new Error(`"${fromCell}" hasn't been discovered yet -- a passage needs a real, known location on at least one end.`);
  if (toCell !== null && toCell !== undefined) {
    assertValidCell(toCell);
    if (!sector.cells[toCell]) throw new Error(`"${toCell}" hasn't been discovered yet -- a passage needs a real, known location on at least one end.`);
  } else {
    toCell = null;
  }
  const existing = sector.passages.find((p) => (p.fromCell === fromCell && p.toCell === toCell) || (p.fromCell === toCell && p.toCell === fromCell));
  if (existing) return existing;
  const passage = { id: `p${Date.now().toString(36)}${(passageCounter++).toString(36)}`, fromCell, toCell, notes: notes || '' };
  sector.passages.push(passage);
  return passage;
}

function removePassage(state, sectorId, passageId) {
  const sector = getSector(state, sectorId);
  const before = sector.passages.length;
  sector.passages = sector.passages.filter((p) => p.id !== passageId);
  if (sector.passages.length === before) throw new Error(`No passage "${passageId}".`);
  return { removed: passageId };
}

// ---- Setting Truths ----

/** Records the resolved truth for one of the 14 categories (overwrites any prior choice). */
function setTruth(state, category, { result, subtableResult, description, questStarter, source }) {
  state.truths[category] = {
    result,
    subtableResult: subtableResult || null,
    description: description || '',
    questStarter: questStarter || '',
    source: source || 'chosen', // 'rolled' | 'chosen'
  };
  return state.truths[category];
}

function clearTruth(state, category) {
  delete state.truths[category];
}

// ---- Connections ----

let connectionCounter = 0;
function addConnection(state, { name, notes, location }) {
  const connection = {
    id: `c${Date.now().toString(36)}${(connectionCounter++).toString(36)}`,
    name,
    notes: notes || '',
    // Per the book's own Make a Connection text: "make note of their name, location, and any
    // other characteristics worth recording" -- a distinct field on the official Connections
    // Worksheet (name/location/role/role), not just folded into general notes.
    location: location || '',
    imageId: null,
    rank: null, // set via setConnectionRank once established; needed before Forge a Bond
    progressTicks: 0, // this connection's own relationship-progress track
    bonded: false, // true once Forge a Bond succeeds -- changes how Develop Your Relationship resolves
    role: null, // e.g. "ship mechanic", "faction representative" -- set via Make a Connection
    secondRole: null, // set if Forge a Bond's "Expand their influence" is chosen
    roleBonus: 1, // becomes 2 if Forge a Bond's "Bolster their influence" is chosen
    benefitsSuspended: false, // true after a Test Your Relationship miss, until the affirming quest resolves
  };
  state.connections.push(connection);
  return connection;
}

/** Make a Connection: sets a connection's role, which grants +roleBonus and +1 momentum
 *  whenever they aid a move closely tied to that role, on a hit -- applies whether bonded or not. */
function setConnectionRole(state, id, role) {
  const c = state.connections.find((x) => x.id === id);
  if (!c) throw new Error(`No connection with id "${id}".`);
  c.role = role;
  return c;
}

/** Forge a Bond's strong-hit choice, option A: the existing role's bonus becomes +2 instead of +1. */
function bolsterConnectionRole(state, id) {
  const c = state.connections.find((x) => x.id === id);
  if (!c) throw new Error(`No connection with id "${id}".`);
  c.roleBonus = 2;
  return c;
}

/** Forge a Bond's strong-hit choice, option B: a second role, each granting +1 (not stacked to +2). */
function expandConnectionRole(state, id, secondRole) {
  const c = state.connections.find((x) => x.id === id);
  if (!c) throw new Error(`No connection with id "${id}".`);
  c.secondRole = secondRole;
  return c;
}

/** Test Your Relationship's miss consequence: the connection's mechanical/narrative benefits are
 *  suspended until the affirming quest is completed (restoreConnectionBenefits), or the
 *  connection is broken entirely (removeConnection) if the quest is refused or fails. */
function suspendConnectionBenefits(state, id) {
  const c = state.connections.find((x) => x.id === id);
  if (!c) throw new Error(`No connection with id "${id}".`);
  c.benefitsSuspended = true;
  return c;
}

function restoreConnectionBenefits(state, id) {
  const c = state.connections.find((x) => x.id === id);
  if (!c) throw new Error(`No connection with id "${id}".`);
  c.benefitsSuspended = false;
  return c;
}

function updateConnection(state, id, { name, notes, location }) {
  const c = state.connections.find((x) => x.id === id);
  if (!c) throw new Error(`No connection with id "${id}".`);
  if (name !== undefined) c.name = name;
  if (notes !== undefined) c.notes = notes;
  if (location !== undefined) c.location = location;
  return c;
}

function setConnectionImage(state, id, imageId) {
  const c = state.connections.find((x) => x.id === id);
  if (!c) throw new Error(`No connection with id "${id}".`);
  c.imageId = imageId;
  return c;
}

/** Shared rank progression order, used for connections AND ordinary progress tracks (vows,
 *  expeditions) alike -- Fulfill Your Vow and Finish an Expedition raise a track's own rank the
 *  same way Forge a Bond raises a connection's rank. */
const RANK_ORDER = ['troublesome', 'dangerous', 'formidable', 'extreme', 'epic'];

function raiseRank(rank) {
  const idx = RANK_ORDER.indexOf(rank);
  if (idx < 0 || idx >= RANK_ORDER.length - 1) return rank;
  return RANK_ORDER[idx + 1];
}

const CONNECTION_RANKS = RANK_ORDER;

/** Sets or raises a connection's rank. Forge a Bond and Develop Your Relationship both require
 *  a rank be established first ("mark progress per the rank of the connection"). */
function setConnectionRank(state, id, rank) {
  if (!CONNECTION_RANKS.includes(rank)) throw new Error(`Unknown rank "${rank}". Expected one of: ${CONNECTION_RANKS.join(', ')}`);
  const c = state.connections.find((x) => x.id === id);
  if (!c) throw new Error(`No connection with id "${id}".`);
  c.rank = rank;
  return c;
}

/** Raises a connection's rank by one step, if not already epic (used after a strong hit with a
 *  match on Develop Your Relationship, and after recommitting post-Forge-a-Bond miss). */
function raiseConnectionRank(state, id) {
  const c = state.connections.find((x) => x.id === id);
  if (!c) throw new Error(`No connection with id "${id}".`);
  if (!c.rank) throw new Error(`Connection "${c.name}" has no rank set yet.`);
  c.rank = raiseRank(c.rank);
  return c;
}

/** Develop Your Relationship (pre-bond path): marks progress on the connection's own track,
 *  using ordinary RANK_TICKS by the connection's rank -- same table as any other progress track. */
function markConnectionProgress(state, id) {
  const c = state.connections.find((x) => x.id === id);
  if (!c) throw new Error(`No connection with id "${id}".`);
  if (!c.rank) throw new Error(`Connection "${c.name}" has no rank set yet -- call set_connection_rank first.`);
  const delta = RANK_TICKS[c.rank];
  const boxesBefore = progressBoxes(c.progressTicks);
  c.progressTicks = clamp(c.progressTicks + delta, 0, 40);
  return { ticks: c.progressTicks, boxes: progressBoxes(c.progressTicks), boxesGained: progressBoxes(c.progressTicks) - boxesBefore };
}

/**
 * The shared "legacy reward" table used by Forge a Bond, Fulfill Your Vow, and Finish an
 * Expedition alike -- this is NOT the same as RANK_TICKS. A higher rank gives a BIGGER reward,
 * the opposite direction from ordinary progress marking (where lower ranks fill faster per
 * mark). Troublesome=1 tick, Dangerous=2, Formidable=1 box (4 ticks), Extreme=2 boxes (8 ticks),
 * Epic=3 boxes (12 ticks). All three moves also share the "weak hit = one rank lower" rule
 * (pass the already-reduced rank yourself, this function doesn't guess at outcome) and an
 * identical miss+recommit consequence (see recommitProgressTrack / recommitAfterFailedBond).
 */
const LEGACY_REWARD_TICKS = {
  troublesome: 1,
  dangerous: 2,
  formidable: 4,
  extreme: 8,
  epic: 12,
};

/** Applies the shared legacy reward table to any legacy track, by rank. Used directly for
 *  Fulfill Your Vow (legacy-quests) and Finish an Expedition (legacy-discoveries); applyBondReward
 *  below is a thin wrapper over this for Forge a Bond (legacy-bonds), which also needs to flip
 *  the connection's `bonded` flag as a side effect. */
function applyLegacyReward(state, trackId, rank) {
  if (!LEGACY_REWARD_TICKS[rank]) throw new Error(`Unknown rank "${rank}". Expected one of: ${RANK_ORDER.join(', ')}`);
  const ticks = LEGACY_REWARD_TICKS[rank];
  const legacyResult = markProgressExact(state, trackId, ticks);
  return { trackId, rank, ticksAwarded: ticks, ...legacyResult };
}

/** Forge a Bond / Develop Your Relationship reward: applies the shared legacy reward table to
 *  the bonds legacy track and marks the connection as bonded. */
function applyBondReward(state, connectionId) {
  const c = state.connections.find((x) => x.id === connectionId);
  if (!c) throw new Error(`No connection with id "${connectionId}".`);
  if (!c.rank) throw new Error(`Connection "${c.name}" has no rank set yet -- call set_connection_rank first.`);
  const result = applyLegacyReward(state, 'legacy-bonds', c.rank);
  c.bonded = true;
  return { connectionId, ...result };
}

/**
 * Deterministically applies a hand-verified, structured asset-ability effect against a roll's
 * ACTUAL outcome and match -- built specifically so the genuinely mechanical portion of an
 * ability (a fixed momentum grant, a legacy tick, an unconditional outcome shift) is computed
 * and applied by code, not left to the model to recall and apply correctly from prose. The
 * model is still the one deciding the two things that genuinely require judgment: whether this
 * ability's fictional trigger applies at all, and calling this only once that's confirmed --
 * this function does no fiction-reading of its own, only arithmetic against a result that
 * already happened.
 *
 * `effect` is a hand-authored, per-ability descriptor (see ASSET_STRUCTURED_EFFECTS below) --
 * deliberately NOT inferred from the free-text catalog at runtime. Every field is optional;
 * only unconditional, non-choice-gated mechanics are ever represented here. Anything
 * conditional on a player choice, a different meter's value, or persisting into a future move
 * is deliberately left OUT of this structure and stays with the model's own reading of the
 * asset's full guidance elsewhere in this prompt -- see the README for why (checked directly
 * against real ability text, not assumed).
 */
function applyStructuredAssetEffect(state, effect, { outcome, isMatch }) {
  const isHit = outcome === 'strong_hit' || outcome === 'weak_hit';
  const applied = { momentumDelta: 0, legacyTicks: 0, legacyTrack: null, effectiveOutcome: outcome };
  // preRollAdd (if this effect has one) is deliberately NOT applied here -- by the time this
  // function runs the roll has already happened, and that portion of the ability is already the
  // responsibility of the existing pre-roll check_asset_bonuses workflow (surfaced before
  // rolling, folded into the adds actually passed to roll_action_move). Echoed back for
  // confirmation only, as a reminder that it should have already been included, not something
  // this function itself applies.
  if (effect.preRollAdd) applied.preRollAddReminder = effect.preRollAdd;

  if (isHit) {
    if (effect.momentumOnHit) applied.momentumDelta += effect.momentumOnHit;
    if (effect.momentumOnStrongHitOnly && outcome === 'strong_hit') applied.momentumDelta += effect.momentumOnStrongHitOnly;
    // Every match-gated bonus in the hand-verified table below is written against the source
    // text's own condition -- some genuinely trigger on ANY hit with a match, others (most of
    // the legacy-tick cases) specifically say "strong hit w/ match" and do NOT apply on a
    // matched weak hit. matchBonusRequiresStrongHit distinguishes the two; defaulting it to
    // false would silently grant a bonus the source text never actually promises.
    const matchApplies = isMatch && (!effect.matchBonusRequiresStrongHit || outcome === 'strong_hit');
    if (effect.momentumMatchBonus && matchApplies) applied.momentumDelta += effect.momentumMatchBonus;
    if (effect.legacyTrack && (effect.legacyTicksOnHit || (effect.legacyTicksMatchBonus && matchApplies))) {
      applied.legacyTrack = effect.legacyTrack;
      if (effect.legacyTicksOnHit) applied.legacyTicks += effect.legacyTicksOnHit;
      if (effect.legacyTicksMatchBonus && matchApplies) applied.legacyTicks += effect.legacyTicksMatchBonus;
    }
  }

  if (effect.outcomeShift === 'weak_to_strong' && outcome === 'weak_hit') applied.effectiveOutcome = 'strong_hit';
  if (effect.outcomeShift === 'miss_to_weak' && outcome === 'miss') applied.effectiveOutcome = 'weak_hit';

  if (applied.momentumDelta !== 0) {
    updateMeter(state, 'momentum', applied.momentumDelta);
  }
  if (applied.legacyTrack && applied.legacyTicks > 0) {
    markProgressExact(state, applied.legacyTrack, applied.legacyTicks);
  }

  return applied;
}

/**
 * Hand-verified structured effects for asset abilities whose FULL mechanics -- not just part of
 * them -- are genuinely unconditional and completely representable here: no player choice, no
 * reroll, no dependency on a different meter's live value, no consequence (a miss penalty, a
 * second effect) this schema doesn't also cover. An early, larger draft of this table included
 * several abilities that only partly fit -- "+1, +1 momentum on hit" entries missing the +1 roll
 * bonus itself, abilities with an unstructured reroll or miss consequence alongside the
 * structurable part -- caught by re-checking every single entry against the real effect text
 * directly rather than trusting an earlier summary from memory, and removed rather than
 * included incomplete: applying only part of an ability and returning a result that looks
 * complete is worse than not structuring it at all, since it would silently drop the rest.
 * Each entry checked directly against the asset pseudocode's own effect text (itself
 * cross-checked against Dataforged and the rulebook throughout this project). An ability not
 * listed here isn't safely structurable and stays exactly as it already was -- surfaced by
 * check_asset_bonuses as free text for the model to read and apply itself. Keyed by
 * "AssetName:Level".
 */
const ASSET_STRUCTURED_EFFECTS = {
  // "+1, +1 momentum on hit" -- both halves: the roll bonus AND the momentum grant.
  'Ace:1': { preRollAdd: 1, momentumOnHit: 1 },
  'Missile Array:2': { preRollAdd: 1, momentumOnHit: 1 },
  'Research Lab:1': { preRollAdd: 1, momentumOnHit: 1 },
  'Service Pod:1': { preRollAdd: 1, momentumOnHit: 1 },
  'Shuttle:2': { preRollAdd: 1, momentumOnHit: 1 },
  'Skiff:3': { preRollAdd: 1, momentumOnHit: 1 },
  'Brawler:1': { preRollAdd: 1, momentumOnHit: 1 },
  'Demolitionist:2': { preRollAdd: 1, momentumOnHit: 1 },
  'Fugitive:2': { preRollAdd: 1, momentumOnHit: 1 },
  'Gearhead:1': { preRollAdd: 1, momentumOnHit: 1 },
  // "+1, +1 momentum on hit (+1 more on strong hit w/ match)" -- fully captured, no leftover.
  'Heavy Cannons:3': { preRollAdd: 1, momentumOnHit: 1, momentumMatchBonus: 1, matchBonusRequiresStrongHit: true },
  // "+1; strong hit w/ match: mark N tick(s) [track] legacy" -- a roll bonus, no on-hit momentum,
  // a legacy tick gated specifically to a MATCHED STRONG hit (not a matched weak hit).
  'Marked:1': { preRollAdd: 1, legacyTrack: 'legacy-bonds', legacyTicksMatchBonus: 2, matchBonusRequiresStrongHit: true },
  // "+1, +1 momentum on hit; strong hit w/ match: mark N tick(s) [track] legacy" -- combines
  // both of the shapes above; the legacy tick has no separate on-hit base, only the match bonus.
  'Naturalist:1': { preRollAdd: 1, momentumOnHit: 1, legacyTrack: 'legacy-discoveries', legacyTicksMatchBonus: 1, matchBonusRequiresStrongHit: true },
  'Healer:2': { preRollAdd: 1, momentumOnHit: 1, legacyTrack: 'legacy-discoveries', legacyTicksMatchBonus: 1, matchBonusRequiresStrongHit: true },
};

/** Returns the hand-verified structured effect for an owned, unlocked asset ability, or null if
 *  this specific ability isn't in the safely-structurable subset (see ASSET_STRUCTURED_EFFECTS). */
function getStructuredAssetEffect(assetName, level) {
  return ASSET_STRUCTURED_EFFECTS[`${assetName}:${level}`] || null;
}

/**
 * The shared miss+recommit consequence for Fulfill Your Vow ("recommit to the quest") and
 * Finish an Expedition ("return to the expedition") -- works on any ordinary progress track
 * (vow, expedition, scene_challenge, etc.), not just connections: "roll both challenge dice,
 * take the lowest value, and clear that number of progress boxes. Then, raise the rank by one."
 * Not automatic -- the rulebook makes this conditional on the player's choice to recommit/return,
 * so this is a separate call the GM only makes if they do.
 */
function recommitProgressTrack(state, trackId) {
  const track = state.progressTracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`No progress track with id "${trackId}".`);
  if (!track.rank) throw new Error(`Track "${track.name}" has no rank to raise.`);
  const d1 = dice.randInt(1, 10);
  const d2 = dice.randInt(1, 10);
  const lowest = Math.min(d1, d2);
  const clearedTicks = Math.min(track.ticks, lowest * 4);
  track.ticks = clamp(track.ticks - clearedTicks, 0, 40);
  track.rank = raiseRank(track.rank);
  return { dice: [d1, d2], lowest, clearedTicks, newTicks: track.ticks, newRank: track.rank };
}

/** Forge a Bond's miss consequence, only if the player chooses to recommit ("if you recommit to
 *  this relationship, roll both challenge dice, take the lowest value, and clear that number of
 *  progress boxes. Then, raise the connection's rank by one."). Not automatic -- the rulebook
 *  makes recommitting a player choice, so this is a separate call the GM only makes if they do. */
function recommitAfterFailedBond(state, connectionId) {
  const c = state.connections.find((x) => x.id === connectionId);
  if (!c) throw new Error(`No connection with id "${connectionId}".`);
  const d1 = dice.randInt(1, 10);
  const d2 = dice.randInt(1, 10);
  const lowest = Math.min(d1, d2);
  const clearedTicks = Math.min(c.progressTicks, lowest * 4);
  c.progressTicks = clamp(c.progressTicks - clearedTicks, 0, 40);
  raiseConnectionRank(state, connectionId);
  return { dice: [d1, d2], lowest, clearedTicks, newTicks: c.progressTicks, newRank: c.rank };
}

function removeConnection(state, id) {
  const before = state.connections.length;
  state.connections = state.connections.filter((c) => c.id !== id);
  if (state.connections.length === before) throw new Error(`No connection with id "${id}".`);
}

// ---- Campaign log ----

function addLogEntry(state, text) {
  const entry = { timestamp: new Date().toISOString(), text };
  state.log.push(entry);
  return entry;
}

/** Hours since the previous turn, or null if this is the very first turn (nothing to compare
 *  against yet). Used to nudge the GM toward Begin a Session's recap+flag-check+optional-
 *  vignette procedure after a real gap, since there's no other reliable "a new session started"
 *  signal in a persistent single conversation. */
function hoursSinceLastPlayed(state) {
  if (!state.lastPlayedAt) return null;
  const ms = Date.now() - new Date(state.lastPlayedAt).getTime();
  return ms / (1000 * 60 * 60);
}

/** Call once per turn (after computing hoursSinceLastPlayed for the system prompt, so this
 *  turn's own timestamp doesn't overwrite the value being compared against). */
function markPlayed(state) {
  state.lastPlayedAt = new Date().toISOString();
}

/** Set a Flag: content the player wants approached mindfully, omitted, or checked in about.
 *  Persisted at the campaign level (not just conversation context) so it isn't lost to context
 *  truncation over a long campaign -- "once content has been flagged, it should remain flagged
 *  for every session going forward." */
function addFlag(state, text) {
  if (state.flags.includes(text)) throw new Error(`"${text}" is already flagged.`);
  state.flags.push(text);
  return state.flags;
}

function removeFlag(state, text) {
  const before = state.flags.length;
  state.flags = state.flags.filter((f) => f !== text);
  if (state.flags.length === before) throw new Error(`"${text}" is not currently flagged.`);
  return state.flags;
}

// ---- Campaign Elements (a player-curated, campaign-specific answer table) ----

function addCampaignElement(state, text) {
  const id = `element-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  state.campaignElements.push({ id, text });
  return { id, text };
}

function removeCampaignElement(state, id) {
  const before = state.campaignElements.length;
  state.campaignElements = state.campaignElements.filter((e) => e.id !== id);
  if (state.campaignElements.length === before) throw new Error(`No campaign element with id "${id}".`);
  return state.campaignElements;
}

/** Picks one entry at random, equal weight -- see the campaignElements field comment above for
 *  why this doesn't replicate the book's own d100-range table structure. Uses the same crypto
 *  RNG as every other roll in this engine, not Math.random(), for genuine consistency. */
function rollCampaignElement(state) {
  if (state.campaignElements.length === 0) throw new Error('No campaign elements defined yet -- nothing to roll on.');
  const idx = dice.randInt(0, state.campaignElements.length - 1);
  return state.campaignElements[idx];
}

// ---- Clocks (Campaign Clocks and Tension Clocks) ----

const VALID_CLOCK_SEGMENTS = [4, 6, 8, 10];

let clockCounter = 0;
function createClock(state, { name, type, segments }) {
  if (!['campaign', 'tension'].includes(type)) {
    throw new Error(`Unknown clock type "${type}". Expected "campaign" or "tension".`);
  }
  if (!VALID_CLOCK_SEGMENTS.includes(segments)) {
    throw new Error(`Clocks have 4, 6, 8, or 10 segments, not ${segments}.`);
  }
  const clock = { id: `clk${Date.now().toString(36)}${(clockCounter++).toString(36)}`, name, type, segments, filled: 0 };
  state.clocks.push(clock);
  return clock;
}

/** Advances a clock by `amount` segments (never below 0, capped at its segment count -- clocks
 *  never go backwards except by being stopped/removed entirely, per the rulebook: "Never erase
 *  segments -- clocks are inexorable and only move forward.") */
function advanceClock(state, id, amount) {
  const clock = state.clocks.find((c) => c.id === id);
  if (!clock) throw new Error(`No clock with id "${id}".`);
  if (amount < 0) throw new Error('Clocks only move forward -- use stopClock to remove one instead of reducing its fill.');
  clock.filled = clamp(clock.filled + amount, 0, clock.segments);
  return { id, filled: clock.filled, segments: clock.segments, completed: clock.filled >= clock.segments };
}

/** Removes a clock from play entirely (resolved, stopped, or no longer relevant). */
function stopClock(state, id) {
  const before = state.clocks.length;
  state.clocks = state.clocks.filter((c) => c.id !== id);
  if (state.clocks.length === before) throw new Error(`No clock with id "${id}".`);
}

/**
 * Begin the Scene move: creates a progress track AND a linked 4-segment tension clock together,
 * per the rulebook's Scene Challenge structure ("you'll create a standard progress track... You'll
 * also set a tension clock of four segments"). Returns both so the caller can reference either;
 * the track's `linkedClockId` and the clock's `linkedTrackId` tie them together for Finish the
 * Scene, which resolves when either one fills.
 */
function createSceneChallenge(state, { id, name, rank }) {
  if (state.progressTracks.some((t) => t.id === id)) {
    throw new Error(`A track with id "${id}" already exists.`);
  }
  if (!RANK_TICKS[rank]) throw new Error(`Unknown rank "${rank}". Expected one of: ${Object.keys(RANK_TICKS).join(', ')}`);
  const clock = createClock(state, { name: `${name} (tension)`, type: 'tension', segments: 4 });
  const track = { id, name, type: 'scene_challenge', rank, ticks: 0, linkedClockId: clock.id };
  state.progressTracks.push(track);
  clock.linkedTrackId = id;
  return { track, clock };
}

// ---- Images (portraits, location images, story illustrations) ----

function setPortraitImage(state, imageId) {
  state.character.portraitImageId = imageId;
  return imageId;
}

let illustrationCounter = 0;
function addIllustration(state, { imageId, caption }) {
  const entry = { id: `i${Date.now().toString(36)}${(illustrationCounter++).toString(36)}`, imageId, caption: caption || '', createdAt: new Date().toISOString() };
  state.illustrations.push(entry);
  return entry;
}

function removeIllustration(state, id) {
  const before = state.illustrations.length;
  state.illustrations = state.illustrations.filter((i) => i.id !== id);
  if (state.illustrations.length === before) throw new Error(`No illustration with id "${id}".`);
}

module.exports = {
  newCampaignState,
  updateMeter,
  markProgress,
  progressBoxes,
  burnMomentum,
  RANK_TICKS,
  METER_BOUNDS,
  DEFAULT_IMPACTS,
  newImpacts,
  toggleImpact,
  addOtherImpact,
  removeOtherImpact,
  setAboardVehicle,
  setVehicleCondition,
  applyImpactEffects,
  setCombatPosition,
  setCombatRange,
  countMarkedImpacts,
  LEGACY_TRACKS,
  addAsset,
  setAssetBroken,
  adjustAssetResource,
  setAssetResource,
  removeAsset,
  companionTakesAHit,
  healCompanion,
  companionMaxHealth,
  unlockAssetAbility,
  availableExperience,
  earnExperience,
  spendExperience,
  ASSET_PURCHASE_COST,
  ASSET_UPGRADE_COST,
  SECTOR_COLS,
  SECTOR_ROWS,
  newSector,
  getSector,
  createSector,
  switchSector,
  validCellId,
  setSectorInfo,
  updateCell,
  addFeature,
  removeFeature,
  setCurrentCell,
  setCellImage,
  createPassage,
  removePassage,
  FEATURE_TYPES,
  setTruth,
  clearTruth,
  addConnection,
  updateConnection,
  setConnectionImage,
  setConnectionRank,
  setConnectionRole,
  bolsterConnectionRole,
  expandConnectionRole,
  suspendConnectionBenefits,
  restoreConnectionBenefits,
  raiseConnectionRank,
  raiseRank,
  RANK_ORDER,
  markConnectionProgress,
  applyLegacyReward,
  applyBondReward,
  applyStructuredAssetEffect,
  getStructuredAssetEffect,
  recommitProgressTrack,
  recommitAfterFailedBond,
  LEGACY_REWARD_TICKS,
  CONNECTION_RANKS,
  markProgressExact,
  removeProgressTrack,
  removeConnection,
  addLogEntry,
  hoursSinceLastPlayed,
  markPlayed,
  addFlag,
  removeFlag,
  addCampaignElement,
  removeCampaignElement,
  rollCampaignElement,
  createClock,
  advanceClock,
  stopClock,
  createSceneChallenge,
  updateCharacterFlavor,
  updateCharacterStats,
  correctCharacterStats,
  setCampaignName,
  setPortraitImage,
  addIllustration,
  removeIllustration,
};
