export interface Stats {
  edge: number;
  heart: number;
  iron: number;
  shadow: number;
  wits: number;
}

export interface Meters {
  health: number;
  spirit: number;
  supply: number;
  integrity: number;
  momentum: number;
  momentum_max: number;
  momentum_min: number;
  momentum_reset: number;
}

export interface Impact {
  name: string;
  marked: boolean;
  permanent: boolean;
}

export type Impacts = Record<string, Impact[]>;

export interface OwnedAsset {
  id: string;
  name: string;
  category: string;
  abilities_unlocked: number[];
  health?: number; // present only for Companion-category assets
  battered?: boolean; // present only for Command Vehicle / Support Vehicle assets
  cursed?: boolean; // present only for Command Vehicle assets (support vehicles can't be cursed)
  resource?: { current: number; max: number; label: string }; // present only for assets with their own tracked resource (Missile Array's ammo, Expanded Hold's cargo, Shields, and others -- see ASSET_RESOURCES in state.cjs)
}

export interface Character {
  name: string;
  callsign: string;
  pronouns: string;
  description: string;
  portraitImageId: string | null;
  stats: Stats;
  statsCorrected: boolean;
  meters: Meters;
  experience: { earned: number; spent: number };
  assets: OwnedAsset[];
  impacts: Impacts;
  aboardVehicleId: string | null; // asset id of whichever vehicle (if any) the character is currently aboard
  combatPosition: 'in_control' | 'bad_spot' | null;
  combatRange: 'close' | 'distance' | null;
}

export interface Clock {
  id: string;
  name: string;
  type: 'campaign' | 'tension';
  segments: 4 | 6 | 8 | 10;
  filled: number;
  linkedTrackId?: string;
}

export interface ProgressTrack {
  id: string;
  name: string;
  type: 'vow' | 'combat' | 'expedition' | 'connection' | 'legacy' | 'scene_challenge';
  rank: 'troublesome' | 'dangerous' | 'formidable' | 'extreme' | 'epic' | null;
  ticks: number;
  legacyCleared?: boolean;
  linkedClockId?: string;
}

export interface StartingAssetCategory {
  category: string;
  assets: { id: string; name: string; color: string | null; abilities: string[] }[];
}

export interface CatalogAsset {
  id: string;
  name: string;
  category: string;
  color: string | null;
  abilities: string[];
}

export type FeatureType = 'star' | 'planet' | 'settlement' | 'derelict' | 'vault' | 'starship' | 'npc' | 'creature' | 'faction' | 'sighting' | 'other';

export interface SectorFeature {
  id: string;
  type: FeatureType;
  name: string;
  description: string;
}

export interface SectorCell {
  name: string;
  notes: string;
  features: SectorFeature[];
  imageId: string | null;
}

export interface Passage {
  id: string;
  fromCell: string;
  toCell: string | null; // null = leads off the edge of the map to another sector
  notes: string;
}

export interface Sector {
  id: string;
  name: string;
  region: string;
  factionControl: string;
  notes: string;
  cells: Record<string, SectorCell>;
  passages: Passage[];
  currentCell: string | null;
}

export interface Illustration {
  id: string;
  imageId: string;
  caption: string;
  createdAt: string;
}

export interface MoveOption {
  text: string;
  using: string[];
}

export interface MoveOutcomes {
  strongHit: string | null;
  weakHit: string | null;
  miss: string | null;
}

export interface MoveSummary {
  id: string;
  name: string;
  category: string;
  color: string | null;
  triggerText: string;
  options: MoveOption[];
  outcomes: MoveOutcomes | null;
}

export interface Truth {
  result: string;
  subtableResult: string | null;
  description: string;
  questStarter: string;
  source: 'rolled' | 'chosen';
}

export interface TruthOption {
  result: string;
  description: string;
  questStarter: string;
  subtable: string[] | null;
}

export interface TruthCategoryCatalog {
  category: string;
  options: TruthOption[];
}

export interface Connection {
  id: string;
  name: string;
  notes: string;
  location: string;
  imageId: string | null;
  rank: 'troublesome' | 'dangerous' | 'formidable' | 'extreme' | 'epic' | null;
  progressTicks: number;
  bonded: boolean;
  role: string | null;
  secondRole: string | null;
  roleBonus: 1 | 2;
  benefitsSuspended: boolean;
}

export interface LogEntry {
  timestamp: string;
  text: string;
}

export interface CampaignState {
  version: number;
  character: Character;
  progressTracks: ProgressTrack[];
  connections: Connection[];
  truths: Record<string, Truth>;
  sectors: Record<string, Sector>;
  currentSectorId: string;
  illustrations: Illustration[];
  clocks: Clock[];
  flags: string[];
  campaignElements: { id: string; text: string }[];
  log: LogEntry[];
  storySummary: { recent: string; distant: string };
}

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_calls?: unknown;
}

export interface PendingChoiceOption {
  label: string;
  description?: string;
}

export interface PendingChoice {
  toolCallId: string;
  prompt: string;
  options: PendingChoiceOption[];
  allowCustom: boolean;
}

export interface CampaignRecord {
  state: CampaignState;
  messages: ChatMessage[];
  pendingChoice: PendingChoice | null;
}

export interface Config {
  apiKey: string;
  model: string;
  comfyUrl: string;
  comfyWorkflow: string;
  temperature: number | null; // null means "use the model's own default" -- deliberately not sent to OpenRouter at all in that case, not forced to some hardcoded value like 1.0
  topP: number | null; // same convention as temperature
  // Player-controlled threshold for when the AI should present move choices instead of assuming
  // one on its own -- expressed in Ask the Oracle's own five-tier odds vocabulary, not a
  // separate scale. 'almost_certain' (the default) is the most permissive: present_choice fires
  // even when the AI is almost certain which move applies. 'small_chance' is the most
  // restrictive: only fires when the AI itself has just a small chance of being right about
  // which single move applies.
  moveChoiceThreshold: 'almost_certain' | 'likely' | '50_50' | 'unlikely' | 'small_chance';
  // Opt-in, off by default. When on, every turn's complete diagnostic record (the exact system
  // prompt the model received, every tool call/result, and the final narration) is appended to
  // a per-campaign debug log file -- useful for telling apart an app bug (wrong or missing
  // guidance in the prompt) from a model failure (the guidance was correct and the model didn't
  // follow it) for any specific turn.
  debugLogging: boolean;
  // Player-editable override for instruction 2's own narrative-style rules (length target,
  // show-don't-tell, no unfilled placeholders) -- undefined/empty means "use the built-in
  // default," fetched via game.getDefaultNarrativeRules() rather than duplicated here, so
  // there's exactly one place that text actually lives. A non-empty value completely replaces
  // the default rather than getting appended to it.
  narrativeRules?: string;
}

export type ChatEvent =
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: Record<string, unknown> }
  | { type: 'assistant_message'; content: string }
  | { type: 'error'; message: string };

export interface CampaignSummary {
  campaignId: string;
  name: string;
  campaignName: string | null;
  sectorName: string;
  updatedAt: string | null;
}

export interface GameBridge {
  getConfig: () => Promise<Config>;
  setConfig: (config: Config) => Promise<boolean>;
  getDefaultNarrativeRules: () => Promise<string>;
  listCampaigns: () => Promise<string[]>;
  getCampaignSummaries: () => Promise<CampaignSummary[]>;
  getCampaign: (campaignId: string) => Promise<CampaignRecord>;
  deleteCampaign: (campaignId: string) => Promise<boolean>;
  renameCampaign: (payload: { campaignId: string; name: string }) => Promise<boolean>;
  duplicateCampaign: (payload: { campaignId: string }) => Promise<{ campaignId: string }>;
  exportCampaign: (payload: { campaignId: string }) => Promise<{ canceled: boolean; filePath?: string }>;
  openExternalLink: (url: string) => Promise<{ opened: boolean; error?: string }>;
  revealDebugLog: (campaignId: string) => Promise<{ opened: boolean; path: string; fileNotYetCreated?: boolean }>;
  importCampaign: () => Promise<{ canceled: boolean; campaignId?: string }>;
  exportCharacter: (payload: { campaignId: string }) => Promise<{ canceled: boolean; filePath?: string }>;
  importCharacter: () => Promise<{ canceled: boolean; character?: Character; truths?: Record<string, Truth>; backgroundVow?: string | null }>;
  applyImportedCharacter: (payload: { campaignId: string; character: Character; truths: Record<string, Truth>; backgroundVow?: string | null }) => Promise<CampaignRecord & { campaignId: string }>;
  newCampaign: (payload: { campaignId?: string; character?: { name: string; stats: Stats; callsign?: string; pronouns?: string; description?: string }; startingAssetIds?: string[]; backgroundVow?: string }) => Promise<CampaignRecord & { campaignId: string }>;
  getStartingAssets: () => Promise<StartingAssetCategory[]>;
  getAssetCatalog: () => Promise<CatalogAsset[]>;
  getMoves: () => Promise<MoveSummary[]>;

  sendMessage: (campaignId: string, text: string) => Promise<{ reply: string; state: CampaignState; pendingChoice: PendingChoice | null }>;
  undoLastTurn: (campaignId: string) => Promise<{ state: CampaignState; messages: ChatMessage[]; undoneUserText: string }>;
  resolveChoice: (campaignId: string, chosenText: string) => Promise<{ reply: string; state: CampaignState; pendingChoice: PendingChoice | null }>;
  composeImagePrompt: (payload: { campaignId: string; kind: 'portrait' | 'connection' | 'location' | 'illustration'; subjectId?: string }) => Promise<string>;

  updateSectorCell: (payload: { campaignId: string; sectorId?: string | null; cell: string; name?: string; notes?: string }) => Promise<CampaignState>;
  addSectorFeature: (payload: { campaignId: string; sectorId?: string | null; cell: string; type: FeatureType; name: string; description?: string }) => Promise<CampaignState>;
  removeSectorFeature: (payload: { campaignId: string; sectorId?: string | null; cell: string; featureId: string }) => Promise<CampaignState>;
  setSectorCurrent: (payload: { campaignId: string; sectorId?: string | null; cell: string }) => Promise<CampaignState>;
  setSectorInfo: (payload: { campaignId: string; sectorId?: string | null; name?: string; region?: string; factionControl?: string; notes?: string }) => Promise<CampaignState>;
  createPassage: (payload: { campaignId: string; sectorId?: string | null; fromCell: string; toCell?: string | null; notes?: string }) => Promise<CampaignState>;
  removePassage: (payload: { campaignId: string; sectorId?: string | null; passageId: string }) => Promise<CampaignState>;
  createSector: (payload: { campaignId: string; name: string; region?: string; factionControl?: string }) => Promise<CampaignState>;
  switchSector: (payload: { campaignId: string; sectorId: string }) => Promise<CampaignState>;

  getTruthsCatalog: () => Promise<TruthCategoryCatalog[]>;
  rollTruth: (payload: { campaignId: string; category: string }) => Promise<{ result: Record<string, unknown>; state: CampaignState }>;
  chooseTruth: (payload: { campaignId: string; category: string; result: string; subtableResult?: string | null; description?: string; questStarter?: string }) => Promise<CampaignState>;
  clearTruth: (payload: { campaignId: string; category: string }) => Promise<CampaignState>;

  addConnection: (payload: { campaignId: string; name: string; notes?: string; location?: string }) => Promise<CampaignState>;
  updateConnection: (payload: { campaignId: string; id: string; name?: string; notes?: string; location?: string }) => Promise<CampaignState>;
  removeConnection: (payload: { campaignId: string; id: string }) => Promise<CampaignState>;

  addLogEntry: (payload: { campaignId: string; text: string }) => Promise<CampaignState>;

  createClock: (payload: { campaignId: string; name: string; type: 'campaign' | 'tension'; segments: 4 | 6 | 8 | 10 }) => Promise<CampaignState>;
  advanceClock: (payload: { campaignId: string; id: string; amount: number }) => Promise<CampaignState>;
  stopClock: (payload: { campaignId: string; id: string }) => Promise<CampaignState>;

  setAboardVehicle: (payload: { campaignId: string; assetId: string | null }) => Promise<CampaignState>;
  setVehicleCondition: (payload: { campaignId: string; assetId: string; condition: 'battered' | 'cursed'; marked: boolean }) => Promise<CampaignState>;
  discardAssetManual: (payload: { campaignId: string; assetId: string }) => Promise<CampaignState>;

  updateCharacterFlavorManual: (payload: { campaignId: string; name?: string; callsign?: string; pronouns?: string; description?: string }) => Promise<CampaignState>;
  updateCharacterStatsManual: (payload: { campaignId: string; stats: Stats }) => Promise<CampaignState>;

  toggleImpactManual: (payload: { campaignId: string; category: string; name: string }) => Promise<CampaignState>;
  addOtherImpactManual: (payload: { campaignId: string; name: string }) => Promise<CampaignState>;
  removeOtherImpactManual: (payload: { campaignId: string; name: string }) => Promise<CampaignState>;

  addFlagManual: (payload: { campaignId: string; text: string }) => Promise<CampaignState>;
  removeFlagManual: (payload: { campaignId: string; text: string }) => Promise<CampaignState>;
  addCampaignElementManual: (payload: { campaignId: string; text: string }) => Promise<CampaignState>;
  removeCampaignElementManual: (payload: { campaignId: string; id: string }) => Promise<CampaignState>;

  testComfyConnection: () => Promise<unknown>;
  getImage: (imageId: string | null) => Promise<string | null>;
  generatePortrait: (payload: { campaignId: string; prompt: string }) => Promise<CampaignState>;
  generateLocationImage: (payload: { campaignId: string; cell: string; prompt: string }) => Promise<CampaignState>;
  generateConnectionImage: (payload: { campaignId: string; connectionId: string; prompt: string }) => Promise<CampaignState>;
  generateIllustration: (payload: { campaignId: string; prompt: string; caption?: string }) => Promise<CampaignState>;
  removeIllustration: (payload: { campaignId: string; id: string }) => Promise<CampaignState>;

  onChatEvent: (callback: (event: ChatEvent & { campaignId: string }) => void) => () => void;
}

export interface UpdaterStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unavailable' | 'ok';
  version?: string;
  percent?: number;
  message?: string;
}

export interface UpdaterBridge {
  getVersion: () => Promise<string>;
  check: () => Promise<UpdaterStatus>;
  download: () => Promise<UpdaterStatus>;
  install: () => Promise<UpdaterStatus>;
  onStatus: (callback: (status: UpdaterStatus) => void) => () => void;
}

declare global {
  interface Window {
    game: GameBridge;
    updater: UpdaterBridge;
  }
}
