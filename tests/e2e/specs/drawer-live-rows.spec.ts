import { test, expect } from '@playwright/test';
import { gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar, sessionRowByInstance } from '../../helpers/sidebar-ui';

// SESSION-02：活着的实例在抽屉里必须有一行。
// 2026-09-23 真机会话 1c401b5d：EnterWorktree 把 transcript 迁到了平级目录的 project 目录，
// 会话还在跑，抽屉里却整行消失——行只由 session:list 驱动，活实例只是往已有行上贴状态。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test.beforeEach(async ({ page }) => {
    await gotoMock(page);
  });

  test('P0-LIVE-1 在跑的会话不在工作区列表里也有一行，且显示运行中', async ({ page }) => {
    await sendChatMessage(page, 'test:live-not-in-list');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);

    const row = sessionRowByInstance(page, 'inst_moved');
    await expect(row, 'session:list 没返回它，但它在跑——整行消失就是 1c401b5d 的症状').toHaveCount(1);
    await expect(row).toContainText('搬走了 transcript 的会话');
    await expect(row.locator('[data-session-status]')).toHaveCount(1);
    // 有 id 的会话不能写成「新会话（未保存）」
    await expect(row).not.toContainText('新会话（未保存）');
  });

  test('P0-LIVE-2 cwd 不在任何工作区之下的在跑会话单独成一节，点开即切过去', async ({ page }) => {
    await sendChatMessage(page, 'test:live-unowned');
    await waitForIdle(page);
    await openSessionsSidebar(page);

    const section = page.locator('[data-testid="unowned-live-section"]');
    await expect(section, '平级 worktree 里的会话不属于任何工作区，没有这一节它就无处可画').toHaveCount(1);
    const row = section.locator('[data-testid="session-row"][data-instance-id="inst_sibling"]');
    await expect(row).toContainText('平级 worktree 里的会话');

    // 同一个实例不能在别的工作区小节里再出现一次
    await expect(sessionRowByInstance(page, 'inst_sibling')).toHaveCount(1);

    // 这一行不是摆设：点开就切到那个会话（活实例走 user:setViewing，不需要列表）
    await row.locator('button').first().click();
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile-feat-x');
  });
});
