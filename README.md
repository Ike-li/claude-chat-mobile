# Claude Chat Mobile

> Use your real local `claude` CLI from your phone — as if you were sitting at your own terminal.

**English** · [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![PWA](https://img.shields.io/badge/PWA-installable-blueviolet.svg)](#quick-start)

**Built for people who already use the `claude` CLI in their terminal.** It does **not** bundle Claude and is **not** a re-implementation — it drives your real local CLI through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), so you get the same agent, the same `CLAUDE.md`, the same MCP servers, skills, hooks, and logged-in session you use at your desk. The goal is **terminal equivalence**: typing to claude on your phone behaves exactly like typing at your computer — edit code, run commands, resume an earlier conversation — except now you can do it from bed.

<p align="center">
  <img src="docs/demo.gif" width="300" alt="Stream a reply, watch tool cards, then approve a git push from your phone">
</p>

> ⚠️ At its core, this is **a remotely reachable code-execution channel straight into your local shell.** Before exposing it to the public internet, read the [Security Model](#security-model) below.

> ℹ️ **Personal project, provided as-is.** No guaranteed maintenance or support. Use it freely, at your own risk.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/01-stream.png" width="240" alt="Streaming output with Markdown rendering"></td>
    <td align="center"><img src="docs/screenshots/02-tools.png" width="240" alt="Tool-call cards"></td>
    <td align="center"><img src="docs/screenshots/03-approval.png" width="240" alt="Dangerous actions approved from the phone"></td>
  </tr>
  <tr>
    <td align="center"><b>Streaming</b><br/>Markdown · syntax highlight · status line</td>
    <td align="center"><b>Visible process</b><br/>tool calls render as collapsible cards</td>
    <td align="center"><b>Approve on phone</b><br/>dangerous actions push full command + cwd</td>
  </tr>
</table>

## Prerequisites

- **Node.js ≥ 20** — check with `node --version`.
- **A working `claude` CLI on the host.** This project drives *your* local CLI; it ships nothing of its own. Confirm `claude` runs in your terminal first (`which claude`, then open a conversation to confirm you are logged in) — the web UI inherits exactly this CLI, your `CLAUDE.md`, MCP servers, skills, hooks, and shell environment.
- **Provider / gateway follows your terminal.** The web side reuses the same provider, gateway, and model your terminal `claude` uses — official subscription or a third-party gateway alike (third-party via `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` `export`ed in the launching shell). **These may only come from the launching shell, never from `.env`** (`ANTHROPIC_*` in `.env` is stripped at startup to keep web and terminal from diverging); see [docs/configuration.md](docs/configuration.md).
- **macOS or Linux.**

## Quick Start

```bash
npm install
cp .env.example .env   # set AUTH_TOKEN (required for any non-localhost access), WORK_DIR, allow-list

# Recommended: pre-flight your config (port in use, CLAUDE_BIN path, gateway env, file perms)
node scripts/doctor.js        # check config
node scripts/doctor.js --fix  # tighten perms (.env and data/*.json → 0600)

npm start                     # http://localhost:3000
```

Then open it on your phone — two ways (the startup log prints ready-to-use URLs with the token pre-filled):

- **Same WiFi:** open the LAN address printed at startup (`http://<lan-ip>:3000/#token=…`) — no tunnel needed.
- **Public internet / install as a PWA** (PWA needs https): run a tunnel in another terminal:

```bash
cloudflared tunnel --url http://localhost:3000
# On your phone open https://<random>.trycloudflare.com/#token=<YOUR_AUTH_TOKEN>
# The token is stored in localStorage on first load, then cleared from the address bar.
```

> ⚠️ With no `AUTH_TOKEN` set, the server binds to `127.0.0.1` only and cannot be reached through a tunnel — this is deliberate.
>
> 📌 The above is the **minimal setup** (temporary random tunnel, testing only). For a **stable production deployment** — fixed domain, Cloudflare Access two-factor, running as a background daemon — see [docs/deployment.md](docs/deployment.md).

## Three ways to run it

Pick one for your situation — commands are in [Quick Start](#quick-start) above and [docs/deployment.md](docs/deployment.md):

| Mode | Good for | Cost |
|---|---|---|
| **LAN, same WiFi** — `http://<lan-ip>:3000/#token=` | At home, phone and computer on one network | Useless when out; no tunnel, least fuss |
| **Temporary public** — `cloudflared tunnel --url` (random domain) | Quick trial / demo | Address changes on every restart; testing-only per Cloudflare |
| **Fixed production** — fixed domain + Cloudflare Access 2FA + daemon | Long-term, anywhere access | One-time DevOps setup, see [docs/deployment.md](docs/deployment.md) |

## Security Model

> **Read this before exposing it to the public internet.** At its core this is a remotely reachable code-execution channel straight into your local shell. Security is the first concern, not an afterthought:

1. **Single-user tool (n = 1).** You are the only user and the only admin. There is no multi-user / login system; any request that passes auth has exactly the same power as you sitting at the terminal.
2. **No token, no leaving the host.** With no `AUTH_TOKEN` set, the server binds to `127.0.0.1` only — there is no "empty = open to the world" path. Reaching the public internet *requires* a token.
3. **Two-layer permission gate — zero injection, pure inheritance of your CLI.** This project injects no allow/deny lists of its own (no `allowedTools` / `disallowedTools` in the code). The auto-approve set is exactly the merged `permissions.allow` from your existing claude config — global `~/.claude/settings.json` + project `.claude/settings.json` + local `.claude/settings.local.json` together (loaded via `settingSources`, same source as your terminal). A match is auto-approved; anything else is suspended and pushed to your phone as an approval request (with the full command and working directory) to run only after you confirm.
   - ⚠️ **Before exposing publicly, audit your global `~/.claude/settings.json` allow-list** — years of accumulated `Bash(...)` / `Write` rules in your terminal will auto-approve here too without a phone prompt, so it is not just the project's list you need to tighten.
4. **Device trust (TOFU).** A connection that is neither local nor Cloudflare Access-verified must be authorized once on your computer before it can do anything — a valid token alone is not enough ([ADR-0018](docs/decisions.md#adr-0018)).

The full threat model and hardening guidance is in [docs/design.md](docs/design.md) §4.

## Cost Note

> **Know this before you adopt it.**

**Currently (as of 2026-06-26): Agent SDK / `claude -p` usage still draws from your subscription quota, in the same pool as interactive use** — using this project on the official subscription path incurs no separate billing.

Background: Anthropic once announced that, starting 2026-06-15, SDK *headless* usage would move to a separate credit pool (Max 5x $100/month at API rates), but **that change was paused on the day it shipped and never took effect** ([official Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). Anthropic says it will rework the plan and give advance notice — this is a **pause, not a cancellation**.

- **Potential risk**: if the policy is revived, this project's SDK usage (personally measured at roughly **~$716/month** equivalent at API rates) would move out of the subscription quota and could hit a separate credit cap. Budget for it then.
- **Via a third-party gateway** (`ANTHROPIC_*` exported in the shell): unaffected — you pay the gateway's own rates.

## Features

Beyond the core loop above:

- **Five permission modes** (default / plan / acceptEdits / bypassPermissions / dontAsk), switchable at runtime.
- **Per-message model switching** (gateway-suffixed names supported).
- **Multi-repo and multi-session** — switch among allow-listed working directories, run several sessions concurrently in tabs.
- **File and image upload**, with path injection and traversal protection.
- **Thinking-effort control**, a **web-native status line**, and **`AskUserQuestion`** as a native picker.
- **Web Push** for approvals, questions, and results (iOS 16.4+ requires Add to Home Screen first).
- **Ops & security hardening** — log sanitization, `0600` atomic writes, a `doctor` startup self-check, optional Cloudflare Access 2FA.

## Documentation

**Daily use and deployment:**

| Doc | Contents |
|---|---|
| [docs/design.md](docs/design.md) | North star, terminal-equivalence checklist, security model, acceptance scripts |
| [docs/configuration.md](docs/configuration.md) | All environment variables (single source of truth) |
| [docs/deployment.md](docs/deployment.md) | Production deployment template |

**For forking / changing the code (internal reference):**

| Doc | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Architecture deep-dive: design philosophy, defense in depth, AgentSession internals, concurrency model |
| [docs/event-contract.md](docs/event-contract.md) | Front/back-end event contract |
| [docs/decisions.md](docs/decisions.md) | Architecture Decision Records (ADR 0001-0018) |

**Suggested reading order for the code**: [docs/design.md](docs/design.md) §0 north star + [docs/event-contract.md](docs/event-contract.md) → `server.js` → `agent.js`'s `map()` and `askPermission()` → `public/js/app.js`'s `handle` dispatch table.

## Project Status

A personal, single-user (n=1) tool, open-sourced for reference — not a community project. The maintainer commits straight to `master`; there is no contribution process, issue triage, or support commitment. Fork freely. The deliberate constraints (no lint / test framework / build step / CI) and the security invariants are recorded in [docs/design.md](docs/design.md) and [CLAUDE.md](CLAUDE.md).

## How it works (read only if you want to read or fork the code)

A "transparent pipe, locked by default": it projects **your local claude CLI** (carrying your CLAUDE.md / MCP / skills / login state) to a phone browser — continuous sessions, visible process, dangerous actions bounced back to the phone for approval.

```mermaid
graph LR
    subgraph Phone
        UI[public/ single page<br/>chat bubbles · tool cards · approval sheet]
    end
    subgraph Internet
        CF[Cloudflare Tunnel]
    end
    subgraph Host
        S[server.js<br/>Express static + Socket.IO contract layer<br/>auth · preflight · device trust · handler guard]
        A[agent.js · AgentSession<br/>long-lived SDK query · permission gate<br/>event envelope seq+epoch · ring buffer]
        J[(data/sessions.json<br/>session metadata)]
        SDK[claude-agent-sdk]
        CLI[local claude CLI<br/>loads your full config]
        FS[(your project files<br/>WORK_DIR)]
    end
    UI <-->|"agent:event envelope / user:* events<br/>(event contract, WebSocket)"| CF <--> S
    S <--> A
    A <-->|streaming input| SDK <-->|spawn| CLI <--> FS
    S --- J
```

### A message's journey

1. Phone `user:message {text}` → server validates → routes to the target instance `agents.get(instanceId)` (lazy-respawned resume; after `session:new` a FRESH instance is lazily opened only on the first message — ADR-010 stage 3).
2. The text is pushed into the AgentSession's streaming input → SDK → claude CLI works in `WORK_DIR`.
3. The SDK message stream flows into `map()`: streaming text → `text_delta`, tool calls → `tool_use`/`tool_result`, off-allow-list actions → `permission_request` (suspended, awaiting allow/deny on the phone).
4. Each event is wrapped in a `{seq, epoch, sessionId, instanceId, cwd, ts, type, payload}` envelope → into a 500-entry ring buffer → `io.emit` broadcast (the front-end demuxes by `viewingInstanceId`; high-frequency deltas from background tabs are not broadcast to save bandwidth).
5. Phone reconnects: `sync:since {lastSeq}` replays the buffer; an `epoch` change means the server swapped the instance, so the client resets its dedup baseline automatically.

### Back-end files (11 `.js`)

The core four are the trunk; the other seven are capability / hardening modules that grew as needed:

| File | Responsibility | Key point |
|---|---|---|
| `server.js` | Contract layer: Socket.IO routing, auth, static hosting, startup preflight | Every handler wrapped in `on()` to prevent crashes; localhost-only with no `AUTH_TOKEN` |
| `agent.js` | Session bridge: `AgentSession` wraps one long-lived SDK query | `canUseTool` approval gate, `map()` translates SDK messages into contract events, idle watchdog |
| `sessions.js` | The only persistent state: atomic read/write of `data/sessions.json` | Stores metadata only (id/title/model); message content's source of truth is claude's own JSONL |
| `history.js` | CLI JSONL reading: session-list scan + history replay | Reads `~/.claude/projects/<project>/`, list isolated by cwd |
| `uploads.js` | File/image upload: persist to `.ccm-uploads` + path injection + traversal guard | O_EXCL/O_NOFOLLOW + landing-point validation |
| `statusline.js` | Web-native status line: SDK data + local git, assembled structurally | Works out of the box, calls no scripts/snapshots |
| `sanitizer.js` | Log sanitization: 15 sensitive patterns + `maskToken` | Applied to interaction logs, stderr, startup printouts |
| `file-security.js` | File safety: 0600 atomic write (tmp→fsync→rename) + symlink guard | Config files protected from other local users |
| `interaction-log.js` | Optional interaction log: enabled by `LOG_INTERACTIONS=1` | Four-hop content summaries, sanitized + truncated; off by default |
| `cf-access.js` | Cloudflare Access JWT verification: fail-closed public auth | Forces JWT over the CF tunnel, never falls back to token |
| `devices.js` | Device management: load/persist trusted and pending fingerprints | TOFU device trust (ADR-018) |

Runtime dependencies: `@anthropic-ai/claude-agent-sdk`, `express`, `socket.io`, `dotenv`, `web-push`, `jose`. Front-end third-party libraries are self-hosted locally in `public/vendor/` (Tailwind/marked/highlight.js/DOMPurify), with zero CDN dependency — see [public/vendor/THIRD-PARTY-NOTICES.md](public/vendor/THIRD-PARTY-NOTICES.md).

## License

[MIT](LICENSE) © 2026 Ike-li
