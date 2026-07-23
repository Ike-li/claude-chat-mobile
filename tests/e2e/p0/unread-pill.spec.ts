// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, MAIN_WORKSPACE, expectSidebarClosed, openWorkspaceSession, openSessionsSidebar } from '../../helpers/p0-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-24 未读角标：切回会话展示未读数，点击跳转到锚点并高亮，随后自动消失', async ({ page }) => {
    await gotoMock(page);

    // test:tab：先把 inst_2 注册进 mockInstances（同 P0-14 系列的既有两步套路）——不然
    // test:unread-pill 直接切 viewingInstanceId 到一个尚不存在的实例，bindView 会落到空首页分支。
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    // test:unread-pill：mock 切到 inst_2，sync:since ack 带 unreadOnEntry=1（该会话固定回放 2 条顶层
    // 气泡：user_message + text_delta 各一条，unreadOnEntry=1 应指向最后一条即 assistant 回复）。
    await sendChatMessage(page, 'test:unread-pill');

    const pill = page.locator('#unreadPill');
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#unreadPillCount')).toHaveText('1');

    const anchor = page.locator('[data-testid="assistant-message"]').last();
    await expect(anchor).toContainText('This is the concurrent session');

    // 仿微信"以下为新消息"分割线：插在锚点前，随高亮同一节奏出现/消失，不进入 sessionDomCache
    // （data-ephemeral="1"，同 streamLiveStatus 的既有排除机制）。
    const divider = page.locator('#unreadDivider');
    await expect(divider).toBeHidden();

    await pill.click();

    await expect(pill).toBeHidden();
    await expect(anchor).toHaveClass(/unread-anchor-flash/);
    await expect(divider).toBeVisible();
    await expect(divider).toContainText('以下为新消息');
    // 分割线须在锚点之前（DOM 顺序），不是随便扔在消息区某处
    const order = await page.evaluate(() => {
      const d = document.querySelector('#unreadDivider');
      const a = document.querySelector('[data-testid="assistant-message"]:last-of-type');
      if (!d || !a) return null;
      return d.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING ? 'divider-before-anchor' : 'other';
    });
    expect(order).toBe('divider-before-anchor');

    await expect(divider).toBeHidden({ timeout: 3_000 }); // 与 flash 同 2s 生命周期后自动移除

    await expectNoBrowserErrors(page);
  });

  // 陷阱记录（排查耗时较长，完整记录避免下次重踩）：分割线自带 2s 自毁计时器（跟随最初创建它的
  // DOM 节点对象，不因该节点被 sessionDomCache 缓存/appendChild 挪动位置而失效）——这意味着"缓存
  // 恢复路径最终 DOM 上还有没有它"这个信号在 2s 内外都会被计时器兜底清空，无法用来判断
  // "有没有被正确排除出缓存"。用 Element.prototype.remove 打点 + 用户可见 DOM 快照实测过：
  // 即便 stripEphemeralMessageNodes 完全没有过滤掉它（即 bug 复现），appendChild 恢复后它确实
  // 存在于 DOM（page.evaluate 同步查询能立即看到），但只要整个切走再切回流程在 2s 内完成，原计时器
  // 依然会准时把它清掉，让"最终 toHaveCount(0)"断言在有 bug 和无 bug 两种情况下都通过——不是
  // 等待时机不够，是这个断言本身选错了要观察的信号。
  // 真正能定位"是否被正确排除出缓存"的时刻，是"切回后、计时器触发前"那个短暂窗口——分割线要么
  // 从未被恢复（修复生效），要么被恢复后短暂可见、2s 后才被计时器清掉（修复失效）。故断言必须在
  // 缓存恢复完成后立即同步检查，不能给计时器窗口留出可乘之机。
  test('P0-24b 分割线不进入 sessionDomCache：切走再切回不残留', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await sendChatMessage(page, 'test:unread-pill'); // 切到 inst_2（ANOTHER_WORKSPACE），前端跟随 viewingInstanceId

    const pill = page.locator('#unreadPill');
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await pill.click();
    await expect(page.locator('#unreadDivider')).toBeVisible();

    // 切到主工作区（触发 sessionDomCache.set 缓存 inst_2 当前 DOM，此刻分割线仍在树上）
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');
    await expectSidebarClosed(page);

    // 切回 inst_2（命中 sessionDomCache 缓存恢复路径）
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');
    await expectSidebarClosed(page);
    // 确认缓存恢复真正落地（消息内容已是 inst_2 的），而不是还没跑到 bindView
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('This is the concurrent session');

    // 决定性断言：必须用一次性同步查询（locator.count()，不自动重试），不能用 expect(locator).toHaveCount()
    // 或 expect.poll()——这两者的默认轮询窗口（本项目 playwright.config.ts expect.timeout=8000ms）
    // 远超 2s 清理计时器的生命周期，无论有没有 bug，轮询早晚都会等到"计时器把它清掉"这个状态而判定
    // 通过，让断言形同虚设。toContainText 已确认 bindView 的同步恢复流程（含 appendChild 缓存节点）
    // 已经跑完，此刻查一次即代表真相，不需要再等。
    const dividerCountAfterRestore = await page.locator('#unreadDivider').count();
    expect(dividerCountAfterRestore, '缓存恢复后不应观察到分割线复活（即便随后 2s 计时器会清掉它）').toBe(0);

    await expectNoBrowserErrors(page);
  });
});
