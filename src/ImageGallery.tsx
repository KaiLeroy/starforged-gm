import React, { useState } from 'react';
import type { CampaignState } from './types';
import { GeneratedImage } from './components';

interface GalleryEntry {
  imageId: string;
  label: string;
  category: string;
}

function collectAllImages(state: CampaignState): GalleryEntry[] {
  const entries: GalleryEntry[] = [];

  if (state.character.portraitImageId) {
    entries.push({ imageId: state.character.portraitImageId, label: state.character.name || 'Unnamed Ironsworn', category: 'Portrait' });
  }

  for (const c of state.connections) {
    if (c.imageId) entries.push({ imageId: c.imageId, label: c.name, category: 'Connection' });
  }

  for (const sector of Object.values(state.sectors)) {
    for (const [cellId, cell] of Object.entries(sector.cells)) {
      if (cell.imageId) {
        entries.push({ imageId: cell.imageId, label: `${cell.name || 'Unnamed hex'} (${cellId})`, category: `Location — ${sector.name || 'unnamed sector'}` });
      }
    }
  }

  for (const i of state.illustrations) {
    entries.push({ imageId: i.imageId, label: i.caption || 'Untitled', category: 'Illustration' });
  }

  return entries;
}

export function ImageGallery({ state, campaignId, onStateChange, onClose }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void; onClose: () => void }) {
  const entries = collectAllImages(state);
  const [lightbox, setLightbox] = useState<GalleryEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const deleteEntry = async (imageId: string) => {
    setBusy(true);
    try {
      const next = await window.game.deleteImage({ campaignId, imageId });
      onStateChange(next);
      setConfirmDelete(null);
      if (lightbox?.imageId === imageId) setLightbox(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <h2>Image Gallery</h2>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -8, marginBottom: 12 }}>
          Every image generated so far for this campaign, in one place -- {entries.length} total.
        </p>

        {entries.length === 0 ? (
          <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>Nothing generated yet. Portraits, location art, and illustrations will show up here as you create them.</p>
        ) : (
          <div style={{ overflowY: 'auto', flex: 1, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {entries.map((entry, i) => (
              <div key={`${entry.imageId}-${i}`} style={{ position: 'relative', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                <button
                  onClick={() => setLightbox(entry)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', overflow: 'hidden', textAlign: 'left', width: '100%', display: 'block' }}
                >
                  <GeneratedImage imageId={entry.imageId} alt={entry.label} style={{ width: '100%', height: 120, display: 'block' }} />
                  <div style={{ padding: '6px 8px' }}>
                    <div style={{ fontSize: 11, fontWeight: 'bold', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.label}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{entry.category}</div>
                  </div>
                </button>
                {confirmDelete === entry.imageId ? (
                  <div style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 2 }}>
                    <button
                      className="icon-btn"
                      style={{ fontSize: 10, padding: '2px 6px', borderColor: 'var(--danger)', color: 'var(--danger)', background: 'var(--bg-panel)' }}
                      onClick={() => deleteEntry(entry.imageId)}
                      disabled={busy}
                    >
                      Confirm
                    </button>
                    <button className="icon-btn" style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-panel)' }} onClick={() => setConfirmDelete(null)}>
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(entry.imageId)}
                    title="Delete this image"
                    style={{ position: 'absolute', top: 4, right: 4, fontSize: 11, padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-panel)', color: 'var(--text-dim)', cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button className="icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {lightbox && (
        <div className="modal-backdrop" style={{ zIndex: 1000 }} onClick={() => setLightbox(null)}>
          <div style={{ maxWidth: '85vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
            <GeneratedImage imageId={lightbox.imageId} alt={lightbox.label} style={{ maxWidth: '85vw', maxHeight: '75vh', width: 'auto', height: 'auto' }} />
            <p style={{ color: 'var(--text)', marginTop: 10, fontSize: 13 }}>
              {lightbox.label} <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>· {lightbox.category}</span>
            </p>
            <div style={{ display: 'flex', gap: 6 }}>
              {confirmDelete === lightbox.imageId ? (
                <>
                  <button className="icon-btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => deleteEntry(lightbox.imageId)} disabled={busy}>
                    Confirm delete
                  </button>
                  <button className="icon-btn" onClick={() => setConfirmDelete(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="icon-btn" onClick={() => setConfirmDelete(lightbox.imageId)}>
                    Delete
                  </button>
                  <button className="icon-btn" onClick={() => setLightbox(null)}>
                    Close
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
