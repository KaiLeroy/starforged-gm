import React, { useMemo, useState } from 'react';
import type { MoveSummary } from './types';

export function MovesPanel({ moves, onTrigger, onClose }: { moves: MoveSummary[]; onTrigger: (move: MoveSummary, text: string) => void; onClose: () => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const grouped = useMemo(() => {
    const map = new Map<string, MoveSummary[]>();
    for (const m of moves) {
      if (!map.has(m.category)) map.set(m.category, []);
      map.get(m.category)!.push(m);
    }
    return Array.from(map.entries());
  }, [moves]);

  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  const doIt = (move: MoveSummary) => {
    onTrigger(move, (drafts[move.id] || '').trim());
    setDrafts((d) => ({ ...d, [move.id]: '' }));
    setExpanded(null);
  };

  return (
    <div className="moves-panel">
      <div className="moves-panel-header">
        <span>Moves</span>
        <button className="icon-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="moves-panel-body">
        {moves.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12, padding: '0 4px' }}>Loading move list…</p>}
        {grouped.map(([category, list]) => (
          <div key={category} style={{ marginBottom: 10 }}>
            <div className="moves-category-label">{category}</div>
            {list.map((move) => {
              const isOpen = expanded === move.id;
              return (
                <div key={move.id} className="move-item" style={{ borderLeftColor: move.color || 'var(--border)' }}>
                  <button className="move-item-header" onClick={() => toggle(move.id)}>
                    {move.name}
                  </button>
                  {isOpen && (
                    <div className="move-item-body">
                      <p className="move-trigger-text">{move.triggerText}</p>
                      {move.options.length > 0 && (
                        <ul className="move-options-list">
                          {move.options.map((o, i) => (
                            <li key={i}>{o.text}</li>
                          ))}
                        </ul>
                      )}
                      {move.outcomes && (
                        <div style={{ margin: '8px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {move.outcomes.strongHit && (
                            <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 3, background: 'rgba(90, 168, 122, 0.1)', borderLeft: '2px solid var(--success)' }}>
                              <strong style={{ color: 'var(--success)' }}>Strong hit — </strong>
                              {move.outcomes.strongHit}
                            </div>
                          )}
                          {move.outcomes.weakHit && (
                            <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 3, background: 'rgba(200, 160, 60, 0.1)', borderLeft: '2px solid var(--accent-copper)' }}>
                              <strong style={{ color: 'var(--accent-copper)' }}>Weak hit — </strong>
                              {move.outcomes.weakHit}
                            </div>
                          )}
                          {move.outcomes.miss && (
                            <div style={{ fontSize: 11, padding: '4px 8px', borderRadius: 3, background: 'rgba(197, 83, 63, 0.1)', borderLeft: '2px solid var(--danger)' }}>
                              <strong style={{ color: 'var(--danger)' }}>Miss — </strong>
                              {move.outcomes.miss}
                            </div>
                          )}
                        </div>
                      )}
                      <textarea
                        placeholder="Describe your action (optional) — e.g. how you're approaching it"
                        value={drafts[move.id] || ''}
                        onChange={(e) => setDrafts((d) => ({ ...d, [move.id]: e.target.value }))}
                        rows={2}
                      />
                      <button className="icon-btn" style={{ borderColor: move.color || 'var(--accent-cyan)', color: move.color || 'var(--accent-cyan)', width: '100%' }} onClick={() => doIt(move)}>
                        Make this move
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
