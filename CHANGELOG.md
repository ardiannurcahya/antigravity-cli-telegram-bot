# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-07

### Added
- **Voice I/O Capabilities (Speech-to-Text & Text-to-Speech)**: Complete native voice interaction with pluggable adapters, strictly opt-in by default (`STT_PROVIDER=none`, `TTS_MODE=off`):
  - **Speech-to-Text (STT)**: Transcribes inbound Telegram voice notes into prompt text using `gemini` (cloud audio buffer), `whisper-local` (offline local whisper CLI), or `agy` (multimodal CLI transcription). Includes interactive `/stt` settings keyboard and language selection.
  - **Text-to-Speech (TTS)**: Synthesizes responses into native Telegram voice notes using `edge-tts` with natural code indicator replacement. Includes `/tts` configuration and flexible response modes (`auto`, `voice-and-text`, `voice-only`).
- **Per-Session Workspace Scoping (`/workspace`)**:
  - Dynamically switch working directories per session with `/workspace <name|path>` or `/workspace clear`.
  - **Forum Topics Binding**: Dedicated project topics persistently bind to their target repository across `/new` resets.
  - **1:1 DM Ephemeral Reset (Option A)**: Private chats automatically revert to default `AGY_WORKSPACE` on `/new` to preserve friction-free daily assistant workflows.
  - **Interactive Project Picker**: Paginated inline keyboard listing available project directories.
  - **Security Boundary**: Strict `isWithin` path containment against authorized root directories to prevent directory traversal.
- **Expandable Delegation Blockquotes**:
  - Automatically isolates intermediate subagent execution turns into native Telegram `<blockquote expandable>` above the final response in `verbose: detailed` mode, while cleanly omitting them in `compact` mode.

### Fixed
- **Nested Code Fence Rendering**: Correctly parses nested code blocks (e.g. internal code fences within Markdown documentation blocks) using CommonMark fence length and nesting depth tracking.
- **Brace Stripping in LaTeX Math**: Preserved object and TypeScript type curly braces (`{}`) in regular text by targeting only actual LaTeX command argument blocks.
- **Word-Boundary Chunk Splitting**: Slices long messages on whitespace boundaries instead of cutting words in half when line breaks are absent.

## [0.4.0] - 2026-09-03

### Added
- **Telegram Forum Topics (Supergroup Threads)**: Full isolation and routing for Telegram forum topics using composite session keys (`chat_id:message_thread_id`). Outbound messages, photos, documents, and chat actions route directly to the active topic thread.
- **Multimodal Payload Ingestion**: Comprehensive handling and metadata extraction for:
  - **Voice Notes & Audio**: Downloaded with duration, artist, and track title metadata injected into the prompt context.
  - **Video & Video Notes**: Ingested with resolution and duration parameters.
  - **Locations & Venues**: Synthesizes geographic coordinates, venue names, and street addresses directly into AGY prompts.
  - **vCard Contacts**: Parses contact name and phone number, saving `.vcf` attachment references.
- **Concurrent Multi-Chat Job Queue (`maxConcurrent: 4`)**: The job queue now processes up to 4 distinct chats/topics concurrently while strictly maintaining FIFO sequential ordering per individual chat.
- **Gemini 3.8 Flash Models**: Added `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, and `gemini-3.8-flash-low` with 1,000,000 token context window support, aligned with AGY CLI 1.1.25.
- **Uncompressed Image Document Support**: Detects uncompressed image uploads sent as documents/files (`image/*`, `.png`, `.jpg`, `.webp`) and flows them directly into `imagePath` for vision model analysis.
- **Scoped Temporary Directory Management**: Media and upload downloads are now isolated in dedicated session folders (`tempDir/chat_${chatId}`) with automated purging on `/new` and automatic cleanup for stale files (>24 hours).
- **Expanded Top-Level AGY Commands**: Added `mic-serve`, `mcp`, and `models` to recognized AGY CLI commands.

### Changed
- **Session Settings Preservation on `/new`**: Starting a new session (`/new` or `action:new`) clears conversation history while preserving user-selected models, effort, sandbox mode, and preferences.
- **Deprecated Model Cleanup**: Removed obsolete Gemini 3.5 variants (`gemini-3.5-flash-*`) from `DEFAULT_MODELS` to match latest AGY CLI specifications.
- **Test Suite Isolation**: Added `envFile` configuration to prevent local test runner executions from touching or mutating host configuration files.

### Fixed
- **Clean Markdown Deep-Link Rendering**: Fixed Telegram entity parser for `conversation://` and `file:///` URLs to render cleanly as inline code (`<code>...</code>`) without unwanted backtick artifacts.
- **Freeform `/agy` Prompt Execution**: Automatically prepends `--print` when typing freeform questions directly via `/agy <prompt>` instead of throwing command syntax errors.
- **Dynamic SQLite Loading**: Implemented graceful dynamic loading for `node:sqlite` to enhance cross-environment runtime resilience.

## [0.3.1] - 2026-08-23

### Added
- **Clean Modular Architecture**: Decomposed monolithic codebase into clean, maintainable domain layers (`domain/`, `infra/`, `router/`, `telegram/`, `ui/`, and `usecases/`).
- **Comprehensive Test Suite**: Added 120 automated unit, smoke, router, and resilience tests with 100% pass coverage.
- **Instance Lock Mechanism**: Prevents concurrent duplicate bot instances on the same host using atomic PID file locking.
- **IPv4-First DNS Resolution**: Forces `ipv4first` result order to eliminate 10–15s connection delays to `api.telegram.org` on hosts without native IPv6 routing.
- **Continuous 4s Typing Indicator**: Stable typing heartbeat ensuring Telegram's status indicator remains active throughout long model thinking turns.

### Security
- **Advanced SSRF Protection**: Bitwise 128-bit IPv6 CIDR validation (blocking ULA `fc00::/7`, link-local `fe80::/10`, site-local `fec0::/10`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`), IPv4-mapped IPv6, decimal/hex IP encodings, and DNS pre-resolution.
- **HTTP Redirect Blocking**: Web media fetcher now strictly uses `redirect: "manual"` and rejects 3xx redirects to prevent SSRF bypasses to internal/cloud metadata services.
- **Strict Path Segment Boundary Containment**: Replaced loose string prefix checks with `path.relative` containment (`isWithin`) across workspace, temp, and brain artifact directories.
- **Secret Stripping from Child Env**: Telegram bot token and secrets are scrubbed before spawning AGY child processes.
- **Conversation UUID Validation**: Verifies conversation IDs match standard UUID format before accessing artifact directories.
- **Permission Safety Defaults**: `AGY_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS` now defaults to `false` in code, requiring explicit opt-in via environment configuration.

### Fixed
- **Critical Polling Offset Advancement**: Fixed dynamic offset tracking in the long polling loop to prevent infinite replay loops on commands like `/new`.
- **Telegram Rate-Limit & 429 Resilience**: Added non-blocking error handling and exponential backoff for Telegram API rate limits.
- **Session Header & Response Separation**: Progress header strictly displays step tickers and token usage breakdowns, while final AI responses are sent in a separate clean chat bubble.
- **Timer Race Condition Cleanup**: Background progress update timers are immediately cleared upon job completion, preventing completed summaries from being overwritten by stale progress text.
- **Zero-Loss Auto-Interrupt**: Under `TELEGRAM_AUTO_INTERRUPT`, multiple queued prompts are merged and preserved rather than silently discarded.
- **Document Upload Cleanup**: Uploaded documents are automatically cleaned up in `finally` blocks after processing to prevent disk space accumulation.

## [0.2.0] - 2026-08-21

### Added
- **Configurable progress mode** (`TELEGRAM_PROGRESS_MODE`): `full` (default), `compact` (single-line summary), or `delete` (remove progress message on completion)
- **Configurable verbose levels** (`TELEGRAM_VERBOSE` / `/verbose` command): `detailed`, `compact`, `silent` — controls step-by-step visibility during AGY execution
- **Dynamic model fetching**: bot calls `agy models` on startup and parses available models; falls back to `DEFAULT_MODELS` if unavailable
- **Media auto-delivery**: auto-detect and send images/files referenced in AGY responses
  - Local file paths (markdown image embeds, `file:///` paths)
  - Immich photo previews (requires `IMMICH_URL` + `IMMICH_KEY` env vars)
  - Public web images with SSRF protection (blocks private/loopback IPs)
  - Automatic temp file cleanup after sending
- **Auto-detect & send generated images**: scans conversation artifact directory for images created during the current job turn
- **In-flight job tracking**: persists active jobs to state file; notifies users on restart if their job was interrupted
- **Restart/update notifications**: pending notices are saved to disk and delivered after service restart
- **New commands**: `/update` (git pull + build + restart), `/restart` (service restart), `/learn` (derive rules from conversation), `/verbose` (change verbosity)
- **Atomic default settings persistence**: `persistDefaultSettings` writes to `.env` via temp file + rename to prevent corruption
- **Markdown table rendering**: converts GitHub-flavored markdown tables to aligned monospace codeblocks in Telegram
- **Rich step progress with emojis**: contextual icons for commands, file reads, edits, web searches, URL fetches, file searches, subagents, and thinking steps
- **Typing keepalive**: sends `typing` chat action every 4s during job execution
- **Heartbeat timer**: updates progress message every 2.5s when AGY is idle (no events received)

### Changed
- **`/cancel` enhanced**: now aborts both prompt and custom AGY controllers, with improved cancellation feedback message
- **AbortSignal support**: `runAgy` now accepts and propagates `AbortSignal` for fast cancellation
- **SIGKILL hard termination**: instant process group kill on cancel to prevent stuck processes
- **Session reset preserves settings**: `resetSession` now keeps user settings instead of wiping the entire session
- **Keyboard layout updated**: 3-button persistent keyboard (New session, Model, Verbose toggle)
- **Model selection**: now uses dynamic `getActiveModels()` instead of static `config.agy.allowedModels`
- **Effort auto-detection**: model IDs ending in `-low`/`-medium`/`-high` automatically set the corresponding effort level
- **Link/code formatting**: markdown links are now parsed before inline code tokens to prevent nesting bugs
- **Empty line preservation**: paragraph spacing between blocks is maintained in chunked messages

### Security
- **Hardcoded credentials removed**: Immich API key and private infrastructure URLs are no longer in source code; require explicit env vars
- **SSRF protection**: `isPrivateOrReservedHost()` blocks 127.x, 10.x, 172.16-31, 192.168.x, 169.254.x, 0.x, 100.64-127, ::1, fe80:, fc00:/fd00: for web image fetches
- **`/update` and `/restart` gated**: disabled by default; requires `ALLOW_BOT_UPDATE=true` to enable remote updates/restarts via Telegram
- **Arg-array exec**: `git` and `npm` commands use `execFile` with argument arrays instead of shell strings to prevent injection
- **Memory engine hardcoded path removed**: personal infrastructure path (`/home/ubuntu/dev/agy-memory-engine/`) stripped from source

### Fixed
- **German strings replaced with English**: all user-facing messages standardized to English
- **Dead code removed**: `defaults.dangerouslySkipPermissions` was set but never used (final settings always override to `false`)
- **`/models` command removed** (replaced by `/model` with dynamic fetching)
- **Shared quota detection**: `parseUsageQuota` now consolidates identical Gemini and Claude/GPT quotas into a unified "Antigravity Quota (All Models)" display

## [0.1.8] - 2026-08-17

### Added
- Auto-record Telegram sessions to conversation database
- Implement missing slash commands
- Fix resume menu HTML escaping

### Fixed
- Process tree cleanup on cancellation

## [0.1.7] - 2026-08-15

### Added
- Full-control mode as default
- Interactive setup wizard

## [0.1.6] - 2026-08-12

### Added
- Gemini 3.7 Flash High model
- Multimodal photo and document file attachment support
- Active context progress bar visualization
- Document download handlers

### Fixed
- Queue `isDraining` lock guard to prevent job processing race conditions

## [0.1.5] - 2026-08-10

### Fixed
- Cancel command keeps Telegram polling responsive
- Stop custom AGY commands on cancel

## [0.1.4] - 2026-08-09

### Added
- Interactive usage credits and resume
- Complete AGY CLI controls exposure
- npm package and release workflows

## [0.1.3] - 2026-08-08

### Fixed
- Format AGY responses for Telegram
- Align CI with Node 22 package runtime

## [0.1.2] - 2026-08-07

### Added
- Standalone AGY Telegram gateway
- TypeScript migration

[0.5.0]: https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/compare/v0.2.0...v0.3.1
[0.2.0]: https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/releases/tag/v0.1.4
