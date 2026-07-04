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

## Test Plan

- `claude-chat-mobile-comprehensive-test-plan.md` is the source plan.
- `tests/p0/*.spec.ts` implements the P0 mock UI scenarios.
- `tests/seed.goto-mock.spec.ts` contains shared Playwright helpers.
- Root `seed.spec.ts` is the `init-agents` bootstrap seed and is not part of the regular P0 runner.

## Boundaries

- P0: zero-token mock UI regression, safe for daily local runs.
- P1: protocol and integration coverage should use the existing Node/socket integration test style unless browser behavior is specifically required.
- P2: real Claude and production smoke tests must stay explicit opt-in because they can consume tokens, touch live workdirs, or interact with the long-running service on port 3000.
