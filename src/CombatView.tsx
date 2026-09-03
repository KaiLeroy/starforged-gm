import React from 'react';
import type { CampaignState } from './types';

export function CombatView({ state }: { state: CampaignState }) {
  const { combatPosition, combatRange } = state.character;
  const inFight = combatPosition !== null || combatRange !== null;
  const combatTracks = state.progressTracks.filter((t) => t.type === 'combat');

  return (
    <div style={{ padding: '18px 28px', overflowY: 'auto', height: '100%' }}>
      <p className="panel-title" style={{ fontSize: 12 }}>
        Combat {inFight ? '— in a fight' : '— not currently in a fight'}
      </p>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -4, marginBottom: 16, maxWidth: 640 }}>
        Position and range decide which combat moves are actually legal to make right now, and
        this is the one piece of fight state with no other display in the app -- easy to lose
        track of scrolling back through the chat log. Set by the GM from how rolls actually go --
        not something to change directly here.
      </p>

      <div className="track-card" style={{ padding: '10px 12px', marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent-copper)', textTransform: 'uppercase', marginBottom: 6 }}>
          Position
        </div>
        <div style={{ padding: '4px 6px', borderRadius: 4, background: 'var(--bg-raised)', border: '1px solid var(--border)', fontSize: 13, display: 'inline-block' }}>
          {combatPosition === 'in_control' ? 'In control' : combatPosition === 'bad_spot' ? 'In a bad spot' : 'Not in a fight'}
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8, marginBottom: 0 }}>
          {combatPosition === 'in_control' && 'Gain Ground and Strike are available. React Under Fire and Clash are not.'}
          {combatPosition === 'bad_spot' && 'React Under Fire and Clash are available. Gain Ground and Strike are not. Take Decisive Action gets a downgrade: a strong hit becomes a weak hit and a weak hit becomes a miss, unless the strong hit has a match.'}
          {combatPosition === null && 'A fight starts with Enter the Fray, which sets this automatically based on the roll.'}
        </p>
      </div>

      <div className="track-card" style={{ padding: '10px 12px', marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent-copper)', textTransform: 'uppercase', marginBottom: 6 }}>
          Range
        </div>
        <div style={{ padding: '4px 6px', borderRadius: 4, background: 'var(--bg-raised)', border: '1px solid var(--border)', fontSize: 13, display: 'inline-block' }}>
          {combatRange === 'close' ? 'Close (+iron)' : combatRange === 'distance' ? 'Distance (+edge)' : 'Not set'}
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8, marginBottom: 0 }}>
          {combatRange === 'close' && 'Strike and Clash roll +iron.'}
          {combatRange === 'distance' && 'Strike and Clash roll +edge.'}
          {combatRange === null && 'Determines the stat for Strike and Clash once combat starts -- +iron close, +edge at distance.'}
        </p>
      </div>

      <p className="panel-title" style={{ fontSize: 12 }}>
        Active objectives
      </p>
      {combatTracks.length === 0 && (
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          No active combat objectives. Enter the Fray creates one when a fight begins -- a complex
          encounter can have more than one running at once.
        </p>
      )}
      {combatTracks.map((t) => {
        const clampedTicks = Math.min(40, Math.max(0, t.ticks));
        return (
          <div className="track-card" key={t.id} style={{ marginBottom: 8 }}>
            <div className="track-name">{t.name}</div>
            <div className="track-meta">
              {t.rank} · {Math.floor(clampedTicks / 4)}/10
            </div>
            <div className="track-boxes">
              {Array.from({ length: 10 }).map((_, i) => {
                const ticksInBox = Math.max(0, Math.min(4, clampedTicks - i * 4));
                return (
                  <div key={i} className="track-box">
                    <div className="track-box-fill" style={{ width: `${(ticksInBox / 4) * 100}%` }} />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
