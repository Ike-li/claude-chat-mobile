// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-04 长流式输出与停止/中断', async ({ page }) => {
    await gotoMock(page);

    // 1. 起始状态/假设：fresh state。发送 test:stream-long，等待至少一个 Chunk 出现。
    await sendChatMessage(page, 'test:stream-long');
    await expect(page.locator('#activeStatusPill')).toBeVisible();
    await expect(page.locator('#btnStopNew')).toBeVisible();
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Chunk 1', { timeout: 10_000 });

    // 2. 点击停止按钮。
    await page.locator('#btnStopNew').click();
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
    await page.locator('#btnStopNew').click();
    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('已中断');

    await sendChatMessage(page, 'test:tool');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('All tools executed cleanly');
    await expect(interruptedReply).not.toContainText('Chunk 4');

    await expectNoBrowserErrors(page);
  });
});
