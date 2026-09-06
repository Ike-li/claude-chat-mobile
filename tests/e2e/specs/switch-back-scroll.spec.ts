// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

// 修「切回会话停在旧位置 + 内容像重播一样慢慢滚到最新」：切走再切回同一会话时，shouldReloadOnEnter
// 的 'keep' 分支恢复的是【离开时缓存的旧内容】底部；离开期间产生的新内容随后才作为 sync:since 补发
// 事件到达，各自走非强制 scrollBottom（未必够到"距底部<120px"阈值）——不强制补一次落底就会停在旧位置。
test.describe('P0 切回会话强制落底', () => {
  test('P0-SCROLL-1 切走再切回：离开期间产生的新内容到达后自动落底到真正的最新消息', async ({ page }) => {
    await gotoMock(page);

    // 1. 注册长历史实例并首次冷切入（30 条基线消息撑满一屏，建立 DOM 缓存）。
    // test:scroll-replay-setup 只广播 instances 快照，不产生 busy/result，无需 waitForIdle。
    await sendChatMessage(page, 'test:scroll-replay-setup');
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Scroll Replay Session');
    await expectSidebarClosed(page);
    await expect(page.locator('[data-testid="user-message"], [data-testid="assistant-message"]'))
      .toHaveCount(30, { timeout: 10_000 });

    // 2. 切回主会话（模拟"离开"）——mock 侧下一次 sync:since 会带上"离开期间产生的新内容"。
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await expectSidebarClosed(page);

    // 3. 再切回去：DOM 缓存命中（hasCache=true）+ 有真实回放内容 → 应强制落底到新消息，而不是停在
    // 缓存的旧内容（消息 #29）底部附近。
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Scroll Replay Session');
    await expectSidebarClosed(page);

    const newMessage = page.locator('[data-testid="assistant-message"]', { hasText: 'This new message arrived while you were on another tab.' });
    await expect(newMessage).toBeVisible({ timeout: 10_000 });
    // 核心断言：必须真正落底（距底部 <5px），而非仅"部分可见"——toBeInViewport() 默认只要求元素与
    // 视口有相交面积即判可见，这条长消息即使停在旧位置（未强制落底）也会因自身够高而蹭到视口顶部，
    // 从而被 toBeInViewport() 误判通过（实测 bug 复现时 distFromBottom≈1161px 仍判 visible）。
    // 直接读 scrollTop/scrollHeight/clientHeight 才是唯一能精确区分"部分可见"与"落底"的断言。
    await expect.poll(() => page.evaluate(() => {
      const el = document.querySelector('#messages');
      return el.scrollHeight - el.scrollTop - el.clientHeight;
    }), { timeout: 10_000 }).toBeLessThan(5);

    await expectNoBrowserErrors(page);
  });
});
