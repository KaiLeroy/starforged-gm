import React, { useEffect, useRef, useState } from 'react';
import type { CampaignRecord, ChatEvent, Config, MoveSummary, Stats, UpdaterStatus } from './types';
import { CharacterSheet, ChatLog, Composer, NewCampaignModal, SettingsModal } from './components';
import { DisplayMessage, TxEvent, parseDisplayMessages } from './utils';
import { SectorView } from './SectorView';
import { TruthsView } from './TruthsView';
import { CodexView } from './CodexView';
import { CombatView } from './CombatView';
import { SessionZeroTruths } from './SessionZeroTruths';
import { MovesPanel } from './MovesPanel';
import { ImageGallery } from './ImageGallery';
import { CampaignSelect } from './CampaignSelect';

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const saveConfig = async (c: Config) => {
    await window.game.setConfig(c);
    setConfig(c);
  };
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<CampaignRecord | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [prefill, setPrefill] = useState<{ text: string; version: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const autoStartFiredRef = useRef(false);
  const handleSaveConfig = async (c: Config) => {
    await saveConfig(c);
    setShowSettings(false);
  };
  const [showGallery, setShowGallery] = useState(false);
  const [showMoves, setShowMoves] = useState(false);
  const [moves, setMoves] = useState<MoveSummary[]>([]);
  const [view, setView] = useState<'story' | 'sector' | 'truths' | 'codex' | 'combat'>('story');
  const [sending, setSending] = useState(false);
  const [pendingEvents, setPendingEvents] = useState<TxEvent[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sessionZeroTruthsDone, setSessionZeroTruthsDone] = useState(false);
  const [importCharacterError, setImportCharacterError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdaterStatus>({ status: 'idle' });

  // Config and the moves catalog don't depend on which campaign is active.
  useEffect(() => {
    window.game.getConfig().then(setConfig);
    window.game.getMoves().then(setMoves);
  }, []);

  // Background update checking -- once shortly after launch (a short delay so it doesn't
  // compete with the initial campaign load), then periodically for anyone who leaves the app
  // open a long time (a real possibility for a session-based game). Deliberately no auto-
  // download or auto-install here, matching updater.cjs's own conservative design -- this only
  // ever discovers that an update exists; downloading and installing both stay explicit actions
  // the player takes via the topbar button below, never something that happens on its own.
  useEffect(() => {
    const unsubscribe = window.updater.onStatus(setUpdateStatus);
    const initialCheck = setTimeout(() => window.updater.check(), 5000);
    const periodicCheck = setInterval(() => window.updater.check(), 4 * 60 * 60 * 1000);
    return () => {
      unsubscribe();
      clearTimeout(initialCheck);
      clearInterval(periodicCheck);
    };
  }, []);

  // Load the chosen campaign's state whenever campaignId changes, and subscribe to its chat events.
  useEffect(() => {
    if (!campaignId) return;
    setCampaign(null);
    setSessionZeroTruthsDone(false);
    setCanUndo(false); // undo is ephemeral, in-memory-only on the backend -- never valid across a campaign switch or reload
    autoStartFiredRef.current = false; // scope the auto-start guard to this specific campaign, not the app's whole lifetime
    window.game.getCampaign(campaignId).then(setCampaign);
    const unsubscribe = window.game.onChatEvent((event: ChatEvent & { campaignId: string }) => {
      if (event.campaignId !== campaignId) return;
      if (event.type === 'tool_call') {
        setPendingEvents((prev) => [...prev, { name: event.name, args: event.args, result: null }]);
      } else if (event.type === 'tool_result') {
        setPendingEvents((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].result === null) {
              next[i] = { ...next[i], result: event.result };
              break;
            }
          }
          return next;
        });
      } else if (event.type === 'error') {
        setConnectionError(event.message);
      }
    });
    return unsubscribe;
  }, [campaignId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [campaign, pendingEvents, sending]);

  if (!config) {
    return (
      <div className="app-shell">
        <div className="empty-state" style={{ gridColumn: '1 / -1', gridRow: '1 / -1', margin: 'auto' }}>
          Establishing uplink…
        </div>
      </div>
    );
  }

  if (!campaignId) {
    return <CampaignSelect onChoose={setCampaignId} config={config} onSaveConfig={saveConfig} />;
  }

  if (!campaign) {
    return (
      <div className="app-shell">
        <div className="empty-state" style={{ gridColumn: '1 / -1', gridRow: '1 / -1', margin: 'auto' }}>
          Loading campaign…
        </div>
      </div>
    );
  }

  const needsCharacter = !campaign.state.character.name;

  const handleSend = async (text: string) => {
    setConnectionError(null);
    setSending(true);
    setPendingEvents([]);
    setView('story');
    // Optimistically show the user's message immediately.
    setCampaign((prev) =>
      prev ? { ...prev, messages: [...prev.messages, { role: 'user', content: text }] } : prev
    );
    try {
      const { state } = await window.game.sendMessage(campaignId, text);
      const fresh = await window.game.getCampaign(campaignId);
      setCampaign(fresh);
      setCanUndo(true); // the backend just took a fresh checkpoint before this turn -- Undo/Edit/Regenerate on it are now valid
      void state;
    } catch (err: any) {
      setConnectionError(err?.message || 'Something went wrong reaching OpenRouter.');
      // Deliberately leave canUndo as it was: a "no API key" error happens before the backend
      // even takes a checkpoint, so this attempt didn't change what undo would roll back to.
    } finally {
      setSending(false);
      setPendingEvents([]);
    }
  };

  // Continues a turn present_choice paused -- see InlineChoice and chat:resolve-choice's own doc
  // comment in main.cjs for the full design. Mirrors handleSend's own shape closely (optimistic
  // update, live event streaming, error handling) since it's really the same kind of operation:
  // sending something to the GM and waiting for the turn to actually finish, just resuming an
  // existing one instead of starting a fresh one.
  const handleResolveChoice = async (chosenText: string) => {
    setConnectionError(null);
    setSending(true);
    setPendingEvents([]);
    try {
      await window.game.resolveChoice(campaignId, chosenText);
      const fresh = await window.game.getCampaign(campaignId);
      setCampaign(fresh);
    } catch (err: any) {
      setConnectionError(err?.message || 'Something went wrong resolving that choice.');
    } finally {
      setSending(false);
      setPendingEvents([]);
    }
  };

  // Rolls back to right before the most recent turn (removing that user message and the GM's
  // response to it) without sending anything new. Shared restore logic used by Regenerate and
  // Edit below, both of which call this then immediately act on the returned undoneUserText.
  const handleUndo = async (): Promise<string | null> => {
    if (!campaignId) return null;
    try {
      const { state, messages, undoneUserText } = await window.game.undoLastTurn(campaignId);
      setCampaign((prev) => (prev ? { ...prev, state, messages } : prev));
      setCanUndo(false); // single-level -- that checkpoint is now consumed
      return undoneUserText;
    } catch (err: any) {
      setConnectionError(err?.message || 'Could not undo the last turn.');
      return null;
    }
  };

  // Re-rolls the GM's last response to the same message, discarding whatever it did the first
  // time (any progress/momentum/impact changes from that attempt included) and trying again.
  const handleRegenerate = async () => {
    const text = await handleUndo();
    if (text !== null) await handleSend(text);
  };

  // Undoes the last turn and hands the original text to the composer for editing, rather than
  // resending it unmodified the way Regenerate does.
  const handleEditLast = async () => {
    const text = await handleUndo();
    if (text !== null) setPrefill({ text, version: Date.now() });
  };

  // Applies a previously-exported character + truths (+ optional background vow) to this
  // campaign, skipping Session Zero truths and character creation entirely -- for reusing a
  // character/truths setup instead of rebuilding it from scratch every time. Mirrors
  // handleCreateCharacter's own completion behavior (auto-starting the campaign) below.
  const handleImportCharacter = async () => {
    setImportCharacterError(null);
    try {
      const picked = await window.game.importCharacter();
      if (picked.canceled || !picked.character) return;
      const record = await window.game.applyImportedCharacter({
        campaignId,
        character: picked.character,
        truths: picked.truths || {},
        backgroundVow: picked.backgroundVow || undefined,
      });
      setCampaign(record);
      setSessionZeroTruthsDone(true);
      if (config?.apiKey && !autoStartFiredRef.current) {
        autoStartFiredRef.current = true;
        handleSend('Begin the campaign.');
      }
    } catch (err: any) {
      setImportCharacterError(err?.message || 'Could not import that character.');
    }
  };

  // Session zero: per the rulebook, Choose Your Truths comes before Create Your Character.
  // Show the truths step first for a brand-new campaign, before the character creation modal.
  if (needsCharacter && !sessionZeroTruthsDone) {
    return (
      <SessionZeroTruths
        state={campaign.state}
        campaignId={campaignId}
        onStateChange={(s) => setCampaign((prev) => (prev ? { ...prev, state: s } : prev))}
        onContinue={() => setSessionZeroTruthsDone(true)}
        onImportCharacter={handleImportCharacter}
        importError={importCharacterError}
        config={config}
        onSaveConfig={saveConfig}
      />
    );
  }

  const handleMoveTrigger = (move: MoveSummary, text: string) => {
    const hint = move.options.length > 0 ? ` (options: ${move.options.map((o) => o.using.join('/')).filter(Boolean).join(', ')})` : '';
    const composed = text ? `I want to make the "${move.name}" move. ${text}` : `I want to make the "${move.name}" move.${hint}`;
    handleSend(composed);
  };

  const handleCreateCharacter = async (name: string, stats: Stats, startingAssetIds: string[], flavor: { callsign: string; pronouns: string; description: string }, backgroundVow: string) => {
    const record = await window.game.newCampaign({ campaignId, character: { name, stats, ...flavor }, startingAssetIds, backgroundVow });
    setCampaign(record);
    // Kick off the campaign automatically -- the GM sets up the sector, rolls any truths still
    // needed, and opens the story referencing the character and their background vow, rather
    // than leaving the player staring at an empty chat waiting to type first.
    // Guarded against a repeat call: this function isn't otherwise idempotent (a second call
    // would send a genuinely independent "Begin the campaign." turn -- its own real dice rolls,
    // its own real API cost -- not just redundant UI state), and it currently has no protection
    // beyond the submit button's own disabled state in NewCampaignModal, which guards against a
    // double-click but not against this function being invoked twice for any other reason.
    if (config?.apiKey && !autoStartFiredRef.current) {
      autoStartFiredRef.current = true;
      handleSend('Begin the campaign.');
    }
  };

  const handleExportCharacter = async () => {
    try {
      await window.game.exportCharacter({ campaignId });
    } catch (err: any) {
      setConnectionError(err?.message || 'Could not export the character.');
    }
  };

  const displayMessages: DisplayMessage[] = parseDisplayMessages(campaign.messages as any);

  return (
    <div className="app-shell">
      <div className="topbar">
        <div>
          <span className={`status-dot ${config.apiKey ? 'online' : 'offline'}`} />
          <span className="campaign-name">{campaign.state.character.name || 'No active ironsworn'}</span>
          {' · '}
          <span>{config.model || 'no model set'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="view-tabs">
            <button className={`view-tab ${view === 'story' ? 'active' : ''}`} onClick={() => setView('story')}>
              Story
            </button>
            <button className={`view-tab ${view === 'sector' ? 'active' : ''}`} onClick={() => setView('sector')}>
              Sector
            </button>
            <button className={`view-tab ${view === 'truths' ? 'active' : ''}`} onClick={() => setView('truths')}>
              Truths
            </button>
            <button className={`view-tab ${view === 'codex' ? 'active' : ''}`} onClick={() => setView('codex')}>
              Codex
            </button>
            <button className={`view-tab ${view === 'combat' ? 'active' : ''}`} onClick={() => setView('combat')}>
              Combat
            </button>
          </div>
          <button className="icon-btn" onClick={() => setCampaignId(null)}>
            Campaigns
          </button>
          <button className="icon-btn" onClick={() => setShowMoves((v) => !v)} disabled={needsCharacter}>
            Moves
          </button>
          <button className="icon-btn" onClick={handleExportCharacter} disabled={needsCharacter}>
            Export Character
          </button>
          <button className="icon-btn" onClick={() => setShowGallery(true)}>
            Gallery
          </button>
          {(() => {
            // A single button whose label, styling, and click behavior all follow from the
            // current status -- deliberately low-key (matches every other topbar icon-btn) until
            // there's actually something worth the player's attention, at which point it steps
            // up to the same accent colors used elsewhere for a genuine option (cyan) or a ready-
            // to-go action (the success green also used for burn_momentum's own improved-outcome
            // choice). 'unavailable' covers both a dev build (where this is expected, not an
            // error) and a real failure -- either way, clicking it just tries again.
            if (updateStatus.status === 'checking') {
              return (
                <button className="icon-btn" disabled>
                  Checking…
                </button>
              );
            }
            if (updateStatus.status === 'available') {
              return (
                <button className="icon-btn" style={{ borderColor: 'var(--accent-cyan)', color: 'var(--accent-cyan)' }} onClick={() => window.updater.download()}>
                  Update available (v{updateStatus.version})
                </button>
              );
            }
            if (updateStatus.status === 'downloading') {
              return (
                <button className="icon-btn" disabled>
                  Downloading… {updateStatus.percent ?? 0}%
                </button>
              );
            }
            if (updateStatus.status === 'downloaded') {
              return (
                <button className="icon-btn" style={{ borderColor: 'var(--success)', color: 'var(--success)' }} onClick={() => window.updater.install()}>
                  Restart &amp; install (v{updateStatus.version})
                </button>
              );
            }
            return (
              <button className="icon-btn" onClick={() => window.updater.check()}>
                Check for Updates
              </button>
            );
          })()}
          <button className="icon-btn" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </div>

      <div className="sidebar">
        <CharacterSheet state={campaign.state} campaignId={campaignId} onStateChange={(s) => setCampaign((prev) => (prev ? { ...prev, state: s } : prev))} />
      </div>

      {view === 'story' ? (
        <div className="main-col">
          <div ref={logRef} style={{ flex: 1, overflowY: 'auto' }}>
            <ChatLog
              messages={displayMessages}
              pendingEvents={pendingEvents}
              thinking={sending}
              canUndo={canUndo && !sending}
              onEdit={handleEditLast}
              onRegenerate={handleRegenerate}
              pendingChoice={campaign.pendingChoice}
              onChoose={handleResolveChoice}
            />
          </div>
          {connectionError && (
            <div style={{ padding: '8px 28px', color: 'var(--danger)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {connectionError}
            </div>
          )}
          <Composer onSend={handleSend} disabled={sending || !config.apiKey || needsCharacter || !!campaign.pendingChoice} prefill={prefill ?? undefined} />
        </div>
      ) : view === 'sector' ? (
        <div className="main-col" style={{ padding: 0 }}>
          <SectorView state={campaign.state} campaignId={campaignId} onStateChange={(s) => setCampaign((prev) => (prev ? { ...prev, state: s } : prev))} />
        </div>
      ) : view === 'truths' ? (
        <div className="main-col" style={{ padding: 0 }}>
          <TruthsView state={campaign.state} campaignId={campaignId} onStateChange={(s) => setCampaign((prev) => (prev ? { ...prev, state: s } : prev))} />
        </div>
      ) : view === 'codex' ? (
        <div className="main-col" style={{ padding: 0 }}>
          <CodexView state={campaign.state} campaignId={campaignId} onStateChange={(s) => setCampaign((prev) => (prev ? { ...prev, state: s } : prev))} />
        </div>
      ) : (
        <div className="main-col" style={{ padding: 0 }}>
          <CombatView state={campaign.state} campaignId={campaignId} onStateChange={(s) => setCampaign((prev) => (prev ? { ...prev, state: s } : prev))} />
        </div>
      )}

      {showMoves && <MovesPanel moves={moves} onTrigger={handleMoveTrigger} onClose={() => setShowMoves(false)} />}
      {showGallery && <ImageGallery state={campaign.state} onClose={() => setShowGallery(false)} />}
      {showSettings && <SettingsModal config={config} onSave={handleSaveConfig} onClose={() => setShowSettings(false)} campaignId={campaignId || 'default'} />}
      {needsCharacter && !showSettings && <NewCampaignModal onCreate={handleCreateCharacter} onOpenSettings={() => setShowSettings(true)} />}
    </div>
  );
}
