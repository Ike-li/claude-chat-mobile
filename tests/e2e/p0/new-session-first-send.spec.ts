// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-12 新会话首发 busy 连续性与不闪回首页', async ({ page }) => {
    await gotoMock(page);

    // 1. 新会话首发后 busy 不被懒开广播冲掉。
    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await sendChatMessage(page, 'test:freshbusy');
    await expect(page.locator('#streamLiveStatus')).toBeVisible();
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('新会话首发回复', { timeout: 10_000 });
    await waitForIdle(page);

    await expectNoBrowserErrors(page);
  });

  // 新会话首发的乐观气泡必须活过懒开清屏（2026-08-27，修「发出去的消息消失」）。
  // 新会话比"已有会话"多一道坎：服务端懒开实例后会 broadcastInstances，viewingInstanceId 由 null 变成
  // 新实例 → 前端 setInstances 判定视图变了 → bindView → clearView 清空 #messages。乐观气泡若挺不过
  // 这次清屏，就会「出现一下又消失、等服务端回显才回来」——正是真机反馈里的"闪烁一下才出现"。
  // 走 test:slow-echo：mock 先懒开广播、再延迟 2s 回显，把清屏与回显之间那段窗口撑开到可断言。
  test('P0-12c 新会话首发的乐观气泡活过懒开清屏，且不与回显重复', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    // 「闪烁」= 气泡出现过、又消失、再回来。光靠事后断言"最终有一条"抓不到它（修复前最终也有一条，
    // 只是中间空了 2 秒）。这里挂一个 MutationObserver 记录【首次出现之后】的最小气泡数：
    // 掉到 0 就说明它中途消失过。零 sleep、纯事件驱动，不依赖任何猜测的时间点。
    // 注意这个判据同时天然正确地放过"同步清屏 + 同步恢复"——同一个同步块内的中间态浏览器不会重绘，
    // MutationObserver 的回调也排在其后，用户根本看不见。看不见的消失不算消失。
    await page.evaluate(() => {
      const w = window as unknown as { __seenBubble: boolean; __minAfterFirst: number };
      w.__seenBubble = false;
      w.__minAfterFirst = Infinity;
      const box = document.getElementById('messages')!;
      const sample = () => {
        const n = box.querySelectorAll('[data-testid="user-message"]').length;
        if (n > 0) w.__seenBubble = true;
        if (w.__seenBubble && n < w.__minAfterFirst) w.__minAfterFirst = n;
      };
      new MutationObserver(sample).observe(box, { childList: true, subtree: true });
      sample();
    });

    await page.locator('#input').fill('test:slow-echo');
    await page.locator('#btnSend').click();

    // 懒开广播已到达（离开空表面），但服务端回显还在 2s 延迟里——这中间气泡必须一直在。
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);
    const bubbles = page.locator('[data-testid="user-message"]');
    await expect(bubbles).toHaveCount(1, { timeout: 800 });
    await expect(bubbles.last()).toContainText('test:slow-echo');
    await expect(bubbles.last()).toHaveClass(/opacity-70/);

    // 回显到达 → 原地转正，仍是一条
    await expect(bubbles.last()).not.toHaveClass(/opacity-70/, { timeout: 10_000 });
    await expect(bubbles).toHaveCount(1);

    // 核心：整段窗口里气泡一次都没消失过（修复前这里是 0——被懒开广播的 clearView 冲掉了）
    const minAfterFirst = await page.evaluate(
      () => (window as unknown as { __minAfterFirst: number }).__minAfterFirst);
    expect(minAfterFirst).toBeGreaterThanOrEqual(1);

    await expectNoBrowserErrors(page);
  });

  // 全新会话首轮点停止后不跳回主页：sessionId 尚未由 SDK init 返回（本例全程 sessionId 恒 null）时
  // 点"停止"，界面应留在聊天视图（用户消息气泡 + 中断提示可见，输入条可用），不应回落 home/compose
  // 空表面；随后应能正常再发一条消息并收到回复。
  test('P0-13 全新会话首轮点停止后不跳回主页', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnNew').click();
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await sendChatMessage(page, 'test:fresh-interrupt');
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    // bindView 已处理懒开广播（离开空表面）——此刻 sessionId 仍未知，正是本任务要修的窗口。
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);

    await page.locator('#btnSend[data-mode="stop"]').click();
    await waitForIdle(page);

    // 核心断言：不应跳回 home/compose 空表面。
    await expect(page.locator('[data-testid="home-dashboard"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="compose-surface"]')).toHaveCount(0);
    await expect(page.locator('#messages')).not.toHaveClass(/empty-start/);
    await expect(page.locator('#messages')).toContainText('已中断');
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:fresh-interrupt');
    await expect(page.locator('#input')).toBeVisible();
    await expect(page.locator('#input')).toBeEditable();

    // composer 真正可用：还能正常再发一条消息并收到回复（同一实例可续用）——
    // sendChatMessage 内部会先断言填字后 #btnSend 可点，比空输入时检查 enabled 更能说明问题。
    await sendChatMessage(page, 'test:tool');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('All tools executed cleanly');

    await expectNoBrowserErrors(page);
  });
});
