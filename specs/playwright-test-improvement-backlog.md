# Playwright Test Improvement Backlog

Last audited: 2026-07-05

## Goal

Build the Playwright suite into a stable daily regression system instead of an ad-hoc list of P0 cases.

The working target is:

- Keep P0 zero-token, mock-only, daily-safe, and isolated to `scripts/visual-mock-server.js`.
- Use P0 for user-visible browser behavior that can be represented by mock Socket.IO events.
- Keep real Claude, production smoke, Cloudflare Access, push delivery, and live network flows out of P0 unless they are explicitly opt-in P2 work.
- Track every candidate as one of: add test, optimize test, refactor test infrastructure.
- Prefer vertical TDD slices: one behavior, one test, smallest mock/server/frontend change needed, then verify.

## Current Snapshot

- Playwright config: `playwright.config.ts`
- P0 command: `npm run test:playwright:p0`
- P0 runner: 1 worker, mobile viewport, mock server on `127.0.0.1:33341`
- P0 count: 107 tests in 20 files
- Browser error capture: all 107 P0 tests call `expectNoBrowserErrors(page)`
- Forbidden patterns: no `test.only`, `test.skip`, `test.fixme`, `networkidle`, or `waitForTimeout` in the Playwright test lane
- Heaviest concentration: `tests/p0/workspace-sessions-sidebar.spec.ts` has 18 tests; its common sidebar flows now use `tests/helpers/p0-ui.ts`
- P1 contract drift guard: `npm run contract:check` statically compares real `agent:event` types with visual mock event types without starting Claude, production server, or Playwright.
- Visual mock scenario registry: `scripts/visual-mock-scenarios.js` now supports exact, alias-list, and prefix command registration. Migrated groups cover statusline, console-after-clear, stale-statusline, message-edit, stream, fresh-busy, queue-full, foreground-sync-replay, foreground-found-missing, background-done, background-error, background-priority, background-taskprogress, history-overflow, tab, tab-model-effort, tool-card, disconnect-now, close-current-pending, late-closed-current-events, permission-cross-tab, question-cross-tab, close-background-question-pending, late-closed-session-events, empty, restore, device-requests, tofu approval/denial, tofu-delayed approval, unsafe-markdown, ask-user-question, permission, settings-echo, pending-snapshot, mirror-readonly, task-progress, and exit-plan fixtures.

## Completed Tooling

1. P1 contract drift check between visual mock events and real server event shapes
   - Added `scripts/agent-event-contract.js` and `scripts/contract-check.js`.
   - Added `npm run contract:check`.
   - Added `test/agent-event-contract.test.mjs`.
   - Human-facing contract note: `docs/event-contract.md`.

## Completed P0 Additions

1. P0-20e token retry does not leak rejected token into local UI state
   - Added `tests/p0/security-observable-ui.spec.ts` coverage for rejected token retry followed by accepted token reconnect.
   - Verifies the auth form is cleared after success and rejected token text/masked prefixes do not persist in visible UI or browser console logs.

2. P0-19d narrow viewport scroll reachability for settings and console sheets
   - Added `tests/p0/empty-restore-responsive.spec.ts` coverage for narrow portrait and landscape viewports.
   - Verifies settings and console sheets keep close/action controls reachable after scrolling.

## Add Test Candidates

### P0 Mock-Only Additions

No open P0 mock-only additions currently listed.

### P1/P2 Candidates To Record Only

1. P1 service worker and offline shell behavior
   - P0 checks local PWA resources load; true offline caching needs a dedicated browser/runtime lane.

2. P1 real Express socket smoke with a fake Claude adapter
   - Useful for auth/session/socket lifecycle without token use.
   - Should not touch production port 3000.

3. P2 real Claude smoke
   - Explicit opt-in only; can consume tokens.
   - Keep separate from `npm run test:playwright:p0`.

4. P2 production domain and Cloudflare Access smoke
   - Explicit opt-in only; depends on live infrastructure and 2FA state.

5. P2 Web Push delivery
   - Requires browser permission, VAPID/device state, and possibly live delivery.
   - Keep out of daily P0.

## Optimize Test Candidates

1. Reduce sidebar selector brittleness
   - Current non-workspace specs still repeat hard-coded selectors such as `div[data-dir="/Users/you/code/another-react-project"] button`, `button[title="Another App Concurrency"]`, and fixed `data-instance-id="inst_2"`.
   - Preferred path: continue applying `tests/helpers/p0-ui.ts` helpers such as `openSessionsSidebar`, `expandWorkspace`, `openSessionByTitle`, `openWorkspaceSession`, `sessionRowByInstance`, and `expectSessionBadge`.
   - Optional product-safe improvement: add stable `data-testid`/`data-session-title`/`data-workspace-name` attributes to sidebar rows.

2. Reduce repeated modal/draft guard boilerplate
   - Permission, question, device, mirror, and queue-full tests repeat the same "draft stays, Send disabled, no user message sent" pattern.
   - Preferred path: helper assertions for blocked composer states and draft preservation.

3. Replace option `nth()` where intent is semantic
   - Question and tool-card tests sometimes rely on `nth(1)` or `nth(2)`.
   - Preferred path: choose by visible label where order is not the point, keep order assertions only where order is the behavior under test.

4. Split slow/high-density specs when behavior domains diverge
   - `workspace-sessions-sidebar.spec.ts` covers history replay, sidebar overflow, close/fallback, status badges, settings-following, and new sessions.
   - Preferred path: keep one helper module, then split into `workspace-session-history`, `workspace-session-close`, and `workspace-session-badges` only when refactoring helps reviewability.

5. Keep full P0 under daily-run threshold
   - Current full P0 is roughly 3.5-3.6 minutes locally.
   - Preferred path: add coverage only when it guards a real regression class; avoid duplicating the same blocked-draft pattern everywhere without a new state transition.

## Refactor Candidates

1. Extend the P0 UI helper module
   - `tests/helpers/p0-ui.ts` now covers common sidebar/session flows in `workspace-sessions-sidebar.spec.ts`.
   - Continue migrating other specs opportunistically when they touch sidebar/session flows.

2. Add a visual mock scenario registry
   - Registry scaffold exists in `scripts/visual-mock-scenarios.js`.
   - Migrated groups: `test:statusline`, `test:console-log-after-clear`, `test:stale-statusline-replay`, `test:stream`, `test:message-edit*`, `test:freshbusy`, `test:queuefull`, `test:foreground-sync-replay`, `test:foreground-found-missing`, `test:background-done`, `test:background-error`, `test:background-priority`, `test:background-taskprogress`, `test:history-overflow`, `test:tab`, `test:tab-model-effort`, `test:tool`, `test:tool-out-of-order`, `test:tool-error`, `test:disconnect-now`, `test:close-current-pending`, `test:late-closed-current-events`, `test:permCrossTab`, `test:questionCrossTab`, `test:close-background-question-pending`, `test:late-closed-session-events`, `test:empty`, `test:restore`, `test:devicerequests`, `test:tofu`, `test:tofu-denied`, `test:tofu-delayed`, `test:unsafe-markdown`, `test:question*`, `test:permission*`, `test:settings-echo`, `test:fresh-settings-echo`, `test:pendingsnapshot*`, `test:gap-pending-snapshot`, `test:questionsnapshot`, `test:gap-question-snapshot`, `test:mirror-readonly*`, `test:taskprogress*`, and `test:exitplan` fixtures.
   - Continue moving remaining `test:*` groups out of the long `if/else` chain in behavior-neutral slices.

3. Add stable sidebar data attributes
   - Existing `data-testid="session-row"` and `data-instance-id` are useful, but tests still depend heavily on titles and synthetic instance IDs.
   - Adding stable non-visual attributes would reduce brittle selectors without changing UI.

4. Normalize test plan and README roles
   - `specs/README.md` is becoming a long coverage ledger.
   - Keep README as runner/boundary/current summary, and use this backlog plus the comprehensive plan for detailed future work.

5. Consider generated inventory checks
   - A lightweight script could list all P0 tests and all `test:*` mock commands, then flag commands used by tests but not recognized by the visual mock server.
   - This is a P1 tooling improvement, not a browser regression.

## Recommended Execution Order

1. Continue visual mock scenario registry migration.

## Definition Of Done For Each Slice

- The test verifies user-visible behavior, not internal implementation.
- The slice stays mock-only unless explicitly marked P1/P2.
- No real Claude, no `RUN_CLAUDE_INTEGRATION`, no `npm start`, no production port 3000.
- Run target test or spec first.
- Run `npm run check`.
- Run `npm run contract:check` for event-contract or visual mock protocol changes.
- Run `npx playwright test --list`.
- Run `npm run test:playwright:p0` for any behavior/test change.
- Run `git diff --check`.
- Remove `playwright-report/` and `test-results/`.
- Commit locally with only intended files staged.
