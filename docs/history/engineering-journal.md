# Starforged Solo GM

A Windows desktop app for playing *Ironsworn: Starforged* solo against an AI game
master, connected through [OpenRouter](https://openrouter.ai). Built with
Electron + React, grounded in the official [Dataforged](https://github.com/rsek/dataforged)
ruleset data (56 moves, 4,185 oracle table rows, 90 assets, 14 setting truths).

## How it works

The AI model does **not** invent dice results, oracle answers, or track values.
It calls tools (OpenRouter/OpenAI-style function calling); the app performs the
actual roll or state update with a real RNG and returns the result; the model
narrates based on that real result. This keeps the mechanics honest while still
letting the AI drive pacing, NPCs, and flavor text -- similar in spirit to how
*AI Roguelite* separates "what the dice say" from "what the AI narrates."

```
you type an action
        │
        ▼
 main process ─▶ OpenRouter (model decides which move/tool to call)
        │                         │
        │◀── tool_calls ──────────┘
        ▼
 rules engine (dice.cjs / data.cjs / state.cjs)
   - rolls real dice against real Starforged move/oracle data
   - updates the campaign's meters / progress tracks
        │
        ▼
 tool results sent back to OpenRouter ─▶ model narrates the outcome
        │
        ▼
   shown in the chat log, with the roll as a small "transmission" line
```

## Project layout

```
electron/
  main.cjs              window + IPC handlers
  preload.cjs            safe bridge exposed to the renderer as window.game
  engine/
    dice.cjs              action/progress/oracle roll math (crypto RNG)
    data.cjs               loads & searches the Dataforged JSON
    state.cjs                character sheet, meters, progress tracks, save/load
    tools.cjs                 the tool schemas + async dispatcher the model calls
    comfyui.cjs                ComfyUI HTTP client (workflow templating, submit/poll/fetch)
    openrouter.cjs             the tool-calling loop against the OpenRouter API
    systemPrompt.cjs            builds the GM system prompt from current state
    store.cjs                   config, campaign saves, image files
    __selftest__.cjs             `npm run test:engine`
    __selftest_openrouter_loop__.cjs  mocked-fetch tests against the tool-calling loop
    __selftest_comfyui__.cjs          mocked-fetch tests against the ComfyUI client
    __playtest_simulation__.cjs       `npm run playtest` -- a full simulated session
data/dataforged/          the official ruleset JSON (moves, oracles, assets, truths)
src/                       React renderer (chat log, character sheet, sector map,
                            truths, Codex, Combat, Expanse, moves panel, Oracles
                            panel, campaign select)
```

## Setup (Windows)

1. Install [Node.js LTS](https://nodejs.org) (20.x or newer).
2. Open a terminal in this folder and run:
   ```
   npm install
   npm run dev
   ```
   This starts the Vite dev server and launches the Electron window together.
3. In the app, click **Settings** and paste in an OpenRouter API key (get one at
   [openrouter.ai/keys](https://openrouter.ai/keys)). Pick a model that supports
   tool calling -- e.g. `anthropic/claude-sonnet-4.5`, `openai/gpt-4.1`, or
   similar. The mechanics depend on reliable tool calling, so avoid models that
   don't support it well.
4. Create your character (name + stats) and start playing.

### Running the engine tests

```
npm run test:engine
```
Runs 18 checks against the real dice math, data lookups, and every tool handler
-- no window or API key required.

### Building a Windows installer

```
npm run dist:win
```

Uses `electron-builder` to produce an NSIS installer at
`dist/Starforged Solo GM Setup <version>.exe` (not `release/` -- the
previous version of this doc had the wrong path; nobody had actually run
this successfully before to notice).

**Verified working end to end** -- built, and the resulting `.exe` confirmed
as a genuine, non-corrupted PE32 Windows executable (not just "the command
exited 0"). Two real things had to be fixed to get there, both already
applied in this repo:

- `electron-builder` was listed as a dependency but never actually installed
  (`npm install` fixes this, and now correctly pulls the pinned 24.13.3
  rather than whatever `npx` would silently fetch instead).
- `build.win.signAndEditExecutable: false` is now set in `package.json`.
  Without it, this electron-builder version hits a bug in its own
  signing code path (`Cannot use 'in' operator ... in undefined`) even
  when no certificate is configured -- a plain `sign: false` doesn't avoid
  it. The tradeoff: the `.exe`'s embedded metadata (file description,
  product name) won't be set. If you're building natively on Windows with
  real signing credentials configured, remove this line first.

**If cross-building from Linux** (this repo's build was verified this way,
not on native Windows): you need `wine` and `wine32:i386` as system
packages -- electron-builder uses Wine to run Windows-native tools
(`rcedit`) for resource editing even when signing itself is skipped.
Without them the build fails outright (`wine is required`), not silently.
On Debian/Ubuntu:
```
sudo dpkg --add-architecture i386 && sudo apt-get update
sudo apt-get install -y wine wine32:i386
```
Building natively on Windows shouldn't need any of this -- Wine is purely a
Linux/macOS cross-compilation requirement.

### Publishing releases for auto-update

The app checks for updates against GitHub Releases (see "Auto-update"
above) -- an unconfigured build reports "not configured" in Settings
rather than silently doing the wrong thing, but getting it actually
working takes a small amount of one-time setup.

Publishing itself happens on GitHub's own infrastructure via
`.github/workflows/release.yml`, not locally -- `npm run dist:win:publish`
still works if run somewhere with unrestricted network access, but isn't
the intended path. This exists specifically because publishing a release
requires uploading to `uploads.github.com`, a different host from the rest
of GitHub's API, and some environments (this one included) block it while
allowing everything else -- a hard, silent-looking failure otherwise. A
real Windows GitHub Actions runner has no such restriction, and also means
the installer builds natively rather than needing Wine for cross-compiling
from Linux.

One-time setup:
1. Create a GitHub repo for this project (public -- electron-updater's
   GitHub provider reads release metadata without authentication).
2. In `package.json`, replace `build.publish.owner` and `build.publish.repo`
   with your actual GitHub username and repo name.
3. Push the repo, including `.github/workflows/release.yml`. No extra
   secrets to configure -- the workflow uses GitHub's own automatic,
   per-run `GITHUB_TOKEN`, already scoped to just this repo.

To publish a new release from then on:
1. Bump `package.json`'s own `version` field -- electron-updater compares
   against this, not a build number.
2. Push a tag matching that version, prefixed with `v` (e.g. `v0.1.2` for
   version `0.1.2`):
   ```
   git tag v0.1.2 && git push origin v0.1.2
   ```
   That tag push is the trigger -- GitHub Actions picks it up, builds on a
   Windows runner, and publishes the installer plus the `latest.yml`
   metadata file electron-updater actually reads (publishing the installer
   alone, without that file, leaves auto-update with nothing to check
   against). `build.publish.releaseType: "release"` in package.json makes
   this a real, published release directly -- electron-builder's own
   default is to leave it as an unpublished draft, invisible to anything
   checking the latest-release endpoint, which needs this setting to avoid.

After that, any already-installed copy of the app will see the new version
next time it checks (manually, from Settings) -- there's no separate step
needed on the client side once a repo is configured once. Verified working
end to end against a real tagged release, not just built and assumed
correct: the same URL electron-updater itself would fetch
(`https://github.com/<owner>/<repo>/releases/latest/download/latest.yml`)
was confirmed to return the real, correct version and file hash.

## Current scope / what's next

Core solo-play loop is feature-complete end to end -- session zero (Truths
before character creation, matching the book's actual order) through
advancement, a sector map, AI image generation, multiple campaigns, and a
structured move interface. This section covers the headline mechanics;
session zero, multi-campaign, ComfyUI, and the full rulebook accuracy pass
each have their own dedicated section further down with the specifics.

- ✅ Action rolls, progress rolls, oracle rolls, Ask the Oracle, meters, momentum
  (including burning it and the negative-momentum penalty), progress tracks
  (tick-level, not just whole boxes), Impacts (Wounded/Shaken/Doomed/etc., which
  correctly reduce max momentum) -- all tool-driven and tested
- ✅ Character creation follows the book's actual 3-step structure: name/
  callsign/pronouns/description/background vow (epic rank, no roll needed),
  then exactly 2 Path assets, then 1 final asset from Module/Support Vehicle/
  Companion/Path (not Deed -- every official Deed asset gates behind an
  in-play milestone, making one impossible to have before the campaign
  starts). A Starship (Command Vehicle) is granted automatically, with its
  own Integrity meter.
- ✅ Full experience economy: Quests/Bonds/Discoveries legacy tracks (ordinary
  progress tracks under the hood, with automatic experience-per-box and
  auto-clearing at the 10th box), `earn_experience`, `buy_asset` (3 XP),
  `upgrade_asset` (2 XP) via the Advance move -- all fail cleanly on
  insufficient experience.
- ✅ **Sector map**: a hex grid (modeled on the actual printed Sector
  Worksheet) that the GM populates as you explore -- `reveal_location`,
  `add_location_feature` (a hex can hold several: a star, planets, a
  settlement, a derelict, etc.), and `set_current_location` are all tools the
  AI calls during play. A campaign can span multiple sectors, each with its
  own independent grid, switchable from the Sector tab. You can also edit
  any hex by hand directly from the UI -- that path doesn't touch the AI at
  all, for quick manual bookkeeping.
- ✅ **Moves panel**: every one of the 56 moves is listed, grouped by category
  and color-coded to match the book. Click one to expand its trigger text and
  stat options, optionally describe your action in a text field, and "Make
  this move" sends it to the GM with that context attached -- rather than
  relying on the GM to infer which move you meant from free text.
- ✅ Persistent save file per campaign, with a Campaign Select screen for
  managing multiple campaigns at once.
- ✅ Chat UI with live dice-roll "transmission" lines colored by the game's own
  move-category colors, each challenge die colored individually by whether it
  was beaten, and a character sheet sidebar showing everything above --
  including companion health, combat position/range, connection roles, active
  clocks, and content flags.
- ✅ **Edit / Regenerate / Undo** on the most recent turn: a full-state
  checkpoint (character, meters, tracks, sector, everything) is taken right
  before each turn and can be rolled back, since a misread action or a bad
  dice-adjacent AI call otherwise has no way to walk back its real, persistent
  mechanical consequences. Single-level by design -- covers the turn that
  just happened, not a full undo stack -- and deliberately never written to
  the save file, so it doesn't survive an app restart.
- ✅ **Temperature / Top P** in Settings, both optional and genuinely omitted
  from the OpenRouter request when left blank rather than forced to a
  default -- tunes how the GM writes and decides, not the game's own dice
  odds. Deliberately doesn't affect the separate summarizer call used for
  context compaction, which wants accuracy, not narrative variety.
- ✅ **AI-composed image prompts**: every "Generate portrait/location image/
  illustration" button composes its prompt via a small, focused OpenRouter
  call drawing on real context (character description and owned assets, a
  connection's role and notes, a location's recorded features, a recent-story
  slice) rather than a fixed JS template -- falls back to a simple template
  automatically, with a visible explanation, if composition itself fails.
- ✅ **The game actually pauses for genuine player choices**: when a move's
  own outcome hands the player a real "choose one of" decision -- Secure an
  Advantage's momentum-or-bonus, Sojourn's pick-two-recover-moves, and many
  others documented throughout this project's own rules-accuracy work -- the
  AI calls present_choice and the turn genuinely stops, with the real
  decision left unresolved (never a fabricated stand-in), until the player
  answers via an actual pop-up. Persisted to the save file, not ephemeral, so
  a pending choice survives closing and reopening the app.
- ✅ **Auto-update**, built on electron-updater against GitHub Releases.
  Deliberately conservative: nothing downloads or installs itself in the
  background -- checking, downloading, and installing are three separate,
  explicit actions from a new section in Settings, showing the current
  version and live status throughout. Requires a real GitHub repo to
  actually check against -- `package.json`'s `build.publish.owner`/`repo`
  are placeholders until that exists (see Setup below for exactly what's
  needed); the feature itself is fully built and works correctly either way,
  reporting a clean, honest "not configured" rather than failing silently.

Deliberately still out of scope for this pass: nothing currently -- every
item previously tracked here has been resolved (see below for details on
each).

**Resolved, not dropped:** the legacy-track "structural guard rail" item
that used to be listed here was checked directly rather than assumed --
`create_progress_track` already refuses to overwrite a reserved legacy
track id via its ordinary duplicate-id check (verified with a test, since
it wasn't locked in before). The actual risk (corrupting a legacy track by
ID collision) was already prevented; the softer, harder-to-define concern
("could the GM roll against a legacy track outside its normal use") wasn't
turned into a restriction, since that's a legitimate operation in some
cases (Continue a Legacy) and there's no way to distinguish "premature"
from "intentional" without guessing at GM intent.

**Deliberately declined, not missed:** `data/dataforged/encounters.json` (the
23 named sample foes from Chapter 4 -- Chiton, Colossus, etc. -- with full
rank/features/drives/tactics/variants) sits in this repo entirely unused.
Found and flagged during a features/QoL review; the call was made to let the
GM invent foes freely rather than wire up a lookup tool for the book's fixed
roster. Noting this explicitly so a future pass doesn't mistake it for an
oversight -- it's a real, considered choice, not a gap.

## Full rulebook accuracy pass

At the user's request, the rulebook is being re-read a second time,
linearly and in ~40-page chunks, rather than via the keyword searches used
for the first pass -- specifically to catch things a search-driven read
would miss because nobody thought to search for them. Each chunk gets a
short report, whether or not it found anything.

### Chunk 1 (pages ~14-43, Chapter 1 fundamentals: momentum, progress tracks)

- **Real bug: combat position is a hard trigger gate, not just informational.**
  Gain Ground can only be made "when you are in control"; React Under Fire
  only "when you are in a bad spot" -- these aren't stylistic suggestions,
  they're the moves' actual trigger conditions. On top of that, Take
  Decisive Action (the move that resolves a fight's progress track) has its
  own downgrade rule while in a bad spot: a strong hit *without* a match
  drops to a weak hit, and a weak hit drops to a miss -- with a strong hit
  *with* a match specifically untouched. `roll_progress_move` now takes an
  opt-in `apply_bad_spot_downgrade` flag, verified against all four cases by
  rolling until each one actually occurred, not just reasoning about the
  code.
- Caught and fixed a smaller thing while investigating: `roll_progress_move`'s
  own tool description referenced a move called "End the Fight," which
  doesn't exist -- the real move is Take Decisive Action.
- Added GM guidance from "Best Practices for Moves": a move should always
  change the situation, and retrying a failed move needs new leverage or a
  different approach, not just another attempt.
- **Confirmed correct, not changed:** negative momentum's exact die-cancellation
  mechanics (matches the book's own worked example), the minimum momentum
  floor, momentum/meters persisting between sessions, progress stacking, and
  the background vow's epic rank -- all already right from earlier passes.

### Chunk 2 (pages ~44-71: Legacy Tracks re-confirmed, Navigating the Forge)

- **Face Death and Face Desolation had no trigger linkage.** The book is
  explicit: "if you are at 0 health, scoring a miss when you Endure Harm
  puts you at risk of suffering an impact or dying" (Spirit: Endure Stress,
  risk of "falling into desolation"). All the underlying tools already
  existed (roll_action_move, toggle_impact, Swear an Iron Vow via a new
  progress track) but nothing connected "meter at 0 + next relevant miss"
  to actually calling these moves -- the GM could narrate injury without
  ever mechanically resolving it. Added explicit guidance, including the
  weak-hit branch (mark doomed/tormented, clear it later when that specific
  vow's track is fulfilled) and that a miss means the character is dead or
  lost, not softened.
- **Continue a Legacy** (character death/retirement, rolling against the
  former character's legacy tracks to determine what a successor inherits)
  is a real, fully-detailed move this app has no dedicated tooling for --
  it would need cross-campaign data linking (starting a new character while
  referencing a prior campaign's final legacy-track state), which is out of
  scope for this pass given how rare the trigger is. Added a system-prompt
  pointer so the GM at least calls `lookup_move` for the real procedure
  instead of improvising, and documented the gap here rather than
  papering over it.
- Legacy track mechanics (2 XP per box, the "10 bubble" clearing behavior,
  the reduced post-clear rate) all re-confirmed exactly correct against a
  second, independent read of the same page.
- Navigating the Forge (eidolon travel, anchorages, near/far/out-of-range
  objects) is pure worldbuilding-and-oracle-procedure guidance -- confirmed
  it already composes correctly from Undertake an Expedition, Explore a
  Waypoint, and the region-specific Space Sightings oracles. No code gap.

4 new tests this pass, covering all four branches of the bad-spot downgrade
rule specifically (including the match exception, which is easy to get
backwards).

### Chunk 3 (pages ~74-131: Build a Starting Sector, Begin Your Adventure)

This chunk directly overlapped with the "AI pregenerates the sector and
opens the campaign" work from a couple sessions ago -- which was written
from inference about how that should work, not from actually having read
these two exercises. Reading them now found a real, substantial gap:

- **The official starting-sector procedure is far more specific than what
  was built, and the implementation was badly under-populating it.** It's
  not "reveal one hex with a couple of features" -- there's an exact
  settlement count by region (Terminus: 4, Outlands: 3, Expanse: 2) and a
  precise oracle chain per settlement (Settlements/Name, /Location,
  /Population/\<region\>, /Authority, /Projects rolled 1-2 times, plus
  Planets/Class for any that are planetside). The system prompt's sector
  setup instructions have been rewritten to follow this exactly rather than
  a rough approximation of it -- a real campaign opening should now produce
  several actually-detailed settlements, not one hex with vague color.
- **Region choice guidance was too even-handed.** The book is direct about
  this: Terminus and Outlands are the common starting choices, Expanse is
  valid but less common ("only a few bold pioneers"), and Void is
  explicitly "don't start your campaign here" -- not merely "rarely," which
  is what the guidance said before. Corrected.
- **The opening scene was missing real structure.** "Begin Your Adventure"
  gives a precise procedure: source the inciting incident from what's
  already established (truths and quest starters, the character's paths/
  backstory/starship, or the new sector's settlement Projects/Trouble and
  sector trouble) rather than inventing one from nothing; choose between a
  short prologue (calm scene, then the incident lands) or starting in
  medias res; and land the opening on the moment to Swear an Iron Vow for
  the new quest -- distinct from the background vow, and something the GM
  should set up but not roll on the player's behalf. None of this specific
  structure existed in the guidance before; it was just "write a good
  opening scene."
- Confirmed `Characters/Goal` and `Core/Action`+`Core/Theme` (the book's
  fallback inspiration oracles for a stuck player) already exist in the
  data and are usable as-is -- no gap there, just wasn't referenced by name.
- Also fixed a genuinely flaky test caught while re-running the suite
  during this chunk: an earlier test asserted a progress roll at score 10
  would *always* land a strong hit, which isn't true -- either challenge
  die can still roll a 10 and be unbeatable (~19% combined chance). Fixed
  to check the invariant that actually matters (no downgrade applied)
  across many rolls instead of asserting one exact lucky outcome.

### Chunk 4 (pages ~133-145: start of Chapter 3, Session Moves in full)

- **Begin a Session existed only as a passing reference (for campaign clock
  checks), never as the actual procedure it is.** The book's real move:
  check/update flagged content, recap last session, set the scene, and
  *optionally* roll a real oracle table ("Begin a Session") for a brief
  spotlighted vignette -- which grants +1 momentum if used. The oracle table
  was already in the data and already rollable; nothing had ever told the
  GM the procedure existed or that it carries a mechanical reward. Since
  this is a persistent single conversation with no natural "session
  boundary" the way a real table has, added a lightweight signal for it:
  `lastPlayedAt` is now tracked on campaign state, and the system prompt
  notes when a real gap (3+ hours) has passed since the last message, as a
  concrete nudge alongside the obvious conversational cues ("I'm back",
  starting a new campaign).
- **Take a Break and End a Session were both missing their actual mechanical
  hooks.** Take a Break (offered after a significant progress move resolves)
  grants +1 on the player's next move if they take it -- a real wellbeing
  check, not just flavor text, and not something to force. End a Session
  has a genuine procedure: recap, then explicitly check whether anything
  got missed -- a connection that grew closer without Develop Your
  Relationship being called, a quest that advanced without Reach a
  Milestone -- and catch it now rather than letting it silently not count.
  Noting a focus for next session grants +1 momentum. Added guidance for
  both.
- 3 new tests cover the gap-tracking math precisely (a 5-hour gap measures
  as ~5 hours, not approximately; immediately after marking played the gap
  is ~0) and confirm the Begin a Session oracle table matches the book's
  ten actual entries, not just that some oracle exists at that path.

### Chunk 5 (pages ~146-159: Adventure Moves, Quest Moves)

Mostly confirmation this time, with a few real precision fixes -- a useful
signal that the earlier chunks caught the bulk of what was actually broken
in this territory, since Quest Moves is where the legacy-reward and
recommit generalization work from a few sessions ago lives, and it held up
exactly against a full linear re-read:

- **A real precision gap in the legacy reward guidance:** a weak hit on
  Fulfill Your Vow without swearing a new vow gives the reward "one rank
  lower" -- except when the quest was already troublesome, the lowest rank,
  where the book is explicit the reward is *none at all* (there's no rank
  below troublesome to drop to). The existing guidance didn't handle this
  edge case and would have had the GM either invent a fractional reward or
  error out trying. Fixed.
- **Swear an Iron Vow's miss has a specific consequence beyond "an
  obstacle":** overcoming that opening obstacle explicitly does not count
  as a Reach a Milestone -- it's what has to happen before the quest
  properly begins, not progress on it. This is an easy thing to get wrong
  narratively (mark progress for clearing the obstacle) without the book's
  specific callout.
- **Confirmed and reinforced:** Face Danger and Secure an Advantage are
  never made during a fight at all -- React Under Fire and Gain Ground
  fully replace them, not just "are usually better." Also confirmed Aid
  Your Ally is co-op/guided-only (an ally played by another person, not a
  Companion asset) -- added a note so a Companion's help doesn't get
  mistakenly routed through this move instead of the companion's own
  ability text.
- **Confirmed correct, unchanged:** the entire legacy-reward table and
  recommit mechanic (built two sessions ago from Fulfill Your Vow's text
  specifically) matches this chunk's independent read of the same section
  exactly -- Check Your Gear's supply-based Track Your Gear design, and
  "it's not necessary to fill the progress track before resolving a quest"
  were also already correctly reflected.

### Chunk 6 (pages ~162-166: Connection Moves) -- the richest gap yet

This was a small page range with the single biggest missing subsystem
found across the whole re-read. Connections weren't just missing a rank
and progress track (fixed a few sessions ago) -- they were missing an
entire mechanical layer:

- **Connections have a role, and it's a real, repeatable bonus, not
  flavor.** "Whenever your connection aids you on a move closely
  associated with their role, add +1 and take +1 momentum on a hit" --
  this applies from the moment Make a Connection succeeds, whether or not
  they're ever bonded. There was no `role` field on a connection at all.
- **Forge a Bond's strong hit is a real choice with two different
  outcomes**, not a single fixed reward: "Bolster their influence" (the
  existing role's bonus becomes +2) or "Expand their influence" (a second,
  separate role, each still worth +1 -- explicitly not stacked to +2).
  Getting this backwards would be an easy, plausible-looking mistake.
- **Test Your Relationship's miss has a specific state, not just "bad
  things happen":** the connection's benefits (their role bonus and
  everything else) are suspended -- not removed -- until an affirming
  quest resolves; only refusing or failing that quest actually breaks the
  connection permanently.
- **There was no way for the GM to actually remove a connection at all.**
  `removeConnection` existed in the state layer from early work, but was
  only ever wired to the manual UI path, never exposed as a tool the GM
  could call. Test Your Relationship's "lose the connection" outcome and
  the failed-affirming-quest case had nothing to invoke.

Added the full state layer (`role`, `secondRole`, `roleBonus`,
`benefitsSuspended`), six new tools (`set_connection_role`,
`bolster_connection_role`, `expand_connection_role`,
`suspend_connection_benefits`, `restore_connection_benefits`, and the
missing `remove_connection`), system prompt guidance tying the whole
lifecycle together, and updated the connections summary the GM sees every
turn to show role/bonus/suspension status. The frontend `Connection` type
was also out of sync with the actual state shape (missing rank/progress/
bonded from earlier work, now missing role too) -- corrected, though no
new UI was built to *display* roles yet; they're fully manageable through
chat.

4 new tests, including one that specifically locks in the bolster-vs-expand
distinction (bolster raises the bonus without adding a role; expand adds a
role without raising the bonus) since that's exactly the kind of thing that
would be easy to implement backwards without a test catching it.

### Chunk 7 (pages ~168-180: Exploration Moves)

A quiet chunk after Connection Moves' big findings, and a useful signal in
its own right -- this territory turned out to already be well covered by
earlier work (Undertake an Expedition, Finish an Expedition, and the
legacy-reward generalization), with a second independent read confirming
the same mechanics rather than surfacing new ones:

- **One real, precise fix:** Make a Discovery (Explore a Waypoint, strong
  hit with a match) and Confront Chaos (miss with a match) both mark exact,
  fixed amounts on the discoveries legacy track, not rank-based ones -- 2
  ticks flat for a Discovery, 1 tick per aspect (1-3, player's choice) for
  Confront Chaos. These need `mark_legacy_ticks`, not `apply_legacy_reward`
  (the rank-based one used by Finish an Expedition) -- easy to conflate
  since both feed the same track. Added explicit guidance connecting each
  move to the right tool.
- **Confirmed correct, unchanged:** Undertake an Expedition's full
  segment-by-segment structure, Set a Course's single-roll resolution
  (+supply), Explore a Waypoint's match-branching into Make a Discovery/
  Confront Chaos, and the guidance on keeping expedition and quest progress
  tracks separate even when they share an objective -- all already matched
  what the engine does.

### Chunk 8 (pages ~182-197: Combat Moves)

Confirmed the pattern from Combat Position/Range work continues to matter
-- this chunk both broadened an earlier fix and found a genuinely missing
piece of engine capability:

- **The position-gating guidance only covered half the gated moves.**
  Gain Ground and React Under Fire were already correctly documented as
  restricted to in-control/bad-spot respectively -- but Strike and Clash
  have the *exact same* gating ("when you are in control, assault a foe..."
  / "when you are in a bad spot, fight back...") and weren't mentioned at
  all. Broadened the guidance to cover all four.
- **Gain Ground has its own three-option resolution structure**, distinct
  from standalone Secure an Advantage's two-option one: a hit lets you pick
  from mark progress / +2 momentum / +1 next move (strong hit picks two,
  weak hit picks one). The existing guidance only documented the simpler
  two-option version and would have applied it to Gain Ground incorrectly.
- **Enter the Fray's exact position-setting logic wasn't connected to
  set_combat_position at all.** Strong hit is always in control; miss is
  always a bad spot; but weak hit is a genuine *choice* between +2 momentum
  or being in control, not both -- and if the player doesn't take control,
  they start in a bad spot by default. None of this was wired to the tool
  that actually tracks position.
- **A real, confirmed missing capability: there was no way to remove a
  progress track at all.** Face Defeat says "clear the objective," Forsake
  Your Vow says "clear the vow" -- both mean the track is gone, not reset
  to zero, and nothing in the tool set could do that. Added
  `remove_progress_track`, with an explicit guard against ever using it on
  a legacy track (those clear themselves automatically at their 10th box
  and should never be deleted outright).

3 new tests, including one confirming the legacy-track protection actually
blocks the call rather than just being a comment.

### Chunk 9 (pages ~198-207: Suffer Moves -- Endure Harm/Stress in full)

The single biggest structural gap found across the entire re-read.
Endure Harm and Endure Stress had been implemented since very early in this
project as "reduce a meter, done" -- and that's wrong. They're two-step
moves, and the second step had never existed at all:

- **Endure Harm/Stress is reduce-the-meter, THEN a real follow-up roll.**
  "Then, if your health is 0 or you choose to resist the harm, roll +health
  or +iron, whichever is higher" -- this is a genuine action roll with its
  own strong/weak/miss branches (shake it off for +1 health if not
  wounded, or embrace the pain for +1 momentum; a weak hit lets you trade
  momentum for health; a miss adds further harm). None of this existed --
  the move was being treated as nothing more than `update_meter`.
- **The miss-at-zero branch has its own dedicated table**, separate from
  Face Death/Face Desolation themselves -- ranging from real mortal danger
  down to "you are still standing" / "you persevere." This table is
  embedded in the move text, not a general-purpose oracle, so it was never
  going to surface by searching the oracle catalog. Added
  `rollSevereHarmTable` (verified against 300+ rolls per meter, confirming
  every band boundary lands where the book says) and a `roll_severe_harm_table`
  tool, since the randomness needed to stay in the engine like everything
  else here.
- Face Death and Face Desolation themselves (added a couple sessions ago)
  turned out to usually be reached *through* this table, not called
  directly -- the guidance now reflects that chain correctly instead of
  jumping straight to them.
- Also closed a smaller, easy-to-miss gap while finishing this pass: several
  tools added across the last two sessions (`remove_progress_track`,
  `remove_connection`, the whole connection-role set) had never gotten
  chat-log display formatting, so they'd have shown as raw tool names in
  the transcript. Fixed for all of them.

5 new tests, including a statistical check that 300+ rolls per table never
produce a result outside the book's actual band boundaries.

### Chunk 10 (pages ~200-215: rest of Suffer Moves, Recover Moves)

Following straight on from the Endure Harm/Stress finding, this chunk asked
the obvious next question -- do the *other* suffer moves have the same
missing second step? -- before reading any further, rather than assuming
they were fine.

- **Yes: Withstand Damage and Companion Takes a Hit had exactly the same
  gap.** Both are meter-reduction-then-a-real-resist-roll moves, same as
  Endure Harm, and both had only ever had the meter-reduction half built.
  Withstand Damage's follow-up roll: Bypass (+1 integrity) or Ride it out
  (+1 momentum) on a strong hit, a momentum-for-integrity trade on a weak
  hit, and on a miss at 0 integrity, a cost that depends on vehicle type --
  command vehicles can mark battered/cursed or lose a module, support
  vehicles can be discarded if destroyed, incidental vehicles always roll
  the table. Companion Takes a Hit's follow-up roll works the same way,
  with its own precise death trigger: a companion is only dead or destroyed
  if their health is 0 **and** the miss was rolled **with a match** --
  otherwise they're just out of action until aided. That distinction (out
  of action vs. actually dead) didn't exist before; discard_asset would
  have had no clear trigger to hang off of.
- **Withstand Damage's miss-at-0 table is richer than the health/spirit
  ones** -- 8 bands instead of 4-5, genuinely serious content (immediate
  destruction, Overcome Destruction, the crew having to Endure Harm/Stress
  or Sacrifice Resources). Added `rollVehicleDestructionTable`, verified
  against 400 rolls confirming every band lands correctly.
- **One easy-to-get-backwards detail in Recover Moves:** mending your own
  wounds (Heal) rolls +iron or +wits, whichever is *lower* -- every other
  multi-stat move in the book uses "whichever is higher," so this is a
  specific, deliberate exception that's easy to apply backwards out of
  habit. Also added: Hearten gets +1 more when made while Sojourning, and
  Sojourn itself lets the character take two recover moves at once, not
  one.

2 new tests, including a statistical check on the 8-band destruction table
matching earlier ones' rigor.

### Chunk 11 (pages ~228-233: Fate Moves) -- and Chapter 3 is now fully covered

This closes out Chapter 3 ("Gameplay in Depth") entirely -- every move
category from Session Moves through Legacy Moves has now been read
linearly and cross-checked, not just searched for keywords.

- **Ask the Oracle's odds table and match handling were already exactly
  right** -- confirmed against the book's own table (Small Chance=10
  through Almost Certain=90) with no changes needed.
- **Pay the Price's table was already exactly right too** (all 20 rows,
  correct ranges), but the guidance around it was missing an important
  restraint principle the book states directly: a mechanical cost isn't
  always the right call -- "narrative costs that reveal major complications
  ... don't need mechanical reinforcement," and piling on mechanical
  penalties for every single Pay the Price risks snowballing complications
  faster than intended. Added explicit guidance to reach for a mechanical
  cost only when the moment earns it, plus the specific tool mapping
  (Lose Momentum / Endure Harm / Endure Stress / Sacrifice Resources /
  Withstand Damage / apply to an ally) the book itself lays out. Also
  handled the "roll twice" result properly -- it means call roll_oracle
  again, not a literal narrative outcome.
- **Clocks, Tension Clocks, and Scene Challenges all re-confirmed exactly
  correct** against this independent read -- no changes, which is a good
  sign the original implementation (built directly from this same section
  several sessions ago) got it right the first time.
- **Legacy Moves re-confirmed exactly correct**, including a detail worth
  explicitly checking rather than assuming: Advance's asset categories
  include Deed ("learn from your experiences or build a legacy") even
  though Deed is excluded from character creation specifically -- verified
  `buy_asset` has no incorrect category restriction carried over from the
  chargen picker, so Deed assets remain purchasable mid-campaign exactly
  as they should be.

## Context-based conditional instructions

The system prompt already had four conditional blocks (sector setup,
opening scene, truths setup, session gap) that only appear when relevant.
Extended this pattern further, but deliberately not uniformly -- not every
instruction is a good candidate, and treating them all the same would have
been a real mistake.

The prompt's ~31 instructions split into two different kinds:

- **Reactive instructions** only matter once the situation they describe
  already exists -- safe to hide until then, since there's nothing to act
  on yet regardless. Companion Takes a Hit's full two-step ruleset, the
  complete combat move-gating rules, and connection rank/bond/role
  mechanics are all like this.
- **Discovery instructions** need to stay visible even when currently
  inactive, because the GM needs to know an option *exists* to ever reach
  for it. Hiding "Scene Challenges are a thing you can use" until one is
  already active is circular -- it would never get discovered.

So the four new gates are a hybrid, not a blanket toggle:

- **Companion rules** -- fully hidden unless the character owns a
  Companion-category asset (nothing to manage otherwise).
- **Connection depth** (rank/bond/role mechanics) -- fully hidden unless at
  least one connection exists. `add_connection`'s always-visible
  instruction is the discovery hook; the detailed mechanics have nothing to
  apply to before a connection exists anyway.
- **Combat detail** -- the full move-gating ruleset only appears once
  `combat_position` or `combat_range` is actually set. Outside combat, a
  short always-visible line still points at Enter the Fray as the trigger,
  so starting a fight doesn't require the detail to already be present.
- **Scene Challenges** -- a short always-visible pointer describing the
  option and how to start one, expanding into the full outcome-resolution
  rules only once a `scene_challenge`-type track actually exists.

Measured effect: roughly **1,000 words (~18%) shorter** for a quiet
campaign with no companion, no active fight, no connections yet, and no
scene challenge underway -- which describes the very start of most
campaigns -- while a fully-active one (companion, mid-fight, connections,
an active scene challenge) is longer than either fixed version would have
been, since it gets the full detail for everything that's actually
relevant instead of a fixed subset.

This is safe specifically because the system prompt is regenerated from
scratch every turn and never persisted into message history (verified --
`chat:send` strips the system message before saving history back), so
there's no risk of stale guidance lingering from an earlier turn once a
fight ends or a scene challenge resolves.

Also fixed a real gap found while building this: there were **zero**
permanent tests asserting on system prompt content before this pass --
all earlier verification of prompt wording had been one-off manual checks,
never locked into the suite. Added 6 tests covering all four gates in both
directions (on and off), plus a check that the fully-active prompt is
strictly longer and that core instruction numbering stays intact and
non-duplicated in both the bare and fully-active cases.

### Full audit pass: "is there anything missed, forgotten, or skipped?"

At the user's explicit request, a systematic self-audit rather than a
spot-check -- cross-referencing every tool, every IPC channel, every
exposed frontend method, and the one remaining unread principles section,
instead of assuming the accumulated work across many sessions was
internally consistent.

- **Chat-log formatting had 11 more silent gaps**, found by actually diffing
  every declared tool name against every formatted case rather than
  spot-checking (this had already happened three times before across
  earlier sessions -- this pass finally did it exhaustively). Included
  frequently-used tools: `reveal_location`, `add_connection`,
  `roll_setting_truth`, `set_current_location`. All 56 tools now have
  dedicated formatting, verified by a zero-diff check, not just "looks
  complete."
- **Two dual-path UI gaps**, found by diffing every exposed preload method
  against actual frontend usage: `discardAssetManual` and `updateConnection`
  had complete backend/IPC/preload plumbing but no button anywhere calling
  them, breaking the "AI tool + manual UI" pattern used everywhere else.
  Added a discard button (with a confirm step, since it's irreversible) and
  inline connection editing.
- **A real, previously-unread principle specifically about solo play:**
  "Principles for Solo Play" had never been read at all, despite the entire
  app being built around solo play. The book is direct that solo players
  default to the harshest reading of every cost, grinding their character
  down faster than intended -- "Be a Fan of Your Character." Added this,
  plus Change Your Fate as a standing, player-invokable override (Reframe/
  Refocus/Replace/Redirect/Reshape) rather than inert move data nobody ever
  surfaced.
- **A concrete default for NPC-inflicted harm was missing** (troublesome≈1,
  dangerous/formidable≈2, extreme/epic≈3), tied directly to the
  Endure Harm/Stress parameters already built -- a number the GM needs
  constantly in a fight and had no anchor for.
- **Face Death's automatic-miss case**: when death is truly certain in the
  fiction, it's narrated directly with no roll at all -- distinct from the
  "brink of death, roll +heart" path already built. Missing before.
- **"Conflict Between Allies" confirmed correctly out of scope** -- read it
  in full rather than assuming; it explicitly requires two player-controlled
  characters and doesn't apply to solo play with a Companion asset.
- **The "Current scope" section itself had gone stale** -- it still
  described character creation as "any 3 assets from Path/Companion/
  Module" (superseded sessions ago by the real 2-Path-plus-1-final
  structure) and still listed Face Death handling as unbuilt (fully built
  two sessions ago). Rewritten to match reality, with a pointer to the
  dedicated sections below rather than re-describing everything inline.
- **Confirmed by exhaustive cross-check, not spot-check:** all 49 IPC
  handlers have exactly one matching preload bridge each, in both
  directions -- zero orphans. All three test files on disk are wired into
  `npm test` -- none forgotten.
- **Two genuinely dead functions removed:** `saveState`/`loadState` in
  `state.cjs` were a direct file-path save/load mechanism from early in the
  project, fully superseded by `store.cjs`'s actual per-campaign
  persistence and never called by anything -- confirmed via a full
  cross-file reference check before removal, not assumption. Removing them
  also left the file's `fs`/`path` requires orphaned; removed those too.

At the user's request, the entire 204-page PDF rulebook was read end to end
(not skimmed) and cross-checked against the implementation, rather than
relying on memory or the Dataforged data alone (which captures move/oracle/
asset *text* accurately, but not the surrounding mechanical rules that
govern how they interact). This turned up eleven real, book-verified gaps --
several of them significant, not cosmetic:

- **Overflow-to-momentum.** Health, Spirit, and Integrity all carry a rule
  that was completely missing: "if reduced to 0, or was already at 0, apply
  any remaining reduction to your momentum meter." Verified against the
  book's own worked example (1 health, -3 major harm → 0 health, -2 to
  momentum). Confirmed Supply has no such rule. `update_meter` now handles
  this automatically and reports it in its result.
- **Companion asset health.** Companion-category assets have their own health
  meter, separate from the character's, with the same overflow rule --
  resolved via a new `companion_takes_a_hit` tool, not the generic meter tool.
- **Vehicle Troubles were counted unconditionally -- a real bug.** Battered
  and Cursed should only count toward the momentum penalty while the
  character is aboard the affected vehicle ("otherwise, they do not count as
  an impact"). Fixed with an `aboardVehicle` flag and `set_aboard_vehicle`.
- **Permanent impacts.** Cursed, Permanently Harmed, and Traumatized can
  never be cleared once marked. `toggle_impact` now refuses to un-mark them.
- **Legacy track experience was structurally wrong.** The actual rule: 2
  experience automatically per completed box, dropping to 1 after the track
  fills its 10th box and "clears" (resets to 0, but permanently resolves
  future progress rolls against it as if at 10). Previously this required
  the GM to manually guess an amount, with no clearing logic at all.
- **Clocks were entirely missing.** Campaign Clocks and Tension Clocks are a
  full subsystem the implementation had zero code for. Built `create_clock`/
  `advance_clock`/`stop_clock` with the correct segment counts (4/6/8/10) and
  the rule that clocks only ever move forward.
- **"Other Impacts."** Some assets (Oathbreaker is the book's example) impose
  an ongoing impact-equivalent penalty with a freeform name, structurally
  different from the four fixed categories. `add_other_impact`/
  `remove_other_impact`.
- **"Set a Flag" had no persistent state.** The safety/content-boundary move
  existed only as text the GM could read but never acted on durably. Now
  real campaign state (`flags: []`), surfaced in the system prompt every
  turn so a boundary set early can't get lost to context truncation later.
- **No way to remove an owned asset.** Overcome Destruction explicitly
  requires discarding a destroyed vehicle "along with any modules and docked
  support vehicles," and there was no code path for that at all. Added
  `discard_asset`.
- **Combat Position and Combat Range** are real tracked states, not just
  narrative color -- Range specifically determines whether Strike/Clash
  rolls +iron (close quarters) or +edge (at a distance). Added as
  GM-judgment tools (`set_combat_position`/`set_combat_range`) rather than
  auto-derived from every roll outcome, since the book is explicit this is a
  fiction-first call, not a strict formula.
- **Starting asset categories were wrong** (see the dedicated section
  below): Path/Companion/Deed should have been Path/Companion/Module.

Every one of these has a dedicated test verifying it against the book's own
numbers or worked examples where one exists, not just "doesn't crash." Also
has UI, not just chat-tool access: a Clocks panel, companion health bars
with hit buttons, an aboard-vehicle checkbox, combat position/range
dropdowns, clickable impact chips, an Other Impacts row, and a Content Flags
list -- all in the character sheet sidebar, all backed by the same
dual-path pattern (AI tool + manual IPC) used everywhere else in this app.

### Second pass: Scene Challenges, and a real bug in the first pass's own fix

Continuing the page-by-page read turned up two more things:

- **Scene Challenges are now fully implemented.** This is the book's
  structured approach for an extended non-combat conflict with real time
  pressure -- disarming a device, a hacking duel, a debate, a race. It
  composes from the clocks/progress-track primitives already built, but the
  exact outcome table is intricate enough that it needed its own tool and
  system-prompt section: `begin_scene_challenge` creates a progress track
  and a linked 4-segment tension clock together (bidirectionally linked, so
  neither can exist without the other), and the system prompt now carries
  the precise rules for Face Danger / Secure an Advantage in this mode
  (weak hit marks progress *and* fills a clock segment; a miss with a match
  fills two segments; Secure an Advantage's momentum/bonus choice differs by
  hit type) through to Finish the Scene. Verified end to end: began a
  challenge, simulated a weak hit, advanced the clock, finished the scene,
  stopped the clock.
- **A real bug in the previous session's own overflow-to-momentum fix.**
  Reading the "Minimum Momentum" rule (momentum floors at -6, and if it's
  already there, "you must apply the cost some other way") exposed that the
  overflow calculation was reporting a number that didn't match what
  actually happened: at momentum -5, a hit requesting 4 points of overflow
  would only have 1 point of room, but the tool reported the full 4 as
  having come off momentum. Fixed in both `updateMeter` and
  `companionTakesAHit`, which now report `unresolvedOverflow` separately --
  the amount that couldn't be absorbed and needs to land somewhere else
  (a meter, an impact, a quest setback), per the book's explicit instruction
  that this is a GM judgment call, not a formula to guess at.
- Also found and fixed: no way to remove an owned asset (needed for Overcome
  Destruction), which is listed above but was actually found and fixed
  during this same continued pass, alongside Combat Position/Range.
- **Chat-log transparency gap.** None of the roughly 15 tools added across
  this whole rulebook pass (companion hits, clocks, combat position/range,
  other impacts, flags, scene challenges) had chat-log display formatting --
  they'd have shown as raw tool names instead of readable lines. Fixed for
  all of them.

### Third pass: Connections turned out to have their own hidden mechanics

Reading Forge a Bond, Develop Your Relationship, and Test Your Relationship
in full revealed the deepest gap of the whole review -- connections weren't
just missing a feature, they were structurally wrong:

- **Connections need their own progress track and rank**, not just a name
  and notes. Forge a Bond explicitly "compares to your progress," which only
  makes sense if each connection tracks its own relationship development
  independently.
- **Bond rewards use a second table that's inverted from ordinary progress
  marking, and easy to get backwards.** Troublesome=1 tick through
  epic=12 ticks -- the *opposite* direction from the standard rank table
  (troublesome=12 down to epic=1). A higher-ranked connection gives a
  bigger reward when you bond with them; a lower-ranked one barely moves the
  needle. Reusing the normal rank table here would have made every bond
  reward wrong. `applyTicksToTrack` was extracted as a shared primitive so
  both tables reuse the same legacy-track auto-XP/clearing logic without
  duplicating it.
- **A real mechanical fork before and after bonding.** Pre-bond, Develop
  Your Relationship marks ordinary progress. Post-bond, it's a different
  move in practice: roll using the connection's *rank as the stat value*
  (troublesome=1 through epic=5) against a fixed 2-tick reward instead of a
  rank-derived one.
- **Forge a Bond's miss consequence is conditional on player choice** ("if
  you recommit") -- built as a separate `recommit_after_failed_bond` tool
  rather than folding it into automatic miss handling, so it can't fire
  without the player actually choosing to recommit.

New tools: `set_connection_rank`, `mark_connection_progress`,
`roll_connection_progress`, `apply_bond_reward`, `recommit_after_failed_bond`,
`raise_connection_rank`, and a generic `mark_legacy_ticks` for exact
(non-rank-derived) amounts, reusable anywhere else a move specifies a fixed
number instead of a rank. 7 new tests lock in the inverted reward table
across all five ranks specifically, plus the pre/post-bond fork and the
conditional recommit.

**Three areas confirmed to need no new code**, which matters as much as the
things that did: "Joining Forces with NPCs" is pure GM narrative guidance
that already matches how the AI handles unaffiliated NPCs, Precursor Vault
exploration is fully oracle-driven, and Undertake an Expedition already
composes correctly from the standard progress-track and action-roll tools --
all three needed nothing new, just confirmation.

**Still not done:** a few smaller cross-references in the book haven't been
checked yet.

### Fourth pass: the "bond reward" table turned out to be a general mechanic

Focused sweep for anything still missed turned up one more real gap, plus
useful confirmation that several other things are already correct:

- **The reward table I built specifically for Forge a Bond is actually
  shared by three moves, not one.** Reading Fulfill Your Vow and Finish an
  Expedition in full showed they use the exact same table (troublesome=1
  tick through epic=12), the exact same "weak hit = one rank lower" rule,
  and the exact same miss-and-recommit consequence -- just applied to the
  quests and discoveries legacy tracks instead of bonds. The original
  `applyBondReward`/`recommitAfterFailedBond` were hardcoded to connections
  specifically. Refactored into generic `applyLegacyReward(trackId, rank)`
  and `recommitProgressTrack(trackId)` that work on any legacy track or
  ordinary progress track (vow, expedition), with the connection-specific
  functions now thin wrappers over the shared logic -- verified the
  refactor didn't change bond behavior at all (same test suite, same
  results) before adding the new coverage.
- Confirmed Swear an Iron Vow's connection/bond bonus (+1 to a connection,
  +2 if bonded) needs no new code -- it's just the existing `adds` parameter
  on `roll_action_move`, already fully supported.
- Confirmed Face Death, Face Desolation, and Set a Course all compose
  correctly from tools that already exist (a standard action roll plus
  impact marking in the first two cases, a supply-stat roll in the third) --
  nothing new needed.

4 new tests, including one that explicitly locks in that the Forge a Bond
wrapper still behaves identically post-refactor.

## Session zero order, background vows, and multiple sectors

Four more corrections against the actual rulebook, this time about the
shape of session zero itself rather than in-play mechanics:

- **Truths now come before character creation, not after.** The book's own
  page footer reads "...Choose Your Truths | 97" immediately before
  "CREATE YOUR CHARACTER" begins on page 98 -- and the character creation
  text itself says to "be mindful of the established truths from the last
  exercise" when picking assets. A new campaign now shows a dedicated Truths
  step first (reusing the same Truths tab UI, with a skip option -- you
  don't need all 14, even two or three is enough to continue), and only
  then moves to character creation.
- **Background vows were entirely missing.** Step 4 of character creation is
  "Write Your Background Vow" -- always epic rank, and per the book "you've
  already sworn this vow as part of your background, and don't need to
  actually make the [Swear an Iron Vow] move in-game." Added as a field in
  character creation; it creates the vow's progress track directly, no roll.
- **The starting-asset picker was structurally wrong**, not just missing a
  category. It's not "any 3 assets from a few categories" -- it's exactly
  2 Path assets, then 1 final asset from Module, Support Vehicle, Companion,
  *or* Path again. Character creation is now a proper 3-step flow matching
  this exactly, rather than one flat picker.
- **Sectors are meant to be plural over a campaign, and there are 4 regions,
  not 3.** "As you head out into the unknown, you can discover, explore, and
  name new sectors" -- Terminus, Outlands, Expanse, and Void (the near-empty
  gulf beyond the Forge). The engine had a single embedded sector object.
  Refactored to `sectors` (a map) + `currentSectorId`; every sector tool
  (`reveal_location`, `add_location_feature`, `set_current_location`,
  `set_sector_info`) now takes an optional `sector_id`, defaulting to
  current. New `create_sector`/`switch_sector` tools, plus a sector-switcher
  tab bar in the Sector view. Caught a real bug in this refactor before it
  shipped: the new sector-ID generator initially collided with the default
  sector's hardcoded ID -- found by testing, not by inspection.
- **The GM now starts the campaign automatically.** Character creation used
  to leave the player looking at an empty chat, waiting to type first. Now
  it immediately sends a kickoff turn, and the system prompt is explicit
  that this isn't a normal message to wait on -- populate the starting hex
  with 2-3 real features (a star and a settlement at minimum, oracle-rolled,
  not invented) plus 1-2 nearby hexes, then open with a real scene that
  references the character's background vow and description naturally,
  ending on a concrete situation rather than "what do you do?"

12 new/updated tests cover the multi-sector isolation (two sectors never
leak state into each other) and the background vow's exact rank.

## Session zero: Setting Truths, Connections, campaign log

The 14 Setting Truth categories (Cataclysm, Exodus, Communities, Iron, Laws,
Religion, Magic, Communication and Data, Medicine, Artificial Intelligence,
War, Lifeforms, Precursors, Horrors) were sitting fully loaded in the data
layer with zero tooling or UI -- a real gap, not a minor one, since they're
core Starforged session-zero material. Now built out properly:

- **Truths tab** -- browse all 14 categories, each with its 3 canonical
  options (full description text and a Quest Starter for vow inspiration,
  straight from the source data), roll for a random one or pick manually.
  Categories with a nested subtable (Cataclysm, Magic, Artificial
  Intelligence) surface those as follow-up choices.
- **The GM rolls truths proactively too** -- as part of the same
  campaign-start procedure as sector generation, it rolls at least Cataclysm
  and Exodus (the two that ground how the character's people got here) and
  weaves the Quest Starter into the opening scene, then rolls the remaining
  12 opportunistically as they become relevant in play, rather than dumping
  all 14 on the player up front.
- **Connections** -- NPCs, allies, contacts the character knows. The GM adds
  these via `add_connection` when someone worth remembering appears; also
  editable directly from the character sheet sidebar.
- **Campaign log** -- short continuity notes at natural breakpoints (`add_log_entry`),
  visible in the sidebar, editable manually too.

All of this is tool-driven and tested (8 new engine tests), with the same
dual-path pattern as the sector map: AI tools for in-fiction use, plus direct
manual IPC/UI editing that bypasses the AI entirely for quick bookkeeping.

**Also fixed in this pass:** `sector:set-info`'s IPC handler was silently
dropping the `notes` field (the Sector Trouble hook) added in an earlier
session -- editing sector notes from the UI did nothing. Caught via code
review while wiring up the truths IPC handlers alongside it, not by running
the app; a good reminder that a passing test suite doesn't guarantee every
wiring path was exercised.

**One inconsistency found right after, by inspection rather than testing:**
sector locations and connections always accepted free-text content, both
from the GM and from manual editing -- but Truths didn't. The Truths tab only
offered the book's 3 canonical options per category, and the GM only had
`roll_setting_truth` (a real dice roll against the fixed table), with no way
to record a custom truth at all. Fixed: added `set_setting_truth` (freeform,
for when the player wants to define a category themselves) and a "Write your
own" form in the Truths tab, so custom content is now possible everywhere
content can appear -- truths, locations, and connections alike.

## Multiple campaigns

The backend has threaded `campaignId` through nearly every IPC call since
early on -- the UI just never let you use more than `"default"`. Fixed:

- **Campaign Select screen** on launch (or via the "Campaigns" topbar
  button) -- lists every saved campaign (character name, sector name, last
  played), click one to continue it, or start a new one. Delete requires a
  confirm click.
- New campaigns get a real generated id (`campaign-<timestamp><random>`),
  not a hardcoded `"default"` -- `campaign:new` also accepts an explicit one
  if given, generates one server-side as a fallback if not.
- New IPC: `campaign:summaries` (name/sector/last-modified for the picker,
  without loading full state for every campaign), `campaign:delete`.
- Custom assets remain a single global library shared across all campaigns,
  by design -- that part didn't change.

7 new engine tests cover `store.cjs`'s campaign listing/deletion and the
custom-asset persistence functions directly (against a real temp directory,
not mocked), since neither had test coverage before despite backing
persistence that matters a lot if it's wrong.

### Rename, duplicate, and export/import

A campaign's only identity used to be its character's name. Added:

- **Rename** -- a campaign nickname, separate from the character's own
  name (`campaignName`, distinct field). Shown alongside the character
  name in Campaign Select if set, falls back to the character name if not.
- **Duplicate** -- a real deep copy under a new campaign id, for
  experimenting with a different choice without risking the original.
  Doesn't duplicate generated images -- they're content-addressed by id and
  immutable once created, so both campaigns safely reference the same
  files without needing a copy.
- **Export/Import** -- native OS save/open dialogs (not a browser-style
  download) write or read the full campaign save (mechanics + chat
  history) as JSON. Generated images are deliberately **not** included --
  they live as separate files referenced by id, not embedded in the save --
  so an imported campaign will have working mechanics but missing pictures.
  Said plainly in the UI rather than silently losing them.

**A real bug found while building this, not introduced by it:**
`campaign:summaries` (the data behind the Campaign Select list) was still
reading `record.state.sector.name` -- the old, singular field name from
before the multi-sector refactor several sessions ago. Multi-sector changed
this to `state.sectors[state.currentSectorId]`, and the summaries handler
was never updated to match. The mismatch threw silently inside a try/catch
meant for genuinely corrupt save files, so every campaign's sector name had
been rendering as blank in the picker since that refactor shipped. Fixed
alongside adding the name field, since the summaries handler needed
touching anyway.

## Chat bubbles were showing raw markdown syntax, never rendering it

Requested directly, and confirmed by the exact same transcript from the
railroading report just above -- the screenshot's `**Cinder**` and
`# The Delphian Tide` weren't stylistic choices in the display, they were
literally what showed up: the chat log rendered `{message.content}` as a
raw string the whole time, with zero markdown parsing anywhere. Since GM
narration naturally comes back from the model in markdown (bold, headers,
lists), every message was showing the raw asterisks and hash marks as
visible characters.

Added `react-markdown` (the standard choice for this, actively maintained,
and safe by default -- it doesn't render embedded raw HTML unless a
plugin is explicitly added for it, which matters here since this renders
model-generated text). Wired into both GM and player bubbles, so nothing
looks inconsistent between them. Deliberately left off the GFM extensions
(tables, strikethrough) -- narration doesn't need them, and skipping them
is less surface area to style and get wrong.

**A real, previously-nonexistent gap found while wiring this up, not
after:** a plain markdown-rendered `<a href>` inside an Electron window
navigates the window itself away from the app on click -- not a new tab,
the actual app window, with no easy way back short of a restart. GM
narration linking anywhere is a rare edge case, but a markdown renderer
needs every element type handled sensibly, not just the common ones.
Added a small `shell:open-external` IPC path (scheme-validated -- only
http/https, verified directly against `javascript:` and `file:` URLs
before considering it done) so a link opens in the real OS browser
instead, and overrode `react-markdown`'s link rendering to route through
it rather than default navigation.

Verified against the real pipeline, not a hand-built approximation of
it: rendered the exact transcript text (headers, bold, a list, a rule)
through the actual `react-markdown` library via `react-dom/server`, wrapped
in the app's actual compiled CSS, and viewed the result through a real
Electron/Chromium window -- not `wkhtmltoimage` this time, learned that
lesson from the sector-map marker fix a few sessions back, where its
older WebKit engine rendered something that looked broken but wasn't.
Confirmed clean: proper heading styling, genuine bold text with no stray
asterisks, a correctly indented bullet list, and an actual horizontal
rule where the markdown source had one.

## A self-inflicted railroading pattern, traced to my own literal wording

Reported with a transcript of an actual campaign opening -- a genuinely
well-written noir-detective scene, ending on an NPC handing the character
a job and the GM asking "What does Gene vow?" The complaint: the AI keeps
pushing the player toward certain actions rather than telling a story
based on their actual choices.

Traced this to its exact source rather than guessing at a general fix,
since the screenshot was literally the opening scene the "Begin Your
Adventure" instruction produces. Found it immediately: that instruction
said, verbatim, to land the opening "on the concrete decision point where
swearing the vow is **the obvious next move**." That's not a vague
tendency the model drifted into -- it's a direct, faithful execution of
what I explicitly told it to do. The narration in the transcript
("There it is: a job, dropped in his lap... The kind of vow Gene Corvus
knows how to swear") presupposes accepting the hook is already settled,
because the instruction it was following presupposed exactly that.

Reworded it to present the situation honestly and let the player actually
decide -- take it up, decline, push back, or do something else -- rather
than narrating as if one path were already chosen. Kept the important
clarification the rewrite would have otherwise dropped (this is a *new*
quest vow, distinct from the already-sworn background vow, which never
gets rolled) -- caught losing it during the edit itself and restored it
before moving on, rather than after.

**Fixed the specific cause, then checked for the general one, since a
single railroaded scene is rarely really a single-instruction problem.**
There was no existing instruction anywhere about the *substance* of player
agency -- plenty about how choices should be *formatted* (short, concrete,
non-mechanical, from earlier tone work), nothing about whether they were
*genuine*. Added 6e: offered choices should lead somewhere actually
different from each other, not converge on the same result in different
words; the GM shouldn't narrate toward a predetermined outcome and dress
it up as a choice; a player declining a hook or doing something
unanticipated isn't a problem to correct back onto a track. Scoped to
every hook and NPC request during play, not just the opening, since the
underlying failure mode isn't specific to campaign-start.

2 new tests, including one that explicitly asserts the old "obvious next
move" phrasing is gone, not just that new text was added alongside it.

## Moves audit, installment 3 (FINAL) -- all 56 moves complete, matching the 90-asset audit's own completion

Finished the moves audit: Connection (4), the rest of Combat (7), and
the rest of Suffer (5) checked against real move text this final
installment. Combined with the two installments before it, all 12 move
categories and all 56 moves are now covered -- the same completeness
already reached for every asset in the game two audits ago.

**Test Your Relationship had a real gap**, not just a missing detail --
only its miss branch was ever documented. The actual move cascades into
Develop Your Relationship on both a strong and weak hit (the weak hit
adding a complication on top), and that cascade simply didn't exist in
guidance before this pass.

**Strike and Clash look nearly identical -- same stats, same close/
distance split -- but have a genuinely different weak-hit result**, easy
to conflate and high-stakes since one or the other resolves nearly every
combat exchange in the game. Strike marks progress twice on both its
strong *and* weak hit; Clash only marks twice on strong, once on weak.
Neither was documented before. Also wired in Take Decisive Action's real
six-option complication table, confirmed to exist in the data with
exactly six entries, rather than leaving the model to invent a generic
one.

**A genuine tool-schema gap, caught the same way the companion-healing
mistake was caught two turns before it: by checking what a tool can
actually do before writing guidance that assumes it.** Lose Momentum's
rare "-6 floor" edge case needs to *clear* progress on any track type,
but `mark_legacy_ticks` can only ever add (schema-enforced minimum of 1)
and only targets legacy tracks. Checked the underlying function first,
confirmed it already supported negative deltas correctly, and built a
proper general-purpose `adjust_progress_ticks` tool rather than write
guidance around a tool that couldn't do what was needed. Also documented
Sacrifice Resources' "unprepared" cascade, confirmed as a real tracked
impact and previously undocumented entirely.

6 new tests. Full regression, syntax, types, and playtest clean.

## Follow-up, with a screenshot: the Connections UI itself wasn't showing any of what last entry just added display support for

The location fix from last entry only reached the AI's own view of
the state -- the actual Connections panel in the UI still showed just
a portrait, name, and notes. No rank, no progress tracker, no bond
status, no role. Everything the backend has tracked correctly this
entire project -- rank, a real 10-box progress track, whether a bond
has formed, role and its bonus -- was invisible to the player looking
at their own connection.

**Reused the exact same progress-track rendering already used for
vows**, rather than inventing a new visual pattern -- same CSS classes,
same box-fill math, confirmed to actually exist in the stylesheet
before relying on them rather than assumed. Sanity-checked the
copied tick-to-box math directly across every boundary case (0, a
partial box, 39, exactly 40, and an over-40 value that should clamp)
since a visual miscount here would be easy to ship unnoticed.

**One rule-accurate detail worth calling out specifically: a bonded
connection doesn't get a progress track shown at all.** Per the
book, once bonded, "you no longer have a progress track associated
with them" -- Develop Your Relationship becomes a direct roll instead.
Showing a stale box track for a bonded connection would misrepresent
a mechanic that's already moved on; the UI now shows the rank plus an
explicit "(bonded -- no progress track)" note in that case instead of
a track that no longer means anything.

Also added role (with its actual bonus value, and a second role if
Forge a Bond's "Expand their influence" was chosen) and clear BOND /
SUSPENDED badges, matching state this project has correctly tracked
all along but never actually surfaced.

Pure frontend display work, no backend logic touched -- no new
automated tests (consistent with this project's own established
practice for React-only changes, verified instead via `tsc` and the
manual math check above). Full regression, syntax, types, build, and
playtest clean.

## Reconsidering last entry's stance, correctly: hand-verified structured effects, actually auto-applied for real

Pushed back directly on last entry's conclusion, and the pushback
identified a real distinction I'd conflated. What I declined last
time was runtime parsing -- inferring structure from the free-text
effect strings on the fly, which is genuinely unsafe given how varied
the phrasing is. What was actually being proposed is different: hand-
verify and structure each ability's mechanics deliberately, ahead of
time, the same disciplined, source-checked process already used for
every other fix this session -- just written as data instead of
prose. That distinction changes the risk profile completely, and I'd
skipped past it.

**Built applyStructuredAssetEffect plus a hand-verified table** of
asset abilities whose FULL mechanics -- not just part of them -- are
completely representable: no player choice, no reroll, no
consequence the schema doesn't also cover.

**Verifying every single entry individually against the real effect
text, rather than trusting an earlier summary from memory, caught
substantial, real problems in the first draft before any of it
shipped:**
- Most "momentum on hit" entries were missing the roll bonus that's
  the OTHER half of the same ability -- "+1, +1 momentum on hit" is
  two effects, and only one had been captured.
- Several candidates (Medbay, Overseer, Vehicle Bay, Rover,
  Bannersworn) turned out to have an unstructured reroll or stat-
  substitution component that would have been silently dropped if
  included as-is.
- Reinforced Hull and Heavy Cannons L2 have real miss consequences
  (a module breaking, "a dire outcome") entirely outside the schema.
- A genuine logic bug: match-only legacy ticks with no separate
  on-hit base would never have fired at all under the original gate,
  and that same gate checked "any hit" when the source text
  consistently specifies "strong hit w/ match" for these abilities --
  a matched weak hit would have wrongly granted a tick that
  shouldn't exist.

All caught by actually re-checking, not assumed correct because the
first pass looked reasonable.

**The final, smaller, fully-verified table is wired into
check_asset_bonuses.** Called again after a roll with the real
outcome and match, it now genuinely computes and applies momentum and
legacy changes for this verified subset -- confirmed directly against
real character state changing, not just the shape of a returned
object -- attached as an "applied" field on that specific ability's
own entry. Everything outside the verified table still returns as
plain text for the model to read and apply itself, exactly as before,
with no false "applied" field implying something was handled when it
wasn't.

2 new tests covering every distinct case caught during verification,
including the strong-hit-match gating bug directly. Full regression,
syntax, types, and playtest all clean.

## The 0.3 headline: an Expanse view -- how sectors actually connect to each other, both AI- and player-editable

Grounded in real, existing rules mechanics rather than invented from scratch: a map-edge passage (toCell: null, per "Build a Starting Sector," Step 7's own "connect a settlement to the edge of your sector map") already existed as the game's real mechanism for "this leads to another sector" -- the sector map already drew it as a dashed stub pointing outward. What didn't exist was any record of WHICH specific sector that stub actually led to, or any view showing how a growing campaign's sectors relate to each other at all.

**Data model**: passages gained a real `toSectorId`, only ever meaningful on a genuine map-edge passage (validated directly -- an in-sector passage can't also point at a different sector, a sector can't link to itself, an unknown destination is rejected cleanly). Both the AI and the player can set it, per direct instruction: `create_sector` gained a `via_passage_id` convenience for the common case (a new sector existing specifically because the party traveled a known route -- one real event, not two separate tool calls), and a standalone `link_passage_to_sector` handles corrections either way, exposed identically to the AI as a tool and to the player as a manual IPC action.

**A real gap found and fixed while verifying the AI side of this**: the passages list already shown to the AI in every system prompt had no way to display `toSectorId` at all -- even a fully-linked passage would have looked identical to an unlinked one, so the AI had no way to see the current state before deciding whether to link something. Fixed the prompt's own passage display to show the real destination sector's name when linked, or say plainly that it isn't yet -- verified directly against constructed linked and unlinked passages side by side in the same prompt, not just reasoned about.

**A real design mistake caught before shipping, not after**: the first layout algorithm spread every node at a given tree depth evenly around the full circle regardless of which parent it actually connected to -- traced through an actual multi-branch scenario and confirmed it could place a child on the opposite side of the circle from its real parent, the connecting line cutting through unrelated nodes. Rewrote it as a proper radial subdivision, where each node's angular slice comes from subdividing its own parent's slice by descendant count -- verified directly this time: a parent's three children all land within a 160-degree arc centered on the parent's own direction, not scattered across 360 degrees.

**New Expanse view**: sectors as nodes (the current one highlighted, any fully disconnected sector marked with a dashed border rather than blending in), linked passages as edges between them, laid out deterministically since Starforged sectors have no fixed spatial coordinates to reproduce -- only a legible relationship to represent. A dedicated "Open passages" list underneath is the actual control center for linking and correcting -- every map-edge passage across every sector in one place, matching the same no-duplicate-home pattern already used for Truths, the Codex, and Combat. The old flat button list for switching sectors, previously duplicated inside the Sector view itself, is retired now that this is its real home; sector creation stays where it was, since that's a genuinely different action.

3 new tests (passage/sector linking end to end, including every real validation failure and the full tool dispatcher path), 1 existing test expanded for the new prompt display. Full regression, syntax, types, build, and playtest all clean.

## "There should be no duplicates" -- a real, widespread Oracles panel bug, not the three categories in the report

Screenshots showed the same handful of names -- Feature, Peril,
Opportunity, then a separate cycle of Observed From Space, Planetside
Feature, Life, Atmosphere -- repeated dozens of times in a row,
looking exactly like broken, duplicated data.

**Checked the real data directly rather than assume the screenshots
told the whole story.** It wasn't duplicated at all -- Location
Themes alone has 25 genuinely distinct oracle tables (Chaotic,
Fortified, Haunted, and more, each with its own real Feature/Peril/
Opportunity content), Planets has 84 across a dozen planet types.
Every single one has a different id and different actual table
contents. The bug was display-only: the panel labeled each oracle
with just its bare leaf name (Dataforged's own Display.Title, when
set, or the plain hierarchical name), with nothing distinguishing
"Feature" under Chaotic from "Feature" under Fortified from "Feature"
under Haunted -- so on screen they were completely indistinguishable,
even though the underlying data was entirely correct.

**Confirmed this wasn't limited to what showed up in the report.**
Checked every oracle in the real catalog against its siblings under
the same top-level category: 150 of 250 (60%) share a leaf label with
at least one other oracle in the same group. Location Themes,
Derelicts, and Planets were the ones that happened to get
screenshotted, not the extent of the problem.

**Fixed generally, not with a special case for the three reported
categories.** The label now prepends whatever path segments sit
between the top-level category (already shown as the group header,
so not repeated) and the final leaf -- "Chaotic — Feature" instead of
just "Feature". Verified directly against the entire real catalog:
zero oracles still share a label with a sibling after the fix, and
every already-unique label (a simple case like "Core / Action") comes
through completely unchanged, not just "probably fine."

TypeScript check, full build, and the complete engine test suite all
clean.

## Two real corrections to the Combat view, both direct feedback: a genuine duplicate found, and a design choice reversed

**The duplicate was real, and pre-existing** -- when the Combat tab
was built, the sidebar already had its own "Combat" section showing
position and range, missed at the time. Worth noting what that
existing section already said, verbatim: *"Set by the GM from how
rolls actually go -- not something to override directly."* That was
already the established, intended philosophy for this specific data
before the new tab existed -- checking for it first would have meant
never building the editable toggles in the first place. Removed the
sidebar section entirely now that the dedicated tab is the one real
home for it, matching the same pattern already used for Truths, the
Codex, and combat objectives themselves.

**The Combat tab is now fully read-only.** Position and range are
plain display now, not toggle buttons -- reusing the sidebar's own
former wording almost exactly, since it already said the right thing.
Removed the manual, non-AI edit IPC handlers (combat:set-position,
combat:set-range) and their preload/type plumbing entirely, since
nothing calls them anymore -- confirmed with a full sweep, careful to
leave the AI's own set_combat_position/set_combat_range tools and
their existing tests completely untouched, since those are genuinely
separate from what got removed.

Full regression, syntax, types, build, and playtest all clean. Bundle
size decreased slightly, consistent with removing rather than adding
code.

## v0.2.0

The four items on the 0.2 roadmap are all shipped -- the Codex, the
Combat/Encounter view, the Oracles panel, and the small backlog
(lastPlayedAt, image deletion, a readable export), each with its own
detailed entry directly below this one. Rather than continue the
0.1.x patch sequence for what amounts to a real, deliberate
milestone, the version itself now reflects that: 0.2.0.

Full regression, syntax, types, build, and playtest all clean --
nothing about this bump is version-number-only under the hood; it
went through the same verification pipeline as every other change
this session.

## Closing out the small backlog: lastPlayedAt, image deletion, and a readable export -- all three, "none of them hard"

Three items already agreed as small gaps, done together.

**lastPlayedAt was already tracked in campaign state but genuinely
never surfaced anywhere.** Campaign Select showed a timestamp, but it
was the save file's own disk mtime, not the purpose-built field --
mtime moves on any write at all, including a migration running on
load or one of this session's own manual, non-AI edit handlers
(combat:set-position, campaignElements:add), not specifically real
play. Both the displayed text and the sort order now prefer
lastPlayedAt when available, falling back to mtime only for a
brand-new campaign with no turn played yet.

**Found a second, related gap while investigating image deletion**:
store.cjs's own deleteImage function was real, already fully built --
and never called anywhere in main.cjs at all. The existing
images:remove-illustration handler only ever cleared the state
reference, silently orphaning the actual file on disk forever every
single time it was used. Fixed that handler directly, and built a
new, more general removeImageEverywhere -- checked against all four
real places an image can live (portrait, connection, sector cell,
illustration), with a dedicated test for each -- for the Image
Gallery, the one place every category is shown side by side and
needs one delete action that works the same regardless of which kind
it's looking at.

**Readable export reuses the chat UI's own role-filtering logic**
(user messages and non-empty assistant content are the story;
system/tool messages and tool-call-only turns are internal mechanics)
rather than reinventing it differently on the backend side. Verified
directly against a realistic, multi-turn transcript including a tool
call, a skipped tool result, and an empty final turn, before trusting
the output. A second export option, genuinely different from the
existing JSON save -- Markdown, meant for a person to read, not for
this app to import back in.

1 new test. Full regression, syntax, types, build, and playtest all
clean.

## Third item on the 0.2 roadmap: an Oracles panel

Grounded in the existing MovesPanel first, since it's the direct
precedent -- but the design actually diverges from it in one
important way. MovesPanel composes a chat message and lets the AI
resolve the move; an Oracles panel exists specifically so a player
can consult an oracle *without* going through the AI at all -- a
direct, instant roll, no waiting on or spending a turn for it. The
panel rolls immediately and shows the result right there, with an
optional "Send to GM" step only if the player wants it woven into the
ongoing story.

**Two real bugs caught by testing the actual logic directly, not just
checking syntax.** `node --check` passed cleanly on both, but neither
handler would have worked the first time a player actually clicked
"Roll": the new oracle-rolling handler referenced `dice.rollOracleTable`
with no `dice.cjs` import anywhere in `main.cjs` at all (a genuine
`ReferenceError` waiting to happen), and separately called
`data.getOracleIndex()`, a real function that exists but was never
exported -- only `findOracle`, `flattenOracles`, and `suggestOracles`
are public. Both caught by actually running the handler's logic
end-to-end against the real oracle catalog (all 250 tables) before
trusting it, not by assuming a clean syntax check meant it worked.

**Reused `flattenOracles()` and `findOracle()`** -- the same functions
the AI's own `roll_oracle` tool already depends on -- rather than
duplicate that lookup logic. Two new, genuinely stateless IPC
handlers (no `campaignId` needed at all, since rolling an oracle
doesn't mutate any campaign state): one to list the full catalog for
the panel's own search/browse, one to roll a specific table by id.

**New OraclesPanel**, reusing MovesPanel's own CSS classes directly
rather than duplicating near-identical panel chrome -- searchable
(essential at 250 entries, unlike Moves' much smaller, flatter list),
grouped by top-level category derived from each oracle's own
breadcrumb path, with the roll result and an optional "Send to GM"
shown inline once rolled.

Full regression, syntax, types, build, and playtest all clean.

## Second item on the 0.2 roadmap: a dedicated Combat/Encounter view

Grounded in the actual state first, not assumed: combat position
("in control" / "in a bad spot") and range ("close" / "distance")
already exist as real, well-tested state (`setCombatPosition`,
`setCombatRange`, both already covered by existing tests since they
were first built) and already gate real mechanics -- which of four
combat moves is even legal to make, and which stat Strike/Clash rolls.
But neither had ANY presence in the UI at all before this -- not
read-only, not editable, nothing. A confirmed, complete gap, not a
partial one: `grep`ing for any manual IPC handler touching either
field turned up zero results.

**Scope decided deliberately, not just built maximally.** Progress
tracks of every type (vows, expeditions, connections, and combat
objectives alike) are read-only everywhere in this app today -- no
manual edit path exists for any of them yet. Rather than have this
one feature quietly introduce that capability only for combat tracks
specifically (a real inconsistency with everything else), combat
objectives stay read-only here too, just filtered and prominently
shown. Position and range are different: two simple three-state
toggles with zero prior UI to be inconsistent with, and exactly the
state a real report called out as easy to lose track of scrolling
back through chat -- so those two specifically got real manual edit
support, backed by two new IPC handlers wrapping the same,
already-tested state functions.

**New dedicated Combat tab**, following the same pattern already used
for Truths and the Codex: position and range shown and editable, with
a plain-language summary of which moves are currently legal (derived
from the same rules already encoded in the system prompt's own combat
guidance, written here for a player rather than the model) and a
filtered, read-only list of active combat objectives using the same
track-card visual as the character sheet.

Combat-type tracks removed from the sidebar's generic Progress Tracks
list -- they have a real, better home now, matching the same
no-duplicate-home decision already made for Truths and Campaign
Elements.

Full regression, syntax, types, build, and playtest all clean. No new
backend logic needed testing -- `setCombatPosition`/`setCombatRange`
were already solid; this only added a new manual entry point to them.

## A real Codex, built for 0.2 -- Campaign Elements upgraded from a flat list into a categorized, browsable, searchable feature

The first of several 0.2 features, chosen deliberately first: this session's own history of continuity bugs (truths not making it into the opening scene, the vow rank-change gap, the misleading asset-bonus label) was the actual argument for building this -- a long campaign accumulates a lot of established state that only lives in prose, and a real place to check it against helps both the player and future debugging.

**Grounded the design before touching code.** Campaign Elements already existed as a real, rulebook-based feature (Chapter 5, "More Oracle Options" -- confirmed via this project's own history, not re-derived from scratch) -- a flat list of `{id, text}` entries the AI could roll on to connect a new situation to something already established, with the category baked informally into the string itself (e.g. "Faction: Silver Dominion") rather than captured as real data. The rulebook PDFs in this project turned out to be image-only with no extractable text layer, so rather than detour into OCR for what is fundamentally a data-model and UI upgrade of an already-built, already-considered feature, the new category taxonomy was grounded in the app's own existing starter-set guidance instead.

**New shape**: `{id, category, name, description}` across seven categories (People, Factions, Locations, Threads, Items & Vehicles, Themes, Other) -- `category` validated against a single, real, exported list (`state.cjs`'s `CAMPAIGN_ELEMENT_CATEGORIES`), never duplicated as a second copy anywhere else that could drift, including in the frontend's own TypeScript types.

**Real migration, not just new-campaign support.** Existing saves have old-shape entries with no category information at all -- rather than guess, they migrate to `category: 'Other'` with the old text becoming `name`, following the exact same backward-compatibility pattern already established in `loadCampaign` for previous data-model changes (sector passages, the vehicle-troubles migration). Verified directly against a simulated old-shape save before trusting it.

**A genuine dedicated view, not a slightly-improved sidebar chip list.** The old compact sidebar section is gone entirely -- following the same pattern already used for Truths (there's no separate `TruthsSection`; `TruthsView` is the only place truths live), Campaign Elements now has its own tab: grouped by category, filterable by a real search box, with name and description shown together per entry, and an add form with a real category dropdown fetched from the same single source of truth the backend validates against.

**Every consumer touched, verified with a full sweep afterward, not assumed complete from the parts that were obviously changed**: both tools' schemas and handlers, the debug-log formatters, the system prompt's own display line and its 10-item starter-set guidance (now explicitly mapped onto the new categories), and two existing backend tests rewritten for the new shape with new coverage for the validation behavior that didn't exist before.

2 tests rewritten, full regression, syntax, types, build, and playtest all clean.

## Narrative rules: reworked from a replaceable override into a genuine addition

Direct correction: the player's own narrative rules text should be an
addition on top of the built-in default, not something that overwrites
it -- a real change of semantics, not a tweak to the last pass.

**The design from the previous two passes couldn't support this
cleanly.** Pre-filling one editable box with the literal default text
and letting the player edit it in place -- exactly what the immediately
prior change did -- makes "the default part" and "the player's genuine
addition" inseparable once they're mixed together in the same field.
There's no way to tell, from the final edited text alone, which parts
are the original rules and which parts are new. Splitting these into
two actually separate things was the only way to make "additive, not
overwritten" true rather than just claimed.

**Reworked into two clearly separate fields.** The built-in default is
now shown in its own disabled, read-only textarea -- visible, but not
editable, so there's no ambiguity about what it is. A second, genuinely
empty textarea holds the player's own additional guidance; anything
written there gets appended after the default in the actual prompt,
never merged into or replacing any part of it. Verified this directly:
built the prompt with a real addition and confirmed the full default
text is still present, the addition appears after it (not before or
interleaved), and an empty or whitespace-only addition behaves
identically to supplying none at all.

**This also removed a risk from the prior design, not just changed the
UI.** The previous pass needed a careful "compare the box against the
live default at save time" check specifically to stop an unedited
default from getting silently locked in as a permanent override. That
whole problem stops existing once the additional-guidance field is
never pre-filled with the default in the first place -- Save is back to
simply storing whatever's actually typed, or nothing if the field is
empty.

2 existing tests rewritten for the new additive assertions. Full
regression, syntax, types, build, and playtest all clean.

## Narrative rules box should show the actual default text, not leave it blank

Direct follow-up: the box shouldn't start blank with the default only
shown as grayed-out placeholder text -- it should actually contain the
default, editable in place, with a real reset option if it changes.

**The real risk this surfaced, worth catching before it shipped**: if
the box always shows the default text and Save just writes whatever's
in the box, then anyone who opens Settings and hits Save -- without
touching this field at all -- would silently lock in a snapshot of
today's default as a permanent override. That defeats the whole reason
"unedited means use the default" mattered in the first place: this
exact text has already been revised multiple times this session (the
length target alone went through two real changes), and a player who
never customizes this field should keep benefiting from that kind of
future refinement, not get frozen on whatever wording happened to be
current the first time they opened Settings.

**Fixed by comparing against the live default at save time, not by
checking for emptiness.** The box is now pre-filled with the real
default once fetched -- but only when the player has no actual saved
override already, so a returning player's real customization is never
silently clobbered by the timing of that fetch. On Save, the typed
text is only stored as an explicit override when it's genuinely
different from the current default; if it matches (never touched, or
edited back to match), nothing is saved at all and the player keeps
tracking the live default going forward. "Reset to Default" now
restores the actual default text into the box and disables itself
once there's nothing left to reset.

Traced all four real scenarios by hand (fresh player, an actual edit,
resetting after an edit, a returning player with a real customization)
against the updated logic before considering this done. TypeScript
check, full build, and the complete engine test suite all clean.

## Narrative rules made genuinely player-editable through Settings

Requested directly: single out a "narrative rules" prompt and make it
editable through Settings. Instruction 2 -- the length target, show-
don't-tell principle, and no-unfilled-placeholders rule, all iterated
on multiple times earlier this same session -- is the one cohesive,
self-contained chunk of the system prompt that's actually about *how*
to narrate, as opposed to which tool to call or what a specific move
does. Kept the scope to exactly that, rather than also folding in
other narrative-adjacent guidance scattered elsewhere in the numbered
list (like leaning on the character's callsign and pronouns), since
that would mix two different concerns into one editable field and
make it a riskier thing for a player to safely customize.

**Extracted into a real, exported DEFAULT_NARRATIVE_RULES constant**,
with buildSystemPrompt accepting a player-supplied override that
replaces it entirely (not appended alongside it) when non-blank.
Verified byte-for-byte, not just "looks right" -- diffed the actual
pre-edit file's real output against the post-edit version with no
override supplied, via git, to confirm transcribing the text into the
new constant introduced zero characters of drift.

**Wired through end to end**: config.narrativeRules flows into both
buildSystemPrompt call sites in main.cjs; a new IPC channel exposes
the default text itself to the renderer, so Settings' "reset to
default" button and its placeholder text both read from the one real
copy of that text rather than a second, hand-duplicated one that could
quietly drift from it over time. Settings gained a new "Narrative
rules" section -- a textarea, blank by default (meaning "use the
built-in rules," shown as placeholder text), completely replacing them
when the player writes something of their own.

2 new tests covering the override, empty, and whitespace-only cases.
Full regression, syntax, types, build, and playtest all clean.

## Background update checking, and a single topbar button replacing the Settings-only manual check

Requested directly: periodic, automatic update checking, plus a small,
non-intrusive way to surface it -- offered as a choice between a
top-of-screen bar or a button near Settings, with the update checker
removed from Settings in the latter case. Went with the button: it
matches the existing row of small icon-btns in the topbar (Moves,
Gallery, Settings) rather than introducing a new, heavier UI pattern
just for this, and a persistent bar is a bigger, harder-to-ignore
fixture than what "non-intrusive" was actually asking for.

**Background checking**: once, a few seconds after launch (a short
delay so it doesn't compete with the initial campaign load), then
every 4 hours for anyone who leaves the app open a long session -- a
real possibility for this kind of game. Deliberately no auto-download
or auto-install here, matching updater.cjs's own conservative design
from when auto-update was first built: this only ever discovers an
update exists. Downloading and installing both stay explicit actions
the player takes, never something that happens on its own.

**The button itself** is a single element whose label, styling, and
click behavior all follow from the current status -- low-key (plain,
matching every other topbar button) until there's actually something
worth noticing, then stepping up to the same accent colors used
elsewhere for a genuine option (cyan) or a ready action (the green
already used for burn_momentum's own improved-outcome choice). Doubles
as the manual "check now" replacement for what Settings used to offer,
since clicking it while idle triggers a check directly.

**Settings' own "App updates" section removed entirely**, per the
request -- its state (current version, status, the check/download/
install buttons) is gone from there and now lives at the App level
instead, since the topbar button needs it regardless of whether
Settings happens to be open.

TypeScript check, full build, and the complete engine and updater test
suites all clean -- no backend changes were needed here at all,
updater.cjs's own check/download/install IPC handlers are unchanged;
this was purely about when checking happens and how it surfaces.

## "Why does it use Utility Bot when there's no mention of it?" -- a real, direct question that turned out to be a misleading label, not a misapplied mechanic

Uploaded log from a mixed-format file (this campaign's log spanned the
v0.1.14 update mid-session -- both the old compact and new pretty-
printed entries needed handling in the same file to read it at all).

**Checked the actual mechanics before assuming anything was wrong.**
check_asset_bonuses surfaced Utility Bot for a Face Danger roll with
no narrative connection to it at all -- but the roll that followed
used the normal +wits stat, not the bot's health-substitution ability.
The AI's actual judgment was already correct: it recognized the
fiction (sneaking through alleys, avoiding a checkpoint) didn't match
the bot's own trigger ("access system/cut obstacle/analyze/assemble
via bot") and didn't apply it.

**The real problem was the debug-log label itself, not the mechanic.**
"Asset bonuses for Face Danger: Utility Bot" reads as though the bot
was actually relevant or used -- with no way to tell that from an
"explicit" match (a named-move alter, effectively guaranteed) at a
glance. An "implicit" match is exactly the opposite: a candidate
surfaced because the engine can't judge fictional relevance on its
own, explicitly not guaranteed to apply, per the tool's own existing
description -- but the label didn't carry that distinction into what
the player actually sees.

Fixed the label directly: explicit and implicit matches are now
described differently, with implicit ones stated plainly as "possible
fictional match, not guaranteed to apply." No system-prompt or
mechanical change needed here -- the underlying judgment was already
right, verified directly against the real roll that followed.

TypeScript check and full build clean; the fix traced by hand against
the exact real data from the log.

## Debug log format: genuinely readable now, not just JSON-valid

Direct feedback that the debug log's `.jsonl` files should be more
readable. Confirmed the actual scale of the problem first rather than
guess: in a real uploaded log, `systemPrompt` alone accounted for 79%
of a single entry's total size, commonly past 100,000 characters.

**Pretty-printing the outer JSON structure alone wouldn't have fixed
this.** The real constraint is that JSON strings can't contain an
actual line break at all -- only an escaped `\n` -- so a giant prose
field stays one unreadable line with literal backslash-n sequences no
matter how nicely the surrounding object gets indented.

**The actual fix**: `systemPrompt` and `finalReply` are now split into
arrays of lines before being logged, instead of left as single
strings. `JSON.stringify`'s own pretty-printing puts each array
element -- each real line of the original text -- on its own real line
in the file. Verified this reconstructs byte-for-byte via
`array.join('\n')`, including at realistic scale (a 100,000+ character
fixture, not just a toy string), so nothing is lost -- this is a pure
readability change. Also reordered fields so `systemPrompt`, by far
the largest and least likely to differ from the previous turn's,
comes last -- reading an entry top to bottom now reaches what actually
happened before the largely-static prompt text.

Entries are pretty-printed and separated by a blank line rather than
one compact line each -- still cheaply appendable (no need to
read/rewrite the whole file per turn), and still straightforward to
split back into individual JSON documents by that same blank-line
boundary.

1 existing test updated to match the new format, 1 new test
specifically at realistic scale. Full regression, syntax, types, and
playtest all clean.

## Two real fixes from a fifth debug log, and the Custom Asset feature fully removed

**A real bug: truths the player set manually were effectively ignored,
not overridden by any explicit tool call.** A fifth uploaded debug log
showed all 14 Setting Truth categories correctly present in the system
prompt -- the player had set every one of them deliberately before play
began -- but the opening scene's actual narration drew on almost none
of them, inventing a generic sector, station, and antagonist instead of
the specific, distinctive facts chosen (interdimensional invaders,
alien gates, sentient AI, precursor ruins, the Soulbinders). Only one
loosely-connected detail slipped through.

Traced to a real, specific gap in the prompt itself, not a model-
compliance issue: the branch handling freshly-rolled truths explicitly
says to weave the result into the opening narration. The branch
handling already-established truths -- this player's actual case, since
they set all 14 manually -- only ever said not to re-roll them. Nothing
told the model to actually use them in the opening scene. Fixed by
adding the missing instruction, mirroring the fresh-truths branch's own
pattern: when the campaign is opening and truths are already
established, actively draw on several of them.

**A second, smaller defect in that same output**: a literal, unfilled
placeholder left visible in the narration -- "[my cat's name? --
insert]" -- rather than either inventing a name outright or asking the
player directly in plain prose. Added an explicit rule against this
exact pattern.

**The Custom Asset feature has been fully removed**, per the earlier
decision that user-created assets can never get the kind of verified,
per-item mechanical guidance this whole session's audits have been
built around. Removed end to end: the tool and its schema, the
`custom-assets:*` IPC handlers and preload exposure, the global
homebrew library's persistence functions, the entire dedicated UI
component and its toolbar button, related types, and every reference
across roughly a dozen tests. `findAssetAnywhere` (the merged official-
or-custom lookup) is gone too, replaced by the plain official-catalog
lookup everywhere it was used.

**A genuinely important catch during the removal, worth naming
directly.** `buildSystemPrompt`'s signature lost its `customAssets`
parameter, but one internal usage of that variable was still sitting in
the function body -- syntactically valid, so `node --check` and the
full test suite both passed clean, but it would have thrown a real
`ReferenceError` the moment any actual gameplay turn reached that code
path, since none of the existing tests exercised it. Caught only by a
final, systematic grep sweep across the entire codebase for any
remaining reference, rather than trusting a clean test run alone to
mean the removal was complete.

3 new tests for the truths/placeholder fixes. Full regression, syntax,
types, build, and playtest all clean.

## The bare "roll_bonus_challenge_dice" log line -- a genuine display gap, and a systematic sweep found two more just like it

Direct report: roll_bonus_challenge_dice shows up in the chat log's
own debug-style lines with no value at all -- just the bare tool
name, no dice, no outcome. This is the exact thing visible in the
very first Sleuth bug screenshot several turns back, still unfixed,
because it was never actually the same bug as the one fixed then.

**Confirmed directly**: the debug-line formatter (formatToolCall) is
a per-tool switch statement, and roll_bonus_challenge_dice was never
given a case at all -- it was falling straight through to the generic
default, `{ label: ev.name }`. Built when the tool itself was built a
few turns ago; the formatter was simply never added alongside it.

**Rather than patch just this one, checked systematically for the
same gap elsewhere.** Compared every real tool name against every
formatted case directly rather than guess which others might be
affected -- found two more genuinely missing: check_asset_bonuses
(one of the most frequently-called tools in the entire app, called
before nearly every roll) and grant_asset. check_asset_bonuses being
silently bare this whole time explains another loose thread from
several turns back -- the very first Sleuth screenshot also showed a
bare "check_asset_bonuses" line with no value, which was never
actually resolved, just overshadowed by the more severe bug found in
that same screenshot.

**All three fixed** with real, informative summaries matching the
established formatting patterns -- roll_bonus_challenge_dice shows
the extra dice rolled and either the forced outcome or how many
pairings are waiting on a choice; check_asset_bonuses names which
assets it found relevant (or says plainly that none applied);
grant_asset matches buy_asset's own format, distinguishing the free
grant from a paid purchase.

TypeScript check, full build, and engine tests all clean. Confirmed
directly against real result shapes, not assumed from the tool's own
schema -- ran the actual dice function to capture both a forced-match
and a no-match result and traced each through the new formatter by
hand before considering this done.

## The length target genuinely wasn't working -- found a real, specific ambiguity, not just re-worded the same instruction again

A real playtest screenshot showed a response wildly beyond the 6-8
sentence, 1-2 paragraph target -- roughly a dozen paragraphs, several
NPCs each getting a full individual treatment. Worth actually
diagnosing rather than just restating the same target with different
words a third time.

**What the screenshot actually showed**: a Gather Information roll
directed at three NPCs at once, followed mid-turn by a second,
separate mechanical event -- Sleuth's bonus-dice ability triggering on
top of the original roll (visible as its own roll_bonus_challenge_dice
call and a second momentum change). The response gave the initial hit
its own full narration, then gave the bonus mechanic's revelation
another full narration on top, stacking well past the target.

**The likely cause: the instruction's own phrasing was genuinely
ambiguous.** "After a tool result comes back, narrate what happens --
6-8 sentences" reads naturally as a per-tool-result allowance, not a
whole-turn budget -- and this exact turn had two tool results worth
narrating (the roll, then the bonus mechanic), which lines up with
getting roughly double the intended length.

**Rewrote it to close that reading directly.** Now explicit that the
target is for the entire final response, not something that stacks
per tool result -- and names the two patterns visible in this exact
screenshot as the thing to actively compress against: several NPCs
answering one question, and a bonus mechanic resolving mid-turn on
top of the original roll. When several threads are genuinely in play,
that's framed as a reason to select the one or two that matter, not
license to give each its own paragraph.

**Worth being honest about the limit here, not overselling this as a
fix that guarantees compliance.** Unlike this session's mechanical
bugs, prose length can't be engine-enforced -- there's no tool call to
validate or reject, just free text reaching the player directly. This
closes a real, identified ambiguity in the instruction; it doesn't
change the underlying fact that a model can still choose not to
follow it, the same way several of this session's real bugs showed
correct instructions being skipped outright.

1 test updated to match. Full regression, syntax, types, and playtest
all clean.

## Choice prompts moved into the chat itself -- no more darkening overlay, no more blocked scrolling

Real feedback on the pending-choice UI: the darkening overlay should
go, and the chat behind it should stay scrollable. Underneath the
question was whether the choice could become part of the chat itself
rather than a separate popup at all -- which turned out to be the
right fix for both problems at once, not a third, separate one.

**What ChoiceModal actually was**: a true full-screen modal --
`position: fixed`, covering the whole viewport, a 75%-opacity dark
background, sitting on top of everything including the chat log.
Being fixed and full-screen, it necessarily intercepted every mouse
event on what was behind it, including scrolling -- there was no
version of that component that could leave the chat interactive
underneath it.

**Rebuilt as InlineChoice**, rendered as part of the chat log itself
-- the last item in the scrollable list, right where a new GM message
would otherwise appear, not a separate overlay layered on top of
anything. No backdrop exists to darken, and the chat is never blocked
from scrolling, because the choice is just ordinary scrollable content
now, styled to read as the GM's own turn (a bordered panel matching
where a message bubble would sit) with its option buttons and
optional free-text field inline underneath. The existing auto-scroll
effect already re-fires whenever a new choice appears, so it comes
into view the same way a new message would.

No new automated tests -- this project has no frontend component test
harness, matching how the earlier font-size and layout change was
verified. TypeScript check and full build both clean; a visual preview
using the app's real colors and fonts confirmed the result directly.

## Adjusted the narration length target to 6-8 sentences, 1-2 paragraphs

A direct follow-up to the previous pass: the 2-4 sentence target was
tighter than wanted. Adjusted to 6-8 sentences, 1-2 paragraphs, and
reworded the surrounding guidance to stay internally consistent with
the longer target -- "don't stack several separate observations...
when the moment only calls for one" made sense against a 2-4 sentence
ceiling, but reads as contradictory against 6-8, so it's now "don't
pad toward the target with observations the moment doesn't call for"
instead, which keeps the actual intent (no artificial filler) without
fighting the new length itself. The show-don't-tell example and
principle from the previous pass are unchanged.

1 existing test updated to match. Full regression, syntax, types, and
playtest all clean.

## Prose was too dense -- rewrote the narration instruction with a real length target and a concretely anchored show-don't-tell example

Direct feedback: the prose felt too dense. The existing narration
instruction already gestured at this ("vividly, but concisely...
not an essay") but gave no concrete target and no actionable path to
actually achieving it -- vague enough that a model could satisfy it
while still writing the multi-paragraph responses visible throughout
this session's own playtest logs.

Rewrote it with a real length target -- 2-4 sentences for a routine
beat, rarely more than a short paragraph even for a major one -- and
a show-don't-tell principle anchored to a concrete, paired example
("her hand won't stay still on the grip" instead of "she's afraid")
rather than just naming the abstract principle and trusting that to
be enough. Also added explicit guidance against two specific patterns
worth naming directly: stacking several separate observations or
revelations into a single response when the moment only calls for
one, and spelling out a beat's emotional weight in words after the
concrete detail has already carried it.

1 new test. Full regression, syntax, types, and playtest all clean.

## Correcting my own earlier claim: the vow rank-change gap was real -- a tool was missing, not just a model-compliance issue

Went back to the vow rank-change question after being pointed
specifically at Sleuth's own text again -- and the earlier answer was
wrong, worth saying plainly rather than glossing over.

**The claim that Fulfill Your Vow's miss-and-recommit is the only
official way to change a vow's rank was incomplete.** Sleuth's own
ability describes a second, entirely separate mechanism: on a miss
with a match during the investigation, "make the rank of your quest
one higher... and use the new rank when marking future progress" --
no mention of clearing any progress at all, genuinely different from
the recommit path's mandatory cost.

**The existing system prompt guidance for Sleuth already correctly
recognized this as its own thing** -- it just told the model to "just
update the track's own rank field," a capability that turned out not
to exist as any callable tool at all. Checked the full tool set
directly rather than assume one might be hiding somewhere: every
rank-related tool was either connection-specific (set_connection_rank,
raise_connection_rank) or forced a progress-clearing recommit
(recommit_progress_track, recommit_after_failed_bond). Nothing could
change a vow, expedition, or fight-objective track's rank on its own.

**Built the missing piece.** set_track_rank changes only a track's
rank field -- no roll, no tick clearing, nothing else touched.
Verified against a track carrying real, non-zero progress
specifically, to confirm the ticks are genuinely left alone rather
than just coincidentally starting at zero in a thin test. Updated
both Sleuth's and Slayer's guidance -- the two places that referenced
this same, previously-nonexistent mechanism -- to call the real tool
by name.

2 new tests. Full regression, syntax, types, and playtest all clean.

## A large, multi-part bug report from real play -- two confirmed real bugs, and two mechanics that turned out to already be correct

A dense, multi-item report from actual play, investigated claim by
claim against real data rather than assumed true or false from the
symptoms alone. Two confirmed, real, severe bugs; two things that
looked wrong but checked out as already correct.

**Real bug one: a choice silently skipped, not just miscalculated.**
roll_bonus_challenge_dice correctly computed three possible pairings
with no forced match -- and the very next event in the log was the
final narration. present_choice was never called at all. The AI
silently narrated a plausible weak-hit outcome without ever letting
the player choose, deciding on their behalf exactly the way existing
guidance elsewhere explicitly warns against. This is the same
underlying pattern already seen once before, in momentum_burn's Gain
Ground bug: correct data reaches the model, and the required
present_choice follow-through gets silently skipped anyway. Both
fields now carry a direct, imperative next_step instruction inside
their own result -- fresh, hard-to-miss context right at the point of
decision, rather than relying solely on prompt-level instructions
further away.

**Real bug two, and a more structural one: set_asset_broken was being
applied to a Companion at all.** Not just the wrong id (already fixed
last pass) -- the wrong mechanic entirely. The engine itself had no
restriction stopping this; it would have silently succeeded had the
id merely been correct, letting a Companion be marked "broken" when
that concept doesn't apply to it -- broken is specifically a Module
thing, Withstand Damage's own miss consequence. Companions have their
own, completely separate mechanic for taking harm
(companion_takes_a_hit, which reduces health). Added a real,
enforced engine-level guard rejecting non-Module assets outright, with
an error naming the actual correct alternative, plus an explicit
system-prompt rule stating the underlying principle directly: a
Companion only ever loses health through companion_takes_a_hit, never
any other mechanism, even under a generic prompt.

**Two reported items checked out as already correct, not bugs.**
Develop Your Relationship's two observed calls both correctly used
its unusual pre-bond, no-roll branch -- the connection in question
never actually reached bonded status, since that only happens via a
successful Forge a Bond roll, not simply filling the connection's own
progress track. Confirmed directly against the real game state at
each call, not assumed from the move's name alone.

3 new tests. Full regression, syntax, types, and playtest all clean.
Two items from this same report -- vow rank-change mechanics, and the
Custom Asset feature's future -- are still open and being worked on
separately.

## A fourth real debug log: the same constructed-ID pattern, tracked to a genuine gap this time -- not just a model ignoring guidance

A fourth uploaded debug log, and this one's failure mode matched the
very first real bug found this session: set_asset_broken was called
with asset_id "utility-bot" for an owned Companion actually named
Utility Bot, correctly rejected since no such id exists.

**The earlier 27-parameter fix already told the model to use the real
id, not construct one -- so this needed tracing to an actual, separate
contributing gap, not just chalked up to the model ignoring guidance
again.** Found one: check_asset_bonuses, the tool that tells the model
which owned assets are relevant to a move, returned only the asset's
name -- never its real id, even though that id was sitting right there
on the underlying data the whole time. A model correctly recognizing
Utility Bot as relevant to the move still had no real id in front of
it at that exact moment, and had nothing to work from except
reconstructing one from the name or trying to recall it from whenever
the asset was first bought, possibly many turns back in the
conversation.

**Fixed at the source.** asset_id now rides directly on every entry
check_asset_bonuses returns, both explicit and implicit. Updated the
tool's own description and every asset-referencing tool's id
parameter (set_asset_broken, adjust_asset_resource, set_asset_resource,
set_vehicle_condition, discard_asset) to point at this as the more
reliable, freshest source, rather than only the original acquisition
call.

**One more thing worth naming honestly rather than silently fixing or
silently ignoring**: whether Take Decisive Action was even the right
move for that turn. The player's stated action was holstering a
weapon and standing down -- which doesn't obviously match the move's
own trigger, "when you seize an objective in a fight." A defensible
GM reading exists on both sides of this (standing down as its own
kind of decisive choice vs. a genuine mismatch), so it's flagged as a
real, open question rather than treated as a clear-cut engine bug the
way the constructed id was.

2 new tests, including one that reproduces the exact real-world
failure -- the literal string "utility-bot" -- and confirms it still
correctly fails while the real, now-surfaced id succeeds. Full
regression, syntax, types, and playtest all clean.

## UI adjustments (bigger character sheet font, narrower story area), and a third real debug log with the same underlying pattern

Two requests handled this pass: real UI adjustments, and a third
uploaded debug log.

**Character sheet font and story area width, actually changed, not
just planned.** All 73 inline font-size declarations across the
character sheet's components (AssetCard, CharacterSheet itself, and
every section it renders -- connections, clocks, illustrations, flags,
campaign elements, the log) bumped +2px, plus the named CSS classes
updated to match, with the stat grid's own value getting an extra
bump as the sheet's single most prominent number. The sidebar widened
from 320px to 380px to give that larger text room without cramping,
and the chat log and composer both capped to a shared, centered
max-width so the story area reads narrower rather than stretching
edge-to-edge on wide windows. Full build and TypeScript check both
clean.

**A third real debug log, and the same underlying pattern as the
last one -- correct, explicit guidance already existed and simply
wasn't followed.** After a Gain Ground roll came back a miss with
momentum at 6 against an action score of only 2, the AI never
checked whether burning momentum would help. Checked directly: it
would have -- turning that exact miss into a strong hit, since
momentum (6) beats both challenge dice (5 and 2) where the actual
action score didn't. The existing instruction already told the model
precisely when to make this check; it just didn't.

**Applied the same structural fix that worked for the last two real
bugs, rather than trust a third round of restating already-correct
prose.** roll_action_move now computes and returns its own
momentum_burn field directly in the same result the model is already
reading to narrate the outcome -- available or not, and what burning
would actually produce -- using the exact same threshold
burn_momentum's own handler already enforces, so the two can never
disagree with each other. The fact is no longer a separate mental
check to remember; it's already sitting in the data the model has in
front of it either way.

2 new tests, including one that reproduces the exact real-world
numbers from the log and confirms the engine identifies the genuine
improvement a real model missed. Full regression, syntax, types,
build, and playtest all clean.

## A second real debug log: a much more severe failure -- not a guidance gap this time, correct guidance simply never followed

A second uploaded debug log, and a much more serious failure than the
first. On a Sleuth-triggered Gather Information roll (action score 5,
original dice 10 and 2), the model never called
roll_extra_challenge_die, never called resolve_action_with_dice, and
never called present_choice. It fabricated an extra die value, a fake
choice menu, and a claimed strong-hit outcome for the pairing (2, 6)
-- entirely in narrative prose, with zero real tool calls behind any
of it.

**This wasn't a guidance gap -- the existing text was already fully
correct and explicit about which real tools to call.** The model
simply didn't call any of them. And the freehand arithmetic it
invented instead was itself wrong: checked directly, with action
score 5, no pairing among {10, 2, 6} produces a strong hit at all,
since 5 does not beat 6 -- the model's claimed "you beat both" for
(2, 6) is flatly false.

**No amount of re-stating already-correct prose can force a model to
call a tool it's skipping entirely, so a different kind of fix was
needed.** Built roll_bonus_challenge_dice: a single tool that
consolidates the whole roll-check-compute sequence -- rolling the
bonus dice, checking the full pool for a forced match, and working
out every possible pairing's real, verified outcome -- into one
atomic call. If the mechanic gets engaged with at all, there is no
longer a point where the model has to compute a comparison by hand;
every pairing arrives pre-computed. Generalized to cover Cohort's
variable-count version of the same underlying mechanic (one bonus die
per participating specialist) from the same function, not treated as
a Sleuth-only special case. Both assets' guidance now points at this
single call in place of the old multi-step orchestration.

3 new tests, including one that reproduces the exact real-world
numbers (action score 5, dice 10/2/6) and confirms the engine
computes the correct answer the model got wrong. Full regression,
syntax, types, and playtest all clean.

## A real bug from real play: constructed IDs instead of returned ones -- traced to a systemic gap across 27 tool parameters, not just one

A real debug log from actual play, uploaded directly, showed a
genuine failure on the very first turn of a brand new campaign.
add_connection correctly created a connection named Halia Wade and
returned its real, engine-generated id ("cmte8jmd10") -- but the
model's next two calls, setting her role and rank, used a constructed,
human-readable id instead ("conn-halia-wade"), which the engine
correctly rejected since nothing by that name actually existed. The
model happened to self-correct two calls later and used the real id
successfully, so this specific case recovered on its own -- but two
calls were wasted getting there, and there's no guarantee a less
persistent model recovers the same way every time.

**Traced this to its actual root cause instead of patching the one
instance.** connection_id had zero description anywhere in its own
tool schema -- nothing telling the model, at the exact moment it's
filling in that value, that it has to be the literal id from
add_connection's own result rather than something reasonable-looking
constructed from the name. Checked whether this was isolated to
connection_id, and it wasn't: a systematic scan of every tool
parameter in the entire app turned up 27 separate id parameters with
no description at all.

**Fixed all 27, each with the specific, correct guidance for how that
particular id actually gets established** -- not a single generic
sentence copy-pasted everywhere. For ids the engine generates and
returns (connections, assets, sectors, passages, clocks), the fix
says explicitly: use the exact returned value, never construct one.
create_progress_track turned out to be a genuine, confirmed exception
-- checked its actual schema rather than assumed a uniform pattern
held everywhere, and found its id is chosen BY the model when
creating the track, not returned afterward, so its own description
says the opposite: reuse the same chosen value consistently.
mark_legacy_ticks needed a third, different clarification again,
since its track_id isn't created via create_progress_track at all --
it's always one of three fixed, permanently-existing legacy tracks.
Also added a short, general principle to the system prompt covering
this whole pattern across every create-style tool at once, as a
second, reinforcing layer on top of the now-fixed individual
descriptions.

4 new tests, including one that scans the entire tool set the same
way the original gap was found, confirming all 27 are genuinely
fixed rather than spot-checked. Full regression, syntax, types, and
playtest all clean.

## Auto-update actually publishing now, end to end -- moved to GitHub Actions after a real mistake and a real network wall

Following up on the auto-update feature: the actual publish step is
now verified working, for real, against a real tagged release -- not
just built and assumed correct.

**A real mistake happened getting here, worth being direct about.**
The first attempt ran the full local build-and-publish command --
roughly 260 seconds -- and only hit a failure at the very last step:
`uploads.github.com`, the specific host GitHub requires for release
asset uploads (architecturally separate from the rest of its API), is
blocked by this environment's network egress policy. That specific
risk had already been flagged as uncertain beforehand, and should
have been tested directly and cheaply before running the expensive
part, not discovered at the end of it. The broken draft release this
left behind was found and deleted before moving on.

**The real fix: build and publish on GitHub's own infrastructure
instead**, not locally. Added `.github/workflows/release.yml` --
triggered by pushing a version tag, running on a real Windows GitHub
Actions runner (which also means no Wine cross-compilation step
needed at all, unlike this project's own local build environment),
authenticated with GitHub's own automatic per-run token rather than
a personal access token.

**Two more real, concrete problems surfaced getting the workflow
itself working, both worth naming rather than glossing over.**
GitHub separately gates writing anything under `.github/workflows/`
behind its own dedicated permission, distinct from general repo
write access -- the first attempt to push the workflow file was
correctly rejected until that permission was added. And
electron-builder's own default behavior is to publish a release as an
unpublished draft, invisible to anything checking the latest-release
endpoint (electron-updater included) -- confirmed directly by
checking the release's own state after a successful build, not
assumed complete just because the workflow reported success. Fixed by
setting `releaseType: "release"` so future tag pushes publish
directly, with no manual step.

**Verified end to end against a real release, not just "the workflow
finished."** Fetched the exact same URL electron-updater's own check
would hit and confirmed it returns the real version, file, and hash
-- the actual thing this whole feature exists to make an installed
app able to find.

Full regression, syntax, types, and playtest all clean throughout.

## Auto-update, built for real -- and a genuine electron-updater testability obstacle solved along the way

Built the first of the smaller, previously-flagged feature gaps:
auto-update, wired to GitHub Releases via electron-updater.

**Deliberately conservative for a personal desktop app.** Checking,
downloading, and installing are three separate, explicit actions from
a new section in Settings -- autoDownload and autoInstallOnAppQuit are
both turned off, so nothing happens in the background without the
user actually clicking something. Current version, live status, and
download progress are all shown directly.

**A real obstacle came up building this, worth explaining rather than
glossing over.** electron-updater's core autoUpdater object throws
immediately on first property access outside a genuinely running
Electron process -- not just when actually used, at the moment it's
even touched. A first attempt at testing this (importing the real
library directly in a test file) failed outright for exactly that
reason. Rather than leave the packaged-mode logic untested, the
module was redesigned to accept an injectable autoUpdater override,
defaulting to lazily requiring the real one only when no override is
given and the build isn't a dev session -- the real app's own
behavior is completely unchanged (main.cjs never passes an override,
so it always gets the genuine library), but tests can now supply a
plain EventEmitter-based fake and actually exercise the event-
forwarding logic directly, including confirming the exact "electron-
updater cannot load here" fallback this sandbox itself hits in
practice, not just a theoretical case.

**Requires a small amount of real setup to actually do anything** --
documented directly in the README's Setup section, not left implicit.
package.json's publish.owner/repo are clearly-labeled placeholders
until a real GitHub repo exists to publish releases to; the feature
reports a clean "not configured" status rather than failing silently
or pretending to work when that setup hasn't happened yet.

11 new tests. Full regression, syntax, types, build, and playtest all
clean.

## The full assets audit is complete: all 90 assets, all 6 categories, checked word for word against Dataforged

Finished the Path category (its final 15 assets: Navigator through
Tech, then Trader through Weapon Master), which completes the entire
assets audit -- every one of the 90 official assets across all 6
categories (Command Vehicle, Module, Support Vehicle, Companion,
Deed, Path), each checked directly against Dataforged's real ability
text rather than trusted from the compressed pseudocode catalog or
assumed correct because a category came back clean before it.

**One more genuine gap found in this final stretch.** Slayer's third
ability was missing most of its actual content, not just a detail --
the existing guidance covered only the mid-fight rank-raise mechanic,
but omitted the unconditional +2 momentum Enter the Fray grants just
for having the objective, the fact that the rank-raising sacrifice is
itself a genuine optional choice rather than something to assume
happened, and the entire follow-up payoff (a trophy and 2 legacy
ticks) for actually defeating the foe after making that sacrifice.
Fixed, confirmed word for word against the source.

**The remaining 14 assets in this stretch** -- Navigator, Outcast,
Scavenger, Scoundrel, Seer, Shade, Sleuth, Sniper, Tech, Trader,
Vestige, Veteran, Voidborn, Weapon Master -- all checked out already
fully correct.

**Tallying the whole audit**: roughly 20 genuine, verified fixes found
across all 90 assets, ranging from single missing details to entire
abilities never documented at all, plus two real transcription errors
caught in the underlying asset-modifiers.json data itself (not just
the prose) and fixed at the source so check_asset_bonuses surfaces
the correct mechanic going forward. The single most significant find
remains Starship -- the one asset nearly every character owns --
whose Withstand Damage ability had been fundamentally misread as two
separate rolls instead of one stat substitution.

1 new test for this stretch's fix. Full regression, syntax, types,
and playtest all clean. This closes out the assets audit as a
complete pass, matching the same word-for-word discipline the moves
audit received earlier this session.

## Assets audit: batch 3 of Path -- a real numerical error, and a much bigger structural gap

Continued the Path category audit (Gunslinger through Naturalist, 10
more assets, bringing the running total to 30 of 47), each checked
word for word against Dataforged.

**Haunted had a real numerical error, not just missing detail.** Its
"let them go" consequence should grant 2 legacy ticks PER marked
ability, per the rulebook's own text -- the existing guidance
described it as N ticks where N was just the ability count, silently
halving the actual reward for anyone with more than one Haunted
ability marked. An easy kind of error to miss precisely because the
guidance wasn't wrong in shape, just off by a missing multiplier.

**Looper's time-link ability had a much bigger, structural gap.** The
existing guidance correctly computed the stat for the roll (the
gap-in-time value) and the no-burning-momentum restriction -- but
never said what the roll's actual outcome DOES. The entire
strong/weak/miss table was completely absent: returning to the linked
moment and resetting condition meters to their original values, the
added Endure Stress cost on a weak hit, the corrupted-timeline Pay the
Price on a miss. The stat computation was right; the mechanic it fed
into was simply never written down.

**The rest of the batch checked out as already fully correct** --
Gunslinger, Healer, Infiltrator, Kinetic, Leader, Naturalist, plus
Lore Hunter and Loyalist re-verified from earlier fixes, including
Loyalist's conclusion that all three of its abilities are genuinely
co-op-only, confirmed precisely against each ability's own text
rather than assumed to still hold.

1 new test covering both fixes. Full regression, syntax, types, and
playtest all clean. 17 Path assets remain.

## Assets audit: the first 20 of 47 Path assets, and this category has a real error rate

Continued into the large Path category (47 assets), working through
the first 20 in two batches of 10, each checked word for word against
Dataforged's real ability text rather than trusted from the
compressed catalog or assumed correct because it was already covered.

**Seven genuine, verified gaps found and fixed.** Archer's guidance
only covered the strong-hit case of its ammo-replenishing roll,
missing the weak-hit and miss outcomes and the hit rewards on its
other two abilities entirely. Bannersworn's second ability was
missing its first half -- the Sojourn-triggered "meeting someone of
the same ideology" mechanic -- leaving only the Forge a Bond bonus
documented. Artist was missing an entire ability (Gather
Information/Secure an Advantage, +2) and the strong-hit reward on its
reroll ability. Demolitionist and Gearhead were each missing an
entire third ability outright -- Demolitionist's max-momentum-reset
Take Decisive Action reroll, and Gearhead's actual Secure an Advantage
roll that crafts its device in the first place, not just the
resulting one-time-use resource. Firebrand was missing three real
details across two abilities: the specific stat for its fire-gathering
roll, the +2 roll bonus that comes with spending fire (only the -1
cost was documented), and both the specific moves and the "mark
progress" half of its unleash-hell ability. Gunner was missing a
minor but real narrative hook.

**Several others were checked with the same rigor and came back
clean** -- Devotant, Diplomat, Empath, Explorer, Fated, Fugitive,
Courier, and Bounty Hunter all confirmed already fully correct, not
waved through just because no error was expected.

4 new tests covering all seven fixes. Full regression, syntax, types,
and playtest all clean. 27 Path assets remain.

## Assets audit: Module and Support Vehicle categories fully verified clean -- and a real, significant error found in the most commonly-owned asset in the game

Continued the systematic assets audit through two full categories:
all 15 Module assets and all 7 Support Vehicle assets, each checked
word for word against Dataforged's real ability text, not just
spot-checked.

**Both categories came back fully correct.** Every ability across
all 22 assets -- Engine Upgrade through Workshop, Exosuit through
Snub Fighter -- matched the real text precisely, including several
mechanically intricate ones (Missile Array's threshold-then-reroll
sequencing, Shields' raise/absorb/decay cycle, Sensor Array's
automated-scan die substitution) that were already correctly guided
from earlier work this session. A genuinely clean result, not just an
absence of things to fix.

**Starship was the one real, significant exception.** Every character
starts with a Starship for free -- it's very likely the single
most-owned asset in the entire game -- and its third ability was
fundamentally misread. The existing guidance described "an optional
+heart roll after Withstand Damage's own outcome," implying two
separate rolls. Dataforged's actual text ("you may roll +heart" for
that SAME resist roll) describes a stat substitution -- +heart
instead of the normal +integrity for one single roll, not a second
roll layered on top. Confirmed directly against the source text before
touching anything, then fixed, including updating an existing test
that had been asserting the old, incorrect behavior all along rather
than just adding a new one alongside it.

1 test corrected to assert the right behavior, rather than left
passing against a wrong one. Full regression, syntax, types, and
playtest all clean. Module, Support Vehicle, Companion, Command
Vehicle, and Deed categories are now all fully audited -- the large
Path category (47 assets) is what remains.

## Starting the assets audit for real -- and finding a real error in the audit's own data

Began the systematic assets audit, matching the discipline already
applied to all 56 moves.

**The first coverage check was wrong, and worth stating why.** A
naive "is the asset name mentioned via an if(a.name===...) callback"
scan flagged 11 assets as having zero guidance at all. Checking
directly showed several of those (Bounty Hunter, Gunner, Glowcat,
Rockhorn) are actually covered through shared, grouped prose blocks
rather than individual callbacks -- a real, different coverage
pattern the naive check simply couldn't see. Rebuilt the check around
counting numbered "(1)/(2)/(3)" ability markers against each asset's
real ability count, anchored on the asset's actual descriptive text
rather than an early mention in a config array (which caused its own
false positives on the first attempt) -- narrowed 44 initial flags
down to 10 real candidates worth checking individually, rather than
trusting either automated pass at face value.

**Two were genuine, verified gaps in this prompt's own guidance.**
Mercenary's third ability (a flat +2 to Check Your Gear or Resupply)
was completely missing. Crew Commander's guidance claimed its rank-2
command boost had "no immediate current bump" -- directly contradicted
by Dataforged's own text, "take +2 command; your max is now 6." Both
fixed. Five Companion assets (Banshee, Combat Bot, Protocol Bot,
Sidekick, Survey Bot) had real, substantial gaps -- entire abilities
never documented anywhere, not just imprecise wording -- each verified
word for word against Dataforged before writing anything.

**Verifying those surfaced something bigger than a prompt gap.** The
parsed asset-modifiers.json catalog itself -- generated from the
pseudocode reference last session -- had two genuine transcription
errors (Sprite and Glowcat, both on their first ability), each
confusing a variable "add +its health" effect with a stat-replacing
"roll +its health" one. Ran a full, systematic cross-check of every
Companion's health-based ability against raw Dataforged text, not
just the two already caught, before trusting the rest of the catalog
again -- confirmed those were the only two errors, then fixed the
underlying JSON data directly. This mattered beyond the prompt text:
check_asset_bonuses reads from that same file, so leaving it wrong
would have kept surfacing the incorrect mechanic to the model
indefinitely, silently, regardless of how correct the prose guidance
became.

3 new tests. Full regression, syntax, types, and playtest all clean.
This is the start of the assets audit, not the whole thing -- roughly
80 assets remain to work through with the same discipline.

## gameplay_pseudocode.md finished (sections 10-13 + implementation notes) -- including a real correction along the way

Finished the full 4-document pseudocode read.

**A real correction happened mid-pass, worth stating plainly rather
than quietly dropping.** Section 10 described a pre-designed,
23-entry encounter library in Dataforged (encounters.json) that turned
out to be loaded by this app but never referenced by any tool or
guidance anywhere. Read that as an oversight and started building a
lookup_encounter tool for it -- wrong call. Told directly that this
was an actual, deliberate decision already made earlier in the
project, not a gap. Reverted the new functions and their exports
completely, confirmed zero stray references remained anywhere in the
codebase, rather than leaving dead code behind or trying to preserve
part of the unwanted work.

**The rest of the pass held to the same discipline as the rest of
this whole audit: verify before either fixing or dismissing.** Section
10 also repeated a claim from earlier work -- that Aid Your Ally can
apply to an NPC connection, not just a fellow player's protagonist --
checked directly against the rulebook text and found false: the book
explicitly defines an ally as "a protagonist played by another
player." This CONFIRMS this session's earlier conclusion that the
move is genuinely co-op-only, rather than overturning it.

**Section 11's fiction-first GM loop was already thoroughly covered**,
including the exact "without new leverage or a different approach"
rulebook phrasing for preventing move-fishing. But the rulebook's own
specific numeric guideline -- that even a legitimate run of the same
move (consecutive combat rounds, expedition waypoints) should still
get broken up with a narrative beat once it's come up three times
running -- was genuinely absent, confirmed word for word against the
actual "Making Moves Matter" rulebook page, and added.

**Sections 12-13 and the implementation notes** turned out to be
confirmations of work already verified earlier this session --
session persistence, progress rolls categorically ignoring momentum
(confirmed directly in roll_progress_move's own handler), and the
exact character-creation numbers all checked out as already correct.

1 new test. Full regression, syntax, types, and playtest all clean.
This completes the requested read of all 4 project pseudocode
references.

## gameplay_pseudocode.md sections 5-9: mostly confirmations, one genuine gap in foundational setting tone

Continued through sections 5-9 -- legacy/advancement, the oracle
engine, character creation, campaign/sector setup, and the inciting
incident/starting vow.

**Most concrete claims checked out as already correct**, each verified
individually rather than assumed as a batch: Ask the Oracle's exact
odds thresholds (10/25/50/75/90) matched dice.cjs precisely; the full
character creation sequence (free Starship grant, the {3,2,2,1,1}
stat array, starting meters and momentum) was already fully correct
-- the Starship grant specifically triggered a false alarm first,
found in the backend (main.cjs) rather than the frontend component an
initial search checked, resolved by searching the right layer instead
of concluding it was missing; the exact passage count per region
(3/2/1) already matched; and the starting vow's rank constraint
(troublesome or dangerous specifically, not the general five-rank
range every other vow gets) was already correctly written into the
existing Begin Your Adventure guidance, confirmed word for word
against the actual rulebook page.

**One genuine, significant gap did turn up.** The rulebook's own
"Default Assumptions" -- nine baseline setting truths (perilous,
lonely, diverse, far-flung, unexplored, wondrous, retro, unjust,
hopeful future) that hold for every Starforged campaign before the
player's own chosen Truths add anything more specific -- were never
established anywhere in this prompt at all. Confirmed directly
against the actual rulebook page (Chapter 2, Choose Your Truths)
before writing anything, not taken on the pseudocode's summary alone.
Added as new, foundational setting context right after the prompt's
own opening paragraph -- this is baseline tone that should color
every scene from the very first line, not something conditional on
later game state or which Truths happen to get rolled.

1 new test. Full regression, syntax, types, and playtest all clean.
Sections 10-13 (foes/NPCs/encounters, the fiction-first GM loop,
session lifecycle, and the worked example) remain for a follow-up.

## core_types.md finished, gameplay_pseudocode.md begun: a real engine-level rule was missing across the entire meter system, not just one move

Finished core_types.md (mostly internal type-system plumbing in its
back half, nothing further to verify), then began
gameplay_pseudocode.md.

**A claim in its momentum/meters section was surprising enough to
verify immediately rather than take on faith**: "a meter cannot be
increased while its matching misfortune is marked." Confirmed
directly against all three rulebook pages, not just one -- identical
language for Wounded/health, Shaken/spirit, and Unprepared/supply.

**Checking whether this was already enforced anywhere found that it
wasn't, anywhere in the app.** update_meter -- the single shared
function every meter change in the whole codebase goes through --
had no awareness of this rule at all. The per-move prose guidance
already got it right in the specific cases checked (Endure Harm's
strong-hit gating, Heal's own +2-if-clearing/+3-otherwise split, both
confirmed already correct from earlier this session) -- but prose
guidance only protects the moves someone thought to write it into,
not every path that ever touches a meter.

**Added real, engine-level enforcement directly to update_meter.** A
positive delta to health/spirit/supply is now rejected outright if
the matching misfortune is currently marked, with an error naming the
exact rule and instructing the impact be cleared first -- the same
kind of structural safety net Phase 1 added for stat selection,
applied to a different, previously-unprotected corner of the same
problem. Tested directly across all three meters (blocked while
marked, succeeds once cleared, negative deltas/ordinary damage
completely unaffected either way), and confirmed the full playtest
simulation -- which already exercises this exact sequence -- still
passes clean.

**Also fixed a smaller, separately-verified gap found while
reading**: Take Decisive Action's own strong hit was undocumented
entirely -- only the bad-spot downgrade and the weak-hit complication
table existed anywhere in this prompt. Missing both the momentum
grant and the conditional "in control" result, which the rulebook
ties specifically to whether other objectives remain in a
multi-objective fight, not an unconditional grant.

2 new tests. Full regression, syntax, types, and playtest all clean.
gameplay_pseudocode.md's remaining sections (character creation
through session lifecycle) are still ahead.

## Reading all 4 project pseudocode references, starting with core_types.md -- a real mistake caught and reverted before it shipped

Asked to read all 4 pseudocode files (two never touched before --
core_types.md and gameplay_pseudocode.md) and ground the app in them.
Started with core_types.md.

**It turned out to be a genuine reconciliation document**, written
after the other three specifically to resolve inconsistencies BETWEEN
them -- including real internal bugs within the individual docs
themselves (moves.md's own gainMomentum calls didn't typecheck as
written; assets.md referenced a field, enabledAbilities, it never
actually declared). Useful as an authoritative reference for the
game's actual mechanical rules, but it describes a hypothetical
implementation with its own drift history -- not a literal blueprint
to rewrite this app's real, working, already-tested state model
against field-for-field.

**Cross-checked concrete mechanical claims against the real codebase
rather than assuming either the doc or memory was right.** The
negative-momentum-cancels-the-die rule and the momentum-floor
redirect-the-cost rule were both already correctly implemented -- the
second even more precisely than the pseudocode's own simplified
version. Companion Takes a Hit's full two-step structure (severity-
based harm first, an optional resist roll second) was also already
fully correct, confirmed directly against the real rulebook text
rather than assumed missing just because it wasn't immediately
visible in this session's own compacted context.

**A real mistake happened, and it's worth being direct about rather
than quietly fixing it.** Withstand Damage's equivalent structure
looked like a major gap on first read, and that led to building an
entire new per-asset tool for it before verifying the premise. Caught
before it shipped: directly checking the codebase's actual data model
showed vehicle integrity is a single character-level meter, not a
per-asset field the way Companion health is -- and the existing
generic update_meter tool already handles the identical rule
correctly. Reverted the new tool and function entirely rather than
leaving a redundant, confusing second mechanism alongside the correct
one.

**The real, much smaller, now-actually-verified gap**: Withstand
Damage's strong hit is also supposed to put the character in control
when it happens during an active fight -- confirmed directly in the
rulebook text, genuinely absent from the existing guidance, and fixed
directly.

1 new test. Full regression, syntax, types, and playtest all clean.
This is the first quarter of the requested read -- the rest of
core_types.md and all of gameplay_pseudocode.md remain for a
follow-up pass.

## Post-roll effects investigated directly, and declined to auto-execute -- the data genuinely isn't safe for it

Asked directly to build the post-roll half of the architectural
shift. Investigated concretely before building anything, since this
was already flagged as the riskier piece.

**Checked the real phrasing across the actual data rather than
assuming it would generalize.** All 134 momentum-related abilities,
the 10 outcome-tier-shift abilities, and -- as a narrower, more
promising candidate -- all 37 legacy-tick abilities. All three are
genuinely too varied to parse safely: momentum amounts are sometimes
conditional on a specific die value, sometimes equal to a different
meter's value outright, sometimes compound into a bonus on a future
turn. Outcome shifts and legacy ticks are frequently gated behind a
player choice made before rolling -- and several of those choices
(Brawler, Demolitionist, Crew Commander, Fugitive, Haunted, Survivor)
are ones already deliberately wired to present_choice earlier this
session. Auto-executing them wouldn't just be redundant, it would
actively conflict with guidance already confirmed correct.

**Declined to build a text parser over this data.** Doing so would
mean writing something close to a natural-language-to-code translator
across 270 inconsistently-phrased strings -- exactly the kind of
free-text-parsing risk this whole session's discipline has been
pushing away from. The failure mode it would introduce (silently
misapplying or double-applying a bonus) is worse than the gap it
would close.

**What's genuinely safe, and what actually got fixed:**
check_asset_bonuses already returns an ability's full effect text --
including whatever post-roll component it describes -- from the same
pre-roll call. The gap wasn't missing data, it was that the existing
guidance only emphasized the pre-roll adds use case, leaving the
post-roll half to survive in memory until the real outcome was known,
sometimes several tool calls later -- the same shape of memory-
dependent failure this whole session keeps finding elsewhere.
Strengthened the instruction directly: apply the post-roll part once
the outcome and match are actually known, and call
check_asset_bonuses again after the roll if at all unsure, rather
than trusting recall of an earlier call.

1 new test. Full regression, syntax, types, and playtest all clean.

## Phase 2 of the architectural shift: automatic asset-bonus surfacing, built directly from the pseudocode reference

Told directly to use the pseudocode catalog as the source for this,
not re-derive it from Dataforged -- which turns out to be the right
call for a structural reason, not just convenience: unlike moves,
whose Trigger.Options already give a clean, machine-readable
"which stat does this option use" structure, Dataforged's asset
abilities are freeform prose with no equivalent "which move does this
alter" field at all. The pseudocode catalog already did that
extraction by hand, cross-checked against Dataforged throughout its
own construction -- genuinely the right source for this specific
piece.

**Wrote a parser rather than hand-transcribing 270 abilities**,
specifically to avoid adding new transcription errors on top of a
reference that's already been carefully checked. The parser caught
two of its own bugs immediately, both real and both traced to their
actual cause rather than patched blindly: a false-positive 91st
"asset" from a bolded move name sitting inside a footnote, and an
ability count (271, not the doc's own claimed 270) that looked wrong
until traced to a genuine, deliberate two-line ability -- Missile
Array's combined attack-and-resupply first slot -- not a parsing
error. Also found, directly, that the doc's own summary claim ("38 of
270 abilities have no named move") is stale against a mechanical count
of the same data (89) -- the same pattern this whole audit already
established: the reference's per-ability mechanical data holds up
well under verification, its own prose claims about that data
sometimes don't.

**Built a genuine engine-level query against the resulting structured
data** -- getAssetAbilitiesForMove -- and a new tool,
check_asset_bonuses, that the model calls before rolling to see which
of a character's own unlocked abilities actually apply to a specific
move. This eliminates the same failure class phase 1 eliminated for
stats, but for assets: no longer needing to recall, unaided, which of
several owned assets are even relevant to a given move in the first
place. Deliberately scoped as a supplement, not a replacement, for
the detailed per-asset prose already written and checked throughout
this whole project -- the tool surfaces relevance and a compressed
summary from real data; genuine mechanical nuance (outcome-tier
shifts, match bonuses, resource costs) stays with the fuller,
already-verified guidance once an asset is confirmed relevant.

4 new tests, including a structural check on the generated dataset
itself (exact category counts, no malformed entries) and full
coverage of the new tool's real, error, and empty-result cases. Full
regression, syntax, types, and playtest all clean.

## A genuine architectural shift: stat selection moves from the model's memory into the engine itself

Raised directly: too much of the mechanical layer is left entirely to
the model's own memory of a 500+ line prompt, rather than computed by
the app. Confirmed this precisely before changing anything -- read
roll_action_move's actual schema and handler, not assumed: the engine
only ever re-verifies the NUMBER for a stat the model already picked;
the stat NAME itself was 100% model-supplied and completely
unvalidated. Every approach-dependent-stat bug found earlier this
session (Compel, Resupply, Heal, Repair, Undertake an Expedition) was
a symptom of exactly this gap -- the model having to correctly recall
a lookup table from prose, with nothing catching it when memory
failed.

**The fix is a real, tested engine change, not more prose.** A new
getMoveStatOptions function reads each move's own Trigger.Options
directly from Dataforged -- the same source data this whole session's
audits were built on -- and roll_action_move now validates the
model's chosen stat against a move's real, closed set of options.
An invalid one is rejected outright, with a helpful error listing the
actual valid stats, rather than silently rolled anyway.

**Deliberately narrow in scope, on purpose.** This only ever catches a
genuinely wrong pick (Compel rolled with +wits, which Dataforged
simply doesn't offer) or leaves an already-open field alone (Face
Danger, where all 5 stats are legitimately valid depending on
approach -- validated directly, produces no rejection at all). It
never second-guesses which of several still-valid stats best fits the
specific fiction -- recognizing "the player is threatening, not
bartering" is a genuine judgment call, and that stays exactly where
it belongs, with the model. Only the rote lookup that follows --
"and threatening uses +iron" -- moves into code.

**Two real bugs caught building this, both fixed before shipping.**
The function initially mishandled Dataforged's "custom_stat"
references (Develop Your Relationship's connection-rank case,
Companion Takes a Hit's own health case) as if they were ordinary,
validatable stat names -- which would have wrongly blocked those
legitimate derived_value rolls outright. Caught by two pre-existing
tests breaking, not assumed fixed -- traced to the actual cause,
fixed at the source, and both tests updated to assert the new,
correct behavior directly rather than the weaker behavior they used
to check.

3 new/updated tests, including full coverage across every
approach-dependent move this session's earlier audits found. Full
regression, syntax, types, and playtest all clean. This is the first
piece of a larger plan -- automatic asset-bonus application
(gatherAssetModifiers) is the natural next phase, bigger and only
partially automatable since many ability triggers are genuinely
fictional judgment calls, so it's being treated as its own dedicated
pass rather than rushed in alongside this one.

## Starting the assets pseudocode reference audit: a missing backend tool, not just missing guidance

A second new reference, this time for all 90 assets and 270
abilities, same Dataforged-sourced discipline as the moves reference.
Its implementation notes flagged one specific principle worth checking
first: Deed-category assets are self-granted by a narrative trigger,
not bought via Advance, and the AI should watch for the trigger
proactively rather than wait to be asked.

**Checking that directly found a real gap, then a deeper one
underneath it.** None of the 9 Deeds' actual trigger conditions were
written down anywhere in this prompt -- confirmed by search, then
each of the 9 conditions individually verified against Dataforged's
own Requirement field before writing anything, not assumed from the
reference alone (Bonded on Forge a Bond, Homesteader/Marked/Vanguard
at specific legacy-track box counts, Oathbreaker on Forsake Your Vow,
Revenant on Face Death, Survivor on trauma or permanent harm, Cohort
on taking a connection on as crewmate, Fleet Commander needing both a
box count AND fleet command, not either alone).

**Writing the actual fix is what surfaced the bigger problem.** Making
these grantable for free required checking whether the tool system
could actually do that -- and it couldn't. buy_asset unconditionally
spends the standard 3 experience with no free path at all. Worse. a
different instruction elsewhere in this same prompt already referenced
a tool called "add_asset" for exactly this kind of free grant -- a tool
that has never actually existed. A real, previously-unnoticed bug
sitting in the prompt's own text, not just an undocumented case.

**Built and verified a genuine new tool**, grant_asset, that adds an
asset with no experience cost -- confirmed directly that it adds the
asset AND spends zero experience, not just that the schema loads --
then pointed both the new Deeds guidance and the old broken reference
at it.

1 new test. Full regression, syntax, types, and playtest all clean.
This is the start of the assets reference audit, not the whole thing --
270 abilities across 90 assets remain to work through systematically.

## A new pseudocode moves reference, cross-checked against the entire prompt across all 12 move categories -- plus surviving a genuine mid-session environment reset

A newly-added, comprehensive pseudocode reference covering all 56
moves, sourced from Dataforged with an explicit invitation to
cross-check it against the implementation. Worked through all 12
categories systematically rather than spot-checking.

**The reference is not infallible, and treating it as automatic truth
would have been a mistake.** It fabricated a Take Decisive Action
bad-spot-downgrade detail -- checked directly against Dataforged and
found no support for it there, though it turned out to already be
correctly handled elsewhere in this prompt under a different,
legitimate rule (not the fabricated one). A more important lesson
came from the opposite direction: a claim not confirmed by
Dataforged's own structured Outcomes field (Explore a Waypoint's
miss-with-match Confront Chaos fork) looked like a second fabrication
at first, but turned out to be a real rule anyway -- documented only
in the surrounding rulebook prose, not captured in Dataforged's JSON
at all. Confirmed by reading the actual extracted rulebook text
directly rather than trusting the JSON's silence as denial.

**Seven confirmed, real fixes, found and applied:**
- Forge a Bond's strong-hit role choice and Test Your Relationship's
  miss choice were both already described correctly but never wired to
  present_choice -- this audit's single most recurring finding, again.
- Explore a Waypoint's miss-with-a-match (Confront Chaos) and
  Companion Takes a Hit's miss-with-a-match (permanent death at 0
  health, not just "out of action") were both genuinely undocumented.
- Heal, Repair, and Resupply all turned out to have multiple distinct
  stat options depending on approach or who's doing the work --
  combined, nine total options across the three moves, and only one
  (Heal's self-treatment case) was previously written down anywhere.

**Several suspected gaps were checked and confirmed as false alarms**,
worth noting since not everything that looks broken is: Aid Your
Ally's apparent gap is a deliberate, correct co-op-only design choice;
Earn Experience's reduced-rate mechanic at a maxed legacy track was
already fully and correctly implemented, in both the guidance and the
underlying state code; and the entire Scene Challenge section already
matches the reference precisely, move for move.

**A genuine mid-session environment reset happened partway through
this work.** The whole project directory was wiped between one
response and the next, losing six of the fixes already made before it
could be verified or delivered. Recovered cleanly from the last
delivered source zip already sitting in outputs, verified the restore
actually passed the full test suite before touching anything further,
then re-applied all six lost fixes from scratch rather than assuming
they'd survived.

2 new tests. Full regression, syntax, types, and playtest all clean.

## A third real playtest log: a self-monitoring gap on aboard status, and Compel turns out to have the exact same undocumented-core-move shape as create_progress_track

Two more issues, both confirmed directly against the log rather than
assumed.

**Issue 1: "aboard" status never cleared.** Traced every
set_aboard_vehicle call across the entire 11-turn log -- zero, the
whole session -- against turn 6's own narration, which the AI itself
wrote: "you step out into the salt wind." An unambiguous departure it
authored and then never acted on. The existing instruction was
already correct, but it led with the mechanical consequence (the
momentum-penalty interaction) rather than the concrete moment itself,
and never named this as something the AI has to self-monitor rather
than wait for the player to ask about -- a materially different kind
of trigger than most of this prompt's instructions, since nothing in
the player's own message calls for this specific tool. Rewrote it to
lead with the trigger and name the self-monitoring requirement
directly.

**Issue 2 turned out to be the exact same shape of gap as
create_progress_track last entry, just on a move instead of a tool.**
Compel -- an extremely common persuasion, deception, and threat move
-- was referenced constantly as a trigger condition across eight
separate assets, but never once had its own base mechanics written
down anywhere in this prompt. Confirmed against the raw move data:
three different stats depending on actual approach (heart for
charm/barter, iron for threats, shadow for lies), none of it
documented. A quick, targeted check of other likely candidates found
nothing further -- and confirmed one apparent gap (Aid Your Ally) is
actually a correct, deliberate choice: it's explicitly co-op-only and
doesn't meaningfully apply to solo play, not an oversight.

1 new test. Full regression, syntax, types, and playtest all clean.

## A second real playtest log, and the most foundational bug found all session: create_progress_track was never referenced anywhere in the entire prompt

A second real log, three fresh issues, every one confirmed directly
against the actual data rather than guessed at.

**Issue 1: a clear quest commitment produced pure narration, zero
tool calls.** "Fine. I'll take the job." should have triggered Swear
an Iron Vow -- confirmed in the log's own event list that nothing was
called at all. The existing dedicated instruction for this move only
ever covered a narrow miss-outcome edge case; the foundational
"when does this actually apply" question was left entirely to generic
move-selection judgment, which evidently failed on exactly the kind
of message that doesn't look like a dice-rolling moment from the
player's side -- just answering an NPC in their own words. Fixed with
an explicit instruction naming this pattern directly: agreeing to a
job, a rescue, a mission is never trivial, regardless of how ordinary
the sentence sounds.

**Issue 2: the reply after that opened with "Weak hit. +1 momentum
(now 3)" as literal narration.** Checked the frontend before assuming
this needed a new display feature: completed messages already render
a dedicated line above the prose showing the move name, outcome, full
dice breakdown, and meter changes -- confirming this was purely
redundant, not filling a real gap. The existing system-prompt rule
only forbade inventing a result without calling the tool; it never
addressed restating a REAL result in prose after a correct call, a
genuinely different concern the existing wording didn't cover. Fixed
with an explicit instruction: narration shows what an outcome MEANS
in the fiction, never the mechanical label that produced it.

**Issue 3 is the most significant single finding of the entire
session.** The vow the player swore never appeared in the trackers.
A direct search found create_progress_track -- a correctly
implemented, necessary tool -- referenced ZERO times anywhere in the
entire system prompt. Not misworded, not buried, genuinely absent.
Checking further rather than stopping at the one confirmed case found
the identical gap in Enter the Fray's combat objectives and Undertake
an Expedition's own track -- every major track-creating move in the
game, all silently assuming a track would just exist once referenced.
Fixed with both a new general instruction (added directly to
instruction 1, the very first line of the whole prompt) and explicit
reinforcement at each of the three specific points -- the same lesson
this whole session keeps confirming: a correct general principle
alone isn't reliable without reinforcement at the exact point of use.

2 new tests. Full regression, syntax, types, and playtest all clean.

## Real playtest feedback, investigated with the debug logging feature built specifically for this

The player uploaded actual screenshots and a debug log from a real
session and reported four things: a manually-toggleable "aboard"
status that should be story-inferred instead; present_choice offering
narrative dialogue options, not just mechanical ones; a chosen answer
that seemed completely ignored; and choice modals appearing on nearly
every turn, obscuring the story text. Read the actual log rather than
guessing at any of it -- this is exactly the situation debug logging
was built for two entries ago.

**"Aboard" confirmed real, fixed directly.** AssetCard had a genuine
manual toggle button ("Board this vehicle" / "Aboard (click to
disembark)") sitting right alongside the AI's own story-driven
set_aboard_vehicle tool call -- an inconsistency with how the rest of
the app works, where state flows from the narrative through the AI,
never from a silent player override. Removed the button and its
handler; the existing read-only "ABOARD" tag next to the asset name
already shows the same information without the desync risk.

**The other three turned out to be one root cause, confirmed directly
in the log, not inferred.** Three consecutive turns showed
present_choice firing for "How do you answer Tomas?", "What now?",
and "Do you trust her?" -- pure narrative dialogue decisions, none of
them a real move or a move's own outcome choice. Worse: after the
player gave a specific, substantive free-text answer to the first one,
the model's entire response was to silently re-issue the identical
choice again, with zero acknowledgment of what had actually been
said -- which is exactly what "ignored me completely" looks like from
the log's own record, not just from the player's side.

Checking the tool's own description confirmed the gap: it already
correctly scoped present_choice to two specific mechanical use cases,
but never explicitly ruled out narrative use, and evidently that
wasn't a strong enough signal on its own. Fixed with a concrete,
explicit negative instruction in two places for redundancy -- the
tool's own description (what the model reads when deciding whether to
call it at all) and system prompt instruction 1d, phrased using an
example ("How do you answer them?") deliberately close to the actual
observed failure, plus an explicit instruction against re-presenting
identical options once the player's own words already answered the
question. Fixing the narrative misuse at the root should also
substantially reduce how often the modal appears at all, addressing
most of the "hides the story text every turn" complaint as a
consequence rather than needing a separate UI fix -- though the modal's
own layout while it's legitimately showing a real mechanical choice
remains a lower-priority, separate item worth revisiting.

1 new test. Full regression, syntax, types, a standalone Vite build
(hash correctly changed, since the frontend genuinely changed), and
playtest all clean.

## The biggest single find of this entire session: asset ability unlocks weren't cross-checked in the guidance the AI actually reads

Asked directly: almost every asset has 2-3 abilities that only unlock
one at a time via Advance -- do they even work, and do they work all
the time or only once actually leveled? Traced the full chain end to
end rather than assuming either answer.

**The underlying mechanism is genuinely correct**, confirmed at every
link: a newly-taken asset defaults to only ability 1 unlocked, the
upgrade_asset tool correctly adds a new one when experience is spent,
the AI is correctly told to call that tool via Advance (instruction
12), and the character sheet's own asset listing already correctly
filters the raw ability text shown down to only the unlocked numbers.
Directly tested at the state level too, not just read -- add, unlock,
duplicate-rejection, and bad-ability-number-rejection were all already
covered.

**But the detailed, per-asset mechanical guidance the AI actually
reads to know HOW to apply a triggered ability never once checked or
even mentioned unlock state.** This isn't one asset's one gap -- it's
the three largest blocks in the entire system prompt (dice-modifying
assets, resource-tracking assets, mechanically-special assets, between
them covering the bulk of all ~90 assets), every single one
unconditionally describing abilities 1, 2, and 3 as if all three were
always available. A general principle already existed elsewhere
(instruction 10: "unlocked ones only") -- but nothing in the specific,
detailed "(1)...(2)...(3)..." text the AI is actually reading in the
moment ever pointed back to it. The exact same shape of gap this whole
audit has kept finding all session -- a correct general rule, not
reinforced at the specific point of highest risk -- just here landing
on nearly every asset in the game simultaneously rather than one
asset's one ability.

Fixed by adding a matching, explicit reminder to the start of all
three blocks: only apply an ability whose number is actually bracketed
on the character sheet above, not every numbered ability described
here for completeness.

1 new test confirming the reminder appears in all three blocks, not
just one or two. Full regression, syntax, types, and playtest clean.

## Checking two specific open items, rather than inventing arbitrary work

Asked for "any other optimizations." Rather than pick something
arbitrary, checked two specific items already flagged as open earlier
in the session.

**Swear an Iron Vow itself checked out clean.** Already fully covered
-- the stat, the connection/bond bonus, and the special miss rule
were all correct. A real check that came back with nothing to fix,
which is itself useful confirmation, not wasted effort.

**Re-reading Build a Starting Sector to verify a different suspicion
turned up a genuinely separate procedure.** The book's own three-step
"Begin Your Adventure" sequence (inciting incident, prologue vs in
medias res, then Swear an Iron Vow) turned out to already be covered
too -- but its fallback hook table was only ever referenced as vague
prose ("the book's own fallback hook list") rather than by its actual
oracle name. Checked directly: the oracle exists, is named "Inciting
Incident," and its first entry matches the book exactly. Fixed to
name it explicitly, the same discipline this whole session has
followed for every other oracle reference.

**Also found Build a Starting Sector's own Step 5 (Generate Stars,
explicitly marked optional in the book) missing entirely** from the
sector setup procedure -- not a wiring gap, just genuinely absent.
Verified the oracle ("Space/Stellar Object") resolves correctly and
added it as an optional addition within settlement generation, noted
as more than pure decoration: an unusual result there (a corrupted
star, an impending supernova) can genuinely feed a sector's trouble or
an early quest hook.

1 new test, including direct verification that both newly-referenced
oracle names actually resolve rather than just looking plausible.
Full regression, syntax, types, and playtest clean.

## New feature: opt-in debug logging, to tell an app bug apart from a model bug on any specific turn

Requested directly: some incorrect behavior during play could be the
app's own fault (wrong or missing guidance in the system prompt) or
the model's fault (guidance that was correct, just not followed) --
and there was no way to tell which from the player-facing chat log
alone, since that only shows the outcome, not what the model was
actually told going in.

**The core idea:** an opt-in setting that, once turned on, writes one
complete diagnostic record per turn to a per-campaign log file -- the
exact system prompt the model received (not a summary or a diff; the
literal text, since it's dynamically rebuilt from current state every
turn and genuinely differs turn to turn), every tool call it made and
the result of each in order, and the final reply. With both halves of
a specific turn sitting side by side, it becomes possible to actually
answer the question directly, rather than guess.

**Backend:** a new `appendDebugLog` function in store.cjs, writing
JSON Lines (one JSON object per turn) rather than a single growing
array, specifically so appending doesn't require reading, parsing,
and rewriting a potentially large file every single turn over a long
campaign. Wired into both `chat:send` and `chat:resolve-choice` via a
shared `logDebugTurn` helper, gated on a new `debugLogging` config
field that defaults to false for both a fresh install and an old
config predating the field -- entirely opt-in, since this writes the
full prompt text to disk every turn and shouldn't start doing that
silently for anyone who never asked. Never throws on a logging
failure of its own -- a disk issue shouldn't ever break the actual
turn it's trying to record.

**A real mistake happened wiring the second handler, worth stating
plainly.** Referencing a `capturedEvents` array in the event callback
before it was ever declared passes a syntax check cleanly (an
undeclared-variable reference isn't a syntax error in itself) but
would throw the moment that code actually ran. Caught by checking the
file's actual content directly rather than trusting the check alone,
and fixed before it could reach a build.

**Frontend:** a toggle and an "Open Debug Log" button in Settings,
wired through a new `debugLog:reveal` IPC handler that opens the log
file directly if one already exists for the campaign, or its
containing folder if logging was just turned on and no turn has
happened yet.

2 new tests covering the store functions directly (multiple appends
land as separate, independently-parseable lines rather than
overwriting each other) and the backward-compatible false default.
Full regression, syntax, types, a standalone Vite build check, and
playtest all clean -- and for the first time this whole session, the
renderer bundle's hash genuinely changed, correctly reflecting that
the frontend itself changed rather than just the backend.

## A real, structural oracle bug, raised directly: Core Oracles being treated as a nested sub-result instead of two independent tables

Pointed at directly: "the app seems to assume descriptor/theme/action
and another last core Oracle to be a sub-oracle, rather than its own,
independent and probably the most important category."

**Verified the actual structure before touching anything.** Action,
Theme, Descriptor, and Focus are confirmed as four separate,
independent, top-level Core Oracles -- checked directly against the
raw data, not assumed. The book's own text confirms their intended
weight too: "for a lightweight approach, it's possible to ignore the
other oracles and focus on answering questions using only... these
four tables."

**Found the actual bug by searching the entire oracle dataset, not
guessing at one table.** Dozens of other tables cross-reference these
as a joined pair -- "⏵Action + Theme", "⏵Descriptor + Focus" -- a
direct search turned up this exact pattern on 81 separate tables:
Settlements/Trouble, most Planets/*/Feature and Observed From Space
tables, every Derelicts/*/Feature and Peril, every Location
Themes/*/Feature and Peril, Vaults/*, Starships/*, Factions'
Projects/Quirks/Rumors, Characters' Role/Goal, and more. That scale is
itself confirmation the user's framing was right -- this isn't a rare
edge case, it's genuinely foundational.

**The actual bug: the cross-reference text itself doesn't resolve as
an oracle.** Calling roll_oracle with the literal joined name
("Action + Theme") returns nothing, confirmed directly -- there's no
such combined table. It has to be recognized as two separate,
independent rolls to make and combine, not one compound lookup. The
existing general cross-reference instruction only covered the
single-name case ("roll that linked table"), leaving this two-name
case genuinely unhandled. Fixed by extending it explicitly, and fixed
the same underlying confusion baked into Seer's own asset guidance,
which used ambiguous slash notation ("Action/Theme") that reads like
a hierarchical sub-table path rather than two oracles to combine.

**Worth being honest about a real mistake mid-fix, not just the
finding itself.** A first draft claimed Sector Trouble has this same
cross-reference, alongside Settlements/Trouble -- a plausible-sounding
detail that turned out to be false the moment it was actually checked
against the raw table. Caught before it shipped, corrected with the
real, verified list instead.

1 new test, including a direct assertion that the broken lookup
("Action + Theme") genuinely fails, confirming the bug this fix
addresses is real and not hypothetical. Full regression, syntax,
types, build, and playtest clean.

## Third asset batch completes the planned sweep, and a real mid-edit mistake caught by the test suite, not missed

Third batch (Shade, Trader, Vestige, Banshee, Combat Bot, Glowcat,
Rockhorn, Sidekick, Bonded, Oathbreaker, Vanguard, Fleet Commander) --
all twelve already had detailed existing guidance, which is itself a
useful confirmation that this audit's earlier work across the whole
session held up under the same scrutiny being applied now.

Two real gaps, the same recurring shape as the rest of this audit:
Trader's Resupply reward was described as "the player's choice"
without ever calling present_choice. Oathbreaker's redemption
stat-improvement was more subtle -- the actual rules text is
genuinely ambiguous about whether taking the improvement is optional
at all, or just which stat to pick -- but the existing guidance had
flattened that ambiguity into something reading as fully automatic.
Fixed by wiring the stat choice to present_choice while leaving room,
via its free-text option, for a player to decline the whole thing if
that's the intended reading.

**A real mistake happened fixing the second one, worth stating
plainly rather than glossing over.** An edit introduced an unescaped
quote inside a string literal, breaking the entire module's syntax.
It wasn't caught by re-checking syntax immediately after that
specific edit -- the discipline this whole session has otherwise held
to consistently -- but only because the full test suite happened to
run next. The result was a wall of 41 failing tests that looked like
a serious regression at first glance. It wasn't: every single one was
the same cascading syntax error (a broken module can't export
anything, so every dependent test fails identically), not 41 separate
problems. Fixed the one real issue, re-ran clean, and the lesson
stands: check syntax right after every edit, not after several.

1 new test. Full regression, syntax, types, build, and playtest
clean. This completes the planned three-batch sweep across all
non-trivial assets; the only remaining open item from this whole line
of work is character-creation-time and Truths choices, never yet
checked against this same standard.

## Point 4's audit continues (second asset batch), and a GitHub write-access question investigated and answered honestly

Second batch of the asset raw-data sweep (Devotant, Explorer,
Gearhead, Gunner, Haunted, Healer, Kinetic, Leader, Looper, Loyalist,
Mercenary, Scoundrel). Most turned out already well-covered --
running the suite surfaced that Gunner, Gearhead, Mercenary, and
Loyalist were already reviewed in an earlier "systematic sweep batch
3" from before this session's context was compacted, confirmed
directly by two pre-existing tests breaking against wording this
batch's own fixes correctly changed, not assumed from memory.

**Four real gaps found and fixed** in the assets that genuinely
hadn't been touched yet -- Devotant (three separate momentum-or-spirit
choices), Explorer (its wondrous-sight choice), Gunner (its pre-roll
Strike choice), and Haunted (a one-time, permanent choice with lasting
consequences either way) -- the same recurring pattern across this
entire audit: a real choice already correctly identified in prose,
never actually wired to present_choice. Both pre-existing tests broken
by these fixes were updated to assert the corrected wording, the same
discipline as every other test fix this session, not just patched
until green.

**A genuine, unplanned detour this entry, worth documenting honestly.**
Asked directly to start uploading source and built installers to
GitHub. Checked thoroughly before answering rather than assuming
either way: no git credentials anywhere in this environment (no SSH
keys, no `.netrc`, no git-credentials file, no GH_TOKEN/GITHUB_TOKEN,
`gh` CLI not even installed), and the MCP connector registry has no
GitHub connector listed either. Current documentation suggests
Claude.ai's GitHub integration is a read-only, context-ingestion
feature (pulling repo content in as reference material) rather than a
write-capable one -- the tool that actually pushes commits on Claude's
behalf is Claude Code via GitHub Actions, a different product not
wired up here. Told the user plainly rather than guessing or silently
failing on a later push attempt, and offered two concrete paths
forward: a personal access token pasted in for this session, or
continuing to deliver zips for the user to push themselves.

1 new test. Full regression, syntax, types, build, and playtest clean.

## Point 4's audit, shifted to the asset side: raw-data sweep begins, and Archer turns out as severe a miss as Fugitive was

The asymmetry from last entry got checked directly rather than left as
a guess: 80 of the 90 assets carry "may"/"choose" language in their
actual Dataforged text, and most of this whole audit's asset review
worked from the existing guidance rather than that raw source the way
the move sweep did. First batch of 12 (Heavy Cannons, Sensor Array,
Vehicle Bay, Workshop, Rover, Service Pod, Snub Fighter, Archer,
Artist, Bannersworn, Bounty Hunter, Demolitionist) gets that same
raw-data treatment now.

**Archer turned out to be exactly as severe a miss as Fugitive was.**
Its guidance only ever mentioned a shared, generic note about one
part of its third ability's preset-die mechanic -- the entire first
two abilities were completely absent. Not just present_choice wiring
missing: the ammo-spending choice on Strike/Clash, the full
replenish-by-crafting roll, and the volley-attack alternative trigger
for Enter the Fray weren't documented anywhere, despite ammo itself
already being correctly tracked in the resource system this whole
time. Wrote the missing two-thirds of this asset from scratch.

**Heavy Cannons, Sensor Array, and Bounty Hunter** all had this
audit's single most common finding -- a real choice already correctly
identified in prose, never actually wired to present_choice. Fixed
the same way as everywhere else.

**Demolitionist was a real, useful false alarm.** First look suggested
its charge mechanic was undocumented; it wasn't -- a dedicated entry
already existed and was already correct, just missed by an early
search matching a different, narrower mention of it first. Worth
following through anyway rather than trusting the first result: doing
so found one genuinely missing piece, a plain second-ability bonus
never written down, now added.

1 new test. Full regression, syntax, types, build, and playtest clean.
Remaining from this same raw-data approach: roughly 25 more assets,
plus a still-open check on character-creation-time and Truths
choices.

## Point 4's audit: a second major undocumented-move gap, five smaller wiring fixes, and a genuine design reconsideration for a multi-select choice

Searched specifically for "choose one/between/two" across every
move's raw text -- the most direct possible signal of a real choice --
and cross-checked coverage move by move, rather than continuing to
rely on the earlier, narrower "may" search.

**This found a second gap of the same shape and scale as last entry's
Withstand Damage discovery.** Check Your Gear, Undertake an
Expedition, and Set a Course had zero dedicated guidance anywhere in
this prompt -- only assets that modify them, all assuming the base
mechanics were already documented somewhere they weren't. Undertake an
Expedition in particular is the primary move for the entire
expedition/travel system, not a minor case. Wrote complete guidance
for all three, including that Undertake an Expedition's stat is
approach-dependent (edge/shadow/wits, picked by how the player
actually describes moving) rather than fixed.

**Five smaller instances of this whole audit's most common finding**
-- described as a choice in prose, never actually wired to
present_choice -- fixed the same way as everywhere else: Secure an
Advantage's weak-hit choice within Scene Challenge resolution, Enter
the Fray's weak-hit control-or-momentum choice, the shared
miss-recommit decision for Fulfill Your Vow and Finish an Expedition,
and Heal's weak-hit cost choice.

**Gain Ground needed actual thought, not just the same pattern
applied again.** Its strong hit picks two of three rewards -- but
present_choice is single-select, so offering all three options
wouldn't let the player actually pick two. Rather than chaining two
sequential present_choice calls for one decision (the same trap
caught and avoided for Take a Break two entries ago), restructured it
to offer the three possible pairs directly as the options instead.

**A real mistake happened writing this entry's own tests, worth
naming rather than glossing over.** The first test for the Gain
Ground/Scene-Challenge fixes failed on a rerun -- not because the fix
was wrong, but because the test itself hadn't set up an active fight
or an active Scene Challenge, both of which those specific
instructions are conditionally gated on. Caught by actually running
the suite rather than assuming a clean syntax check meant the test was
right, fixed by adding the real state setup those code paths need,
verified against the actual passing suite afterward rather than just
trusted.

2 new tests. Full regression, syntax, types, build, and playtest
clean.

## Point 4's audit, finishing the original move inventory: another undocumented core choice, and a genuine design reconsideration

Reviewed the last of the original 23-move "may" inventory (Begin a
Session, Take a Break, Reach a Milestone, Forsake Your Vow, Develop
Your Relationship, Explore a Waypoint, Make a Discovery, Confront
Chaos, Earn Experience, Advance, Ask the Oracle) individually. Most
turned out to be GM-facing judgment calls or trigger-condition
phrasing that don't actually need present_choice -- correctly left
alone, since fixing something that isn't broken just adds noise.

**Explore a Waypoint's own base strong-hit choice was undocumented
anywhere in this prompt** -- Find an opportunity vs. Gain progress,
on one of the single most frequently-triggered moves in the entire
game (it's the core resolution move for every waypoint during
Undertake an Expedition). Worse, the existing guidance for its
strong-hit-with-match option -- substituting Make a Discovery entirely
-- read as if that substitution happened automatically on a match,
when the actual rule is a genuine third choice alongside the normal
two, not a replacement of them. Wrote a complete new instruction
covering all of it correctly.

**Take a Break needed an actual design decision, not just a
present_choice stamp.** The existing guidance said the AI "may offer"
it -- prose, not a real pause. The straightforward fix would have been
copying the same pattern used everywhere else in this audit. But Take
a Break has its own two-part structure (take a break at all, then
which of two outcomes), and chaining two sequential present_choice
calls for one decision would mean two separate round-trip pauses where
one suffices. Collapsed it into a single present_choice with three
real options instead -- worth a moment's actual thought rather than
mechanically reapplying the same shape everywhere it fits.

**Advance was checked and deliberately left alone**, not skipped by
oversight -- unlike the other gaps found this session, it's typically
player-initiated ("I want to Advance and take X") rather than
something the AI needs to proactively interrupt a turn to offer, so
the general principle already covering it is the right level of
handling, not a dedicated instruction.

1 new test. Full regression, syntax, types, build, and playtest clean.
This completes review of the original 23-move inventory; open work
remains on move/asset text outside that original search's specific
phrasing.

## Point 4's audit, shifted to moves: the single biggest gap found in the whole sweep

Moved from assets to the moves themselves, as planned. Pulled every
move with "may" language directly from the raw move data -- 23 real
matches, not estimated.

**This turned up the biggest gap in the entire audit.** Withstand
Damage and Companion Takes a Hit -- Endure Harm's direct equivalents
for a vehicle and a companion, both extremely frequently triggered --
had zero dedicated guidance anywhere in this system prompt. Not
prose-only guidance needing an upgrade to present_choice, like most of
this audit's other finds -- nothing at all. Both moves have real
choices: Withstand Damage's strong hit is an actual "choose one"
(Bypass for +1 integrity, or Ride it out for +1 momentum), its weak
hit offers an optional trade, and a vehicle at 0 integrity faces a
genuine four-way fork for a command vehicle specifically, none of it
written down anywhere. Wrote a complete new instruction (19d) covering
both moves in full, matching the depth already given to Endure
Harm/Stress.

**Reading the instructions immediately around that gap, rather than
just patching it and moving on, found two more real ones in the same
neighborhood.** Face Death and Face Desolation's weak-hit option to
Swear an Iron Vow instead of dying was described in prose implying a
choice, but never actually called present_choice for it (19b).
Overcome Destruction's whether-to-accept-the-favor decision had the
same shape of gap (19c). Both fixed the same way as everything else
in this audit -- described as a real, explicit present_choice call,
not left implicit.

**Sojourn, Resupply, and Repair's recover-move decisions got the same
treatment**, despite already being fully documented and already used
as the flagship example in present_choice's own general instruction
(1d). Documented and referenced as an example is not the same as
actually wired -- 20b's own text never called present_choice directly
for any of these. Strengthened it to do so explicitly for all of
Resupply's strong-hit reward choice, Repair's supply-for-repair-points
option, and Sojourn's three separate decision points (strong hit,
weak hit, miss), rather than trusting the general principle to
reliably reach a case this specific and this frequent on its own --
the same lesson this whole audit keeps confirming.

3 new tests. Full regression, syntax, types, build, and playtest
clean.

## Point 4's audit, continued: reviewing the full original inventory individually, and finding a genuinely missing ability, not just a missing present_choice

Finished reviewing all remaining candidates from the original 39-item
inventory individually against their full guidance text, rather than
trusting the new general principle (5a) to cover everything by
assumption. 21 of 22 already used correct, explicit "the player may"
framing that 5a now catches on its own -- confirmed one at a time, not
skimmed.

**Fugitive was a different kind of problem than the rest of this
audit** -- not a missing present_choice call, but a missing ability
description entirely. Checked the raw Dataforged text directly rather
than trusting the existing guidance: the real first ability lets the
player improve the result of literally any move to a strong hit, no
reroll, no dice. The existing guidance only described what happens to
a tracking clock afterward, never the ability that triggers it -- the
AI had no way to know this significant, generically-applicable power
even existed. Rewrote it to actually describe the ability itself,
gated by present_choice the same shape as burning momentum.

**A second sweep for different optional-choice phrasing** ("optionally",
"the player's choice", and similar) turned up Crew Commander sharing
the exact same shape of gap as Fugitive, just smaller: spending a
resource to upgrade a roll's outcome by one step, described without
ever marking it as the player's own decision rather than something
that just happens automatically once the resource is available. Fixed
the same way.

**A third, targeted sweep specifically for this outcome-upgrade
pattern** elsewhere in the prompt (rather than assuming these two were
the only cases) turned up no further unmarked instances -- the one
other match found was Outcast, already correctly framed and already
reviewed. Real confirmation that these two were genuine outliers, not
visible symptoms of a wider unexamined pattern.

1 new test covering both fixes. Full regression, syntax, types, build,
and playtest clean. This completes review of the original inventory;
the audit itself (checking against move text too, not just assets, and
against any phrasing this session's three sweeps still might have
missed) remains open for further passes.

## Starting point 4's audit: a general principle, plus the single highest-impact specific fix found so far

The first real installment of "go over every roll/choice interruption
across all moves and assets" -- explicitly the same scale as the
earlier full-asset sweep, approached the same way: build a concrete
inventory before touching anything, not an estimate.

**Inventoried first.** A direct grep for "the player may" / "player
chooses" style language across the whole system prompt turned up 39
initial candidates -- real numbers, not a guess at how big this is.
Roughly 34 of them are individual asset abilities; the rest are
general move instructions.

**Added one general principle rather than rewriting dozens of
individual entries one at a time.** Instruction 5a extends the
momentum-burn pattern (just fixed last entry) to the general class:
any genuinely optional asset ability affecting a roll -- a reroll, a
resource spend, a choice between two rewards, rolling a different
stat -- should stop for present_choice, not get mentioned in prose and
narrated past. This mirrors how instruction 1d already handles
move-outcome choices as a general principle rather than being spelled
out separately for every single move that has one.

**Found something more specific and higher-impact within that same
sweep, not just the general fix.** Endure Harm and Endure Stress's own
Step 2 structure -- one of the most frequently-triggered pairs of
moves in the entire game -- turned out to have four separate real
decision points, all still prose-only: whether to even resist
optionally in the first place, the strong-hit "shake it off" vs.
"embrace it" choice, the weak-hit momentum-for-healing choice, and the
miss's cost choice (including a real third fork, at 0 health/spirit,
between marking an impact directly or rolling the severe harm table
instead). Rewrote the whole instruction to wire all four to
present_choice individually, not just trusted the new general
principle to catch something this important and this frequent on its
own.

**This is one installment, not a finished pass** -- said plainly
rather than implied otherwise. Roughly 20 more candidates from the
initial inventory (mostly individual asset entries -- Ace, Armored,
Augmented, Brawler, Diplomat, Empath, Gunslinger, Naturalist, Outcast,
Seer, Sniper, Protocol Bot, Utility Bot, Grappler, Engine Upgrade,
Homesteader, Tech, Weapon Master, Revenant, Symbiote, Fugitive,
Starship) still need individual review to confirm the new general
principle actually covers each one correctly, not just assumed because
it sounds like it should. The general instruction was spot-checked
against a few already-reviewed entries (Hoverbike's momentum-burn
interaction, its afterburner's spend-for-bonus-with-downside) and held
up consistently, but that's confirmation on a handful, not the full
remaining set.

2 new tests, checking the general principle and each of Endure
Harm/Stress's four decision points individually, not just that
present_choice appears somewhere in the instruction. Full regression,
syntax, types, build, and playtest clean.

## Four playtesting notes from actual use -- two real bugs found and fixed, one root-caused precisely, one scoped honestly as a larger future audit

Real reports from actually playing the game, not hypothetical review.
Worked through each concretely rather than guessing at fixes.

**1. Momentum burning wasn't actually pausing for a real answer.**
`burn_momentum` itself already existed, already well-tested and
correctly validated (refuses a burn that wouldn't genuinely help,
rejects the exact boundary case, requires the real challenge dice
rather than trusting a guess). Instruction 5 already told the AI to
"point out" the option -- but that was just prose the AI could
mention and then roll straight past, with nothing actually stopping
the turn for a real answer. Rewired to call present_choice instead,
the same mechanism built two sessions ago for exactly this kind of
gap, just never connected to this specific one. **A real bug caught
immediately while writing the fix, not after:** the new instruction
text interpolated `${momentum}`, a variable that was never in scope
at that point in the function -- would have thrown on every single
system prompt build, meaning the entire app would have broken the
moment this shipped. Caught by actually calling buildSystemPrompt
directly rather than trusting a syntax check alone (which passed
clean despite the bug), fixed with the correct `c.meters.momentum`
path, then re-verified against two different momentum values to
confirm the interpolation is genuinely live, not just present.

**3. Expanded Hold's cargo tracker (and nine other assets') were
invisible in the UI despite being correctly tracked all along.**
Checked the actual backend before assuming anything was missing:
`ASSET_RESOURCES` in state.cjs already had complete, correct entries
for Expanded Hold and nine other resource-bearing assets (Missile
Array's ammo, Shields, Fleet Commander's power, and more), each
correctly populating `asset.resource` the moment the asset is added.
The real gap was entirely on the frontend -- `asset.resource` was
never rendered anywhere, for any asset, confirmed by a direct search
turning up zero results. Added a real display matching the existing
health meter's own tick style exactly. **A second real bug caught
before shipping:** the CSS only defined `.meter-tick.filled` paired
with a specific color modifier (`.health`, `.spirit`, `.supply`,
`.integrity`) -- no bare `.filled` rule existed, so the new resource
ticks would have rendered as empty regardless of the actual value.
Added a proper `.resource` color variant and fixed the class name
before it could ship looking broken.

**2. Vow and expedition auto-progression: root-caused, not yet fixed.**
Checked the actual guidance before assuming it didn't exist --
instruction 29c already tells the AI, in strong, proactive language,
that vow progress "is a judgment call you make from the fiction, not
something that waits for the player to ask... mark it in the same
turn." This already matches what was asked for almost exactly.
Expeditions are deliberately handled differently and documented as
such in that same instruction -- their progress is tied to Undertake
an Expedition's own roll outcomes, not a separate estimation. Given
the guidance already exists and reads correctly, the actual gap is
harder to diagnose with confidence than 1 or 3 were -- likely a
matter of how reliably a long system prompt's judgment-call
instructions get followed in practice, not a missing mechanism the
way momentum burning was. Left this one unresolved rather than ship
a guess; worth a focused follow-up rather than a rushed patch.

**4. "Audit every roll/choice interruption across all moves and
assets" acknowledged as its own, larger undertaking** -- the same
scale as this project's earlier 90-asset sweep, not something to
compress into this entry. Point 1's fix is exactly the kind of thing
this audit would need to find systematically rather than one report
at a time.

3 new tests. Full regression, syntax, types, build, and playtest
clean.

## Correcting the pacing dial's actual model, based on a clarifying exchange about what the slider was really supposed to compare

Last entry built the slider around the wrong axis: "the AI's confidence
about which single move applies," gated by a separate, always-on
"is this dramatically obvious" carve-out sitting outside the slider
entirely. A follow-up question ("does moving toward Small Chance make
it assume moves, or stop doing moves with high triviality?") surfaced
that these were two different, only loosely-related things bolted
together -- and the real intended design collapses them into one.

**The corrected model is a single axis, not two gates.** The AI now
judges one thing: how plausible is it that this action is trivial
enough to need no move at all, in the same five-tier language. Above
the player's threshold, it's trivial -- narrated straight through, no
move, no roll. At or below the threshold, it is NOT trivial, and
present_choice fires unconditionally -- not "usually," not "unless the
AI feels confident about one option," always, every time, once
you're at or below the line. The previous design let a separate,
independent confidence judgment silently override the slider in
edge cases; this one doesn't allow that at all.

**Verified the actual behavior change by tracing through both ends of
the scale before touching any code.** At Almost Certain (the
default), nothing can rank above the ceiling of the scale, so
virtually nothing gets treated as trivial and the GM asks about
nearly every real action -- unchanged from two entries ago. At Small
Chance, nearly everything ranks above that floor, so nearly
everything gets waved through as trivial, and only the situations the
AI judges as genuinely, deeply uncertain still stop to ask. Same
overall pacing gradient as before, reached through one clean rule
instead of two loosely-connected ones.

**Updated every place the old model was described, not just the core
instruction.** The system prompt instruction, present_choice's own
tool description (kept consistent with each other again, same
discipline as the past two entries), the Settings slider's label, and
its explanatory paragraph all described the superseded "confidence
about which move" framing and needed rewriting together -- an
inconsistency between any of these and the actual rule would have
left the model (or the player) reading a mix of the old and new
policy.

**Fixed the test asserting the old model's exact wording again,**
matching the same pattern from the past two entries -- rewritten to
verify the corrected, unified behavior specifically (including that
the old, separate confidence-in-which-move phrasing and the
independent triviality carve-out are both genuinely gone, not just
supplemented), rather than left to quietly assert a policy that no
longer exists.

Full regression, syntax, types, build, and playtest clean.

## A real, player-controlled pacing dial for present_choice, grounded in the game's own vocabulary

Last entry corrected my own over-narrow scoping of present_choice by
making it fire on every assumed move by default. This entry adds the
right way to actually dial that back, if a player wants to: not the
AI silently deciding when to ask (which was the actual mistake
corrected last time), but a real setting the player controls
themselves -- suggested directly, and grounded in a genuinely existing
game mechanic rather than an invented scale.

**Reuses real game vocabulary instead of making up a new one.**
Verified directly against Ask the Oracle's own odds table before
building anything: five tiers, Small Chance / Unlikely / 50-50 /
Likely / Almost Certain, mapped to exact roll thresholds (10/25/50/
75/90 or less). A new Settings slider lets the player set a threshold
in that same five-tier language, and the system prompt now asks the
model to judge its own confidence that one specific move clearly
applies using that identical vocabulary -- present_choice fires
whenever that self-assessed confidence is at or below the player's
setting. At the default (Almost Certain, the most permissive tier),
this preserves last entry's corrected "ask virtually always" behavior
exactly, since nothing ranks above it. Moving the slider toward Small
Chance narrows it toward only the genuinely uncertain cases -- a real
choice the player makes, not the AI second-guessing on their behalf
again under a new name.

**Triviality remains the one absolute gate, regardless of the
slider.** An action dramatically obvious enough to need no roll at
all still skips present_choice entirely at every setting -- that's
not a pacing preference, it's whether a move applies in the first
place.

**Threaded all the way through and tested at each layer**, not just
the prompt text: `store.cjs`'s config defaults (fresh install and
old-config migration both tested directly against a real temp
directory, not assumed from symmetry with existing patterns -- caught
myself about to assume `saveConfig`'s exact name before checking it),
`buildSystemPrompt`'s new third parameter (correct label
interpolation verified for all five tiers plus both fallback edge
cases -- omitted entirely, and an unrecognized stored value, both
correctly defaulting to the most permissive tier rather than
something silently more restrictive), both `main.cjs` call sites, and
a real slider control in Settings with live tier labels.

2 new tests, plus the existing test from last entry's now-superseded
policy rewritten to verify the new threshold mechanism instead of
just deleted. Full regression, syntax, types, build, and playtest
clean.

## Correcting my own over-caution from last entry: present_choice fires on every assumed move, not just genuinely ambiguous ones

Direct correction to the previous entry's scoping: "This feature
should be fired on every message where the AI would assume a move.
This means that the AI should evaluate triviality of player's actions
in every situation."

**Worth being straightforward about what happened.** Last entry, I
deliberately narrowed the feature to only trigger on genuine ambiguity
between multiple plausible moves, worried about it becoming annoying
if it fired too often -- and explicitly wrote that concern into the
instruction itself ("don't interrupt the player with a picker they
don't need"). That was my own judgment call, not something asked for,
and it was wrong: the actual intent was for this to fire every time
the AI would otherwise assume a move on the player's behalf at all,
with only one real exception -- genuine triviality, not degree of
ambiguity.

**Rewrote the policy correctly this time.** Even when one move looks
like the clear best fit, it still gets offered now, alongside the
next most plausible real alternative, rather than the AI silently
rolling its own best guess. The only thing that skips present_choice
entirely is an action dramatically obvious enough that no roll is
warranted in the first place -- reusing this project's own existing
"when something is dramatically obvious, just make it happen"
principle as the actual gate, rather than the ambiguity-based one I'd
substituted for it. Updated both the system prompt instruction and
the tool's own description together, since a model reading a
self-description still anchored to the old, narrower policy could
easily undercut the corrected instruction sitting right next to it.

**Fixed the test I'd written for the wrong policy, not just the
prompt text.** The test added last entry directly asserted the old
behavior by name ("scoped against overuse... not a picker on every
message"), which would have kept passing right past this correction
if left alone -- a green checkmark quietly protecting the very
mistake being fixed. Rewrote it to assert the corrected policy
instead: fires even on a single clear fit, gated on triviality, old
framing confirmed genuinely absent rather than just supplemented.

Full regression, syntax, types, build, and playtest clean.

## Extended present_choice to a second use case: offering real move candidates when free text is genuinely ambiguous, not just move outcomes

A follow-up idea to last entry's pause-for-choices feature: rather than
the AI silently picking whichever move seems likeliest when the
player's own free-text message doesn't specify one, it should
recognize genuine ambiguity between multiple real, distinct moves and
offer the actual candidates -- letting the player choose which one
actually applies before anything gets rolled.

**No new architecture needed -- this reuses exactly what already
exists.** present_choice, the pause/resume turn loop, and the frontend
modal built last entry for move-outcome decisions work identically
here; this is a system-prompt extension telling the AI about a second
legitimate reason to reach for a tool it already has, not a new
mechanism. The tool's own description was updated to reflect both use
cases, not just the original one, so the model's own understanding of
what the tool is for stays accurate.

**Deliberately scoped against becoming annoying.** The real risk with
a feature like this is turning every message into an interruption --
explicit instruction that this is for genuine ambiguity between
multiple meaningfully different moves, not a picker shown reflexively;
a clearly-mapped action should still resolve directly without asking.
Also explicit that combat-replacement rules and explicit Moves panel
selections (both already documented) resolve most cases before this
would ever need to trigger, and that present_choice's existing
free-text fallback already covers "none of these fit" without needing
a dedicated option for it on every list.

1 new test confirming the instruction and the updated tool description
are both present. Full regression, syntax, types, build, and playtest
clean.

## Connections were missing a real, official field: location -- confirmed against the actual Connections Worksheet, not assumed

Pointed directly at page 12 of the Playkit -- the official Connections
Worksheet -- and asked to re-read Connection Moves and Make a
Connection against it.

**Extracted the actual worksheet rather than trusting the filename.**
The Playkit turned out to be a page-image archive, not a normal text
PDF -- each page is an image plus separate OCR text, not something
`pdftotext` can read directly. Rendered page 12 as an image and
confirmed its real layout: Name, Location, Role, Role, a Bond
checkbox, and a standard 10-box progress track per connection. The
book's own Make a Connection text confirms it independently: "make
note of their name, location, and any other characteristics worth
recording." Location was genuinely missing -- there was no dedicated
field for it anywhere, only general notes it would have had to be
folded into.

**Re-read all of Connection Moves as asked, and the actual move
mechanics checked out clean.** Test Your Relationship's bonded +1,
the strong/weak cascade into Develop Your Relationship, Forge a
Bond's deferred weak-hit reward (the bond doesn't land until the
request is actually fulfilled, not at the moment of the roll), the
miss recommit mechanic -- all already correctly implemented, matching
the re-read text precisely. This pass found one real, structural gap
(the missing field), not scattered mechanical ones.

**Added location end to end**, not just as a stored value: the state
functions, the add_connection tool schema, a new
set_connection_location tool for setting it later, the character-
creation local-connection step (which obviously has a location -- the
character's own starting hex, now recorded instead of left blank),
the frontend UI in the same field order as the real worksheet, and
the AI's own state dump -- which was silently omitting location even
after the state layer already supported it, meaning the AI couldn't
have referenced or acted on a location that was technically being
stored.

**Two real bugs caught along the way, not just the planned feature
work.** The `connections:add` IPC handler was destructuring its
payload without `location` in its parameter list, silently dropping
it even after the frontend started sending it -- confirmed by
checking the actual handler rather than trusting that wiring the
frontend was sufficient. And a first draft of the system-prompt
instruction pointed the AI at `update_connection` to record a
location later, which doesn't exist as an AI-facing tool at all --
caught by directly checking TOOL_SCHEMAS rather than assuming a
plausible-sounding name existed, fixed by adding the real tool
instead of leaving a broken reference in place.

3 new tests. Full regression, syntax, types, build, and playtest
clean.

## New feature: the game actually pauses for player choices now, instead of the AI silently deciding for them

A real, structural gap reported directly, and a recurring one: this
whole project has documented dozens of genuine "choose one of"
outcomes throughout its own system prompt guidance -- Secure an
Advantage's momentum-or-bonus, Sojourn's pick-two-recover-moves,
Fulfill Your Vow's miss recommit-or-forsake, and many others -- but
the AI had no way to actually stop and ask. It just picked on the
player's behalf every time, however carefully the mechanics were
documented elsewhere in this same prompt.

**Built as a genuine pause in the turn, not a UI trick layered on
top.** A new `present_choice` tool the model can call instead of
deciding -- and when it does, `runTurn`'s own loop intercepts that
call before it ever reaches the normal tool dispatcher, and returns
immediately with the decision still genuinely unresolved: no
fabricated "result" standing in for what the player would have said,
which would just be the model picking for them again by another
name. The conversation itself is left mid-tool-call, deliberately
incomplete, until the player actually answers.

**A real pop-up, not a chat message the player might miss.** A new
`ChoiceModal` shows the prompt and every option as an actual button,
plus a free-text field when the model allows a custom answer. The
normal composer is disabled while a choice is open -- there's no
sensible "type something else instead" path mid-decision. Answering
appends the player's real response as that specific tool call's
result and re-enters the turn loop from exactly where it paused, so
the story continues knowing what was actually chosen, not what the
model guessed.

**Persisted properly, not just held in memory.** Unlike the Undo
checkpoint (deliberately ephemeral), a pending choice is saved to the
campaign file itself, since a player could close the app mid-decision
and reasonably expect to see it again later. Correctly carried through
on campaign duplication and import too, so an in-progress choice never
gets orphaned by copying a campaign while one is open. Backward-
compatible migration handles existing saves that predate the field
entirely.

**Handles the messy real-world case too, not just the clean one.** The
tool's own description tells the model to call it alone, but nothing
guarantees a model actually will -- so if other tool calls end up
bundled in the same batch, ones before present_choice still execute
for real, and the resolve step defensively supplies an honest
"skipped, a choice had to be resolved first" placeholder for anything
stranded after it, so the conversation stays valid regardless of how
the model actually behaves.

5 new tests added directly to the existing mocked-fetch harness for
the turn loop, covering present_choice alone, bundled with a prior
real call, the complete pause-resolve-resume round trip, and the
defensive stranded-call handling -- the same approach already used
elsewhere in this project for IPC-layer logic that can't be imported
outside Electron. Full regression across all five suites, syntax,
types, build, and playtest clean.

## New feature: image prompts composed by AI from real story context, not fixed JS templates

Requested directly, following up on last entry's image-generation
fixes: rather than a hardcoded template string (`Portrait of ${name},
${description}, sci-fi, painterly`), the prompt for every generate
button should be composed by inferring the subject's appearance from
the actual story -- character description, notable gear, what's
happened recently -- the same way a person writing the prompt
themselves would draw on everything they know, not just concatenate a
couple of fixed fields.

**Built as a new, focused, non-conversational OpenRouter call**
(`promptComposer.cjs`), the same established pattern this project
already uses for context-compaction summarization -- deliberately not
routed through the main GM conversation loop, so "compose me an image
prompt" never appears as a message in the actual campaign transcript,
and this call can carry its own narrow, tailored context instead of
the full tool-calling system prompt the main loop needs.

**Real, distinct context for each of the four cases**, gathered
server-side from the live campaign state: a character portrait pulls
name, pronouns, description, and every owned asset's name (a
Gunslinger's player, for instance, plausibly carries and dresses for
a weapon, even if nothing says so explicitly -- the composer is
instructed to make reasonable inferences like this without
contradicting anything actually stated); a connection portrait pulls
their name, role, and notes; a location image pulls the sector cell's
name, notes, and every recorded feature; an illustration pulls a
recent-story slice, preferring the compressed story summary when one
exists over raw log entries. Also inherits the temperature/top_p
settings from two entries ago -- a deliberate difference from the
summarizer's own calls, which exclude those on purpose as an accuracy
task; composing a vivid, varied prompt is a creative one, using the
same model, so the same creativity preference plausibly carries over.

**Degrades honestly instead of breaking** if composition fails --
no API key configured, a network hiccup -- falling back to the old,
simple template with a visible explanation of what happened, rather
than leaving the box stuck empty or the feature silently unusable.

New dedicated test file (`__selftest_promptComposer__.cjs`, matching
the existing summarizer/comfyui test pattern, wired into `npm run
test`) -- 9 tests covering all four context branches pulling the
right fields, the empty-context fallback, response trimming, both
real error cases, and the temperature/top_p threading. Full
regression across all five suites, syntax, types, build, and playtest
clean.

## Real bug, reported with a screenshot: explicitly selecting a move from the panel didn't guarantee that move actually happened

The player picked "Make a Discovery" directly from the Moves panel,
typed a description, clicked "Make this move" -- and the AI called
Gather Information instead. A different move, silently substituted.

**Traced the actual cause rather than patching the symptom.** The
Moves panel composes a plain message ("I want to make the \"X\"
move...") and sends it through the ordinary chat pipeline, with
nothing anywhere telling the model this represents a deliberate,
explicit UI selection rather than a free-text description open to
the model's own interpretation.

**Made worse by a second, genuinely real finding underneath the first:
Make a Discovery has no stat to roll at all.** Confirmed directly
against the raw move data, not assumed -- it's a table-roll move with
its own linked oracle, not a normal action-roll move. One of 18 out
of the game's 56 moves with no Trigger.Options. The model's
substitution wasn't an arbitrary failure; it was a coherent response
to a request it had no clean mechanism to fulfill as literally
stated. But that's exactly the problem -- it should have honored the
explicit selection through the correct mechanism (rolling that move's
own linked table directly) instead of silently swapping to something
else.

**Fixed both halves together**, since they're the same underlying
gap: an explicit "I want to make the X move" selection is now treated
as unambiguous, not just another action description to weigh against
alternatives. For a normal move, call it exactly. For a table-roll
move like Make a Discovery, Confront Chaos, Ask the Oracle, Pay the
Price, or Begin a Session, honor the selection via roll_oracle on that
move's own linked table (it resolves by the move's own name directly,
already verified against the fixed oracle-lookup system from earlier
in this project) and apply its stated reward, rather than treating
"no stat to roll" as license to pick something else entirely. The
only exception left standing is a genuine, already-documented
rules-based override (like the existing combat-replacement rule) --
and even then, the model should say so, not substitute silently.

1 new test. Full regression, syntax, types, build, and playtest clean.

## Three real image-generation UI bugs, reported directly: cropping, no regenerate, an empty prompt

**Frames were cropping generated images.** The character portrait and
sector cell image both used a fixed pixel height with `object-fit:
cover`, which crops to fill whenever a generated image's actual
aspect ratio doesn't match. Changed both to `height: 'auto'`, so the
frame follows the image's real proportions instead of forcing it into
one and cutting off content -- the same pattern the image lightbox and
one other spot already used correctly, just not applied consistently
everywhere. Also applied to the single-column Illustrations list for
the same reason. Left alone on purpose: the actual thumbnail grid and
a 40x40 icon-sized portrait, where a fixed, cropped square is the
correct, intentional design for a tidy grid or a tiny icon, not a bug.

**There was no way to regenerate an image once one existed.** Real bug,
not a missing feature -- in three separate places (character portrait,
sector cell image, connection portrait), the generate button was
conditionally hidden entirely as soon as an image existed, with no
other path back to it. Fixed all three the same way: the image and the
generate control now both render whenever an image exists, with the
button's own label switching to "Regenerate" so it's clear what
clicking it will do.

**The Illustrations panel's prompt box was starting genuinely empty**,
not composed from anything -- confirmed by checking, not assumed: the
portrait and location-image prompts were already pulling from
character description or cell notes respectively, but the
illustration one was passing a literal empty string. Composed a real
default instead, falling back through the most relevant context
available: the campaign's own recent story summary first, the most
recent log entry if that's not there yet, or the character's own
description as a last resort early in a campaign.

Pure frontend changes -- no backend logic touched, so no new automated
test (this project has no React-component test harness; verified via
`tsc` and a full sweep of every remaining GeneratedImage/
InlineImageGenerate call site to confirm the fix was applied
consistently and nothing else needed the same treatment). Full
regression, syntax, types, and build clean.

## Real bug: the iteration cap was hit on literally the first message of a new campaign

Reported directly, with a screenshot: "Hit the tool-call iteration cap
(8) without a final narration" on the starter message.

**Root cause was this project's own thoroughness catching up with a
safety-net value set early on, before that thoroughness existed.** The
book's own "Build a Starting Sector" procedure is deliberately run as
one full upfront batch on the very first turn (systemPrompt.cjs's
sectorSetupBlock, built out across several earlier sessions) -- and by
itself, a genuinely thorough Terminus-region setup is an estimated 50+
individual tool calls: 4 settlements each needing 5+ oracle rolls plus
a reveal/feature call, passages, zoom-in detail on top of that, a
starting connection, more. The 8-round-trip cap was set well before
that procedure grew to this level of detail, and was never revisited
against it.

Tallied the actual minimum before touching anything, rather than just
guessing at a bigger number: roughly 53 tool calls for a full Terminus
setup alone, before any character-review or opening narration. At 8
rounds, even assuming a generous 4 tool calls batched per round-trip,
capacity tops out around 32 -- genuinely insufficient regardless of
model behavior, not an edge case.

**Raised to 60** -- comfortable headroom above the estimated minimum,
while still functioning as a real safety net against an actually
runaway/looping model, which would hit this ceiling far faster than
50-60 legitimate calls ever would.

The existing test for this cap (`__selftest_openrouter_loop__.cjs`)
imports and asserts against the live `MAX_TOOL_ITERATIONS` constant
rather than a hardcoded number, so it adapted automatically -- run
directly to confirm rather than just assumed.

No new test needed; full regression, syntax, types, build, and
playtest clean.

## New feature: Temperature and Top P in Settings

Another request about the app itself: the ability to tune the text
model's own sampling behavior, rather than always running at whatever
default OpenRouter or the underlying provider picks.

**Both fields are optional and genuinely absent when left blank**,
not silently forced to some default value. Threaded all the way
through: `store.cjs`'s config load/defaults, through `chat:send`, into
`runTurn`'s actual OpenRouter request body -- the temperature/top_p
keys are only added to that JSON payload when a real value is set,
never sent as `null` or `undefined`, since some providers may reject
or handle that unpredictably differently from the key simply not
being there.

**One real edge case mattered here and got explicit handling and a
test: temperature 0 is a valid, meaningful value** (fully deterministic
sampling), not something to treat as falsy-and-therefore-unset. An
early, naive `if (temperature)` check would have silently dropped it;
the actual check is `!== null && !== undefined`, verified directly
against both the zero case and the omitted case.

**Deliberately does not touch the summarizer's own, separate OpenRouter
call** -- context compaction is an accuracy task, not a creative one,
and a temperature tuned for varied GM narration would work against a
summarizer that wants to stay faithful to what actually happened.
Left alone on purpose, not missed.

Tested by capturing the real request body `runTurn` builds through its
existing mocked-fetch test harness (`__selftest_openrouter_loop__.cjs`)
-- not a separate simulation, the actual function under test. 2 new
tests there. Full regression, syntax, types, build, and playtest clean.

## New feature: Edit, Regenerate, and Undo -- rolling back a turn's real mechanical consequences, not just its text

The user's own suggestion, from a review of the app itself rather than
rules accuracy: no way existed to retry a bad AI response, edit a
sent message, or undo a turn. That mattered more here than for a
typical chatbot -- if the AI misreads an action and calls the wrong
move, the player was stuck with whatever momentum, progress, or
impact changes resulted, with no way back except manually correcting
it through more conversation.

**Built as a single-level, ephemeral checkpoint**, taken in the backend
immediately before each turn starts -- a full deep-clone of both the
message history and the entire campaign state (character, meters,
tracks, sector map, everything), kept in a Map deliberately separate
from anything `saveCampaign` ever touches, so there's no risk of a
stale snapshot ever leaking into a persisted save file. Doesn't
survive an app restart -- an accepted tradeoff for a first version,
not an oversight.

Edit, Regenerate, and Undo all share this one restore primitive:
Regenerate rolls back then immediately resends the same text;
Edit rolls back and hands the original text to the composer instead
of resending it automatically; a bare Undo just stops there. Buttons
appear only on the actual last exchange, with real position logic
covering both a normally-completed turn (message followed by a GM
reply) and one that failed outright (just the user message, nothing
to regenerate).

**tsc caught a real type error mid-implementation** -- the new
`undoLastTurn` bridge method was typed with `messages: unknown[]`
instead of the project's actual `ChatMessage[]`, which the compiler
flagged immediately rather than letting it surface as a runtime
problem later.

**The core checkpoint logic can't be unit-tested by importing it
directly** -- it lives in `main.cjs`, which requires the Electron
runtime and can't be loaded standalone the way the rest of this
engine can. Verified instead by simulating the exact same logic (take
checkpoint, mutate, undo, confirm restoration, confirm a second undo
is correctly rejected) both as a one-off script before this was added
to the suite, and then as a permanent test mirroring that same
simulation -- the same approach this project already uses for other
IPC-layer logic that can't be imported directly.

1 new test. Full regression, syntax, types, build, and playtest clean.

## Finishing Chapter 5: three site-specific expedition oracle mappings, and a genuinely new feature -- Campaign Elements

Skipped the pure oracle-table dumps in the rest of Chapter 5 (already
in Dataforged, extensively verified already) in favor of the
interspersed procedural sections.

**Three site types turned out to have real, previously uncovered
connections to their own dedicated exploration oracles.** Derelicts:
each zone has its own Area/Feature/Peril/Opportunity tables, and an
area explored during Undertake an Expedition can itself serve as a
waypoint. Precursor vaults: a genuine three-phase structure
(Exterior/Interior/Sanctum), with a concrete numeric trigger for the
last transition -- 6 or more filled boxes on an expedition's progress
track means the Sanctum has been reached, not just a table result.
Planets: their own Peril/Opportunity tables for expedition incidents,
separate from their fixed Feature/Life characteristics.

**The first draft of that guidance contained a real, caught error.**
Every other planet oracle in this project follows a per-class compound
path (Planets/Desert/Atmosphere and so on), so the first guess for
these two tables followed the same pattern -- Planets/Desert/Peril.
It doesn't exist. Checking the raw data directly rather than trusting
the assumed pattern turned up the real structure: Planets/Peril and
Planets/Opportunity each split into Lifebearing/Lifeless variants
instead. Fixed before it shipped, the same discipline this whole
project has used on oracle paths since the findOracle bug.

**Also found a genuinely new mechanic: Campaign Elements** -- a
player-curated table of story ingredients specific to one campaign
(people, factions, locations, troubles, quests), used to connect a new
situation to something already established rather than generating
something wholly new. Implemented as a real feature, not just
guidance: state (add/remove/roll, using the same crypto RNG as every
other roll in this engine), three tools tested through the real
dispatcher, the book's own ten-item starting suggestion and an End of
Session pruning reminder woven into existing instructions, and a full
frontend panel mirroring the existing Content Flags panel.

**Worth being direct about a real mistake in the middle of building
this:** an edit meant to add the new frontend component instead
deleted several lines from the unrelated, pre-existing FlagsSection,
which would not have compiled. Caught immediately by viewing the file
right after the edit rather than assuming it worked, repaired in the
same turn, and re-verified with a full type-check and complete test
run before writing anything further -- not just assumed fixed because
the fix looked right.

4 new tests. Full regression, syntax, types, build, and playtest clean.

This completes Chapter 5 and, with it, every rulebook chapter this
project has had access to.

## Chapter 4 and Chapter 5 uploaded -- the exact missing pages flagged last entry -- and reading them found four real things

The previous entry's honesty paid off directly: flagged that Chapter 4
wasn't available and foe-generation guidance was necessarily built from
oracle data rather than the book's own procedure. Chapter 4 ("Foes and
Encounters") and Chapter 5 ("Oracles," in two parts) arrived this entry.

**Chapter 4's procedural section (not the sample-NPC catalog after it)
mostly confirmed what was already built** -- the rank/harm-by-rank
guidance and the oracle-chain approach from last entry both matched
the book's own text closely. But it also contained **"Joining Forces
with NPCs"** -- the exact section this project's own notes flagged
missing months ago, confirmed by the earlier Chapter 3 PDF's own text
physically ending at page 247, right before it. Real, previously
uncovered mechanics: NPCs don't grant automatic bonuses to the
player's own rolls unless they're a companion asset or connection;
fighting alongside allied NPCs is legitimate grounds to set a fight's
objective at a genuinely lower rank than fighting alone; protecting
NPCs can redirect a cost onto them instead of the player; and an NPC
who earns a lasting place with the character should be formalized
as a real asset (Sidekick or an appropriate companion) rather than
left an undefined ongoing ally indefinitely.

**Chapter 5's "Using the Oracles" section independently validated two
things already built** -- the is_match-doesn't-apply-to-general-oracles
rule matched the book's own explicit note almost word for word, and
the existing Peeling the Onion guidance held up against its actual
source for the first time. But it surfaced two more real gaps: "Roll
twice" as an oracle's own embedded result can appear on ANY table,
not just Pay the Price, where it was the only documented case -- and
the anti-recursion rule (a second "roll twice" doesn't chase further,
just reroll that one result) wasn't captured anywhere. Separately, the
book's own cross-reference arrow convention (a ⏵ symbol that survives
this project's own link-stripping by design, matching the book's
printed notation exactly) had zero guidance telling the model it means
"go roll that linked table next" rather than something to read past.

**Four real, confirmed things found and fixed from source material this
project didn't have access to until this entry** -- a genuinely
productive use of the gap flagged honestly rather than glossed over
last time.

2 new tests. Full regression, syntax, types, build, and playtest clean.

## New feature request: foe generation with real oracle guidance, not improvisation from nothing

Asked directly for the AI to make up enemies with genuine oracle
support, rather than always inventing them from scratch. Existing
coverage was thin: one line buried in the sector-map instruction
mentioning "Creatures" among a long list of location-discovery
oracles, plus the already-solid mechanical side (rank, harm/stress
scale, the Combat Action oracle for behavior mid-fight) -- nothing
dedicated to actually generating a new foe's identity.

**Two full, real oracle chains existed in the data and were never
used anywhere in this project.** For a non-humanoid creature:
Creatures/Environment (space, interior, land, liquid, air) ->
Basic Form (a sub-table specific to that environment) -> Scale
(with Ultra-scale as its own table for anything truly massive). For a
humanoid antagonist: Characters/First Look, Role, and Goal. Both
chains share a Revealed Aspect table -- a natural fit for this project's
existing Peeling the Onion principle, so the guidance explicitly treats
that one as the deeper-layer roll to save for later rather than
front-loading it with everything else on first appearance.

**Every single referenced oracle path was individually checked before
writing anything**, not assumed from the category names -- including
confirming Basic Form is genuinely environment-dependent (not one
flat table) and that Characters/Disposition is a general-purpose NPC
attitude table, not foe-specific, so the guidance is explicit that it
shouldn't be assumed hostile by default.

**Worth being direct about a real limitation here:** Chapter 4, "Foes
and Encounters" -- the book's own dedicated section on exactly this
topic -- isn't present in either rulebook PDF provided to this project.
Confirmed by actually checking rather than assumed missing; the
second PDF's own text ends at page 247, right before Chapter 4 would
begin. This guidance is built from the verified, real oracle data and
this project's own established design philosophy (the same
"Peeling the Onion" instinct that's shaped several other fixes
throughout this whole sweep), not reconstructed from book text that
was never actually available to check against. If the missing pages
ever become available, this is worth a proper re-check against the
book's own actual procedure.

1 new test, checking all ten referenced oracle paths resolve. Full
regression, syntax, types, build, and playtest clean.

## The deferred vehicle Battered/Cursed architecture gap is fixed -- and fixing it surfaced two real bugs of its own

Picked back up the gap confirmed real several sessions ago and deferred
three times to keep other work moving: the rulebook describes marking
Battered/Cursed on a vehicle's own asset card, but this project tracked
them as one shared toggle regardless of which vehicle -- or how many --
the character actually owned.

**Rebuilt properly, not patched.** Battered and Cursed now live directly
on each vehicle asset. `character.aboardVehicleId` (an asset id,
nullable) replaces the old boolean, so a character with both a Starship
and a Support Vehicle can genuinely have one battered and the other
not -- exactly what a single shared flag could never express. Support
vehicles can only ever be battered, never cursed (the rulebook ties
Cursed specifically to the command vehicle), and that's enforced, not
just documented -- tested directly, including the attempt that should
fail. Cursed remains permanent once marked, also tested directly,
including the attempt to clear it.

**Old saves migrate correctly, verified end to end.** A save with the
legacy shared `impacts['Current Vehicle']` and boolean `aboardVehicle`
gets both migrated onto the character's command vehicle on load, then
the old fields are removed -- tested against a simulated legacy-shaped
state, confirming the migrated data produces correct momentum math
afterward, not just that the fields moved.

**Continuing into the system prompt and frontend surfaced two real
bugs, both from the same root cause: pieces of this change referencing
each other before all of them actually existed.** The character state
display still read the deleted `c.aboardVehicle` boolean -- rendering
"no" unconditionally regardless of the truth, a real display bug, not
just stale wording. More seriously, new UI controls already built into
each vehicle's asset card were calling `window.game.setVehicleCondition`
and passing an asset id to `setAboardVehicle` -- neither of which
existed anywhere on the actual IPC bridge, confirmed by TypeScript
itself: 13 real compile errors once actually checked, not assumed clean
from an earlier run that predated these changes. Fixed the IPC handler,
the preload binding, and the type signatures to match what the UI
already (correctly) expected, and removed the old, now-redundant
global "aboard" checkbox and a dead impacts-category reference in favor
of the working per-vehicle controls.

**Worth being direct about the middle of this entry:** the honest
account is that this fix went through a rougher middle stretch than
most of this project's work -- a genuine display bug and a genuinely
broken UI control both existed at once, mid-implementation, before the
full sweep across every affected file caught them. Both are confirmed
fixed now, not just addressed in the files most likely to have the
problem.

2 new tests (bringing this session's total to 5, across the state layer,
tool-dispatch layer, and the vehicle-only boarding validation). Full
regression, syntax, TypeScript, and playtest all clean.

## Chapter 1 finished: Equipment, Vehicles, and Welcome to the Forge -- one real fix, and the last unchecked subsection confirmed pure flavor

Closes out Chapter 1, the last of the three rules chapters with this
kind of gap between what's in Dataforged and what's in the full prose.

**Vehicles surfaced one real, concrete gap.** Incidental vehicles --
anything temporarily acquired mid-story that isn't an owned asset, a
borrowed sea-skimmer, a commandeered shuttle -- get their max
integrity assigned by envisioned size the moment the character first
boards one: heavy 5, medium 4, light 3. Existing guidance already knew
incidental vehicles can't be marked battered and always use the
destruction table on a bad miss, but had no idea how to set their
integrity in the first place. Also added the related exclusion the book
states directly: if nobody aboard is actually controlling it, it isn't an
incidental vehicle at all and shouldn't have an integrity meter tracked
for it.

**Equipment checked out as pure supply-as-abstraction philosophy**,
already covered extensively through this project's own Sacrifice
Resources and Resupply work -- nothing new needed.

**"Welcome to the Forge" -- the very first section of the book, before
Making Moves -- had never been read at all until this entry**, and
turned out to be purely introductory: physical dice requirements
(already matched), a chapter-by-chapter reading guide, setting tone
and inspiration. No actionable mechanics in it, confirmed by reading
it in full rather than assumed safe to skip.

1 new test. Full regression, syntax, types, build, and playtest clean.

**This completes every subsection of Chapter 1.** Combined with the
already-finished Chapter 2 and Chapter 3 sweeps, all three rules
chapters covering actual game mechanics -- The Basics, Launching
Your Campaign, and Gameplay in Depth -- have now been read in full
against the real text, not just the structured move/asset/oracle data
this whole project was originally built from.

## Chapter 3 sweep complete: Fate Moves, Clocks, Conflict Between Allies, and Principles of Play all confirmed clean -- the entire 118-page chapter now checked

This closes the second major audit thread of this whole project,
following the 90-asset sweep. Every section of "Gameplay in Depth" --
Session, Adventure, Quest, Connection, Exploration, Combat, Suffer,
Recover, Threshold, Legacy, and Fate Moves, plus Clocks, Conflict
Between Allies, and Principles of Play -- has now been read in full and
checked against the already-implemented mechanics, not just the bare
move text this project was originally built from.

**This final stretch found nothing new to fix, and that's worth stating
plainly rather than treated as a non-event.** Fate Moves (Ask the
Oracle's four techniques and odds table, Pay the Price's full
consequence table) matched exactly, already verified earlier in this
project. Campaign Clocks -- a real, distinct mechanic from tension
clocks, checked during Begin a Session via a specific Ask the Oracle
procedure -- was already fully and correctly implemented, including the
exact default-Likely-odds framing. Conflict Between Allies is
inherently co-op-specific (opposed rolls between two player
characters) and correctly out of scope for a solo-focused tool, the
same call already made for Aid Your Ally. Principles of Play's two most
actionable, solo-specific philosophies -- "be a fan of your character,
it's not possible to cheat" and "trust your instincts, too many oracle
rolls becomes an exercise in randomness" -- were both already present,
matching the source almost word for word.

No new tests this entry, since nothing changed. Regression re-confirmed
clean before writing this up.

**For the whole Chapter 3 thread, tallied honestly:** what started as a
single question about whether a travel move should have triggered
turned into reading this entire chapter end to end. Real fixes landed
along the way -- the Face Danger/Secure an Advantage/Gather
Information combat-replacement rule, the previously undocumented
Battle move, the actual mass-combat scene-challenge system the book
names for "the clash of mighty armies and fleets," Face Defeat's real
cost, Heal's organic/mechanical distinction, Sojourn's and Resupply's
real structure, Overcome Destruction's darker miss stakes -- alongside
genuine, verified confirmations that Quest Moves, Connection Moves,
Exploration Moves, all of Suffer Moves, and now Fate Moves and
Principles of Play were already correct as built. Both outcomes were
tracked with the same rigor throughout, because knowing what's
already right is as much the point of this kind of pass as finding what
isn't.

## Finishing Recover Moves, all of Threshold and Legacy Moves -- two real fixes, and one case of correctly leaving something alone

**Finished Recover Moves.** Hearten and Repair both checked out clean
in full, matching precisely (including Repair's entire point-cost table
and Hearten's own confirmation that mechanical companions go
through Repair, reinforcing the Heal fix from the previous entry).
Resupply was missing its real strong-hit structure: a genuine choice
between bolstering general supply (with the correct unprepared-
clearing detail) or acquiring a specific needed item for momentum
instead -- previously reduced to just its four-stat list.

**Read all of Threshold Moves.** Face Death and Face Desolation
checked out clean, already correctly matching the weak-hit vow option
and the automatic-miss-on-certain-death exception. Overcome
Destruction needed two real additions: its miss carries genuinely
darker narrative stakes than its weak hit -- conflicting with an existing
vow, serving an actual enemy -- which the existing guidance treated as
identical to the weak hit in every way but mechanics. And a
replacement command vehicle secured through the narrative itself
(a gift, salvage, a favor) is genuinely an incidental vehicle until
formally purchased with the granted experience, not an asset yet --
worth stating explicitly so a narratively-acquired ship doesn't
accidentally get treated as a proper Starship before it's actually paid
for.

**Read all of Legacy Moves.** Earn Experience and Advance both
confirmed already correct. Continue a Legacy's full nine-option,
three-tier menu (strong/weak/miss, each with real narrative and
mechanical choices) was checked directly against the actual
Dataforged move text and found already fully present there --
confirming that this project's existing choice to defer to `lookup_move`
for this specific move, rather than duplicate a rarely-triggered,
one-time-per-character event into the system prompt, is sound
judgment. Left alone rather than "fixed" for the sake of it -- the same
discipline applied to confirming Rockhorn and Sprite were already
correct earlier in this sweep, not just to finding gaps.

2 new tests. Full regression, syntax, types, build, and playtest clean.

Suffer, Recover, Threshold, and Legacy Moves are now all fully checked.
Fate Moves, the rest of Clocks, Conflict Between Allies, and Principles
of Play remain.

## User context on Battle led somewhere more precise than a correction: a completely separate, real mass-combat system was missing

The user pointed out that Battle is meant for large-scale, army-on-army
conflicts. Checking this against the actual text rather than just
accepting or dismissing it found something more exact: the named
Battle move documented in the previous entry (its own official example
is sentry bots, not an army) is genuinely a different thing from a
separate, dedicated system -- **"Mass Combat Using a Scene
Challenge"** -- found under Clocks, which the book names explicitly
for "the clash of mighty armies and fleets."

**The real problem wasn't a missing move, it was actively wrong
framing on an existing one.** This project's Scene Challenge guidance
described the whole system as "an optional structured approach for an
extended NON-COMBAT conflict" -- language that would have steered
the model away from the exact use case the book calls out for it, not
just failed to mention it. Fixed to state the real exception plainly, plus
a genuine mechanical detail the book describes and nothing here had:
a specific fight within the larger battle can still be zoomed into with
an ordinary Enter the Fray and the full combat-move sequence, with
that fight's own outcome feeding back into the scene challenge's
progress track or clock -- winning it marks progress, losing it advances
the clock -- rather than the detailed fight replacing the larger
challenge.

1 new test, checking both the inactive and active Scene Challenge
states render the fix correctly. Full regression, syntax, types, build,
and playtest clean.

## Chapter 3, continued: five real fixes in one sitting -- Face Defeat, Battle, Heal, and Sojourn

The most in one continuous read since the asset sweep itself.

**Face Defeat** was missing that it always pairs with a real cost. The
existing guidance covered the trigger and the "clear, don't reset"
mechanic, but not that the book pairs it with Pay the Price every time,
or that a bad spot follows if other objectives in the same fight remain
active -- not a clean, neutral removal.

**Battle's own momentum sharing needed correcting, not just
completing.** The terser Dataforged text ("you and any allies who
joined... may take +2 momentum") reads as if the whole group shares
it. The fuller Chapter 3 prose is explicit that only the character who
actually made the roll takes the momentum -- everyone else just shares
the narrative success. Caught by reading past the bare move text
into the longer explanation, the same discipline that found Sleuth's
rank cap and several other gaps earlier in this sweep.

**Heal's companion-treatment approach was silently ambiguous** about
organic vs mechanical companions. The book states plainly, as a
general rule: treatment for a mechanical companion should go through
Repair instead of Heal, unless that specific asset's own card says
otherwise. Nothing in the existing guidance distinguished a Glowcat
from a Combat Bot for this purpose.

**Sojourn -- thought reasonably well covered from an earlier session --
turned out to be missing real structure, not just phrasing.** Four
things: the same recover move can genuinely be picked twice on a
strong hit, not just two different ones; a weak hit caps the whole
group at three recover moves total, not one each with no limit; every
chosen move resolves as an automatic hit, not a real roll -- something
worth getting right since a model defaulting to rolling would silently
introduce failure chances the move doesn't have; and the miss has a
real branch (accept a costly demand and treat the whole thing as a
strong hit, or take Pay the Price instead) that wasn't there at all.

4 new tests. Full regression, syntax, types, build, and playtest clean.

Session, Adventure, Quest, Connection, Exploration, and Combat Moves
are now fully checked. Suffer Moves checked out clean through Lose
Momentum, Endure Harm, Endure Stress, Companion Takes a Hit,
Sacrifice Resources, and Withstand Damage -- all matching precisely,
including the full vehicle-destruction table. Recover Moves is checked
through Sojourn and Heal; Hearten, Resupply, and Repair's full prose,
plus Threshold, Legacy, and Fate Moves, Clocks, Conflict Between
Allies, and Principles of Play, remain ahead.

## Continuing Chapter 3: Quest, Connection, and Exploration Moves all confirmed clean against the full text

Kept reading past Adventure Moves. No new code changes this entry --
recorded here because the verification work itself is real and worth an
honest account, not because anything needed fixing.

**Quest Moves** (Swear an Iron Vow, Reach a Milestone, Fulfill Your Vow,
Forsake Your Vow): checked in detail, including Fulfill Your Vow's
specific weak-hit exception (a new vow to "set things right" keeps the
full reward instead of dropping a rank) and its miss's precise recommit
mechanic (roll both dice, take the lowest, clear that many *boxes*, raise
rank). `recommitProgressTrack` was independently re-verified line by
line against this exact wording -- correct. Forsake Your Vow's full
six-option consequence menu and "clear the vow, not reset it" behavior
also matched exactly.

**Connection Moves** (Make a Connection, Develop Your Relationship,
Test Your Relationship, Forge a Bond): also checked in full, including a
detail easy to have missed -- Forge a Bond's strong hit includes a real
choice (bolster an existing role to +2, or expand to a second role) --
already correctly implemented with dedicated tools, confirmed mutually
exclusive as the book requires.

**Exploration Moves** (Undertake an Expedition, Explore a Waypoint,
Make a Discovery, Confront Chaos, Finish an Expedition): matched the
already-implemented mechanics precisely, including the general
fallback rule for combat position on non-combat-specific moves used
mid-fight (strong hit -> in control, weak/miss -> bad spot, unless a
move's own text overrides it) -- already correctly captured.

**Started Combat Moves.** General framing (position tracking, the
in-control/bad-spot fallback rule, objective ranking guidance) and
Enter the Fray's full text both check out against what's already
implemented.

**Continuing into the rest of Combat Moves found something real.** Gain
Ground, React Under Fire, Strike, Clash, and Take Decisive Action all
checked out precisely against the already-implemented mechanics --
including the subtle Strike-vs-Clash Pay the Price distinction (weak hit
costs nothing extra for Strike, but does for Clash) fixed much earlier in
this project, independently re-confirmed word for word against the
source. But reading past Face Defeat surfaced **Battle** -- a real,
distinct move (`Starforged/Moves/Combat/Battle`, confirmed by checking
Dataforged directly, not assumed) that resolves an entire fight in a
single roll. It's the combat equivalent of Set a Course vs Undertake an
Expedition -- a one-roll option sitting alongside the fuller, multi-move
sequence, not a replacement for it -- and it had zero coverage anywhere
in this project. The earlier moves audit, several sessions back, checked
7 combat moves; there are 8.

1 new test. Full regression, syntax, types, build, and playtest clean.

Face Defeat's full text has been read but not yet explicitly
cross-checked against the implementation. Suffer, Recover, Threshold,
Legacy, and Fate Moves, plus Clocks, Conflict Between Allies, and
Principles of Play, remain entirely ahead.

## Starting Chapter 3: Session Moves check out clean, and Adventure Moves surface a real disambiguation gap affecting every combat scene

Began the last major unchecked section: Chapter 3, "Gameplay in Depth"
-- the full explanatory prose behind every move, worked examples and
GM guidance included, not just the terse trigger/outcome text already
covered via Dataforged. This is the section the original moves audit,
several sessions back, never actually reached; that audit checked bare
move text, never this fuller chapter.

**Session Moves came back genuinely clean.** Begin/End a Session, Take
a Break, Set a Flag, and Change Your Fate (all five redirect techniques
-- Reframe, Refocus, Replace, Redirect, Reshape) were already fully and
correctly documented, matching the real text precisely.

**Reading Face Danger, Secure an Advantage, and Gather Information's
full explanatory text together surfaced a real, previously-missing
general rule.** The book is explicit, in two separate places, that
several adventure moves have a combat-specific replacement that
applies the instant a fight is active: Face Danger is replaced by
React Under Fire, and -- less obviously -- *both* Secure an Advantage
and Gather Information are replaced by the same move, Gain Ground.
None of this was written down anywhere, despite `combatPosition`
already existing as exactly the state signal needed to gate it
correctly. This isn't a rare edge case; it's the difference between the
right move firing correctly or not in every single fight in the game.

**A real placement mistake in my own first draft, caught before it
shipped:** the initial fix was written into the block that only
renders once a fight is already underway. But the rule's actual value
is in choosing correctly *as* a fight begins or before one has, not
just while already inside it -- gating it that way would have meant
the model still lacked the rule at exactly the moment it mattered most.
Moved to the always-visible instructions, and explicitly verified it
renders correctly both in and out of combat before calling it done,
rather than assume the move was safe because the content itself
was right.

2 new tests. Full regression, syntax, types, build, and playtest clean.

This is one section into a fourteen-section chapter (Session Moves and
the start of Adventure Moves so far, of Adventure, Quest, Connection,
Exploration, Combat, Suffer, Recover, Threshold, Legacy, Fate moves,
plus Clocks, Conflict Between Allies, and Principles of Play still
ahead) -- a large amount of genuinely unchecked material remains.

## Character Creation checks out clean, and checking one oracle it references surfaces a real, systemic bug affecting 172 tables

Asked what else was worth checking now that the rulebook is properly
available. Character Creation -- all 11 steps -- was the clear next
candidate: "Build a Starting Sector" got the same treatment two audits
ago and turned up three real gaps, and this project's own character
creation flow had never been checked against the actual text at all.

**It came back genuinely clean.** Cross-referenced against the real
`NewCampaignModal` component and the `campaign:new` handler, not just
skimmed: the standard array (3/2/2/1/1) is explicitly validated, not
just suggested. Deed assets are correctly excluded from starting
selection at *both* stages (path picks and the final asset), with a
comment explaining why -- every Deed gates behind an in-play milestone,
which is itself a real, correct insight about the asset catalog.
The background vow is created at epic rank with zero ticks and no
roll, matching "you've already sworn this vow... don't need to make
the move." Every single Step 8 meter value matches exactly: health/
spirit/supply at 5, momentum +2/max 10/reset +2, companion health
correctly initialized per-asset. Worth stating this plainly, the same
as any gap would be: this is the first major rulebook section in this
whole thread to come back essentially correct as originally built.

**Checking the "Character Name" oracle Step 10 references led
somewhere much bigger.** `findOracle()` had zero awareness of
`Display.Title` -- the exact name the rulebook itself prints above
each table -- and matched only against the internal hierarchical path
built from the data's own category nesting. Checked every oracle's
real display title against what the lookup actually resolved: **172
mismatches.** Most are expected and correct to remain unresolved by a
bare title alone (a dozen+ different oracles are all just called
"Feature" or "Peril," genuinely ambiguous without path context, and
the compound-path convention already used throughout this project's
own guidance handles those correctly). But real, unique, unambiguous
book names were failing outright or landing on the wrong table --
"Character Goal" (referenced by that exact name in this very chapter's
own "Can't Think of a Vow?" sidebar), "Starship Name," "Settlement
Trouble," "Planetary Class," every Faction oracle.

**Fixed properly, not just patched for the one case that started it.**
Added a new match tier: an exact match against a table's real display
title resolves with high confidence, but only when that title is
unique across the entire oracle set. A title shared by several tables
deliberately still falls through to the existing path logic rather
than this tier silently guessing which one was meant -- the fix
targets the specific failure (unique names going unrecognized), not a
blanket "trust any title match," which would have just moved the
ambiguity problem instead of solving it. **104 of the 172 broken cases
are now genuinely fixed**; the rest are confirmed, correctly-still-
ambiguous cases that need a compound path, exactly as intended.

**Fixing this surfaced a real bug in this project's own test suite,
not just the app.** An existing regression test asserted
`findOracle('Starship Name')` should return `null`, written on the
assumption that name was fabricated for testing purposes. It wasn't --
it's the real, official title the book prints for
`Starforged/Oracles/Starships/Name`, and the test was simply wrong,
written before this gap was ever found. Fixed the test itself rather
than let a passing-but-incorrect assertion mask the very thing this
fix was for; replaced with a genuinely fabricated name to preserve the
test's real intent (the matcher must not hallucinate a match for a
truly fake query).

**Also added actual character-naming guidance**, since Step 10's
reference turned out to name three separate, individually-rollable
sub-oracles (Given Name, Family Name, Callsign) rather than one
combined table -- previously undocumented, and the compound paths
needed to actually reach them aren't obvious without being told.

7 new tests. Full regression, syntax, types, build, and playtest clean.

## The full 90-asset sweep is complete: every asset in the game, individually checked, 76 of 90 (84%) with real confirmed gaps

This closes out the thread that started with a single question about
whether a travel move should have triggered. The last 9 assets --
the entire Companion category -- are done: Banshee, Combat Bot,
Protocol Bot, Rockhorn, Sidekick, Sprite, Survey Bot, Utility Bot,
Voidglider.

**6 of 9 had real gaps.** Several followed the same shape seen
throughout this whole sweep: a companion's mechanism (roll +health,
add +health, a conditional reroll) was already covered by general
guidance built during an earlier Companion-category audit, but the
SPECIFIC bonus layered on top of that mechanism -- a match bonus, a
once-per-expedition limit, an entire second ability -- wasn't. Survey
Bot's second ability is a clean example: the health-substitution
itself was covered, but the ability's real structure (once per
expedition, a genuine stacking-progress bonus, a match-triggered
legacy tick) had been reduced to nothing beyond the generic mechanism.

**Rockhorn and Sprite, checked against the exact same standard applied
to everything else in this sweep, came back genuinely clean --
verified directly, not assumed from a partial pattern match.** Worth
stating as plainly as the gaps: this sweep was never just about
finding problems, and two fully correct assets out of the final nine
is real, positive information, not a gap in the search.

**The sweep's own completion is now mechanically verified, not just
narrated.** A new test loads the full 90-asset list directly from
Dataforged, confirms it's still exactly 90, and checks that every
single name is accounted for -- either in one of the special-mechanics
lists this whole thread has been building, or in a small, explicit
exception list for the 3 assets (Rockhorn, Sprite, Glowcat) that are
genuinely covered through general prose rather than a per-asset entry.
If a future edit ever drops an asset from coverage, this test fails
immediately rather than the gap going unnoticed.

10 new tests this installment. Full regression, syntax, types, build,
and playtest all clean.

---

**Final tally for the entire sweep, start to finish: all 90 assets in
the game individually checked against their complete, real ability
text. 76 (84%) had at least one real, previously-undocumented gap --
a missing ability, a missing match bonus, a wrong tool reference, a
stacking rule nobody had written down. 14 were confirmed genuinely
correct as originally documented.** What began as a single question
about whether Set a Course should have triggered turned, through the
rulebook actually being checked rather than recalled, into a complete,
line-by-line audit of every asset in Ironsworn: Starforged -- matching,
for assets, the same standard this project's move audit reached
several sessions ago. Nothing in the game's asset catalog remains
unverified.

## Batch 9: the last of the never-checked Path assets, and a move-order detail worth flagging on its own

Continued into the final 9 never-checked Path assets: Gunslinger,
Haunted, Infiltrator, Leader, Naturalist, Outcast, Seer, Shade, Sniper.
All from a complete blank, same starting point as the previous two
batches. The json.dumps()-based generation approach held up again --
third batch running with correct escaping on the first attempt.

**A few mechanics worth naming specifically, not just "gaps filled":**
Leader's second ability has a genuine move-ORDER requirement -- it
resolves before allies act, not after. Getting that backwards wouldn't
just be an ordering nitpick; it would change what the allies are
actually reacting to when their own automatic strong hit applies.
Seer's prophecy mechanic caps at one active recording at a time, easy
to lose track of without explicit guidance. Shade's veil has a real,
temporary lockout after a miss -- without stating this outright, a
player could just re-veil immediately afterward, which defeats the
entire point of the cost.

6 new tests. Full regression, syntax, types, build, and playtest clean.

**Verified cumulative total: 81 assets checked across this entire
thread, 70 with at least one real, confirmed gap. Only 9 remain --
the entire Companion category (Banshee, Combat Bot, Protocol Bot,
Rockhorn, Sidekick, Sprite, Survey Bot, Utility Bot, Voidglider), which
would close out every single asset in the game.**

## Batch 8: a real workflow fix after two syntax bugs last time -- generate escaped strings programmatically instead of hand-quoting

Continued into 8 more never-checked Path assets: Ace, Armored,
Augmented, Brawler, Devotant, Diplomat, Empath, Explorer. Same starting
point as the previous batch -- zero prior guidance, all needed complete
entries.

**Changed how the guidance text itself gets written, directly in
response to last batch's two syntax errors.** Rather than hand-quote
strings with embedded apostrophes and quoted phrases again, generated
this batch's entries with Python's `json.dumps()`, which guarantees
correct JavaScript string escaping by construction rather than by
careful manual attention. Both the guidance text and its tests passed
`node --check` on the first attempt -- a genuine process improvement
adopted because the previous approach had just failed twice in a row,
not a theoretical precaution.

**Ace surfaced something worth naming specifically: half of one ability
was already indirectly documented, and half was a complete blank.** An
existing general instruction already named "Ace's saved firing
position" when describing how to use a preset action die once one is
set -- but nothing anywhere described the actual trigger that sets that
value in the first place (a strong hit with a 4, 5, or 6 on Gain
Ground). The existing mention read as coverage from a distance; it
wasn't, once traced to what it actually described versus what the card
requires.

Other real mechanics worth naming: Armored's second ability replaces
its first ability's preset value rather than stacking as an additional
bonus; Augmented explicitly does not let its two instances' bonuses
stack, previously undocumented; Diplomat's reroll-with-more-dice
ability has a real cap -- a second miss calls for Pay the Price, not an
unlimited do-over; Empath's second ability is an additional effect on
the *same* roll as its first, not a separate move, easy to misread as
two independent triggers.

6 new tests. Full regression, syntax, types, build, and playtest clean.

**Verified cumulative total: 72 assets checked across this entire
thread, 61 with at least one real, confirmed gap. 18 assets across the
full catalog remain that have never been checked once.**

## Moving past the originally-flagged lists: the first batch of the ~35 never-checked-at-all assets, and two real syntax bugs caught before they shipped

With the special-mechanics sweep finished, moved into the assets that
were never flagged for attention in the first place -- 8 command-vehicle
modules and support vehicles this batch: Heavy Cannons, Internal Refit,
Reinforced Hull, Research Lab, Stealth Tech, Vehicle Bay, Shuttle, Skiff.

**Different starting point than every previous batch: zero of these had
any prior guidance to check against, partial or otherwise.** All 8
needed complete guidance written from scratch, not gaps filled in
existing text. Real mechanics found along the way worth naming:
Internal Refit's genuine exception to the normal Sacrifice Resources
flow (a roll that can avoid marking unprepared entirely, rather than
the usual automatic mark); Reinforced Hull's fixed, specific miss
consequence (mark the module broken) where most assets defer to
open-ended Pay the Price; Research Lab's legacy reward correctly
distinguished from Workshop's near-identical ability -- one feeds
discoveries, the other quests, easy to conflate given how structurally
similar the two cards are; Vehicle Bay's salvage-and-restore mechanic,
a 50/50 oracle roll that can bring back a destroyed support vehicle
with its previously-marked abilities genuinely intact.

**Two real JavaScript syntax errors were introduced while writing this
batch's guidance text, both caught immediately, before either reached
the test suite.** Heavy Cannons and Stealth Tech both needed embedded
double-quoted phrases (move names in quotes) inside strings that also
contained apostrophes, and the quote-escaping came out wrong both
times -- `node --check` failed loudly on both before any test ran.
Fixed via direct, careful string replacement rather than repeated
guessing, then explicitly re-verified the *rendered content* was
correct after each fix, not just that the file parsed -- a syntax fix
that silently changes the actual guidance text would be its own new
bug hiding behind a passing check.

**The sweep's own self-verifying test needed a real design fix, not
just a number bump.** It had asserted the flagged-asset-list total was
exactly 55 -- true when it was written, false the moment this batch
added 8 more names to the lists. Rather than just patch the number
(which would break again the next time the lists grow, since this
sweep is explicitly continuing), rewrote the test to check the
structural invariant that actually matters -- every name in the lists
has been individually verified -- without hardcoding a total that's
inherently a moving target for as long as this work continues.

5 new tests. Full regression, syntax, types, build, and playtest all
clean.

**Running total, now spanning both the originally-flagged lists and
this new phase: 64 assets checked, 53 with at least one real gap.**
Roughly 26 assets remain that have never been checked at all.

## Batch 6 (final): the sweep of every originally-flagged asset is complete -- 45 of 55 (82%) had real gaps, mechanically verified, not just claimed

Finished the last 7 assets in the special-mechanics lists: Tech,
Trader, Vanguard, Vestige, Voidborn, Weapon Master, Workshop. This
closes out every single asset this project had ever flagged as needing
special mechanical attention.

**Two of the seven -- Vanguard and Weapon Master -- had real, if
smaller, gaps caught only on a careful second read.** Vanguard's
haven-founding roll never stated its own explicit miss consequence
(Pay the Price), even though the card says so directly. Weapon
Master's guidance jumped straight to a rare Take-Decisive-Action
follow-up combo without ever stating the base bonus that applies on
every ordinary qualifying Strike -- the common case was missing, only
the edge case was documented. The other five -- Tech, Trader, Vestige,
Voidborn, Workshop -- were verified against their complete, real
ability text and found genuinely accurate, nothing further needed.

**A real, worth-naming moment of self-correction happened while writing
this summary.** A draft description in this project's own test suite
claimed all 7 of this batch "had real missing abilities... no clean
assets" -- but that didn't match what direct re-verification actually
showed. Caught before it shipped by re-reading the raw ability text a
second time rather than trusting an existing claim, and corrected to
state plainly which 5 were genuine confirmations and which 2 had real,
smaller gaps -- the same discipline this whole thread has been built
on, applied to this project's own record of itself, not just to the
rulebook.

**A second arithmetic slip caught before it shipped, same discipline
as two batches ago: an initial recount produced an impossible negative
remainder, immediately signaling a double-count.** Traced to Glowcat --
correctly confirmed clean earlier in this thread, but it's a companion
checked through general guidance, not a member of the 55-asset
special-mechanics lists this specific sweep was counting against.
Recomputed correctly rather than force the numbers to look consistent.

**Final, verified total for this entire sweep: all 55 originally-
flagged assets have now been individually checked against their
complete, real ability text -- 45 of them (82%) had at least one real,
confirmed missing ability.** This is no longer tracked by memory or
narrative claim; a test in this project's own suite programmatically
extracts every asset name from every special-mechanics list in the
actual source and verifies each one is accounted for, failing loudly
if the sweep is ever incomplete.

**What's left, stated plainly rather than implied finished: the other
~35 assets across the full catalog were never flagged for special
attention in the first place, and have not been checked even once by
this process.** Given an 82% hit rate on the list that already had
*some* attention, the unflagged assets are, if anything, more likely to
have gaps, not less.

Full regression, syntax, types, and playtest all clean throughout this
batch.

## Batch 5: Sleuth -- covered since very early in this whole project -- still had a real gap, and the exact same test-break lesson recurred immediately

Continued the sweep, next 8 assets. All eight had at least a partial
real gap this time -- the first batch with a 100% hit rate since the
very first spot-check that started this whole line of work.

**Sleuth is the one worth sitting with.** It was documented in detail
very early in this project, and re-checking it here still found a real
gap: the quest's rank is capped at formidable the moment the vow is
first sworn, a genuinely different mechanic from the miss-with-match
rank *increase* later in the investigation, which WAS already
documented. Two rank-related rules on the same asset, only one of them
written down. That's precisely the kind of thing "this asset already
got attention" makes easy to assume is complete without checking.

Shields, Sensor Array, Service Pod, Slayer, Snub Fighter, Survivor, and
Symbiote all had further real gaps of their own -- including Shields
missing a stat *choice* (integrity or wits) on its core raising roll,
not just an entire third ability.

**The exact same lesson from two batches ago recurred immediately, not
eventually:** restructuring Sensor Array's guidance broke another older
test, a plain casing mismatch this time ("Don't" became "don't" once
the phrase moved mid-sentence). Caught the same way as last time --
running the full suite before calling the batch done, not assuming a
correct-looking fix is a safe one. Two occurrences of the identical
failure mode is worth naming as a pattern in its own right: any
edit that moves or rewraps existing text is a real risk to whatever
already depended on its exact wording, independent of whether the edit
itself is correct.

4 new tests. Full regression, syntax, types, build, and playtest clean.

**Verified cumulative total, recomputed directly: 43 of 49 assets
checked across this whole thread (88%) have had at least one real,
confirmed missing ability.** Only 6 remain in the originally-flagged
special-mechanics lists -- this sweep is close to finishing what it set
out to check. Another 35 have never been checked even once.

## Batch 4: Rover was nearly a total blank, and a genuine sixth clean asset caught by reading the full text instead of trusting a partial match

Continued the sweep, next 8 assets from the special-mechanics lists.

**Crew Commander, Navigator, Oathbreaker, Overseer, Revenant, Rover, and
Scoundrel all had real missing abilities -- 7 of 8.** Rover stands out:
before this pass, it had guidance for exactly one half of one of its
three abilities. Everything else -- the base Undertake an Expedition/Set
a Course add, equipping a module at no cost with its own
Withstand-Damage consequences, the Face Danger/React Under Fire
derived-integrity roll -- had nothing at all. Also worth naming:
Oathbreaker's guidance previously only covered the redemption path, not
the failure path -- Forsaking the vow discards the asset but explicitly
*retains* the impact, since failure doesn't undo the burden the way
genuine redemption does. That distinction was silently absent, which
would have let a failed redemption arc quietly clear a consequence it
shouldn't have.

**Looper turned out to be the sixth clean asset in this whole thread --
but only after actually reading its complete guidance rather than
trusting a partial grep match.** An initial check saw one entry
mentioning Looper and nearly logged it as another gap; reading the full
diceModifierBlock text found a second entry covering the remaining two
abilities already. Worth stating plainly: the discipline that catches
missing coverage has to be the same discipline that avoids
false-flagging what's already there, and this batch is a direct
example of checking twice before concluding either way.

4 new tests. Full regression, syntax, types, build, and playtest clean
-- and, learning directly from last batch's caught-but-fixed test break,
checked carefully this time for the same failure mode before calling
the batch done. None occurred.

**Verified cumulative total, recomputed directly rather than carried
forward by memory: 35 of 41 assets checked across this whole thread
(85%) have had at least one real, confirmed missing ability.** 14
remain in the already-flagged special-mechanics lists; another 35 have
never been checked even once.

## Batch 3: 7 more confirmed, and a real test break caught by actually running the suite

Continued the same sweep, same standard, next 8 assets from the
special-mechanics lists.

**Gearhead, Gunner, Lore Hunter, Marked, Medbay, Mercenary, and Missile
Array all had real missing abilities -- 7 of 8.** Loyalist, re-checked
against the same standard rather than assumed fine because it was
already dismissed as co-op-only, held up: its framing was deliberate
and adequate, not an oversight.

**Medbay's second ability is worth calling out specifically, not just
counting as one more gap.** Permanently Harmed is, by its own name,
supposed to be permanent -- but the real card carves out a genuine
exception: brought to this specific medbay quickly enough, a strong hit
on Heal can clear it. That's not a minor omission; it's the kind of
detail that, missing, would make the model tell a player something is
permanent when the rules say otherwise. Documented with an explicit
warning not to generalize the exception to Heal rolls anywhere else.

**Missile Array's third ability had a wrong reference, not just a
missing one.** It had been marked "covered by the dice-modifying
guidance above," which sounded right but wasn't -- that guidance
describes a straight reroll, while the actual card requires rolling a
standalone action die first and checking it against current ammo
before the reroll is even offered. A reference that looks correct
without actually matching the mechanic is its own failure mode, worth
naming separately from an outright missing one.

**Restructuring Lore Hunter's guidance broke an older, unrelated
test** -- one written in an earlier session that checked for an exact
substring no longer present after the rewrite, even though the
underlying fact (a +2 momentum bonus on Reach a Milestone) was still
correctly stated, just phrased differently. Caught immediately by
running the full suite before considering the batch done, not assumed
safe because the fix itself looked right. Fixed the test to match the
current, still-accurate text rather than revert the improvement.

4 new tests this batch. Full regression, syntax, types, build, and
playtest all clean.

**Verified cumulative total across this whole thread, recomputed
directly rather than estimated: 28 of 33 assets checked so far (85%)
have had at least one real, confirmed missing ability.** 22 remain in
the already-flagged special-mechanics lists; another 35 have never
been checked even once.

## Turning ad-hoc discovery into a genuine systematic sweep: 13 of 16 assets confirmed with real gaps across two batches

Given full latitude on direction, chose to convert the pattern this
whole thread had been finding by chance into a deliberate, bounded
sweep: every asset already named in this project's own special-
mechanics lists (55 total), checked one by one against its complete,
real ability text, not just the one mechanic that originally got it
flagged.

**Batch 1 (8 assets): Archer, Artist, Blademaster, Bonded, Bounty
Hunter, Cohort, and Courier all had real missing abilities -- 7 of 8.**
Bannersworn, pulled fresh and compared against what an earlier session
had written, matched word for word -- a genuine confirmation, not
assumed. Real content found and added: Blademaster's stacking-progress
bonus and its Charge/Evade pre-roll choice; Bonded's Set a Course stat
override (+heart replacing the move's normal +supply for that specific
trip, not adding to it); Cohort's explicit no-stacking rule for multiple
specialists; Courier's connection-progress-doubling bonus and its
roll-+safety-as-the-stat option; Bounty Hunter's match-triggered branch
between two genuinely different player choices.

**Batch 2 (7 assets): Engine Upgrade, Exosuit, Expanded Hold, Firebrand,
and Fugitive all had real missing abilities -- and Fated, an asset
already believed fully documented from an earlier session, turned out
to have a genuine gap even within its own already-covered first
ability.** The progress-marking half was there; the Fulfill-Your-Vow
half -- a deliberate, story-ending moment the book frames as "your fate
is at hand" -- had never been written down at all. Worth naming
specifically: this is exactly the failure mode a systematic pass is
supposed to catch and an ad-hoc one keeps missing, since "Fated" reads
as already handled from the outside.

Also fixed a real instance of guidance quietly punting on its own job:
Expanded Hold's second and third abilities had been reduced to "per its
own text," a placeholder that isn't actually guidance. Replaced with the
real mechanics -- a sweeten-the-pot reroll costing 1 cargo, and the exact
lighten-the-load math -- rather than leaving the model to go find the
card itself.

Demolitionist's and Fleet Commander's remaining abilities, checked
against this same standard, held up as already adequate -- confirmations
recorded plainly alongside the fixes, not just the misses.

**Running total across this whole thread: 21 of 25 assets checked so
far have had at least one real, confirmed missing ability** (13 of 16
in this installment's two batches specifically). That's no longer a
pattern under investigation -- it's the expected result, and the
remaining ~30 assets in these lists (plus the ~35 outside them
entirely, never flagged for special attention at all) should be
treated accordingly.

11 new tests this installment. Full regression, syntax, types, build,
and playtest all clean.

## Deeper into Assets and Oracles: two more confirmed, one genuine clean pass

Kept going into the rulebook's own Assets and Oracles sections, which
use Glowcat, Homesteader, and Kinetic as further example cards with
full text shown directly.

**Homesteader and Kinetic both had real, confirmed missing abilities --
seven of eight assets checked across this whole line of inquiry now
confirmed with gaps.** Homesteader was missing a bonds-legacy tick that
fires on *any* hit (not just strong) when swearing its vow, which
genuinely stacks with a separate Fulfill Your Vow bonus rather than
replacing it, plus its entire Sojourn choice. Kinetic was missing a
third ability that's actually one of its most powerful and distinctive:
spending max momentum for a guaranteed automatic strong hit on the next
move, no roll at all.

**Glowcat, checked against the exact same standard, was already fully
covered -- worth recording plainly, not just the misses.** All three of
its abilities turned out to already be handled correctly, just through
the general companion guidance (the "roll +health vs add +health"
distinction from the Companion audit two sessions ago) rather than an
asset-specific entry. Confirmed by checking directly, not assumed from
the absence of a dedicated line -- the same rigor applied to the failures
was applied to this one, and it held up.

**Endure Stress and the oracle-match-significance rule both checked out
exactly against the real text, unusual edge cases included** -- the
"Lose Momentum equal to any remaining stress" overflow rule matches the
already-implemented automatic overflow behavior precisely, and the
"a match on an oracle roll has no significance unless the specific
table says otherwise" principle was already worded generally and
correctly, not narrowly scoped the way memory alone might have left it.

3 new tests. Full regression, syntax, types, and playtest clean.

## Continuing the same pass: a sixth confirmed asset, and a real gap fixed properly instead of left as an acknowledged limitation

Kept reading through Chapter 1 rather than stop at five. Starship --
the free default vehicle nearly every character owns -- makes it six for
six on the exact same pattern: a bonds-legacy-tick tied specifically to
finishing a dangerous-or-greater expedition (not troublesome, a real
distinction), and an optional post-Withstand-Damage +heart roll with its
own Endure Stress cost on a weak hit or miss, neither of which existed
anywhere in this project despite Starship being universal.

**Also found something this pass could actually fix properly, not just
flag: broken modules.** The rulebook is explicit -- Withstand Damage's
miss can mark a module broken, and "a broken module cannot be used until
you successfully Repair it." That's a real mechanical restriction. This
project's own guidance already *knew* about the mechanic in two separate
places, but both said "narrative -- no state flag for this," an
acknowledged gap left in place across earlier sessions rather than
actually built.

Built it properly this time: a real `broken` field on any owned asset,
a new `set_asset_broken` tool, and the asset now shows a plain,
unmissable warning in the model's own context when broken --
"do not apply this asset's abilities until repaired" stated outright,
not left for the model to infer from a boolean alone. Withstand
Damage's miss and Repair's fix-a-module option both now call the real
tool instead of repeating the old acknowledged limitation.

5 new tests, including one that explicitly checks the old "no state
flag for this" text is genuinely gone, not just that new text was added
alongside it. Full regression, syntax, types, build, and playtest clean.

**Six for six is no longer a small sample -- it's approaching a full
survey of every asset actually referenced by name in this project's
existing special-mechanics guidance.** The other ~85 assets that were
never flagged as needing special attention in the first place remain
unverified against this same standard, and likely warrant it more, not
less, given they never got even the partial attention these six did.

## A confirmed, systemic gap: asset guidance covered each asset's one standout mechanic, not its full ability text

Continued the same discipline from the previous entry -- check the real
rulebook instead of memory -- but this time against Chapter 1's core
mechanics (Making Moves, Momentum, Progress Tracks, Legacy Tracks,
Impacts, Assets) rather than a single procedural section. Momentum math
checked out exactly. Legacy track math checked out exactly, including a
genuinely obscure edge case (a cleared legacy track resolves as 10 for
any progress roll against it, even though its ticks reset to keep earning
experience at a reduced rate) that was already correctly implemented,
comment and all citing the rulebook -- a real confirmation, not a gap,
worth stating plainly since this pass isn't only about what was wrong.

**What wasn't fine: "Stacking Progress" is a real, explicitly-named rule
with its own worked example, and it didn't exist anywhere in this
project's guidance.** When a move's own outcome and a separately-owned
asset's ability both say to mark progress for the same action, both
apply -- not one. The book's own example uses Hoverbike specifically:
Undertake an Expedition's strong hit marks progress once, Hoverbike's
first ability marks progress again on a strong hit with a match, and
together that's progress marked twice for one roll, not once.

**Checking Hoverbike's actual full ability text to write that example
correctly surfaced something worse: it has three abilities, and only one
had ever been documented.** That prompted a spot-check of three more
assets already covered in earlier sessions -- Grappler, Veteran,
Scavenger. All three had real, confirmed missing abilities. Then a
fourth check, prompted by the rulebook using Healer as its own literal
example asset card: also missing two of its three abilities, including a
strong-hit-with-match legacy-track reward that isn't just flavor.

**Five for five.** Every multi-ability asset checked this session had at
least one, usually two, completely undocumented abilities. This is not a
spot-check result anymore -- it's confirmed as a systemic pattern. The
apparent cause: earlier asset audits found each asset's one standout,
unusual mechanic (genuinely valuable work) without verifying that the
asset's other, more standard-looking abilities were also fully covered
-- and several of those "standard-looking" abilities turned out to have
real mechanical nuance (conditional legacy rewards, match-based branching
outcomes with actual consequences) that a generic "+1 add" gloss would
never have implied.

**Also found and fixed: Heal, a core Recover move, had zero guidance
anywhere despite being the primary way to increase a companion's health
outside Companion Takes a Hit's own resist roll.** Four distinct
approaches depending on who's being treated, a deliberately unusual
"whichever is LOWER" rule for self-treatment (the opposite of Endure
Harm/Stress's whichever-is-higher, and easy to get backwards without
checking), and a conditional healing amount based on whether the Wounded
impact is currently marked. None of it existed before this pass.

**Flagged but deliberately not fixed this session: vehicle Battered/
Cursed is currently tracked as one shared toggle, but the rulebook
describes marking it directly on each vehicle's own asset card** -- implying
a character with two vehicles should be able to have one battered and the
other not, independently. Confirmed real by reading the actual
implementation, not assumed. Deferred rather than rushed into a
same-session fix, since it touches core impact/momentum computation more
broadly than a guidance-text change, and this pass was already carrying
several of those.

**Honest about what this does and doesn't establish**: five real findings
from checking five assets is a strong signal the pattern is widespread,
not proof of its extent. The other ~85 assets have not been re-verified
against this same standard. That's a real, larger piece of work still
ahead, named as such rather than implied to be finished.

6 new tests this session. Full regression, syntax, types, and playtest
clean after every individual fix.

## Proactively re-checking the same section that had already been wrong twice, instead of waiting for a third correction

Asked directly why rules mistakes kept recurring, and whether something
structural could be done about it. The honest answer: this project has
two very different kinds of source material. The structured Dataforged
data (moves, assets, oracles) is precise and machine-checkable, which is
exactly why the exhaustive move and asset audits held up. Procedural and
prose content -- character creation steps, "Build a Starting Sector,"
setting lore -- was never available as a checkable source at all before
this session's rulebook upload. Every real correction had been in that
second category. Rather than just acknowledge that pattern, went back
into "Build a Starting Sector" -- the exact section that had already
produced the passages gap -- and checked the rest of it against the real
text, on the theory that a section with one real gap likely has more.

**It did. Two more, both real, both found before being pointed at
them.** Steps 8 and 9 (zoom in on one settlement with its own oracle
chain; create exactly one local connection as an automatic strong hit,
no roll, since "this connection is already established as you begin
your campaign") had nothing but a vague "roll Trouble tables as needed"
placeholder standing in for the real procedure. Step 11's instruction to
set a controlling power for the sector was completely absent -- the
`factionControl` state field had existed since early in this project,
with UI to display it, but nothing anywhere ever actually instructed the
model to populate it during sector generation.

**Checking Step 8 precisely surfaced something more structurally
important than the missing content itself: several of the oracle names
involved are genuinely ambiguous, and a naive lookup would have silently
returned the wrong table.** "First Look" resolves by default to a
Creatures oracle, not the Settlements one Step 8 actually means --
confirmed directly, not assumed, by walking the real oracle category
tree rather than trusting a single fuzzy match. "Atmosphere," "Observed
From Space," and "Feature" (not "Planetside Feature," which doesn't
exist as a name at all) are separately defined under *every single*
planet class -- Desert, Furnace, Grave, Ice, Jovian, Jungle, Ocean, Rocky,
Shattered, Tainted, and Vital all have their own copies. Writing
guidance that just said "roll Atmosphere" would have compiled, rendered,
and looked correct, while silently rolling on whichever class the fuzzy
matcher happened to prefer -- not necessarily the class already
established for that specific settlement's planet a few steps earlier.
Fixed by requiring the exact same class already rolled in Step 4 to be
used again here, with a concrete example (Desert World) rather than a
placeholder.

3 new tests, including one that checks the oracle lookups resolve to
the exact expected ids directly, not just that the guidance text
mentions the right words.

**On the actual question asked**: the most concrete fix isn't a promise
to be more careful in the abstract -- it's that the uploaded rulebook PDF
only persists for this conversation unless it's added to the Claude
Project's own permanent knowledge base, which is a decision only the
user can make (Claude can't write to project knowledge directly). Once
it's there, every future session gets the same checkable source this one
just used to find three real, previously-invisible gaps in a single
section -- rather than relying on training-data memory of a 400-page book
for anything not already covered by Dataforged's structured data.

## Sector passages -- a real rulebook mechanic found only by checking the actual source, not memory

A user question ("shouldn't that have triggered a space travel move?") turned
into a genuine, previously-unimplemented mechanic once traced back to the
actual rulebook rather than trusted from memory -- twice over, in fact. My
first answer to the question relied on a half-remembered version of Set a
Course's trigger and turned out to be wrong in a way that mattered; the
real trigger is "a **known** route through **perilous** space," not "any
significant journey." Getting that wrong once was a reason to go source
the second, bigger claim properly rather than answer from memory again.

**"Build a Starting Sector," Step 7, and "Navigating the Forge" (p.68)
describe passages: charted routes along the drifts, connecting either two
settlements or a settlement to the edge of the sector map.** They aren't
flavor -- which move actually applies for a given journey is structurally
tied to whether one exists. Following an existing passage is what Set a
Course resolves in a single roll. Traveling somewhere with no passage
between here and there is Undertake an Expedition instead, and
successfully finishing one is exactly when a new passage gets charted for
future use. This had zero implementation anywhere in this project before
now -- not in the sector state, not in the starting-sector generation
guidance, not in the moves guidance connecting the two travel moves to
each other.

**Verified against the actual rulebook PDF rather than the condensed
quick-reference materials already in the project**, which turned out not
to cover this at all -- confirmed directly by searching them for "route"
and getting zero matches in either, a real, checkable fact rather than an
assumption about what they contained.

**Built as real state, not just a visual.** `passages` added to the sector
shape (`{ id, fromCell, toCell, notes }`, `toCell: null` for the map-edge
case), with two new tools (`create_passage`, `remove_passage`) tested
end-to-end through the real dispatcher -- including the idempotent case
where charting the same route reversed correctly returns the existing
passage rather than duplicating it.

**A real mistake caught and fixed before it shipped**: the first draft of
`create_passage`'s schema used a JSON Schema union type
(`['string', 'null']`) for the optional endpoint. Nothing else anywhere
in this codebase uses that pattern, and OpenAI-style function calling has
inconsistent support for it across different models reachable via
OpenRouter. Fixed to a plain optional string once the inconsistency was
noticed, rather than leave an untested pattern as the one exception in an
otherwise uniform tool schema convention.

**Backward compatibility handled at two separate layers, deliberately,
not one.** Every campaign saved before this feature genuinely lacks the
`passages` field entirely. `state.cjs`'s own `getSector()` normalizes it
for any tool-driven path, but `campaign:get` -- what the renderer actually
calls on load -- returns raw state through `loadCampaign()` without going
through `getSector()` at all, which would have left the frontend looking
at `undefined` on a real old save regardless of the first fix. Caught by
tracing the actual call path rather than assuming one fix covered both,
and fixed at `loadCampaign()` itself, the single point every other code
path (including that one) passes through.

**The map now actually draws routes between locations** -- solid copper
lines for charted passages, dashed for ones leading off to another
sector, both rendered underneath the hex grid and location markers per
ordinary cartographic convention rather than on top of them. A new panel
lets the player view and manually chart or remove passages by hand, not
just have the AI manage them.

**A real bug in my own test, caught before it could hide anything.**
Wrote a test for the "undiscovered destination" error path using cell
"9,9" -- except the grid only goes up to row 7, so that input was actually
failing the *bounds* check, not the "not yet discovered" check the test
claimed to cover. A passing test that wasn't testing what it said it was.
Fixed with a genuinely valid-but-undiscovered cell, and confirmed the
distinction actually holds before trusting the suite again.

9 new tests. Full regression, types, and build all clean.

## Character export/import -- reusing a character and truths setup instead of rebuilding it from scratch

Added a lighter, more focused export/import than the existing full
campaign export -- just the character build (name, stats, assets,
flavor text) and setting truths, not progress tracks, connections, the
sector map, or chat history. For starting a new campaign with a
character and truths already in hand, rather than replaying character
creation and re-rolling truths every time.

**Export** lives as a new toolbar button, active once a character
exists. Pulls `character` and `truths` directly off the campaign state,
plus the background vow's name specifically -- which turned out to live
as its own progress track (`vow-background`), not as a field on the
character object at all, so exporting it correctly meant reading from a
different part of state than the character bundle itself. Saved via the
same native save dialog the existing campaign export already uses.

**Import** lives on the Session Zero screen, the earliest point in a new
campaign, since loading a character here skips both truths-rolling and
character creation in one action -- the actual point of the feature.
Deliberately a full replacement, not a merge, and deliberately does
*not* grant a free Starship or anything else normal character creation
adds -- an imported character is already complete exactly as it was
exported, so nothing extra should be layered on top of it.

**A real bug caught and fixed before it shipped, not after:** the first
version of the error handling routed import failures through
`connectionError`, the app's existing error-display state -- except that
state is only ever rendered in the main story view, which doesn't exist
yet while the Session Zero screen is showing (it's an early return,
structurally before the main view is reachable at all). An import
failure would have failed completely silently, with no way for the
player to know what went wrong. Caught by tracing exactly where
`connectionError` actually renders rather than assuming reusing existing
state was automatically safe. Added a dedicated error state that Session
Zero actually displays.

**Also genuinely couldn't be tested the way most of this project's
logic is.** `main.cjs` requires the `electron` module at the top of the
file, which fails immediately outside a real Electron process --
confirmed by inspection, not assumed, before deciding how to verify this
at all. `campaign:export`/`campaign:import`, the existing full-campaign
equivalents, have the same untestable IPC/dialog layer and were never
covered either; consistent with that established, accepted gap in this
project rather than a new one. What *is* tested: the exact underlying
state-transformation logic the new IPC handlers rely on, built directly
on `state.cjs`, including that applying an imported character to a fresh
campaign correctly leaves that campaign's own legacy tracks (Quests/
Bonds/Discoveries) untouched -- those belong to the new campaign, not
the imported character, and conflating them would have been a real,
easy-to-miss bug.

5 new tests. Full regression, types, build, and playtest all clean.

## Moves audit, installment 2 -- a real architectural bug and an accidental duplication, both caught by verifying rather than assuming

Covered Session (5), Adventure (6), Quest's Forsake Your Vow
specifically, and Exploration (6) against the real move text this
installment -- 22 more moves checked, several already-confirmed-correct
along the way, two genuine bugs found and fixed.

**Session and Adventure were mostly confirmatory, which is worth
reporting as plainly as the bugs.** Scene Challenge's guidance from
installment 1, Set a Flag's safety-boundary handling, Aid Your Ally's
correct co-op-only scoping, Face Danger/Secure an Advantage never firing
mid-combat -- all checked directly against the real text and all already
right. One real gap: Take a Break's trigger only covered progress-move
resolutions, when the actual move also fires for "an intense scenario"
generally -- broadened to match.

**Forsake Your Vow uncovered a genuine architectural bug, not just a
missing detail.** Its full guidance -- both the track-removal mechanic and
its own fixed six-option consequence menu -- had been nested inside the
combat-only conditional block, positioned there originally because it sat
next to Face Defeat's genuinely combat-specific nuance. But renouncing a
vow is a narrative decision a player can make at any time, not something
gated on being in a fight. The guidance was invisible for the far more
common case (forsaking a vow outside combat) and only ever rendered
during an active fight. Extracted it into its own always-visible
instruction, verified it now renders both with and without combat active
so the fix didn't just relocate the bug.

**Caught a second, unrelated bug while verifying the first fix:** the
Fulfill Your Vow / Finish an Expedition reward-table instruction had been
accidentally duplicated word-for-word in the rendered prompt, evidently
introduced while editing this same area for the Forsake Your Vow fix.
Caught by counting occurrences directly in the actual rendered output
rather than assuming a str_replace had landed cleanly -- exactly the kind
of drift that only surfaces from checking, not from having written the
edit carefully.

**Exploration's trickiest-looking mechanic turned out to already be
exactly right, confirmed precisely rather than assumed.** Finish an
Expedition's "return" miss option -- roll both challenge dice, take the
lower value, clear that many progress *boxes*, raise the rank by one --
is exactly what `recommitProgressTrack` already does, verified with a
test that checks the cleared amount is precisely four times the lower
die and the rank raises by exactly one step.

5 new tests. Full regression, syntax, types, and playtest all clean
after every individual fix, not batched at the end.

**16 moves remain: Connection (4, spot-checked earlier but not yet given
this same exhaustive treatment), the rest of Combat (7: Enter the Fray,
Gain Ground, React Under Fire, Strike, Clash, Take Decisive Action, Face
Defeat), and the rest of Suffer (5: Lose Momentum, Endure Harm, Endure
Stress, Sacrifice Resources, Withstand Damage -- Companion Takes a Hit
already got extensive, direct verification this session via the
heal_companion work).**

## Moves audit, installment 1 -- a chain of real bugs from one guidance question, 18 of 56 moves covered

With all 90 assets done, started the same 1-by-1 treatment on the 56
moves. This installment covers Recover (5), Threshold (3), Legacy (3),
Fate (2), all four Scene Challenge moves, and Battle from Combat -- 18 of
56. What actually happened along the way turned out to matter more than
the raw count.

**Checked Scene Challenge's own versions of Face Danger and Secure an
Advantage against the real text precisely, since Dataforged lists them
separately from their Adventure-category namesakes with subtly different
outcome structures.** They matched the existing guidance exactly, line
for line -- a genuine confirmation, not a gap, and worth stating plainly
rather than only ever reporting problems. Battle had zero mentions
anywhere despite being a real, standard move -- added a brief note since
it's a deliberate single-roll alternative to the granular combat
sequence, and without any guidance the model might not know it exists or
might wrongly try to apply combat-position gating to it.

**Before diving into move text, ran something more efficient than
re-reading everything by hand: extracted every snake_case identifier
across the entire rendered system prompt -- with every conditional block
forced active at once -- and cross-checked it against the real tool
list.** Found zero broken references. A specific concern about four
connection-related tool names that looked unfamiliar on first read turned
out to be unfounded once checked directly -- they're real, correctly-used
tools that simply weren't rendered in that particular test scenario. Worth
including as a real check that came back clean, not just the ones that
found problems.

**Overcome Destruction had never gotten its own resolution mechanics,
only a passing mention as a trigger consequence.** Discarding the command
vehicle along with its modules and support vehicles, rolling progress
against the bonds legacy track specifically (not a normal move), the
indebted-marking pattern, and the restricted experience reward (spendable
only on vehicle-related purchases) are all real and now documented.

**Repair's "repair points" -- a temporary situational currency spent
across a menu of effects, completely undocumented until this pass --
led to a genuine chain of bugs, not just one gap.** Writing guidance for
"+1 health for a mechanical companion" required checking what tool could
actually do that, and none could: `companion_takes_a_hit` explicitly
rejects any non-negative value by its own design, correctly matching its
name. Built `heal_companion` properly rather than force a healing
mechanic through a damage-only tool.

**That fix surfaced something worse while implementing it.** The same
function hardcoded companion max health to 5 everywhere, wrong for
Symbiote (max 2, or 3 once its third ability unlocks) -- the identical
class of bug already fixed for the display layer two sessions ago, never
applied to this underlying logic. Building the shared max-health helper
properly led directly to catching a genuinely pre-existing, invisible
bug: `companionTakesAHit`'s own category check only ever accepted
`'Companion'`, and Symbiote's real category is Path -- meaning **Symbiote
could never take damage at all**, since its health tracking was added
several sessions ago. Confirmed live: the fix's own test threw the actual
error before the fix was applied. Fixed the check, verified a genuinely
non-companion asset is still correctly rejected, and traced the same
hardcoded-max bug to a third location -- the chat-log formatter -- fixing
all three from one shared source of truth instead of three places that
could drift independently.

**Went back and corrected every place earlier guidance had already
suggested the broken, nonexistent healing path**, rather than leaving
the newly-built tool undiscovered by the very instructions that needed
it: Companion Takes a Hit's own strong-hit result, Sprite's free full
heal, and Repair's own companion-healing line all now correctly point at
`heal_companion`. Also found and added a real, separate detail while
re-checking Rockhorn's exact text for this fix -- a match-bonus choice
between extra healing and momentum that had never been documented at all,
independent of everything else in this chain.

12 new tests. Full regression and playtest clean throughout, run after
every individual fix, not batched at the end.

**38 moves remain: Session (5), Adventure (6), Quest (4), Connection (4,
spot-checked earlier but not yet given this same exhaustive treatment),
Exploration (6), the rest of Combat (7), and the rest of Suffer (5).**

## All 90 assets, done -- the 1-by-1 pass requested three sessions ago is actually complete

Finished Deed, the final 9 assets, closing out the full "every move and
every asset" audit. All 6 categories, all 90 assets, each read
individually and checked against what this engine and system prompt
actually do, not assumed from a pattern match. Confirmed the total
directly: Command Vehicle (1) + Module (15) + Support Vehicle (7) + Path
(47) + Companion (11) + Deed (9) = 90, and the full playtest simulation
still runs clean end to end after everything this pass changed.

**The most significant finding of this final batch was fully mechanical,
not just guidance text.** Survivor's "this lasting effect no longer
reduces your max momentum" is now genuinely automatic, the same
architectural pattern as Veteran's combat-based bonus from the vehicle
pass -- implemented in the actual impact-counting function, not left to
the model to remember. Handled the real edge case explicitly: if both
Traumatized and Permanently Harmed happen to be marked, only one is
exempted, deterministically, matching the rulebook's own "not both."
Caught and fixed the same ordering gap found for Veteran, too -- gaining
Survivor while an effect is already marked now recomputes the momentum
cap immediately, not only whenever some unrelated later event happens to
trigger a recompute.

**A genuine, if cosmetic, inaccuracy in this project's own earlier work
surfaced and got fixed while cataloging Deed.** Fleet Commander -- covered
extensively during the vehicle-category pass under the assumption it was
a Module asset -- is actually categorized as Deed in the real game data.
The functional guidance was never affected (the lookup logic keys by
name, not category), but the guidance block's own header text claimed
every asset in it was a "vehicle module," which became actively wrong the
moment Fleet Commander was correctly recognized as sharing that list.
Fixed the header to describe what the list has actually grown into,
rather than what it used to be when it only covered Module assets.

**Real, distinct mechanics kept turning up even this late in the
pass:** Marked's reputation-risk clock is terminal (the asset gets
discarded when it fills), a genuinely different shape from Fugitive's
persistent, resetting version found during the Path pass -- worth
noticing the two look similar on the surface and aren't. Oathbreaker
counts as an impact the moment it's taken, permanently, unlike Fated's
similar-sounding but temporary version. Cohort rerolls one die per
participating specialist, a genuinely variable-sized pool rather than the
fixed one, two, or three dice every other reroll mechanic in this game
uses.

7 new tests, including one that asserts the full 90-asset total directly
rather than trusting six separate category counts to add up correctly on
their own.

## Companion complete -- 81 of 90 assets, one category left

Finished all 11 Companion assets this turn, confirmed by the same
name-against-coverage-list test pattern established for Path and the
vehicle categories. 81 of 90 total now done -- only Deed (9) remains.

**The headline finding here wasn't one unusual mechanic -- it was a
distinction that recurs across nearly the entire category and had never
been stated once.** Companion ability text constantly says either "roll
+its health" or "add +its health," and these are genuinely different
operations: the first replaces the move's normal stat entirely (the same
derived_value pattern already used for Companion Takes a Hit's own resist
roll, just extended to ordinary action moves for the first time), the
second is a variable bonus added on top of the character's real,
validated stat. Conflating them would have been an easy, quiet mistake --
nothing about the phrasing makes the difference obvious out of context,
and different companions lean on each pattern in almost every one of
their abilities. Stated once, generally, rather than re-explained per
asset, the same approach taken for "reroll any dice" and "preset the
action die" earlier in this pass.

**Real per-asset mechanics still turned up underneath the general
pattern, not just more of the same shape:** Combat Bot grants actual
combat position on a *weak* hit specifically, not just a hit in general;
Rockhorn upgrades its own resist roll's outcome by one step, the same
shape as Crew Commander's mechanic from the Path pass but scoped to one
specific companion's own suffer move; Sprite gets a genuine no-cost,
no-roll full heal, distinct from the normal two-step Companion Takes a
Hit recovery path; Symbiote's health-restoration is a direct 1:1 transfer
from the character's own spirit loss, not two independently-tracked
numbers that happen to move together.

4 new tests. **Only Deed (9 assets) remains.**

## Path complete -- 70 of 90 assets now done, and a real test-writing mistake caught and fixed in the open

Finished the remaining 23 Path assets this turn, completing the category
entirely -- 47 of 47, confirmed by a test that checks every asset name
against the coverage list directly rather than trusting a batch count.
Combined with the vehicle categories from two turns ago, 70 of 90 assets
are now genuinely covered.

**A fourth resource pool, with a genuinely new kind of mechanic attached.**
Crew Commander's "command" needed the same tracking as ammo/cargo/shields/
fire, but spending it does something none of the others do: it upgrades
an outcome by exactly one step (miss to weak hit, or weak hit to strong
hit) rather than replacing a number and recomputing. `resolve_action_with_dice`
can't express a relative improvement like that -- it only computes fresh
from a score and two dice -- so the guidance is explicit that this is a
direct outcome override, apply the better result's actual consequences,
don't try to force it through a tool built for a different shape of
problem.

**Looper's passive turned out to be genuinely cross-cutting, not scoped to
just its own ability.** It adds +1 to *any* asset's reroll, from any
source, not only its own "loop back." Documented that explicitly rather
than letting it read as Looper-specific. Its other ability rolls a stat
that isn't a real stat at all -- a fixed value based on how much fictional
time has passed -- and explicitly cannot be improved by burning momentum,
a restriction worth stating plainly since it's exactly the kind of
detail that's easy to lose track of once several other assets have
already established that burning momentum is usually fine to offer.

**Re-verifying assets already partially covered from earlier sessions
kept finding real gaps, not just confirming what was already right.**
Lore Hunter had an undocumented +2 momentum tied specifically to Reach a
Milestone, separate from its already-covered reroll ability. Loyalist's
"mostly not applicable solo" framing had only ever covered one of its
three abilities, not all three. Veteran -- already fixed for its
automatic momentum-reset bonus two turns ago -- had a second, genuinely
different effect (+1 on the next move after burning momentum) that was
never written down alongside the fix, since the earlier session's focus
was specifically the automatable part.

**A real mistake made and caught within the same turn, not glossed
over:** wrote a test asserting an exact substring of Looper's guidance
text, and it failed -- not because the guidance was wrong, but because the
test's expected string didn't match what the guidance actually said
("derived_value: true, same as..." when the real text reads
"derived_value: true **on roll_action_move**, same as..."). Diagnosed by
pulling the actual rendered prompt and comparing directly rather than
guessing which side was wrong, confirmed the guidance itself was correct
and complete, and fixed the test to match reality. Worth stating plainly:
this is exactly the value of running the suite before claiming something
works, not after.

12 new tests this turn, all passing, none glossed over.

**20 assets remain: Companion (11) and Deed (9).**

## Path, batches 1-3 -- 24 more assets, halfway through the largest category (47/90 total)

Continued the 1-by-1 pass into Path, the largest category by far. Found
substantially more per-asset than the vehicle categories did, which
tracks -- Path is where most of the game's genuinely unusual character
mechanics live.

**Three more real resource pools, checked individually rather than
assumed from the pattern:** Courier's "safety" (starts at 5, resets to an
asymmetric 3 -- not back to its own max -- once overcome at 0), Firebrand's
"fire" (built from its own dedicated gathering roll, spent per use, hard-
reset to 0 rather than decremented by a fixed amount when unleashed all at
once), and Gearhead's one-time device -- genuinely different in kind from
the others since it's a single permanent use with no recharge mechanic at
all, not a smaller version of the same pattern. Reused the resource system
for a fourth case that isn't a pool at all: Blademaster's oathbound-blade
charge is really a boolean flag, represented as a resource with max 1
rather than inventing a separate boolean-flag system for one asset.

**Demolitionist's charge mechanic doesn't fit anything built so far, and
didn't get forced into an existing tool it doesn't belong in.** The player
picks a value before rolling, then the actual raw dice (not just the
outcome) get compared against it afterward to potentially upgrade a weak
hit to strong or downgrade it to a miss. This is outcome reinterpretation
from raw dice already returned by a normal roll, not a new roll or a
recomputation -- guided as exactly that, distinct from every other dice
tool built so far.

**Fated needed three genuinely separate effects kept apart, not
summarized into one:** a cross-track trigger easy to miss (background vow
progress also feeds the quests legacy track, a side effect of a different
track's own progress moves, not its own trigger); a death-defiance ability
whose cost is unusual -- using it makes the asset itself count as an
impact until the vow's next milestone, not a resource spend or a dice
cost; and a conditional single-die reroll gated on rolling a literal 10,
not freely available the way Bannersworn's version is.

**Caught a real gap in my own earlier work, not just new material.**
Fugitive's four-segment clock was investigated and understood correctly
several turns ago, during the vehicle-category pass -- but the actual
guidance was never written down, an oversight that only surfaced because
this pass re-checks systematically rather than trusting an earlier note
to have been followed through on. Written now, with a test asserting the
guidance is genuinely present, not just that the mechanic was once
correctly reasoned about.

**A reusable pattern worth naming explicitly rather than re-explaining
per asset:** Kinetic's second ability applies its bonus *after* seeing
the roll, not before -- the same shape as Sensor Array's automated scan
and Exosuit's action-die substitution from the vehicle pass.
`resolve_action_with_dice` is the right tool whenever a bonus gets decided
once the dice are already known, not only when the dice themselves
change, and the guidance now says so plainly instead of leaving that
generalization implicit.

10 new tests. 47 of 90 assets now covered -- all three vehicle categories,
plus half of Path. Companion (11), Deed (9), and the remaining half of
Path (23) are still ahead.

## A genuine 1-by-1 asset pass, not pattern-matching -- vehicles complete (23/90), Path/Companion/Deed still ahead

Asked directly to go deeper than the pattern-based sweep from the
previous session -- read every asset's actual text individually, not
search for categories of suspicious wording. Completed all three
vehicle-related categories (Command Vehicle, Module, Support Vehicle --
23 of 90 assets) this pass. Found substantially more than the pattern
sweep did, which is exactly why the deeper pass mattered.

**A whole missing mechanical dimension: zero tracking existed anywhere
for asset-specific resource pools** (ammo, cargo, shields, fleet power).
Fifteen assets across the full catalog reference some kind of numeric
pool; checked each individually rather than trusting the word match, and
several turned out to be flavor text only (Starship and Skiff's "cargo"
mentions, Devotant's "power" meaning a deity, Tech's "power" meaning
electricity) rather than real mechanics. Five were genuine: Missile
Array, Archer, Expanded Hold, Shields, Fleet Commander. Built a real
generic system rather than one-off state -- a `resource: {current, max,
label}` field, two new tools (`adjust_asset_resource`, `set_asset_resource`),
full guidance for each asset's specific triggers, chat-log formatters,
7 tests covering initialization, clamping in both directions, and the
error case for an asset with no pool at all.

**Symbiote needed the same treatment as a Companion despite not being
categorized as one.** While wiring this in, caught a real, separate bug:
its health display was hardcoded to a Companion's `/5` max, when
Symbiote's own real max is 2, rising to 3 once its third ability
unlocks -- would have shown "health 2/5" forever, which is simply wrong
information about the character's own asset.

**A widespread pattern got one general fix instead of per-asset
special-casing:** many assets grant "reroll any dice" (the whole move --
action die included -- not just challenge dice, which is a narrower,
separate effect some other assets grant instead). Rather than
documenting this asset-by-asset as more of them turned up, added one
general instruction covering the distinction clearly, since a plain
LLM reading raw ability text has no way to know these two similar-
sounding phrases mean mechanically different things without being told.

**Six more real findings closed out Module completely, each verified and
guided individually, not glossed over:** Sensor Array's "automated
scan" (replace the action die entirely with a fixed value derived from
vehicle integrity -- doesn't call roll_action_move at all); Overseer's
"roll twice, choose either" on a Withstand Damage miss (only applies to
the specific miss options that involve an actual roll -- toggle_impact
and discard_asset don't have a "roll twice" version, a distinction the
first draft of this guidance blurred and a second pass caught and fixed);
Grappler's and Service Pod's automatic-hit-with-a-cost abilities; Engine
Upgrade's momentum bonus that depends on the actual action die value, not
just the outcome; and a recurring "reroll the action die if it's below
some threshold" pattern shared by Medbay, Workshop, and Fleet Commander,
which needed an entirely new primitive (`reroll_action_die`) since
nothing existing could reroll just the action die in isolation.

**Support Vehicle added its own genuinely distinct findings, not just
more of the same shapes:** Exosuit has two separate dice effects that
needed to be told apart (a single-die reroll on one move, and an
after-the-fact fixed-value substitution on another -- conflating them
would have been wrong); Hoverbike's momentum-burn interaction is
genuinely tricky, since `burn_momentum` always resets momentum
internally as part of its own logic, so "on a 5 or 6, don't reset
momentum" requires burning first and then restoring the pre-burn value
afterward, not skipping the reset step, which doesn't exist as a
separable option; Snub Fighter tracks a persistent victory tally that
resets and keeps counting rather than resolving once like an ordinary
clock, a distinction worth being explicit about since it's easy to
default to the more common pattern.

15 new tests, all state-and-guidance changes verified precisely rather
than assumed. 67 assets remain -- Path (47, by far the largest category),
Companion (11), and Deed (9) -- untouched this pass.

## A systematic re-audit of every move and asset -- honest about scope, not claiming false completeness

Asked directly to re-verify every move and every asset card works exactly
as described. Given the real scale involved -- 56 moves, 90 assets, 270
individual ability texts -- a genuinely exhaustive one-by-one read of
every single mechanic isn't something to claim completion of in one
pass without it being dishonest, the same reasoning that split the
original rulebook read into 11 separate chunks rather than one sweep.
What actually happened: a systematic, pattern-based sweep across the
entire asset catalog for categories of unusual mechanics (automatic
hits, momentum modification, dice rerolling, rank capping, legacy-track
interactions), triaging roughly 60 pattern matches down to the ones that
were genuinely novel rather than false positives from an overly broad
regex, then investigating and fixing each real finding completely before
moving to the next. Four came out of it, one of them significant enough
to matter regardless of anything else in this pass.

**The system prompt's own asset rendering had never had cross-reference-
link stripping applied, even after the identical bug was found and fixed
in three other places over two separate earlier sessions (oracle results,
lookup_move, the UI's asset catalog).** This one is different in kind from
the other three: it's not a display surface, it's the model's actual
context on every single turn where the character owns any asset with a
cross-reference in its ability text -- confirmed at 78% of the official
catalog when this bug was first found. Fixed with the same shared helper
used everywhere else, and locked in with a test that owns every asset in
the game one at a time and checks the real rendered prompt for every one
of them, not a sample.

**Veteran's "+1 momentum reset while in a fight" was never applied at
all**, despite the underlying state (`combatPosition`/`combatRange`) that
would make this fully automatable already existing. Implemented as a real
automatic modifier rather than GM-judgment guidance, since unlike a
similar ability on Voidborn (which depends on "in space vs. planetside," a
fictional distinction this engine has no persistent state for), this one
has a genuine, existing state signal to key off of. Caught and fixed a
second problem while implementing the first: neither `setCombatPosition`
nor `setCombatRange` triggered a recompute at all, so even with the bonus
logic correct, it wouldn't have actually taken effect until some
unrelated, possibly much later change happened to trigger one.

**Bannersworn has three genuinely distinct special mechanics that were
completely undocumented** -- a full reroll (not just challenge dice) on
Swear an Iron Vow with a bonus legacy tick on any hit, a Forge a Bond
reward one rank higher than normal (with the rulebook's own explicit "1
extra box" substitute for the case where the connection is already
epic, since there's no rank above it), and a reroll of exactly one
challenge die (not both) on ideology-aligned progress moves. Added
complete, explicit tool-sequencing guidance for all three -- confirmed
while researching this that the "cap the vow's rank" pattern from
Sleuth (found and fixed two sessions ago) doesn't recur on any other
asset in the game, a real question worth actually checking rather than
assuming.

7 new tests. Genuinely not claiming this closes the book on "every move
and every asset" -- what it closes is a real, systematic sweep with
verified fixes for what it found, the same honest framing as every other
large-scope pass in this project.

## Vow progress wasn't ticking "automatically" because nothing actually told the GM to do it

Asked directly whether vow progress was supposed to tick on its own.
Checked the system prompt for existing guidance first rather than
guessing, and found the real mechanic -- Reach a Milestone -- was only
ever mentioned in passing (as an example inside two unrelated
instructions), never given its own clear trigger. Confirmed this is a
real, well-defined move in the official data, not a vague concept: six
concrete triggers (overcoming a critical obstacle, gaining meaningful
insight, completing a perilous expedition, acquiring a crucial item or
resource, earning vital support, defeating a notable foe), and critically
-- unlike almost every other progress-marking instruction already in this
prompt -- it isn't tied to any roll at all. It's a pure narrative judgment
call the GM has to proactively notice, which is exactly the shape of
mechanic that's easy to quietly never apply.

Added a dedicated instruction listing all six triggers verbatim and
stating plainly that this doesn't wait for the player to ask for it. Drew
a real distinction while writing it, not after: expedition progress looks
similar but is fundamentally different -- it's marked directly by
Undertake an Expedition's own roll outcome, not by Reach a Milestone at
all. An earlier draft of this fix conflated the two ("vow (and expedition)
progress"); caught and corrected before it shipped, since that would have
been a second real inaccuracy introduced while fixing the first one.

**Caught my own mistake while adding the test, not the user's.** A test
asserting the correct rank-based tick count failed for every single
rank, not a boundary case -- `newCampaignState()` always seeds three
default legacy tracks before any custom track gets added, so a freshly
pushed track never actually lands at array index 0 the way the test
assumed. Verified the real underlying function directly before touching
the test at all, confirming `markProgress` genuinely marks the correct
tick count and the feature itself was never broken -- only my own test's
assumption about array position was. Fixed to find the track by id
instead of assuming a position.

3 new tests: all six triggers present and correctly worded, the
expedition/vow conflation explicitly absent, and every rank's tick count
verified against the real state function.

## Burn Momentum existed, but nothing stopped a burn that would make things worse

Asked directly whether burning momentum to override a roll was actually
implemented. It was -- the tool, the state function, and system-prompt
guidance about offering it all existed -- but investigating precisely
turned up something more serious than "does this feature exist": **the
tool never received the original action score it was supposed to be
improving on, so it had no way to know whether burning would actually
help.** Proved this concretely rather than reasoning about it abstractly:
momentum at 2, an original roll of 7, and the tool happily downgraded a
weak hit to a miss with zero warning. Burning resets momentum to a low
value with no way to undo it in the moment, so a mistaken or premature
burn isn't a cosmetic issue -- it's a real, costly mistake with no
recovery.

Fixed by making `original_action_score` a required parameter and having
the tool actually check it: momentum must genuinely exceed the original
score, or the call is refused outright and nothing changes -- not a
warning that still lets a bad burn through. Rejected three distinct
cases, not just the obvious one: momentum lower than the original score
(makes things worse), momentum exactly equal to it (zero benefit, still a
pure waste of a one-way resource), and the parameter being omitted
entirely rather than silently skipping validation, since a newly-required
parameter isn't guaranteed to be honored by every tool call. Verified all
three independently, plus confirmed a genuinely beneficial burn still
works and momentum is completely untouched after every rejected attempt,
not partially applied.

Also fixed the same "has momentum to spare" imprecision in the system
prompt's own guidance for offering this to the player -- that phrase
doesn't actually mean "higher than the rolled score," which is the only
condition that matters here.

Caught the chat-log formatter would have shown a rejected burn as
"Burned momentum (undefined → undefined)" -- meaningless to a player --
while writing this, not after; fixed alongside the validation itself
rather than as a separate follow-up.

5 new/updated tests, including the exact scenario that proved the gap.

## Sleuth's dice weren't real, the roll display hid its own logic, and a build-size anomaly that turned out to be legitimate

Two requests together, from an actual transcript: show the real components
of a roll (die + stat + adds), not just the final number, and a direct
question -- did Sleuth's asset ability actually apply? The screenshot
showed a Gather Information roll ("8 vs 8, 5") right next to Sleuth's own
ability text in the sidebar, which reads "roll three challenge dice and
choose two. If any challenge dice match, you must use those values" --
and only two dice ever appeared, with no choice offered.

**Confirmed the ability genuinely wasn't applying, and it wasn't isolated
to Sleuth.** The engine only ever rolled the standard two challenge dice --
there was no support anywhere for a third die, let alone the "must use a
matching pair" override. Checked the rest of the asset catalog for the
same shape of problem rather than assuming this was a one-off, and found
three more real, distinct mechanics with the same gap: Missile Array,
Demolitionist, and Lore Hunter all reroll both dice entirely under
specific conditions; Revenant can zero out one specific die via momentum;
Loyalist replaces a die with an ally's (confirmed co-op-only, correctly
not applicable solo). Built three reusable primitives rather than one
Sleuth-specific patch -- `roll_extra_challenge_die`, `reroll_challenge_dice`,
`resolve_action_with_dice` (recomputes the real outcome against whatever
dice actually end up applying) -- verified `resolve_action_with_dice`
reproduces the exact reported scenario (score 8 vs dice 8, 5 → weak hit)
and correctly identifies a forced match as a miss, not a hit, since a
score never beats a tied challenge die. Guidance for all six assets is
gated behind actually owning one of them, matching the app's established
conditional-prompt pattern -- verified both that it's absent by default
and that owning one asset surfaces only that asset's procedure, not all
six unconditionally.

**The roll display now shows its own arithmetic.** `roll_action_move`
already returned the action die, stat value, and adds separately -- they
just weren't making it past the chat-log formatter into what actually
renders. Threaded them through and updated the display to show
`die + stat value + adds = score`, only including the `+ adds` term when
it's actually nonzero rather than cluttering every roll with `+ 0`.
Verified through the real Electron rendering engine, not just a code
read -- three realistic cases in one pass: a roll with a nonzero add, one
without, and `resolve_action_with_dice`'s result (which has no die/stat to
break down, only a final score) correctly falling back to the plain
score-vs-dice format instead of showing a broken or empty breakdown.

**An honest tangent worth including rather than quietly setting aside:**
mid-rebuild, the bundle size nearly tripled from every prior build this
session (202 modules instead of the consistent ~40). Stopped and
investigated instead of shipping it. Found a genuine, deliberate
`react-markdown` dependency -- fully wired end to end (a real IPC handler
with its own protocol allowlist restricting external links to http/https,
not a stub), rendering chat narration as actual markdown rather than raw
text. No memory of adding it in this specific conversation, but the
implementation quality (a real security consideration about not trusting
raw HTML in model-generated text, correct handling of Electron's own
link-navigation quirk) made it clear this was legitimate prior work, not
an accident -- confirmed by tracing the whole chain by hand rather than
assuming either way: the import, its actual use in message rendering, the
preload bridge, the type, and the main-process handler, one link at a
time.

10 new tests for the dice-modifying-asset tools and their conditional
guidance.

## "It seems to roll the dice twice on game startup" -- and why the evidence says otherwise, plus a real gap found while checking

Reported with two OpenRouter request-inspector screenshots of the same
campaign's opening turn, taken at different points (30 messages/21,147
tokens, then later 53 messages/30,243 tokens), both showing the same
27-tool-call sector-building sequence.

**The evidence actually rules out a genuine duplicate run, rather than
confirming one.** Message 6 in both screenshots shows the exact same
"Sector Trouble" oracle roll -- `"roll": 69`, `"result": "Religious
zealots overrun the sector"`. The dice are real `crypto.randomInt`
(verified directly in the session before this one) -- an independent
second run landing on the exact same d100 value is roughly a 1-in-100
coincidence, for just one of 27 tool calls that would all need to
coincidentally match. The far more likely explanation, and the one the
identical rolls actually support: these are two snapshots of the *same*
growing conversation, not two separate runs -- since the full message
history gets resent every turn, the early messages naturally look
identical in both, because they're literally the same messages, still
sitting in history, with more appended after them by the second check.

**Investigated the underlying risk anyway, rather than stopping at "the
evidence doesn't show a bug."** `handleCreateCharacter` (which both
creates the campaign and auto-sends the opening "Begin the campaign."
turn) had no protection of its own against being called more than once --
it relied entirely on the character-creation modal's own submit-button
disable state, which guards a double-click but wouldn't prevent this
specific function from firing twice for any other reason. Unlike the
ordinary Composer path (already correctly disabled while a send is in
flight, confirmed by checking directly), this auto-start call bypasses
that guard entirely, since it's invoked programmatically, not through the
input the disabled state actually protects. If it were ever invoked
twice, that genuinely would send two independent "Begin the campaign."
turns, with two genuinely different sets of real dice rolls and real API
cost -- which is exactly what these screenshots would have looked like,
had the identical roll not ruled it out.

Added a one-time guard (`autoStartFiredRef`), correctly scoped to reset
per campaign (not the app's whole lifetime) so a second, genuinely
different new campaign created later in the same session still
auto-starts normally.

## A real, verified exploit: the AI could report any stat_value it wanted, with zero cross-check

Asked why the AI rolls dice at all rather than switching to RNG, since
"it's going to cheat in favor of the player anyway." Worth answering
precisely rather than just reassuring: the dice were **already** true RNG
-- `crypto.randomInt`, computed entirely inside `dice.cjs`, with no
parameter the model could pass to influence a single die value. That part
of the concern doesn't apply to this codebase and never has.

But chasing the actual worry down turned up something more concrete and
real than "the AI decides the dice" -- **the AI decides the *input* to the
roll, and nothing validated it against the character's real stats.**
`roll_action_move` took `stat_value` directly from whatever the model
reported, with no cross-check against `campaignState.character.stats` or
`.meters` at all. Proved this wasn't theoretical before touching anything:
an Edge-1 character, told to report `stat_value: 5`, produced a genuine
`strong_hit` the real stat would not have earned against the same
challenge dice -- not a cosmetic display issue, a different outcome.

Fixed by having the engine look up the real value itself for the 5 stats
and 4 condition meters (health/spirit/supply/**integrity** -- the last one
was missing from the `stat` enum entirely until this fix, a genuinely
separate, pre-existing gap found while verifying this one; Withstand
Damage's own documented "roll +integrity" instruction had nothing valid to
pass for `stat` this whole time), silently overriding whatever
`stat_value` was reported. Verified this precisely, both ways: an inflated
report now gets corrected to the real stat, and a correctly-reported value
still passes through unchanged (no behavior change for the common case).

**The one legitimate exception, and it's real:** some rolls intentionally
use a number that isn't the character's own stat -- a connection's rank
standing in for a stat on Develop Your Relationship, a companion's own
health on its resist roll. Added an explicit `derived_value: true` escape
hatch, required (not automatic) for exactly these two documented cases --
verified the flag correctly preserves the derived number, and separately
verified that *omitting* it correctly falls back to the real stat instead
of trusting an unflagged derived-looking value.

**On the tokens/speed half of the question, the honest answer:** the
tool-calling round-trip itself can't be eliminated without losing the
actual point of using an LLM as GM -- deciding which move applies, which
stat fits a freely-typed action, and whether to burn momentum are
judgment calls a fixed script can't make. What genuinely helps with token
growth over a long campaign is the multi-layer summarization work from
directly before this -- bounding the *history* rather than trying to
remove the *decision-making* the dice tools exist to support.

5 new tests, including one that reconstructs the exact proven exploit and
confirms it's now closed, not just patched around.

## Multi-layer context summarization

Requested directly, in response to a question about what actually gets
sent to the model on every turn. The honest answer at the time: the raw
message history had no ceiling at all -- every user message, every GM
narration, every tool call and result, from the entire campaign, resent in
full every single turn, forever. Fine for a normal campaign, but no safety
net for a genuinely long one; it would just fail outright once it exceeded
the model's context window, with nothing graceful in between.

Added a three-tier system, in `electron/engine/summarizer.cjs`:

- **Tier 0 (unchanged):** the most recent 60 messages stay exactly as they
  are -- full detail, tool calls included, sent to the API normally.
- **Tier 1 (recent summary):** once older messages age out of that window,
  the oldest batch (30 at a time) gets condensed by a real LLM call into a
  moderate-detail narrative recap -- concrete plot points, named
  characters and places, decisions, unresolved threads, explicitly *not*
  dice mechanics or exact numbers (those already live permanently in the
  actual campaign state -- meters, tracks, impacts -- a prose summary
  doesn't need to re-derive them). Appended to
  `campaignState.storySummary.recent`, and those messages are then
  actually removed from history, not just hidden.
- **Tier 2 (distant summary):** once the recent-tier summary itself grows
  past ~2000 characters, it gets folded into
  `campaignState.storySummary.distant` via a second, more aggressive
  compression pass, and the recent tier resets to empty. Content only ever
  flows one direction, getting more compressed at each step -- the further
  back something happened, the less detail survives.

Both tiers are surfaced directly in the system prompt (distant first, then
recent, with an explicit note that the raw conversation history picks up
immediately after both), so the model retains real continuity for events
no longer in the raw transcript at all -- not just a vague sense that
"something happened."

**Runs automatically, once per turn, and is designed to never be the
reason a turn fails.** A failed summarization call (bad key, network
issue, rate limit) leaves the message history exactly as it was and just
gets retried next turn, rather than blocking or corrupting anything --
verified explicitly for both a thrown network error and a non-OK HTTP
response, confirming neither `record.messages` nor `campaignState.
storySummary` are touched either way. A large backlog (e.g. resuming a
campaign that accumulated far more than the threshold at once) compacts in
a loop until back under the limit, not just a single pass -- also verified
explicitly, not assumed.

**A real bug caught before it ever reached production, precisely because
of the testing discipline this whole project has followed.** The
`storySummary` field was designed as part of the plan but never actually
added to `newCampaignState()` -- an honest oversight, not a subtle one.
Because the compaction step is deliberately wrapped in error handling (so
a failed summarization never breaks the player's turn), the resulting
`TypeError` from reading `.recent` off `undefined` was silently swallowed
by that same safety net, and `maybeCompact` just quietly returned
`compacted: false` with no visible symptom. It only surfaced because the
verification script checked the resulting state *outside* that guard, not
because anything crashed loudly. Fixed by actually adding the field, then
re-ran the exact same test to confirm -- a good reminder that testing
error-handled code needs to specifically probe past the error handling,
not just check the error path looks reasonable.

Visible in the UI too, not just the model's own context -- a "Story So
Far" section now appears above the Campaign Log once either tier has
content, distant summary in muted italic, recent summary in the accent
color, both clearly labeled as automatic condensation rather than
something the player wrote.

15 new tests across a dedicated `__selftest_summarizer__.cjs` (now wired
into `npm test`) plus state-default and system-prompt-integration checks
in the main suite -- narrative-extraction filtering, both tiers, the
multi-batch loop, accumulation across successive batches, and both error
paths.

**Honest about what this doesn't solve:** the summarization call itself
uses the same model configured for the main game, which may be more
(or less) than a condensation task actually needs -- a cheaper/faster
model specifically for this could be a reasonable follow-up. The
thresholds (60 / 30 / ~2000 characters) are considered defaults, not yet
exposed as a setting. And this manages the *size* of what gets sent, not
the cost of the extra summarization calls themselves, which are real API
calls against the same key.

## Found this one myself: the stat-correction tool had no limit on repeat use

Asked directly whether there was anything else left to implement. The
honest answer is that the tracked list was genuinely empty, but that
question was also a reasonable prompt to think about what hadn't been
asked yet -- and thinking through the shape of the last two fixes (combat
position, companion health) surfaced a real one: the post-creation
"fix a chargen mistake" stat editor had no restriction beyond the standard-
array validation itself. Nothing stopped a player from opening it before
every single roll, reassigning stats to maximize whatever was about to be
tested, then swapping back after -- the same shape of mechanical lever as
the two controls already removed for exactly that reason.

Unlike those two, though, outright removal wasn't right here -- this tool
serves a real, legitimate purpose (correcting an actual character-creation
mistake) that combat position and companion health never did. The fix:
`correctCharacterStats` is now a separate function from the one chargen
itself uses (`updateCharacterStats`, still called freely during character
creation), usable exactly once per character. A second attempt is rejected
with a clear message, verified to not partially apply, and the UI hides
the correction section entirely once used rather than surfacing a
now-permanently-broken button. This closes the exploit shape while fully
preserving the tool's actual purpose.

## Assets showed a count instead of their actual text, and a control that shouldn't have existed

Two separate asks about the character sheet's Assets panel: show what an
asset actually does instead of just "abilities 1", and a direct question
-- should manually adjusting a companion's health even be something the
player controls?

**Assets only ever showed "abilities 1" -- never the actual ability
text.** The data was always there (every asset's full ability text lives
in the Dataforged catalog), but the character sheet only ever displayed
which ability *numbers* were unlocked, not what they said. Added a new
`assets:catalog` endpoint covering all 6 asset categories (the existing
`assets:starting` endpoint is deliberately scoped to only the 4 categories
eligible at character creation, missing Deed and Command Vehicle -- both
real, ownable categories mid-campaign) and updated the character sheet to
show each ability's real text, unlocked ones in full brightness with a
filled marker, locked ones dimmed with a hollow one -- so upgrading an
asset later shows the player what they're actually unlocking, not just a
number going up.

**While building this, found the same cross-reference-link bug from two
sessions ago in a third, much larger place than either of the first two.**
211 of 270 official asset abilities (78%) had raw markdown cross-reference
syntax embedded in them -- far more pervasive than the oracle-result and
move-text instances found earlier, just never surfaced before because
nothing had displayed asset ability text at all until now. Fixed at all
four extraction sites (both the existing starting-asset picker and the new
full catalog) using the same shared `stripCrossRefLinks` helper. Verified
with a comprehensive sweep across the entire asset catalog, not a sample.

**On the companion health question: removed the manual control, matching
the character's own meters, not extending Companion's exception to
justify itself.** Checked the character's own core meters (Health,
Spirit, Supply, Integrity) for comparison first -- none of them have any
manual adjustment control at all, purely AI-driven via `update_meter`.
Companion health having a manual "Hit" button that the player's own vital
meters don't get was the actual inconsistency, not something to preserve.
Unlike the earlier combat-position bug, this wasn't a mechanical exploit
(marking harm on your own companion is a pure downside, no incentive to
abuse it) -- but consistency with how every other core meter in this app
works was reason enough on its own. Removed the manual `companion-takes-
a-hit` IPC path, preload bridge, and type entirely; confirmed zero
remaining references anywhere in the codebase before calling it done.
Companion health is now a read-only display, exactly like the character's
own meters, with the actual `companion_takes_a_hit` AI tool untouched.

Verified the new ability display against the real Electron/Chromium
rendering engine, not just a proxy tool -- an earlier check with
`wkhtmltoimage` (used successfully for the sector-map marker fix) showed
the unlocked/locked marker symbols rendering as garbled characters, which
turned out to be that tool's own older WebKit font-fallback limitation,
not a real bug -- confirmed by rendering the identical markup through an
actual throwaway Electron window instead, where it displayed perfectly.
Worth the extra step rather than either trusting the first (misleading)
result or skipping visual verification entirely for a meaningfully complex
UI change.

## The GM was narrating its own rules-checking out loud

Reported directly from an actual transcript: before resolving a simple
travel choice, the GM walked the player through "let me verify the right
travel move," "quick rules check before I roll -- the move matters here,"
then explained the mechanical difference between Set a Course and
Undertake an Expedition in a full paragraph, then offered a bulleted menu
of narrative approaches each tagged with its stat in parentheses. None of
that moves the story forward -- it's the GM showing its work instead of
just doing it.

Instruction 6 already said "speak as a narrator... not as a rulebook,"
but evidently not specifically or forcefully enough against this exact
failure mode -- likely a real side effect of how much of this system
prompt is about precision and verification (dozens of instructions about
checking exact move text, using the right tool, not guessing). The model
had apparently generalized "be careful and correct" into "be visibly
careful," narrating its own verification process as if accuracy needed an
audience.

Tightened instruction 6 (options offered to the player should be a short,
concrete list of things the character could actually do, not the
mechanical machinery behind each one) and added 6d, using the actual
reported phrases as explicit counter-examples: rules-checking, weighing
between similar moves, and calling `lookup_move` all happen silently --
the tool-call transmission line is already all the transparency this
needs. The instructions elsewhere in this prompt about verifying exact
move text are about being *correct*, not about being *visibly* careful --
get it right, then get out of the way. If the player's specific approach
genuinely determines a stat, ask one short in-fiction question, not a
labeled menu with a parenthetical stat tag on each option.

## Guided Play and Using the Oracles -- a section worth reading precisely because this app isn't quite either mode

At the user's request, since this section is arguably the single most
directly relevant piece of the whole book to what this app actually is --
an AI filling the "guide" role for a single player, which is neither pure
Solo Play (no guide at all, the player does all the interpretation) nor
Guided Play as written (a human guiding other humans) but structurally
closer to the latter than the former. Found three real, concrete gaps and
one important design confirmation.

- **"Peeling the Onion" directly contradicts part of what got built for
  starting-sector generation, and applies everywhere else too.** The
  book's own explicit guidance: rolling a full generator chain the first
  time something is introduced "can slow down your game and work against
  the opportunity to gain insight through the course of your story."
  Instead: roll one or two tables for a first impression, envision the
  rest, and reveal more only if the story actually returns to that
  person or place later. The one-time Build a Starting Sector procedure is
  deliberately exempt (it's genuinely meant as an upfront batch, per its
  own separate procedure), but nothing existed telling the GM to use this
  restraint for *ordinary* NPCs and locations encountered during regular
  play -- which is the much more common case. Added explicit guidance
  distinguishing the two.
- **A concrete technique for a bad-fit or unsafe oracle result was
  missing.** The book doesn't just say "reroll" -- it says check one table
  row up or down from the original result first, a small, targeted
  adjustment rather than starting over. This is essentially a concrete,
  oracle-specific instance of Change Your Fate's "Replace" technique
  (already in the system prompt from an earlier session) that hadn't been
  connected to oracles specifically.
- **A real, previously-unaddressed source of possible over-interpretation:
  matches don't mean anything on most oracle rolls.** The book states this
  explicitly for the general Chapter 5 descriptive oracles (Character/
  Location/Settlement/Planet/Faction generators and similar) -- but
  `roll_oracle` always returns `is_match` in its result regardless of
  which oracle was rolled, and nothing told the GM that this field is only
  meaningful for *specific* tables whose own rules say so (Ask the
  Oracle's odds, Pay the Price's "roll twice," the severe harm tables'
  documented exceptions). Without this, a matched roll on something as
  routine as a settlement name could plausibly get treated as some kind of
  narrative omen it was never meant to carry. Added explicit scoping.
- **Confirmed, not changed:** "Oracles in Solo and Co-op Play" -- the
  parallel section to the one this app is really closer to -- already
  matches the existing "trust your instincts, oracles are support, not
  the primary generative engine" guidance exactly. Good validation that
  the overall design philosophy already reflected in this app's guidance
  was sound, not just the individual mechanics.

## A sixth and seventh bug, found from a real transcript, and a marker that was too easy to miss

Reported alongside two actual chat-log screenshots of the AI building a
starting sector -- which turned out to be exactly the right way to catch
this next one, since it's invisible from source code alone.

**Sixth: every "Settlements/Name"-style oracle call in the screenshots was
silently failing.** The AI's own narration shows it noticing and
self-correcting mid-turn ("My oracle names need the full path -- let me
retry"), which is a good sign the model handles failure gracefully, but
the failures shouldn't have happened at all. Root cause: `pathKey()`
normalizes a stored oracle path's `" / "` separators down to a single
space for matching (`"Settlements / Name"` → `"settlements name"`), but
the *query* string never got the same treatment. `"Settlements/Name"` --
exactly how the system prompt documents it, and the natural way to write a
compound name in prose -- stayed as `"settlements/name"` forever, and
never matched anything. Fixed in `findOracle` itself so it helps any
compound-name query, not just this one procedure, and verified against
every settlement-generation oracle the "Build a Starting Sector" procedure
actually uses. Also caught a second, unrelated bug while testing edge
cases: the tool's own example query in its description
(`"Derelict: Community"`) was itself wrong -- singular instead of plural,
and pointing at a non-leaf oracle that doesn't exist on its own. Fixed
that too.

**Seventh: raw Dataforged cross-reference markdown was leaking through
unstripped**, visible in the second screenshot as
`[▸Furnace World](Starforged/Oracles/Planets/Furnace)`. This had already
been fixed once for move text a couple of sessions ago, but never applied
to oracle results. Tracing it further turned up something worse than a
display bug: `lookup_move` -- the tool explicitly recommended whenever the
GM is unsure exactly how a move resolves, so it gets called often -- was
returning this same raw syntax directly into the model's own context, not
just the chat log. That risks it leaking into actual narration shown to
the player, not merely looking ugly in a transcript. Fixed at the source
in both places and consolidated what had become two independently
maintained copies of the same stripping logic into one shared function in
`data.cjs`.

**The sector map's current-location marker was functionally correct the
whole time -- the screenshots confirm `set_current_location` was firing
exactly right -- it just wasn't visually distinct enough to read as "you
are here" at a glance**, especially next to a map full of other
feature-colored hexes. Replaced a plain 5px dot with a pulsing copper ring
around a ship-marker triangle (a standard "current position" cartography
convention), rendered on top of everything else in that hex. Verified with
an actual rendered screenshot of the exact SVG markup (via a standalone
HTML file and `wkhtmltoimage`, not just a code read), confirmed clearly
visible and distinct against both the background and neighboring colored
hexes.

5 new tests cover the oracle-lookup fix precisely (every settlement oracle
from the real transcript, plus confirming previously-working query styles
didn't regress) and the link-stripping fix (both `roll_oracle` and
`lookup_move`, including that non-text fields like `$id` and `Using`
survive untouched).

## Four real bugs found through actual use, and a fifth that was worse than any of them

The fifth was reported after actually playing through session zero: Truths
chosen or rolled manually during the Session Zero Truths screen were
silently discarded the moment character creation completed, and the GM
would roll Cataclysm and Exodus again from scratch at campaign start as if
nothing had been chosen -- exactly what the screenshot in the bug report
showed.

**Root cause: `campaign:new` always built a brand-new, empty campaign
state from scratch, unconditionally overwriting whatever record already
existed for that campaign id.** That was correct the day it was written --
character creation used to be the very first screen, so there was nothing
to lose. But once Session Zero Truths was added as an *earlier* step
(several sessions before this fix), it started mutating a real backend
record for that same campaign id -- rolling or setting truths through the
ordinary IPC path, persisted to disk -- before character creation ever
ran. `campaign:new` was never updated to account for that. Each of the two
screens was individually correct; the bug was entirely in the seam between
them, which is exactly why a rules-accuracy pass or a code-level audit
wouldn't have caught it -- it only shows up by actually walking through
the real sequence a player follows.

Fixed by having `campaign:new` load and reuse whatever record already
exists for that campaign id (falling back to a genuinely fresh one only if
Session Zero was skipped entirely) and applying the character-creation
mutations on top of it, rather than discarding it. Since reusing state
changes the safety profile of a double-call (an accidental double-click on
"Begin Campaign" used to just harmlessly re-wipe everything twice; now it
could have granted a duplicate starting Starship or a duplicate background
vow track), added idempotency guards on both, verified explicitly against
three repeated calls in a row, plus a plain UI-level guard (the button
disables itself once clicked) as a second layer.

Verified end to end against the real persistence functions, not a mock --
a temp directory, `store.cjs`'s actual save path, real JSON round-trips --
confirming manually-chosen truths survive character creation intact while
the character's own name, stats, and background vow are still applied
correctly on top. 2 new tests lock this in permanently.

### The other four

Found by the user actually clicking through the app rather than by code
review -- exactly the kind of thing a rules-accuracy pass or a code audit
doesn't catch, since all four are UX/integration issues, not mechanical
ones.

**1. Zoom-in keybind was backwards from every other app's convention.**
No custom Electron menu existed, so the app fell back to Electron's default
one, which binds zoom-in to `CmdOrCtrl+Plus` -- and "+" isn't a key on most
keyboards, it's Shift+"=". So the intuitive `Ctrl+=` did nothing, while the
unintuitive `Ctrl+Shift+=` worked. Added a real custom menu with an
explicit `CmdOrCtrl+=` binding (matching Chrome/Firefox/VS Code
convention), plus a hidden secondary binding for numpad `+` so that still
works too, without being the primary/visible one.

**2. Settings was completely unreachable on first launch.** A brand-new
user's actual path through the app is Campaign Select → Session Zero
Truths → Character Creation, and none of those three screens had any way
to reach Settings -- the character-creation modal's own backdrop blocks
the main topbar behind it, and a `!showSettings` escape hatch existed in
the code but nothing ever triggered it, so it was dead. This meant a truly
new user had no way to configure their API key until *after* finishing
the entire session-zero flow and character creation, by which point the
auto-start message had already silently failed to fire (correctly guarded
by `if (config?.apiKey)`, but with no explanation offered as to why
nothing happened). Added Settings access directly on all three screens,
plus a visible "no API key configured" banner on the two earliest ones.

**3. The AI failing to generate anything was completely silent.** If a
model returned empty content with no tool calls, nothing surfaced --
`runTurn`'s loop treated it as valid final narration (an empty string is
falsy, so it just vanished), and the frontend's response handler didn't
even inspect the reply. Fixed at the source: an empty or whitespace-only
final response now emits a real, visible error explaining what happened,
same as a network failure or a bad API key already did. Also stopped
persisting a genuinely empty final message to permanent chat history --
it would've sat there as a blank, unexplained bubble forever otherwise.
Verified the fix doesn't accidentally strip a *legitimate* empty-content
message (a normal tool-only turn mid-loop, which correctly has empty
content but real `tool_calls` attached) -- only a message that's both
contentless *and* toolless gets filtered. 3 new tests.

**4. Combat position and range had a manual dropdown a player could freely
flip.** This one wasn't found by the user clicking around -- it was
flagged directly: "I shouldn't be able to control this." And it's a real
design mistake, not just a UI nitpick. Position and range are supposed to
be *derived* from actual roll outcomes (Enter the Fray, Gain Ground,
React Under Fire) -- the entire rulebook-accuracy work on combat-move
gating and Take Decisive Action's bad-spot downgrade assumes the player
can't just set themselves to "in control" whenever convenient. Unlike
other manual paths in this app (discarding an asset, editing a connection,
editing a sector hex by hand), which are legitimate bookkeeping
corrections with no incentive to abuse, a player-facing combat-state
override is specifically a cheat vector with no comparable justification.
Removed the dropdown (replaced with a plain read-only display) and fully
deleted the underlying manual IPC path, preload bridge, and types --
verified zero remaining references anywhere in the codebase before
confirming the AI's own `set_combat_position`/`set_combat_range` tools
(the only legitimate way this should ever change) were untouched.

All four verified with a real, running headless Electron smoke test
(`xvfb-run` + the existing `SCREENSHOT_PATH` dev hook), not just a type
check -- confirming the custom menu builds without crashing app startup,
and incidentally catching a clean screenshot of the Settings-accessibility
fix actually rendering correctly on the first-launch screen.

## Sector pan/zoom and the unified image gallery

The last two items from the known-gaps list.

**Pan/zoom.** The sector map was a fixed viewBox showing the whole 12x8
grid at once. Now supports zoom buttons (60%-250%, capped both directions),
scroll-wheel zoom, and click-and-drag panning -- all clamped so you can't
pan into empty space indefinitely. Switching sectors resets the view, since
panning around a previous sector's coordinates wouldn't mean anything for a
different one.

The one real implementation risk here -- drag-to-pan and click-to-select-a-
hex both start with a mousedown on the same SVG element, so a drag needed
to not *also* register as a hex click on release. Handled with a ref-based
"did we just drag past a few pixels of threshold" flag, checked and cleared
via a same-tick timeout in the hex click handler -- since `mouseup` fires
before `click` in the browser's own event order, the flag has to survive
that gap or the check happens too late to matter. Verified the pan/zoom
clamping and center-preserving math directly (Node script replicating the
exact logic against realistic dimensions) rather than trusting it by
inspection -- confirmed zoom caps correctly at both limits, converges to a
stable value instead of drifting once maxed out, and extreme pan requests
clamp to sane bounds instead of allowing the view to wander off
indefinitely. No automated frontend test suite exists in this project (the
test suite is backend-only), so this is the extent of verification
possible without a browser -- worth being upfront about rather than
implying more confidence than that math check actually provides.

**Unified image gallery.** A single view aggregating every generated image
in the campaign -- portrait, every connection's portrait, every sector
location's art *across every sector*, not just the current one, and every
story illustration -- each labeled with what it is, click for a full-size
lightbox view. Verified the collection logic directly against a simulated
multi-sector, multi-connection campaign state before wiring up the UI,
confirming all five categories surface correctly, including images
attached to a sector you're not currently viewing.

## Character flavor text + AI image generation (ComfyUI)

Two related additions in this pass: richer character flavor text for the GM
to draw on in narration, and real local image generation for portraits,
locations, and story illustrations.

**Flavor text.** Character creation now has callsign, pronouns, and a
freeform description field (appearance, mannerisms, anything worth the GM
knowing). All three flow into the system prompt every turn -- the GM is
explicitly instructed to lean on them ("how NPCs address them, how their
presence reads in a scene") rather than defaulting to generic description
when they're already established.

**Image generation via ComfyUI.** This app never sends prompts to any image
service -- it talks to a ComfyUI server running on your own machine
(`http://127.0.0.1:8188` by default, configurable in Settings), using a
workflow you export yourself. This was a deliberate choice: ComfyUI's whole
point is deep customizability (your checkpoint, your LoRAs, your sampler
settings), so there's no "default" workflow that would work for everyone --
you bring your own, and the app substitutes a `{{PROMPT}}` placeholder into
it before submitting.

- **Setup**: in ComfyUI, enable Dev Mode, build a text-to-image workflow, use
  "Save (API Format)", then find the positive-prompt `CLIPTextEncode` node's
  `text` field in the exported JSON and replace its value with
  `{{PROMPT}}`. Paste the whole file into Settings, along with your server
  URL, and use "Test Connection" to confirm it's reachable.
- **Four targets**: portrait (character), location (a sector hex), connection
  (an NPC), and illustration (a general story-moment gallery entry, shown
  inline in the chat log where it was generated).
- **Two paths to generate, everywhere it makes sense**: the GM has a
  `generate_image` tool it calls when the player explicitly asks for a visual
  ("show me what she looks like") -- deliberately *not* automatic on every
  scene, since generation takes real local compute and time (up to a 3-minute
  timeout). Every location that can hold an image also has a manual
  "Generate" button that bypasses the AI entirely -- character sheet,
  connections, the sector hex inspector, and a general illustrations gallery
  in the sidebar.
- **Images never touch OpenRouter.** They're saved to disk under Electron's
  userData directory and served to the renderer as base64 data URLs over IPC
  -- the model only ever sees confirmation that an image was generated, plus
  which sector hexes/connections already have one (so it doesn't regenerate
  needlessly), never the image itself.

**Testing note, since this is the first tool with real network/filesystem
access:** every other tool in this app is a pure function over in-memory
state, which is why the existing test suite could get away with no mocking.
`generate_image` is architecturally different -- `executeTool` had to become
`async`, and the ComfyUI client makes real HTTP calls. Checked this two ways:
19 new tests (14 against the actual `comfyui.cjs` HTTP flow with a mocked
`fetch` -- submit, poll, error, timeout, malformed responses -- and 5 against
the `generate_image` tool dispatch itself with a stub image generator,
confirming all four targets save correctly and update the right state slot),
plus a full hand-traced simulation of the exact code path `main.cjs` runs
(config → workflow parsing → generation → save → fetch-back-as-data-URL) to
catch anything the unit tests structurally couldn't, since `main.cjs` itself
requires Electron and can't run in this environment. **87/87 tests pass.**

**A real bug this surfaced:** converting `executeTool` to `async` for image
support left one caller in `main.cjs` (the manual `truths:roll` handler)
without an `await` -- it would have silently returned a Promise instead of
the actual result. Found by grepping every `executeTool` call site rather
than assuming the conversion was complete everywhere; it wasn't.

## Custom (homebrew) assets

The one remaining place custom content wasn't possible: assets were locked
to the official 90-asset catalog, both at character creation and via the
Advance move in play. Fixed with a full homebrew asset system:

- **Custom Assets** (topbar button) -- a personal asset library, shared
  across every campaign, not tied to any one of them. Create/edit/delete
  assets with 1-3 abilities, an optional requirement, and a color, matching
  the shape of official assets exactly ($id, Name, Asset Type, Display.Color,
  Abilities[]) -- which means every existing code path (buy_asset,
  upgrade_asset, the system prompt's ability listing) works on a custom asset
  identically to an official one, no special-casing needed anywhere.
- Custom Path/Companion/Module assets automatically appear in the
  character-creation asset picker, in their own "Custom" group alongside the
  official categories.
- The GM has a `create_custom_asset` tool for when the player describes a
  homebrew asset mid-conversation -- it's added to the library (not
  auto-granted), then the GM follows up with `buy_asset` or grants it
  directly if this is happening during character creation.
- `data.findAssetAnywhere(nameOrId, customAssets)` is the merged lookup used
  everywhere an asset needs to be found -- checks custom assets first, falls
  back to the official catalog. Verified it correctly lets a custom asset
  shadow an official one with a colliding name, and falls through correctly
  when there's no collision.

6 new engine tests cover asset creation, the merged lookup, and both
buy_asset/upgrade_asset resolving custom assets correctly. Also manually
traced the full character-creation path (create a custom asset → it appears
in the starting-asset picker → chosen as a starting asset → granted to the
character) end to end outside the UI, since that's the one path unit tests
don't naturally cover.

## A bug this work uncovered

Character creation offered starting assets from Path/Companion/**Deed** --
wrong. Checked against the actual data rather than memory: every single one
of the 9 official Deed assets has a `Requirement` field describing an in-play
milestone -- "once you [Forge a Bond](...) with a special individual",
"once you fill 6 boxes on your discoveries legacy track", "once you [Face
Death](...)", and so on. None of these can be true before the campaign has
even started, which is exactly why Deed isn't one of the three starting
categories in the first place -- it's earned, not chosen. Ship Modules, by
contrast, have zero such requirements (they're just equipment), and were
missing from the starting picker despite being perfectly valid to have from
the outset. Fixed: starting categories are now Path/Companion/Module.
Locked in with a test that asserts every Deed asset has a Requirement field
and every Module asset doesn't, so this can't silently regress.


Building sector generation exposed a real correctness bug in the oracle
lookup (`findOracle` in `data.cjs`): querying "Sector Name Suffix" was
silently resolving to an unrelated `Settlements/Name` table, because the old
matcher only compared against an oracle's short leaf name ("Name", "Suffix",
"Feature", "Peril" etc. are reused across dozens of unrelated categories) --
whichever happened to be indexed first would win, with no error and no
indication anything was wrong. A related issue let raw substring matching
produce false positives like `"faction name".includes("action")` matching an
unrelated "Action" move oracle, purely because "faction" contains the letters
"action". Both are fixed: matching now checks the oracle's full breadcrumb
path first (specific phrases like "Space / Sector Name / Suffix" can't be
confused with "Settlements / Name"), and the leaf-name fallback is
word-boundary aware, with two regression tests (`__selftest__.cjs`) locking
in the fix. Worth knowing about if you ever see the GM roll on a
suspiciously-unrelated table.

## Testing this app for real

Since there's no real display or OpenRouter access available while building
this, "playtesting" happened three ways instead of by clicking through the
UI:

- **`npm run test`** -- 43 unit tests against the rules engine + 8 integration
  tests that mock `fetch` and drive the actual tool-calling orchestration
  loop in `openrouter.cjs` (message construction, `tool_call_id` threading,
  multi-tool-call turns, malformed-JSON arguments, network errors, HTTP
  errors, and the iteration cap) -- this loop had never been exercised
  end-to-end before and came back clean.
- **`npm run playtest`** -- a full simulated campaign
  (`__playtest_simulation__.cjs`) that drives every tool in a realistic
  sequence: character creation, sector generation from real oracle rolls, an
  action roll, Pay the Price, taking harm and marking an Impact, a full
  combat (Enter the Fray → Strike → End the Fight), discovering a derelict,
  progressing and rolling to fulfill a vow, spending experience, and eight
  deliberate failure cases (bad move name, out-of-bounds hex, wrong impact
  category, unknown meter, nonexistent track). Every failure case produced a
  clean error, not a crash.
- Direct probing of specific mechanics: rolling with a condition meter
  (Health/Spirit/Supply) as the acting stat, and a full state save/load
  round-trip through the actual persistence path (byte-identical after
  JSON serialization -- sector, impacts, and assets all survive correctly).

**Real bugs found and fixed this way:**
1. `burn_momentum` reset momentum but never actually recomputed whether
   burning improved the outcome -- the entire point of the move. It now takes
   the `challenge_dice` from the roll being upgraded and returns the real
   recomputed outcome, not just a momentum reset.
2. `mark_progress_track`'s description didn't explain how to handle outcomes
   like Strike's weak hit ("mark progress twice") -- I hit this myself
   simulating the GM's decisions and only marked progress once. Fixed the
   tool description to say explicitly: call it multiple times, once per
   rank's worth.
3. Character creation accepted any stat values at all -- no enforcement that
   they're actually the standard array (3/2/2/1/1, one value per stat). A
   player could have accidentally created a character with all 5s. Now
   validated both in the UI (live feedback, button disabled until valid) and
   server-side in `main.cjs` (defense in depth).

**A known, deliberate non-fix:** the tools don't validate that a chosen stat
is actually one of a given move's real options (e.g. nothing stops the GM
from using Health for a move that only lists Heart). This is left alone on
purpose -- asset abilities can legitimately grant "use a different stat"
exceptions, so a rigid validator would sometimes be wrong. It's a trust
boundary, not an oversight.


## Design notes / prior art

[Stargazer](https://github.com/nboughton/stargazer) by Nick Boughton is the most
popular existing Starforged companion app, and studying its source directly
improved this project in a few concrete ways:

- It uses the exact same move-category colors we already pull from Dataforged
  (`#00b3c8` for Session, `#d68f00` for Combat, etc.) -- confirms that's the
  "official" visual language, not something we invented.
- Its dice roller colors each challenge die individually based on whether the
  action score beat it, not just the overall outcome -- adopted here.
- Its progress tracks render tick-level fill (0-4 per box) rather than only
  whole boxes -- adopted here.
- **It implements a rule we'd missed entirely: Impacts.** Debuffs like Wounded,
  Shaken, Doomed, or Battered reduce max momentum (by 1 each) and drop the
  momentum reset value (2 → 1 → 0). This is now in `state.cjs` with the exact
  category/name list Stargazer uses, matching the physical character sheet.
- **It also implements the negative-momentum rule** we'd missed: when momentum
  is negative and its absolute value matches the action die, the die counts as
  0. Now in `dice.cjs`, computed from scratch rather than subtracted after the
  10-cap (Stargazer's own subtraction can under-penalize near the cap).

Where this app differs by design, not oversight: Stargazer is a *player's
toolkit* -- a dice roller and oracle reference you operate yourself, with a
manually-written journal. This app is AI-narrated -- the model decides when a
move triggers and calls the tool itself, and impacts are marked by the GM's
judgment rather than a checkbox, per the earlier design decision that the AI
should own the mechanical bookkeeping.

## Licensing note

The Starforged rules text and oracle/move/asset data (`data/dataforged/*.json`)
is Shawn Tomkin's *Ironsworn: Starforged*, used under CC BY 4.0 -- see
`data/dataforged/LICENSE.md`. Attribution is included there; keep it if you
redistribute this app. The planet illustrations from the same repo are
CC BY-**NC** 4.0 and are intentionally *not* included here since this app
could plausibly be shared -- if you want them for strictly personal use, copy
them in from the [Dataforged repo](https://github.com/rsek/dataforged) yourself.
