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
- P0 count: 101 tests in 20 files
- Browser error capture: all 101 P0 tests call `expectNoBrowserErrors(page)`
- Forbidden patterns: no `test.only`, `test.skip`, `test.fixme`, `networkidle`, or `waitForTimeout` in the Playwright test lane
- Heaviest concentration: `tests/p0/workspace-sessions-sidebar.spec.ts` has 17 tests and the most hard-coded sidebar selectors

## Add Test Candidates

### P0 Mock-Only Additions

1. P0-17g delayed terminal read-only lock after session switch
   - Why: current mirror coverage verifies lock, takeover, draft retention, and switching after lock. It does not cover a delayed stale lock arriving after the user has switched away.
   - Test shape: arm delayed mirror lock, switch workspace/session before it arrives, assert current session is not locked and the old session state is only visible in its owner row/view.
   - Mock impact: likely reuse or slightly extend `test:mirror-readonly-delayed`.
   - Priority: high.

2. P0-18g attachment removal frees quota
   - Why: attachment limits are covered, and removed chips are not sent, but quota recovery after removal is not pinned.
   - Test shape: add files near count/size limit, remove one chip, add another allowed file, send, assert only remaining attachments are visible.
   - Mock impact: none.
   - Priority: medium.

3. P0-11r closing the last visible session falls back to empty start
   - Why: current close coverage focuses on fallback to another existing session. The no-remaining-session path is a different user-visible state.
   - Test shape: close the only current visible session or prepare a mock with one closeable session, assert empty-start/workspace shell remains usable and no stale transcript remains.
   - Mock impact: likely add a focused close-last-session fixture.
   - Priority: medium.

4. P0-16e console modal clear after new logs arrive
   - Why: clear currently verifies chat history is not deleted. It does not pin behavior when a new mock log arrives after clear/reopen.
   - Test shape: open console, clear, trigger a message that emits logs, reopen/inspect visible trace and chat separation.
   - Mock impact: maybe reuse existing `logs:get` plus `test:statusline`.
   - Priority: medium.

5. P0-20e token retry does not leak rejected token into local UI state
   - Why: current auth tests verify rejected/accepted tokens are not visibly leaked. A stronger boundary is that retry state does not persist the bad token in input or logs after success.
   - Test shape: bad token, retry good token, assert token input/sheet is gone and logs/messages contain no token text.
   - Mock impact: none.
   - Priority: medium.

6. P0-19d narrow viewport scroll reachability for settings and console sheets
   - Why: permission sheet reachability is covered; settings/console can also grow vertically.
   - Test shape: use narrow/landscape viewports and assert close/action controls remain reachable after scrolling.
   - Mock impact: none.
   - Priority: low.

### P1/P2 Candidates To Record Only

1. P1 contract drift check between visual mock events and real server event shapes
   - Prefer a Node/static contract check over browser UI tests.
   - Should catch event field drift before P0 mocks become misleading.

2. P1 service worker and offline shell behavior
   - P0 checks local PWA resources load; true offline caching needs a dedicated browser/runtime lane.

3. P1 real Express socket smoke with a fake Claude adapter
   - Useful for auth/session/socket lifecycle without token use.
   - Should not touch production port 3000.

4. P2 real Claude smoke
   - Explicit opt-in only; can consume tokens.
   - Keep separate from `npm run test:playwright:p0`.

5. P2 production domain and Cloudflare Access smoke
   - Explicit opt-in only; depends on live infrastructure and 2FA state.

6. P2 Web Push delivery
   - Requires browser permission, VAPID/device state, and possibly live delivery.
   - Keep out of daily P0.

## Optimize Test Candidates

1. Reduce sidebar selector brittleness
   - Current tests repeatedly use hard-coded selectors such as `div[data-dir="/Users/you/code/another-react-project"] button`, `button[title="Another App Concurrency"]`, and fixed `data-instance-id="inst_2"`.
   - Preferred path: add helpers such as `openSessionsSidebar`, `selectWorkspace`, `openSessionByTitle`, `closeSessionByTitle`, and `expectSessionBadge`.
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

1. Add a P0 UI helper module
   - Candidate file: `tests/helpers/p0-ui.ts` or extend `tests/seed.goto-mock.spec.ts` conservatively.
   - First helpers should target repeated sidebar/session flows because that is the largest selector hotspot.

2. Add a visual mock scenario registry
   - `scripts/visual-mock-server.js` currently uses a long `if/else` chain for `test:*` commands.
   - A registry object keyed by command would make scenario coverage easier to audit and reduce accidental fall-through.
   - Keep this refactor behavior-neutral and do it separately from adding new tests.

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

1. Add P0-17g delayed mirror lock after session switch.
2. Refactor sidebar helpers before adding more P0-11 cases.
3. Add P0-18g attachment removal frees quota.
4. Add P0-11r close-last-session empty fallback.
5. Add P1 contract drift check.
6. Refactor visual mock scenario registry.

## Definition Of Done For Each Slice

- The test verifies user-visible behavior, not internal implementation.
- The slice stays mock-only unless explicitly marked P1/P2.
- No real Claude, no `RUN_CLAUDE_INTEGRATION`, no `npm start`, no production port 3000.
- Run target test or spec first.
- Run `npm run check`.
- Run `npx playwright test --list`.
- Run `npm run test:playwright:p0` for any behavior/test change.
- Run `git diff --check`.
- Remove `playwright-report/` and `test-results/`.
- Commit locally with only intended files staged.
