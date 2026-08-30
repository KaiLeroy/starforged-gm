'use strict';
const fs = require('fs');
const path = require('path');

/**
 * In dev (plain `node`, or unpackaged Electron) the data lives at <project root>/data/dataforged.
 * In a packaged build, electron-builder's extraResources puts it under resourcesPath instead,
 * since data/ sits outside the asar'd app directory. We only reach for `electron` when actually
 * running inside Electron, so this module still works when required from plain Node (e.g. tests).
 */
function resolveDataDir() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return path.join(process.resourcesPath, 'data', 'dataforged');
    }
  } catch {
    // Not running inside Electron (e.g. `node` test scripts) -- fall through to the dev path.
  }
  return path.join(__dirname, '..', '..', 'data', 'dataforged');
}

const DATA_DIR = resolveDataDir();

let cache = null;

function loadData() {
  if (cache) return cache;
  const read = (file) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
  cache = {
    moves: read('moves.json'),
    oracles: read('oracles.json'),
    assets: read('assets.json'),
    truths: read('truths.json'),
    encounters: read('encounters.json'),
    // Not official Dataforged content -- generated from the project's own hand-verified asset
    // pseudocode reference (which asset abilities alter which named moves), specifically so the
    // engine can compute this itself rather than relying on the model's own recall of a long
    // prose prompt. See getAssetAbilitiesForMove below for how this gets used.
    assetModifiers: read('asset-modifiers.json'),
  };
  return cache;
}

/** Dataforged move and oracle text both embed markdown-style links to other moves/oracles, e.g.
 *  "[Pay the Price](Starforged/Moves/Fate/Pay_the_Price)" or "[⏵Furnace World](Starforged/Oracles/
 *  Planets/Furnace)" -- internal cross-references, not something either the player or the model
 *  should see raw. Strip down to just the display text. Shared by anything that surfaces move or
 *  oracle text: the moves catalog (main.cjs) and oracle rolls (tools.cjs) both need this, so it
 *  lives here once rather than as two independently-maintained copies. */
function stripCrossRefLinks(text) {
  if (!text) return text;
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function normalize(str) {
  return String(str).toLowerCase().trim();
}

/** Splits into lowercase alphanumeric words, so matching can't be fooled by character-level
 *  substring collisions like "faction".includes("action"). */
function words(str) {
  return normalize(str).split(/[^a-z0-9]+/).filter(Boolean);
}

/** True if every word in `smaller` appears somewhere in `larger` (order-independent). */
function wordsSubsetOf(smaller, larger) {
  return smaller.length > 0 && smaller.every((w) => larger.includes(w));
}

/**
 * Word-boundary-aware fuzzy match: prefers exact word-set equality, then lets a query match a
 * candidate name it fully contains, but only lets a *candidate's* words match as a subset of a
 * longer query when the candidate name itself has 2+ words. A single generic word like "Name" or
 * "Feature" is too common across this dataset to safely win against an unrelated multi-word query
 * just because that word happens to appear in it (e.g. "Faction Name" must NOT match a "Name"
 * oracle that belongs to Settlements).
 */
function fuzzyWordMatch(candidateWords, needleWords) {
  const nameSubsetOk = candidateWords.length >= 2 && wordsSubsetOf(candidateWords, needleWords);
  const needleSubsetOk = wordsSubsetOf(needleWords, candidateWords);
  return nameSubsetOk || needleSubsetOk;
}

/** Flattens every move across every category into a single array. */
function allMoves() {
  const { moves } = loadData();
  const out = [];
  for (const category of moves) {
    for (const move of category.Moves || []) out.push(move);
  }
  return out;
}

/** Finds a move by exact $id, or by fuzzy name match (word-boundary aware, not raw substring --
 *  raw substring would let e.g. "faction" falsely match a move named "Action"). */
function findMove(nameOrId) {
  const moves = allMoves();
  const needle = normalize(nameOrId);
  let hit = moves.find((m) => m.$id === nameOrId);
  if (hit) return hit;
  hit = moves.find((m) => normalize(m.Name) === needle);
  if (hit) return hit;
  const needleWords = words(nameOrId);
  hit = moves.find((m) => fuzzyWordMatch(words(m.Name), needleWords));
  return hit || null;
}

/**
 * Returns a move's own approach-to-stat options, straight from Dataforged's Trigger.Options --
 * the same data used to write this whole prompt's approach-dependent stat guidance (Compel,
 * Resupply, Heal, Repair, Undertake an Expedition, Enter the Fray, Strike, Clash, and others),
 * now made available to the engine itself rather than only living in prose the model has to
 * recall correctly every time. Only "Any"-method options resolve to a single, directly-named
 * stat -- "Lowest"/"Highest"-method options (Heal's self-treatment case: "whichever of iron or
 * wits is lower") are derived computations, not a stat choice, and are excluded from
 * validStats; those are still handled via the existing derived_value escape hatch in
 * roll_action_move, not this validation path. Returns null for a move with no Trigger.Options
 * at all (a single fixed stat, or no stat -- nothing to validate against).
 */
function getMoveStatOptions(nameOrId) {
  const move = typeof nameOrId === 'object' ? nameOrId : findMove(nameOrId);
  if (!move || !move.Trigger || !Array.isArray(move.Trigger.Options) || move.Trigger.Options.length === 0) return null;
  const KNOWN_STATS = ['edge', 'heart', 'iron', 'shadow', 'wits', 'health', 'spirit', 'supply', 'integrity'];
  const options = move.Trigger.Options.map((opt) => ({
    text: opt.Text || '',
    method: opt['Roll type'] === 'Action roll' ? (opt.Method || 'Any') : null,
    // Dataforged represents a derived/non-standard value (a connection's rank, a companion's own
    // health standing in for the character's own stat) as a "custom_stat" reference here rather
    // than a real stat name -- filtered out, since those are handled through the roll's own
    // derived_value escape hatch, not something to validate as if it were an ordinary stat pick.
    stats: (opt.Using || []).map((s) => String(s).toLowerCase()).filter((s) => KNOWN_STATS.includes(s)),
  })).filter((o) => o.stats.length > 0);
  if (options.length === 0) return null;
  const validStats = [...new Set(options.filter((o) => o.method === 'Any' && o.stats.length === 1).map((o) => o.stats[0]))];
  return { options, validStats };
}

/**
 * Given a character's owned assets and a move name, returns which of that character's own
 * UNLOCKED ability effects actually alter this specific move -- computed from structured data
 * (the project's own hand-verified asset pseudocode reference, cross-checked against Dataforged
 * and the rulebook throughout this whole project) rather than left to the model's own recall of
 * a long prose prompt. This is the asset-side counterpart to getMoveStatOptions: the model still
 * judges whether an ability's fictional trigger genuinely fits the moment (that judgment call
 * stays exactly where it belongs), but it no longer has to also separately remember, unaided,
 * which of a character's several owned assets are even relevant to a given move in the first
 * place -- that lookup is now something the engine can answer directly.
 *
 * Returns { explicit, implicit } -- explicit entries name this exact move in their own alters
 * list (Dataforged's own "alters" mapping, not a guess); implicit entries have no named move at
 * all (alters: []) and instead key off a fictional CATEGORY ("a forceful move", "a move to
 * craft/repair/modify") that this function can't classify on its own -- surfaced separately so
 * the model can still consider them, but recognizing the category match itself remains a
 * judgment call, not something reduced to a lookup here.
 */
function getAssetAbilitiesForMove(ownedAssets, moveName) {
  const { assetModifiers } = loadData();
  const needle = normalize(moveName);
  const explicit = [];
  const implicit = [];
  for (const owned of ownedAssets || []) {
    const def = assetModifiers.find((a) => normalize(a.name) === normalize(owned.name));
    if (!def) continue;
    const unlocked = new Set(owned.abilities_unlocked || [1]);
    for (const ability of def.abilities) {
      if (!unlocked.has(ability.level)) continue;
      const entry = { asset: owned.name, asset_id: owned.id, level: ability.level, trigger: ability.trigger, effect: ability.effect };
      if (ability.alters.length === 0) {
        implicit.push(entry);
      } else if (ability.alters.some((m) => normalize(m) === needle)) {
        explicit.push(entry);
      }
    }
  }
  return { explicit, implicit };
}

/** Recursively walks an oracle category tree, collecting every rollable table node. */
function flattenOracles() {
  const { oracles } = loadData();
  const out = [];
  const walk = (node, categoryPath) => {
    const here = categoryPath ? `${categoryPath} / ${node.Name}` : node.Name;
    if (Array.isArray(node.Table)) {
      // Display.Title is the name the rulebook itself prints for this table (e.g. "Character
      // Goal", "Starship Name", "Settlement Trouble") -- often meaningfully different from the
      // bare hierarchical Name used to build the path (e.g. "Name" under "Characters", or
      // "Trouble" under "Settlements"). Captured separately from `name`/`path` so it can be
      // checked as its own, distinct match tier in findOracle() below.
      out.push({ id: node.$id, name: node.Name, path: here, displayTitle: (node.Display && node.Display.Title) || null, description: node.Description || null, table: node.Table });
    }
    for (const sub of node.Oracles || []) walk(sub, here);
    for (const sub of node.Categories || []) walk(sub, here);
  };
  for (const cat of oracles) walk(cat, '');
  return out;
}

let oracleIndex = null;
function getOracleIndex() {
  if (!oracleIndex) oracleIndex = flattenOracles();
  return oracleIndex;
}

/** Normalizes an oracle's breadcrumb path into a flat, space-separated lowercase string for matching. */
function pathKey(oracleEntry) {
  return normalize(oracleEntry.path).replace(/\s*\/\s*/g, ' ');
}

/**
 * Finds an oracle table by exact $id, or by fuzzy match against its full breadcrumb path.
 * Matching against the *path* (not just the leaf name) matters a lot here: many oracles share
 * generic leaf names across categories (dozens of tables are just called "Name", "Feature",
 * "Peril", "Suffix", etc.), so a query like "Sector Name Suffix" must be checked against
 * "Space / Sector Name / Suffix" as a whole -- matching leaf names alone can silently resolve
 * to the wrong table (e.g. "Suffix" matching some unrelated "Name" oracle instead).
 */
function findOracle(nameOrId) {
  const idx = getOracleIndex();
  let hit = idx.find((o) => o.id === nameOrId);
  if (hit) return hit;

  const needle = normalize(nameOrId);
  // pathKey() collapses a stored path's " / " separators (with any surrounding whitespace) down
  // to a single space -- e.g. "Settlements / Name" becomes "settlements name". The query needs
  // the exact same treatment, or a perfectly reasonable query like "Settlements/Name" (no
  // spaces, which is how compound oracle names read most naturally in prose) never matches
  // anything: it stays "settlements/name", the slash never disappears, and it's neither equal to
  // nor a substring of "settlements name". Both slash styles ("Settlements/Name" and
  // "Settlements / Name") and dot/colon-separated styles should all resolve the same way.
  const pathNeedle = needle.replace(/\s*[/:]\s*/g, ' ');

  // Exact full-path match.
  hit = idx.find((o) => pathKey(o) === pathNeedle);
  if (hit) return hit;

  // Exact match against the oracle's own printed Display.Title (e.g. "Character Goal",
  // "Starship Name", "Settlement Trouble") -- the name the rulebook itself actually uses, which
  // is frequently very different from the internal hierarchical Name the path above is built
  // from (bare "Name" nested under "Characters", bare "Trouble" nested under "Settlements",
  // etc.). Found by comparing every oracle's real Display.Title against what this function
  // actually resolved for that exact string -- 172 of them silently failed or landed on the
  // wrong table before this fix existed. Deliberately gated on uniqueness: many display titles
  // ARE genuinely ambiguous on their own (a dozen different oracles are all just titled
  // "Feature" or "Peril"), and a query that's genuinely ambiguous should fall through to the
  // existing path-based logic below (where compound-path context resolves it correctly) rather
  // than this tier silently guessing one of several plausible tables.
  const titleMatches = idx.filter((o) => o.displayTitle && normalize(o.displayTitle).replace(/\s*[/:]\s*/g, ' ') === pathNeedle);
  if (titleMatches.length === 1) return titleMatches[0];

  // The path contains the whole needle as a substring -- much more specific than leaf-name
  // matching. If several match, prefer the most specific (shortest) path.
  const pathMatches = idx.filter((o) => pathKey(o).includes(pathNeedle));
  if (pathMatches.length > 0) {
    pathMatches.sort((a, b) => pathKey(a).length - pathKey(b).length);
    return pathMatches[0];
  }

  // A short query naming a whole path from the inside out (rare, but cheap to support).
  hit = idx.find((o) => pathKey(o).length > 0 && pathNeedle.includes(pathKey(o)));
  if (hit) return hit;

  // Last resort: leaf-name-only matching, word-boundary aware (not raw substring, which would
  // let e.g. "faction" falsely match an oracle named "Action").
  hit = idx.find((o) => normalize(o.name) === needle);
  if (hit) return hit;
  const needleWords = words(nameOrId);
  hit = idx.find((o) => fuzzyWordMatch(words(o.name), needleWords));
  return hit || null;
}

/** Returns up to `limit` oracle entries whose name/path loosely matches, for error messages.
 *  Ranked by how many query words they match and how specific (short) their path is, so the
 *  most likely intended table surfaces first instead of whatever happened to be indexed earlier. */
function suggestOracles(nameOrId, limit = 5) {
  const idx = getOracleIndex();
  const needleWords = words(nameOrId);
  const scored = idx
    .map((o) => {
      const pk = pathKey(o);
      const matchCount = needleWords.filter((w) => pk.includes(w)).length;
      return { o, matchCount };
    })
    .filter((s) => s.matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount || pathKey(a.o).length - pathKey(b.o).length);
  return scored.slice(0, limit).map(({ o }) => ({ id: o.id, name: o.name, path: o.path }));
}

function allAssets() {
  const { assets } = loadData();
  const out = [];
  for (const category of assets) {
    for (const asset of category.Assets || []) out.push(asset);
  }
  return out;
}

function findAsset(nameOrId) {
  const assets = allAssets();
  const needle = normalize(nameOrId);
  let hit = assets.find((a) => a.$id === nameOrId);
  if (hit) return hit;
  hit = assets.find((a) => normalize(a.Name) === needle);
  return hit || null;
}

/** Returns the list of the 14 Setting Truth category names, in book order. */
function truthCategoryNames() {
  const { truths } = loadData();
  return truths.map((t) => t.Name);
}

/**
 * Finds a Setting Truth category by exact (case-insensitive) name.
 */
function findTruthCategory(name) {
  const { truths } = loadData();
  const needle = normalize(name);
  return truths.find((t) => normalize(t.Name) === needle) || null;
}

module.exports = {
  loadData,
  stripCrossRefLinks,
  allMoves,
  findMove,
  getMoveStatOptions,
  getAssetAbilitiesForMove,
  flattenOracles,
  findOracle,
  suggestOracles,
  allAssets,
  findAsset,
  truthCategoryNames,
  findTruthCategory,
};
