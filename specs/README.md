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
- Status line coverage verifies the prompt-cache TTL estimate text, including the `est` marker for derived cache timing.
- Status line coverage verifies stale cross-workspace status replays without `instanceId` are ignored by the current workspace view.
- Input coverage verifies the foreground turn queue-full state disables Send, keeps the user's draft, and re-enables Send after the queue drains.
- Input coverage verifies messages sent while disconnected enter the visible offline queue and are retried after reconnect.
- Input coverage verifies a foreground `pageshow` sync replay does not duplicate an already-rendered assistant reply.
- Input coverage verifies a foreground `sync:since` `found:false` recovery clears stale visible content and reloads authoritative session history.
- Input coverage verifies selecting the ultracode effort preset injects the per-turn keyword once and completes the mock turn.
- Stream/Markdown coverage verifies code-block copy controls are present and provide visible feedback after a click.
- Auth failure coverage includes opening the access-help sheet and retrying by Enter from the token gate without leaking rejected or accepted tokens.
- Settings coverage verifies unsupported-model effort controls hide and do not leak a stale thinking effort into the next turn.
- Settings coverage verifies new-session empty-start permission/effort presets are consumed by the first sent message.
- Console coverage verifies opening and closing the trace sheet preserves the user's in-progress input draft.
- Console coverage verifies reopening the trace sheet after a session switch shows the current session trace rather than the previous session trace.
- Long-stream interrupt coverage verifies that a stopped stream does not keep appending chunks after a later command completes.
- Long-stream interrupt coverage verifies repeated Stop taps produce a single visible interrupted state rather than duplicate feedback.
- Tool-card coverage includes out-of-order tool results to ensure outputs stay attached to the correct visible card.
- Tool-card coverage verifies an in-flight tool is marked failed and the input recovers when the turn ends with an error.
- Permission approval coverage includes the per-session "always allow this tool type" path, so a repeated same-session command can complete without a second approval sheet and the rule does not leak to another live session.
- Permission approval coverage verifies a failed `result.isError` turn closes the active approval sheet, marks the visible tool card failed, and leaves the input usable for the next message.
- Permission approval coverage verifies background drafts are not submitted while an approval sheet is open, and that the draft can be sent after the approval is resolved.
- Remote request resolution coverage verifies stale permission and AskUserQuestion sheets close when another trusted device resolves the request.
- Multi-session routing guards cover closing a background session without disturbing the current view, and switching back to a background pending-permission instance before resolving its approval.
- Multi-session routing guards cover closing the current session and falling back to the remaining session without leaving the closed session's history on screen.
- Multi-session routing guards cover closing the current pending-approval session and falling back without leaving stale approval state.
- Multi-session routing guards cover late tool/text/permission/question/result events from a just-closed current session so they do not pollute the fallback session view.
- Cross-tab pending guards cover AskUserQuestion sheets being cleared when the view switches away and rebuilt only after switching back to the owning session.
- Cross-tab pending guards cover closing a background AskUserQuestion session without reviving its stale choice sheet.
- Cross-tab pending guards cover stale events that arrive after a background pending session is closed and verify they do not pollute the current view.
- Workspace status coverage verifies background completion and error states appear in both the top sessions indicator and sidebar badges, and that mixed background states prioritize pending approval over completed/running work.
- Session navigation coverage verifies unopened historical sessions can be launched from the sidebar and rendered through the `session:history` fallback.
- Session navigation coverage verifies a `sync:since` gap while opening a historical session clears partial replay and falls back to `session:history`.
- Session navigation coverage verifies the sidebar `显示全部会话…` path can expand a truncated `session:list` result and open an older history session.
- Session navigation coverage verifies a previously cached sidebar `session:list` refresh can surface a new `显示全部会话…` entry and open the older history session.
- Session navigation coverage verifies the sidebar new-session button opens an empty chat in the selected workspace rather than the previously viewed workspace.
- Session navigation coverage verifies the first message from a sidebar-created empty chat stays in the selected workspace after the lazy fresh instance opens.
- Session navigation coverage verifies a failed historical session switch shows an error without replacing the current workspace or chat transcript.
- Session navigation coverage verifies model, permission, and thinking effort pills follow the selected live instance after a workspace/session switch.
- Pending snapshot reconciliation covers duplicate same-`requestId` pending entries without showing repeated approval sheets, and restores AskUserQuestion choice sheets from `sync:since` pending snapshots.
- Pending snapshot reconciliation verifies a `sync:since` gap still rebuilds approval and AskUserQuestion state after falling back to `session:history`.
- AskUserQuestion coverage includes duplicate same-`requestId` replay without showing repeated choice sheets after reconnect/sync paths.
- AskUserQuestion coverage verifies a failed `result.isError` turn closes the active choice sheet, marks the visible tool card failed, and leaves the input usable for the next message.
- AskUserQuestion coverage verifies background drafts are not submitted while a choice sheet is open, and that the draft can be sent after the choice is answered.
- Task progress coverage includes failed background tasks so failure notifications also clear the progress banner.
- Task progress coverage verifies another workspace's progress heartbeat does not show a current-session banner while its busy state remains visible in the sessions entry and sidebar.
- Mirror-state coverage verifies terminal read-only catch-up locks the input and allows an explicit user takeover.
- Mirror-state coverage verifies switching to another session clears the read-only catch-up lock so it does not block unrelated sessions.
- Mirror-state coverage verifies an in-progress draft is preserved while the terminal read-only lock is active and can be sent after explicit takeover.
- Device trust coverage includes pending, denied, denied retry back to pending, and trusted-device approval/rejection updates through mock Socket.IO events.
- Device trust coverage verifies an existing draft is preserved while TOFU approval is pending, Send is disabled with visible reason, and the draft can be sent after approval.
- Device trust coverage verifies a draft is still preserved after device denial and retrying access keeps Send disabled while returning to pending approval.
- Client-side attachment boundary checks cover oversized files, repeated same-file selection, total-size overflow, and no-extension generic attachments; these do not upload to the real server or touch Claude.
- Attachment isolation coverage verifies unsent attachment chips are cleared on session switch so files selected in one session are not sent to another session.
- Offline attachment coverage verifies queued attachment messages keep their chip while disconnected and do not duplicate the chip after reconnect resend confirmation.
- Responsive and PWA coverage verifies permission approval sheet controls stay reachable in narrow portrait/landscape viewports and manifest icons plus the local service-worker shell script load.

## Test Plan

- `claude-chat-mobile-comprehensive-test-plan.md` is the source plan.
- `tests/p0/*.spec.ts` implements the P0 mock UI scenarios.
- `tests/seed.goto-mock.spec.ts` contains shared Playwright helpers.
- Root `seed.spec.ts` is the `init-agents` bootstrap seed and is not part of the regular P0 runner.

## Boundaries

- P0: zero-token mock UI regression, safe for daily local runs.
- P1: protocol and integration coverage should use the existing Node/socket integration test style unless browser behavior is specifically required.
- P2: real Claude and production smoke tests must stay explicit opt-in because they can consume tokens, touch live workdirs, or interact with the long-running service on port 3000.
