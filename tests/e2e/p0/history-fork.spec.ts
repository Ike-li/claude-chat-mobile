// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

// 长按历史气泡「从这里分叉新会话」：session:fork（forkSession upToMessageId）。长按靠真实 550ms
// setTimeout 触发（见 app/public/js/app.js bindForkLongPress），不用 waitForTimeout（禁用模式）——
// 派发 touchstart 后直接轮询等确认弹层出现，天然把这段延迟吃掉。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-FORK 长按 assistant 气泡可从该点分叉新会话', async ({ page }) => {
    await gotoMock(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history.', { timeout: 10_000 });

    const assistantBubble = page.locator('[data-testid="assistant-message"]', { hasText: 'Archived plan replay' });
    const box = await assistantBubble.boundingBox();
    if (!box) throw new Error('assistant bubble bounding box not found');
    const touch = { identifier: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await assistantBubble.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch] });

    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('#confirmTitle')).toContainText('分叉');
    await page.locator('#confirmOk').click();

    // mock session:fork 切到 mock-session-forked，其 session:history 回一段带独立文案的历史，验证真切换了会话。
    await expect(page.locator('#messages')).toContainText('Forked session ready.', { timeout: 10_000 });

    await expectNoBrowserErrors(page);
  });

  test('P0-FORKc 长按后续用户消息会解析出前一条 assistant 的 uuid（而非自己的）', async ({ page }) => {
    await gotoMock(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Any follow-up questions?', { timeout: 10_000 });

    // mock session:fork 只收 assistant 侧 uuid（a-archived-1/2）；若前端误发这条 user 气泡自己的 uuid
    // （u-archived-2）会被 mock 拒绝、下面的「切到新会话」断言就会失败——是真正有区分力的回归护栏。
    const secondUserBubble = page.locator('[data-testid="user-message"]', { hasText: 'Any follow-up questions?' });
    const box = await secondUserBubble.boundingBox();
    if (!box) throw new Error('user bubble bounding box not found');
    const touch = { identifier: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await secondUserBubble.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch] });

    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click();
    await expect(page.locator('#messages')).toContainText('Forked session ready.', { timeout: 10_000 });

    await expectNoBrowserErrors(page);
  });

  test('P0-FORKb 长按会话首条用户消息（前面无 assistant 回复）时禁用分叉', async ({ page }) => {
    await gotoMock(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10_000 });

    const firstUserBubble = page.locator('[data-testid="user-message"]', { hasText: 'Summarize archived plan' });
    const box = await firstUserBubble.boundingBox();
    if (!box) throw new Error('user bubble bounding box not found');
    const touch = { identifier: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await firstUserBubble.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch] });

    await expect(page.locator('#messages')).toContainText('这是最早一条消息', { timeout: 3_000 });
    await expect(page.locator('#confirmModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });
});
