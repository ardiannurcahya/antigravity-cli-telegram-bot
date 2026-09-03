<div align="center">

# Antigravity CLI Telegram Bot

**Connect Antigravity CLI to Telegram with a secure, allowlisted bot gateway.**

Run AGY prompts from Telegram with allowlisted users, per-chat sessions,
streamed progress, model controls, and a hardened systemd deployment.

[![Node.js 22+](https://img.shields.io/badge/node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![CI](https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/ardiannurcahya/antigravity-cli-telegram-bot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agy-telegram?logo=npm&logoColor=white)](https://www.npmjs.com/package/agy-telegram)
[![Tests](https://img.shields.io/badge/tests-120%20passing-2ea44f)](./test)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

</div>

Antigravity CLI Telegram Bot is a standalone tool for connecting the
Antigravity CLI to a Telegram bot. It is designed to run as its own systemd
service under a dedicated Unix user.

> **Security notice:** AGY can inspect and modify files and execute commands
> through its tools. Only deploy this bot for trusted Telegram users and keep
> its workspace, credentials, and sandbox configuration tightly restricted.

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Install From npm](#install-from-npm)
- [Install From GitHub Packages](#install-from-github-packages)
- [Telegram Commands](#telegram-commands)
- [Configuration](#configuration)
- [Production Deployment](#production-deployment)
- [Security Model](#security-model)
- [Development](#development)
- [Project Structure](#project-structure)
- [Ecosystem & Complementary Tools](#ecosystem--complementary-tools)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [License](#license)

## Features

- Standalone Telegram bot and token for Antigravity CLI.
- Numeric Telegram user allowlist with optional chat allowlist.
- Private-chat-only operation by default.
- One global AGY job at a time to protect a small VPS with `isDraining` queue lock guard.
- Per-chat AGY conversation mapping when AGY returns a conversation ID.
- Multimodal photo and document file attachment support (`.pdf`, `.txt`, `.md`, `.json`, `.csv`, `.py`, `.go`, etc.) automatically saved to `${AGY_WORKSPACE}/uploads/`.
- Per-chat model, effort, execution mode, and sandbox settings.
- Persistent reply keyboard beside the Telegram input.
- Persistent keyboard limited to Model and Mode controls.
- Inline pickers for model, effort, mode, and sandbox selection.
- Browse, paginate, and resume saved AGY conversations from the AGY SQLite database.
- Live AGY model quota reports through a PTY-backed `/usage` command.
- Live AGY credits reports through a PTY-backed `/credits` command.
- Live AGY active context token breakdown through a PTY-backed `/context` command.
- Active Context Usage % and visual progress bar representation based on per-model context limits (Gemini 1M/2M, Claude 200K, GPT 128K).
- Separate `/tokens` reporting for per-turn and accumulated stream usage.
- AGY CLI panels for models, agents, changelog, plugins, CLI help, version, update, and common options.
- Full non-interactive AGY CLI passthrough through `/agy` with shell-free argument handling.
- Streamed progress messages and live response drafts with separate final response bubbles.
- Per-turn and accumulated token usage when AGY provides usage data.
- Long replies uploaded as Markdown documents.
- Process-group timeout and hard cancellation.
- Strict TypeScript build with an automated test suite (139 passing tests).
- Clean modular architecture (`domain`, `infra`, `router`, `telegram`, `ui`, `usecases`).
- Hardened security: Bitwise 128-bit IPv6 SSRF protection, strict path containment (`isWithin`), secret scrubbing, and safe permission defaults.
- Dangerous plugin, update, install, and permission operations require an explicit second confirmation.
- Per-session workspace isolation: scope AGY's working directory dynamically with `/workspace <name|path>`, automatically reverting to global root on `/new` in 1:1 DMs (Option A) and preserving topic binding in forum supergroups.
- AGY is restricted to the configured workspace by default.

## Architecture

```text
                                 Telegram Bot API
                                        │
                                        ▼
                           ┌──────────────────────────┐
                           │   src/router/updates.ts  │
                           │   (Ingestion & Auth Gate)│
                           └────────────┬─────────────┘
                                        │
                    ┌───────────────────┴───────────────────┐
                    ▼                                       ▼
       ┌────────────────────────┐              ┌────────────────────────┐
       │   src/router/commands  │              │  src/router/callbacks  │
       │   (Slash Commands)     │              │  (Inline Keyboards)    │
       └────────────┬───────────┘              └────────────┬───────────┘
                    │                                       │
                    └───────────────────┬───────────────────┘
                                        ▼
                           ┌──────────────────────────┐
                           │   src/usecases/enqueue   │
                           │   (Job Queue & Auto-Int) │
                           └────────────┬─────────────┘
                                        │
                    ┌───────────────────┴───────────────────┐
                    ▼                                       ▼
       ┌────────────────────────┐              ┌────────────────────────┐
       │  src/usecases/prompt   │              │   src/pty-runner.ts    │
       │  Non-interactive AGY   │              │   Interactive PTY AGY  │
       │  (--output stream-json)│              │   (/usage, /credits)   │
       └────────────┬───────────┘              └────────────┬───────────┘
                    │                                       │
                    ▼                                       ▼
       ┌────────────────────────┐              ┌────────────────────────┐
       │ Live Stream Progress   │              │ Cleaned Terminal TUI   │
       │ & Clean Answer Bubble  │              │ Quota & Credit Card    │
       └────────────┬───────────┘              └────────────┬───────────┘
                    │                                       │
                    └───────────────────┬───────────────────┘
                                        ▼
                           ┌──────────────────────────┐
                           │   src/ui/ & telegram/    │
                           │   (HTML, LaTeX, Media)   │
                           └──────────────────────────┘
```

The gateway starts AGY with `--print --output-format stream-json`, parses its
incremental NDJSON events, and streams real-time status updates to Telegram.
Final model responses are delivered in a clean, separate chat bubble to avoid
overwriting progress headers. Normal prompts use this non-interactive mode for
stable response boundaries. The read-only `/usage`, `/credits`, and `/context`
commands use a short-lived PTY session to capture interactive TUI reports, clean
ANSI control sequences, and render structured quota cards. PTY processes are
time-limited and can be aborted immediately with `/cancel`.

## Requirements

- Node.js 22 or newer (uses native SQLite).
- The AGY CLI installed and authenticated for the service user.
- A Telegram bot created through [BotFather].
- A writable, dedicated AGY workspace.
- A Telegram user ID to add to the allowlist.

For production, install AGY at `/usr/local/bin/agy` and run this gateway as a
dedicated `agybot` user. Running the bot as root is not recommended.

## Quick Start

The recommended production installation uses the npm package. A source
checkout is only needed for development or contributing.

### 1. Create and configure the bot

Create a bot with [BotFather], then copy the token into a local environment
file. Never commit the real token.

```bash
cp .env.example .env
chmod 600 .env
```

Set at least these values in `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=replace-with-botfather-token
TELEGRAM_ALLOWED_USER_IDS=123456789
AGY_BIN=/usr/local/bin/agy
AGY_WORKSPACE=/srv/agy-workspaces/default
AGY_MODE=plan
AGY_SANDBOX=1
```

Telegram numeric user IDs can be obtained using a trusted Telegram ID bot or
from an update received while diagnosing a controlled test deployment. Do not
use a username as the allowlist value.

### 2. Install dependencies and build from source

```bash
npm ci
npm run build
npm test
```

### 3. Start locally from source

```bash
set -a
. ./.env
set +a
npm start
```

Open the bot in Telegram and send `/start`. Use `/menu` to refresh the control
keyboard or send a normal text message to submit a prompt to AGY.

## Install From npm

Install the published package globally. This provides the `agy-telegram`
command and includes the compiled runtime, systemd template, environment
template, README, and license.

```bash
sudo npm install --global agy-telegram
agy-telegram --version
```

For a configured bot, run:

```bash
agy-telegram
```

If the Telegram settings are not configured, the command opens a setup wizard:

```bash
agy-telegram --setup
```

The wizard asks for the bot token and allowed Telegram user ID(s), then saves
them to `~/.config/agy-telegram/.env` with mode `600`. Existing environment
variables take precedence over the saved file. For systemd, use
`EnvironmentFile` or configure `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_ALLOWED_USER_IDS` explicitly; systemd has no interactive terminal.

For a production service, use the systemd instructions below. The package
installs the executable at `/usr/bin/agy-telegram` when npm uses the default
system prefix.

## Telegram Commands

| Command | Description |
| --- | --- |
| `/start` | Show status and safety settings. |
| `/help` | Show available commands. |
| `/menu` | Show or refresh the persistent control keyboard. |
| `/new` | Start a new AGY conversation for this chat. |
| `/resume` | Browse and resume previous conversations from AGY's SQLite database. |
| `/sessions` | Alias for `/resume`. |
| `/models` | Open the allowed model picker. |
| `/model` | Show the current model. |
| `/model ID` | Select an allowed model. |
| `/effort` | Show the current reasoning effort. |
| `/effort LEVEL` | Set `low`, `medium`, or `high` effort. |
| `/mode` | Show the current execution mode. |
| `/mode MODE` | Set `plan` or `accept-edits` mode. |
| `/sandbox` | Show the current sandbox status. |
| `/sandbox on\|off` | Enable or disable sandbox when server policy permits it. |
| `/session` | Show active conversation and runtime settings. |
| `/usage` | Check live models & quota limits from AGY interactive PTY. |
| `/quota` | Alias for `/usage`. |
| `/credits` | Check live AGY credits and purchase links via PTY. |
| `/tokens` | Show turn and accumulated token usage from stream data. |
| `/status` | Show queue and active-job status. |
| `/cancel` | Cancel this chat's active or queued jobs. |
| `/agents` | List available custom AGY agents. |
| `/agent NAME` | Select a custom AGY agent for future prompts. |
| `/changelog` | Show AGY CLI release notes. |
| `/plugins` | List imported AGY plugins. |
| `/cli-help` | Show the installed `agy --help` output. |
| `/version` | Show the installed AGY CLI version. |
| `/agy ARGS...` | Run any non-interactive AGY command or subcommand using direct argv. |
| `/agy-confirm` | Confirm a pending plugin, update, install, or permission-changing command. |
| `/project ID\|clear` | Set or clear the per-chat `--project` value. |
| `/add-dir PATH\|clear` | Add a directory for future prompts, or clear the list. |
| `/output-format FORMAT` | Set `text`, `json`, or `stream-json` for future prompts. |
| `/json-schema VALUE\|clear` | Set or clear `--json-schema`. |
| `/log-file PATH\|clear` | Set or clear `--log-file`. |
| `/print-timeout VALUE\|clear` | Set or clear `--print-timeout`. |
| `/continue on\|off` | Toggle `--continue` for future prompts. |
| `/new-project on\|off` | Toggle `--new-project` for future prompts. |
| `/disable-slash-commands on\|off` | Toggle `--disable-slash-commands` for future prompts. |
| `/workspace [NAME\|PATH\|clear]` | Show active workspace, switch to a project directory, or reset to default. |

Any other text is treated as an AGY prompt. `/agy` accepts the complete
non-interactive flag surface shown by `agy --help`, including repeatable
`--add-dir`, `--agent`, `--continue`, `--conversation`, `--mode`, `--model`,
`--effort`, `--json-schema`, `--log-file`, `--new-project`, `--output-format`,
`--print-timeout`, `--project`, `--sandbox`, and the `--print`/`--prompt`
aliases. Arguments are passed directly to AGY and never through a shell.
By default, the process working directory is fixed by `AGY_WORKSPACE`, and can be
dynamically scoped per session or forum topic using `/workspace`.

### Workspace Scoping & Lifecycle (/workspace)

By default, the process working directory is fixed by `AGY_WORKSPACE` to preserve a friction-free experience for general daily assistant tasks (smart home, notes, calendar, email drafts).

For software development workflows, `/workspace` enables scoping the working directory to a specific project repository:

```bash
/workspace                 # Display the current workspace and interactive project buttons
/workspace my-project      # Switch the active workspace to /path/to/projects/my-project
/workspace /projets/repo   # Flexible resolution accepting leading slash prefix
/workspace clear           # Revert back to the default AGY_WORKSPACE
```

#### Lifecycle and Mental Model (Option A)
- **1:1 Direct Messages (Ephemeral)**: Starting a new conversation with `/new` automatically resets the session **and** reverts the workspace back to `AGY_WORKSPACE`. This ensures ad-hoc debugging or coding sessions never accidentally linger or trap subsequent personal assistant tasks in a code repository.
- **Forum Topics (Persistent Binding)**: In Telegram supergroups with forum topics, running `/new` within a dedicated topic clears the conversation history but **preserves the topic's project workspace binding**. This allows project-specific threads (e.g. `#my-app`) to stay anchored to their repository.
- **Visual Feedback on Prompt**: When a custom workspace is bound to a session, every prompt immediately displays a clear workspace confirmation banner in the live progress message (`📁 Workspace: /path/to/project`).
- **Interactive Keyboard & Autocompletion**: `/workspace` is registered for Telegram slash-command autocompletion and displays an interactive inline button menu when called without arguments, allowing one-tap project switching without typing.
- **Security & Confinement**: Directory selection is strictly validated using path containment checks (`isWithin`) against `AGY_PROJECTS_ROOT` and the default workspace to prevent path traversal attacks (`../`). Leading slashes (e.g. `/scripts` or `/projets/scripts`) are cleanly resolved relative to authorized roots.

The full control panel is available from `/menu`. The persistent keyboard next
to the input intentionally contains only `Model` and the current `Mode` button;
model, effort, sandbox, session, usage, credits, resume, and AGY CLI information are available
through the inline menu and slash commands.

The inline menu exposes common flags and plugin actions; the custom command
panel covers the complete CLI surface. `--prompt-interactive` is reported but
rejected because it requires a local TTY. Plugin installation/removal, CLI
update, and `agy install` require a second `/agy-confirm` message. With
`AGY_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS=1`, normal prompts and `/agy --print`
commands automatically approve tool permissions so ordinary shell commands
can run without an interactive approval prompt. The configured sandbox policy,
service user, workspace, and systemd restrictions remain in force.

### Interactive command behavior

`/usage` and `/credits` are read-only commands implemented with a one-shot PTY
runner because AGY exposes these reports through its interactive TUI. The
runner:

- Starts AGY with the configured binary and workspace as the service user.
- Removes Telegram bot credentials from the child environment.
- Handles terminal capability queries and the workspace trust prompt.
- Waits for the rendered prompt, types the slash command, and submits it.
- Detects reports rendered between TUI rows, including multiline prompt output.
- Removes ANSI control sequences and formats quota/credits as Telegram HTML.
- Terminates the child process after the report, timeout, cancellation, or output limit.

Normal text prompts do not use this PTY path. They continue to use
`--print --output-format stream-json` so streamed progress, response parsing,
conversation IDs, and token usage remain deterministic.

### Resuming conversations

`/resume` reads `conversation_summaries` from the configured AGY SQLite database
in read-only mode. The bot filters out killed or empty conversations, displays
ten sessions per page, validates selected conversation UUIDs, and stores the
selected conversation in per-chat state. Future normal prompts pass the
selected conversation with `--conversation`; this takes precedence over
`--continue`. `/new` clears the active conversation and its accumulated run
usage while preserving the chat's model and execution settings.

## Configuration

Copy `.env.example` to an environment file outside the repository. The
following variables are supported:

| Variable | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required | Token generated by BotFather. |
| `TELEGRAM_ALLOWED_USER_IDS` | Required | Comma-separated numeric Telegram user IDs. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Empty | Optional comma-separated chat ID allowlist. |
| `TELEGRAM_PRIVATE_ONLY` | `1` | Reject non-private chats unless set to `0`. |
| `TELEGRAM_MAX_MESSAGE_CHARS` | `3900` | Telegram message chunk size. |
| `AGY_BIN` | `/root/.local/bin/agy` | Absolute path to the AGY executable. |
| `AGY_WORKSPACE` | `/srv/agy-workspaces/default` | Default working directory AGY may use. Must be absolute. |
| `AGY_PROJECTS_ROOT` | Parent of `AGY_WORKSPACE` | Base directory for discovering and scoping projects with `/workspace`. |
| `AGY_PROJECT` | Empty | Optional AGY project identifier. |
| `AGY_DB_PATH` | `~/.gemini/antigravity-cli/conversation_summaries.db` | Read-only AGY SQLite database used by `/resume`. |
| `AGY_MODE` | `plan` | AGY mode: `plan` or `accept-edits`. |
| `AGY_SANDBOX` | `0` | Full-control default: disable AGY terminal restrictions. Set to `1` to enable the sandbox. |
| `AGY_ALLOW_SANDBOX_DISABLE` | `1` | Permit users to toggle the sandbox from Telegram. |
| `AGY_MODEL` | Empty | Default model. Empty uses AGY's default model. |
| `AGY_EFFORT` | `high` | Default reasoning effort: `low`, `medium`, or `high`. |
| `AGY_AGENT` | Empty | Optional default custom agent passed as `--agent`. |
| `AGY_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS` | `1` | Full-control default: automatically approve AGY tool permissions for normal prompts. |
| `AGY_ALLOWED_MODELS` | All known models | Comma-separated allowlist used by `/models` and `/model`. |
| `AGY_TIMEOUT_MS` | `1800000` | Maximum AGY runtime in milliseconds. |
| `AGY_MAX_OUTPUT_BYTES` | `20000000` | Maximum captured AGY output. |
| `MAX_QUEUE_SIZE` | `8` | Maximum queued prompts across chats. |
| `STATE_FILE` | `/var/lib/agy-telegram/state.json` | Persistent offset, sessions, settings, and usage. |
| `TEMP_DIR` | `/var/lib/agy-telegram/tmp` | Runtime temporary directory. |
| `LOG_LEVEL` | `info` | Reserved logging-level setting. |

The configuration loader rejects missing tokens, empty user allowlists,
invalid Telegram IDs, relative workspaces, unsupported modes or effort levels,
and models outside the configured model allowlist.

### Supported models

The built-in model allowlist currently includes:

- `gemini-3.8-flash-high`
- `gemini-3.8-flash-medium`
- `gemini-3.8-flash-low`
- `gemini-3.7-flash-high`
- `gemini-3.7-flash-medium`
- `gemini-3.7-flash-low`
- `gemini-3.6-flash-high`
- `gemini-3.6-flash-medium`
- `gemini-3.6-flash-low`
- `gemini-3.1-pro-high`
- `gemini-3.1-pro-low`
- `claude-sonnet-4-6`
- `claude-opus-4-6-thinking`
- `gpt-oss-120b-medium`

AGY may expose usage fields such as input, output, thinking, cache-read, and
total tokens. The gateway displays values supplied by AGY and does not estimate
billing usage or subscription quota.

## Production Deployment

The repository includes a hardened systemd unit at
[`deploy/agy-telegram.service`](./deploy/agy-telegram.service) and an
environment template at [`deploy/agy-telegram.env.example`](./deploy/agy-telegram.env.example).

### 1. Prepare the service user and directories

```bash
sudo useradd --system --home-dir /var/lib/agybot --create-home --shell /usr/sbin/nologin agybot
sudo install -d -o agybot -g agybot -m 0750 /var/lib/agy-telegram/tmp
sudo install -d -o agybot -g agybot -m 0750 /srv/agy-workspaces/default
```

Install and authenticate AGY for `agybot`, then verify that the service user
can access the configured workspace and AGY credential cache:

```bash
sudo -u agybot -H /usr/local/bin/agy --version
```

### 2. Install the npm package

```bash
sudo npm install --global agy-telegram
agy-telegram --help
```

Use the package metadata to locate the installed deployment templates:

```bash
NPM_PACKAGE_DIR="$(npm root --global)/agy-telegram"
ls "$NPM_PACKAGE_DIR/deploy"
```

### 3. Install and edit the service environment

```bash
NPM_PACKAGE_DIR="$(npm root --global)/agy-telegram"
sudo install -m 0600 -o root -g root "$NPM_PACKAGE_DIR/deploy/agy-telegram.env.example" /etc/agy-telegram.env
sudoedit /etc/agy-telegram.env
```

Replace all placeholders. At minimum, configure the real BotFather token and
one or more numeric Telegram user IDs.

### 4. Enable the service

```bash
NPM_PACKAGE_DIR="$(npm root --global)/agy-telegram"
sudo install -m 0644 "$NPM_PACKAGE_DIR/deploy/agy-telegram.service" /etc/systemd/system/agy-telegram.service
sudo systemctl daemon-reload
sudo systemctl enable --now agy-telegram
sudo systemctl status agy-telegram
sudo journalctl -u agy-telegram -f
```

The unit runs as `agybot`, uses `/var/lib/agybot` as `HOME`, keeps the process
inside the configured workspace, and applies CPU, memory, task, and systemd
filesystem restrictions. Review `ReadWritePaths` and AGY's authentication path
for your host before starting the service.

## Security Model

This project is a control gateway, not a complete authorization boundary for
an untrusted user. Keep all of the following controls enabled:

- Use a dedicated Telegram bot token and never commit it.
- Allow only trusted numeric Telegram user IDs.
- Keep `TELEGRAM_PRIVATE_ONLY=1` unless group operation is intentional.
- Run the service as a dedicated non-root Unix user.
- Give AGY a dedicated, least-privilege workspace rather than `/root` or `/`.
- Keep `AGY_MODE=plan` for unattended operation unless edits are explicitly intended.
- This release defaults to full-control mode: `AGY_SANDBOX=0`,
  `AGY_ALLOW_SANDBOX_DISABLE=1`, and
  `AGY_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS=1`. Restrict
  `TELEGRAM_ALLOWED_USER_IDS` to trusted users.
- For a safer deployment, set `AGY_SANDBOX=1`,
  `AGY_ALLOW_SANDBOX_DISABLE=0`, and
  `AGY_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS=0`.
- Store `/etc/agy-telegram.env` and the state file with mode `0600`.
- Keep SSH keys, cloud credentials, AGY credentials, and unrelated repositories
  outside the AGY workspace.
- Review systemd resource and write-path restrictions before deployment.

If a token is ever pasted into a chat, terminal transcript, issue, or log,
revoke it in BotFather or the relevant provider and issue a replacement.

## Development

The project uses strict TypeScript and emits compiled JavaScript into `dist/`.
Generated output and dependencies are intentionally ignored by Git.

```bash
npm ci
npm run build
npm test
npm run pack:check
git diff --check
```

The package can be tested locally before publishing:

```bash
npm pack
npm install --global ./agy-telegram-0.1.4.tgz
```

Do not commit the generated `.tgz` file. It is ignored by Git and should be
removed after a local installation test.

## Install From GitHub Packages

The project publishes two package names from the same source:

- npmjs: `agy-telegram`
- GitHub Packages: `@ardiannurcahya/agy-telegram`

GitHub Packages requires npm packages to use a lowercase scope. The release
workflow creates the scoped GitHub Package metadata in a temporary directory,
publishes it to `https://npm.pkg.github.com`, and links it to this repository
through the `repository` field. It authenticates from GitHub Actions with the
workflow `GITHUB_TOKEN` and does not require a token in the repository.

To install from GitHub Packages, create a user-level or project-local `.npmrc`
without committing a real token:

```ini
@ardiannurcahya:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Use a GitHub personal access token (classic) with at least `read:packages` in
`GITHUB_PACKAGES_TOKEN`, then install the scoped package:

```bash
npm install --global @ardiannurcahya/agy-telegram --registry=https://npm.pkg.github.com
```

The GitHub Package is published when a release tag such as `v0.1.4` is pushed.
After its first publication, its visibility and access policy can be reviewed
from the repository's **Packages** page.

## npm Publishing

GitHub Actions runs on every pull request and push to `main`. The CI workflow
tests Node.js 20 and 22, builds the TypeScript output, runs the test suite, and
uploads an npm tarball as a workflow artifact.

Publishing is triggered by pushing a semantic version tag such as `v0.2.0`:

```bash
npm version minor
git push origin main --follow-tags
```

Before publishing, add an npm access token with package publish access as the
repository secret `NPM_SECRET`. The publish workflow verifies the package
contents and publishes with npm provenance enabled. Keep the npm token out of
commits, logs, and command arguments.

Before opening a pull request:

1. Keep secrets and local state outside the repository.
2. Add or update tests for behavior changes.
3. Run the build and full test suite.
4. Document configuration or deployment changes in this README.

## Project Structure

The codebase is organized as a modular domain-driven architecture with clean separation of concerns, explicit dependency injection, and complete test isolation:

```text
src/
├── cli.ts                      # CLI entrypoint and binary dispatcher
├── bot.ts                      # Bot lifecycle coordinator and long-polling runner
├── context.ts                  # AppContext dependency injection graph
├── config.ts                   # Environment validation, defaults, and security bounds
├── types.ts                    # Shared TypeScript domain types and interfaces
├── agy-runner.ts               # Non-interactive AGY CLI runner and stream-json parser
├── pty-runner.ts               # Interactive PTY session runner for /usage & /credits
├── queue.ts                    # Global job queue with cancellation and concurrency guards
├── state.ts                    # Persistent state store (sessions, offsets, in-flight jobs)
├── db.ts                       # Read-only SQLite conversation index and lookup
├── models.ts                   # Dynamic & default model catalog
├── setup.ts                    # Interactive terminal setup wizard
├── index.ts                    # Public package exports
│
├── domain/                     # Business Logic & Entities
│   ├── settings.ts             # Per-chat session settings resolution & defaults
│   └── usage-math.ts           # Token arithmetic, percentages, and progress bars
│
├── infra/                      # Infrastructure & Environment Hardening
│   ├── instance-lock.ts        # Atomic PID-based instance lock to prevent duplicates
│   └── safe-env.ts             # Secret scrubbing and child environment isolation
│
├── router/                     # Ingestion, Authentication & Dispatch
│   ├── updates.ts              # Telegram update ingestion and attachment dispatch
│   ├── commands.ts             # Slash command routing and execution registry
│   ├── callbacks.ts            # Inline keyboard callback query handler
│   ├── callback-parser.ts      # Strongly-typed callback query parser
│   └── auth.ts                 # User ID and chat ID allowlist authorization gate
│
├── telegram/                   # Telegram Engine & Media Services
│   ├── client.ts               # HTTP client with exponential backoff & IPv4-first DNS
│   ├── markdown-renderer.ts    # Telegram HTML formatting, LaTeX conversion & chunking
│   └── media-resolver.ts       # Path containment and SSRF-hardened web image fetcher
│
├── ui/                         # Presentation & Views
│   ├── reply.ts                # Resilient message sender with chunking & retry logic
│   ├── screens.ts              # Menu, status, tokens, and session screen formatters
│   ├── inline-keyboards.ts     # Dynamic inline keyboards (models, settings, confirmations)
│   └── messages.ts             # Standardized user-facing UI messages and banners
│
└── usecases/                   # Application Workflows
    ├── prompt-job.ts           # Prompt execution lifecycle, live streaming & token summaries
    ├── custom-agy.ts           # Full-control /agy CLI passthrough & confirmation gating
    ├── enqueue.ts              # Job queueing with zero-loss auto-interrupt merge
    ├── image-detection.ts      # AI artifact image detection and delivery
    ├── model-selection.ts      # Dynamic model fetching and effort level selection
    ├── self-update.ts          # Git pull, TypeScript build, and systemd restart flow
    └── default-settings.ts     # Atomic default settings persistence to .env

test/                           # Node Test Runner Suite (120 automated tests)
├── agy-runner.test.ts          # Stream parser and process lifecycle tests
├── callback-parser.test.ts     # Typed callback parser tests
├── commands.test.ts            # Command execution and authorization parity tests
├── config.test.ts              # Configuration validation and default safety tests
├── db.test.ts                  # SQLite pagination and conversation lookup tests
├── golden-pure.test.ts         # Screen rendering and format snapshot tests
├── handlers.test.ts            # Router, callback, and command handling tests
├── instance-lock.test.ts       # Atomic lock acquisition and crash takeover tests
├── production-resilience.test.ts # Polling recovery, retry, rate limit & queue tests
├── pty-runner.test.ts          # PTY terminal report extraction & ANSI cleaner tests
├── queue.test.ts               # Queue order, worker crash, and cancellation tests
├── setup.test.ts               # Interactive setup wizard tests
├── smoke.test.ts               # End-to-end PTY and database smoke tests
├── state.test.ts               # State persistence and in-flight job recovery tests
├── telegram.test.ts            # SSRF protection, LaTeX, HTML, and media resolver tests
└── helpers/                    # Test fixtures, mock Telegram server, and utilities

deploy/                         # Production systemd service unit & environment template
.github/workflows/              # CI/CD, TypeScript build, and npm publish workflows
```

## Ecosystem & Complementary Tools

- **[agy-memory-engine](https://github.com/sbolten/agy-memory-engine)** — A lightweight, local 4-layer cognitive long-term memory engine (Facts, Narrative Episodes, Learnings, Entity Graph) for Google Antigravity. Using AGY's lifecycle hooks, conversation turns from Telegram are automatically enqueued in `< 1ms` and consolidated into persistent SQLite FTS5 memory in the background with calm-memory session debouncing.

## Limitations

- Long polling is used instead of a webhook.
- Only one AGY job runs globally at a time.
- Telegram output is chunked or uploaded as Markdown for long responses.
- Subscription quota is not available from AGY `stream-json` and cannot be
  calculated by this gateway.
- The AGY interactive PTY path is intentionally limited to the read-only
  `/usage` and `/credits` reports; arbitrary interactive commands are not
  exposed through Telegram.
- The PTY parser depends on the installed AGY TUI headings and may need updates
  if a future AGY release changes the report layout.

## Contributing

Issues and pull requests are welcome. Please include the motivation, expected
behavior, test coverage, and any security or deployment impact in your change.
Do not include bot tokens, AGY credentials, private workspace files, or server
logs containing secrets.

## Disclaimer

This is an independent, community-driven open-source project that interfaces with the official Google Antigravity (`agy`) CLI. It is **not** an official Google product and is **not** affiliated with, sponsored by, or endorsed by Google LLC or Google DeepMind. "Google", "Gemini", and "Antigravity" are trademarks of Google LLC.

## License

This project is licensed under the [MIT License](./LICENSE).

[BotFather]: https://t.me/BotFather
