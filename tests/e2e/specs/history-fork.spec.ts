// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

// 长按历史气泡的两个动作：assistant → 对话轴 fork（forkSession upToMessageId）；
// user → 先弹二选一，可选文件轴 Rewind（session:rewind:preview/confirm）或 fork。
// 两者的锚点语义【相反】——fork 取前一条 assistant 的 uuid，rewind 取气泡自己的——
// 所以 mock 的两个 handler 各自只收一侧 uuid，前端若把解析路径搞混，这里当场红。
// 长按靠真实 550ms setTimeout 触发（见 app.js bindBubbleLongPress），不用 waitForTimeout
// （禁用模式）——派发 touchstart 后直接轮询等确认弹层出现，天然把这段延迟吃掉。
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

    // 2026-09-10 起 user 气泡长按先弹二选一（回退 / 分叉）——两个动作的锚点语义相反，
    // 走的是两条不同的解析路径。这里选「从这里分叉」，后续断言不变：仍要求送出的是
    // 前一条 assistant 的 uuid（mock 只收 a-archived-*，送自己的会被拒 → 切不过去）。
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmAlt').click();
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

    // 先弹二选一；选「从这里分叉」后才走到"前面没有 assistant 可作锚点"这一档。
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmAlt').click();
    await expect(page.locator('#messages')).toContainText('这是最早一条消息', { timeout: 3_000 });
    await expect(page.locator('#confirmModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });
});

// ── 文件轴 Rewind ──
test.describe('P0 日常零 token Mock UI 回归 · Rewind', () => {
  const longPressUser = async (page: import('@playwright/test').Page, text: string) => {
    const bubble = page.locator('[data-testid="user-message"]', { hasText: text });
    const box = await bubble.boundingBox();
    if (!box) throw new Error(`user bubble not found: ${text}`);
    const touch = { identifier: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await bubble.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch] });
  };
  const openArchived = async (page: import('@playwright/test').Page) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
  };

  test('P0-REWIND 长按用户气泡可回退该轮文件，确认框先列出影响面', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('Any follow-up questions?', { timeout: 10_000 });

    // 用【第二条】user 气泡：第一条是会话首条消息，其前面没有可保留的 chain entry，
    // 真 server 的 planRewind 在那一档返回 first-turn（见下一条用例）。
    await longPressUser(page, 'Any follow-up questions?');
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click(); // 主动作 = 回退

    // preview 的影响面必须先摆出来再让人点确认——回退会真改磁盘，"确认"不能是盲签。
    await expect(page.locator('#confirmBody')).toContainText('app.js', { timeout: 3_000 });
    await expect(page.locator('#confirmBody')).toContainText('完整保留');
    await expect(page.locator('#confirmBody')).toContainText('12'); // insertions
    await page.locator('#confirmOk').click();

    // 成功路径的 UI 由 rewind_applied 广播驱动（本机与其他设备同一条路径）。
    // fork 语义：文案必须说清【原会话保留】——这是本方案相对原地截断的核心差异，
    // 用户据此知道回退不是不可逆的。
    await expect(page.locator('#messages')).toContainText('原会话保留', { timeout: 10_000 });
    await expectNoBrowserErrors(page);
  });

  test('P0-REWINDb 会话首条消息无可保留锚点时，preview 阶段就拒绝且不弹二次确认', async ({ page }) => {
    await openArchived(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10_000 });

    await longPressUser(page, 'Summarize archived plan');
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click(); // 主动作 = 回退

    // 拒绝发生在动任何文件【之前】，所以不该出现"将恢复 N 个文件"那道确认框。
    // 文案要点名是什么挡住的（这里是"第一轮"），否则用户无从判断该换个位置试还是根本不行。
    await expect(page.locator('#messages')).toContainText('第一轮', { timeout: 5_000 });
    await expect(page.locator('#confirmModal')).toBeHidden();
    await expectNoBrowserErrors(page);
  });
});
