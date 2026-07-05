// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-16 交互日志 Console modal', async ({ page }) => {
    await gotoMock(page);

    // 1. 点击顶部日志按钮打开交互日志 bottom sheet。
    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleModal')).toBeVisible();
    await expect(page.locator('#consoleModal')).toContainText('Current Session Trace');
    await expect(page.locator('#consoleClose')).toBeVisible();
    await expect(page.locator('#consoleClear')).toBeVisible();
    await page.locator('#consoleClear').click();
    await expect(page.locator('#messages')).toBeVisible();
    await page.locator('#consoleClose').click();
    await expect(page.locator('#consoleModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-16b Console 清屏只清日志不清聊天内容', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:statusline');
    await expect(page.locator('#messages')).toContainText('Simulated Terminal StatusLine updated successfully');

    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleModal')).toBeVisible();
    await expect(page.locator('#consoleLogArea')).toContainText('[MOCK_LOG]');
    await page.locator('#consoleClear').click();
    await expect(page.locator('#consoleLogArea')).toBeEmpty();
    await page.locator('#consoleClose').click();
    await expect(page.locator('#consoleModal')).toBeHidden();

    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:statusline');
    await expect(page.locator('#messages')).toContainText('Simulated Terminal StatusLine updated successfully');

    await expectNoBrowserErrors(page);
  });

  test('P0-16c Console 打开关闭不丢输入草稿', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#input').fill('draft before console');
    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleModal')).toBeVisible();
    await page.locator('#consoleClose').click();
    await expect(page.locator('#consoleModal')).toBeHidden();
    await expect(page.locator('#input')).toHaveValue('draft before console');

    await page.locator('#btnSend').click();
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('draft before console');
    await expect(page.locator('#input')).toHaveValue('');

    await expectNoBrowserErrors(page);
  });
});
