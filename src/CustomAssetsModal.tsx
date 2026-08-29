import React, { useEffect, useState } from 'react';
import type { CustomAsset } from './types';

const CATEGORIES = ['Path', 'Companion', 'Deed', 'Command Vehicle', 'Module', 'Support Vehicle'];

function emptyForm() {
  return { name: '', category: 'Path', abilities: ['', '', ''], requirement: '', color: '#8e97ac' };
}

export function CustomAssetsModal({ onClose }: { onClose: () => void }) {
  const [assets, setAssets] = useState<CustomAsset[]>([]);
  const [form, setForm] = useState(emptyForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => window.game.getCustomAssets().then(setAssets);
  useEffect(() => {
    refresh();
  }, []);

  const startEdit = (a: CustomAsset) => {
    setEditingId(a.$id);
    setForm({
      name: a.Name,
      category: a['Asset Type'],
      abilities: [0, 1, 2].map((i) => a.Abilities[i]?.Text || ''),
      requirement: a.Requirement || '',
      color: a.Display.Color,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm());
    setError(null);
  };

  const submit = async () => {
    setError(null);
    const abilities = form.abilities.map((a) => a.trim()).filter(Boolean);
    if (!form.name.trim() || abilities.length === 0) {
      setError('Needs a name and at least one ability.');
      return;
    }
    try {
      if (editingId) {
        await window.game.updateCustomAsset({ id: editingId, name: form.name.trim(), abilities, requirement: form.requirement.trim(), color: form.color });
      } else {
        await window.game.createCustomAsset({ name: form.name.trim(), category: form.category, abilities, requirement: form.requirement.trim() || undefined, color: form.color });
      }
      await refresh();
      cancelEdit();
    } catch (e: any) {
      setError(e?.message || 'Something went wrong.');
    }
  };

  const remove = async (id: string) => {
    await window.game.deleteCustomAsset({ id });
    await refresh();
    if (editingId === id) cancelEdit();
  };

  const setAbility = (i: number, value: string) => {
    setForm((f) => {
      const abilities = [...f.abilities];
      abilities[i] = value;
      return { ...f, abilities };
    });
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 560, maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}>
        <h2>Custom Assets</h2>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -8, marginBottom: 12 }}>
          Your homebrew asset library — available across every campaign, at character creation and via the Advance
          move in play.
        </p>

        <div style={{ overflowY: 'auto', flex: 1, marginBottom: 12 }}>
          {assets.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>None yet — create one below.</p>}
          {assets.map((a) => (
            <div key={a.$id} className="track-card" style={{ borderLeft: `3px solid ${a.Display.Color}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontWeight: 'bold', fontSize: 13 }}>{a.Name}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="icon-btn" style={{ fontSize: 9, padding: '1px 6px' }} onClick={() => startEdit(a)}>
                    Edit
                  </button>
                  <button className="icon-btn" style={{ fontSize: 9, padding: '1px 6px' }} onClick={() => remove(a.$id)}>
                    Delete
                  </button>
                </div>
              </div>
              <div className="track-meta">{a['Asset Type']}{a.Requirement ? ` · requires: ${a.Requirement}` : ''}</div>
              {a.Abilities.map((ab, i) => (
                <div key={i} style={{ fontSize: 12, marginTop: 4, color: ab.Enabled ? 'var(--text)' : 'var(--text-dim)' }}>
                  [{i + 1}] {ab.Text}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <p style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)', textTransform: 'uppercase', marginBottom: 8 }}>
            {editingId ? 'Edit asset' : 'Create a new asset'}
          </p>
          <div className="field">
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Name" />
          </div>
          {!editingId && (
            <div className="field">
              <select
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12 }}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          )}
          {[0, 1, 2].map((i) => (
            <div className="field" key={i}>
              <label>Ability {i + 1}{i === 0 ? ' (unlocks immediately)' : ' (optional, unlocked via Advance)'}</label>
              <input value={form.abilities[i]} onChange={(e) => setAbility(i, e.target.value)} placeholder={i === 0 ? 'Required' : 'Optional'} />
            </div>
          ))}
          <div className="field">
            <label>Requirement (optional)</label>
            <input value={form.requirement} onChange={(e) => setForm((f) => ({ ...f, requirement: e.target.value }))} />
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</p>}
          <div className="modal-actions">
            {editingId && (
              <button className="icon-btn" onClick={cancelEdit}>
                Cancel edit
              </button>
            )}
            <button className="icon-btn" style={{ borderColor: 'var(--accent-copper)', color: 'var(--accent-copper)' }} onClick={submit}>
              {editingId ? 'Save changes' : 'Create asset'}
            </button>
          </div>
        </div>

        <div className="modal-actions" style={{ marginTop: 8 }}>
          <button className="icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
