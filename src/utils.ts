import type { ChatMessage } from './types';

export interface TxEvent {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

export interface DisplayMessage {
  role: 'user' | 'gm';
  content: string;
  events: TxEvent[];
}

/**
 * Walks the raw OpenAI-style message history (user / assistant-with-tool_calls / tool /
 * assistant-with-content) and groups it into what the chat log actually renders: a
 * user bubble, or a GM bubble with the dice/oracle events that produced it attached.
 * Tool calls and their results are paired by order, since the engine always executes
 * and reports them sequentially.
 */
export function parseDisplayMessages(messages: ChatMessage[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  let pending: TxEvent[] = [];
  const openCalls: TxEvent[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content, events: [] });
    } else if (msg.role === 'assistant') {
      const toolCalls = (msg as any).tool_calls as Array<{ function: { name: string; arguments: string } }> | undefined;
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            /* ignore malformed args */
          }
          const ev: TxEvent = { name: tc.function.name, args, result: null };
          pending.push(ev);
          openCalls.push(ev);
        }
      }
      if (msg.content) {
        out.push({ role: 'gm', content: msg.content, events: pending });
        pending = [];
      }
    } else if (msg.role === 'tool') {
      const next = openCalls.shift();
      if (next) {
        try {
          next.result = JSON.parse(msg.content);
        } catch {
          next.result = { raw: msg.content };
        }
      }
    }
  }
  return out;
}

export interface FormattedTx {
  label: string;
  outcome?: string;
  color?: string;
  /** Structured dice for rolls that have them, so the UI can color each die individually. */
  dice?: { actionScore?: number; die1: number; die2: number; beatsC1?: boolean; beatsC2?: boolean; isMatch?: boolean; actionDie?: number; stat?: string; statValue?: number; adds?: number };
  note?: string;
  /** Set when this tool call produced an image, so the chat log can render it inline. */
  imageId?: string;
}

export function formatToolCall(ev: TxEvent): FormattedTx {
  if (ev.name === 'generate_image' && ev.result === null) {
    return { label: 'Generating image… (this can take a minute or more)' };
  }
  if (ev.name === 'present_choice') {
    // No tool_result ever follows this one -- see openrouter.cjs's runTurn, which intercepts it
    // before execution and pauses the turn instead. Build the label from the call's own args,
    // not r (which would just be {} here, unlike every other case in this switch).
    const args: any = ev.args || {};
    const optionCount = Array.isArray(args.options) ? args.options.length : 0;
    return { label: `Choice presented: ${args.prompt || 'a decision'}${optionCount ? ` (${optionCount} options)` : ''}` };
  }
  const r: any = ev.result || {};
  switch (ev.name) {
    case 'check_asset_bonuses': {
      if (r.error) return { label: `Check asset bonuses failed: ${r.error}` };
      const explicit = r.explicit || [];
      const implicit = r.implicit || [];
      const moveName = r.move_name || ev.args?.move_name || 'move';
      const total = explicit.length + implicit.length;
      if (total === 0) return { label: `Asset bonuses checked for ${moveName}: none apply` };
      const names = [...explicit, ...implicit].map((e: any) => e.asset).join(', ');
      return { label: `Asset bonuses for ${moveName}: ${names}` };
    }
    case 'roll_action_move': {
      const move = r.move || {};
      const outcome = (r.outcome || '').replace('_', ' ');
      const [d1, d2] = r.challengeDice || [];
      return {
        label: `${move.name || 'Move'}`,
        outcome,
        color: move.color,
        dice: {
          actionScore: r.actionScore,
          die1: d1,
          die2: d2,
          beatsC1: r.beatsC1,
          beatsC2: r.beatsC2,
          isMatch: r.is_match,
          actionDie: r.actionDie,
          stat: r.stat,
          statValue: r.statValue,
          adds: r.adds,
        },
        note: r.negativeMomentumApplied ? 'negative momentum zeroed the action die' : undefined,
      };
    }
    case 'roll_progress_move': {
      const outcome = (r.outcome || '').replace('_', ' ');
      const [d1, d2] = r.challengeDice || [];
      return {
        label: `Progress roll — ${r.track_name || ''}`,
        outcome,
        dice: { actionScore: r.progressScore, die1: d1, die2: d2, beatsC1: r.beatsC1, beatsC2: r.beatsC2, isMatch: r.is_match },
      };
    }
    case 'roll_oracle': {
      const oracle = r.oracle || {};
      return { label: `Oracle: ${oracle.name || ev.args.oracle_name} → ${r.result ?? '—'} (${r.roll ?? '?'})` };
    }
    case 'roll_severe_harm_table': {
      if (r.error) return { label: `Severe harm roll failed: ${r.error}` };
      return { label: `${ev.args.kind === 'spirit' ? 'Endure Stress' : 'Endure Harm'} severe roll (${r.roll}) → ${r.result}` };
    }
    case 'add_connection': {
      return r.error ? { label: `Add connection failed: ${r.error}` } : { label: `Connection added: ${r.name}` };
    }
    case 'add_location_feature': {
      if (r.error) return { label: `Add feature failed: ${r.error}` };
      return { label: `${r.feature?.name} (${r.feature?.type}) added to hex ${r.cell}` };
    }
    case 'add_log_entry': {
      return { label: `Log: ${r.text ?? ev.args.text}` };
    }
    case 'create_custom_asset': {
      if (r.error) return { label: `Create asset failed: ${r.error}` };
      return { label: `Custom asset created: ${r.asset?.Name} (${r.asset?.['Asset Type']})` };
    }
    case 'create_sector': {
      if (r.error) return { label: `Create sector failed: ${r.error}` };
      return { label: `Sector created: ${r.name || 'unnamed'} (${r.region || 'region unset'})` };
    }
    case 'reveal_location': {
      if (r.error) return { label: `Reveal location failed: ${r.error}` };
      return { label: `Location revealed: ${r.name || 'unnamed'} (hex ${r.cell})` };
    }
    case 'roll_setting_truth': {
      if (r.error) return { label: `Roll truth failed: ${r.error}` };
      const sub = r.subtableResult ? ` — ${r.subtableResult}` : '';
      return { label: `Truth rolled: ${r.category} (${r.roll}) → ${r.result}${sub}` };
    }
    case 'set_current_location': {
      return r.error ? { label: `Set location failed: ${r.error}` } : { label: `Now at hex ${r.current_cell}` };
    }
    case 'create_passage': {
      if (r.error) return { label: `Chart passage failed: ${r.error}` };
      const dest = r.toCell ? `hex ${r.toCell}` : 'the sector edge';
      return { label: `Passage charted: ${r.fromCell} → ${dest}` };
    }
    case 'remove_passage': {
      return r.error ? { label: `Remove passage failed: ${r.error}` } : { label: `Passage removed` };
    }
    case 'set_sector_info': {
      if (r.error) return { label: `Set sector info failed: ${r.error}` };
      return { label: `Sector updated: ${r.name || 'unnamed'} (${r.region || 'region unset'})` };
    }
    case 'set_setting_truth': {
      if (r.error) return { label: `Set truth failed: ${r.error}` };
      return { label: `Truth set: ${r.category} → ${r.result}` };
    }
    case 'switch_sector': {
      return r.error ? { label: `Switch sector failed: ${r.error}` } : { label: `Switched to sector ${r.current_sector_id}` };
    }
    case 'roll_vehicle_destruction_table': {
      return { label: `Withstand Damage severe roll (${r.roll}) → ${r.result}` };
    }
    case 'remove_progress_track': {
      return r.error ? { label: `Remove track failed: ${r.error}` } : { label: `Track cleared: ${r.name}` };
    }
    case 'remove_connection': {
      return r.error ? { label: `Remove connection failed: ${r.error}` } : { label: `Connection lost` };
    }
    case 'set_connection_role': {
      return r.error ? { label: `Set role failed: ${r.error}` } : { label: `Connection role set: ${r.role}` };
    }
    case 'set_connection_location': {
      return r.error ? { label: `Set location failed: ${r.error}` } : { label: `Connection location set: ${r.location}` };
    }
    case 'bolster_connection_role': {
      return r.error ? { label: `Bolster failed: ${r.error}` } : { label: `Role bolstered → +${r.roleBonus}` };
    }
    case 'expand_connection_role': {
      return r.error ? { label: `Expand failed: ${r.error}` } : { label: `Role expanded: ${r.role} + ${r.secondRole}` };
    }
    case 'suspend_connection_benefits': {
      return r.error ? { label: `Suspend failed: ${r.error}` } : { label: `Connection benefits suspended` };
    }
    case 'restore_connection_benefits': {
      return r.error ? { label: `Restore failed: ${r.error}` } : { label: `Connection benefits restored` };
    }
    case 'ask_the_oracle': {
      return { label: `Ask the Oracle (${r.odds}) → ${r.answer ?? '?'} (${r.roll ?? '?'})` };
    }
    case 'update_meter': {
      let label = `${r.meter} → ${r.new_value}`;
      if (r.momentum_overflow) label += ` (momentum overflow: -${r.momentum_overflow})`;
      if (r.unresolved_overflow) label += ` ⚠ ${r.unresolved_overflow} unresolved -- GM applies elsewhere`;
      return { label };
    }
    case 'mark_progress_track': {
      return { label: `Progress marked → ${r.boxes ?? '?'}/10 boxes` };
    }
    case 'create_progress_track': {
      return { label: `New track created: ${ev.args.name}` };
    }
    case 'burn_momentum': {
      if (r.error) return { label: `Burn momentum refused: ${r.error}` };
      const newOutcome = r.new_outcome;
      if (newOutcome) {
        const outcome = (newOutcome.outcome || '').replace('_', ' ');
        return {
          label: `Burned momentum (${r.burned} → ${r.resetTo}) — new score ${newOutcome.new_action_score} vs ${newOutcome.challenge_dice?.join(', ')}`,
          outcome,
        };
      }
      return { label: `Burned momentum (${r.burned} → ${r.resetTo})` };
    }
    case 'reroll_action_die': {
      return { label: `Rerolled action die → ${r.die}` };
    }
    case 'roll_extra_challenge_die': {
      return { label: `Extra challenge die → ${r.die}` };
    }
    case 'roll_bonus_challenge_dice': {
      if (r.error) return { label: `Bonus dice roll failed: ${r.error}` };
      const extra = (r.extra_dice || []).join(', ');
      if (r.forced_match) {
        const outcome = (r.outcome || '').replace('_', ' ');
        return {
          label: `Bonus dice (+${extra}) — forced match on ${r.dice_used?.join(', ')}`,
          outcome,
        };
      }
      const pairingCount = Array.isArray(r.possible_pairings) ? r.possible_pairings.length : 0;
      return { label: `Bonus dice (+${extra}) — no match, ${pairingCount} pairings to choose from` };
    }
    case 'reroll_challenge_dice': {
      return { label: `Rerolled challenge dice → ${r.challenge_dice?.join(', ')}` };
    }
    case 'resolve_action_with_dice': {
      if (r.error) return { label: `Resolve with dice failed: ${r.error}` };
      const outcome = (r.outcome || '').replace('_', ' ');
      return {
        label: `Resolved with chosen dice`,
        outcome,
        dice: { actionScore: r.action_score, die1: r.challenge_dice?.[0], die2: r.challenge_dice?.[1], beatsC1: r.beatsC1, beatsC2: r.beatsC2, isMatch: r.is_match },
      };
    }
    case 'adjust_asset_resource': {
      if (r.error) return { label: `Asset resource adjustment failed: ${r.error}` };
      const res = r.resource || {};
      return { label: `${res.label || 'Resource'} → ${res.current}/${res.max}` };
    }
    case 'set_asset_resource': {
      if (r.error) return { label: `Asset resource set failed: ${r.error}` };
      const res = r.resource || {};
      return { label: `${res.label || 'Resource'} set → ${res.current}/${res.max}` };
    }
    case 'toggle_impact': {
      return { label: `${r.marked ? 'Marked' : 'Cleared'} impact: ${ev.args.name}` };
    }
    case 'earn_experience': {
      return { label: `+${r.earned} experience (${r.reason ?? ev.args.reason}) → ${r.total_available} available` };
    }
    case 'buy_asset': {
      return r.error ? { label: `Buy asset failed: ${r.error}` } : { label: `New asset: ${r.asset?.name ?? ev.args.asset_name} (${r.experience_remaining} XP left)` };
    }
    case 'grant_asset': {
      return r.error ? { label: `Grant asset failed: ${r.error}` } : { label: `Asset granted: ${r.asset?.name ?? ev.args.asset_name} (no XP cost)` };
    }
    case 'upgrade_asset': {
      return r.error
        ? { label: `Upgrade failed: ${r.error}` }
        : { label: `${ev.args.asset_name} ability ${r.ability_number} unlocked (${r.experience_remaining} XP left)` };
    }
    case 'lookup_move': {
      return { label: `Checked move: ${ev.args.move_name}` };
    }
    case 'generate_image': {
      if (r.error) return { label: `Image generation failed: ${r.error}` };
      const targetLabel = { portrait: 'Portrait', location: 'Location image', connection: 'Portrait', illustration: 'Illustration' }[r.target as string] || 'Image';
      return { label: `${targetLabel} generated`, imageId: r.imageId };
    }
    case 'companion_takes_a_hit': {
      if (r.error) return { label: `Companion hit failed: ${r.error}` };
      let label = `${r.name} takes a hit → health ${r.health}/${r.maxHealth ?? 5}${r.outOfAction ? ' (out of action)' : ''}`;
      if (r.momentumOverflow) label += ` (momentum overflow: -${r.momentumOverflow})`;
      if (r.unresolvedOverflow) label += ` ⚠ ${r.unresolvedOverflow} unresolved`;
      return { label };
    }
    case 'heal_companion': {
      if (r.error) return { label: `Heal companion failed: ${r.error}` };
      return { label: `${r.name} healed +${r.healed} → health ${r.health}/${r.maxHealth ?? 5}` };
    }
    case 'set_asset_broken': {
      if (r.error) return { label: `Set asset broken failed: ${r.error}` };
      return { label: `${r.name} ${r.broken ? 'marked broken' : 'repaired'}` };
    }
    case 'set_aboard_vehicle': {
      if (r.error) return { label: `Set aboard vehicle failed: ${r.error}` };
      return { label: r.aboard_vehicle_id ? `Now aboard vehicle` : `Disembarked` };
    }
    case 'set_vehicle_condition': {
      if (r.error) return { label: `Set vehicle condition failed: ${r.error}` };
      return { label: `${r.name}: battered ${r.battered ? 'yes' : 'no'}, cursed ${r.cursed ? 'yes' : 'no'}` };
    }
    case 'set_combat_position': {
      return { label: `Combat position: ${r.combat_position || 'not in a fight'}` };
    }
    case 'set_combat_range': {
      return { label: `Combat range: ${r.combat_range || 'not in a fight'}` };
    }
    case 'discard_asset': {
      return r.error ? { label: `Discard failed: ${r.error}` } : { label: `Discarded: ${r.removed}` };
    }
    case 'begin_scene_challenge': {
      return r.error ? { label: `Begin Scene failed: ${r.error}` } : { label: `Scene Challenge begun: ${r.track?.name} (${r.track?.rank}), tension clock ${r.clock?.segments} segments` };
    }
    case 'create_clock': {
      return r.error ? { label: `Create clock failed: ${r.error}` } : { label: `Clock created: ${r.name} (${r.type}, ${r.segments} segments)` };
    }
    case 'advance_clock': {
      return r.error ? { label: `Advance clock failed: ${r.error}` } : { label: `Clock advanced → ${r.filled}/${r.segments}${r.completed ? ' (complete!)' : ''}` };
    }
    case 'stop_clock': {
      return r.error ? { label: `Stop clock failed: ${r.error}` } : { label: `Clock stopped` };
    }
    case 'apply_legacy_reward': {
      return r.error ? { label: `Legacy reward failed: ${r.error}` } : { label: `Legacy reward: +${r.ticksAwarded} ticks on ${r.trackId}${r.experienceEarned ? ` (+${r.experienceEarned} XP)` : ''}` };
    }
    case 'recommit_progress_track': {
      return r.error ? { label: `Recommit failed: ${r.error}` } : { label: `Recommitted: cleared ${r.clearedTicks} ticks, rank → ${r.newRank}` };
    }
    case 'set_track_rank': {
      return r.error ? { label: `Set rank failed: ${r.error}` } : { label: `Rank set: ${r.oldRank} → ${r.newRank} (${r.name}, progress untouched)` };
    }
    case 'set_connection_rank': {
      return r.error ? { label: `Set rank failed: ${r.error}` } : { label: `Connection rank set: ${r.rank}` };
    }
    case 'mark_connection_progress': {
      return r.error ? { label: `Mark connection progress failed: ${r.error}` } : { label: `Connection progress → ${r.boxes}/10 boxes` };
    }
    case 'roll_connection_progress': {
      if (r.error) return { label: `Connection roll failed: ${r.error}` };
      const outcome = (r.outcome || '').replace('_', ' ');
      return { label: `Forge a Bond roll (${r.connection_name})`, outcome, dice: { actionScore: r.progressScore, die1: r.challengeDice?.[0], die2: r.challengeDice?.[1], beatsC1: r.beatsC1, beatsC2: r.beatsC2, isMatch: r.is_match } };
    }
    case 'apply_bond_reward': {
      return r.error ? { label: `Bond reward failed: ${r.error}` } : { label: `Bond reward: +${r.ticksAwarded} ticks on bonds legacy${r.experienceEarned ? ` (+${r.experienceEarned} XP)` : ''}` };
    }
    case 'recommit_after_failed_bond': {
      return r.error ? { label: `Recommit failed: ${r.error}` } : { label: `Recommitted: cleared ${r.clearedTicks} ticks, connection rank → ${r.newRank}` };
    }
    case 'raise_connection_rank': {
      return r.error ? { label: `Raise rank failed: ${r.error}` } : { label: `Connection rank raised → ${r.rank}` };
    }
    case 'mark_legacy_ticks': {
      return r.error ? { label: `Mark legacy ticks failed: ${r.error}` } : { label: `Legacy track +${ev.args.ticks} ticks${r.experienceEarned ? ` (+${r.experienceEarned} XP)` : ''}` };
    }
    case 'adjust_progress_ticks': {
      if (r.error) return { label: `Adjust progress ticks failed: ${r.error}` };
      const delta = Number(ev.args.delta) || 0;
      return { label: `Track ${delta >= 0 ? '+' : ''}${delta} ticks → ${r.ticks} (${r.boxes} boxes)` };
    }
    case 'add_other_impact': {
      return r.error ? { label: `Add impact failed: ${r.error}` } : { label: `Other Impact added: ${r.name}` };
    }
    case 'remove_other_impact': {
      return r.error ? { label: `Remove impact failed: ${r.error}` } : { label: `Other Impact cleared: ${r.removed}` };
    }
    case 'add_flag': {
      return r.error ? { label: `Add flag failed: ${r.error}` } : { label: `Content flag set: ${ev.args.text}` };
    }
    case 'remove_flag': {
      return r.error ? { label: `Remove flag failed: ${r.error}` } : { label: `Content flag cleared: ${ev.args.text}` };
    }
    case 'add_campaign_element': {
      return r.error ? { label: `Add campaign element failed: ${r.error}` } : { label: `Campaign element added: ${r.text}` };
    }
    case 'remove_campaign_element': {
      return r.error ? { label: `Remove campaign element failed: ${r.error}` } : { label: `Campaign element removed` };
    }
    case 'roll_campaign_element': {
      return r.error ? { label: `Roll campaign element failed: ${r.error}` } : { label: `Campaign element: ${r.text}` };
    }
    default:
      return { label: `${ev.name}` };
  }
}
