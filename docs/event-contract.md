# Agent Event Contract

This document records the Socket.IO `agent:event` contract shared by the real server path and the Playwright visual mock server.

The executable contract lives in `scripts/agent-event-contract.js`. Run:

```bash
npm run contract:check
```

The check is static and zero-token. It does not start the production server, the visual mock server, a browser, or the real Claude CLI.

## Drift Guard Scope

`npm run contract:check` verifies:

- `agent.js` direct `this.emit(...)` and `this.emitTransient(...)` event types are in the contract.
- `server.js` static `agent:event` object-literal types are in the contract.
- `scripts/visual-mock-server.js` static `agent:event` object-literal types are in the contract.
- Every visual mock event type is also emitted by the real server/agent path.
- Static `agent:event` object literals expose a top-level `type` field so drift remains checkable.

## Event Types

Allowed `agent:event` types:

- `device_status`
- `effort_mode`
- `error`
- `history_append`
- `init`
- `instances`
- `mirror_state`
- `models`
- `pending_devices`
- `permission_mode`
- `permission_request`
- `question`
- `request_resolved`
- `result`
- `session_log`
- `status_line`
- `system`
- `task_notification`
- `task_progress`
- `text_delta`
- `thinking_delta`
- `tool_result`
- `tool_use`
- `user_message`
