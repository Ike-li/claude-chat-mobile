# Claude Chat Mobile

This is a self-hosted "remote console for Claude Code" that runs on your own machine: it puts your local `claude` CLI agent sessions into a chat UI on your phone or browser.

No database, no multi-tenancy, no SaaS backend — state lives on local disk and in process memory.

[中文](README.md) · **English** · [🌐 Website](https://ike-li.github.io/claude-chat-mobile/)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Agent SDK](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FIke-li%2Fclaude-chat-mobile%2Fmaster%2Fpackage.json&query=%24.dependencies%5B%22%40anthropic-ai%2Fclaude-agent-sdk%22%5D&label=Agent%20SDK&color=blue)](https://code.claude.com/docs/en/agent-sdk/overview)
[![tested with claude CLI](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FIke-li%2Fclaude-chat-mobile%2Fmaster%2Fpackage.json&query=%24.verifiedWith.claudeCli&label=tested%20with%20claude%20CLI&color=blue)](#prerequisites)
[![PWA](https://img.shields.io/badge/PWA-installable-blueviolet.svg)](#quick-start)
[![CI](https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml/badge.svg)](https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml)

## Product shape at a glance

```
Phone PWA / browser
    ↕ Socket.io (authenticated, joins the approved room)
Local Node server (server.js → src/server/app.js)
    ↕ Agent SDK query()
Local claude CLI child process (cwd = one allowlisted workspace)
    ↕ reads / writes
transcripts and session files under ~/.claude
```

The goal is not "another AI chat product" but **using your local Claude Code remotely and equivalently**: send messages, watch streaming output, approve tools, interrupt, resume sessions, switch model / permission mode / effort.

What it solves: **staying able to operate local Claude Code safely, and close to terminal-equivalently, when you are not at the computer.**

Only one side drives a session at a time. Web-driven messages travel through the Agent SDK into the local CLI; when the terminal CLI is driving, the Web app follows the persisted transcript in read-only mode, and the two sides cannot both type into one live process. While the terminal is still running you can explicitly force a takeover (behind a confirmation that spells out the fork risk) — that only lifts the read-only lock on the phone side; it does not stop the terminal process. See the [architecture guide](docs/architecture.en.md) for the component diagram, message flow, single-driver transitions, and reconnect replay.

## Core capabilities

- **Sessions and workspaces**: resume, fork, and remove CLI sessions at two levels; a cross-session "needs you" view; multiple workspaces and sessions in parallel. One message per turn — while a task runs you can keep a draft, but the send control becomes Stop instead of queuing another message.
- **Conversation and files**: streaming Markdown, syntax highlighting, tool cards, Edit/Write diffs, Read excerpts, a native `AskUserQuestion` picker; image and file uploads, pasted screenshots, historical attachment previews, composer `@` file references; browse project files inside approved workspaces and edit them directly in CodeMirror.
- **Notifications**: Web Push / ntfy for approvals, questions, and results, defaulting to type-only text, with a delivery-path test and an optional content preview; an optional CLI hooks bridge upgrades terminal "turn ended / needs you" from polling to an immediate signal.
- **Visibility**: API errors, retry countdowns, SDK notices, subagents, and background-task progress appear in the UI rather than only in server logs.
- **Reliability and operations**: `seq + epoch` event deduplication and reconnect replay; the status line picks SDK or CLI snapshots according to the current driver; startup checks with `doctor`, an in-app security check, redacted logs, auth rate limits, a service-status panel, and authenticated `/health` and `/metrics`. All configuration lives in a single `ccm.config.json` that the CLI (`config.js`) and the GUI both read and write.
- **Configuration entry points**: headless use `node scripts/config.js`; macOS additionally has an optional desktop console (menu bar icon plus a main window) with an embedded config form, logs, doctor, and service installation — **no terminal needed**, and configuration stays editable while the server is down.
- **Form factor**: an installable PWA with complete Chinese and English UI coverage; browser dependencies are self-hosted with the project instead of loaded from a CDN.

## Prerequisites

- **Node.js 20 or newer.**
- **A locally installed and authenticated `claude` CLI.** Confirm that `which claude` finds it and that a terminal conversation works.
- **macOS or Linux** are first-class platforms. Native Windows is experimental; WSL2 is the safer route.
- Claude subscriptions and third-party gateways are both supported. Gateway `ANTHROPIC_*` variables must exist in the **shell that starts the server**; values placed in the config file are stripped.
- As of **2026-07-31**, the Agent SDK and `claude -p` still draw from Claude subscription usage, and Anthropic's previously announced separate-credit plan is paused (policy may change; check the [official notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). API-key and third-party-gateway costs and limits are set by their providers.

## Quick Start

```bash
git clone https://github.com/Ike-li/claude-chat-mobile.git
cd claude-chat-mobile

node --version && which claude   # check against the prerequisites above
npm install --omit=dev
npm run setup                    # creates AUTH_TOKEN; asks for WORK_DIR, the CLI hooks bridge, and (macOS) the desktop console
node scripts/doctor.js
npm start

# on the first connection from a non-local address, approve the device from another terminal
node scripts/device.js list
node scripts/device.js approve <ID>
```

The startup log prints a tokenized LAN URL that you can open on your phone. For the complete first-run flow, non-interactive setup, a copyable coding-agent prompt, PWA setup, and bridge configuration, see the [Getting Started guide](docs/getting-started.en.md).

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
3. **Keep workspace scope narrow.** `WORK_DIR` and `WORKDIRS` are the scope gate for files, sessions, and git operations. Do not expose your whole home directory for convenience.
4. **Automatic approval inherits CLI configuration.** `permissions.allow` rules from `~/.claude/settings.json`, project `.claude/settings.json`, and `.claude/settings.local.json` apply here too. Review accumulated Bash/Write rules before public use.
5. **Device trust is a second gate.** Except for local connections or requests validated by Cloudflare Access JWT, a valid token still needs one-time device approval. Revoke a device with `node scripts/device.js deny <ID>`.
6. **The file editor is a direct user write.** It does not pass through the Agent tool-approval chain. It can only modify existing files up to 256KB and applies scope checks, content-hash conflict detection, and audit logging. Set `FILE_EDIT=off` for read-only browsing.

Report vulnerabilities privately through [GitHub Security Advisories](SECURITY.md), not a public issue.

## Documentation

- [Getting Started](docs/getting-started.en.md): from clone to the first message sent from your phone.
- [Deployment and operations](docs/deployment.md) (Chinese): Cloudflare Tunnel, Access, LaunchAgent, and systemd.
- [Architecture](docs/architecture.en.md): Web/CLI paths, event envelopes, and takeover boundaries.
- [Hard rules and tech debt](docs/hard-rules.md) (Chinese): n=1 tradeoffs, invariants, and deferred work (maintainers).
- [Display contracts](docs/display-contracts.md) (Chinese): sources of truth for model, effort, and status-line display.
- [Repository map](docs/repository-map.md): entrypoints, directory roles, and the complete file inventory.
- **Settings reference**: `node scripts/config.js schema` — every setting, type, and default, generated from the schema so it can never drift from the code.
- [Security policy](SECURITY.md): private vulnerability-reporting instructions.

## License

[GNU AGPL-3.0-only](LICENSE) © 2026 Ike-li, with Section 7 additional terms; see [NOTICE](NOTICE).

You may use, study, modify, and self-host this software. If you offer a modified version as a network service, the AGPL requires you to make the corresponding source available. The additional terms also require attribution and prohibit misrepresenting the project's origin.

## Friend Links

- [LINUX DO](https://linux.do/)
