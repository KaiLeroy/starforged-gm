import React, { useState } from 'react';
import type { CampaignState, Config } from './types';
import { TruthsView } from './TruthsView';
import { SettingsModal } from './components';

export function SessionZeroTruths({
  state,
  campaignId,
  onStateChange,
  onContinue,
  onImportCharacter,
  importError,
  config,
  onSaveConfig,
}: {
  state: CampaignState;
  campaignId: string;
  onStateChange: (s: CampaignState) => void;
  onContinue: () => void;
  onImportCharacter: () => void;
  importError: string | null;
  config: Config;
  onSaveConfig: (c: Config) => Promise<void>;
}) {
  const establishedCount = Object.keys(state.truths).length;
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="app-shell" style={{ gridTemplateColumns: '1fr', gridTemplateAreas: '"header" "main"' }}>
      <div className="topbar">
        <span className="campaign-name">Session Zero — Step 1 of 2: Choose Your Truths</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="icon-btn" onClick={onImportCharacter} title="Load a previously-exported character + truths, skipping this and character creation entirely">
            Import Character
          </button>
          <button className="icon-btn" onClick={() => setShowSettings(true)}>
            Settings
          </button>
          <button className="icon-btn" onClick={onContinue}>
            {establishedCount === 0 ? 'Skip for now' : 'Continue to Character Creation'}
          </button>
        </div>
      </div>
      {showSettings && <SettingsModal config={config} onSave={(c) => { onSaveConfig(c); setShowSettings(false); }} onClose={() => setShowSettings(false)} />}
      <div style={{ gridArea: 'main', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {importError && (
          <div className="track-card" style={{ margin: '14px 28px 0', padding: '10px 14px', maxWidth: 760, borderLeft: '3px solid var(--danger)' }}>
            <strong style={{ color: 'var(--danger)' }}>Character import failed:</strong>
            <span style={{ color: 'var(--text-dim)' }}> {importError}</span>
          </div>
        )}
        {!config.apiKey && (
          <div className="track-card" style={{ margin: '14px 28px 0', padding: '10px 14px', maxWidth: 760, borderLeft: '3px solid var(--accent-copper)' }}>
            <strong style={{ color: 'var(--accent-copper)' }}>No OpenRouter API key configured yet.</strong>
            <span style={{ color: 'var(--text-dim)' }}> The GM won't be able to respond once character creation finishes -- set one up now via Settings, above.</span>
          </div>
        )}
        <p style={{ padding: '14px 28px 0', fontSize: 12, color: 'var(--text-dim)', maxWidth: 760 }}>
          In the book, this comes before character creation — the truths you establish here (what
          happened to your people, what Iron and vows mean, whether there's magic or AI or
          horrors) shape what kind of character makes sense to play. You don't need to fill in all
          14 now; even two or three is enough to continue. You can always add more later, in the
          Truths tab.
        </p>
        <div style={{ flex: 1, minHeight: 0 }}>
          <TruthsView state={state} campaignId={campaignId} onStateChange={onStateChange} />
        </div>
      </div>
    </div>
  );
}
