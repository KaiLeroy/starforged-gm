import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CampaignState, FeatureType, SectorFeature } from './types';
import { GeneratedImage, InlineImageGenerate } from './components';

// Must match SECTOR_COLS / SECTOR_ROWS in electron/engine/state.cjs.
const COLS = 12;
const ROWS = 8;
const HEX_SIZE = 30; // center-to-corner radius, in SVG user units

const FEATURE_COLORS: Record<FeatureType, string> = {
  star: '#c98a3e',
  planet: '#00b3c8',
  settlement: '#3f9250',
  derelict: '#c5533f',
  vault: '#6b52ec',
  starship: '#9aa3ad',
  npc: '#4053c9',
  creature: '#7438b8',
  faction: '#d68f00',
  sighting: '#676767',
  other: '#8e97ac',
};

const FEATURE_TYPES: FeatureType[] = ['star', 'planet', 'settlement', 'derelict', 'vault', 'starship', 'npc', 'creature', 'faction', 'sighting', 'other'];

function hexCenter(col: number, row: number) {
  const w = Math.sqrt(3) * HEX_SIZE;
  const vertStep = HEX_SIZE * 1.5;
  const x = w * col + (row % 2 === 1 ? w / 2 : 0) + w / 2 + 4;
  const y = vertStep * row + HEX_SIZE + 4;
  return { x, y };
}

function hexPoints(cx: number, cy: number) {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90);
    pts.push(`${cx + HEX_SIZE * Math.cos(angle)},${cy + HEX_SIZE * Math.sin(angle)}`);
  }
  return pts.join(' ');
}

function primaryColor(featureTypes: FeatureType[]): string | null {
  if (featureTypes.length === 0) return null;
  return FEATURE_COLORS[featureTypes[0]];
}

export function SectorView({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [featureType, setFeatureType] = useState<FeatureType>('star');
  const [featureName, setFeatureName] = useState('');
  const [featureDesc, setFeatureDesc] = useState('');
  const [showNewSector, setShowNewSector] = useState(false);
  const [newSectorName, setNewSectorName] = useState('');
  const [passageTarget, setPassageTarget] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startPanX: number; startPanY: number; dragged: boolean } | null>(null);
  const justDraggedRef = useRef(false);

  const { width, height } = useMemo(() => {
    const c = hexCenter(COLS - 1, ROWS - 1);
    return { width: c.x + Math.sqrt(3) * HEX_SIZE, height: c.y + HEX_SIZE * 1.5 };
  }, []);

  const MIN_ZOOM = 0.6;
  const MAX_ZOOM = 2.5;

  const clampPan = (x: number, y: number, z: number) => {
    const viewW = width / z;
    const viewH = height / z;
    // A generous overscroll margin so a hex near the edge can still be panned toward the center,
    // without letting the view wander off into empty space indefinitely.
    const marginX = viewW * 0.4;
    const marginY = viewH * 0.4;
    return {
      x: Math.max(-marginX, Math.min(width - viewW + marginX, x)),
      y: Math.max(-marginY, Math.min(height - viewH + marginY, y)),
    };
  };

  const zoomBy = (factor: number) => {
    setZoom((z) => {
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z * factor));
      setPan((p) => {
        // Keep the current view's center point stable while the zoom level changes.
        const oldViewW = width / z;
        const oldViewH = height / z;
        const newViewW = width / newZoom;
        const newViewH = height / newZoom;
        const centerX = p.x + oldViewW / 2;
        const centerY = p.y + oldViewH / 2;
        return clampPan(centerX - newViewW / 2, centerY - newViewH / 2, newZoom);
      });
      return newZoom;
    });
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return; // left button (or primary touch) only
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPanX: pan.x, startPanY: pan.y, dragged: false };
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragRef.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const unitsPerPixelX = width / zoom / rect.width;
    const unitsPerPixelY = height / zoom / rect.height;
    const screenDx = e.clientX - dragRef.current.startX;
    const screenDy = e.clientY - dragRef.current.startY;
    if (Math.abs(screenDx) > 3 || Math.abs(screenDy) > 3) dragRef.current.dragged = true;
    if (!dragRef.current.dragged) return;
    const next = clampPan(dragRef.current.startPanX - screenDx * unitsPerPixelX, dragRef.current.startPanY - screenDy * unitsPerPixelY, zoom);
    setPan(next);
  };

  const handleMouseUp = () => {
    if (dragRef.current?.dragged) {
      justDraggedRef.current = true;
      // Cleared on the next tick, after the resulting click event (if any) has had a chance to
      // check it and suppress hex selection -- click fires after mouseup, so clearing here would
      // erase the flag before the check that needs it.
      setTimeout(() => {
        justDraggedRef.current = false;
      }, 0);
    }
    dragRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  };

  const sector = state.sectors[state.currentSectorId];
  const cells = sector.cells;
  const selectedCell = selected ? cells[selected] : null;
  const passages = sector.passages || [];
  const selectedPassages = selected ? passages.filter((p) => p.fromCell === selected || p.toCell === selected) : [];

  const selectCell = (id: string) => {
    if (justDraggedRef.current) return; // suppress accidental hex selection right after a pan drag
    setSelected(id);
    setNameDraft(cells[id]?.name || '');
    setNotesDraft(cells[id]?.notes || '');
  };

  const saveCellInfo = async () => {
    if (!selected) return;
    const next = await window.game.updateSectorCell({ campaignId, cell: selected, name: nameDraft, notes: notesDraft });
    onStateChange(next);
  };

  const addFeature = async () => {
    if (!selected || !featureName.trim()) return;
    const next = await window.game.addSectorFeature({ campaignId, cell: selected, type: featureType, name: featureName.trim(), description: featureDesc.trim() });
    onStateChange(next);
    setFeatureName('');
    setFeatureDesc('');
  };

  const removeFeature = async (feature: SectorFeature) => {
    if (!selected) return;
    const next = await window.game.removeSectorFeature({ campaignId, cell: selected, featureId: feature.id });
    onStateChange(next);
  };

  const addPassage = async () => {
    if (!selected) return;
    // Empty passageTarget means "leads off the edge of the map" -- the omit-to_cell case, same
    // as the AI tool's own optional to_cell.
    const next = await window.game.createPassage({ campaignId, fromCell: selected, toCell: passageTarget.trim() || undefined });
    onStateChange(next);
    setPassageTarget('');
  };

  const removePassageHandler = async (passageId: string) => {
    const next = await window.game.removePassage({ campaignId, passageId });
    onStateChange(next);
  };

  const setAsCurrent = async () => {
    if (!selected) return;
    const next = await window.game.setSectorCurrent({ campaignId, cell: selected });
    onStateChange(next);
  };

  const saveSectorHeader = async (patch: { name?: string; region?: string; factionControl?: string; notes?: string }) => {
    const next = await window.game.setSectorInfo({ campaignId, ...patch });
    onStateChange(next);
  };

  const switchTo = async (sectorId: string) => {
    const next = await window.game.switchSector({ campaignId, sectorId });
    onStateChange(next);
    setSelected(null);
    resetView();
  };

  const createAndSwitch = async () => {
    if (!newSectorName.trim()) return;
    const next = await window.game.createSector({ campaignId, name: newSectorName.trim() });
    const created = Object.values(next.sectors).find((s) => s.name === newSectorName.trim() && s.id !== state.currentSectorId);
    onStateChange(next);
    if (created) await switchTo(created.id);
    setNewSectorName('');
    setShowNewSector(false);
  };

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '14px 20px 0', flexWrap: 'wrap' }}>
          {Object.values(state.sectors).map((s) => (
            <button
              key={s.id}
              className={`view-tab ${s.id === state.currentSectorId ? 'active' : ''}`}
              onClick={() => switchTo(s.id)}
            >
              {s.name || 'Unnamed sector'}
            </button>
          ))}
          {showNewSector ? (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                value={newSectorName}
                onChange={(e) => setNewSectorName(e.target.value)}
                placeholder="New sector name"
                style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 12, color: 'var(--text)' }}
              />
              <button className="icon-btn" onClick={createAndSwitch} disabled={!newSectorName.trim()}>
                Create
              </button>
              <button className="icon-btn" onClick={() => setShowNewSector(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button className="icon-btn" onClick={() => setShowNewSector(true)}>
              + New Sector
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, padding: '10px 20px 6px' }}>
          <SectorHeaderField label="Sector" value={sector.name} onCommit={(v) => saveSectorHeader({ name: v })} />
          <SectorHeaderField label="Region" value={sector.region} onCommit={(v) => saveSectorHeader({ region: v })} />
          <SectorHeaderField label="Faction / Control" value={sector.factionControl} onCommit={(v) => saveSectorHeader({ factionControl: v })} />
        </div>
        <div style={{ padding: '0 20px 6px' }}>
          <SectorHeaderField label="Sector notes (overarching hook, e.g. a rolled Sector Trouble)" value={sector.notes} onCommit={(v) => saveSectorHeader({ notes: v })} />
        </div>

        <div style={{ flex: 1, overflow: 'hidden', padding: '4px 20px 20px', position: 'relative' }}>
          <div style={{ position: 'absolute', top: 8, right: 28, zIndex: 1, display: 'flex', gap: 4 }}>
            <button className="icon-btn" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => zoomBy(1 / 1.3)} title="Zoom out">
              −
            </button>
            <button className="icon-btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={resetView} title="Reset view">
              {Math.round(zoom * 100)}%
            </button>
            <button className="icon-btn" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => zoomBy(1.3)} title="Zoom in">
              +
            </button>
          </div>
          <svg
            ref={svgRef}
            viewBox={`${pan.x} ${pan.y} ${width / zoom} ${height / zoom}`}
            style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab', touchAction: 'none' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onWheel={handleWheel}
          >
            {passages.map((p) => {
              const from = hexCenter(...p.fromCell.split(',').map(Number) as [number, number]);
              // A passage to the map edge (toCell null) is drawn as a short stub pointing outward
              // from its one real endpoint, toward whichever edge of the grid is closest -- rather
              // than inventing a fake destination coordinate, which would misleadingly imply a
              // second real location exists.
              let to = from;
              if (p.toCell) {
                to = hexCenter(...p.toCell.split(',').map(Number) as [number, number]);
              } else {
                const [col, row] = p.fromCell.split(',').map(Number);
                const distances: [number, number][] = [
                  [0 - col, 0],
                  [COLS - 1 - col, 0],
                  [0, 0 - row],
                  [0, ROWS - 1 - row],
                ];
                const [dCol, dRow] = distances.reduce((a, b) => (Math.hypot(...a) < Math.hypot(...b) ? a : b));
                const len = Math.hypot(dCol, dRow) || 1;
                to = { x: from.x + (dCol / len) * HEX_SIZE * 2.2, y: from.y + (dRow / len) * HEX_SIZE * 2.2 };
              }
              const isSelected = selected !== null && (p.fromCell === selected || p.toCell === selected);
              return (
                <line
                  key={p.id}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={isSelected ? 'var(--accent-cyan)' : 'var(--accent-copper)'}
                  strokeWidth={isSelected ? 1.6 : 1}
                  strokeDasharray={p.toCell ? undefined : '3,3'}
                  opacity={isSelected ? 0.85 : 0.45}
                />
              );
            })}
            {Array.from({ length: ROWS }).map((_, row) =>
              Array.from({ length: COLS }).map((__, col) => {
                const id = `${col},${row}`;
                const { x, y } = hexCenter(col, row);
                const cell = cells[id];
                const isCurrent = sector.currentCell === id;
                const isSelected = selected === id;
                const color = cell ? primaryColor(cell.features.map((f) => f.type)) : null;
                const revealed = Boolean(cell);
                return (
                  <g key={id} onClick={() => selectCell(id)} style={{ cursor: 'pointer' }}>
                    <polygon
                      points={hexPoints(x, y)}
                      fill={color ? `${color}33` : revealed ? 'var(--bg-raised)' : 'transparent'}
                      stroke={isSelected ? 'var(--accent-cyan)' : color || 'var(--border)'}
                      strokeWidth={isSelected ? 2 : 1}
                    />
                    {isCurrent && (
                      <g>
                        {/* Pulsing outer ring -- draws the eye immediately, distinct from any static hex coloring */}
                        <circle cx={x} cy={y} r={9} fill="none" stroke="var(--accent-copper)" strokeWidth={1.5} opacity={0.8}>
                          <animate attributeName="r" values="7;13;7" dur="2s" repeatCount="indefinite" />
                          <animate attributeName="opacity" values="0.8;0;0.8" dur="2s" repeatCount="indefinite" />
                        </circle>
                        {/* Ship-marker triangle, not a plain dot -- a classic "current position" cartography convention */}
                        <polygon
                          points={`${x},${y - 7} ${x - 5.5},${y + 5} ${x + 5.5},${y + 5}`}
                          fill="var(--accent-copper)"
                          stroke="#16110a"
                          strokeWidth={1.2}
                        />
                      </g>
                    )}
                    {cell?.name && !isCurrent && (
                      <text x={x} y={y + HEX_SIZE - 6} textAnchor="middle" fontSize="7" fontFamily="var(--font-mono)" fill="var(--text-dim)">
                        {cell.name.length > 10 ? cell.name.slice(0, 9) + '…' : cell.name}
                      </text>
                    )}
                  </g>
                );
              })
            )}
          </svg>
        </div>

        <div style={{ display: 'flex', gap: 12, padding: '0 20px 14px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', flexWrap: 'wrap' }}>
          {FEATURE_TYPES.map((t) => (
            <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: FEATURE_COLORS[t], display: 'inline-block' }} />
              {t}
            </span>
          ))}
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 14, height: 0, borderTop: '1px solid var(--accent-copper)', display: 'inline-block' }} />
            charted passage
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 14, height: 0, borderTop: '1px dashed var(--accent-copper)', display: 'inline-block' }} />
            passage to another sector
          </span>
        </div>
      </div>

      <div style={{ width: 320, borderLeft: '1px solid var(--border)', padding: 16, overflowY: 'auto', flexShrink: 0 }}>
        {!selected && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>Click a hex to view or record what's there.</p>}
        {selected && (
          <>
            <p className="panel-title">
              Hex {selected}
              {sector.currentCell === selected ? ' · current' : ''}
            </p>
            {selectedCell?.imageId && (
              <GeneratedImage imageId={selectedCell.imageId} alt={selectedCell.name || selected} style={{ width: '100%', height: 'auto', marginBottom: 10 }} />
            )}
            <div style={{ marginBottom: 10 }}>
              <InlineImageGenerate
                label={selectedCell?.imageId ? 'Regenerate location image' : 'Generate location image'}
                fallbackPrompt={`${selectedCell?.name || 'A location'} in space${selectedCell?.notes ? `, ${selectedCell.notes}` : ''}, sci-fi concept art`}
                composePrompt={() => window.game.composeImagePrompt({ campaignId, kind: 'location', subjectId: selected! })}
                onGenerate={async (prompt) => {
                  const next = await window.game.generateLocationImage({ campaignId, cell: selected, prompt });
                  onStateChange(next);
                }}
              />
            </div>
            <div className="field">
              <label>Name</label>
              <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onBlur={saveCellInfo} placeholder="e.g. Kaross System" />
            </div>
            <div className="field">
              <label>Notes</label>
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                onBlur={saveCellInfo}
                rows={3}
                style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, color: 'var(--text)', fontFamily: 'var(--font-serif)', fontSize: 13, resize: 'vertical' }}
              />
            </div>
            {sector.currentCell !== selected && (
              <button className="icon-btn" style={{ marginBottom: 14 }} onClick={setAsCurrent}>
                Set as current location
              </button>
            )}

            <p className="panel-title">Features</p>
            {(selectedCell?.features.length ?? 0) === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>None recorded yet.</p>}
            {selectedCell?.features.map((f: SectorFeature) => (
              <div key={f.id} className="track-card" style={{ padding: '6px 10px', borderLeft: `3px solid ${FEATURE_COLORS[f.type]}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 12, fontWeight: 'bold' }}>{f.name}</span>
                  <button className="icon-btn" style={{ padding: '1px 6px', fontSize: 9 }} onClick={() => removeFeature(f)}>
                    ✕
                  </button>
                </div>
                <div className="track-meta">{f.type}</div>
                {f.description && <div style={{ fontSize: 12, marginTop: 2 }}>{f.description}</div>}
              </div>
            ))}

            <p className="panel-title" style={{ marginTop: 14 }}>
              Add a feature
            </p>
            <div className="field">
              <select
                value={featureType}
                onChange={(e) => setFeatureType(e.target.value as FeatureType)}
                style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12 }}
              >
                {FEATURE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <input value={featureName} onChange={(e) => setFeatureName(e.target.value)} placeholder="Name" />
            </div>
            <div className="field">
              <textarea
                value={featureDesc}
                onChange={(e) => setFeatureDesc(e.target.value)}
                placeholder="Description (optional)"
                rows={2}
                style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, color: 'var(--text)', fontFamily: 'var(--font-serif)', fontSize: 13, resize: 'vertical' }}
              />
            </div>
            <button className="icon-btn" style={{ borderColor: 'var(--accent-cyan)', color: 'var(--accent-cyan)' }} onClick={addFeature} disabled={!featureName.trim()}>
              Add feature
            </button>

            <p className="panel-title" style={{ marginTop: 14 }}>
              Passages
            </p>
            {selectedPassages.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>None charted from here yet.</p>}
            {selectedPassages.map((p) => {
              const otherCell = p.fromCell === selected ? p.toCell : p.fromCell;
              const otherLabel = otherCell ? cells[otherCell]?.name || otherCell : 'edge of map (another sector)';
              return (
                <div key={p.id} className="track-card" style={{ padding: '6px 10px', borderLeft: '3px solid var(--accent-copper)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 12, fontWeight: 'bold' }}>↔ {otherLabel}</span>
                    <button className="icon-btn" style={{ padding: '1px 6px', fontSize: 9 }} onClick={() => removePassageHandler(p.id)}>
                      ✕
                    </button>
                  </div>
                  {p.notes && <div style={{ fontSize: 12, marginTop: 2 }}>{p.notes}</div>}
                </div>
              );
            })}
            <div className="field" style={{ marginTop: 8 }}>
              <label>Chart a passage to (hex, e.g. "4,3" — leave blank for "leads off the map")</label>
              <input value={passageTarget} onChange={(e) => setPassageTarget(e.target.value)} placeholder="col,row or blank" />
            </div>
            <button className="icon-btn" style={{ borderColor: 'var(--accent-copper)', color: 'var(--accent-copper)' }} onClick={addPassage}>
              Add passage
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SectorHeaderField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="field" style={{ flex: 1, marginBottom: 0 }}>
      <label>{label}</label>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && onCommit(draft)} />
    </div>
  );
}
