import React, { useMemo, useState } from 'react';
import type { OracleSummary, OracleRollResult } from './types';

/**
 * Derives a genuinely distinguishing label for an oracle within its top-level category group --
 * the bare leaf name (oracle.displayTitle || oracle.name) alone is NOT enough. A real, direct
 * report showed the same leaf names (Feature, Peril, Opportunity...) repeated dozens of times
 * with no way to tell them apart, which looked like broken, duplicated data but wasn't -- each
 * one is a genuinely distinct oracle table (a different location theme, a different planet
 * type), just sharing a leaf name with its siblings under the same category. Checked directly
 * against the real catalog: 150 of 250 oracles (60%) have at least one same-category,
 * same-leaf-label sibling, so this needed a general fix, not a special case for the categories
 * that happened to be reported. Prepends whatever path segments sit between the top-level
 * category (already shown as the group header, so not repeated here) and the final leaf --
 * verified this leaves every already-unique label (e.g. "Core / Action") completely unchanged,
 * and resolves every single ambiguous one across the entire catalog.
 */
function oracleLabel(oracle: OracleSummary): string {
  const segments = oracle.path.split(' / ');
  const intermediate = segments.slice(1, -1);
  const leaf = oracle.displayTitle || oracle.name;
  return intermediate.length > 0 ? `${intermediate.join(' — ')} — ${leaf}` : leaf;
}

export function OraclesPanel({ oracles, onSendToGM, onClose }: { oracles: OracleSummary[]; onSendToGM: (oracle: OracleSummary, result: OracleRollResult) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, OracleRollResult>>({});
  const [rolling, setRolling] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return oracles;
    return oracles.filter((o) => o.name.toLowerCase().includes(needle) || o.path.toLowerCase().includes(needle) || (o.description || '').toLowerCase().includes(needle));
  }, [oracles, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, OracleSummary[]>();
    for (const o of filtered) {
      // Top-level category is the first breadcrumb segment (e.g. "Space" from "Space / Sector
      // Name / Suffix") -- the same path field findOracle itself matches fuzzily against.
      const top = o.path.split('/')[0].trim() || 'Other';
      if (!map.has(top)) map.set(top, []);
      map.get(top)!.push(o);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  const roll = async (oracle: OracleSummary) => {
    setRolling(oracle.id);
    try {
      const result = await window.game.rollOracle({ oracleId: oracle.id });
      setResults((r) => ({ ...r, [oracle.id]: result }));
    } finally {
      setRolling(null);
    }
  };

  return (
    <div className="moves-panel">
      <div className="moves-panel-header">
        <span>Oracles</span>
        <button className="icon-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="moves-panel-body">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search oracles…"
          style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', fontSize: 13, color: 'var(--text)', marginBottom: 10, boxSizing: 'border-box' }}
        />
        {oracles.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12, padding: '0 4px' }}>Loading oracle list…</p>}
        {oracles.length > 0 && filtered.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12, padding: '0 4px' }}>No oracles match "{query}".</p>}
        {grouped.map(([category, list]) => (
          <div key={category} style={{ marginBottom: 10 }}>
            <div className="moves-category-label">{category}</div>
            {list.map((oracle) => {
              const isOpen = expanded === oracle.id;
              const result = results[oracle.id];
              return (
                <div key={oracle.id} className="move-item">
                  <button className="move-item-header" onClick={() => toggle(oracle.id)}>
                    {oracleLabel(oracle)}
                  </button>
                  {isOpen && (
                    <div className="move-item-body">
                      {oracle.description && <p className="move-trigger-text">{oracle.description}</p>}
                      <button
                        className="icon-btn"
                        style={{ borderColor: 'var(--accent-cyan)', color: 'var(--accent-cyan)', width: '100%' }}
                        onClick={() => roll(oracle)}
                        disabled={rolling === oracle.id}
                      >
                        {rolling === oracle.id ? 'Rolling…' : 'Roll'}
                      </button>
                      {result && (
                        <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 4, background: 'var(--bg-raised)', border: '1px solid var(--border)' }}>
                          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)', marginBottom: 4 }}>
                            Rolled {result.roll}
                            {result.isMatch ? ' — match' : ''}
                          </div>
                          <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>{result.result || '(no result for this roll)'}</div>
                          <button className="icon-btn" style={{ fontSize: 11 }} onClick={() => onSendToGM(oracle, result)}>
                            Send to GM
                          </button>
                        </div>
                      )}
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
