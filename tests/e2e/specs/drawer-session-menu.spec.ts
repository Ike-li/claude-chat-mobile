import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import {
  ANOTHER_WORKSPACE, MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, expectSidebarOpen, openSessionMenu,
  openSessionsSidebar, sessionMenuItem, sessionRowByInstance,
} from '../../helpers/sidebar-ui';

// 抽屉会话行的「⋯」菜单（2026-10-25，对齐桌面端 SessionDropdownMenu）。此前一行有三个入口：✕、🗑、红色侧滑「关闭」，
// 侧滑与抽屉自己的左滑收起抢同一次手势——露出按钮后多滑 30px 抽屉就被收走。现在一行只有「⋯」，长按什么也不做。
// 菜单里有哪些项、什么时候灰掉，判定在 logic 的 sessionRowMenuItems（tests/unit/logic-session-row-menu.test.mjs）；
// 这里守的是界面：入口只剩一个、菜单真的这样画出来、点了走到原来的确认流程。
const menu = (page: import('@playwright/test').Page) => page.locator('#sessionMenuModal');

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-ROW-MENU-1 每行只剩「⋯」一个入口：没有 ✕ / 🗑，也没有侧滑「关闭」', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:tab'); // 造一个已打开的后台会话（inst_2），已打开与没打开的行都在
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expandWorkspace(page, ANOTHER_WORKSPACE);

    const panel = page.locator('#sessionPanel');
    const rows = panel.locator('[data-testid="session-row"]');
    await expect(sessionRowByInstance(page, 'inst_2')).toHaveCount(1);
    await expect(panel.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]')).toHaveCount(1);
    await expect(panel.locator('[data-testid="session-close"]'), '✕ 还在：一行又有两个关闭入口').toHaveCount(0);
    await expect(panel.locator('[data-testid="session-delete"]'), '🗑 还在').toHaveCount(0);
    await expect(panel.locator('.swipe-row-container'), '侧滑底还在：它和抽屉的左滑收起抢手势').toHaveCount(0);
    const n = await rows.count();
    expect(n).toBeGreaterThan(1);
    await expect(panel.locator('[data-testid="session-row"] [data-testid="session-menu"]')).toHaveCount(n);

    await expectNoBrowserErrors(page);
  });

  test('P0-ROW-MENU-2 已打开的会话：标已读/未读 · 关闭会话 · 删除会话（灰掉，说要先关闭）；关闭走原确认', async ({ page }) => {
    await gotoMock(page);
    await page.setViewportSize({ width: 900, height: 812 });
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    const row = sessionRowByInstance(page, 'inst_2');
    await expect(row).toContainText('Another App Concurrency');

    await openSessionMenu(page, row);
    await expect(page.locator('#sessionMenuTitle')).toHaveText('Another App Concurrency');
    await expect(menu(page).locator('[data-menu-action]')).toHaveCount(3);
    // 后台会话有新活动，此刻是未读：文案随未读态二选一（单测钉住），这里只要它在、能点
    await expect(sessionMenuItem(page, 'toggle-read')).toBeEnabled();
    await expect(sessionMenuItem(page, 'close')).toContainText('关闭会话');
    const del = sessionMenuItem(page, 'delete');
    await expect(del).toContainText('删除会话');
    await expect(del, '服务端拒删正被驱动的会话，删除必须点不动').toBeDisabled();
    await expect(del).toContainText('先关闭会话才能删除');

    await sessionMenuItem(page, 'close').click();
    await expect(menu(page)).not.toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmModal')).toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmOk')).toHaveText('关闭会话');
    await page.locator('#confirmOk').click();
    await expectSidebarClosed(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel')).not.toContainText('another-react-project');

    await expectNoBrowserErrors(page);
  });

  test('P0-ROW-MENU-3 没打开的会话：标为未读 · 删除会话（能点），删除走原「彻底删除」确认', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const row = page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');
    await expect(row).toBeVisible();

    await openSessionMenu(page, row);
    await expect(page.locator('#sessionMenuTitle')).toHaveText('Archived Planning Session');
    await expect(menu(page).locator('[data-menu-action]')).toHaveCount(2);
    await expect(sessionMenuItem(page, 'toggle-read')).toContainText('标为未读');
    await expect(sessionMenuItem(page, 'close')).toHaveCount(0);
    await expect(sessionMenuItem(page, 'delete')).toBeEnabled();

    await sessionMenuItem(page, 'delete').click();
    await expect(page.locator('#confirmModal')).toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmOk')).toHaveText('彻底删除');
    // 从抽屉里发起的确认答完要回到抽屉：菜单 sheet 与确认 sheet 上的点击都不算「点抽屉外面」
    await page.locator('#confirmCancel').click();
    await expectSidebarOpen(page);
    await expect(row).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-ROW-MENU-4 长按 / 右键会话行什么也不弹', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const row = page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');
    await expect(row).toBeVisible();

    // 右键与触屏长按此前走同一个入口，且 contextmenu 同步就把确认 sheet 打开——派发完立刻断言是有效的
    await row.dispatchEvent('contextmenu');
    await expect(page.locator('#confirmModal')).not.toHaveClass(/sheet-open/);
    await expect(menu(page)).not.toHaveClass(/sheet-open/);
    await expectSidebarOpen(page);

    await expectNoBrowserErrors(page);
  });

  test('P0-ROW-MENU-5 取消、点遮罩、Esc 都只收菜单，抽屉留着', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const row = page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');

    await openSessionMenu(page, row);
    await page.locator('#sessionMenuCancel').click();
    await expect(menu(page)).not.toHaveClass(/sheet-open/);
    await expectSidebarOpen(page);

    await openSessionMenu(page, row);
    await menu(page).click({ position: { x: 10, y: 10 } });
    await expect(menu(page)).not.toHaveClass(/sheet-open/);
    await expectSidebarOpen(page);

    await openSessionMenu(page, row);
    // openSheet 下一帧才把焦点移进 sheet；人不会在那一帧里按 Esc，测试也等焦点到位再按
    await expect(menu(page).locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(menu(page)).not.toHaveClass(/sheet-open/);
    await expectSidebarOpen(page);

    await expectNoBrowserErrors(page);
  });
});
