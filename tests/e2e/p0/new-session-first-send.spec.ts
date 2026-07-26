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
