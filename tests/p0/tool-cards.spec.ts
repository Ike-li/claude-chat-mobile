// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-05 工具调用卡片生命周期', async ({ page }) => {
    await gotoMock(page);

    // 1. 起始状态/假设：fresh state。发送 test:tool。
    await sendChatMessage(page, 'test:tool');
    await expect(page.locator('details.thinking')).toBeVisible();
    await expect(page.locator('details.toolcard')).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator('details.toolcard').nth(0)).toContainText('read_file');
    await expect(page.locator('details.toolcard').nth(1)).toContainText('edit_file');
    await expect(page.locator('details.toolcard').nth(2)).toContainText('run_command');
    await expect(page.locator('#activeStatusPill')).toBeVisible();

    // 2. 等待完成并展开第一个工具卡片。
    await waitForIdle(page);
    await page.locator('details.toolcard summary').first().click();
    await expect(page.locator('details.toolcard').first()).toHaveAttribute('open', '');
    await expect(page.locator('details.toolcard pre').first()).toContainText('utils/date.js');
    await expect(page.locator('details.toolcard .t-status')).toHaveText(['✅', '✅', '✅']);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('All tools executed cleanly');

    await expectNoBrowserErrors(page);
  });

  test('P0-05b 工具结果乱序返回仍落到正确卡片', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tool-out-of-order');
    await expect(page.locator('details.toolcard')).toHaveCount(2, { timeout: 10_000 });
    await expect(page.locator('details.toolcard').nth(0)).toContainText('read_file');
    await expect(page.locator('details.toolcard').nth(1)).toContainText('run_command');

    await waitForIdle(page);
    await page.locator('details.toolcard summary').nth(0).click();
    await page.locator('details.toolcard summary').nth(1).click();
    await expect(page.locator('details.toolcard').nth(0)).toContainText('read_file result: config.json');
    await expect(page.locator('details.toolcard').nth(0)).not.toContainText('command result: npm run check');
    await expect(page.locator('details.toolcard').nth(1)).toContainText('command result: npm run check');
    await expect(page.locator('details.toolcard').nth(1)).not.toContainText('read_file result: config.json');
    await expect(page.locator('details.toolcard .t-status')).toHaveText(['✅', '✅']);

    await expectNoBrowserErrors(page);
  });
});
