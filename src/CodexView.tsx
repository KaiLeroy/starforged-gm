import React, { useEffect, useMemo, useState } from 'react';
import type { CampaignState } from './types';

const CATEGORY_COLORS: Record<string, string> = {
  People: 'var(--accent-cyan)',
  Factions: 'var(--accent-copper)',
  Locations: 'var(--success)',
  Threads: 'var(--danger)',
  'Items & Vehicles': 'var(--text-dim)',
  Themes: 'var(--accent-cyan)',
  Other: 'var(--text-dim)',
};

function AddEntryForm({ categories, onAdd }: { categories: string[]; onAdd: (category: string, name: string, description: string) => Promise<void> }) {
  const [category, setCategory] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!category && categories.length > 0) setCategory(categories[0]);
  }, [categories]);

  const submit = async () => {
    if (!category || !name.trim() || busy) return;
    setBusy(true);
    try {
      await onAdd(category, name.trim(), description.trim());
      setName('');
      setDescription('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="track-card" style={{ padding: '10px 12px', marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent-copper)', textTransform: 'uppercase', marginBottom: 8 }}>
        Add an entry
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 7px', fontSize: 12, color: 'var(--text)' }}
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name, e.g. Silver Dominion"
          style={{ flex: 1, minWidth: 160, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 7px', fontSize: 12, color: 'var(--text)' }}
        />
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 7px', fontSize: 12, marginBottom: 8, color: 'var(--text)', resize: 'vertical', boxSizing: 'border-box' }}
      />
      <button className="icon-btn" style={{ borderColor: 'var(--accent-copper)', color: 'var(--accent-copper)' }} onClick={submit} disabled={!category || !name.trim() || busy}>
        {busy ? 'Adding…' : 'Add to Codex'}
      </button>
    </div>
  );
}

export function CodexView({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const [categories, setCategories] = useState<string[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    window.game.getCampaignElementCategories().then(setCategories).catch(() => {});
  }, []);

  const add = async (category: string, name: string, description: string) => {
    const next = await window.game.addCampaignElementManual({ campaignId, category, name, description });
    onStateChange(next);
  };

  const remove = async (id: string) => {
    const next = await window.game.removeCampaignElementManual({ campaignId, id });
    onStateChange(next);
  };

  // Grouped by category, in the same order the categories are defined (not alphabetical, so
  // People/Factions/Locations -- the ones a player reaches for most -- lead), and only categories
  // that actually have at least one entry get their own section header, so a fresh campaign
  // doesn't show seven empty headings before anything's been added.
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? state.campaignElements.filter((e) => e.name.toLowerCase().includes(needle) || e.description.toLowerCase().includes(needle) || e.category.toLowerCase().includes(needle))
      : state.campaignElements;
    const order = categories.length > 0 ? categories : Array.from(new Set(matches.map((e) => e.category)));
    return order.map((cat) => ({ category: cat, entries: matches.filter((e) => e.category === cat) })).filter((g) => g.entries.length > 0);
  }, [state.campaignElements, query, categories]);

  return (
    <div style={{ padding: '18px 28px', overflowY: 'auto', height: '100%' }}>
      <p className="panel-title" style={{ fontSize: 12 }}>
        Codex — {state.campaignElements.length} {state.campaignElements.length === 1 ? 'entry' : 'entries'}
      </p>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -4, marginBottom: 16, maxWidth: 640 }}>
        People, factions, locations, and other recurring story ingredients specific to this campaign. The GM can
        roll on these to connect a new, open-ended situation to something already established, rather than
        inventing something wholly new.
      </p>

      <AddEntryForm categories={categories} onAdd={add} />

      {state.campaignElements.length > 0 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the Codex…"
          style={{ width: '100%', maxWidth: 320, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', fontSize: 13, color: 'var(--text)', marginBottom: 16, boxSizing: 'border-box' }}
        />
      )}

      {state.campaignElements.length === 0 && (
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          Nothing in the Codex yet. Add an entry above, or ask the GM to help start one -- early in a campaign, or
          whenever you want more of your own story threads recurring, is a good moment.
        </p>
      )}
      {state.campaignElements.length > 0 && filtered.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>No entries match "{query}".</p>}

      {filtered.map((group) => (
        <div key={group.category} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.04em', color: CATEGORY_COLORS[group.category] || 'var(--text-dim)', marginBottom: 8, borderBottom: `1px solid var(--border)`, paddingBottom: 4 }}>
            {group.category} <span style={{ color: 'var(--text-dim)' }}>({group.entries.length})</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {group.entries.map((e) => (
              <div key={e.id} className="track-card" style={{ padding: '8px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 'bold', fontSize: 13, color: 'var(--text)' }}>{e.name}</div>
                  {e.description && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{e.description}</div>}
                </div>
                <button
                  onClick={() => remove(e.id)}
                  title="Remove from Codex"
                  style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: 0, fontSize: 13, flexShrink: 0 }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
