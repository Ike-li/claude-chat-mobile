// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-04 长流式输出与停止/中断', async ({ page }) => {
    await gotoMock(page);

    // 1. 起始状态/假设：fresh state。发送 test:stream-long，等待至少一个 Chunk 出现。
    await sendChatMessage(page, 'test:stream-long');
    await expect(page.locator('#streamLiveStatus')).toBeVisible();
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Chunk 1', { timeout: 10_000 });

    // 2. 空输入时发送钮 morph 为停止，点击中止。
    await page.locator('#btnSend[data-mode="stop"]').click();
    await waitForIdle(page);
    await page.locator('#input').fill('hello after interrupt');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-04b 停止后旧长流不再继续追加到旧消息', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:stream-long');
    const interruptedReply = page.locator('[data-testid="assistant-message"]').filter({ hasText: 'Chunk 1' }).first();
    await expect(interruptedReply).toContainText('Chunk 1', { timeout: 10_000 });
    await page.locator('#btnSend[data-mode="stop"]').click();
    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('已中断');

    await sendChatMessage(page, 'test:tool');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('All tools executed cleanly');
    await expect(interruptedReply).not.toContainText('Chunk 4');

    await expectNoBrowserErrors(page);
  });

  test('P0-04c 连续点击停止只显示一次中断反馈', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:stream-long');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Chunk 1', { timeout: 10_000 });

    await page.locator('#btnSend[data-mode="stop"]').dblclick();
    await waitForIdle(page);
    await expect(page.locator('#messages .msg-frame.text-center').filter({ hasText: '已中断' })).toHaveCount(1);

    await page.locator('#input').fill('hello after double interrupt');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });
});
