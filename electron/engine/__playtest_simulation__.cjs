'use strict';
const state = require('./state.cjs');
const data = require('./data.cjs');
const { executeTool } = require('./tools.cjs');

let n = 0;
function log(label, result) {
  n++;
  console.log(`\n[${n}] ${label}`);
  console.log(JSON.stringify(result, null, 2));
}
function section(title) {
  console.log(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`);
}

section('CHARACTER CREATION');
const cs = state.newCampaignState();
cs.character.name = 'Kess Vantar';
Object.assign(cs.character.stats, { edge: 2, heart: 1, iron: 3, shadow: 1, wits: 2 });
const starship = data.findAsset('Starship');
state.addAsset(cs, { id: starship.$id, name: starship.Name, category: 'Command Vehicle' });
for (const name of ['Bounty Hunter', 'Empath', 'Devotant']) {
  const a = data.findAsset(name);
  state.addAsset(cs, { id: a.$id, name: a.Name, category: (a['Asset Type'] || '').split('/').pop() });
}
console.log('Character:', cs.character.name, cs.character.stats, 'assets:', cs.character.assets.map((a) => a.name));

section('SESSION ZERO: setting truths, connections, log');
log('roll_setting_truth Cataclysm', executeTool('roll_setting_truth', { category: 'Cataclysm' }, cs));
log('roll_setting_truth Exodus', executeTool('roll_setting_truth', { category: 'Exodus' }, cs));
log('add_connection', executeTool('add_connection', { name: 'Rin Okafor', notes: 'Old mentor, runs a salvage yard on the station.' }, cs));
log('add_log_entry', executeTool('add_log_entry', { text: 'Campaign begins at Larissa Station.' }, cs));

section('SECTOR SETUP (per the campaign-start procedure)');
const prefix = executeTool('roll_oracle', { oracle_name: 'Sector Name Prefix' }, cs);
const suffix = executeTool('roll_oracle', { oracle_name: 'Sector Name Suffix' }, cs);
log('roll_oracle Sector Name Prefix/Suffix', { prefix: prefix.result, suffix: suffix.result });
const trouble = executeTool('roll_oracle', { oracle_name: 'Sector Trouble' }, cs);
log('roll_oracle Sector Trouble', trouble);
log('set_sector_info', executeTool('set_sector_info', { name: `${prefix.result} ${suffix.result}`, region: 'Terminus', notes: trouble.result }, cs));
const startSettlement = executeTool('roll_oracle', { oracle_name: 'Settlements Name' }, cs);
log('roll_oracle Settlements Name', startSettlement);
log('reveal_location', executeTool('reveal_location', { cell: '5,4', name: `${startSettlement.result} Station` }, cs));
log('add_location_feature', executeTool('add_location_feature', { cell: '5,4', type: 'settlement', name: `${startSettlement.result} Station`, description: 'Starting point.' }, cs));
log('set_current_location', executeTool('set_current_location', { cell: '5,4' }, cs));

section('VOW: swear an iron vow, then work toward it');
log('create_progress_track (vow)', executeTool('create_progress_track', { id: 'vow-find-the-signal', name: 'Find the source of the signal', type: 'vow', rank: 'dangerous' }, cs));

section('ACTION ROLL: Face Danger (sneaking past a patrol), using Shadow');
const faceDanger = executeTool('roll_action_move', { move_name: 'Face Danger', stat: 'shadow', stat_value: cs.character.stats.shadow }, cs);
log('roll_action_move', faceDanger);

if (faceDanger.outcome === 'miss' || faceDanger.outcome === 'weak_hit') {
  section('MOMENTUM CHECK before Pay the Price / Suffer');
  console.log('Current momentum:', cs.character.meters.momentum, 'vs action score', faceDanger.actionScore, 'challenge dice', faceDanger.challengeDice);
  if (cs.character.meters.momentum > faceDanger.actionScore) {
    const burn = executeTool('burn_momentum', { challenge_dice: faceDanger.challengeDice }, cs);
    log('burn_momentum', burn);
  } else {
    console.log('Momentum not high enough to help -- proceeding with the original outcome.');
  }
}

section('ORACLE: Pay the Price (on a miss)');
const price = executeTool('roll_oracle', { oracle_name: 'Pay the Price' }, cs);
log('roll_oracle Pay the Price', price);

section('SUFFER: took a hit, mark harm, maybe an impact');
log('update_meter health -1', executeTool('update_meter', { meter: 'health', delta: -2 }, cs));
log('toggle_impact Wounded', executeTool('toggle_impact', { category: 'Misfortunes', name: 'Wounded' }, cs));
console.log('Momentum max/reset after impact:', cs.character.meters.momentum_max, cs.character.meters.momentum_reset);

section('COMBAT: Enter the Fray, then Strike, then End the Fight');
log('create_progress_track (combat)', executeTool('create_progress_track', { id: 'combat-patrol', name: 'Skirmish with the patrol', type: 'combat', rank: 'dangerous' }, cs));
const enterFray = executeTool('roll_action_move', { move_name: 'Enter the Fray', stat: 'edge', stat_value: cs.character.stats.edge }, cs);
log('roll_action_move Enter the Fray', enterFray);
const strike = executeTool('roll_action_move', { move_name: 'Strike', stat: 'iron', stat_value: cs.character.stats.iron }, cs);
log('roll_action_move Strike', strike);
if (strike.outcome !== 'miss') {
  log('mark_progress_track combat', executeTool('mark_progress_track', { track_id: 'combat-patrol', rank: 'dangerous' }, cs));
}
const endFight = executeTool('roll_progress_move', { track_id: 'combat-patrol' }, cs);
log('roll_progress_move End the Fight', endFight);

section('ORACLE-DRIVEN EXPLORATION: travel and discover a derelict');
log('set_current_location 6,4', executeTool('set_current_location', { cell: '6,4' }, cs));
const derelictType = executeTool('roll_oracle', { oracle_name: 'Derelicts Type Deep Space' }, cs);
log('roll_oracle Derelict Type', derelictType);
const derelictCondition = executeTool('roll_oracle', { oracle_name: 'Derelicts Condition' }, cs);
log('roll_oracle Derelict Condition', derelictCondition);
log('reveal_location 6,4', executeTool('reveal_location', { cell: '6,4', name: 'Drifting hulk' }, cs));
log('add_location_feature derelict', executeTool('add_location_feature', { cell: '6,4', type: 'derelict', name: derelictType.result || 'Unknown derelict', description: derelictCondition.result || '' }, cs));

section('VOW PROGRESS AND FULFILLMENT');
log('mark_progress_track vow', executeTool('mark_progress_track', { track_id: 'vow-find-the-signal', rank: 'dangerous' }, cs));
log('mark_progress_track vow again', executeTool('mark_progress_track', { track_id: 'vow-find-the-signal', rank: 'dangerous' }, cs));
const fulfillRoll = executeTool('roll_progress_move', { track_id: 'vow-find-the-signal' }, cs);
log('roll_progress_move Fulfill Your Vow', fulfillRoll);
if (fulfillRoll.outcome !== 'miss') {
  log('mark_progress_track legacy-quests', executeTool('mark_progress_track', { track_id: 'legacy-quests', rank: 'dangerous' }, cs));
  const legacyBoxes = state.progressBoxes(cs.progressTracks.find((t) => t.id === 'legacy-quests').ticks);
  const xp = executeTool('earn_experience', { amount: legacyBoxes, reason: 'Fulfilled vow: Find the source of the signal' }, cs);
  log('earn_experience', xp);
}

section('ADVANCEMENT: spend experience');
console.log('Experience available:', state.availableExperience(cs));
if (state.availableExperience(cs) >= state.ASSET_PURCHASE_COST) {
  log('buy_asset', executeTool('buy_asset', { asset_name: 'Explorer' }, cs));
} else {
  log('upgrade_asset attempt with insufficient XP', executeTool('upgrade_asset', { asset_name: 'Bounty Hunter', ability_number: 2 }, cs));
}

section('EDGE CASES');
log('create_progress_track with reserved legacy id (should error)', executeTool('create_progress_track', { id: 'legacy-quests', name: 'dupe', type: 'vow', rank: 'formidable' }, cs));
log('roll_action_move with unknown move (should error)', executeTool('roll_action_move', { move_name: 'Do A Barrel Roll', stat: 'edge', stat_value: 2 }, cs));
log('reveal_location out of bounds (should error)', executeTool('reveal_location', { cell: '99,99', name: 'x' }, cs));
log('toggle_impact unknown name (should error)', executeTool('toggle_impact', { category: 'Misfortunes', name: 'Cursed' }, cs)); // Cursed lives on a vehicle asset now (set_vehicle_condition), not any impacts category
log('update_meter on unknown meter (should error)', executeTool('update_meter', { meter: 'luck', delta: 1 }, cs));
log('roll_progress_move on nonexistent track (should error)', executeTool('roll_progress_move', { track_id: 'nope' }, cs));

section('FINAL STATE DUMP');
console.log(JSON.stringify(cs, null, 2));
