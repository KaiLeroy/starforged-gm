import React, { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import type { CampaignState, Config, Stats, StartingAssetCategory, OwnedAsset, Connection, Character, CatalogAsset, PendingChoice, UpdaterStatus } from './types';
import { DisplayMessage, formatToolCall } from './utils';

/** Renders chat message content as markdown -- both the GM's narration and the player's own
 *  typed messages, so nothing looks inconsistent. Uses the base CommonMark feature set (bold,
 *  italic, headers, lists, blockquotes, links, inline/fenced code) without GFM extensions like
 *  tables or strikethrough, which aren't needed for narration and would be extra surface area to
 *  style. No raw HTML passthrough (react-markdown's default, not overridden here) -- this
 *  renders model-generated text, so treating embedded HTML as literal text rather than markup is
 *  the safe default to keep, not an oversight. */
function MessageContent({ text }: { text: string }) {
  return (
    <div className="markdown-content">
      <Markdown
        components={{
          // A plain <a href> inside this Electron window would navigate the window itself away
          // from the app on click. Open externally instead -- GM narration linking anywhere is a
          // rare edge case, but a real markdown renderer needs every element handled sensibly.
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) window.game.openExternalLink(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

/** Fetches an image by id via IPC (main process reads the file and returns a data URL) and
 *  renders it, or a lightweight placeholder while loading / if there's no image yet. */
export function GeneratedImage({ imageId, alt, style }: { imageId: string | null; alt: string; style?: React.CSSProperties }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!imageId) {
      setDataUrl(null);
      return;
    }
    let cancelled = false;
    window.game.getImage(imageId).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [imageId]);

  if (!imageId) return null;
  if (!dataUrl) {
    return <div style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, ...style }} />;
  }
  return <img src={dataUrl} alt={alt} style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)', ...style }} />;
}

function AssetCard({ asset, catalogEntry, campaignId, aboardVehicleId, onStateChange }: { asset: OwnedAsset; catalogEntry: CatalogAsset | null; campaignId: string; aboardVehicleId: string | null; onStateChange: (s: CampaignState) => void }) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const isVehicle = asset.battered !== undefined;
  const isAboard = aboardVehicleId === asset.id;

  const discard = async () => {
    const next = await window.game.discardAssetManual({ campaignId, assetId: asset.id });
    onStateChange(next);
  };

  const toggleCondition = async (condition: 'battered' | 'cursed') => {
    const next = await window.game.setVehicleCondition({ campaignId, assetId: asset.id, condition, marked: !asset[condition] });
    onStateChange(next);
  };

  return (
    <div className="track-card" style={{ padding: '6px 10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="track-name" style={{ fontSize: 12 }}>
          {asset.name}
          {isAboard && <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--accent-cyan)' }}>ABOARD</span>}
        </div>
        {confirmingDiscard ? (
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="icon-btn" style={{ fontSize: 9, padding: '1px 6px', borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={discard}>
              Confirm
            </button>
            <button className="icon-btn" style={{ fontSize: 9, padding: '1px 6px' }} onClick={() => setConfirmingDiscard(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="icon-btn" style={{ fontSize: 9, padding: '1px 6px' }} onClick={() => setConfirmingDiscard(true)} title="Discard this asset -- destroyed, lost, or given up">
            ✕
          </button>
        )}
      </div>
      <div className="track-meta">{asset.category}</div>
      {catalogEntry ? (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {catalogEntry.abilities.map((text, i) => {
            const abilityNumber = i + 1;
            const unlocked = asset.abilities_unlocked.includes(abilityNumber);
            return (
              <div
                key={abilityNumber}
                style={{
                  fontSize: 11,
                  lineHeight: 1.4,
                  color: unlocked ? 'var(--text)' : 'var(--text-dim)',
                  opacity: unlocked ? 1 : 0.6,
                  display: 'flex',
                  gap: 6,
                }}
              >
                <span style={{ flexShrink: 0 }}>{unlocked ? '●' : '○'}</span>
                <span>{text}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="track-meta">abilities {asset.abilities_unlocked.join(', ')}</div>
      )}
      {asset.health !== undefined && (
        <div style={{ marginTop: 6 }}>
          <div className="meter-row" style={{ marginBottom: 0 }}>
            <span className="meter-label">Health</span>
            <div className="meter-ticks">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className={`meter-tick ${i < asset.health! ? 'filled health' : ''}`} />
              ))}
            </div>
            <span className="meter-value">{asset.health}</span>
          </div>
        </div>
      )}
      {asset.resource !== undefined && (
        <div style={{ marginTop: 6 }}>
          <div className="meter-row" style={{ marginBottom: 0 }}>
            <span className="meter-label" style={{ textTransform: 'capitalize' }}>{asset.resource.label}</span>
            <div className="meter-ticks">
              {Array.from({ length: asset.resource.max }).map((_, i) => (
                <div key={i} className={`meter-tick ${i < asset.resource!.current ? 'filled resource' : ''}`} />
              ))}
            </div>
            <span className="meter-value">{asset.resource.current}/{asset.resource.max}</span>
          </div>
        </div>
      )}
      {isVehicle && (
        <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="icon-btn"
            style={{ fontSize: 9, padding: '1px 6px', borderColor: asset.battered ? 'var(--danger)' : undefined, color: asset.battered ? 'var(--danger)' : undefined }}
            onClick={() => toggleCondition('battered')}
          >
            {asset.battered ? 'Battered ✓' : 'Battered'}
          </button>
          {asset.cursed !== undefined && (
            <button
              className="icon-btn"
              style={{ fontSize: 9, padding: '1px 6px', borderColor: asset.cursed ? 'var(--danger)' : undefined, color: asset.cursed ? 'var(--danger)' : undefined }}
              disabled={asset.cursed}
              title={asset.cursed ? 'Cursed is permanent -- cannot be cleared' : 'Cursed is permanent once marked'}
              onClick={() => toggleCondition('cursed')}
            >
              {asset.cursed ? 'Cursed ✓ (permanent)' : 'Cursed'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CharacterSheet({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const { character, progressTracks } = state;
  const [assetCatalog, setAssetCatalog] = useState<CatalogAsset[]>([]);
  useEffect(() => {
    window.game.getAssetCatalog().then(setAssetCatalog);
  }, []);
  const stats: [keyof Stats, string][] = [
    ['edge', 'Edge'],
    ['heart', 'Heart'],
    ['iron', 'Iron'],
    ['shadow', 'Shadow'],
    ['wits', 'Wits'],
  ];

  const meterRow = (label: string, key: 'health' | 'spirit' | 'supply' | 'integrity', value: number) => (
    <div className="meter-row">
      <span className="meter-label">{label}</span>
      <div className="meter-ticks">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={`meter-tick ${i < value ? `filled ${key}` : ''}`} />
        ))}
      </div>
      <span className="meter-value">{value}</span>
    </div>
  );

  const momentum = character.meters.momentum;
  const segments = 16; // spans -6..10
  const [showEditModal, setShowEditModal] = useState(false);

  return (
    <>
      <div>
        <p className="panel-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span>
            {character.name || 'Unnamed Ironsworn'}
            {character.callsign ? ` "${character.callsign}"` : ''}
          </span>
          <button className="icon-btn" style={{ fontSize: 9, padding: '1px 6px' }} onClick={() => setShowEditModal(true)} title="Edit name, flavor text, or fix a stat mistake">
            ✎
          </button>
        </p>
        {character.portraitImageId && (
          <GeneratedImage imageId={character.portraitImageId} alt={character.name} style={{ width: '100%', height: 'auto', marginBottom: 8 }} />
        )}
        <PortraitGenerateButton state={state} campaignId={campaignId} onStateChange={onStateChange} />
        {character.pronouns && <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '0 0 4px' }}>{character.pronouns}</p>}
        {character.description && <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 8px', fontStyle: 'italic' }}>{character.description}</p>}
        {showEditModal && <EditCharacterModal character={character} campaignId={campaignId} onStateChange={onStateChange} onClose={() => setShowEditModal(false)} />}
        <div className="stat-grid">
          {stats.map(([key, label]) => (
            <div className="stat-cell" key={key}>
              <div className="stat-label">{label}</div>
              <div className="stat-value">{character.stats[key]}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="panel-title">Condition</p>
        {meterRow('Health', 'health', character.meters.health)}
        {meterRow('Spirit', 'spirit', character.meters.spirit)}
        {meterRow('Supply', 'supply', character.meters.supply)}
      </div>

      <div>
        <p className="panel-title">Vehicle Integrity</p>
        {meterRow('Integrity', 'integrity', character.meters.integrity)}
        <p style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
          Which vehicle counts toward momentum, and its Battered/Cursed status, is set per-vehicle in the Assets list below.
        </p>
      </div>

      <div>
        <p className="panel-title">Combat</p>
        <p style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: -6, marginBottom: 6 }}>
          Set by the GM from how rolls actually go -- not something to override directly.
        </p>
        <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: 'var(--text-dim)', marginBottom: 3 }}>Position</div>
            <div style={{ padding: '4px 6px', borderRadius: 4, background: 'var(--bg-raised)', border: '1px solid var(--border)' }}>
              {character.combatPosition === 'in_control' ? 'In control' : character.combatPosition === 'bad_spot' ? 'Bad spot' : 'Not in a fight'}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: 'var(--text-dim)', marginBottom: 3 }}>Range</div>
            <div style={{ padding: '4px 6px', borderRadius: 4, background: 'var(--bg-raised)', border: '1px solid var(--border)' }}>
              {character.combatRange === 'close' ? 'Close (+iron)' : character.combatRange === 'distance' ? 'Distance (+edge)' : 'Not in a fight'}
            </div>
          </div>
        </div>
      </div>

      <div>
        <p className="panel-title">
          Experience ({character.experience.earned - character.experience.spent} available)
        </p>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
          {character.experience.earned} earned · {character.experience.spent} spent
        </p>
      </div>

      <div>
        <p className="panel-title">Assets</p>
        {character.assets.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>None yet.</p>}
        {character.assets.map((a) => (
          <AssetCard key={a.id} asset={a} catalogEntry={assetCatalog.find((c) => c.id === a.id) || null} campaignId={campaignId} aboardVehicleId={character.aboardVehicleId} onStateChange={onStateChange} />
        ))}
      </div>

      <div>
        <p className="panel-title">Momentum ({momentum})</p>
        <div className="momentum-track">
          {Array.from({ length: segments }).map((_, i) => {
            const value = i - 6 + 1; // maps index -> -6..10
            const filled = value <= momentum && value > 0;
            const negFilled = value >= momentum && value < 0;
            return <div key={i} className={`momentum-seg ${filled ? 'filled' : ''} ${negFilled ? 'negative' : ''}`} />;
          })}
        </div>
      </div>

      <div>
        <p className="panel-title">Progress Tracks</p>
        {progressTracks.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>No active vows or tracks yet.</p>}
        {progressTracks.map((t) => {
          const clampedTicks = Math.min(40, Math.max(0, t.ticks));
          return (
            <div className="track-card" key={t.id}>
              <div className="track-name">{t.name}</div>
              <div className="track-meta">
                {t.type} · {t.rank} · {t.legacyCleared ? '10/10 (cleared — rolls treat as 10)' : `${Math.floor(clampedTicks / 4)}/10`}
              </div>
              <div className="track-boxes">
                {Array.from({ length: 10 }).map((_, i) => {
                  // Each box holds 4 ticks, matching the physical sheet's quarter-marks.
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

      <div>
        <p className="panel-title">Impacts</p>
        {Object.entries(character.impacts).map(([category, impacts]) => {
          if (category === 'Other Impacts') return null; // rendered separately below, with its own add/remove form
          return (
            <div key={category} style={{ marginBottom: 8 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 3 }}>
                {category}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {impacts.map((impact) => (
                  <button
                    key={impact.name}
                    title={impact.permanent && impact.marked ? 'Permanent — cannot be cleared' : 'Click to toggle'}
                    disabled={impact.permanent && impact.marked}
                    onClick={async () => {
                      const next = await window.game.toggleImpactManual({ campaignId, category, name: impact.name });
                      onStateChange(next);
                    }}
                    style={{
                      fontSize: 11,
                      padding: '2px 7px',
                      borderRadius: 3,
                      border: `1px solid ${impact.marked ? 'var(--danger)' : 'var(--border)'}`,
                      color: impact.marked ? 'var(--danger)' : 'var(--text-dim)',
                      background: impact.marked ? 'rgba(197, 83, 63, 0.12)' : 'transparent',
                      cursor: impact.permanent && impact.marked ? 'default' : 'pointer',
                    }}
                  >
                    {impact.name}
                    {impact.permanent && impact.marked ? ' 🔒' : ''}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        <OtherImpactsRow state={state} campaignId={campaignId} onStateChange={onStateChange} />
        <p style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
          Click to toggle. Also marked automatically by the GM when the fiction calls for it. 🔒 = permanent.
        </p>
      </div>

      <ConnectionsSection state={state} campaignId={campaignId} onStateChange={onStateChange} />
      <ClocksSection state={state} campaignId={campaignId} onStateChange={onStateChange} />
      <IllustrationsSection state={state} campaignId={campaignId} onStateChange={onStateChange} />
      <FlagsSection state={state} campaignId={campaignId} onStateChange={onStateChange} />
      <CampaignElementsSection state={state} campaignId={campaignId} onStateChange={onStateChange} />
      <LogSection state={state} campaignId={campaignId} onStateChange={onStateChange} />
    </>
  );
}

/** Small "generate an image" affordance: click to reveal a prompt field + confirm, used anywhere
 *  a manual (non-AI) image trigger makes sense -- portrait, connection portrait, location art. */
export function InlineImageGenerate({
  label,
  fallbackPrompt,
  composePrompt,
  onGenerate,
}: {
  label: string;
  fallbackPrompt: string;
  composePrompt: () => Promise<string>;
  onGenerate: (prompt: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startOpen = async () => {
    setOpen(true);
    setError(null);
    setComposing(true);
    setPrompt('');
    try {
      const composed = await composePrompt();
      setPrompt(composed);
    } catch (e: any) {
      // Composition failing (no API key set, a network hiccup) shouldn't leave the box stuck
      // empty -- fall back to the old, simple template so the feature still works, just less
      // tailored, and let the player know why rather than silently downgrading.
      setPrompt(fallbackPrompt);
      setError(`Couldn't compose a prompt automatically (${e?.message || 'unknown error'}) -- using a simple default instead. Feel free to edit it.`);
    } finally {
      setComposing(false);
    }
  };

  const go = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onGenerate(prompt.trim());
      setOpen(false);
    } catch (e: any) {
      setError(e?.message || 'Generation failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="icon-btn" style={{ fontSize: 10 }} onClick={startOpen}>
        {label}
      </button>
    );
  }

  return (
    <div style={{ marginTop: 4 }}>
      <textarea
        value={composing ? 'Composing a prompt from the story so far…' : prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={composing}
        rows={2}
        style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 7px', fontSize: 11, color: composing ? 'var(--text-dim)' : 'var(--text)', resize: 'vertical', marginBottom: 4, fontStyle: composing ? 'italic' : 'normal' }}
      />
      {error && <p style={{ fontSize: 10, color: 'var(--danger)', margin: '0 0 4px' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 4 }}>
        <button className="icon-btn" style={{ fontSize: 10, borderColor: 'var(--accent-copper)', color: 'var(--accent-copper)' }} onClick={go} disabled={busy || composing}>
          {busy ? 'Generating…' : 'Generate'}
        </button>
        <button className="icon-btn" style={{ fontSize: 10 }} onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function EditCharacterModal({
  character,
  campaignId,
  onStateChange,
  onClose,
}: {
  character: Character;
  campaignId: string;
  onStateChange: (s: CampaignState) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(character.name);
  const [callsign, setCallsign] = useState(character.callsign);
  const [pronouns, setPronouns] = useState(character.pronouns);
  const [description, setDescription] = useState(character.description);
  const [stats, setStats] = useState<Stats>({ ...character.stats });
  const [error, setError] = useState<string | null>(null);
  const [savingStats, setSavingStats] = useState(false);

  const STANDARD_ARRAY = [3, 2, 2, 1, 1];
  const statsValid = (() => {
    const values = Object.values(stats).sort((a, b) => a - b);
    const expected = [...STANDARD_ARRAY].sort((a, b) => a - b);
    return values.length === expected.length && values.every((v, i) => v === expected[i]);
  })();
  const statsChanged = (Object.keys(stats) as (keyof Stats)[]).some((k) => stats[k] !== character.stats[k]);

  const saveFlavor = async () => {
    const next = await window.game.updateCharacterFlavorManual({ campaignId, name: name.trim() || 'Unnamed Ironsworn', callsign: callsign.trim(), pronouns: pronouns.trim(), description: description.trim() });
    onStateChange(next);
    onClose();
  };

  const saveStats = async () => {
    setError(null);
    setSavingStats(true);
    try {
      const next = await window.game.updateCharacterStatsManual({ campaignId, stats });
      onStateChange(next);
    } catch (e: any) {
      setError(e?.message || 'Could not save stats.');
    } finally {
      setSavingStats(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 460 }}>
        <h2>Edit Character</h2>
        <div className="field">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Callsign</label>
            <input value={callsign} onChange={(e) => setCallsign(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Pronouns</label>
            <input value={pronouns} onChange={(e) => setPronouns(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, color: 'var(--text)', fontFamily: 'var(--font-serif)', fontSize: 13, resize: 'vertical' }}
          />
        </div>

        <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-cyan)', textTransform: 'uppercase', marginTop: 16, marginBottom: 8, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          Fix a stat mistake
        </p>
        {character.statsCorrected ? (
          <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -4, marginBottom: 10 }}>
            Already used for this character -- stats can only be manually corrected once, so a single chargen mistake can be fixed without turning this into a lever to reassign stats before every roll. Any further changes should happen in play, through the fiction.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -4, marginBottom: 10 }}>
              Not a normal in-fiction action -- Starforged doesn't support rebalancing stats mid-campaign. This is purely for correcting a chargen mistake, and can only be used once.
            </p>
            <div className="stat-grid">
              {(Object.keys(stats) as (keyof Stats)[]).map((key) => (
                <div className="stat-cell" key={key}>
                  <div className="stat-label">{key}</div>
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={stats[key]}
                    onChange={(e) => setStats((s) => ({ ...s, [key]: Number(e.target.value) }))}
                    style={{ width: '100%', textAlign: 'center', background: 'transparent', border: 'none', fontFamily: 'var(--font-mono)', fontSize: 16, color: 'var(--text)' }}
                  />
                </div>
              ))}
            </div>
            {statsChanged && !statsValid && (
              <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>
                Must be exactly the values 3, 2, 2, 1, 1 -- one per stat, in any order.
              </p>
            )}
            {error && <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>{error}</p>}
            {statsChanged && (
              <button className="icon-btn" style={{ marginTop: 8, borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={saveStats} disabled={!statsValid || savingStats}>
                {savingStats ? 'Saving…' : 'Save stat correction (one-time only)'}
              </button>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="icon-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="icon-btn" style={{ borderColor: 'var(--accent-cyan)', color: 'var(--accent-cyan)' }} onClick={saveFlavor}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function PortraitGenerateButton({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const c = state.character;
  const fallbackPrompt = `Portrait of ${c.name || 'a character'}${c.description ? `, ${c.description}` : ''}, sci-fi, painterly`;
  return (
    <div style={{ marginBottom: 8 }}>
      <InlineImageGenerate
        label={c.portraitImageId ? 'Regenerate portrait' : 'Generate portrait'}
        fallbackPrompt={fallbackPrompt}
        composePrompt={() => window.game.composeImagePrompt({ campaignId, kind: 'portrait' })}
        onGenerate={async (prompt) => {
          const next = await window.game.generatePortrait({ campaignId, prompt });
          onStateChange(next);
        }}
      />
    </div>
  );
}

function ConnectionsSection({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [location, setLocation] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editLocation, setEditLocation] = useState('');

  const add = async () => {
    if (!name.trim()) return;
    const next = await window.game.addConnection({ campaignId, name: name.trim(), notes: notes.trim(), location: location.trim() });
    onStateChange(next);
    setName('');
    setNotes('');
    setLocation('');
  };

  const remove = async (id: string) => {
    const next = await window.game.removeConnection({ campaignId, id });
    onStateChange(next);
  };

  const startEdit = (c: Connection) => {
    setEditingId(c.id);
    setEditName(c.name);
    setEditNotes(c.notes);
    setEditLocation(c.location);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const next = await window.game.updateConnection({ campaignId, id: editingId, name: editName.trim(), notes: editNotes.trim(), location: editLocation.trim() });
    onStateChange(next);
    setEditingId(null);
  };

  return (
    <div>
      <p className="panel-title">Connections</p>
      {state.connections.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>None yet.</p>}
      {state.connections.map((c) => (
        <div className="track-card" key={c.id} style={{ padding: '6px 10px' }}>
          {editingId === c.id ? (
            <div>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Name"
                style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 6px', fontSize: 12, marginBottom: 4 }}
              />
              <input
                value={editLocation}
                onChange={(e) => setEditLocation(e.target.value)}
                placeholder="Location (where they can typically be found)"
                style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 6px', fontSize: 11, marginBottom: 4 }}
              />
              <input
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="Notes"
                style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 6px', fontSize: 11, marginBottom: 4 }}
              />
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="icon-btn" style={{ fontSize: 9, padding: '1px 6px' }} onClick={saveEdit} disabled={!editName.trim()}>
                  Save
                </button>
                <button className="icon-btn" style={{ fontSize: 9, padding: '1px 6px' }} onClick={() => setEditingId(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              {c.imageId && <GeneratedImage imageId={c.imageId} alt={c.name} style={{ width: 40, height: 40, flexShrink: 0 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 12, fontWeight: 'bold' }}>{c.name}</span>
                  <div style={{ display: 'flex', gap: 2 }}>
                    <button className="icon-btn" style={{ padding: '1px 6px', fontSize: 9 }} onClick={() => startEdit(c)} title="Edit name/location/notes">
                      ✎
                    </button>
                    <button className="icon-btn" style={{ padding: '1px 6px', fontSize: 9 }} onClick={() => remove(c.id)} title="Remove connection">
                      ✕
                    </button>
                  </div>
                </div>
                {c.location && <div style={{ fontSize: 11, color: 'var(--accent-cyan)' }}>{c.location}</div>}
                {c.notes && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{c.notes}</div>}
                {(c.role || c.bonded) && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {c.role && (
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, border: '1px solid var(--border)', color: 'var(--text-dim)' }}>
                        {c.role} (+{c.roleBonus}){c.secondRole && ` / ${c.secondRole} (+${c.roleBonus})`}
                      </span>
                    )}
                    {c.bonded && (
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, border: '1px solid var(--accent-copper)', color: 'var(--accent-copper)' }}>
                        BOND
                      </span>
                    )}
                    {c.benefitsSuspended && (
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, border: '1px solid var(--danger)', color: 'var(--danger)' }}>
                        SUSPENDED
                      </span>
                    )}
                  </div>
                )}
                {c.rank ? (
                  c.bonded ? (
                    // Per the book: once bonded, the connection no longer has a progress track at
                    // all -- Develop Your Relationship becomes a direct action roll instead. Showing
                    // a stale box track here would misrepresent a mechanic that no longer applies.
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>{c.rank} (bonded -- no progress track)</div>
                  ) : (
                    <div style={{ marginTop: 4 }}>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 2 }}>
                        {c.rank} · {Math.floor(Math.min(40, Math.max(0, c.progressTicks)) / 4)}/10
                      </div>
                      <div className="track-boxes">
                        {Array.from({ length: 10 }).map((_, i) => {
                          const clampedTicks = Math.min(40, Math.max(0, c.progressTicks));
                          const ticksInBox = Math.max(0, Math.min(4, clampedTicks - i * 4));
                          return (
                            <div key={i} className="track-box">
                              <div className="track-box-fill" style={{ width: `${(ticksInBox / 4) * 100}%` }} />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )
                ) : (
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>No rank set yet</div>
                )}
              </div>
            </div>
          )}
          {editingId !== c.id && (
            <InlineImageGenerate
              label={c.imageId ? 'Regenerate portrait' : 'Generate portrait'}
              fallbackPrompt={`Portrait of ${c.name}${c.notes ? `, ${c.notes}` : ''}, sci-fi, painterly`}
              composePrompt={() => window.game.composeImagePrompt({ campaignId, kind: 'connection', subjectId: c.id })}
              onGenerate={async (prompt) => {
                const next = await window.game.generateConnectionImage({ campaignId, connectionId: c.id, prompt });
                onStateChange(next);
              }}
            />
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12 }} />
        <button className="icon-btn" onClick={add} disabled={!name.trim()}>
          Add
        </button>
      </div>
      <input
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        placeholder="Location (optional)"
        style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12, marginTop: 4 }}
      />
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12, marginTop: 4 }}
      />
    </div>
  );
}

function OtherImpactsRow({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const others = state.character.impacts['Other Impacts'] || [];

  const add = async () => {
    if (!name.trim()) return;
    const next = await window.game.addOtherImpactManual({ campaignId, name: name.trim() });
    onStateChange(next);
    setName('');
    setAdding(false);
  };

  const remove = async (n: string) => {
    const next = await window.game.removeOtherImpactManual({ campaignId, name: n });
    onStateChange(next);
  };

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 3 }}>Other Impacts</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
        {others.map((impact) => (
          <span key={impact.name} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 3, border: '1px solid var(--danger)', color: 'var(--danger)', background: 'rgba(197, 83, 63, 0.12)', display: 'flex', alignItems: 'center', gap: 4 }}>
            {impact.name}
            <button onClick={() => remove(impact.name)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 10 }}>
              ✕
            </button>
          </span>
        ))}
      </div>
      {adding ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Oathbreaker"
            style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 6px', fontSize: 11 }}
          />
          <button className="icon-btn" style={{ fontSize: 10 }} onClick={add} disabled={!name.trim()}>
            Add
          </button>
          <button className="icon-btn" style={{ fontSize: 10 }} onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="icon-btn" style={{ fontSize: 10 }} onClick={() => setAdding(true)}>
          + Add Other Impact
        </button>
      )}
    </div>
  );
}

function FlagsSection({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const [text, setText] = useState('');

  const add = async () => {
    if (!text.trim()) return;
    const next = await window.game.addFlagManual({ campaignId, text: text.trim() });
    onStateChange(next);
    setText('');
  };

  const remove = async (t: string) => {
    const next = await window.game.removeFlagManual({ campaignId, text: t });
    onStateChange(next);
  };

  return (
    <div>
      <p className="panel-title">Content Flags</p>
      <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -4, marginBottom: 6 }}>
        Content to handle carefully, off-screen, or avoid entirely. The GM respects these for the whole campaign.
      </p>
      {state.flags.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>None set.</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
        {state.flags.map((f) => (
          <span key={f} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 3, border: '1px solid var(--border)', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
            {f}
            <button onClick={() => remove(f)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 10 }}>
              ✕
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. body horror" style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12 }} />
        <button className="icon-btn" onClick={add} disabled={!text.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

function CampaignElementsSection({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const [text, setText] = useState('');

  const add = async () => {
    if (!text.trim()) return;
    const next = await window.game.addCampaignElementManual({ campaignId, text: text.trim() });
    onStateChange(next);
    setText('');
  };

  const remove = async (id: string) => {
    const next = await window.game.removeCampaignElementManual({ campaignId, id });
    onStateChange(next);
  };

  return (
    <div>
      <p className="panel-title">Campaign Elements</p>
      <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -4, marginBottom: 6 }}>
        Story ingredients specific to this campaign -- the GM can roll on these to connect a new situation to something already established.
      </p>
      {state.campaignElements.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>None set yet.</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
        {state.campaignElements.map((e) => (
          <span key={e.id} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 3, border: '1px solid var(--border)', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
            {e.text}
            <button onClick={() => remove(e.id)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 10 }}>
              ✕
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Faction: Silver Dominion" style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12 }} />
        <button className="icon-btn" onClick={add} disabled={!text.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

function LogSection({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const [text, setText] = useState('');

  const add = async () => {
    if (!text.trim()) return;
    const next = await window.game.addLogEntry({ campaignId, text: text.trim() });
    onStateChange(next);
    setText('');
  };

  return (
    <div>
      {(state.storySummary.distant || state.storySummary.recent) && (
        <div style={{ marginBottom: 14 }}>
          <p className="panel-title">Story So Far</p>
          <p style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: -6, marginBottom: 6 }}>
            Older parts of this campaign, automatically condensed to keep things running smoothly. The GM still remembers them.
          </p>
          {state.storySummary.distant && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6, paddingLeft: 8, borderLeft: '2px solid var(--border)', fontStyle: 'italic' }}>
              {state.storySummary.distant}
            </div>
          )}
          {state.storySummary.recent && (
            <div style={{ fontSize: 11, color: 'var(--text)', marginBottom: 6, paddingLeft: 8, borderLeft: '2px solid var(--accent-cyan)' }}>
              {state.storySummary.recent}
            </div>
          )}
        </div>
      )}
      <p className="panel-title">Campaign Log</p>
      {state.log.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>No entries yet.</p>}
      {state.log
        .slice()
        .reverse()
        .map((e, i) => (
          <div key={i} style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4, paddingLeft: 8, borderLeft: '2px solid var(--border)' }}>
            {e.text}
          </div>
        ))}
      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note…" style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12 }} />
        <button className="icon-btn" onClick={add} disabled={!text.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

function ClocksSection({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<'campaign' | 'tension'>('tension');
  const [segments, setSegments] = useState<4 | 6 | 8 | 10>(4);

  const create = async () => {
    if (!name.trim()) return;
    const next = await window.game.createClock({ campaignId, name: name.trim(), type, segments });
    onStateChange(next);
    setName('');
    setShowForm(false);
  };

  const advance = async (id: string, amount: number) => {
    const next = await window.game.advanceClock({ campaignId, id, amount });
    onStateChange(next);
  };

  const stop = async (id: string) => {
    const next = await window.game.stopClock({ campaignId, id });
    onStateChange(next);
  };

  return (
    <div>
      <p className="panel-title">Clocks</p>
      {state.clocks.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>None active.</p>}
      {state.clocks.map((c) => (
        <div className="track-card" key={c.id} style={{ padding: '6px 10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 12, fontWeight: 'bold' }}>{c.name}</span>
            <button className="icon-btn" style={{ padding: '1px 6px', fontSize: 9 }} onClick={() => stop(c.id)}>
              ✕
            </button>
          </div>
          <div className="track-meta">
            {c.type} · {c.filled}/{c.segments}
          </div>
          <div style={{ display: 'flex', gap: 2, marginTop: 4, marginBottom: 4 }}>
            {Array.from({ length: c.segments }).map((_, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: 10,
                  border: '1px solid var(--border)',
                  background: i < c.filled ? (c.type === 'campaign' ? 'var(--accent-cyan)' : 'var(--danger)') : 'transparent',
                }}
              />
            ))}
          </div>
          {c.filled < c.segments && (
            <button className="icon-btn" style={{ fontSize: 10 }} onClick={() => advance(c.id, 1)}>
              +1 segment
            </button>
          )}
        </div>
      ))}
      {showForm ? (
        <div style={{ marginTop: 6 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Clock name"
            style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12, marginBottom: 4 }}
          />
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as 'campaign' | 'tension')}
              style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 11, color: 'var(--text)' }}
            >
              <option value="tension">Tension</option>
              <option value="campaign">Campaign</option>
            </select>
            <select
              value={segments}
              onChange={(e) => setSegments(Number(e.target.value) as 4 | 6 | 8 | 10)}
              style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 11, color: 'var(--text)' }}
            >
              {[4, 6, 8, 10].map((n) => (
                <option key={n} value={n}>
                  {n} segments
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="icon-btn" style={{ borderColor: 'var(--accent-copper)', color: 'var(--accent-copper)' }} onClick={create} disabled={!name.trim()}>
              Create
            </button>
            <button className="icon-btn" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="icon-btn" style={{ marginTop: 6 }} onClick={() => setShowForm(true)}>
          + New Clock
        </button>
      )}
    </div>
  );
}

function IllustrationsSection({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const remove = async (id: string) => {
    const next = await window.game.removeIllustration({ campaignId, id });
    onStateChange(next);
  };

  return (
    <div>
      <p className="panel-title">Illustrations</p>
      {state.illustrations.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 6 }}>None yet.</p>}
      {state.illustrations
        .slice()
        .reverse()
        .map((i) => (
          <div key={i.id} className="track-card" style={{ padding: 6 }}>
            <GeneratedImage imageId={i.imageId} alt={i.caption} style={{ width: '100%', height: 'auto', marginBottom: 4 }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{i.caption}</span>
              <button className="icon-btn" style={{ padding: '1px 6px', fontSize: 9, flexShrink: 0 }} onClick={() => remove(i.id)}>
                ✕
              </button>
            </div>
          </div>
        ))}
      <InlineImageGenerate
        label="Generate illustration"
        fallbackPrompt={
          state.storySummary.recent
            ? `${state.storySummary.recent}, sci-fi concept art`
            : state.log.length > 0
              ? `${state.log[state.log.length - 1].text}, sci-fi concept art`
              : `${state.character.name || 'A lone ironsworn'}${state.character.description ? `, ${state.character.description}` : ''}, sci-fi concept art`
        }
        composePrompt={() => window.game.composeImagePrompt({ campaignId, kind: 'illustration' })}
        onGenerate={async (prompt) => {
          const next = await window.game.generateIllustration({ campaignId, prompt, caption: prompt.slice(0, 80) });
          onStateChange(next);
        }}
      />
    </div>
  );
}

function TxLine({ event }: { event: DisplayMessage['events'][number] }) {
  const { label, outcome, color, dice, note, imageId } = formatToolCall(event);
  return (
    <div className={`tx-line ${outcome ? outcome.replace(' ', '_') : ''}`} style={color ? { borderLeftColor: color } : undefined}>
      {label}
      {outcome ? <span className="tx-outcome"> — {outcome}</span> : null}
      {dice && (
        <span>
          {' '}
          (
          {dice.actionDie !== undefined && (
            <>
              <span className="tx-die">{dice.actionDie}</span>
              {' + '}
              {dice.stat}
              {' '}
              {dice.statValue}
              {!!dice.adds && ` + ${dice.adds} `}
              {' = '}
            </>
          )}
          {dice.actionScore} vs{' '}
          <span className={`tx-die ${dice.beatsC1 ? 'beat' : 'not-beat'}`}>{dice.die1}</span>
          {', '}
          <span className={`tx-die ${dice.beatsC2 ? 'beat' : 'not-beat'}`}>{dice.die2}</span>
          {dice.isMatch ? ' — match' : ''})
        </span>
      )}
      {note ? <span style={{ color: 'var(--accent-copper)' }}> · {note}</span> : null}
      {imageId && <GeneratedImage imageId={imageId} alt={label} style={{ display: 'block', width: '100%', maxWidth: 420, height: 'auto', maxHeight: 320, marginTop: 6 }} />}
    </div>
  );
}

export function ChatLog({
  messages,
  pendingEvents,
  thinking,
  canUndo,
  onEdit,
  onRegenerate,
}: {
  messages: DisplayMessage[];
  pendingEvents: DisplayMessage['events'];
  thinking: boolean;
  canUndo?: boolean;
  onEdit?: () => void;
  onRegenerate?: () => void;
}) {
  if (messages.length === 0 && !thinking) {
    return (
      <div className="chat-log">
        <div className="empty-state">
          Your ironsworn awaits their first move. Describe what your character does, and the
          transmission will begin.
        </div>
      </div>
    );
  }
  const lastIdx = messages.length - 1;
  // Edit shows on the last user message -- either the very last message overall (the turn
  // failed before any GM response came back) or the second-to-last, immediately followed by the
  // GM's reply (the normal, completed-turn case). Regenerate shows only on an actual last GM
  // message, since there's nothing to re-roll if the turn never produced one.
  const editableIdx = canUndo
    ? messages[lastIdx]?.role === 'user'
      ? lastIdx
      : messages[lastIdx - 1]?.role === 'user' && messages[lastIdx]?.role === 'gm'
        ? lastIdx - 1
        : -1
    : -1;
  const regenerateIdx = canUndo && messages[lastIdx]?.role === 'gm' ? lastIdx : -1;
  return (
    <div className="chat-log">
      {messages.map((m, i) => (
        <div className={`msg ${m.role === 'user' ? 'user' : 'gm'}`} key={i}>
          {m.events.map((e, j) => (
            <TxLine event={e} key={j} />
          ))}
          <div className="bubble">
            <MessageContent text={m.content} />
          </div>
          {(i === editableIdx || i === regenerateIdx) && (
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              {i === editableIdx && (
                <button className="icon-btn" style={{ fontSize: 11 }} onClick={onEdit} title="Undo this turn and edit your message before resending">
                  Edit
                </button>
              )}
              {i === regenerateIdx && (
                <button className="icon-btn" style={{ fontSize: 11 }} onClick={onRegenerate} title="Undo this turn and try again with the same message">
                  Regenerate
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {thinking && (
        <div className="msg gm">
          {pendingEvents.map((e, j) => (
            <TxLine event={e} key={j} />
          ))}
          <div className="bubble" style={{ color: 'var(--text-dim)' }}>
            …
          </div>
        </div>
      )}
    </div>
  );
}

export function Composer({ onSend, disabled, prefill }: { onSend: (text: string) => void; disabled: boolean; prefill?: { text: string; version: number } }) {
  const [value, setValue] = useState('');
  // prefill.version changes every time Edit is used, even if the text happens to be identical
  // to what's already there -- a plain dependency on prefill.text wouldn't re-fire in that case.
  useEffect(() => {
    if (prefill) setValue(prefill.text);
  }, [prefill?.version]);
  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
  };
  return (
    <div className="composer">
      <textarea
        value={value}
        placeholder="What does your ironsworn do?"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button onClick={submit} disabled={disabled}>
        Transmit
      </button>
    </div>
  );
}

export function SettingsModal({ config, onSave, onClose, campaignId = 'default' }: { config: Config; onSave: (c: Config) => void; onClose: () => void; campaignId?: string }) {
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [model, setModel] = useState(config.model);
  // Kept as text, not type="number" inputs: these are optional (blank means "use the model's
  // own default", parsed to null on save, not forced to some hardcoded value), and React's
  // number inputs handle an empty/in-progress value awkwardly compared to a plain string here.
  const [temperature, setTemperature] = useState(config.temperature === null || config.temperature === undefined ? '' : String(config.temperature));
  const [topP, setTopP] = useState(config.topP === null || config.topP === undefined ? '' : String(config.topP));
  const [moveChoiceThreshold, setMoveChoiceThreshold] = useState<Config['moveChoiceThreshold']>(config.moveChoiceThreshold || 'almost_certain');
  const [debugLogging, setDebugLogging] = useState(config.debugLogging || false);
  const [comfyUrl, setComfyUrl] = useState(config.comfyUrl || 'http://127.0.0.1:8188');
  const [comfyWorkflow, setComfyWorkflow] = useState(config.comfyWorkflow || '');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const [appVersion, setAppVersion] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdaterStatus>({ status: 'idle' });
  useEffect(() => {
    window.updater.getVersion().then(setAppVersion).catch(() => {});
    const unsubscribe = window.updater.onStatus((status: UpdaterStatus) => setUpdateStatus(status));
    return unsubscribe;
  }, []);

  const testConnection = async () => {
    setTestStatus('testing');
    setTestMessage('');
    try {
      await window.game.testComfyConnection();
      setTestStatus('ok');
    } catch (e: any) {
      setTestStatus('error');
      setTestMessage(e?.message || 'Could not reach ComfyUI.');
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 560, maxHeight: '85vh', overflowY: 'auto' }}>
        <h2>Uplink Settings</h2>
        <div className="field">
          <label>OpenRouter API Key</label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-or-..." />
        </div>
        <div className="field">
          <label>Model</label>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="anthropic/claude-sonnet-4.5" />
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Temperature</label>
            <input value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="model default" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Top P</label>
            <input value={topP} onChange={(e) => setTopP(e.target.value)} placeholder="model default" />
          </div>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -8, marginBottom: 16 }}>
          Both optional -- leave blank to use the model's own default rather than forcing one.
          Temperature is typically 0-2 (higher is more varied/less predictable, lower is more
          consistent); Top P is typically 0-1. Adjusting either changes how the GM writes and
          decides, not the game's own dice odds, which are unaffected.
        </p>

        <div className="field">
          <label>Ask before a move, unless triviality is at least...</label>
          {(() => {
            const tiers: { value: Config['moveChoiceThreshold']; label: string }[] = [
              { value: 'small_chance', label: 'Small Chance' },
              { value: 'unlikely', label: 'Unlikely' },
              { value: '50_50', label: '50-50' },
              { value: 'likely', label: 'Likely' },
              { value: 'almost_certain', label: 'Almost Certain' },
            ];
            const idx = Math.max(0, tiers.findIndex((t) => t.value === moveChoiceThreshold));
            return (
              <>
                <input
                  type="range"
                  min={0}
                  max={4}
                  step={1}
                  value={idx}
                  onChange={(e) => setMoveChoiceThreshold(tiers[Number(e.target.value)].value)}
                  style={{ width: '100%' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                  {tiers.map((t) => (
                    <span key={t.value} style={{ fontWeight: t.value === moveChoiceThreshold ? 'bold' : 'normal', color: t.value === moveChoiceThreshold ? 'var(--accent-copper)' : 'var(--text-dim)' }}>
                      {t.label}
                    </span>
                  ))}
                </div>
              </>
            );
          })()}
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -8, marginBottom: 16 }}>
          When you describe an action without picking a move from the Moves panel yourself, the
          GM first judges how plausible it is that the action is trivial enough to need no move at
          all -- using the same five-tier odds Ask the Oracle itself uses. Above this setting, it's
          treated as trivial and just narrated through, no move rolled. At or below it, the GM
          always asks you which move actually applies, every time, rather than quietly picking one
          itself. At "Almost Certain" (the default), essentially nothing outranks that ceiling, so
          it asks about nearly every real action. Move it toward "Small Chance" for a faster pace
          where more gets waved through as trivial, and the GM only stops to ask on the situations
          it judges as genuinely below that bar.
        </p>

        <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 8, flexDirection: 'row' }}>
          <input
            type="checkbox"
            id="debug-logging-toggle"
            checked={debugLogging}
            onChange={(e) => setDebugLogging(e.target.checked)}
            style={{ width: 'auto' }}
          />
          <label htmlFor="debug-logging-toggle" style={{ marginBottom: 0 }}>
            Enable debug logging
          </label>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -8, marginBottom: 4 }}>
          When on, every turn's complete diagnostic record -- the exact system prompt the GM
          received, every tool call it made and the result of each, and the final reply -- is
          appended to a log file for this campaign. Useful for telling apart an app problem (the
          prompt itself was wrong or missing guidance for the situation) from a model problem (the
          guidance was correct and the GM just didn't follow it): with both halves of a specific
          turn side by side, it's usually clear which one it was. Off by default, since it writes
          the full prompt text to disk every turn.
        </p>
        <button
          className="icon-btn"
          onClick={() => window.game.revealDebugLog(campaignId)}
          style={{ marginBottom: 16 }}
        >
          Open Debug Log
        </button>

        <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-cyan)', textTransform: 'uppercase', marginTop: 20, marginBottom: 8, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          Image generation (ComfyUI, optional)
        </p>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -4, marginBottom: 10 }}>
          Portraits, location art, and story illustrations run through your own local ComfyUI
          server -- this app never sends prompts anywhere else for images. Requires ComfyUI
          running with a checkpoint already set up.
        </p>
        <div className="field">
          <label>ComfyUI Server URL</label>
          <input value={comfyUrl} onChange={(e) => setComfyUrl(e.target.value)} placeholder="http://127.0.0.1:8188" />
        </div>
        <div className="field">
          <label>Workflow Template (API format JSON)</label>
          <textarea
            value={comfyWorkflow}
            onChange={(e) => setComfyWorkflow(e.target.value)}
            placeholder='Paste a workflow exported from ComfyUI via "Save (API Format)". Put {{PROMPT}} in the positive prompt node&apos;s text field.'
            rows={6}
            style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 11, resize: 'vertical' }}
          />
          <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
            In ComfyUI: enable Dev Mode (Settings gear icon), build your workflow, then "Save (API
            Format)". Open the file, find the positive-prompt CLIPTextEncode node's "text" value,
            and replace it with <code>{'{{PROMPT}}'}</code>. Paste the whole JSON file here.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <button className="icon-btn" onClick={testConnection} disabled={testStatus === 'testing'}>
            {testStatus === 'testing' ? 'Testing…' : 'Test Connection'}
          </button>
          {testStatus === 'ok' && <span style={{ color: 'var(--success)', fontSize: 12 }}>Connected.</span>}
          {testStatus === 'error' && <span style={{ color: 'var(--danger)', fontSize: 12 }}>{testMessage}</span>}
        </div>

        <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-cyan)', textTransform: 'uppercase', marginTop: 20, marginBottom: 8, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          App updates
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Current version: {appVersion || '…'}</span>
          <button
            className="icon-btn"
            onClick={() => window.updater.check()}
            disabled={updateStatus.status === 'checking' || updateStatus.status === 'downloading'}
          >
            {updateStatus.status === 'checking' ? 'Checking…' : 'Check for Updates'}
          </button>
          {updateStatus.status === 'available' && (
            <button className="icon-btn" style={{ borderColor: 'var(--accent-cyan)', color: 'var(--accent-cyan)' }} onClick={() => window.updater.download()}>
              Download v{updateStatus.version}
            </button>
          )}
          {updateStatus.status === 'downloaded' && (
            <button className="icon-btn" style={{ borderColor: 'var(--success)', color: 'var(--success)' }} onClick={() => window.updater.install()}>
              Restart &amp; Install v{updateStatus.version}
            </button>
          )}
        </div>
        {updateStatus.status === 'not-available' && <p style={{ fontSize: 12, color: 'var(--success)', marginTop: 4 }}>You're on the latest version.</p>}
        {updateStatus.status === 'downloading' && <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>Downloading… {updateStatus.percent ?? 0}%</p>}
        {(updateStatus.status === 'error' || updateStatus.status === 'unavailable') && <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>{updateStatus.message}</p>}

        <div className="modal-actions">
          <button className="icon-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="icon-btn"
            style={{ borderColor: 'var(--accent-cyan)', color: 'var(--accent-cyan)' }}
            onClick={() => {
              const parseOptionalFloat = (s: string): number | null => {
                const trimmed = s.trim();
                if (!trimmed) return null;
                const n = parseFloat(trimmed);
                return Number.isNaN(n) ? null : n;
              };
              onSave({ apiKey, model, comfyUrl, comfyWorkflow, temperature: parseOptionalFloat(temperature), topP: parseOptionalFloat(topP), moveChoiceThreshold, debugLogging });
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

const FINAL_ASSET_CATEGORIES = ['Module', 'Support Vehicle', 'Companion', 'Path', 'Custom'];

export function NewCampaignModal({
  onCreate,
  onOpenSettings,
}: {
  onCreate: (name: string, stats: Stats, assetIds: string[], flavor: { callsign: string; pronouns: string; description: string }, backgroundVow: string) => void;
  onOpenSettings: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState('');
  const [callsign, setCallsign] = useState('');
  const [pronouns, setPronouns] = useState('');
  const [description, setDescription] = useState('');
  const [backgroundVow, setBackgroundVow] = useState('');
  const [stats, setStats] = useState<Stats>({ edge: 1, heart: 2, iron: 2, shadow: 1, wits: 1 });
  const [categories, setCategories] = useState<StartingAssetCategory[]>([]);
  const [paths, setPaths] = useState<string[]>([]);
  const [finalAsset, setFinalAsset] = useState<string | null>(null);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const setStat = (key: keyof Stats, value: number) => setStats((s) => ({ ...s, [key]: value }));

  // Standard array is a fixed multiset {3,2,2,1,1} distributed across the five stats -- not free-form points.
  const STANDARD_ARRAY = [3, 2, 2, 1, 1];
  const statsValid = (() => {
    const values = Object.values(stats).sort((a, b) => a - b);
    const expected = [...STANDARD_ARRAY].sort((a, b) => a - b);
    return values.length === expected.length && values.every((v, i) => v === expected[i]);
  })();

  const goToPaths = () => {
    setStep(2);
    if (categories.length === 0) {
      setLoadingAssets(true);
      window.game
        .getStartingAssets()
        .then(setCategories)
        .finally(() => setLoadingAssets(false));
    }
  };

  const togglePath = (id: string) => {
    setPaths((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return prev;
      return [...prev, id];
    });
  };

  const pathCategory = categories.find((c) => c.category === 'Path');
  const finalAssetCategories = categories
    .filter((c) => FINAL_ASSET_CATEGORIES.includes(c.category))
    .map((c) => (c.category === 'Path' ? { ...c, assets: c.assets.filter((a) => !paths.includes(a.id)) } : c))
    .filter((c) => c.assets.length > 0);

  if (step === 1) {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2>New Ironsworn</h2>
            <button className="icon-btn" style={{ fontSize: 10 }} onClick={onOpenSettings}>
              Settings
            </button>
          </div>
          <div className="field">
            <label>Character Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kess Vantar" />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Callsign (optional)</label>
              <input value={callsign} onChange={(e) => setCallsign(e.target.value)} placeholder="e.g. Ghost" />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Pronouns (optional)</label>
              <input value={pronouns} onChange={(e) => setPronouns(e.target.value)} placeholder="e.g. she/her" />
            </div>
          </div>
          <div className="field">
            <label>Description (optional) — appearance, mannerisms, anything the GM can draw on</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Lean, scarred across one cheek, always wears a patched flight jacket. Quiet until she trusts you."
              rows={3}
              style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, color: 'var(--text)', fontFamily: 'var(--font-serif)', fontSize: 13, resize: 'vertical' }}
            />
          </div>
          <div className="field">
            <label>Background Vow — a primary motivation or goal, sworn months or years ago (always epic rank; you don't roll to swear it, it's already part of your history)</label>
            <textarea
              value={backgroundVow}
              onChange={(e) => setBackgroundVow(e.target.value)}
              placeholder="e.g. I vow to discover what happened to my sister's expedition."
              rows={2}
              style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, color: 'var(--text)', fontFamily: 'var(--font-serif)', fontSize: 13, resize: 'vertical' }}
            />
          </div>
          <div className="field">
            <label>Stats (standard array: 3 / 2 / 2 / 1 / 1 — assign each value to one stat)</label>
            <div className="stat-grid">
              {(Object.keys(stats) as (keyof Stats)[]).map((key) => (
                <div className="stat-cell" key={key}>
                  <div className="stat-label">{key}</div>
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={stats[key]}
                    onChange={(e) => setStat(key, Number(e.target.value))}
                    style={{ width: '100%', textAlign: 'center', background: 'transparent', border: 'none', fontFamily: 'var(--font-mono)', fontSize: 16 }}
                  />
                </div>
              ))}
            </div>
            {!statsValid && (
              <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>
                Must be exactly the values 3, 2, 2, 1, 1 -- one per stat, in any order. Currently: {Object.values(stats).sort((a, b) => b - a).join(', ')}.
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button className="icon-btn" style={{ borderColor: 'var(--accent-copper)', color: 'var(--accent-copper)' }} onClick={goToPaths} disabled={!statsValid}>
              Next: Choose Two Paths
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="modal-backdrop">
        <div className="modal" style={{ width: 560, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2>Choose Two Paths ({paths.length}/2)</h2>
            <button className="icon-btn" style={{ fontSize: 10 }} onClick={onOpenSettings}>
              Settings
            </button>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -8, marginBottom: 12 }}>
            Paths represent background, career, training, and skills. Pick two that fit an emerging concept for your character.
          </p>
          <div style={{ overflowY: 'auto', flex: 1, marginBottom: 12 }}>
            {loadingAssets && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>Loading asset catalog…</p>}
            {pathCategory?.assets.map((a) => {
              const isSelected = paths.includes(a.id);
              const disabled = !isSelected && paths.length >= 2;
              return (
                <button
                  key={a.id}
                  onClick={() => togglePath(a.id)}
                  disabled={disabled}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: isSelected ? 'rgba(0, 179, 200, 0.12)' : 'var(--bg-raised)',
                    border: `1px solid ${isSelected ? 'var(--accent-cyan)' : 'var(--border)'}`,
                    borderLeft: `3px solid ${a.color || 'var(--border)'}`,
                    borderRadius: 4,
                    padding: '8px 10px',
                    marginBottom: 6,
                    color: disabled ? 'var(--text-dim)' : 'var(--text)',
                    opacity: disabled ? 0.5 : 1,
                    fontFamily: 'var(--font-serif)',
                  }}
                >
                  <div style={{ fontWeight: 'bold', marginBottom: 2 }}>{a.name}</div>
                  {a.abilities[0] && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{a.abilities[0]}</div>}
                </button>
              );
            })}
          </div>
          <div className="modal-actions">
            <button className="icon-btn" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="icon-btn" style={{ borderColor: 'var(--accent-copper)', color: 'var(--accent-copper)' }} disabled={paths.length !== 2} onClick={() => setStep(3)}>
              Next: Choose Final Asset
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 560, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2>Choose Your Final Asset</h2>
          <button className="icon-btn" style={{ fontSize: 10 }} onClick={onOpenSettings}>
            Settings
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -8, marginBottom: 12 }}>
          One more, from any of these categories — not limited to Path this time.
        </p>
        <div style={{ overflowY: 'auto', flex: 1, marginBottom: 12 }}>
          {finalAssetCategories.map((cat) => (
            <div key={cat.category} style={{ marginBottom: 14 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-cyan)', textTransform: 'uppercase', marginBottom: 6 }}>
                {cat.category}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {cat.assets.map((a) => {
                  const isSelected = finalAsset === a.id;
                  return (
                    <button
                      key={a.id}
                      onClick={() => setFinalAsset(a.id)}
                      style={{
                        textAlign: 'left',
                        background: isSelected ? 'rgba(0, 179, 200, 0.12)' : 'var(--bg-raised)',
                        border: `1px solid ${isSelected ? 'var(--accent-cyan)' : 'var(--border)'}`,
                        borderLeft: `3px solid ${a.color || 'var(--border)'}`,
                        borderRadius: 4,
                        padding: '8px 10px',
                        color: 'var(--text)',
                        fontFamily: 'var(--font-serif)',
                      }}
                    >
                      <div style={{ fontWeight: 'bold', marginBottom: 2 }}>{a.name}</div>
                      {a.abilities[0] && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{a.abilities[0]}</div>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="icon-btn" onClick={() => setStep(2)}>
            Back
          </button>
          <button
            className="icon-btn"
            style={{ borderColor: 'var(--accent-copper)', color: 'var(--accent-copper)' }}
            disabled={!finalAsset || submitting}
            onClick={() => {
              setSubmitting(true);
              onCreate(name || 'Unnamed Ironsworn', stats, [...paths, ...(finalAsset ? [finalAsset] : [])], { callsign, pronouns, description }, backgroundVow);
            }}
          >
            {submitting ? 'Beginning…' : 'Begin Campaign'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Shown whenever the GM's own turn defers a real mechanical decision to the player (see
 * present_choice in tools.cjs / systemPrompt.cjs) instead of picking on their behalf -- e.g.
 * Secure an Advantage's momentum-or-bonus choice, Sojourn's pick-two-recover-moves, Fulfill Your
 * Vow's miss recommit-or-forsake. Blocks the normal composer until answered, since resuming
 * requires a real response to resolve the specific tool call that's waiting on one.
 */
export function ChoiceModal({ choice, onChoose }: { choice: PendingChoice; onChoose: (text: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [customText, setCustomText] = useState('');

  const pick = async (text: string) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      await onChoose(text.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 440 }}>
        <h2>{choice.prompt}</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10, marginBottom: choice.allowCustom ? 16 : 4 }}>
          {choice.options.map((opt, i) => (
            <button
              key={i}
              className="icon-btn"
              style={{ textAlign: 'left', padding: '8px 10px', borderColor: 'var(--accent-copper)', color: 'var(--text)', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
              disabled={busy}
              onClick={() => pick(opt.label)}
            >
              <span style={{ fontWeight: 'bold' }}>{opt.label}</span>
              {opt.description && <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 'normal' }}>{opt.description}</span>}
            </button>
          ))}
        </div>
        {choice.allowCustom && (
          <div className="field">
            <label>Or answer in your own words</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') pick(customText);
                }}
                style={{ flex: 1 }}
              />
              <button className="icon-btn" disabled={busy || !customText.trim()} onClick={() => pick(customText)}>
                {busy ? '…' : 'Submit'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
