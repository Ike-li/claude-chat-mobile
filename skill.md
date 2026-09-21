---
name: claude-chat-mobile
description: Self-hosted mobile web interface bridging terminal Claude Code CLI to phone browsers via Anthropic Agent SDK.
version: 2.0 (dev@687bca3)
license: Apache-2.0
repository: https://github.com/Ike-li/claude-chat-mobile
docs: https://ike-li.github.io/claude-chat-mobile/docs-site/
llms-txt: https://ike-li.github.io/claude-chat-mobile/llms.txt
---

# Claude Chat Mobile — Agent Capability & Architecture Card

AEO-optimized capability specification for AI agents (Cursor, Claude Code, Windsurf).
Read this card in <500 tokens to understand architecture, boundaries, configuration, and invocation paths.

## 1. What It Is & Positioning
- **What it does**: Bridges a locally authenticated `claude` CLI to mobile browsers as a touch-friendly PWA.
- **Terminal Parity**: "Typing on your phone is functionally identical to typing in your terminal". Same session, same transcripts, same `CLAUDE.md`, MCPs, skills, and tools.
- **Product Stance (n=1)**: Single-user, self-hosted. **Never multi-tenant**, no user accounts, no hosted SaaS. Authenticated remote user = root user at terminal.

## 2. Core Architecture: Dual-Channel & Single-Driver
1. **Web Driving Channel**: Web client uses WebSocket (`agent:event` envelope with seq/epoch) -> Server `AgentSession` -> Agent SDK streaming input -> spawns `claude` CLI.
2. **CLI Terminal Driving Channel**: Direct terminal execution is mirrored read-only by polling local JSONL transcripts (`~/.claude/projects/`). Web input locks with `mirrorReadonly` to prevent transcript divergence.
3. **Takeover**: When terminal turns idle (>12.5s), Web safely resumes with `externalDirty` absorption.

## 3. Technology Stack & Key Constants
- **Runtime**: Node ≥20 · Pure ESM · Express 5 · Socket.IO 4 · `@anthropic-ai/claude-agent-sdk` (0.3.263) · `jose` 6 (JWT).
- **Protocols**: Outbound: 27 `agent:event` types (`app/src/shared/protocol.js`); Inbound: 46 socket events.
- **Ring Buffer**: In-memory circular buffer of **2000** events per session (`BUFFER_CAP = 2000`).
- **History Cap**: Transcript cold-read max **2000** messages (`HISTORY_MAX_MESSAGES = 2000`).

## 4. Security & Network Model (ACCESS_PROFILE)
- **Mandatory Auth**: Refuses to start without `AUTH_TOKEN`. No token = hard exit (never binds unauthenticated).
- **Device Trust (TOFU)**: Non-loopback devices require one-time approval on host machine via `node scripts/device.js approve <ID>`.
- **Topologies (`ACCESS_PROFILE`)**:
  - `cloudflare`: Public access via Cloudflare Tunnel + Access (verified via edge JWT).
  - `reverse-proxy`: Reverse proxy (Nginx, Tailscale Funnel); requires `TRUSTED_PROXY=loopback` to parse last X-Forwarded-For hop.
  - `lan`: Direct local network (WiFi) connection.
- **IPv6 Rate Limiting**: Aggregates by `/64` subnet to prevent brute-force abuse.

## 5. Critical Codebase Fragile Points
1. **Root Path Resolution**: Modules under `app/src/**` must resolve root 3 levels up (`resolve(HERE, '../../../')`). Resolving only 2 levels silently creates `data/` and config inside `app/` without error.
2. **Process String Matching**: `desktop/launchd/server.plist.template` launch command `exec <node> app/server.js` must character-by-character match `app/src/ops/service-units.js`.
3. **Host Test Whitelist**: Only 10 read-only/mock commands allowed on host (`guard-host-tests.js`). All destructive or mutating tests (`mutate:docker`) must run inside Docker containers with virtual sandbox `HOME`.

## 6. How to Configure & Operate
```bash
# Configuration CLI (single source of truth: ccm.config.json & env-schema.js)
node scripts/config.js get PORT
node scripts/config.js set ACCESS_PROFILE reverse-proxy

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
