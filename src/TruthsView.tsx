import React, { useEffect, useState } from 'react';
import type { CampaignState, TruthCategoryCatalog } from './types';

function CustomTruthForm({ category, onSet }: { category: string; onSet: (result: string, description: string, questStarter: string) => void }) {
  const [result, setResult] = useState('');
  const [description, setDescription] = useState('');
  const [questStarter, setQuestStarter] = useState('');

  const submit = () => {
    if (!result.trim()) return;
    onSet(result.trim(), description.trim(), questStarter.trim());
    setResult('');
    setDescription('');
    setQuestStarter('');
  };

  return (
    <div className="track-card" style={{ padding: '8px 10px', borderLeft: '3px solid var(--accent-copper)' }}>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent-copper)', textTransform: 'uppercase', marginBottom: 6 }}>
        Write your own
      </div>
      <input
        value={result}
        onChange={(e) => setResult(e.target.value)}
        placeholder="Your truth for this category"
        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 7px', fontSize: 12, marginBottom: 6, color: 'var(--text)' }}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 7px', fontSize: 12, marginBottom: 6, color: 'var(--text)', resize: 'vertical' }}
      />
      <textarea
        value={questStarter}
        onChange={(e) => setQuestStarter(e.target.value)}
        placeholder="Quest starter (optional)"
        rows={2}
        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 7px', fontSize: 12, marginBottom: 6, color: 'var(--text)', resize: 'vertical' }}
      />
      <button className="icon-btn" style={{ borderColor: 'var(--accent-copper)', color: 'var(--accent-copper)' }} onClick={submit} disabled={!result.trim()}>
        Set this truth
      </button>
    </div>
  );
}

export function TruthsView({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const [catalog, setCatalog] = useState<TruthCategoryCatalog[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rolling, setRolling] = useState<string | null>(null);

  useEffect(() => {
    window.game.getTruthsCatalog().then(setCatalog);
  }, []);

  const established = state.truths;
  const establishedCount = Object.keys(established).length;

  const roll = async (category: string) => {
    setRolling(category);
    try {
      const { state: next } = await window.game.rollTruth({ campaignId, category });
      onStateChange(next);
    } finally {
      setRolling(null);
    }
  };

  const choose = async (category: string, option: TruthCategoryCatalog['options'][number], subtableResult?: string) => {
    const next = await window.game.chooseTruth({
      campaignId,
      category,
      result: option.result,
      subtableResult: subtableResult ?? null,
      description: option.description,
      questStarter: option.questStarter,
    });
    onStateChange(next);
  };

  const clear = async (category: string) => {
    const next = await window.game.clearTruth({ campaignId, category });
    onStateChange(next);
  };

  return (
    <div style={{ padding: '18px 28px', overflowY: 'auto', height: '100%' }}>
      <p className="panel-title" style={{ fontSize: 12 }}>
        Setting Truths — {establishedCount}/14 established
      </p>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -4, marginBottom: 16, maxWidth: 640 }}>
        These establish foundational facts about the setting. Roll for a random result (with a Quest Starter for vow
        inspiration), or pick one yourself. The GM will also roll categories on its own as they come up in play.
      </p>

      {catalog.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>Loading truths catalog…</p>}

      {catalog.map((cat) => {
        const t = established[cat.category];
        const isOpen = expanded === cat.category;
        return (
          <div key={cat.category} className="move-item" style={{ borderLeftColor: t ? 'var(--accent-cyan)' : 'var(--border)', marginBottom: 6 }}>
            <button className="move-item-header" onClick={() => setExpanded(isOpen ? null : cat.category)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{cat.category}</span>
              {t && (
                <span style={{ fontSize: 11, color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.result}
                </span>
              )}
            </button>
            {isOpen && (
              <div className="move-item-body">
                {t && (
                  <div className="track-card" style={{ marginBottom: 10 }}>
                    <div className="track-name" style={{ fontSize: 12 }}>
                      Established ({t.source}){t.subtableResult ? ` — ${t.subtableResult}` : ''}
                    </div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>{t.result}</div>
                    {t.questStarter && (
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, fontStyle: 'italic' }}>Quest Starter: {t.questStarter}</div>
                    )}
                    <button className="icon-btn" style={{ marginTop: 8 }} onClick={() => clear(cat.category)}>
                      Clear
                    </button>
                  </div>
                )}
                <button
                  className="icon-btn"
                  style={{ borderColor: 'var(--accent-copper)', color: 'var(--accent-copper)', marginBottom: 10 }}
                  onClick={() => roll(cat.category)}
                  disabled={rolling === cat.category}
                >
                  {rolling === cat.category ? 'Rolling…' : 'Roll for me'}
                </button>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {cat.options.map((opt, i) => (
                    <div key={i} className="track-card" style={{ padding: '8px 10px' }}>
                      <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 4 }}>{opt.result}</div>
                      {opt.description && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6, whiteSpace: 'pre-wrap' }}>{opt.description}</div>}
                      {opt.questStarter && <div style={{ fontSize: 11, fontStyle: 'italic', marginBottom: 6 }}>Quest Starter: {opt.questStarter}</div>}
                      {opt.subtable ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {opt.subtable.map((sub) => (
                            <button key={sub} className="icon-btn" style={{ fontSize: 10 }} onClick={() => choose(cat.category, opt, sub)}>
                              Choose: {sub}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <button className="icon-btn" onClick={() => choose(cat.category, opt)}>
                          Choose this
                        </button>
                      )}
                    </div>
                  ))}
                  <CustomTruthForm
                    category={cat.category}
                    onSet={async (result, description, questStarter) => {
                      const next = await window.game.chooseTruth({ campaignId, category: cat.category, result, description, questStarter });
                      onStateChange(next);
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
