import { test, expect } from '@playwright/test';
import { gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { MAIN_WORKSPACE, chooseSessionMenuItem, expandWorkspace, openSessionsSidebar, sessionRowByInstance } from '../../helpers/sidebar-ui';

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

  // 验收 O46：开着的旧会话按时间排不进收起列表的这一页，被画在最前面，标题却是「新会话」、没有时间——
  // 那一行只拿得到实例广播里的 title（终端来的会话不在 sessions.json 里，是 null）。看起来像多出一个空白新会话。
  test('P0-LIVE-3 被分页挤出本页的已开会话：照样画在前面，但标题和时间是它自己的', async ({ page }) => {
    await sendChatMessage(page, 'test:live-paged-out');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);

    const row = sessionRowByInstance(page, 'inst_paged');
    await expect(row).toHaveCount(1);
    await expect(row, '标题落成了「新会话」：用户会以为多出来一个空白会话').toContainText('Older Migration Session');
    // 副标题是「时间 · 已打开 · 短 id」；没有时间时就只剩「已打开 · …」（验收里看到的就是这样）
    const subtitle = row.locator('button').first().locator(':scope > div').last();
    await expect(subtitle).toContainText('已打开');
    await expect(subtitle, '没有时间').not.toHaveText(/^已打开/);
  });

  // 验收 O104：关掉一条只在活实例里的会话行（搬走了 transcript 的、平级 worktree 的、被挤出页的）后，服务端
  // 广播已不含它，抽屉开着时那一行却还留着，写着「已打开 ✕」，要关掉抽屉再开才消失（R6 · E1）。
  // 2026-10-22 在 dev@8c616a67 上桌面 / 手机两种宽度都复现不了；这条守的是那个症状：手机上关闭会顺手收起
  // 抽屉，桌面宽度下侧栏常驻、走 setInstances 的局部重建——把那次 rebuildDirSections 去掉，三条全红。
  for (const [scenario, inst, sid] of [['test:live-not-in-list', 'inst_moved', 'mock-session-moved-away'], ['test:live-unowned', 'inst_sibling', 'mock-session-sibling'], ['test:live-paged-out', 'inst_paged', 'mock-session-older-migration']]) {
    test(`P0-LIVE-4 侧栏常驻时关掉只在活实例里的行（${scenario}），行当场消失`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoMock(page);
      await sendChatMessage(page, scenario);
      await waitForIdle(page);
      if (inst !== 'inst_sibling') await expandWorkspace(page, MAIN_WORKSPACE);
      const row = page.locator(`[data-testid="session-row"][data-instance-id="${inst}"]`);
      await expect(row).toHaveCount(1);
      await chooseSessionMenuItem(page, row, 'close');
      await page.locator('#confirmOk').click();
      // 按会话 id 找，不按实例 id：残留的那一行实例 id 可能已经清空，按实例 id 找会把它漏掉、恒绿
      const after = page.locator(`[data-testid="session-row"][data-session-id="${sid}"]`);
      await expect(after, '关掉的会话还挂在侧栏里，写着「已打开 ✕」').toHaveCount(0);
    });
  }

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
