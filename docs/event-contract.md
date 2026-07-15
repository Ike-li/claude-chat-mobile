# Agent Event Contract

This document records the Socket.IO `agent:event` contract shared by the real server path and the Playwright UI mock server. It is the consolidated protocol reference for the former detailed-design event section.

The executable contract lives in `scripts/agent-event-contract.js`. Run:

```bash
npm run contract:check
```

The check is static and zero-token. It does not start the production server, the visual mock server, a browser, or the real Claude CLI.

## Drift Guard Scope

`npm run contract:check` verifies:

- `src/agent/agent.js` direct `this.emit(...)` and `this.emitTransient(...)` event types are in the contract.
- `src/server/app.js` static `agent:event` object-literal types are in the contract.
- `tests/e2e/mock/server.js` and `tests/e2e/mock/scenarios/*.js` static `agent:event` object-literal types are in the contract.
- Every visual mock event type is also emitted by the real server/agent path.
- Static `agent:event` object literals expose a top-level `type` field so drift remains checkable.

## Envelope and replay rules

Buffered agent/session events use this envelope:

```js
{ seq, epoch, sessionId, instanceId, cwd, ts, type, payload }
```

- `seq` is monotonic within one live Agent instance. Each instance retains the latest 2000 buffered events for `sync:since` replay.
- `epoch` identifies the live instance generation. A changed epoch resets the client de-duplication baseline.
- `sessionId`, `instanceId`, and `cwd` are routing identity; clients render only the selected instance while retaining background status.
- Transient state frames use `seq: 0` and do not enter the replay buffer. Heartbeat/RTT uses the separate `conn:ping` request/ack path.
- If `sync:since` reports a gap or no matching instance, the client reloads authenticated `session:history`; a transport disconnect is never treated as a completed task.
- `payload` is type-specific. The executable allowlist guards type names; behavioral payload assertions live in Node integration tests and Playwright P0 tests.

## Event Types

Allowed `agent:event` types (26):

- `api_retry`
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
