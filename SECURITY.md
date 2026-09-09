# Security and privacy

Please report suspected vulnerabilities privately to the repository owner rather than opening a public issue with exploit details.

## Sensitive local data

- The OpenRouter API key is encrypted through Electron `safeStorage` when operating-system encryption is available and is never returned to the renderer.
- Campaign saves contain the player's story and game state.
- Opt-in debug logs contain full prompts, tool calls/results, and narration. They may include the entire private campaign context. Logs rotate at 5 MB, retain at most four files per campaign, expire after 30 days, and can be exported or cleared from Settings.
- Best-effort filesystem permissions restrict debug logs and generated images to the current user; filesystem and operating-system policy remain authoritative.

Do not attach debug logs to public issues without reviewing and redacting their contents.

