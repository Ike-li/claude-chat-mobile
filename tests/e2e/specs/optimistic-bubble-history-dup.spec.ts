// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

// 在线乐观气泡与历史全量重载撞成两条（2026-08-27）。
//
// a417c08 让在线发送重新建本地气泡，并在 clearView 里【保住】未确认气泡挺过懒开清屏。它防住了
// 「气泡闪一下才出现」，但同时打开了另一条门：clearView 之后紧接着的 loadHistory 是【不清屏、
// 直接追加】的（renderHistoryBubbles 只 append fragment，清屏责任全在调用方）。而真 server 一
// 收到 user:message 就把它写进 transcript——于是那次全量重载拉回来的历史里，本来就含这条消息。
// 保住的乐观气泡 + 历史里的同一条 = 两颗气泡，且乐观那颗还排在整段历史【前面】。
//
// 触发条件是日常路径，不是边角：已有会话 + 实例被 INSTANCE_IDLE_RECLAIM_MS 回收后懒开 →
// 换实例广播 → bindView → diskLen(已含新消息) > seenDiskLen → shouldReloadOnEnter 判 'reload'。
//
// 【为什么此前抓不到】a417c08 补的两条用例都跑在新会话上（ensureComposerReady / #btnNew）——
// 新会话没有历史，loadHistory 拉回来的是空，这条重复路径结构性不可达。且 mock 的 sync:since
// 从不回 diskLen（真 server 一直回），'reload' 的磁盘 ahead 分支在整套 E2E 里同样够不着。
test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-DUP-OPT 已有会话发消息后全量重载，乐观气泡不与历史里的同一条重复', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Timeline Session');
    // 历史先落地：seenDiskLen 记成 10，后面 mock 回 diskLen=11 才构成「磁盘 ahead」
    await expect(page.locator('#messages')).toContainText('Timeline today follow-up', { timeout: 10_000 });

    // 「闪烁」= 气泡出现过、又消失、再回来。事后断言"最终有一条"抓不到它。挂 MutationObserver
    // 记录【首次出现之后】的最小气泡数：掉到 0 就说明中途消失过。本次修复要移动/丢弃气泡节点，
    // 这条判据钉死那些操作不能在屏幕上留下空窗（同款手法见 P0-12c）。
    await page.evaluate(() => {
      const w = window as unknown as { __seenDup: boolean; __minDup: number };
      w.__seenDup = false;
      w.__minDup = Infinity;
      const box = document.getElementById('messages')!;
      const sample = () => {
        const n = [...box.querySelectorAll('[data-testid="user-message"]')]
          .filter(b => b.textContent?.includes('test:dup-optimistic')).length;
        if (n > 0) w.__seenDup = true;
        if (w.__seenDup && n < w.__minDup) w.__minDup = n;
      };
      new MutationObserver(sample).observe(box, { childList: true, subtree: true });
      sample();
    });

    await page.locator('#input').fill('test:dup-optimistic');
    await page.locator('#btnSend').click();

    const dup = page.locator('[data-testid="user-message"]').filter({ hasText: 'test:dup-optimistic' });

    // ① 气泡立刻可见（a417c08 修好的那一半，别在修重复时把它退回去）。
    //    刻意不断言此刻是否仍为 opacity-70：全量重载若已把这条带回来，说明服务端确实已经落盘，
    //    气泡转成确认态才是诚实的显示——把"未确认态必须持续到回显"写进断言反而是钉死实现细节。
    await expect(dup.first()).toBeVisible({ timeout: 800 });

    // ② 核心：mock 延迟 2s 才回显 user_message，这中间换实例广播触发的全量重载早已落地。
    //    历史里那条 test:dup-optimistic 若也渲染成气泡，这里就是 2。
    await expect(dup, '历史落地后，同一条消息只该有一颗气泡').toHaveCount(1, { timeout: 5_000 });

    // ③ 回显到达之后依然只有一颗——回显走的是另一条路径（handle.user_message），
    //    它若认领失败会再建一颗，那是第三颗。
    await expect(page.locator('.pending-indicator')).toHaveCount(0, { timeout: 10_000 });
    await expect(dup, '服务端回显到达后仍只有一颗气泡').toHaveCount(1);

    // ④ 顺序：它是最新消息，必须排在整段历史之后，而不是被保住的气泡顶到最前面
    const order = await page.evaluate(() => {
      const bubbles = [...document.querySelectorAll('#messages > [data-top-level="1"]')];
      const idxDup = bubbles.findIndex(b => b.textContent?.includes('test:dup-optimistic'));
      const idxLastHistory = bubbles.map(b => b.textContent || '')
        .reduce((acc, t, i) => (t.includes('Timeline ') ? i : acc), -1);
      return { idxDup, idxLastHistory };
    });
    expect(order.idxDup).toBeGreaterThan(-1);
    expect(order.idxDup, '最新消息必须排在整段历史之后').toBeGreaterThan(order.idxLastHistory);

    // ⑤ 整段窗口里气泡一次都没消失过（丢弃/移动节点若跨了重绘，这里会是 0）
    const minDup = await page.evaluate(() => (window as unknown as { __minDup: number }).__minDup);
    expect(minDup, '气泡在整段窗口里一次都不该消失').toBeGreaterThanOrEqual(1);

    await expectNoBrowserErrors(page);
  });
});
