import React, { useEffect, useState } from 'react';
import type { CampaignSummary, Config } from './types';
import { SettingsModal } from './components';

function genCampaignId() {
  return `campaign-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function CampaignSelect({ onChoose, config, onSaveConfig }: { onChoose: (campaignId: string) => void; config: Config; onSaveConfig: (c: Config) => Promise<void> }) {
  const [summaries, setSummaries] = useState<CampaignSummary[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const refresh = () => window.game.getCampaignSummaries().then(setSummaries);
  useEffect(() => {
    refresh();
  }, []);

  const remove = async (campaignId: string) => {
    await window.game.deleteCampaign(campaignId);
    setConfirmDelete(null);
    refresh();
  };

  const startRename = (s: CampaignSummary) => {
    setRenamingId(s.campaignId);
    setRenameDraft(s.campaignName || '');
  };

  const saveRename = async (campaignId: string) => {
    await window.game.renameCampaign({ campaignId, name: renameDraft.trim() });
    setRenamingId(null);
    refresh();
  };

  const duplicate = async (campaignId: string) => {
    setBusyId(campaignId);
    try {
      await window.game.duplicateCampaign({ campaignId });
      refresh();
    } finally {
      setBusyId(null);
    }
  };

  const exportOne = async (campaignId: string) => {
    setBusyId(campaignId);
    try {
      await window.game.exportCampaign({ campaignId });
    } finally {
      setBusyId(null);
    }
  };

  const exportStoryOne = async (campaignId: string) => {
    setBusyId(campaignId);
    try {
      await window.game.exportCampaignStory({ campaignId });
    } finally {
      setBusyId(null);
    }
  };

  const importOne = async () => {
    setImportError(null);
    try {
      const result = await window.game.importCampaign();
      if (!result.canceled) refresh();
    } catch (e: any) {
      setImportError(e?.message || 'Could not import that file.');
    }
  };

  if (summaries === null) {
    return (
      <div className="app-shell">
        <div className="empty-state" style={{ gridColumn: '1 / -1', gridRow: '1 / -1', margin: 'auto' }}>
          Loading campaigns…
        </div>
      </div>
    );
  }

  // Prefers lastPlayedAt for the same reason the displayed text does -- otherwise briefly
  // opening a manual-edit view (Codex, Combat) on one campaign could sort it above another
  // actually played more recently, telling a different story than the text right below it.
  const sortKey = (s: CampaignSummary) => s.lastPlayedAt || s.updatedAt || '';
  const sorted = [...summaries].sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

  return (
    <div className="app-shell" style={{ gridTemplateColumns: '1fr', gridTemplateAreas: '"header" "main"' }}>
      <div className="topbar">
        <span className="campaign-name">Starforged Solo GM</span>
        <button className="icon-btn" style={{ fontSize: 11 }} onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </div>
      {showSettings && <SettingsModal config={config} onSave={(c) => { onSaveConfig(c); setShowSettings(false); }} onClose={() => setShowSettings(false)} />}
      <div style={{ gridArea: 'main', display: 'flex', justifyContent: 'center', padding: '40px 20px', overflowY: 'auto' }}>
        <div style={{ width: 560 }}>
          {!config.apiKey && (
            <div className="track-card" style={{ padding: '10px 14px', marginBottom: 16, borderLeft: '3px solid var(--accent-copper)' }}>
              <strong style={{ color: 'var(--accent-copper)' }}>No OpenRouter API key configured yet.</strong>
              <span style={{ color: 'var(--text-dim)' }}> The GM can't respond until one's set. </span>
              <button className="icon-btn" style={{ fontSize: 11, marginLeft: 4 }} onClick={() => setShowSettings(true)}>
                Open Settings
              </button>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <p className="panel-title" style={{ fontSize: 13 }}>
              Your Campaigns
            </p>
            <button className="icon-btn" style={{ fontSize: 11 }} onClick={importOne}>
              Import…
            </button>
          </div>
          {importError && <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: -8, marginBottom: 10 }}>{importError}</p>}
          {sorted.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 20 }}>No campaigns yet — start your first one below.</p>}
          {sorted.map((s) => (
            <div key={s.campaignId} className="track-card" style={{ padding: '12px 14px', marginBottom: 8 }}>
              {renamingId === s.campaignId ? (
                <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    placeholder={s.name || 'Unnamed Ironsworn'}
                    style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px', fontSize: 13, color: 'var(--text)' }}
                  />
                  <button className="icon-btn" style={{ fontSize: 10 }} onClick={() => saveRename(s.campaignId)}>
                    Save
                  </button>
                  <button className="icon-btn" style={{ fontSize: 10 }} onClick={() => setRenamingId(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <button
                    onClick={() => onChoose(s.campaignId)}
                    style={{ background: 'none', border: 'none', textAlign: 'left', flex: 1, cursor: 'pointer', color: 'var(--text)' }}
                  >
                    <div style={{ fontSize: 15, fontWeight: 'bold' }}>
                      {s.campaignName || s.name || 'Unnamed Ironsworn'}
                      {s.campaignName && s.name && <span style={{ fontWeight: 'normal', color: 'var(--text-dim)', fontSize: 12 }}> — {s.name}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                      {s.sectorName ? `${s.sectorName} · ` : ''}
                      {s.lastPlayedAt
                        ? `Last played ${new Date(s.lastPlayedAt).toLocaleString()}`
                        : s.updatedAt
                          ? `Created ${new Date(s.updatedAt).toLocaleString()}`
                          : ''}
                    </div>
                  </button>
                  {confirmDelete === s.campaignId ? (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="icon-btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => remove(s.campaignId)}>
                        Confirm delete
                      </button>
                      <button className="icon-btn" onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="icon-btn" style={{ fontSize: 10 }} onClick={() => startRename(s)} title="Rename">
                        ✎
                      </button>
                      <button className="icon-btn" style={{ fontSize: 10 }} onClick={() => duplicate(s.campaignId)} disabled={busyId === s.campaignId} title="Duplicate">
                        ⧉
                      </button>
                      <button className="icon-btn" style={{ fontSize: 10 }} onClick={() => exportOne(s.campaignId)} disabled={busyId === s.campaignId} title="Export to a file">
                        ↓
                      </button>
                      <button className="icon-btn" style={{ fontSize: 10 }} onClick={() => exportStoryOne(s.campaignId)} disabled={busyId === s.campaignId} title="Export as a readable story (Markdown) -- for sharing or reading, not re-importing">
                        Story
                      </button>
                      <button className="icon-btn" onClick={() => setConfirmDelete(s.campaignId)}>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <button
            className="icon-btn"
            style={{ borderColor: 'var(--accent-copper)', color: 'var(--accent-copper)', width: '100%', padding: '10px 0', marginTop: 12 }}
            onClick={() => onChoose(genCampaignId())}
          >
            + Start New Campaign
          </button>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 10 }}>
            Export/Import save the campaign's mechanics and story, but not generated images -- those live as separate files and won't travel with the export. Story exports as a plain, readable document instead -- for sharing or reading, not re-importing.
          </p>
        </div>
      </div>
    </div>
  );
}

