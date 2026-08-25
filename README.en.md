# Claude Chat Mobile

**Bring the Claude Code on your computer to your phone.**

Claude Chat Mobile is a **self-hosted remote console for Claude Code that runs on your own machine**. It puts your local `claude` CLI sessions into a chat UI on your phone or browser, so that after you walk away from the computer you can still start or resume a session, watch task progress, answer questions, approve tool calls, and interrupt a task.

Your code, the Claude CLI, your project files, and the local CCM / Claude session state all keep running or living **on your own computer**. There is no database, no multi-tenancy, and no SaaS backend; model requests are still sent by the local `claude` CLI using your existing Anthropic sign-in or third-party gateway configuration.

[中文](README.md) · **English** · [🌐 Website](https://ike-li.github.io/claude-chat-mobile/)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Agent SDK](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FIke-li%2Fclaude-chat-mobile%2Fmaster%2Fpackage.json&query=%24.dependencies%5B%22%40anthropic-ai%2Fclaude-agent-sdk%22%5D&label=Agent%20SDK&color=blue)](https://code.claude.com/docs/en/agent-sdk/overview)
[![tested with claude CLI](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FIke-li%2Fclaude-chat-mobile%2Fmaster%2Fpackage.json&query=%24.verifiedWith.claudeCli&label=tested%20with%20claude%20CLI&color=blue)](#prerequisites)
[![PWA](https://img.shields.io/badge/PWA-installable-blueviolet.svg)](#quick-start)
[![CI](https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml/badge.svg)](https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml)

## Why you might want it

Claude Code can keep working through a development task on your computer, but when it hits a question, a tool approval, or a decision that needs a human, you normally have to be back at the desk.

Claude Chat Mobile moves that part of the interaction to your phone:

```text
Claude Code is working on your computer
        ↓
You walk away
        ↓
Check progress / answer a question / approve a tool / interrupt — from your phone
        ↓
Claude Code keeps running on the original computer
```

The goal is not to rebuild an AI chat product, but:

> **to let you operate the Claude Code on your own machine safely and close to terminal-equivalently while you are away from it.**

## Who is it for

If you already use Claude Code and any of these apply, Claude Chat Mobile is probably a fit:

* you do not want to sit at the desk the whole time Claude runs a long task;
* you want to keep watching progress and interacting after you have left;
* you want to answer `AskUserQuestion` or approve tool calls from your phone;
* you want a notification when a task finishes or needs a human;
* you want to keep using the projects, Claude CLI configuration, and development environment on your original machine;
* you want to own the service and the data rather than move a whole development environment into someone else's SaaS.

It is probably **not** a fit if:

* you just want ordinary chat with Claude on your phone;
* you do not currently use Claude Code;
* you want to sign up and start using it without running a service on your own computer.

## Core capabilities

* **Remote control of Claude Code**: start and resume sessions, watch streaming output, answer questions, approve tools, stop tasks, switch model / permission mode / effort.
* **Sessions and workspaces**: multiple workspaces and sessions, including resuming Claude CLI sessions that already exist on the machine.
* **Working with project content**: view tool calls, Edit / Write diffs and Read output; browse and edit files inside approved workspaces; upload files and images, and paste screenshots.
* **Notifications**: approvals, questions, and task results over Web Push / ntfy, with an optional Claude CLI hooks bridge.
* **Reconnect recovery**: after the phone loses network and reconnects, missing session events are filled in.
* **Local operations**: a `doctor` startup self-check; on macOS, an optional desktop console for configuration, logs, services, and device approval.
* **PWA**: installable to the phone home screen, with full Chinese and English UI.

## How it works

```text
Phone PWA / browser
        ↕
     Socket.io
        ↕
Claude Chat Mobile Server
      (local machine)
        ↕
 Claude Agent SDK
        ↕
local claude CLI
        ↕
project files / Claude sessions
```

The phone and the browser are only a **remote control surface**.

Executing code, reading the project, calling tools, and maintaining Claude sessions all still happen in the Claude Code on your computer.

### One boundary worth understanding

A live Claude session has exactly one driver at a time.

While the terminal is driving, the Web side is read-only by default; you can explicitly resume from the Web when you need to, but that may fork the session. The terminal and the Web never type into the same live Claude process at once.

See the [architecture guide](docs/architecture.en.md) for the full component relationships, the Web / CLI dual path, event synchronization, and session takeover.

## Prerequisites

You need:

* **Node.js 20 or newer**;
* a locally installed and working `claude` CLI;
* a signed-in Claude account, or a third-party gateway that already works;
* at least one project directory you are willing to let Claude Code operate on.

> ⚠️ One rule that is easy to miss with third-party gateways: the gateway's `ANTHROPIC_*` variables **must come from the shell that starts the server**. Values written into `ccm.config.json` are stripped at startup — the file says one thing, nothing takes effect, and nothing reports an error.

Platform support:

| Platform       | Status         |
| -------------- | -------------- |
| macOS          | first-class    |
| Linux          | first-class    |
| Windows + WSL2 | recommended    |
| Native Windows | experimental   |

Claude Chat Mobile **does not include Claude Code, and will not install or sign in to the Claude CLI for you**.

## Quick Start

If Claude Code already runs on your computer:

```bash
git clone https://github.com/Ike-li/claude-chat-mobile.git
cd claude-chat-mobile

node --version
which claude
claude auth status

npm install --omit=dev
npm run setup
node scripts/doctor.js
npm start
```

`npm run setup` walks you through generating a local configuration and setting the workspaces that may be accessed, and can optionally install the CLI hooks bridge; on macOS it can also install the desktop console.

Once it starts, the terminal prints a LAN address you can open on your phone.

The first time another device connects, you have to approve it:

```bash
node scripts/device.js list
node scripts/device.js approve <ID>
```

Then open the address from the startup log on your phone to enter a workspace and send Claude Code its first message.

> If the macOS desktop app already started a server, do not run a second `npm start`. Follow what `doctor` tells you and restart the service from the desktop menu instead.

Full first-run instructions — configuration, non-interactive setup, PWA, and CLI hooks:

**→ [Getting Started guide](docs/getting-started.en.md)**

## Remote access

Claude Chat Mobile supports everything from LAN access to a long-lived public entry point:

| Scenario         | Method                                      | Best for                       |
| ---------------- | ------------------------------------------- | ------------------------------ |
| Same Wi-Fi       | LAN address                                 | the simplest first run         |
| Temporary public | Cloudflare Quick Tunnel                     | trials and demos               |
| Long-term public | fixed domain + Cloudflare Tunnel + Access   | regular access from outside    |

PWA installation and Web Push require HTTPS; on iOS, Web Push also requires iOS 16.4+ and installing the site to the Home Screen first.

Fixed domains, Cloudflare Tunnel, Cloudflare Access, long-running setups, and day-to-day operations:

**→ [Deployment and operations](docs/deployment.md)** (Chinese)

## Security Model

> **Claude Chat Mobile is an entry point that can reach the Claude Code on your machine remotely, and through it indirectly obtain local code execution.**

Treat it as a remote control tool for a development machine, not as an ordinary web page.

Boundaries to understand before you use it:

1. **Single user.** There is no multi-user or tenant isolation; the permissions of an authenticated operation ultimately come from the local account running `claude`.
2. **No token means it is not exposed to the LAN.** Without `AUTH_TOKEN`, the server listens only on `127.0.0.1`.
3. **Workspaces are explicitly allowlisted.** Files, sessions, and related operations can only reach the configured `WORK_DIR` / `WORKDIRS`. Do not add your whole home directory for convenience.
4. **New devices need trust.** Except for local connections and connections already validated by Cloudflare Access, a device holding the correct token still needs one device approval.
5. **Claude Code permissions are inherited.** Existing Claude Code rules such as `permissions.allow` stay in effect; review your automatic Bash / Write approvals before public use.
6. **The file editor is a direct user write.** It **does not pass through the Agent tool-approval chain**. It can only modify existing files inside an approved workspace, with scope checks, a size limit, content-hash conflict detection, and audit logging. Set `FILE_EDIT=off` if you do not need it.

If you plan to expose it publicly for the long term, read [deployment and operations](docs/deployment.md) (Chinese) first.

Report security vulnerabilities privately through [GitHub Security Advisories](SECURITY.md), not a public issue.

## Documentation

### I want to get started

**[Getting Started guide](docs/getting-started.en.md)**
From a computer that already runs Claude Code, all the way to the first message sent from your phone; also covers configuration, migration, PWA, and CLI hooks.

**[Deployment and operations](docs/deployment.md)** (Chinese)
LAN, public access, Cloudflare Tunnel, Cloudflare Access, long-running setups, and routine operations.

Settings are not maintained as a separate static list — read the current definitions generated from the schema:

```bash
node scripts/config.js schema
```

### I want to understand how it works

**[Architecture](docs/architecture.en.md)**
Web / CLI dual path, the Agent SDK, event synchronization, reconnect recovery, and session takeover.

### I want to modify or maintain it

**[Hard rules and tech debt](docs/hard-rules.md)** (Chinese)
Architectural invariants, design tradeoffs, and what the project has decided not to do.

**[Display contracts](docs/display-contracts.md)** (Chinese)
Sources of truth and display rules for model, effort, and status-line information.

**[Repository map](docs/repository-map.md)**
Code entrypoints, directory ownership, and the repository file structure.

### Security

**[Security policy](SECURITY.md)**
How to report vulnerabilities.

## Community and feedback

* **Bugs and feature requests**: open a [GitHub Issue](https://github.com/Ike-li/claude-chat-mobile/issues). It is searchable and archived — the next person who hits the same problem can find the answer instead of asking again.
* **Security vulnerabilities**: report privately through [GitHub Security Advisories](SECURITY.md), not a public issue.
* **General discussion** (Chinese): QQ group **881200369** — scan the QR code below with the QQ mobile app, or [join from a desktop](https://qm.qq.com/q/9Bv2ZaSAUw).

<img src="https://ike-li.github.io/claude-chat-mobile/assets/qq-group-qr.png" alt="QQ group QR code for the CCM discussion group, group number 881200369" width="240">

> ⚠️ Redact before you paste anything into the group. Never paste your **`AUTH_TOKEN`, public domain, full `ccm.config.json`, or raw `doctor` output** — they are enough for someone to take over your machine, and group history is visible to every member including those who join later, so you cannot take it back.

## License

[GNU AGPL-3.0-only](LICENSE) © 2026 Ike-li, with Section 7 additional terms; see [NOTICE](NOTICE).

You may use, study, modify, and self-host this project. If you offer a modified version as a network service to other users, you must meet the AGPL's corresponding-source obligation; the additional terms also require attribution and prohibit misrepresenting the project's origin.

## Friend Links

* [LINUX DO](https://linux.do/)
