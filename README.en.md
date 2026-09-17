# Claude Chat Mobile

<p align="center">
  <strong>The Claude Code on your computer — keep driving it from your phone.</strong><br>
  Approvals · questions · resume sessions · the control plane stays on your own machine
</p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="https://ike-li.github.io/claude-chat-mobile/">Website</a> ·
  <a href="https://ike-li.github.io/claude-chat-mobile/diagrams/">Architecture diagrams</a><br>
  <a href="https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml"><img src="https://github.com/Ike-li/claude-chat-mobile/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node >= 20">
</p>

![Bring the claude in your terminal to your phone](https://ike-li.github.io/claude-chat-mobile/assets/hero-zh.jpg)

<p align="center">
  <img src="https://ike-li.github.io/claude-chat-mobile/screenshots/01-stream-en.png" width="23%" alt="Streaming Claude output on the phone">
  <img src="https://ike-li.github.io/claude-chat-mobile/screenshots/02-tools-en.png" width="23%" alt="Tool calls and file changes, readable on the phone">
  <img src="https://ike-li.github.io/claude-chat-mobile/screenshots/03-approval-en.png" width="23%" alt="Approving a tool call from the phone">
  <img src="https://ike-li.github.io/claude-chat-mobile/screenshots/04-sessions-en.png" width="23%" alt="Every session in the workspace, including ones started in a terminal">
</p>

## What you do in the terminal, and how it works on the phone

Walking away from the desk, the fear isn't losing sight of the output — it's that **it stalls on something that needs you and waits all night**. So these three first:

| In the terminal | On the phone |
| --- | --- |
| **Tool approval** (y / n) | An approval card: Allow / Deny / **Interrupt turn** (mirrors `Esc`). Tick "always allow" and pick this session only, or permanently |
| **It asks you something** (`AskUserQuestion`) | Tap the option. Multi-select, a free-form "Other…", and "skip and interrupt turn" are all there |
| **Did it finish, or is it stuck?** | Pushed to your lock screen. Approvals, questions and background-task completions are pushed **unconditionally**, whether or not you have it open |

The rest is about getting work done:

| In the terminal | On the phone |
| --- | --- |
| `claude` for a new session / `--resume` to dig through history | `+` in the top bar: pick the workspace, the branch, whether to open it in a fresh worktree. The drawer lists every session in that workspace — titles generated for you, searchable, live ones marked "running" |
| `Esc` to interrupt | Stop button in the composer |
| `/model`, permission mode, effort | Tap the composer chip; takes effect from the next message. All six permission modes |
| `@` to reference a file | Type `@` to search the workspace and insert the path |
| `/` slash commands | Type `/` for candidates, including the skills you installed |
| Seeing what it actually changed | Open a tool card to preview the diff; each turn ends with a changed-files summary (± lines) |
| A quick `git diff` | The "Changes" tab in the workspace panel |
| Rewind or branch off | Long-press a message: **rewind** restores the workspace files to before that message and forks a new session from that moment; **fork** copies the conversation only, leaving files alone. The original session survives either way |
| Glancing at the statusline | Always-on summary in the composer. Expand for model / branch / ctx usage / **5h and 7d quota usage with reset countdowns** / estimated spend, copyable in one tap |
| Watching background tasks | A task banner; stop any single one |
| **That session you left open in the terminal** | Visible, and you can take the wheel — one driver at a time, and it warns you on takeover |

Also: image upload and screenshot paste, event catch-up after a reconnect, PWA install to the home screen, a `doctor` startup self-check, and an optional macOS desktop console.

## How it differs from official Remote Control

**If you can use official [Remote Control](https://code.claude.com/docs/en/remote-control) and accept its account and data path, use it** — zero deployment, and it is the default recommendation. This project is for people the official path refuses, or whose control plane they cannot accept. The first group typically points the `claude` CLI at a relay, a third-party model or a non-Anthropic one, which shuts the official door outright; the second needs session records and audit logs to stay on their own machine.

|  | Official Remote Control | Claude Chat Mobile |
| --- | --- | --- |
| **Model path** | Requires a claude.ai sign-in and a direct connection to `api.anthropic.com`. API keys, Bedrock / Google Agent Platform / Microsoft Foundry, an `ANTHROPIC_BASE_URL` pointing elsewhere, telemetry switches like `DISABLE_TELEMETRY`, ZDR organizations — any one of these rules it out entirely | Whatever your `claude` CLI is configured with — third-party gateway / API key / Bedrock / Vertex / telemetry disabled all work |
| **Control-plane data** | Session transcripts are stored on Anthropic's servers for cross-device sync | Service, transcripts, device trust and audit logs all stay on your machine; fully self-contained on a LAN |
| **What you can see** | Only sessions you explicitly enabled Remote Control on (or new ones once auto-connect is on); `/resume` is terminal-only, so you cannot browse session history from a phone | **Every** session in your allowlisted workspaces — started in a terminal, left over from last week, all visible and resumable |
| **Driving one session from both ends** | Yes — send from terminal, web or phone interchangeably | **No** — single-driver model; the web side must explicitly take over, and that can fork the session |
| **Deployment cost** | None | You run a server yourself |

> A note on wording: this is not "data never leaves your machine" — model requests are still sent by the local `claude` CLI using your existing configuration. What CCM promises is that it adds **no additional** data egress beyond that.

CCM makes no assumption about where it runs: wherever your `claude` CLI works, the control plane follows. Your own dev machine is the main case; a remote server works just the same, with your phone connecting to that server.

## Three steps to run it

You need Node.js ≥ 20 and a working local `claude` CLI. This project **does not** install or sign you into Claude.

```bash
curl -fsSL https://github.com/Ike-li/claude-chat-mobile/archive/refs/heads/master.tar.gz | tar xz
cd claude-chat-mobile-master
npm ci --omit=dev && npm run setup && npm start
```

Open the address printed in the terminal on your phone. The first time a new device connects it needs one approval: `node scripts/device.js list`, then `approve <ID>`. Typing a 64-character token on a phone is painful — `node scripts/qr.js` renders the address as a terminal QR code.

> **A running server ≠ a working chat.** CCM's token and device approval only decide whether the phone gets into the shell; **whether `claude` in your host terminal can complete one normal turn** decides whether you can actually talk. A Claude subscription needs that host signed in; a third-party gateway does not use Anthropic login and will **never** show `Not logged in` — it needs `ANTHROPIC_*` to actually take effect. A specific CLI error reaching your phone is good news: the link itself works. Both cases converge on one action: **get `claude` through a turn in your host terminal, then retry from the phone.** Full checklist: [Getting Started §8](docs/getting-started.en.md#8-complete-the-first-run-check).

To change code or run tests, `git clone` the full repository instead. Configuration, non-interactive setup, PWA, CLI hooks and **how to update**: **→ [Getting Started](docs/getting-started.en.md)**

## How it works

```text
Phone PWA / browser ↕ Socket.io ↕ CCM Server (local) ↕ Claude Agent SDK ↕ local claude CLI
```

The phone is only a **remote control plane**. What actually executes code, reads the project, calls tools and maintains sessions is still the Claude Code on your computer — no database, no multi-tenancy, no SaaS backend.

**One boundary worth knowing**: a live session has exactly one driver at a time. While the terminal is driving, the Web side is read-only by default; you can explicitly resume from the Web, but that may fork the session. The two never type into the same live Claude process at once.

Dual path, event sync, session takeover: **→ [Architecture guide](docs/architecture.en.md)**

## Remote access

| Scenario | Method |
| --- | --- |
| Same Wi-Fi | LAN address — the simplest first run |
| Temporary public | Cloudflare Quick Tunnel, ngrok, other hosted tunnels |
| Long-term public | fixed domain + Cloudflare Tunnel + Access |
| Off Cloudflare | Tailscale (recommended, HTTPS included), other encrypted tunnels / VPNs, self-hosted reverse proxy |

The setup wizard asks how your phone will reach this machine; the answer is stored as `ACCESS_PROFILE`, and `doctor` plus the on-phone security check tailor themselves to it. The product never installs third-party tunnel tools — it only points to the docs. PWA install and Web Push require HTTPS (on iOS also 16.4+ and installing to the Home Screen first).

**→ [Deployment and operations](docs/deployment.md)** (Chinese)

## Security Model

> **This is an entry point that can reach the Claude Code on your machine remotely, and through it indirectly obtain local code execution.** Treat it as a remote control tool for a development machine, not as an ordinary web page.

1. **Single user.** There is no multi-user or tenant isolation; an authenticated operation carries the permissions of the local account running `claude`.
2. **No token, no server.** `AUTH_TOKEN` is a startup prerequisite under every bind mode — even a browser on this machine needs it. There is no "local means no auth" path.
3. **Workspaces are explicitly allowlisted.** Files, sessions and related operations can only reach the configured `WORKDIRS`. Do not add your whole home directory for convenience.
4. **New devices need trust.** Except for local connections and those already validated by the optional public identity layer (currently Cloudflare Access), a device holding the correct token still needs one approval. Note: **when Access is on it replaces device approval**, so the trust list does not govern connections arriving through it; set `DEVICE_APPROVAL_SCOPE=all` to make approval apply to every path.
5. **Claude Code permissions are inherited.** Existing rules such as `permissions.allow` stay in effect; review your automatic Bash / Write approvals before public use.
6. **The file editor is a direct write.** It **does not pass through the Agent tool-approval chain** (it does enforce scope checks, a size limit, content-hash conflict detection and audit logging). Set `FILE_EDIT=off` to disable it; turning it off is recommended for long-term public exposure.

Read [deployment and operations](docs/deployment.md) (Chinese) before exposing it publicly for the long term. Report vulnerabilities privately through [GitHub Security Advisories](SECURITY.md), not a public issue.

## Docs

* **[Getting Started](docs/getting-started.en.md)** — from install to your phone's first message; configuration, updating, command reference
* **[Deployment and operations](docs/deployment.md)** (Chinese) — LAN to long-term public entry points, Cloudflare Tunnel / Access, off-Cloudflare alternatives
* **[Architecture guide](docs/architecture.en.md)** · [Architecture diagrams](https://ike-li.github.io/claude-chat-mobile/diagrams/)
* [Hard rules and tech debt](docs/hard-rules.md) (Chinese) · [Display contracts](docs/display-contracts.md) (Chinese) · [Security policy](SECURITY.md)

Config keys and commands are not maintained as static lists: `node scripts/config.js schema` prints the current definitions, and every CLI prints its own usage when run without a subcommand.

## Community and feedback

Bugs and feature requests go to [GitHub Issues](https://github.com/Ike-li/claude-chat-mobile/issues); security vulnerabilities go to [Security Advisories](SECURITY.md).

> ⚠️ Never paste your `AUTH_TOKEN`, public domain, full `ccm.config.json` or raw `doctor` output into a public channel — those are enough for someone to take over your machine.

## License

[Apache-2.0](LICENSE) © 2026 Ike-li. See also [NOTICE](NOTICE). You may use, study, modify, self-host and redistribute it, including commercially and in closed-source products, as long as you keep the copyright notice and the NOTICE attribution. Versions up to and including v1.10.2 were released under AGPL-3.0-only; the change is not retroactive.
