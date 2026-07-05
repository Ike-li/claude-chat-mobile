# Specs

This directory stores test plans and generated Playwright scenario sources for the mobile Web UI.

## Playwright P0 Mock Regression

P0 is the daily-safe browser regression lane. It runs against `scripts/visual-mock-server.js`, uses Socket.IO mock events, and does not call the real Claude CLI or consume tokens.

Run it with:

```bash
npm run test:playwright:p0
```

The Playwright config starts the mock server automatically on `127.0.0.1:33341` by default. Override only for local debugging:

```bash
CCM_PLAYWRIGHT_PORT=33342 npm run test:playwright:p0
```

The mock server exposes `POST /__reset` for the Playwright seed helper so each test starts from a clean mock state. This endpoint exists only in the visual mock server, not in production `server.js`.

Current P0 mock-only coverage also includes:

- `test:settings-echo` in the visual mock server, which renders the selected model, permission mode, and thinking effort from the next sent message so the settings panel is tested through user-visible chat behavior.
- A mock `logs:get` response with a stable `[MOCK_LOG]` trace row so the Console modal can verify Clear affects only the log pane, not chat history.
- Visual mock Socket.IO auth rejects `bad-token`, `invalid-token`, and `expired-token` with `unauthorized` so P0 can cover the token retry UI without enabling production `AUTH_TOKEN`.
- Permission approval coverage includes the per-session "always allow this tool type" path, so a repeated same-session command can complete without a second approval sheet.
- Multi-session routing guards cover closing a background session without disturbing the current view, and switching back to a background pending-permission instance before resolving its approval.
- Pending device request cards cover both trusted-device approval and rejection updates through mock Socket.IO events.
- Client-side attachment boundary checks cover oversized files, repeated same-file selection, total-size overflow, and no-extension generic attachments; these do not upload to the real server or touch Claude.

## Test Plan

- `claude-chat-mobile-comprehensive-test-plan.md` is the source plan.
- `tests/p0/*.spec.ts` implements the P0 mock UI scenarios.
- `tests/seed.goto-mock.spec.ts` contains shared Playwright helpers.
- Root `seed.spec.ts` is the `init-agents` bootstrap seed and is not part of the regular P0 runner.

## Boundaries

- P0: zero-token mock UI regression, safe for daily local runs.
- P1: protocol and integration coverage should use the existing Node/socket integration test style unless browser behavior is specifically required.
- P2: real Claude and production smoke tests must stay explicit opt-in because they can consume tokens, touch live workdirs, or interact with the long-running service on port 3000.
