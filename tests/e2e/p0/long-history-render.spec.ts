// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

// Part B 性能优化：长会话（2000 条，触达 src/sessions/history.js 的 HISTORY_MAX_MESSAGES 上限）切入时
// renderHistoryBubbles 改成分块渲染（public/js/app.js），验证：①最终结果与同步版等价（不丢/不重复）；
// ②分块确实多次让出主线程（而非一次性同步任务）；③渲染中途切走不残留半渲染气泡。
test.describe('P0 长会话切入分块渲染', () => {
  test('P0-LH1 渲染完毕消息总数与输入等价，不丢不重复', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expectSidebarClosed(page);

    await expect(page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' }))
      .toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="user-message"], [data-testid="assistant-message"]')).toHaveCount(2000);

    await expectNoBrowserErrors(page);
  });

  test('P0-LH2 分块渲染多次让出主线程，而非一次性同步任务跑完', async ({ page }) => {
    await gotoMock(page);

    // 用调用次数（而非墙钟计时）判定是否让出——不依赖机器速度，避免时间竞争型断言的固有 flaky 风险。
    // 2000 条/每块 40 条 ≈ 50 块：分块实现应触发数十次 requestIdleCallback；一次性同步实现只会为
    // 收尾高亮调用 1 次。
    await page.evaluate(() => {
      const w = window as unknown as { __idleCallCount: number };
      w.__idleCallCount = 0;
      const orig = window.requestIdleCallback?.bind(window);
      window.requestIdleCallback = ((cb: IdleRequestCallback, opts?: IdleRequestOptions) => {
        w.__idleCallCount++;
        return orig ? orig(cb, opts) : window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline), 0);
      }) as typeof window.requestIdleCallback;
    });

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expectSidebarClosed(page);

    await expect(page.locator('[data-testid="assistant-message"]', { hasText: 'Long history final message marker' }))
      .toBeVisible({ timeout: 15000 });

    const idleCallCount = await page.evaluate(() => (window as unknown as { __idleCallCount: number }).__idleCallCount);
    expect(idleCallCount).toBeGreaterThan(10);

    await expectNoBrowserErrors(page);
  });

  test('P0-LH3 渲染中途切走不残留半渲染气泡，迟到的续块回调也不污染当前会话', async ({ page }) => {
    await gotoMock(page);

    // 冻结分块调度：只捕获第一次 requestIdleCallback 的回调、不执行，让渲染确定性地卡在第一块（40 条）
    // 之后——不依赖真实时间竞争去猜「切走时是否恰好还没渲染完」。
    await page.evaluate(() => {
      const w = window as unknown as { __frozenIdleCallback: IdleRequestCallback | null };
      w.__frozenIdleCallback = null;
      window.requestIdleCallback = ((cb: IdleRequestCallback) => {
        if (w.__frozenIdleCallback === null) w.__frozenIdleCallback = cb;
        return 0;
      }) as typeof window.requestIdleCallback;
    });

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expectSidebarClosed(page);

    // 不在这里断言「DOM 仍是 0 条」——那会和「session:history 还没回来」抢同一个假窗口，
    // 同步实现下也会碰巧通过。真正有区分力的是：分块中途切走后目标会话正确，且迟到的
    // 续块回调不污染新会话（displayedInstanceId 守卫）。
    // 等第一块同步处理完并调度过被冻结的 idle 回调（不依赖墙钟 waitForTimeout）。
    await expect.poll(async () => page.evaluate(() => {
      const w = window as unknown as { __frozenIdleCallback: IdleRequestCallback | null };
      return w.__frozenIdleCallback !== null;
    })).toBe(true);

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10000 });
    await expect(page.locator('#messages')).not.toContainText('Long history stress message');

    // 即使浏览器之后才姗姗来迟地触发那个被冻结的续块回调，也不该污染已经切换到的会话 DOM
    // （displayedInstanceId 快照守卫，见 public/js/app.js renderHistoryBubbles 的 processChunk）。
    await page.evaluate(() => {
      const w = window as unknown as { __frozenIdleCallback: IdleRequestCallback | null };
      w.__frozenIdleCallback?.({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline);
    });
    await expect(page.locator('#messages')).not.toContainText('Long history stress message');
    await expect(page.locator('#messages')).toContainText('Summarize archived plan');

    await expectNoBrowserErrors(page);
  });
});
