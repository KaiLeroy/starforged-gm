'use strict';
const dice = require('./dice.cjs');
const data = require('./data.cjs');
const state = require('./state.cjs');
const comfyui = require('./comfyui.cjs');
const { runStateTransaction } = require('./transaction.cjs');

const OUTCOME_KEY = { strong_hit: 'Strong Hit', weak_hit: 'Weak Hit', miss: 'Miss' };

/** Pulls the move's outcome text for a given result, falling back to the raw move text. */
function outcomeTextFor(move, outcome) {
  const key = OUTCOME_KEY[outcome];
  if (move.Outcomes && move.Outcomes[key]) return move.Outcomes[key].Text;
  return null;
}

const CONNECTION_RANK_VALUE = { troublesome: 1, dangerous: 2, formidable: 3, extreme: 4, epic: 5 };
const CHARACTER_VALUES = new Set(['edge', 'heart', 'iron', 'shadow', 'wits', 'health', 'spirit', 'supply', 'integrity']);
const ALTERNATE_CHARACTER_VALUE_GRANTS = {
  Shields: { stats: ['integrity'], abilities: [1] },
  'Stealth Tech': { stats: ['shadow'], abilities: [3] },
  Skiff: { stats: ['integrity'], abilities: [1, 2] },
  Ace: { stats: ['integrity'], abilities: [3] },
  Devotant: { stats: ['edge', 'heart', 'iron', 'shadow', 'wits'], abilities: [1, 2, 3] },
  Seer: { stats: ['spirit'], abilities: [2] },
  Sniper: { stats: ['wits'], abilities: [2] },
  'Sensor Array': { stats: ['integrity'], abilities: [2, 3] },
  Overseer: { stats: ['integrity'], abilities: [1, 3] },
  'Service Pod': { stats: ['integrity'], abilities: [2] },
  'Snub Fighter': { stats: ['integrity'], abilities: [1] },
  Artist: { stats: ['edge', 'heart', 'iron', 'shadow', 'wits'], abilities: [3] },
  Trader: { stats: ['supply'], abilities: [1] },
  'Weapon Master': { stats: ['supply'], abilities: [3] },
  Revenant: { stats: ['heart'], abilities: [3] },
  Vanguard: { stats: ['wits'], abilities: [3] },
  Starship: { stats: ['heart'], abilities: [3] },
  Rover: { stats: ['integrity'], abilities: [3] },
  Scoundrel: { stats: ['shadow'], abilities: [2] },
};

function characterValue(campaignState, name) {
  if (!CHARACTER_VALUES.has(name)) throw new Error(`Unknown character stat or meter "${name}".`);
  if (name in campaignState.character.stats) return campaignState.character.stats[name];
  return campaignState.character.meters[name];
}

/** Resolves every roll value from owned campaign state or Dataforged; never from model arithmetic. */
function resolveRollValue(move, args, campaignState) {
  const source = args.value_source || 'character';
  const statOptions = data.getMoveStatOptions(move);
  if (source === 'character') {
    if (statOptions && statOptions.validStats.length > 0 && !statOptions.validStats.includes(args.stat)) {
      const listed = statOptions.options
        .filter((option) => option.method === 'Any' && option.stats.length === 1)
        .map((option) => `+${option.stats[0]}${option.text ? ` (${option.text.toLowerCase()})` : ''}`)
        .join(', ');
      throw new Error(`"${args.stat}" is not a valid stat for ${move.Name}. Its own actual options are: ${listed}.`);
    }
    return { statValue: characterValue(campaignState, args.stat), valueSource: source };
  }
  if (source === 'connection_rank') {
    if (move.Name !== 'Develop Your Relationship') throw new Error('connection_rank is only valid for Develop Your Relationship.');
    const connection = campaignState.connections.find((candidate) => candidate.id === args.source_id);
    if (!connection || !CONNECTION_RANK_VALUE[connection.rank]) throw new Error('source_id must identify a ranked connection in this campaign.');
    return { statValue: CONNECTION_RANK_VALUE[connection.rank], valueSource: source, sourceId: connection.id };
  }
  if (source === 'companion_health') {
    const asset = campaignState.character.assets.find((candidate) => candidate.id === args.source_id);
    if (!asset || typeof asset.health !== 'number') throw new Error('source_id must identify an owned companion-style asset with health.');
    return { statValue: asset.health, valueSource: source, sourceId: asset.id };
  }
  if (source === 'highest' || source === 'lowest') {
    const method = source === 'highest' ? 'Highest' : 'Lowest';
    const option = statOptions && statOptions.options.find((candidate) => candidate.method === method && candidate.stats.length > 0);
    if (!option) throw new Error(`${move.Name} has no Dataforged ${source}-value option.`);
    const values = option.stats.map((name) => characterValue(campaignState, name));
    return { statValue: source === 'highest' ? Math.max(...values) : Math.min(...values), valueSource: source, comparedStats: option.stats };
  }
  if (source === 'alternate_character_value') {
    const asset = campaignState.character.assets.find((candidate) => candidate.id === args.source_id);
    const grant = asset && ALTERNATE_CHARACTER_VALUE_GRANTS[asset.name];
    if (!asset || !grant || !grant.stats.includes(args.stat) || !grant.abilities.some((level) => asset.abilities_unlocked.includes(level))) {
      throw new Error('source_id must identify an owned, unlocked asset ability that authorizes this alternate character value.');
    }
    return { statValue: characterValue(campaignState, args.stat), valueSource: source, sourceId: asset.id };
  }
  if (source === 'asset_resource') {
    const asset = campaignState.character.assets.find((candidate) => candidate.id === args.source_id);
    if (!asset || !asset.resource) throw new Error('source_id must identify an owned asset with a tracked resource.');
    return { statValue: asset.resource.current, valueSource: source, sourceId: asset.id };
  }
  if (source === 'time_gap') {
    const looper = campaignState.character.assets.find((asset) => asset.id === args.source_id && asset.name === 'Looper' && asset.abilities_unlocked.includes(2));
    if (move.Name !== 'Loop Back' || !looper) throw new Error('time_gap is only valid for an owned Looper with ability 2 making Loop Back.');
    const values = { minutes: 4, hours: 3, days: 2 };
    if (!values[args.time_gap]) throw new Error('time_gap must be minutes, hours, or days.');
    return { statValue: values[args.time_gap], valueSource: source, timeGap: args.time_gap };
  }
  throw new Error(`Unknown value_source "${source}".`);
}

function validateActionDieMode(args, campaignState) {
  const mode = args.action_die_mode || 'normal';
  if (mode === 'normal') return { mode };
  const asset = campaignState.character.assets.find((candidate) => candidate.id === args.source_id);
  if (!asset) throw new Error('source_id must identify the owned asset authorizing this action-die mode.');
  if (mode === 'omit') {
    if (asset.name !== 'Sensor Array' || !asset.abilities_unlocked.includes(2)) throw new Error('Omitting the action die is only valid for Sensor Array ability 2.');
    return { mode, assetId: asset.id };
  }
  const permitted =
    (asset.name === 'Ace' && asset.abilities_unlocked.includes(2) && [4, 5, 6].includes(args.preset_action_die)) ||
    (asset.name === 'Archer' && asset.abilities_unlocked.includes(3) && args.preset_action_die === 5) ||
    (asset.name === 'Armored' && asset.abilities_unlocked.includes(1) && [4, 5].includes(args.preset_action_die) && (args.preset_action_die !== 5 || asset.abilities_unlocked.includes(2)));
  if (!permitted) throw new Error('That owned asset/ability does not authorize the requested preset action die.');
  return { mode, assetId: asset.id, preset: args.preset_action_die };
}

/**
 * OpenAI/OpenRouter-style tool definitions. Descriptions are written for the model,
 * not the developer -- keep them precise about what the app will do mechanically.
 */
const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'roll_action_move',
      description:
        "Resolve a Starforged action roll (d6 + stat/meter + adds vs 2d10) for a specific move. " +
        "Use this whenever the fiction calls for a move that triggers an action roll -- combat, " +
        "risky actions, social pressure, etc. The app performs the actual roll; you narrate the result. " +
        "For moves with more than one valid stat depending on approach (Compel, Resupply, Heal, Repair, " +
        "etc.), the app checks the stat you pick against that move's own real options -- an invalid " +
        "one is rejected with the actual valid stats listed, rather than silently rolled anyway. Pick " +
        "whichever stat genuinely fits how the player is approaching the moment; if it's rejected, the " +
        "error tells you the real options to choose from instead.",
      parameters: {
        type: 'object',
        properties: {
          move_name: { type: 'string', description: 'Exact or close name of the Starforged move being made, e.g. "Face Danger", "Strike", "Compel".' },
          stat: { type: 'string', enum: ['edge', 'heart', 'iron', 'shadow', 'wits', 'health', 'spirit', 'supply', 'integrity'], description: 'The stat, or condition meter used in place of a stat, that this move adds.' },
          adds: { type: 'integer', description: 'Any bonus adds from assets, momentum, or the fiction. Defaults to 0.' },
          value_source: {
            type: 'string',
            enum: ['character', 'connection_rank', 'companion_health', 'highest', 'lowest', 'alternate_character_value', 'asset_resource', 'time_gap'],
            description:
              'Where the engine must obtain the roll value. Omit/character for an ordinary character stat or meter. ' +
              'Use connection_rank or companion_health with source_id; highest/lowest makes the engine use the move\'s own ' +
              'Dataforged comparison; alternate_character_value uses the named real character stat/meter for an asset-granted ' +
              'substitution; asset_resource reads the owned asset\'s tracked resource; time_gap uses time_gap below. No source ' +
              'accepts a model-supplied numeric value.',
          },
          source_id: { type: 'string', description: 'Exact connection or owned asset id required by every non-character value source and non-normal action-die mode.' },
          time_gap: { type: 'string', enum: ['minutes', 'hours', 'days'], description: 'Only for Looper\'s Loop Back: minutes=4, hours=3, days=2.' },
          action_die_mode: { type: 'string', enum: ['normal', 'preset', 'omit'], description: 'Omit/normal for a standard d6. preset is only for a qualifying owned Ace/Archer/Armored ability and requires preset_action_die plus source_id. omit is only Sensor Array\'s automated scan.' },
          preset_action_die: { type: 'integer', minimum: 4, maximum: 6, description: 'The established preset die for a qualifying owned asset; validated against that asset.' },
        },
        required: ['move_name', 'stat'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_asset_bonuses',
      description:
        'Call this BEFORE roll_action_move whenever the character owns any assets, to see which of their own ' +
        'unlocked ability effects actually apply to the move about to be made -- computed from structured data, ' +
        'not left to your own memory of a long prompt. Returns two lists: "explicit" entries genuinely alter ' +
        'this exact move (confirmed against the asset\'s own real data, not a guess) -- if one applies here, fold ' +
        'its bonus into the adds you pass to roll_action_move next. "implicit" entries have no single named move ' +
        '-- they key off a broader fictional category ("a forceful move", "a move to craft or repair") that only ' +
        'you can judge fits the moment or not; the app surfaces them because it can\'t classify that on its own, ' +
        'not because they\'re guaranteed to apply. Every entry includes the asset\'s own real asset_id -- if you go on to ' +
        'call anything that needs it (set_asset_broken, adjust_asset_resource, discard_asset, and similar), use this ' +
        'exact value, never a constructed one built from the asset\'s name (e.g. never invent "utility-bot" for an ' +
        'asset actually named Utility Bot) -- a made-up id is rejected outright, and this is the reliable place to ' +
        'get the real one rather than trying to recall it from whenever the asset was first acquired. An empty ' +
        'result for both means nothing from this character\'s ' +
        'owned assets is relevant here -- that\'s a real answer, not a failure. Call it AGAIN after the roll, ' +
        'this time passing roll_id (from the roll result), outcome and is_match -- for a hand-verified subset of abilities whose post-roll effect ' +
        'is genuinely unconditional (a fixed momentum grant, a legacy-track tick, an outcome-tier shift), the app ' +
        'computes AND ACTUALLY APPLIES the real result itself (see "applied" in the response) rather than leaving ' +
        'it to you -- narrate what it returns, don\'t recompute or reapply it yourself. Anything not in that ' +
        'verified subset still comes back as plain effect text for you to read and apply by hand, exactly as ' +
        'before -- most abilities work this way, since only mechanics simple and unconditional enough to be ' +
        'fully, safely captured are ever auto-applied.',
      parameters: {
        type: 'object',
        properties: {
          move_name: { type: 'string', description: 'The exact move about to be rolled, e.g. "Strike", "Compel", "Gain Ground".' },
          roll_id: { type: 'string', description: 'Required on the post-roll call: the exact roll_id returned by roll_action_move.' },
          outcome: {
            type: 'string',
            enum: ['strong_hit', 'weak_hit', 'miss'],
            description: 'Only pass this on the SECOND call, after the roll -- the move\'s actual outcome.',
          },
          is_match: { type: 'boolean', description: 'Only pass this on the SECOND call, after the roll -- whether the challenge dice matched.' },
        },
        required: ['move_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_progress_move',
      description:
        'Resolve a Starforged progress roll (progress score vs 2d10, no action die) for a vow, combat, ' +
        'or expedition progress track. Use this when a track is being resolved (e.g. Fulfill Your Vow, ' +
        'Take Decisive Action). Pass move_name whenever this is a named core move so the roll ledger can ' +
        'verify move-specific post-roll abilities.',
      parameters: {
        type: 'object',
        properties: {
          track_id: { type: 'string', description: 'The id of the progress track being resolved (from campaign state).' },
          move_name: { type: 'string', description: 'The named core progress move being made, e.g. "Take Decisive Action". Omit only for an asset-specific progress roll with no core move.' },
          apply_bad_spot_downgrade: {
            type: 'boolean',
            description:
              'Only for Take Decisive Action: set true if the character is in a bad spot (combat_position). Downgrades ' +
              'a strong hit without a match to a weak hit, and a weak hit to a miss -- a strong hit WITH a match is ' +
              'unaffected. Leave false/omitted for every other progress move (vows, expeditions, connections, etc.).',
          },
        },
        required: ['track_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_progress_track',
      description:
        "Mark progress on a track after a fictional success, per the track's challenge rank. If a move's outcome " +
        'says to mark progress more than once (e.g. "Mark progress twice"), call this tool that many times -- ' +
        'each call adds one rank\'s worth of ticks, so calling it twice for a weak hit that says "mark progress ' +
        'twice" is correct, not a double-count.',
      parameters: {
        type: 'object',
        properties: {
          track_id: { type: 'string', description: "The same id chosen when this track was created via create_progress_track -- not a separately-generated value; create_progress_track's own id is model-chosen, so this must exactly match whatever slug was used there." },
          rank: { type: 'string', enum: ['troublesome', 'dangerous', 'formidable', 'extreme', 'epic'] },
        },
        required: ['track_id', 'rank'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_progress_track',
      description: 'Create a new progress track (a vow, a fight, an expedition, a connection) in campaign state.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A short unique slug, e.g. "vow-find-the-relay".' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['vow', 'combat', 'expedition', 'connection'] },
          rank: { type: 'string', enum: ['troublesome', 'dangerous', 'formidable', 'extreme', 'epic'] },
        },
        required: ['id', 'name', 'type', 'rank'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_progress_track',
      description:
        'Removes a progress track entirely -- "clear the vow" (Forsake Your Vow), "clear the objective" (Face ' +
        'Defeat), or similar. Never use this on a legacy track (legacy-quests/bonds/discoveries) -- those clear ' +
        'themselves automatically at their 10th box and should never be deleted.',
      parameters: {
        type: 'object',
        properties: { track_id: { type: 'string', description: "The same id chosen when this track was created via create_progress_track -- not a separately-generated value; create_progress_track's own id is model-chosen, so this must exactly match whatever slug was used there." } },
        required: ['track_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_oracle',
      description:
        'Roll on a named Starforged oracle table (locations, NPCs, complications, planet features, etc.) ' +
        'and get back the generated result text. Use this to generate unknowns instead of inventing them yourself.',
      parameters: {
        type: 'object',
        properties: {
          oracle_name: { type: 'string', description: 'Name or path of the oracle table, e.g. "Action", "Planet Class", "Derelicts / Community / Feature".' },
        },
        required: ['oracle_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_severe_harm_table',
      description:
        "Endure Harm's miss-at-0-health table (kind: \"health\") or Endure Stress's parallel miss-at-0-spirit table " +
        '(kind: "spirit") -- only roll this when the character is already at 0 and misses the Endure Harm/Endure ' +
        "Stress follow-up roll. Results range from a real chance of Face Death/Face Desolation up to \"still " +
        'standing"/"you persevere" -- resolve whatever it returns, don\'t soften it.',
      parameters: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['health', 'spirit'] } },
        required: ['kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_vehicle_destruction_table',
      description:
        "Withstand Damage's miss-at-0-integrity table. Only one of several options on that miss (the others are " +
        'narrative: mark battered/cursed via toggle_impact, discard a broken module via discard_asset) -- roll this ' +
        'one specifically when the fiction calls for genuine uncertainty about what happens to the vehicle. Results ' +
        'range from immediate destruction (Endure Harm or Face Death for everyone aboard) down to "holds together" ' +
        '-- resolve whatever it returns, and remember a destroyed command vehicle triggers Overcome Destruction.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_the_oracle',
      description: 'Resolve a yes/no question via the Ask the Oracle move using an odds band.',
      parameters: {
        type: 'object',
        properties: {
          odds: { type: 'string', enum: ['small_chance', 'unlikely', '50_50', 'likely', 'almost_certain'] },
          question: { type: 'string', description: 'The yes/no question being asked, for logging/narration context.' },
        },
        required: ['odds', 'question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_meter',
      description: "Adjust the character's health, spirit, supply, integrity (command vehicle condition), or momentum by a delta (positive or negative). Values are clamped to their legal range automatically.",
      parameters: {
        type: 'object',
        properties: {
          meter: { type: 'string', enum: ['health', 'spirit', 'supply', 'integrity', 'momentum'] },
          delta: { type: 'integer' },
        },
        required: ['meter', 'delta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'burn_momentum',
      description:
        "Burn momentum for an engine-recorded roll_id. The engine retrieves that roll's real score and dice, " +
        'refuses a burn that cannot improve it, prevents a second burn of the same roll, recomputes the outcome, ' +
        'and resets momentum. Only call this right after a weak ' +
        'hit or miss, and only if the player chose to burn momentum.',
      parameters: {
        type: 'object',
        properties: {
          roll_id: { type: 'string', description: 'Exact roll_id returned by roll_action_move or roll_progress_move.' },
        },
        required: ['roll_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reroll_action_die',
      description:
        "Rolls a fresh, independent action die (1-6) -- ONLY the action die, not challenge dice, and not the whole " +
        'move. For assets that grant a conditional action-die reroll (Medbay, Workshop, Fleet Commander all grant ' +
        '"reroll your action die if its value is less than [some value]"): after the normal roll, check that ' +
        "condition yourself first (this tool doesn't check it), then if it's met and the player wants to, call " +
        'this with that roll_id; the engine recomputes and records the outcome against the unchanged challenge dice. ' +
        'Omit roll_id only when an asset explicitly calls for a standalone d6 check rather than modifying a move.',
      parameters: { type: 'object', properties: { roll_id: { type: 'string', description: 'Exact roll_id whose action die is being rerolled. Omit only for a genuine standalone d6 check.' }, extra_add: { type: 'integer', enum: [0, 1], description: 'Optional verified ability add applied to the rerolled action die; only 0 or 1.' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_extra_challenge_die',
      description:
        "Rolls one additional, independent challenge die (1-10). For the small number of assets that need a third " +
        'challenge die on top of the normal two -- Sleuth ("roll three challenge dice and choose two"), Loyalist ' +
        '("roll one challenge die" to potentially replace an ally\'s -- co-op only, not applicable solo). After ' +
        'rolling, use resolve_action_with_dice to recompute the outcome with whichever two dice actually apply. ' +
        'roll_bonus_challenge_dice below does this whole sequence -- including every pairing\'s real outcome -- ' +
        'in one call; prefer that one for Sleuth/Cohort specifically rather than orchestrating this by hand.',
      parameters: { type: 'object', properties: { roll_id: { type: 'string', description: 'Exact roll_id whose challenge pool receives this die.' } }, required: ['roll_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_bonus_challenge_dice',
      description:
        'Rolls the bonus challenge dice for Sleuth (always 1 extra) or Cohort\'s strategize-together (1 per ' +
        'participating specialist), checks the full pool for a forced match, and returns the REAL, already-' +
        'computed outcome for every case -- never compute any of this by hand. If any two dice in the full pool ' +
        '(original two plus the extra ones) share a value, that pair is mandatory per the rulebook -- the result\'s ' +
        '"forced_match" is true, "dice_used" is that pair, and the outcome fields are already final; there is no ' +
        'choice to offer. If nothing matches, "forced_match" is false and "possible_pairings" lists every distinct ' +
        'pair from the pool with its own real, pre-computed outcome (strong_hit/weak_hit/miss) -- read the pairing ' +
        'that\'s actually being offered directly from this list when building present_choice, rather than working ' +
        'out whether a given action score beats a given die value in your own head.',
      parameters: {
        type: 'object',
        properties: {
          roll_id: { type: 'string', description: 'Exact roll_id returned by the original action/progress roll; score and original dice are read from the ledger.' },
          extra_die_count: { type: 'integer', description: 'How many bonus dice to roll -- 1 for Sleuth, or the number of participating specialists for Cohort. Defaults to 1 if omitted.' },
        },
        required: ['roll_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reroll_challenge_dice',
      description:
        'Rolls a fresh, independent pair of challenge dice, replacing the original two entirely. For assets that ' +
        'grant "reroll any challenge dice" under specific conditions -- Missile Array, Demolitionist, Lore Hunter. ' +
        'After rerolling, use resolve_action_with_dice with the same action score and these new dice to get the ' +
        "real outcome -- don't work it out yourself.",
      parameters: { type: 'object', properties: { roll_id: { type: 'string', description: 'Exact roll_id whose challenge dice are being rerolled.' } }, required: ['roll_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolve_action_with_dice',
      description:
        'Recomputes the outcome of an already-rolled action or progress move against a specific, explicit pair of ' +
        'challenge dice -- for any asset ability that changes which dice apply after the fact: Sleuth\'s "choose two ' +
        'of three" (forced to use a matching pair if any two of the three match), a reroll from Missile Array/' +
        'Demolitionist/Lore Hunter, Revenant\'s "zero out one die" (pass 0 for that die, the original value for the ' +
        "other), or Loyalist's die-replacement. Always use this instead of computing the new outcome yourself.",
      parameters: {
        type: 'object',
        properties: {
          roll_id: { type: 'string', description: 'Exact roll_id returned by the original action/progress roll.' },
          action_score: { type: 'integer', description: 'Optional score returned by an engine action-die reroll. It must be authorized on this roll; omit to use the original score.' },
          score_mode: { type: 'string', enum: ['current', 'kinetic_plus_2', 'exosuit_integrity_die'], description: 'Optional engine-verified post-roll score transformation for the named owned asset ability.' },
          dice_mode: { type: 'string', enum: ['current', 'revenant_zero'], description: 'Optional engine-verified challenge-die transformation. revenant_zero requires the owned unlocked Revenant and its exact source_id.' },
          source_id: { type: 'string', description: 'Exact owned asset id required by a non-current score_mode or dice_mode.' },
          challenge_dice: {
            type: 'array',
            items: { type: 'integer' },
            minItems: 2,
            maxItems: 2,
            description: 'The [die1, die2] pair to check the score against -- the two dice actually being used after choosing/rerolling/replacing.',
          },
        },
        required: ['roll_id', 'challenge_dice'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adjust_asset_resource',
      description:
        "Adjusts an owned asset's own tracked resource pool (ammo, cargo, shields, fleet power, etc. -- distinct " +
        'from the character\'s own meters) by a relative amount, clamped to [0, max]. Only for assets that actually ' +
        'have one (Missile Array, Archer, Expanded Hold, Shields, Fleet Commander) -- this errors cleanly on any ' +
        "other asset rather than silently doing nothing, since that's more likely a sign of the wrong tool or the " +
        "wrong asset than something to paper over.",
      parameters: {
        type: 'object',
        properties: {
          asset_id: { type: 'string', description: "The exact \"id\" field returned by buy_asset's or grant_asset's own result for this asset, or (more reliably, since that original call could be many turns in the past) the asset_id check_asset_bonuses returns for it right now -- never construct or guess one, always use a real, literal value one of those actually returned." },
          delta: { type: 'integer', description: 'Positive to gain, negative to spend/lose.' },
        },
        required: ['asset_id', 'delta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_asset_resource',
      description:
        "Sets an owned asset's resource pool to an absolute value, or raises its max, rather than adjusting by a " +
        'relative delta -- for Shields being set to 2/3/4 by a raise-shields roll, or Fleet Commander\'s "set your ' +
        'max power to 5" ability unlock. Pass only what actually changed.',
      parameters: {
        type: 'object',
        properties: {
          asset_id: { type: 'string', description: "The exact \"id\" field returned by buy_asset's or grant_asset's own result for this asset, or (more reliably, since that original call could be many turns in the past) the asset_id check_asset_bonuses returns for it right now -- never construct or guess one, always use a real, literal value one of those actually returned." },
          current: { type: 'integer', description: 'New current value, if it changed.' },
          max: { type: 'integer', description: 'New max value, if it changed (e.g. an ability unlock that raises capacity).' },
        },
        required: ['asset_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'toggle_impact',
      description:
        "Mark or clear one of the character's fixed Impacts (debuffs like Wounded, Shaken, Doomed, etc.) -- " +
        'toggles it. Marking an impact reduces max momentum and lowers the momentum reset value, per the rules. ' +
        'Call this when the fiction or a move outcome establishes a lasting condition, not for temporary harm ' +
        'already covered by the health/spirit/supply meters. Permanently Harmed and Traumatized are ' +
        'permanent -- this tool will refuse to clear them once marked. Battered/Cursed are NOT here -- those live ' +
        'directly on the specific vehicle asset, use set_vehicle_condition instead. For asset-granted impacts with ' +
        'custom names (e.g. Oathbreaker), use add_other_impact / remove_other_impact instead.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['Misfortunes', 'Lasting Effects', 'Burdens'] },
          name: { type: 'string', description: 'Exact impact name, e.g. "Wounded", "Doomed".' },
        },
        required: ['category', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_other_impact',
      description:
        'Adds a freeform, asset-granted impact (e.g. the OATHBREAKER asset "counts as an impact until you fulfill ' +
        'that vow"). Counts toward the momentum penalty like any other impact for as long as it exists. Remove it ' +
        'with remove_other_impact once its condition resolves (e.g. the vow is fulfilled).',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Descriptive name, e.g. "Oathbreaker (quest of redemption)".' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_other_impact',
      description: 'Removes a previously-added Other Impact once its source condition resolves.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_flag',
      description:
        'Records content the player wants approached mindfully, checked in about, or avoided entirely (the Set a ' +
        'Flag move) -- persisted for the whole campaign, not just this conversation. Call this whenever the player ' +
        'states a boundary, not just during character creation.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The flagged subject, in the player\'s own terms, e.g. "harm against children" or "body horror".' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_flag',
      description: 'Removes a previously-set content flag, if the player asks to lift it.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_campaign_element',
      description:
        'Adds an entry to the campaign elements table -- a categorized, player-curated codex of story ' +
        'ingredients specific to this campaign, used to answer "what does this connect to?" with something ' +
        'already established, rather than generating something wholly new. Call this when the player wants to ' +
        'record a new recurring element, or when building a starting table together.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: state.CAMPAIGN_ELEMENT_CATEGORIES, description: 'What kind of thing this is -- pick the closest fit; "Other" is a real, legitimate choice when nothing else fits well, not a fallback to avoid.' },
          name: { type: 'string', description: 'A short name or label, e.g. "Silver Dominion" or "Kess Rendahl" -- not a full sentence.' },
          description: { type: 'string', description: 'Optional: a bit more detail on what this is or why it matters, e.g. "ruthless mercenary captain, owes the player a debt".' },
        },
        required: ['category', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_campaign_element',
      description:
        'Removes a campaign element that is no longer a factor or no longer interesting -- the book\'s own guidance ' +
        'is to periodically prune this table, e.g. when the player ends a session.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_campaign_element',
      description:
        'Picks a random entry from the campaign elements table -- use when a genuinely open-ended situation calls ' +
        'for connecting to something already established in the story, rather than generating something new via ' +
        'roll_oracle. Errors if the table is empty.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'present_choice',
      description:
        "Pauses the turn right here and hands a genuine decision to the PLAYER, instead of picking on their " +
        'behalf and narrating it as already settled. Two real use cases: (1) a move\'s own outcome text presents a ' +
        'choice for the player to make -- not narrative color, but a real "choose one of" the rules hand to them: ' +
        "Secure an Advantage's momentum-or-bonus choice, Sojourn's pick-two-recover-moves, Advance's which-asset-" +
        "to-upgrade, Fulfill Your Vow's miss recommit-or-forsake, and others documented throughout this system " +
        "prompt. (2) the player's own free-text message would otherwise lead you to assume which MOVE applies on " +
        "their behalf -- judge how plausible it is that the action is trivial enough to need no move at all " +
        '(Ask the Oracle\'s own five-tier odds vocabulary, compared against the player\'s own configured ' +
        'threshold -- see this system prompt for the exact rule and current setting); above that threshold, just ' +
        "narrate it, nothing to assume since no move applies. At or below it, ALWAYS call this tool with the real " +
        "candidates instead -- not conditionally, and not skipped just because one option seems like the obvious " +
        'best fit once you\'re already at or below the threshold. Call this ALONE -- not bundled with other tool ' +
        'calls in the same turn -- as the last thing you do before stopping; everything you\'ve already resolved ' +
        "this turn (rolls made, meters changed) stays in effect, only the choice itself is deferred. You will be " +
        'called again automatically once the player has actually answered, with their answer included -- ' +
        'continue the turn naturally from there, applying whatever they chose. NEVER use this for narrative or ' +
        'roleplay content -- how to respond to an NPC in conversation, which of several story directions to ' +
        'pursue, what to do next in general. That is what the player\'s own free-text message in the ordinary ' +
        'chat is for; they will simply say what their character does or says, in their own words, the same way ' +
        'they always do. Only call this tool for the two mechanical cases above -- a real choice the RULES hand ' +
        'to the player, or move-selection ambiguity from their own free text -- never to offer a menu of ways to ' +
        'react to a scene, answer a question, or decide what happens next. If a scene calls for a decision and ' +
        'neither of the two cases above applies, just end your narration on an open question or a clear decision ' +
        'point in prose (e.g. "What do you do?") and let the player answer however they want, exactly as you ' +
        'would with no tools available at all.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'A short question framing the decision, e.g. "How do you want to use your success?"' },
          options: {
            type: 'array',
            description: 'At least two real options for the player to pick from.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short button text, e.g. "+2 momentum"' },
                description: { type: 'string', description: 'Optional one-line elaboration of what this option means.' },
              },
              required: ['label'],
            },
            minItems: 2,
          },
          allow_custom: {
            type: 'boolean',
            description: 'Whether the player may also type a free-text alternative instead of picking a listed option. Defaults to true -- set false only when the listed options are truly exhaustive and a custom answer would be meaningless (rare).',
          },
        },
        required: ['prompt', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'earn_experience',
      description:
        'Grant experience per the rules -- typically "earn experience equal to your progress score" on a hit ' +
        'when resolving Fulfill Your Vow, Forge a Bond, or a similar legacy-track-concluding move. Call this ' +
        'right after such a roll if its outcome text grants experience.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'integer', description: 'How much experience to grant.' },
          reason: { type: 'string', description: 'Why -- for logging, e.g. "Fulfilled vow: Reclaim the derelict".' },
        },
        required: ['amount', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buy_asset',
      description:
        'Spend 3 experience to purchase a new asset for the character (its first ability unlocks immediately), ' +
        'via the Advance move. Only call this when the player has chosen an asset and can afford it.',
      parameters: {
        type: 'object',
        properties: {
          asset_name: { type: 'string', description: 'Exact or close asset name, e.g. "Ace", "Bounty Hunter", "Starship".' },
        },
        required: ['asset_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grant_asset',
      description:
        'Add a new asset to the character at NO experience cost -- for a Deed-category asset self-granted by its ' +
        'own narrative trigger (Bonded, Homesteader, Marked, Oathbreaker, Revenant, Survivor, Vanguard, Cohort, ' +
        'Fleet Commander), or any other case where the fiction itself hands the character an asset for free ' +
        '(a gift, a reward, a story event), rather than the player spending experience to acquire it via Advance. ' +
        'Never call this for an ordinary purchase -- that\'s buy_asset, which correctly costs experience.',
      parameters: {
        type: 'object',
        properties: {
          asset_name: { type: 'string', description: 'Exact or close asset name, e.g. "Oathbreaker", "Bonded".' },
        },
        required: ['asset_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upgrade_asset',
      description: "Spend 2 experience to unlock an already-owned asset's second or third ability, via the Advance move.",
      parameters: {
        type: 'object',
        properties: {
          asset_name: { type: 'string', description: 'Name of an asset the character already owns.' },
          ability_number: { type: 'integer', enum: [2, 3] },
        },
        required: ['asset_name', 'ability_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_sector_info',
      description: "Set or update a sector's name, region, faction/power in control, and/or an overarching sector-level note (e.g. the rolled Sector Trouble, a campaign-wide hook). Call this early in the campaign, or whenever this changes. Operates on the current sector unless sector_id is given.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          region: { type: 'string', enum: ['Terminus', 'Outlands', 'Expanse', 'Void'] },
          factionControl: { type: 'string' },
          notes: { type: 'string', description: 'Overarching context for the whole sector -- not tied to any one hex.' },
          sector_id: { type: 'string', description: 'Optional -- defaults to the current sector.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_sector',
      description:
        'Creates a new, empty sector -- "as you head out into the unknown, you can discover, explore, and name new ' +
        'sectors." Does not switch to it automatically; call switch_sector once the party actually arrives there. ' +
        'If this new sector exists specifically because the party traveled through a charted, map-edge passage ' +
        '(the common case), pass via_passage_id (and from_sector_id if it was charted somewhere other than the ' +
        "current sector) to link that passage to this new sector automatically, rather than a separate " +
        'link_passage_to_sector call for what is really one event.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          region: { type: 'string', enum: ['Terminus', 'Outlands', 'Expanse', 'Void'] },
          factionControl: { type: 'string' },
          via_passage_id: { type: 'string', description: 'Optional -- the exact "id" of the map-edge passage (no toCell) the party traveled through to reach this new sector, if any. Links that passage to this new sector.' },
          from_sector_id: { type: 'string', description: 'Optional -- which sector via_passage_id belongs to, if not the current sector.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_sector',
      description: "Switches which sector is current -- the one the map displays and location tools operate on by default. Call this when the party travels to a different sector (not just a different hex within the same one).",
      parameters: {
        type: 'object',
        properties: { sector_id: { type: 'string', description: "The exact \"id\" field returned by create_sector's own result -- never construct or guess one, always use the literal value that call returned. The default starting sector is always exactly \"sector-1\", not something to look up." } },
        required: ['sector_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reveal_location',
      description:
        'Reveal or update a hex on the sector map (grid coordinates are "col,row", col 0-11, row 0-7). ' +
        'Call this when the party arrives somewhere new or learns about a location worth remembering -- ' +
        'a system, planet, station, derelict, etc. Creates the cell if it doesn\'t exist yet. Operates on ' +
        'the current sector unless sector_id is given.',
      parameters: {
        type: 'object',
        properties: {
          cell: { type: 'string', description: 'Grid coordinate as "col,row", e.g. "3,4".' },
          name: { type: 'string', description: 'Short label for the hex, e.g. a system or region name.' },
          notes: { type: 'string', description: 'A sentence or two of context about this hex.' },
          sector_id: { type: 'string', description: 'Optional -- defaults to the current sector.' },
        },
        required: ['cell'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_location_feature',
      description:
        'Add a specific feature to a sector hex -- a star, planet, settlement, derelict, vault, starship, ' +
        'NPC, creature, faction presence, or a sighting. A single hex (a star system) can hold several of ' +
        'these. Use roll_oracle first to generate its details rather than inventing them. Operates on the ' +
        'current sector unless sector_id is given.',
      parameters: {
        type: 'object',
        properties: {
          cell: { type: 'string', description: 'Grid coordinate as "col,row".' },
          type: { type: 'string', enum: ['star', 'planet', 'settlement', 'derelict', 'vault', 'starship', 'npc', 'creature', 'faction', 'sighting', 'other'] },
          name: { type: 'string' },
          description: { type: 'string' },
          sector_id: { type: 'string', description: 'Optional -- defaults to the current sector.' },
        },
        required: ['cell', 'type', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_current_location',
      description: "Mark the party's current hex on the sector map -- call this whenever they travel somewhere new within a sector. Operates on the current sector unless sector_id is given.",
      parameters: {
        type: 'object',
        properties: {
          cell: { type: 'string', description: 'Grid coordinate as "col,row".' },
          sector_id: { type: 'string', description: 'Optional -- defaults to the current sector.' },
        },
        required: ['cell'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_passage',
      description:
        'Charts a passage -- "Build a Starting Sector," Step 7: a known, plotted route along the drifts connecting ' +
        'two settlements, or connecting one settlement to the edge of the sector map (implying travel onward to ' +
        'another sector, omit to_cell entirely for this case). Both real endpoints must already be discovered ' +
        "locations, not empty hexes. Passages are what Set a Course actually resolves in a single roll -- following " +
        'unplotted space instead calls for Undertake an Expedition, and successfully finishing one is exactly when ' +
        'a new passage should be charted (see the sector-map guidance for the full distinction). Creating a passage ' +
        'that already exists (even reversed) just returns the existing one rather than duplicating it. Operates on ' +
        'the current sector unless sector_id is given.',
      parameters: {
        type: 'object',
        properties: {
          from_cell: { type: 'string', description: 'Grid coordinate as "col,row" -- must already be a discovered location.' },
          to_cell: { type: 'string', description: 'Grid coordinate as "col,row". Omit entirely if this passage leads off the edge of the map to another sector.' },
          notes: { type: 'string', description: 'Optional flavor -- what this route is like, who uses it, etc.' },
          sector_id: { type: 'string', description: 'Optional -- defaults to the current sector.' },
          to_sector_id: { type: 'string', description: 'Optional, only valid when to_cell is omitted -- which specific, already-existing sector this passage leads to, if that happens to already be known. Usually it is not known yet at creation time (the destination sector typically does not exist until the party actually travels there) -- link_passage_to_sector or create_sector\'s own via_passage_id are the normal way this gets set, not this parameter.' },
        },
        required: ['from_cell'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'link_passage_to_sector',
      description:
        'Sets, changes, or clears which specific sector a map-edge passage (one with no to_cell) actually leads ' +
        'to -- the Expanse-level connection between sectors. Usually unnecessary at the moment a new sector is ' +
        "created (create_sector's own via_passage_id already does this automatically for the common case of " +
        'arriving somewhere new via a specific route); use this directly for linking a passage that was left ' +
        'unlinked, correcting one that points at the wrong sector, or clearing one (pass null) that turns out to ' +
        'be wrong.',
      parameters: {
        type: 'object',
        properties: {
          passage_id: { type: 'string', description: 'The exact "id" of the map-edge passage to link -- from create_passage\'s own result, never constructed or guessed.' },
          to_sector_id: { type: 'string', description: 'The exact "id" of the destination sector, from create_sector\'s own result. Pass the literal string "none" to clear an existing link.' },
          sector_id: { type: 'string', description: 'Optional -- which sector the passage itself belongs to, if not the current sector.' },
        },
        required: ['passage_id', 'to_sector_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_passage',
      description: 'Removes a charted passage -- for correcting a mistake, or narratively when a route becomes lost, blockaded, or destroyed. Operates on the current sector unless sector_id is given.',
      parameters: {
        type: 'object',
        properties: {
          passage_id: { type: 'string', description: "The exact \"id\" field returned by create_passage's own result -- never construct or guess one, always use the literal value that call returned." },
          sector_id: { type: 'string', description: 'Optional -- defaults to the current sector.' },
        },
        required: ['passage_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_setting_truth',
      description:
        'Roll on one of the 14 Setting Truth categories (Cataclysm, Exodus, Communities, Iron, Laws, Religion, ' +
        'Magic, Communication and Data, Medicine, Artificial Intelligence, War, Lifeforms, Precursors, Horrors) to ' +
        'establish a foundational fact about the setting, complete with a Quest Starter you can offer the player ' +
        "as vow inspiration. Typically done once per category at the start of a campaign, but it's fine to roll " +
        "more later if a category hasn't been established yet and becomes relevant.",
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['Cataclysm', 'Exodus', 'Communities', 'Iron', 'Laws', 'Religion', 'Magic', 'Communication and Data', 'Medicine', 'Artificial Intelligence', 'War', 'Lifeforms', 'Precursors', 'Horrors'],
          },
        },
        required: ['category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_setting_truth',
      description:
        'Set a custom Setting Truth for a category -- use this instead of roll_setting_truth when the player wants ' +
        "to define this part of the setting themselves rather than rolling one of the book's three options. Freeform " +
        'text, not tied to the official table.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['Cataclysm', 'Exodus', 'Communities', 'Iron', 'Laws', 'Religion', 'Magic', 'Communication and Data', 'Medicine', 'Artificial Intelligence', 'War', 'Lifeforms', 'Precursors', 'Horrors'],
          },
          result: { type: 'string', description: 'The custom truth statement.' },
          description: { type: 'string', description: 'Optional flavor/context.' },
          questStarter: { type: 'string', description: 'Optional vow/quest hook tied to this truth.' },
        },
        required: ['category', 'result'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_connection',
      description: "Record a new connection (an NPC, ally, contact, or rival the character knows) in the campaign's connection list. Per the book's own instruction on a successful Make a Connection, \"make note of their name, location, and any other characteristics worth recording\" -- location is a distinct field on the official Connections Worksheet (name/location/role/role), not just another detail folded into notes.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          notes: { type: 'string', description: 'Who they are, how the character knows them, disposition, anything worth remembering.' },
          location: { type: 'string', description: 'Where they can typically be found -- a settlement, sector, ship, or similar. Optional, but the book asks for it explicitly whenever a connection is genuinely established.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_connection',
      description:
        'Permanently removes a connection -- the relationship is broken or lost. Use for Test Your Relationship\'s ' +
        '"Lose the connection" outcome, or when a suspended connection\'s affirming quest is refused or fails.',
      parameters: {
        type: 'object',
        properties: { connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." } },
        required: ['connection_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_connection_rank',
      description:
        "Sets or changes a connection's rank -- required before Forge a Bond, Develop Your Relationship, or Test " +
        "Your Relationship can resolve. Reflects the connection's relative scale/significance, same rank scale as " +
        'a progress track (troublesome through epic).',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." },
          rank: { type: 'string', enum: ['troublesome', 'dangerous', 'formidable', 'extreme', 'epic'] },
        },
        required: ['connection_id', 'rank'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_connection_role',
      description:
        "Make a Connection: sets a connection's role (e.g. \"ship mechanic\", \"faction representative\") once the " +
        'connection is established (on a hit). From then on, whenever they aid a move closely tied to their role, ' +
        "add the connection's role bonus (+1 normally, or +2 if bolstered) and take +1 momentum on a hit -- this " +
        'applies whether bonded or not.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." },
          role: { type: 'string' },
        },
        required: ['connection_id', 'role'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_connection_location',
      description:
        "Sets or updates where a connection can typically be found -- a settlement, sector, or ship. Per the " +
        'book\'s own instruction on a successful Make a Connection, "make note of their name, location, and any ' +
        'other characteristics worth recording" -- usually set at creation via add_connection\'s own location ' +
        'argument, but use this instead if it genuinely comes up later (the fiction establishes it after the ' +
        'fact, or the connection relocates).',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." },
          location: { type: 'string' },
        },
        required: ['connection_id', 'location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bolster_connection_role',
      description:
        'Forge a Bond strong-hit choice A ("Bolster their influence"): raises the connection\'s existing role bonus ' +
        'from +1 to +2. Mutually exclusive with expand_connection_role -- the player picks one, not both.',
      parameters: {
        type: 'object',
        properties: { connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." } },
        required: ['connection_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'expand_connection_role',
      description:
        'Forge a Bond strong-hit choice B ("Expand their influence"): gives the connection a second role. Each role ' +
        'grants +1 (not stacked to +2) when it applies. Mutually exclusive with bolster_connection_role.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." },
          second_role: { type: 'string' },
        },
        required: ['connection_id', 'second_role'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suspend_connection_benefits',
      description:
        "Test Your Relationship's miss consequence: suspends a connection's mechanical/narrative benefits (their " +
        'role bonus, etc.) until the affirming quest is completed. Call restore_connection_benefits when that quest ' +
        "resolves, or remove_connection if the player refuses or fails it (the relationship is permanently undone).",
      parameters: {
        type: 'object',
        properties: { connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." } },
        required: ['connection_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restore_connection_benefits',
      description: "Restores a connection's suspended benefits once the affirming quest from a Test Your Relationship miss is fulfilled.",
      parameters: {
        type: 'object',
        properties: { connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." } },
        required: ['connection_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_connection_progress',
      description:
        'Develop Your Relationship (pre-bond): marks progress on this connection\'s own relationship track, using ' +
        "the connection's rank. Only valid while not yet bonded -- once bonded, Develop Your Relationship works " +
        'differently (roll_action_move using the rank-as-stat table in the system instructions, not this tool).',
      parameters: {
        type: 'object',
        properties: { connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." } },
        required: ['connection_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_connection_progress',
      description:
        'Forge a Bond\'s roll: compares this connection\'s accumulated relationship progress to the challenge dice. ' +
        'On a strong or weak hit, follow up with apply_bond_reward. On a miss, ask whether the player wants to ' +
        'recommit -- only call recommit_after_failed_bond if they do.',
      parameters: {
        type: 'object',
        properties: { connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." } },
        required: ['connection_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_bond_reward',
      description:
        "Applies the Forge a Bond reward: marks the connection-rank-appropriate amount on the bonds legacy track " +
        "(a different, smaller table than ordinary progress marking -- don't compute this yourself) and marks the " +
        'connection as bonded. Call after a strong or weak hit on roll_connection_progress.',
      parameters: {
        type: 'object',
        properties: { connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." } },
        required: ['connection_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_legacy_reward',
      description:
        'Applies the shared legacy-reward table (used by Fulfill Your Vow -> legacy-quests, and Finish an ' +
        'Expedition -> legacy-discoveries) -- troublesome=1 tick, dangerous=2, formidable=4, extreme=8, epic=12. ' +
        "This is NOT the same table as mark_progress_track's rank ticks (that one runs the opposite direction) -- " +
        "never compute this yourself, always call this tool. On a weak hit, pass the rank ONE STEP LOWER than the " +
        "vow/expedition's actual rank (the rulebook's own rule), not the real rank.",
      parameters: {
        type: 'object',
        properties: {
          track_id: { type: 'string', enum: ['legacy-quests', 'legacy-discoveries'], description: 'Which legacy track the reward goes to.' },
          rank: { type: 'string', enum: ['troublesome', 'dangerous', 'formidable', 'extreme', 'epic'] },
        },
        required: ['track_id', 'rank'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommit_progress_track',
      description:
        'Fulfill Your Vow\'s "recommit to the quest" / Finish an Expedition\'s "return to the expedition" ' +
        'consequence on a miss, ONLY if the player explicitly chooses that option. Rolls both challenge dice, ' +
        "clears progress equal to the lowest value (in boxes), and raises the track's rank by one. Do not call " +
        "this unless the player has actually chosen to recommit/return -- if they instead give up (Forsake Your " +
        "Vow, or abandon the expedition), don't call it.",
      parameters: {
        type: 'object',
        properties: { track_id: { type: 'string', description: "The same id chosen when this track was created via create_progress_track -- not a separately-generated value; create_progress_track's own id is model-chosen, so this must exactly match whatever slug was used there." } },
        required: ['track_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_track_rank',
      description:
        "Directly sets a progress track's rank -- no tick clearing, no roll, no other side effect. Genuinely " +
        'different from recommit_progress_track (which always clears progress as part of its own procedure): use ' +
        "this specifically when a rank should change on its own, with the track's existing progress left " +
        "untouched -- Sleuth's own text (\"make the rank of your quest one higher... and use the new rank when " +
        'marking future progress\") and Slayer\'s sacrifice choice both call for exactly this, not a recommit.',
      parameters: {
        type: 'object',
        properties: {
          track_id: { type: 'string', description: "The same id chosen when this track was created via create_progress_track -- not a separately-generated value." },
          rank: { type: 'string', enum: ['troublesome', 'dangerous', 'formidable', 'extreme', 'epic'], description: 'The new rank to set the track to.' },
        },
        required: ['track_id', 'rank'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommit_after_failed_bond',
      description:
        'Forge a Bond\'s miss consequence, ONLY if the player explicitly chooses to recommit to the relationship ' +
        'after being put at odds with the connection. Rolls both challenge dice, clears progress equal to the ' +
        'lowest value (in boxes), and raises the connection\'s rank by one. Do not call this unless the player has ' +
        'actually chosen to recommit -- if they don\'t, nothing further happens to the connection.',
      parameters: {
        type: 'object',
        properties: { connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." } },
        required: ['connection_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'raise_connection_rank',
      description:
        "Raises a connection's rank by one step (not already epic). Used for Develop Your Relationship's strong-" +
        'hit-with-a-match outcome once bonded, or any other moment the fiction earns it.',
      parameters: {
        type: 'object',
        properties: { connection_id: { type: 'string', description: "The exact \"id\" field returned by add_connection's own result -- never construct or guess one (e.g. from the connection's name), always use the literal value that call returned." } },
        required: ['connection_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_legacy_ticks',
      description:
        'Adds an EXACT tick amount to a legacy track (not rank-derived) -- used for the fixed 2-tick reward from ' +
        "Develop Your Relationship's post-bond outcome, or any other move that specifies an exact amount rather " +
        'than a rank. For rank-based marking, use mark_progress_track instead.',
      parameters: {
        type: 'object',
        properties: {
          track_id: { type: 'string', enum: ['legacy-quests', 'legacy-bonds', 'legacy-discoveries'], description: 'One of these three fixed, always-existing values -- never created via create_progress_track, so there is nothing to look up here.' },
          ticks: { type: 'integer', minimum: 1 },
        },
        required: ['track_id', 'ticks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adjust_progress_ticks',
      description:
        'Adjusts ANY progress track (vow, expedition, connection, fight objective, or legacy) by an exact signed ' +
        "tick delta, clamped to [0, max] -- the general-purpose version of mark_legacy_ticks, which only ever adds " +
        "and only works on legacy tracks. This is specifically for Lose Momentum's rare momentum-floor edge case " +
        "(clearing a set amount of progress on some other track when momentum is already at -6 and can't go " +
        'lower) -- pass a NEGATIVE delta to clear progress. Don\'t use this for normal progress marking; ' +
        'mark_progress_track (rank-based) or mark_legacy_ticks (exact, legacy-only) are correct for that.',
      parameters: {
        type: 'object',
        properties: {
          track_id: { type: 'string', description: "The same id chosen when this track was created via create_progress_track -- not a separately-generated value; create_progress_track's own id is model-chosen, so this must exactly match whatever slug was used there." },
          delta: { type: 'integer', description: 'Signed tick change. Negative to clear progress.' },
        },
        required: ['track_id', 'delta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'companion_takes_a_hit',
      description:
        "The Companion Takes a Hit move: reduces a Companion asset's own health meter (separate from the " +
        "character's) by harm suffered -- minor (-1), serious (-2), major (-3). If it was already at 0 or hits 0, " +
        "the excess spills into momentum loss automatically, same as Endure Harm. Only usable on Companion-category " +
        'assets the character owns.',
      parameters: {
        type: 'object',
        properties: {
          asset_id: { type: 'string', description: 'The owned Companion asset taking the hit.' },
          harm: { type: 'integer', enum: [-1, -2, -3], description: 'Minor -1, serious -2, major -3.' },
        },
        required: ['asset_id', 'harm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'heal_companion',
      description:
        "Increases a Companion asset's (or Symbiote's) own health by a positive amount, clamped to its real max " +
        '(5 for a normal Companion, 2 or 3 for Symbiote depending on whether its third ability is unlocked). The ' +
        "positive counterpart to companion_takes_a_hit, which explicitly cannot heal -- use this instead for the " +
        "Companion Takes a Hit move's own strong/weak hit results, Repair's companion healing, Sprite's free full " +
        'heal, Rockhorn\'s bonus health, or any other "+N health" for a companion.',
      parameters: {
        type: 'object',
        properties: {
          asset_id: { type: 'string', description: 'The owned Companion (or Symbiote) asset gaining health.' },
          amount: { type: 'integer', description: 'How much health to restore. Must be positive.' },
        },
        required: ['asset_id', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_asset_broken',
      description:
        'Marks (or clears) an owned asset -- specifically a Module -- as broken, per Withstand Damage\'s own miss ' +
        'consequence ("mark a module as broken... a broken module cannot be used until you successfully Repair ' +
        'it"). Rejected outright for anything that isn\'t actually a Module -- "broken" isn\'t a real mechanic for ' +
        'Companions or other asset categories, even under a generic prompt like Pay the Price\'s "your equipment or ' +
        'vehicle malfunctions" -- for a Companion taking harm, use companion_takes_a_hit instead, which reduces its ' +
        'health rather than marking it broken. A real mechanical restriction once actually applied to a Module: ' +
        'while broken is true, do not apply that asset\'s abilities to any ' +
        'roll or outcome. Call again with broken: false once Repair (or Repair\'s repair-points menu) fixes it.',
      parameters: {
        type: 'object',
        properties: {
          asset_id: { type: 'string', description: "The exact \"id\" field returned by buy_asset's or grant_asset's own result for this asset, or (more reliably, since that original call could be many turns in the past) the asset_id check_asset_bonuses returns for it right now -- never construct or guess one, always use a real, literal value one of those actually returned." },
          broken: { type: 'boolean' },
        },
        required: ['asset_id', 'broken'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_aboard_vehicle',
      description:
        "Sets which vehicle asset (by id) the character is currently aboard, or clears it if they've disembarked. " +
        "Battered/Cursed on THAT specific vehicle only count toward the momentum penalty while aboard it -- call " +
        "this when the fiction has the character board, disembark, or switch from one vehicle to another (e.g. " +
        "their Starship to a Support Vehicle), so the momentum math stays correct.",
      parameters: {
        type: 'object',
        properties: { asset_id: { type: 'string', description: 'The vehicle asset id, or omit/null if disembarking entirely.' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_vehicle_condition',
      description:
        "Marks or clears Battered or Cursed directly on a specific vehicle asset -- these live on the vehicle's " +
        'own card, not as a single character-wide condition. Support vehicles can only ever be battered, never ' +
        'cursed (only the command vehicle can be cursed). Cursed is permanent once marked -- do not call this to ' +
        'clear it.',
      parameters: {
        type: 'object',
        properties: {
          asset_id: { type: 'string', description: "The exact \"id\" field returned by buy_asset's or grant_asset's own result for this asset, or (more reliably, since that original call could be many turns in the past) the asset_id check_asset_bonuses returns for it right now -- never construct or guess one, always use a real, literal value one of those actually returned." },
          condition: { type: 'string', enum: ['battered', 'cursed'] },
          marked: { type: 'boolean' },
        },
        required: ['asset_id', 'condition', 'marked'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_combat_position',
      description:
        'Sets combat position: "in_control" (proactive/offensive moves available) or "bad_spot" (reactive/' +
        'defensive moves only), or null when not in a fight. The default guideline is a strong hit puts the ' +
        'character in control and a weak hit or miss puts them in a bad spot -- but use fiction-first judgment, ' +
        'not that formula blindly (some moves set position explicitly regardless of outcome).',
      parameters: {
        type: 'object',
        properties: { position: { type: 'string', enum: ['in_control', 'bad_spot', 'none'] } },
        required: ['position'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_combat_range',
      description:
        'Sets combat range: "close" (Strike/Clash roll +iron) or "distance" (Strike/Clash roll +edge), or "none" ' +
        "when not in a fight. Changes when the fiction moves combatants closer or farther apart -- gunfire and " +
        "vehicle exchanges are usually at a distance, melee and boarding actions are close quarters.",
      parameters: {
        type: 'object',
        properties: { range: { type: 'string', enum: ['close', 'distance', 'none'] } },
        required: ['range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'discard_asset',
      description:
        "Permanently removes an owned asset -- it's destroyed, lost, or discarded (e.g. Overcome Destruction: " +
        '"discard the asset, along with any modules and docked support vehicles"). Unlike anything else asset-' +
        "related, this can't be undone by spending experience.",
      parameters: {
        type: 'object',
        properties: { asset_id: { type: 'string', description: "The exact \"id\" field returned by buy_asset's or grant_asset's own result for this asset, or (more reliably, since that original call could be many turns in the past) the asset_id check_asset_bonuses returns for it right now -- never construct or guess one, always use a real, literal value one of those actually returned." } },
        required: ['asset_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'begin_scene_challenge',
      description:
        'Begin the Scene move: starts a structured Scene Challenge for an extended non-combat conflict with time ' +
        'pressure (disarming a timed device, a hacking duel, a formal debate, a race). Creates a linked progress ' +
        'track AND a 4-segment tension clock together. Rank: Troublesome (clear advantage), Dangerous (ready to ' +
        'act, default if unsure), or Formidable (unprepared or outmatched). Once begun, resolve actions with ' +
        'roll_action_move using "Face Danger" or "Secure an Advantage" as normal, but apply outcomes per the ' +
        'Scene Challenge rules (see system instructions), and finish it with roll_progress_move against this track.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A short unique slug, e.g. "scene-disarm-bomb".' },
          name: { type: 'string', description: 'The objective, e.g. "Disarm the bomb before it detonates".' },
          rank: { type: 'string', enum: ['troublesome', 'dangerous', 'formidable'] },
        },
        required: ['id', 'name', 'rank'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_clock',
      description:
        'Create a campaign clock or tension clock (4, 6, 8, or 10 segments). Campaign clocks track ' +
        "background events/factions independent of the player's actions, advanced by an oracle check at the start " +
        'of a session. Tension clocks track a looming threat or deadline in the current situation, advanced when ' +
        'the player Pays the Price or hits a complication -- never on their own.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'What the clock represents, e.g. "Northstar Syndicate takeover" or "Reinforcements arrive".' },
          type: { type: 'string', enum: ['campaign', 'tension'] },
          segments: { type: 'integer', enum: [4, 6, 8, 10], description: 'Imminent tension clocks: 4 or 6. Longer-term threats or campaign clocks: 6-10.' },
        },
        required: ['name', 'type', 'segments'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'advance_clock',
      description:
        'Fill one or more segments on a clock. For campaign clocks: normally 1 segment when checked at the start ' +
        'of a session (2 on a match). For tension clocks: normally 1 segment on a cost/complication (2 on a miss ' +
        "with a match). Clocks never move backwards -- to remove one that's no longer relevant, use stop_clock.",
      parameters: {
        type: 'object',
        properties: {
          clock_id: { type: 'string', description: "The exact \"id\" field returned by create_clock's own result -- never construct or guess one, always use the literal value that call returned." },
          amount: { type: 'integer', minimum: 1 },
        },
        required: ['clock_id', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_clock',
      description: "Remove a clock from play -- it's been resolved, stopped, or is no longer relevant. Also appropriate once a clock fills completely and its outcome has been narrated.",
      parameters: {
        type: 'object',
        properties: { clock_id: { type: 'string', description: "The exact \"id\" field returned by create_clock's own result -- never construct or guess one, always use the literal value that call returned." } },
        required: ['clock_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_log_entry',
      description:
        'Append a short continuity note to the campaign log -- a session summary, an unresolved thread, something ' +
        'to remember for later. Use sparingly, at natural breakpoints (end of a scene or session), not after every move.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        'Generate an AI image via the player\'s local ComfyUI server -- a character portrait, a location/planet/' +
        'derelict/settlement, or a general story illustration. Only call this when the player explicitly asks for ' +
        'a visual (e.g. "show me what he looks like", "generate an image of this planet") -- never automatically ' +
        'for every scene or description, since generation takes real time and local compute. If it fails, tell ' +
        'the player plainly (likely their ComfyUI server isn\'t running or isn\'t configured) rather than retrying blindly.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['portrait', 'location', 'connection', 'illustration'], description: 'Where the image gets attached.' },
          prompt: { type: 'string', description: 'A vivid, concrete visual description of exactly what should be in the image -- subject, setting, mood.' },
          cell: { type: 'string', description: 'Required when target is "location": the sector hex, e.g. "5,4".' },
          connection_id: { type: 'string', description: 'Required when target is "connection": the id of the connection to attach the image to.' },
          caption: { type: 'string', description: 'Short caption (used for illustrations and locations).' },
        },
        required: ['target', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_move',
      description: 'Look up the exact trigger and outcome text for a move, without rolling. Use this if unsure exactly how a move works before calling it.',
      parameters: {
        type: 'object',
        properties: { move_name: { type: 'string' } },
        required: ['move_name'],
      },
    },
  },
];

/**
 * Executes a single tool call against a private working state. The public executeTool wrapper
 * commits that state only if this dispatcher succeeds. `imageGen` (optional) is
 * `{ baseUrl, workflowTemplate, saveImage(buffer) => imageId }`, injected by the
 * caller so this module never touches the filesystem or Electron directly -- if omitted,
 * generate_image reports a clean "not configured" error instead of throwing.
 * Async because generate_image makes real network calls; every other case still just returns
 * a plain value, which works fine inside an async function.
 */
async function executeToolOnWorkingState(name, args, campaignState, imageGen = null) {
  switch (name) {
    case 'roll_action_move': {
      const move = data.findMove(args.move_name) || (
        args.value_source === 'time_gap' && String(args.move_name).toLowerCase() === 'loop back'
          ? { $id: 'Starforged/Assets/Path/Looper/Loop_Back', Name: 'Loop Back', Category: 'Asset Move', Display: {} }
          : null
      );
      if (!move) return { error: `No move found matching "${args.move_name}".` };
      let resolved;
      let actionDieMode;
      try {
        resolved = resolveRollValue(move, args, campaignState);
        actionDieMode = validateActionDieMode(args, campaignState);
      } catch (error) {
        return { error: error.message };
      }
      let result;
      if (actionDieMode.mode === 'normal') {
        result = dice.rollActionMove({ statValue: resolved.statValue, adds: args.adds || 0, momentum: campaignState.character.meters.momentum });
      } else {
        const actionDie = actionDieMode.mode === 'preset' ? actionDieMode.preset : null;
        const dieValue = actionDie === null ? 0 : actionDie;
        const negativeMomentumApplied = actionDie !== null && campaignState.character.meters.momentum < 0 && Math.abs(campaignState.character.meters.momentum) === actionDie;
        const actionScore = dice.computeActionScore(negativeMomentumApplied ? 0 : dieValue, resolved.statValue, args.adds || 0);
        const challengeDice = dice.rollChallengeDice();
        result = {
          actionDie,
          statValue: resolved.statValue,
          adds: args.adds || 0,
          momentum: campaignState.character.meters.momentum,
          negativeMomentumApplied,
          challengeDice,
          actionScore,
          ...dice.determineOutcome(actionScore, challengeDice),
        };
      }
      const rollId = state.recordRoll(campaignState, {
        kind: 'action',
        moveName: move.Name,
        stat: args.stat,
        ...resolved,
        adds: result.adds,
        actionDie: result.actionDie,
        momentum: result.momentum,
        actionDieMode: actionDieMode.mode,
        actionScore: result.actionScore,
        challengeDice: result.challengeDice,
        outcome: result.outcome,
        isMatch: result.is_match,
      });
      // Surfaced directly in this same result, not left as a separate fact the model has to
      // remember to go check on its own -- real play showed that check being skipped entirely,
      // even with explicit prompt guidance already telling the model exactly when to make it.
      // A miss with momentum 6 against an action score of 2 should have offered a burn (it would
      // have turned that exact miss into a strong hit) and simply didn't; nothing here can force
      // the model to act on this, but putting the computed answer inside the one result it's
      // already reading removes the separate step where that answer previously went missing.
      // Same threshold burn_momentum's own handler enforces (momentum must genuinely exceed the
      // score, not just be present) so the two can never disagree with each other.
      let momentumBurn = { available: false };
      if ((result.outcome === 'weak_hit' || result.outcome === 'miss') && result.momentum > result.actionScore) {
        const preview = dice.determineOutcome(result.momentum, result.challengeDice);
        momentumBurn = {
          available: true,
          would_produce_outcome: preview.outcome,
          next_step:
            'REQUIRED: call present_choice now, offering to burn momentum for this improved outcome or keep the ' +
            'result as rolled -- a genuine choice for the player to make, not something to decide on their behalf. ' +
            "Don't narrate or resolve this roll's outcome until they've actually answered.",
        };
      }
      return {
        move: {
          id: move.$id,
          name: move.Name,
          category: (move.Category || '').split('/').pop(),
          color: (move.Display && move.Display.Color) || null,
        },
        stat: args.stat,
        roll_id: rollId,
        ...result,
        outcome_text: outcomeTextFor(move, result.outcome),
        momentum_burn: momentumBurn,
      };
    }
    case 'check_asset_bonuses': {
      const move = data.findMove(args.move_name);
      if (!move) return { error: `No move found matching "${args.move_name}".` };
      const { explicit, implicit } = data.getAssetAbilitiesForMove(campaignState.character.assets, move.Name);
      // Only on the post-roll call (outcome provided): for any explicit match that's also in the
      // hand-verified structured-effect table, actually compute and apply the real result here,
      // rather than just describing it in prose for the model to apply itself. Attached directly
      // onto that ability's own entry so it's unambiguous which specific ability produced which
      // change, not a separate, disconnected list.
      if (args.outcome) {
        if (!args.roll_id) return { error: 'roll_id is required on the post-roll check_asset_bonuses call.' };
        let roll;
        try {
          roll = state.getRoll(campaignState, args.roll_id);
        } catch (error) {
          return { error: error.message };
        }
        if (roll.moveName !== move.Name) return { error: `roll_id "${args.roll_id}" belongs to ${roll.moveName}, not ${move.Name}.` };
        if (roll.currentOutcome !== args.outcome || roll.currentIsMatch !== !!args.is_match) {
          return { error: 'The supplied outcome/is_match does not match the engine-recorded roll.' };
        }
        for (const entry of explicit) {
          const effect = state.getStructuredAssetEffect(entry.asset, entry.level);
          if (effect) {
            const effectKey = `${entry.asset_id}:${entry.level}`;
            const previous = state.getAppliedAssetEffect(campaignState, args.roll_id, effectKey);
            if (previous) {
              entry.applied = { ...previous, already_applied: true };
            } else {
              entry.applied = state.applyStructuredAssetEffect(campaignState, effect, { outcome: roll.currentOutcome, isMatch: roll.currentIsMatch });
              state.recordAppliedAssetEffect(campaignState, args.roll_id, effectKey, entry.applied);
            }
          }
        }
      }
      return { move_name: move.Name, explicit, implicit };
    }
    case 'roll_progress_move': {
      const track = campaignState.progressTracks.find((t) => t.id === args.track_id);
      if (!track) return { error: `No progress track with id "${args.track_id}".` };
      let progressMove = null;
      if (args.move_name) {
        progressMove = data.findMove(args.move_name);
        const isProgressMove = progressMove && (progressMove.Trigger?.Options || []).some((option) => option['Roll type'] === 'Progress roll');
        if (!isProgressMove) return { error: `No progress move found matching "${args.move_name}".` };
      }
      // A legacy track that has ever been cleared always resolves as if at 10 progress,
      // even though its ticks reset to 0 to keep earning experience -- per the rulebook.
      const progressScore = track.legacyCleared ? 10 : state.progressBoxes(track.ticks);
      const result = dice.rollProgressMove({ progressScore });
      // Take Decisive Action's own rule: "If you are in a bad spot, count a strong hit without a
      // match as a weak hit, and a weak hit as a miss." Opt-in via apply_bad_spot_downgrade
      // since this only applies to specific combat-position-sensitive progress moves, not every
      // progress roll (a vow or expedition roll is never affected by combat position).
      if (args.apply_bad_spot_downgrade) {
        const original = result.outcome;
        if (result.outcome === 'strong_hit' && !result.is_match) result.outcome = 'weak_hit';
        else if (result.outcome === 'weak_hit') result.outcome = 'miss';
        if (result.outcome !== original) result.downgraded_from = original;
      }
      const rollId = state.recordRoll(campaignState, {
        kind: 'progress',
        moveName: progressMove ? progressMove.Name : null,
        trackId: args.track_id,
        progressScore: result.progressScore,
        challengeDice: result.challengeDice,
        outcome: result.outcome,
        isMatch: result.is_match,
      });
      return { roll_id: rollId, track_id: args.track_id, track_name: track.name, ...result };
    }
    case 'mark_progress_track': {
      try {
        const result = state.markProgress(campaignState, args.track_id, args.rank);
        return { track_id: args.track_id, ...result };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'create_progress_track': {
      if (campaignState.progressTracks.some((t) => t.id === args.id)) {
        return { error: `A track with id "${args.id}" already exists.` };
      }
      campaignState.progressTracks.push({ id: args.id, name: args.name, type: args.type, rank: args.rank, ticks: 0 });
      return { created: args.id };
    }
    case 'remove_progress_track': {
      try {
        return state.removeProgressTrack(campaignState, args.track_id);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'roll_oracle': {
      const oracle = data.findOracle(args.oracle_name);
      if (!oracle) {
        return { error: `No oracle found matching "${args.oracle_name}".`, suggestions: data.suggestOracles(args.oracle_name) };
      }
      const result = dice.rollOracleTable(oracle.table);
      return {
        oracle: { id: oracle.id, name: oracle.name, path: oracle.path },
        roll: result.roll,
        is_match: result.is_match,
        result: result.row ? data.stripCrossRefLinks(result.row.Result) : null,
      };
    }
    case 'roll_severe_harm_table': {
      try {
        return dice.rollSevereHarmTable(args.kind);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'roll_vehicle_destruction_table': {
      return dice.rollVehicleDestructionTable();
    }
    case 'ask_the_oracle': {
      try {
        const result = dice.rollOdds(args.odds);
        return { question: args.question, ...result };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'update_meter': {
      try {
        const result = state.updateMeter(campaignState, args.meter, args.delta);
        const out = { meter: args.meter, new_value: result.value };
        if (result.momentumOverflow > 0) {
          out.momentum_overflow = result.momentumOverflow;
          out.new_momentum = campaignState.character.meters.momentum;
          out.note = `${args.meter} could not absorb the full reduction -- the excess (${result.momentumOverflow}) spilled into momentum loss, per the rules.`;
        }
        if (result.unresolvedOverflow > 0) {
          out.unresolved_overflow = result.unresolvedOverflow;
          out.note = `Momentum was already at its -6 floor and could only absorb ${result.momentumOverflow} of the overflow -- ${result.unresolvedOverflow} more must be applied some other way (a condition meter, an impact, or a setback in a quest), per the rules. Use your judgment on which.`;
        }
        return out;
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'burn_momentum': {
      let roll;
      try {
        roll = state.getRoll(campaignState, args.roll_id);
      } catch (error) {
        return { error: error.message };
      }
      const currentMomentum = campaignState.character.meters.momentum;
      if (roll.kind !== 'action') return { error: 'Momentum can only be burned on an action roll, not a progress roll.' };
      if (roll.momentumBurned) return { error: `Momentum was already burned for roll_id "${args.roll_id}".` };
      if (currentMomentum <= roll.currentActionScore) {
        return {
          error: `Burning momentum wouldn't help here: current momentum (${currentMomentum}) does not exceed the roll's current score (${roll.currentActionScore}). Refused -- momentum was NOT spent.`,
        };
      }
      const recomputed = dice.determineOutcome(currentMomentum, roll.currentChallengeDice);
      const newOutcome = { new_action_score: currentMomentum, challenge_dice: roll.currentChallengeDice, ...recomputed };
      const result = state.burnMomentum(campaignState);
      state.markMomentumBurned(campaignState, args.roll_id);
      state.updateRollResolution(campaignState, args.roll_id, currentMomentum, roll.currentChallengeDice, recomputed);
      return { ...result, new_outcome: newOutcome };
    }
    case 'reroll_action_die': {
      try {
        if (!args.roll_id) return { die: dice.rollActionDie(), standalone: true };
        const roll = state.getRoll(campaignState, args.roll_id);
        if (roll.kind !== 'action') return { error: 'reroll_action_die requires an action-roll roll_id.' };
        if (args.extra_add === 1 && !campaignState.character.assets.some((asset) => asset.name === 'Looper' && asset.abilities_unlocked.includes(3))) {
          return { error: 'extra_add 1 requires an owned Looper with ability 3 unlocked.' };
        }
        const die = dice.rollActionDie();
        const dieValue = roll.momentum < 0 && Math.abs(roll.momentum) === die ? 0 : die;
        const actionScore = dice.computeActionScore(dieValue, roll.statValue, roll.adds + (args.extra_add || 0));
        state.authorizeActionScore(campaignState, args.roll_id, actionScore);
        const result = dice.determineOutcome(actionScore, roll.currentChallengeDice);
        state.updateRollResolution(campaignState, args.roll_id, actionScore, roll.currentChallengeDice, result);
        return { roll_id: args.roll_id, die, action_score: actionScore, challenge_dice: roll.currentChallengeDice, ...result };
      } catch (error) {
        return { error: error.message };
      }
    }
    case 'roll_extra_challenge_die': {
      try {
        const roll = state.getRoll(campaignState, args.roll_id);
        const die = dice.rollExtraChallengeDie();
        for (const original of roll.currentChallengeDice) {
          state.authorizeChallengeDice(campaignState, args.roll_id, [original, die]);
          state.authorizeChallengeDice(campaignState, args.roll_id, [die, original]);
        }
        return { roll_id: args.roll_id, die };
      } catch (error) {
        return { error: error.message };
      }
    }
    case 'roll_bonus_challenge_dice': {
      try {
        const roll = state.getRoll(campaignState, args.roll_id);
        const result = dice.rollBonusChallengeDice(roll.currentActionScore, roll.currentChallengeDice, args.extra_die_count || 1);
        if (result.forced_match) {
          state.authorizeChallengeDice(campaignState, args.roll_id, result.dice_used);
          state.updateRollResolution(campaignState, args.roll_id, roll.currentActionScore, result.dice_used, result);
        } else {
          for (const pairing of result.possible_pairings) state.authorizeChallengeDice(campaignState, args.roll_id, pairing.dice);
        }
        return { roll_id: args.roll_id, action_score: roll.currentActionScore, ...result };
      } catch (error) {
        return { error: error.message };
      }
    }
    case 'reroll_challenge_dice': {
      try {
        const roll = state.getRoll(campaignState, args.roll_id);
        const challengeDice = dice.rerollChallengeDice();
        state.authorizeChallengeDice(campaignState, args.roll_id, challengeDice);
        const result = dice.determineOutcome(roll.currentActionScore, challengeDice);
        state.updateRollResolution(campaignState, args.roll_id, roll.currentActionScore, challengeDice, result);
        return { roll_id: args.roll_id, action_score: roll.currentActionScore, challenge_dice: challengeDice, ...result };
      } catch (error) {
        return { error: error.message };
      }
    }
    case 'resolve_action_with_dice': {
      if (!Array.isArray(args.challenge_dice) || args.challenge_dice.length !== 2) {
        return { error: 'challenge_dice must be an array of exactly 2 integers.' };
      }
      try {
        const roll = state.getRoll(campaignState, args.roll_id);
        let actionScore = args.action_score === undefined ? roll.currentActionScore : args.action_score;
        let burnSpecialMomentum = false;
        if (args.score_mode && args.score_mode !== 'current') {
          const asset = campaignState.character.assets.find((candidate) => candidate.id === args.source_id);
          if (args.score_mode === 'kinetic_plus_2') {
            if (!asset || asset.name !== 'Kinetic' || !asset.abilities_unlocked.includes(2)) return { error: 'kinetic_plus_2 requires the exact id of an owned Kinetic with ability 2 unlocked.' };
            actionScore = Math.min(10, roll.currentActionScore + 2);
          } else if (args.score_mode === 'exosuit_integrity_die') {
            if (!asset || asset.name !== 'Exosuit' || !asset.abilities_unlocked.includes(2) || roll.kind !== 'action') return { error: 'exosuit_integrity_die requires an action roll and the exact id of an owned Exosuit with ability 2 unlocked.' };
            actionScore = dice.computeActionScore(campaignState.character.meters.integrity, roll.statValue, roll.adds);
          }
          state.authorizeActionScore(campaignState, args.roll_id, actionScore);
        }
        if (args.dice_mode === 'revenant_zero') {
          const revenant = campaignState.character.assets.find((candidate) => candidate.id === args.source_id && candidate.name === 'Revenant' && candidate.abilities_unlocked.includes(2));
          const changedIndexes = roll.challengeDice
            .map((value, index) => (args.challenge_dice[index] === 0 && value !== 0 ? index : -1))
            .filter((index) => index >= 0);
          const unchangedIndexes = roll.challengeDice
            .map((value, index) => (args.challenge_dice[index] === value ? index : -1))
            .filter((index) => index >= 0);
          if (!revenant || roll.moveName !== 'Take Decisive Action' || changedIndexes.length !== 1 || unchangedIndexes.length !== 1) {
            return { error: 'revenant_zero requires Take Decisive Action and the exact id of an owned Revenant with ability 2 unlocked, changing exactly one original die to 0.' };
          }
          if (roll.momentumBurned) return { error: `Momentum was already burned for roll_id "${args.roll_id}".` };
          if (campaignState.character.meters.momentum <= roll.challengeDice[changedIndexes[0]]) {
            return { error: 'Current momentum must exceed the challenge die being zeroed.' };
          }
          state.authorizeChallengeDice(campaignState, args.roll_id, args.challenge_dice);
          burnSpecialMomentum = true;
        }
        if (!state.isAuthorizedActionScore(campaignState, args.roll_id, actionScore)) return { error: 'action_score was not produced or authorized by the engine for this roll_id.' };
        if (!state.isAuthorizedChallengeDice(campaignState, args.roll_id, args.challenge_dice)) return { error: 'challenge_dice were not produced or authorized by the engine for this roll_id.' };
        const recomputed = dice.determineOutcome(actionScore, args.challenge_dice);
        let momentumBurn = null;
        if (burnSpecialMomentum) {
          momentumBurn = state.burnMomentum(campaignState);
          state.markMomentumBurned(campaignState, args.roll_id);
        }
        state.updateRollResolution(campaignState, args.roll_id, actionScore, args.challenge_dice, recomputed);
        return { roll_id: args.roll_id, action_score: actionScore, challenge_dice: args.challenge_dice, ...recomputed, ...(momentumBurn ? { momentum_burn: momentumBurn } : {}) };
      } catch (error) {
        return { error: error.message };
      }
    }
    case 'adjust_asset_resource': {
      try {
        return state.adjustAssetResource(campaignState, args.asset_id, args.delta);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'set_asset_resource': {
      try {
        return state.setAssetResource(campaignState, args.asset_id, { current: args.current, max: args.max });
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'toggle_impact': {
      try {
        return state.toggleImpact(campaignState, args.category, args.name);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'add_other_impact': {
      try {
        return state.addOtherImpact(campaignState, args.name);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'remove_other_impact': {
      try {
        state.removeOtherImpact(campaignState, args.name);
        return { removed: args.name };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'add_flag': {
      try {
        return { flags: state.addFlag(campaignState, args.text) };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'remove_flag': {
      try {
        return { flags: state.removeFlag(campaignState, args.text) };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'add_campaign_element': {
      try {
        return state.addCampaignElement(campaignState, args.category, args.name, args.description);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'remove_campaign_element': {
      try {
        return { campaign_elements: state.removeCampaignElement(campaignState, args.id) };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'roll_campaign_element': {
      try {
        return state.rollCampaignElement(campaignState);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'earn_experience': {
      try {
        const total = state.earnExperience(campaignState, args.amount);
        return { earned: args.amount, reason: args.reason, total_available: total };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'buy_asset': {
      const asset = data.findAsset(args.asset_name);
      if (!asset) return { error: `No asset found matching "${args.asset_name}".` };
      try {
        const added = state.purchaseAsset(campaignState, {
          id: asset.$id,
          name: asset.Name,
          category: (asset['Asset Type'] || '').split('/').pop(),
        });
        return {
          asset: added,
          ability_text: asset.Abilities && asset.Abilities[0] ? asset.Abilities[0].Text : null,
          experience_remaining: state.availableExperience(campaignState),
        };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'grant_asset': {
      const asset = data.findAsset(args.asset_name);
      if (!asset) return { error: `No asset found matching "${args.asset_name}".` };
      try {
        // Deliberately no spendExperience call -- this is the free-grant path, distinct from
        // buy_asset's cost. See the tool's own description for when each one applies.
        const added = state.addAsset(campaignState, {
          id: asset.$id,
          name: asset.Name,
          category: (asset['Asset Type'] || '').split('/').pop(),
        });
        return {
          asset: added,
          ability_text: asset.Abilities && asset.Abilities[0] ? asset.Abilities[0].Text : null,
        };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'upgrade_asset': {
      const owned = campaignState.character.assets.find((a) => a.name.toLowerCase() === String(args.asset_name).toLowerCase());
      if (!owned) return { error: `Character doesn't own an asset called "${args.asset_name}".` };
      try {
        state.upgradeAsset(campaignState, owned.id, args.ability_number);
        const fullAsset = data.findAsset(owned.id);
        const abilityText = fullAsset && fullAsset.Abilities ? fullAsset.Abilities[args.ability_number - 1].Text : null;
        return { asset: owned, ability_number: args.ability_number, ability_text: abilityText, experience_remaining: state.availableExperience(campaignState) };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'set_sector_info': {
      try {
        return state.setSectorInfo(campaignState, args.sector_id || null, { name: args.name, region: args.region, factionControl: args.factionControl, notes: args.notes });
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'reveal_location': {
      try {
        return { cell: args.cell, ...state.updateCell(campaignState, args.sector_id || null, args.cell, { name: args.name, notes: args.notes }) };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'add_location_feature': {
      try {
        const feature = state.addFeature(campaignState, args.sector_id || null, args.cell, { type: args.type, name: args.name, description: args.description });
        return { cell: args.cell, feature };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'set_current_location': {
      try {
        state.setCurrentCell(campaignState, args.sector_id || null, args.cell);
        return { current_cell: args.cell };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'create_passage': {
      try {
        return state.createPassage(campaignState, args.sector_id || null, { fromCell: args.from_cell, toCell: args.to_cell || null, notes: args.notes, toSectorId: args.to_sector_id || null });
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'link_passage_to_sector': {
      try {
        return state.linkPassageToSector(campaignState, args.sector_id || null, args.passage_id, args.to_sector_id === 'none' ? null : args.to_sector_id);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'remove_passage': {
      try {
        return state.removePassage(campaignState, args.sector_id || null, args.passage_id);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'create_sector': {
      try {
        return state.createSector(campaignState, { name: args.name, region: args.region, factionControl: args.factionControl, viaPassageId: args.via_passage_id || null, fromSectorId: args.from_sector_id || null });
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'switch_sector': {
      try {
        state.switchSector(campaignState, args.sector_id);
        return { current_sector_id: args.sector_id };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'roll_setting_truth': {
      const category = data.findTruthCategory(args.category);
      if (!category) return { error: `No Setting Truth category matching "${args.category}".` };
      const rolled = dice.rollOracleTable(category.Table);
      if (!rolled.row) return { error: 'Roll landed outside the table range -- this should not happen; try again.' };
      let subtableResult = null;
      if (Array.isArray(rolled.row.Subtable) && rolled.row.Subtable.length > 0) {
        const subRolled = dice.rollOracleTable(rolled.row.Subtable);
        subtableResult = subRolled.row ? subRolled.row.Result : null;
      }
      const saved = state.setTruth(campaignState, category.Name, {
        result: rolled.row.Result,
        subtableResult,
        description: rolled.row.Description || '',
        questStarter: rolled.row['Quest Starter'] || '',
        source: 'rolled',
      });
      return { category: category.Name, roll: rolled.roll, ...saved };
    }
    case 'set_setting_truth': {
      const category = data.findTruthCategory(args.category);
      if (!category) return { error: `No Setting Truth category matching "${args.category}".` };
      const saved = state.setTruth(campaignState, category.Name, {
        result: args.result,
        description: args.description || '',
        questStarter: args.questStarter || '',
        source: 'chosen',
      });
      return { category: category.Name, ...saved };
    }
    case 'add_connection': {
      return state.addConnection(campaignState, { name: args.name, notes: args.notes, location: args.location });
    }
    case 'set_connection_rank': {
      try {
        return state.setConnectionRank(campaignState, args.connection_id, args.rank);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'set_connection_role': {
      try {
        return state.setConnectionRole(campaignState, args.connection_id, args.role);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'set_connection_location': {
      try {
        return state.updateConnection(campaignState, args.connection_id, { location: args.location });
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'bolster_connection_role': {
      try {
        return state.bolsterConnectionRole(campaignState, args.connection_id);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'expand_connection_role': {
      try {
        return state.expandConnectionRole(campaignState, args.connection_id, args.second_role);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'suspend_connection_benefits': {
      try {
        return state.suspendConnectionBenefits(campaignState, args.connection_id);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'restore_connection_benefits': {
      try {
        return state.restoreConnectionBenefits(campaignState, args.connection_id);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'remove_connection': {
      try {
        state.removeConnection(campaignState, args.connection_id);
        return { removed: args.connection_id };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'mark_connection_progress': {
      try {
        return state.markConnectionProgress(campaignState, args.connection_id);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'roll_connection_progress': {
      const c = campaignState.connections.find((x) => x.id === args.connection_id);
      if (!c) return { error: `No connection with id "${args.connection_id}".` };
      const progressScore = state.progressBoxes(c.progressTicks);
      const result = dice.rollProgressMove({ progressScore });
      return { connection_id: args.connection_id, connection_name: c.name, ...result };
    }
    case 'apply_bond_reward': {
      try {
        return state.applyBondReward(campaignState, args.connection_id);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'apply_legacy_reward': {
      try {
        return state.applyLegacyReward(campaignState, args.track_id, args.rank);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'recommit_progress_track': {
      try {
        return state.recommitProgressTrack(campaignState, args.track_id);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'set_track_rank': {
      try {
        return state.setTrackRank(campaignState, args.track_id, args.rank);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'recommit_after_failed_bond': {
      try {
        return state.recommitAfterFailedBond(campaignState, args.connection_id);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'raise_connection_rank': {
      try {
        return state.raiseConnectionRank(campaignState, args.connection_id);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'mark_legacy_ticks': {
      try {
        return state.markProgressExact(campaignState, args.track_id, args.ticks);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'adjust_progress_ticks': {
      try {
        return state.markProgressExact(campaignState, args.track_id, args.delta);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'add_log_entry': {
      return state.addLogEntry(campaignState, args.text);
    }
    case 'companion_takes_a_hit': {
      try {
        return state.companionTakesAHit(campaignState, args.asset_id, args.harm);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'heal_companion': {
      try {
        return state.healCompanion(campaignState, args.asset_id, args.amount);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'set_asset_broken': {
      try {
        return state.setAssetBroken(campaignState, args.asset_id, args.broken);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'set_aboard_vehicle': {
      try {
        const assetId = state.setAboardVehicle(campaignState, args.asset_id || null);
        return { aboard_vehicle_id: assetId, momentum_max: campaignState.character.meters.momentum_max, momentum_reset: campaignState.character.meters.momentum_reset };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'set_vehicle_condition': {
      try {
        return state.setVehicleCondition(campaignState, args.asset_id, args.condition, args.marked);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'set_combat_position': {
      try {
        const position = state.setCombatPosition(campaignState, args.position === 'none' ? null : args.position);
        return { combat_position: position };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'set_combat_range': {
      try {
        const range = state.setCombatRange(campaignState, args.range === 'none' ? null : args.range);
        return { combat_range: range };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'discard_asset': {
      try {
        return state.removeAsset(campaignState, args.asset_id);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'begin_scene_challenge': {
      try {
        const { track, clock } = state.createSceneChallenge(campaignState, { id: args.id, name: args.name, rank: args.rank });
        return { track, clock };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'create_clock': {
      try {
        return state.createClock(campaignState, { name: args.name, type: args.type, segments: args.segments });
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'advance_clock': {
      try {
        return state.advanceClock(campaignState, args.clock_id, args.amount);
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'stop_clock': {
      try {
        state.stopClock(campaignState, args.clock_id);
        return { stopped: args.clock_id };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'generate_image': {
      if (!imageGen || !imageGen.baseUrl) {
        return { error: 'ComfyUI is not configured yet -- the player needs to set a server URL and workflow template in Settings first.' };
      }
      if (args.target === 'location' && !args.cell) {
        return { error: 'target "location" requires a cell.' };
      }
      if (args.target === 'connection' && !args.connection_id) {
        return { error: 'target "connection" requires a connection_id.' };
      }
      if (args.target === 'connection' && !campaignState.connections.some((c) => c.id === args.connection_id)) {
        return { error: `No connection with id "${args.connection_id}".` };
      }
      try {
        const buffer = await comfyui.generateImage({ baseUrl: imageGen.baseUrl, workflowTemplate: imageGen.workflowTemplate, prompt: args.prompt, signal: imageGen.signal });
        const imageId = imageGen.saveImage(buffer);
        if (args.target === 'portrait') {
          state.setPortraitImage(campaignState, imageId);
        } else if (args.target === 'location') {
          state.setCellImage(campaignState, args.sector_id || null, args.cell, imageId);
        } else if (args.target === 'connection') {
          state.setConnectionImage(campaignState, args.connection_id, imageId);
        } else {
          state.addIllustration(campaignState, { imageId, caption: args.caption || args.prompt.slice(0, 80) });
        }
        return { imageId, target: args.target };
      } catch (e) {
        return { error: e.message };
      }
    }
    case 'lookup_move': {
      const move = data.findMove(args.move_name);
      if (!move) return { error: `No move found matching "${args.move_name}".` };
      // Strip embedded cross-reference links (e.g. "[Pay the Price](Starforged/Moves/Fate/
      // Pay_the_Price)") from every text field before this reaches the model -- lookup_move is
      // the tool explicitly recommended whenever the GM is unsure how a move resolves, so it
      // gets called often, and raw markdown syntax leaking into the model's context risks
      // leaking straight into player-facing narration, not just a display glitch.
      const cleanTrigger = move.Trigger && {
        ...move.Trigger,
        Text: data.stripCrossRefLinks(move.Trigger.Text),
        Options: (move.Trigger.Options || []).map((o) => ({ ...o, Text: data.stripCrossRefLinks(o.Text) })),
      };
      const cleanOutcomes = move.Outcomes && Object.fromEntries(Object.entries(move.Outcomes).map(([key, val]) => [key, val && typeof val === 'object' && 'Text' in val ? { ...val, Text: data.stripCrossRefLinks(val.Text) } : val]));
      return { id: move.$id, name: move.Name, trigger: cleanTrigger, text: data.stripCrossRefLinks(move.Text), outcomes: cleanOutcomes || null };
    }
    default:
      return { error: `Unknown tool "${name}".` };
  }
}

/**
 * Transactional public boundary for every model-callable tool. A handler may mutate its working
 * copy freely; a returned `{ error }` or thrown exception discards all of those mutations. On
 * success the working copy replaces the live state's contents without changing its root identity.
 */
async function executeTool(name, args, campaignState, imageGen = null) {
  return runStateTransaction(
    campaignState,
    (workingState) => executeToolOnWorkingState(name, args, workingState, imageGen)
  );
}

module.exports = { TOOL_SCHEMAS, executeTool };
