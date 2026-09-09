# Architecture

## Process boundaries

The React renderer talks only to named APIs exposed by `electron/preload.cjs`. The main process validates every IPC payload, serializes campaign mutations by campaign ID, and owns filesystem and network access.

The main subsystems are:

- `electron/engine/state.cjs`: campaign mechanics and state transitions
- `electron/engine/tools.cjs`: model-callable tool schemas and handlers
- `electron/engine/transaction.cjs`: atomic AI turns and mutation queues
- `electron/engine/store.cjs`: campaign/config persistence and recovery
- `electron/engine/imageStore.cjs`: generated-image storage, references, and collection
- `electron/engine/debugLog.cjs`: bounded diagnostic-log storage
- `electron/engine/ipcBoundary.cjs`: validation and mutation-serialization adapter
- `electron/engine/openrouter.cjs`: bounded provider loop
- `src/`: isolated React renderer

## Campaign writes

Campaign records carry a revision. A save serializes and validates the full record, writes and flushes a sibling temporary file, preserves the prior valid primary as one backup, and atomically renames the new file. A malformed primary is restored from its backup on load; the malformed bytes are retained as a diagnostic copy where possible.

## Image lifecycle

Images are immutable files referenced by opaque IDs. Campaign duplication shares those references. Generation attaches a new ID only after target validation; a failed attachment or save immediately deletes the new file. After replacement, deletion, campaign deletion, and successful AI image turns, the collector scans every loaded and persisted campaign. Collection fails closed if any campaign cannot be read.

## Trust boundaries

Imports, configuration, identifiers, strings, and payload sizes are validated in the main process. OpenRouter and ComfyUI calls have request and operation budgets. ComfyUI is restricted to HTTP(S) loopback origins and returned images require the expected PNG shape and size.

