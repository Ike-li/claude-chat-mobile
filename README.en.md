# Claude Chat Mobile

> Connect your local `claude` CLI to your phone. It keeps the same project configuration, tools, and session history, but it is not remote desktop software or a shared live TTY.

[中文](README.md) · **English** · [🌐 Website](https://ike-li.github.io/claude-chat-mobile/)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Agent SDK](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FIke-li%2Fclaude-chat-mobile%2Fmaster%2Fpackage.json&query=%24.dependencies%5B%22%40anthropic-ai%2Fclaude-agent-sdk%22%5D&label=Agent%20SDK&color=blue)](https://code.claude.com/docs/en/agent-sdk/overview)
[![tested with claude CLI](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FIke-li%2Fclaude-chat-mobile%2Fmaster%2Fpackage.json&query=%24.verifiedWith.claudeCli&label=tested%20with%20claude%20CLI&color=blue)](#prerequisites)
[![PWA](https://img.shields.io/badge/PWA-installable-blueviolet.svg)](#quick-start)
[![CI](https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml/badge.svg)](https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml)

> The Agent SDK and claude CLI badges read `package.json` on `master`. The CLI badge records the environment used to verify the latest release; it is not a minimum version requirement.

Claude Code may keep running while you are away from your computer. Claude Chat Mobile drives your locally authenticated CLI through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), so you can keep editing code, running commands, answering questions, and approving actions from your phone. It does not bundle Claude or create a separate account or session system.

## Who it is for

- People who already use `claude` in a macOS or Linux terminal and want to follow or handle work away from the desk.
- People who need to switch between repositories and sessions while seeing tool calls, diffs, background tasks, and errors on a phone.
- People who want approvals and questions to reach the phone instead of watching a terminal continuously.

By default only one side drives a session at a time. Web-driven messages travel through the Agent SDK into the local CLI. When the terminal CLI is driving, the Web app follows the persisted transcript in read-only mode. This is not screen sharing, and the phone and terminal cannot both type into one live process. While the terminal is still running you can explicitly force a takeover (behind a confirmation that spells out the fork risk) — that only lifts the read-only lock on the phone side; it does not stop the terminal process.

## Core capabilities

### Sessions and workspaces

- Resume, fork, and remove CLI sessions at two levels, with a cross-session “needs you” view (scoped to instances the Web backend is driving; sessions waiting inside a plain terminal do not enter this view and surface only through the optional hooks bridge).
- Monitor multiple workspaces and sessions. A git worktree must be added to `workdirs.json` by absolute path; it is never auto-discovered or implicitly authorized.
- One message per turn: while a task runs, you can keep a draft, but the send control becomes Stop instead of queuing another message.

### Mobile interaction

- Streaming Markdown, syntax highlighting, tool cards, Edit/Write diffs, Read excerpts, and a native `AskUserQuestion` picker.
- Image and file uploads, pasted screenshots, historical attachment previews, and composer `@` file references.
- Browse files inside approved workspaces. Existing text files up to 256KB can be edited in CodeMirror, with content-hash checks preventing concurrent overwrites.

### Notifications and visibility

- Web Push / ntfy notifications for approvals, questions, and results. Notifications default to type-only text; you can test the delivery path and optionally enable content previews for Web Push.
- An optional CLI hooks bridge turns terminal Stop / Notification events into immediate signals instead of waiting for polling.
- API errors, retry countdowns, SDK notices, subagents, and background-task progress are visible in the UI rather than only in server logs.

### Reliability and operations

- `seq + epoch` event deduplication and reconnect replay. The status line selects either SDK or CLI snapshots according to the current driver.
- Startup checks with `doctor`, an in-app security check, redacted logs, auth rate limits, a service-status panel, and authenticated `/health` and `/metrics` endpoints.
- An installable PWA with complete Chinese and English UI coverage. Browser dependencies are self-hosted with the project instead of loaded from a CDN.

## Prerequisites

- **Node.js 20 or newer.**
- **A locally installed and authenticated `claude` CLI.** Confirm that `which claude` finds it and that a terminal conversation works.
- **macOS or Linux** are first-class platforms. Native Windows is experimental; WSL2 is the safer route.
- Claude subscriptions and third-party gateways are both supported. Gateway `ANTHROPIC_*` variables must exist in the **shell that starts the server**; values placed in `.env` are stripped.

## Quick Start

```bash
git clone https://github.com/Ike-li/claude-chat-mobile.git
cd claude-chat-mobile

node --version
which claude
npm install --omit=dev
npm run setup
node scripts/doctor.js
npm start
```

`setup` creates an `AUTH_TOKEN`, asks which `WORK_DIR` Claude may access, and explicitly asks whether to install the CLI hooks bridge. The startup log prints a tokenized LAN URL that you can open on your phone.

The first connection from a non-local device also requires approval on the computer:

```bash
node scripts/device.js list
node scripts/device.js approve <ID>
```

For the complete first-run flow, non-interactive setup, a copyable coding-agent prompt, PWA setup, and bridge configuration, see the [Getting Started guide](docs/getting-started.en.md).

## Three ways to run it

| Mode | Best for | Notes |
|---|---|---|
| Same Wi-Fi: `http://<lan-ip>:3000/#token=…` | Home or office LAN | Simplest option; unavailable after leaving that network |
| Temporary public URL: `cloudflared tunnel --url http://localhost:3000` | Trials and demos | Random hostname changes; no Access layer, so device approval still applies |
| Fixed production deployment: domain + Cloudflare Access + service manager | Long-term access from anywhere | Requires one-time operations setup; see the [deployment guide](docs/deployment.md) |

PWA installation and Web Push require HTTPS. On iOS, Web Push also requires iOS 16.4+ and installing the site on the Home Screen first.

## Security Model

> This is a remotely reachable code-execution path into your local shell. Understand these boundaries before exposing it publicly.

1. **Single-user, owner-level access.** There is no multi-user or tenant isolation. An authenticated operation has the permissions of the local account that started `claude`.
2. **No token means loopback only.** Without `AUTH_TOKEN`, the server listens only on `127.0.0.1`. Phone or tunnel access requires a strong token.
3. **Keep workspace scope narrow.** `WORK_DIR` and `workdirs.json` are the scope gate for files, sessions, and git operations. Do not expose your whole home directory for convenience.
4. **Automatic approval inherits CLI configuration.** `permissions.allow` rules from `~/.claude/settings.json`, project `.claude/settings.json`, and `.claude/settings.local.json` apply here too. Review accumulated Bash/Write rules before public use.
5. **Device trust is a second gate.** Except for local connections or requests validated by Cloudflare Access JWT, a valid token still needs one-time device approval. Revoke a device with `node scripts/device.js deny <ID>`.
6. **The file editor is a direct user write.** It does not pass through the Agent tool-approval chain. It can only modify existing files up to 256KB and applies scope checks, content-hash conflict detection, and audit logging. Set `FILE_EDIT=off` for read-only browsing.

Report vulnerabilities privately through [GitHub Security Advisories](SECURITY.md), not a public issue.

## How Web and CLI work together

```text
Web driver: phone → Socket.io → AgentSession → Agent SDK → local claude CLI → workspace
CLI driver:  terminal claude → transcript / hooks → server → read-only phone mirror
```

Both paths share persisted CLI session history, not a live TTY. While the terminal CLI is driving, the Web app can only see content that has reached disk. Hooks accelerate “turn ended / needs you” signals; they do not make the terminal process a bidirectionally attached session. Before Web takes over, it waits for the terminal turn to end and absorbs external transcript growth before sending.

See the [architecture guide](docs/architecture.en.md) for the component diagram, message flow, single-driver transitions, and reconnect replay.

## Documentation

- [Getting Started](docs/getting-started.en.md): from clone to the first message sent from your phone.
- [Deployment and operations](docs/deployment.md) (Chinese): Cloudflare Tunnel, Access, LaunchAgent, and systemd.
- [Architecture](docs/architecture.en.md): Web/CLI paths, event envelopes, and takeover boundaries.
- [Hard rules and tech debt](docs/hard-rules.md) (Chinese): n=1 tradeoffs, invariants, and deferred work (maintainers).
- [Display contracts](docs/display-contracts.md) (Chinese): sources of truth for model, effort, and status-line display.
- [Repository map](docs/repository-map.md): entrypoints, directory roles, and the complete file inventory.
- [Environment template](.env.example): every runtime setting and its default.
- [Security policy](SECURITY.md): private vulnerability-reporting instructions.

## Usage and compatibility

As of **2026-07-31**, Agent SDK, `claude -p`, and third-party Agent SDK apps still draw from Claude subscription usage. Anthropic's previously announced separate-credit plan is paused. This policy may change; check the [official notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

API-key and third-party-gateway costs and limits are set by their providers. The recorded claude CLI version is only a release-verification environment; check [Releases](https://github.com/Ike-li/claude-chat-mobile/releases) before upgrading.

## License

[GNU AGPL-3.0-only](LICENSE) © 2026 Ike-li, with Section 7 additional terms; see [NOTICE](NOTICE).

You may use, study, modify, and self-host this software. If you offer a modified version as a network service, the AGPL requires you to make the corresponding source available. The additional terms also require attribution and prohibit misrepresenting the project's origin.

## Friend Links

- [LINUX DO](https://linux.do/)
