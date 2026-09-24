---
name: claude-chat-mobile
description: Self-hosted mobile web interface bridging terminal Claude Code CLI to phone browsers via Anthropic Agent SDK.
version: 2.1 (dev@3f488861)
license: Apache-2.0
repository: https://github.com/Ike-li/claude-chat-mobile
docs: https://ike-li.github.io/claude-chat-mobile/docs-site/
llms-txt: https://ike-li.github.io/claude-chat-mobile/llms.txt
---

# Claude Chat Mobile — Agent Capability & Architecture Card

AEO-optimized capability specification for AI agents (Cursor, Claude Code, Windsurf).
Read this card in <500 tokens to understand architecture, boundaries, configuration, and invocation paths.

## 1. What It Is & Positioning
- **What it does**: Bridges a locally configured `claude` CLI to mobile browsers as a touch-friendly PWA.
- **Terminal Parity**: "Typing on your phone is functionally identical to typing in your terminal". Same session, same transcripts, same `CLAUDE.md`, MCPs, skills, and tools.
- **Product Stance (n=1)**: Single-user, self-hosted. **Never multi-tenant**, no user accounts, no hosted SaaS. An authenticated remote user acts with the permissions of the local account running `claude`.

## 2. Core Architecture: Dual-Channel & Single-Driver
1. **Web Driving Channel**: Web client uses WebSocket (`agent:event` envelope with seq/epoch) -> Server `AgentSession` -> Agent SDK streaming input -> spawns `claude` CLI.
2. **CLI Terminal Driving Channel**: Direct terminal execution is mirrored read-only by polling local JSONL transcripts (`~/.claude/projects/`). Web input locks with `mirrorReadonly` to prevent transcript divergence.
3. **Takeover**: When terminal turns idle (>12.5s), Web safely resumes with `externalDirty` absorption.

## 3. Technology Stack & Key Constants
- **Runtime**: Node ≥20 · Pure ESM · Express 5 · Socket.IO 4 · `@anthropic-ai/claude-agent-sdk` (0.3.263 in release v1.12.1; 0.3.278 on dev) · `jose` 6 (JWT).
- **Protocols**: Outbound: 31 `agent:event` types; Inbound: 57 socket events in v1.12.1, 58 on dev (+`user:autoContinue`). Source of truth: `app/src/shared/protocol.js`.
- **Ring Buffer**: In-memory circular buffer of **2000** events per session (`BUFFER_CAP = 2000`).
- **History Cap**: Transcript cold-read max **2000** messages (`HISTORY_MAX_MESSAGES = 2000`).

## 4. Security & Network Model
- **Mandatory Auth**: Refuses to start without `AUTH_TOKEN`, under every `BIND_MODE`. No token = hard exit before listening (never binds unauthenticated).
- **Listen surface (`BIND_MODE`)**: unset or `lan` = `0.0.0.0`; `loopback` = `127.0.0.1`; `custom` + `BIND_HOST`.
- **Device approval**: New devices need a one-time approval (macOS menu-bar app, another trusted device, Enter in the `npm start` terminal, or `node scripts/device.js approve <ID>`). Skipped only for Cloudflare Access–validated connections and genuine local ones (loopback peer + `localhost` / `127.0.0.1` / `::1` Host). `DEVICE_APPROVAL_SCOPE=all` removes both exceptions.
- **`ACCESS_PROFILE`**: A declaration of how the phone reaches the host (`cloudflare` / `vpn` / `reverse-proxy` / `direct` / `lan`). It tailors `doctor` and the on-phone security check; it does not switch auth. Cloudflare Access JWT verification is enabled by the `CF_ACCESS_*` settings.
- **`TRUSTED_PROXY=loopback`**: Only affects rate-limit bucketing — behind a loopback reverse proxy, bucket by the last X-Forwarded-For hop instead of one shared bucket.
- **IPv6 Rate Limiting**: Aggregates by `/64` subnet to prevent brute-force abuse.

## 5. Critical Codebase Fragile Points
1. **Root Path Resolution**: Modules under `app/src/**` must resolve root 3 levels up (`join(import.meta.dirname, '..', '..', '..')`). Resolving only 2 levels silently creates `data/` and config inside `app/` without error.
2. **Process String Matching**: `desktop/launchd/server.plist.template` launch command `exec <node> app/server.js` must character-by-character match `app/src/ops/service-units.js`.
3. **Host Test Whitelist**: Only a short allow-list of read-only/mock npm scripts may run on the host (`HOST_ALLOWED_SCRIPTS` in `tests/gates/guard-host-tests.js`). All destructive or mutating tests (`mutate:docker`) must run inside Docker containers with virtual sandbox `HOME`.

## 6. How to Configure & Operate
```bash
# Configuration CLI (single source of truth: ccm.config.json & env-schema.js)
node scripts/config.js get PORT
node scripts/config.js set ACCESS_PROFILE=reverse-proxy

# Diagnostics & Health Check
node scripts/doctor.js
node scripts/doctor.js --fix

# Service Management (macOS LaunchAgent & Native Menu Bar App)
npm run service:status
npm run service:restart
npm run app:install
```

## 7. Fast Links for Agents
- Complete Markdown Docs: `https://ike-li.github.io/claude-chat-mobile/docs-site/pages/<slug>.md`
- Master Combined Text: `https://ike-li.github.io/claude-chat-mobile/llms-full.txt`
