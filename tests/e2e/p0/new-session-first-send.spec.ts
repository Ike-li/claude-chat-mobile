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
});
