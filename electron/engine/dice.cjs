'use strict';
const crypto = require('crypto');

/** True uniform random integer in [min, max], inclusive. */
function randInt(min, max) {
  return min + crypto.randomInt(max - min + 1);
}

function rollActionDie() {
  return randInt(1, 6);
}

function rollChallengeDice() {
  return [randInt(1, 10), randInt(1, 10)];
}

/** A handful of assets modify how challenge dice get rolled, beyond the standard 2d10:
 *  Sleuth ("roll three challenge dice and choose two"), Loyalist ("roll one challenge die" to
 *  potentially replace an ally's). Both need a single extra d10, independent of the original
 *  pair -- this is that primitive. */
function rollExtraChallengeDie() {
  return randInt(1, 10);
}

/**
 * Consolidates the whole "roll bonus challenge dice, check for a forced match, work out every
 * pairing's real outcome" sequence into a single call -- built specifically because a real
 * playtest showed the alternative (the model orchestrating roll_extra_challenge_die, checking
 * for a match itself, then computing each pairing's outcome by hand before presenting a choice)
 * failing outright: not just an occasional wrong pairing, but a full turn where none of that
 * happened at all -- the model fabricated a die value, a fake choice UI, and a strong-hit outcome
 * for a pairing that was actually a weak hit, without calling a single real tool for any of it.
 * Existing, correct guidance already told it exactly what to do; it didn't do any of it. This
 * doesn't fix that on its own -- nothing can force a model to call a tool it skips entirely --
 * but it collapses several steps that each individually invite a mistake into one atomic call:
 * if it's engaged with at all, every pairing's outcome is already computed here, correctly,
 * before the model ever has to reason about which one is which.
 *
 * Sleuth is the fixed case (always exactly one extra die); Cohort's "one reroll per participating
 * specialist" is the variable one -- extraDieCount covers both from the same function.
 */
function rollBonusChallengeDice(actionScore, originalChallengeDice, extraDieCount = 1) {
  const extraDice = [];
  for (let i = 0; i < extraDieCount; i++) extraDice.push(rollExtraChallengeDie());
  const allDice = [...originalChallengeDice, ...extraDice];

  // A "match" here means ANY two dice in the full pool share a value -- not just the original
  // pair. Checked across every distinct pairing, first match found wins (the rule doesn't
  // distinguish between multiple matching pairs if that were ever possible).
  const pairIndices = [];
  for (let i = 0; i < allDice.length; i++) {
    for (let j = i + 1; j < allDice.length; j++) pairIndices.push([i, j]);
  }
  const matchedIndices = pairIndices.find(([i, j]) => allDice[i] === allDice[j]);

  if (matchedIndices) {
    const dice_used = [allDice[matchedIndices[0]], allDice[matchedIndices[1]]];
    const result = determineOutcome(actionScore, dice_used);
    return { extra_dice: extraDice, all_dice: allDice, forced_match: true, dice_used, ...result };
  }

  const possible_pairings = pairIndices.map(([i, j]) => {
    const dice = [allDice[i], allDice[j]];
    return { dice, ...determineOutcome(actionScore, dice) };
  });
  return { extra_dice: extraDice, all_dice: allDice, forced_match: false, possible_pairings };
}

/** Missile Array, Demolitionist, and Lore Hunter all grant "reroll any challenge dice" under
 *  specific conditions -- a fresh, independent pair, not a modification of the original one. */
function rerollChallengeDice() {
  return [randInt(1, 10), randInt(1, 10)];
}

/**
 * Starforged d100 oracle roll: two d10s, one tens/one units, decided before rolling.
 * A roll of 0/0 represents 100. Returns { roll, is_match } where is_match means the
 * tens and units digit matched (the game's "match" trigger for an extra twist).
 */
function rollD100() {
  const tens = randInt(0, 9);
  const units = randInt(0, 9);
  const roll = tens === 0 && units === 0 ? 100 : tens * 10 + units;
  const is_match = tens === units;
  return { roll, is_match };
}

/**
 * The fixed table Endure Harm's miss-at-0-health branch rolls on ("You suffer mortal harm.
 * Face Death." through "You are still standing.") and Endure Stress's parallel table
 * ("You are overwhelmed. Face Desolation." through "You persevere."). These are embedded in the
 * move text itself, not general-purpose reusable oracles, so they're not in the Dataforged
 * oracle catalog -- hardcoded here since they're fixed, short, and specific to these two moves.
 */
const SEVERE_HARM_TABLES = {
  health: [
    { max: 10, result: 'You suffer mortal harm. Face Death.' },
    { max: 20, result: 'You are dying. Within an hour or two, you must Heal and raise your health above 0, or Face Death.' },
    { max: 35, result: 'You are unconscious and out of action. If left alone, you come back to your senses in an hour or two. If you are vulnerable to ongoing harm, Face Death.' },
    { max: 50, result: 'You are reeling. If you engage in any vigorous activity before taking a breather, roll on this table again (before resolving the other move).' },
    { max: 100, result: 'You are still standing.' },
  ],
  spirit: [
    { max: 10, result: 'You are overwhelmed. Face Desolation.' },
    { max: 25, result: 'You give up. Forsake Your Vow.' },
    { max: 50, result: 'You give in to fear or compulsion, and act against your better instincts.' },
    { max: 100, result: 'You persevere.' },
  ],
};

/** Rolls on the Endure Harm ("health") or Endure Stress ("spirit") miss-at-zero table. */
function rollSevereHarmTable(kind) {
  const table = SEVERE_HARM_TABLES[kind];
  if (!table) throw new Error(`Unknown severe harm table "${kind}". Expected "health" or "spirit".`);
  const { roll, is_match } = rollD100();
  const entry = table.find((e) => roll <= e.max);
  return { roll, is_match, result: entry.result };
}

/**
 * Withstand Damage's miss-at-0-integrity table -- same idea as the severe harm tables above
 * (embedded in the move text, not a general oracle), but richer: 10 bands instead of 4-5,
 * covering everything from immediate catastrophic destruction down to "the vehicle holds
 * together." Applies the same regardless of vehicle type -- what differs by vehicle type is
 * which OTHER options are available instead of rolling this table at all (see the move text/
 * system prompt), not the table's own contents.
 */
const VEHICLE_DESTRUCTION_TABLE = [
  { max: 10, result: 'Immediate catastrophic destruction. All aboard must Endure Harm or Face Death, as appropriate.' },
  { max: 25, result: 'Destruction is imminent and unavoidable. If you do not have the means or intention to get clear, Endure Harm or Face Death, as appropriate.' },
  { max: 40, result: 'Destruction is imminent, but can be averted if you Repair your vehicle and raise its integrity above 0. If you fail, treat this as 11-25 instead.' },
  { max: 55, result: 'You cannot Repair this vehicle until you Resupply and obtain a crucial replacement part. If you roll this result again prior to that, treat this as 11-25 instead.' },
  { max: 70, result: 'The vehicle is crippled or out of your control. To get it back in action, you must Repair and raise its integrity above 0.' },
  { max: 85, result: "It's a rough ride. All aboard must make the Endure Harm, Endure Stress, or Companion Takes a Hit move, suffering a serious (-2) cost." },
  { max: 95, result: "You've lost fuel, energy, or cargo. Sacrifice Resources (-2)." },
  { max: 100, result: 'Against all odds, the vehicle holds together.' },
];

function rollVehicleDestructionTable() {
  const { roll, is_match } = rollD100();
  const entry = VEHICLE_DESTRUCTION_TABLE.find((e) => roll <= e.max);
  return { roll, is_match, result: entry.result };
}

/**
 * Action score = action die + stat/meter value + adds, capped at 10 (never negative
 * either, per the rulebook's examples, though the book doesn't explicitly floor it —
 * we floor at 0 to avoid nonsensical negative scores).
 */
function computeActionScore(actionDie, statValue, adds = 0) {
  const raw = actionDie + statValue + adds;
  return Math.max(0, Math.min(10, raw));
}

/** Compares an action/progress score against the two challenge dice. */
function determineOutcome(score, challengeDice) {
  const [c1, c2] = challengeDice;
  const beatsC1 = score > c1;
  const beatsC2 = score > c2;
  const is_match = c1 === c2;
  let outcome;
  if (beatsC1 && beatsC2) outcome = 'strong_hit';
  else if (beatsC1 || beatsC2) outcome = 'weak_hit';
  else outcome = 'miss';
  return { outcome, is_match, beatsC1, beatsC2 };
}

/**
 * Full action roll: d6 + stat/meter + adds vs 2d10.
 * statValue may be a stat (0-5) or a condition meter used in place of a stat.
 *
 * Implements the negative momentum rule: if momentum is negative and its
 * absolute value equals the action die's value, the action die counts as 0
 * (per the Starforged rulebook, "Momentum" section). We recompute the score
 * from scratch with die=0 rather than subtracting the die from the already-
 * capped score, since subtracting after the 10-cap can under-penalize.
 */
function rollActionMove({ statValue, adds = 0, momentum = 0 }) {
  const actionDie = rollActionDie();
  const challengeDice = rollChallengeDice();
  let actionScore = computeActionScore(actionDie, statValue, adds);
  let negativeMomentumApplied = false;
  if (momentum < 0 && Math.abs(momentum) === actionDie) {
    actionScore = computeActionScore(0, statValue, adds);
    negativeMomentumApplied = true;
  }
  const { outcome, is_match, beatsC1, beatsC2 } = determineOutcome(actionScore, challengeDice);
  return {
    actionDie,
    statValue,
    adds,
    momentum,
    negativeMomentumApplied,
    challengeDice,
    actionScore,
    outcome,
    is_match,
    beatsC1,
    beatsC2,
  };
}

/**
 * Progress roll: no action die. The progress score (0-10, i.e. filled boxes on the
 * track) is compared directly against 2d10.
 */
function rollProgressMove({ progressScore }) {
  const score = Math.max(0, Math.min(10, progressScore));
  const challengeDice = rollChallengeDice();
  const { outcome, is_match, beatsC1, beatsC2 } = determineOutcome(score, challengeDice);
  return { progressScore: score, challengeDice, outcome, is_match, beatsC1, beatsC2 };
}

/** Rolls against a Dataforged oracle table (array of {Floor, Ceiling, Result, ...}). */
function rollOracleTable(table) {
  const { roll, is_match } = rollD100();
  const row = table.find((r) => roll >= r.Floor && roll <= r.Ceiling);
  return { roll, is_match, row: row || null };
}

const ODDS_THRESHOLDS = {
  small_chance: 10,
  unlikely: 25,
  '50_50': 50,
  likely: 75,
  almost_certain: 90,
};

/** Ask the Oracle yes/no move. */
function rollOdds(oddsKey) {
  const threshold = ODDS_THRESHOLDS[oddsKey];
  if (threshold === undefined) {
    throw new Error(`Unknown odds "${oddsKey}". Expected one of: ${Object.keys(ODDS_THRESHOLDS).join(', ')}`);
  }
  const { roll, is_match } = rollD100();
  const answer = roll <= threshold ? 'yes' : 'no';
  return { odds: oddsKey, threshold, roll, is_match, answer };
}

module.exports = {
  randInt,
  rollActionDie,
  rollChallengeDice,
  rollExtraChallengeDie,
  rollBonusChallengeDice,
  rerollChallengeDice,
  rollD100,
  rollSevereHarmTable,
  rollVehicleDestructionTable,
  computeActionScore,
  determineOutcome,
  rollActionMove,
  rollProgressMove,
  rollOracleTable,
  rollOdds,
  ODDS_THRESHOLDS,
};
