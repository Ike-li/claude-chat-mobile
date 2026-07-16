// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { ANOTHER_WORKSPACE, openSessionsSidebar, openWorkspaceSession } from '../../helpers/p0-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-16 交互日志 Console modal', async ({ page }) => {
    await gotoMock(page);

    // 1. 点击顶部日志按钮打开交互日志 bottom sheet。
    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleModal')).toBeVisible();
    await expect(page.locator('#consoleModal')).toContainText('交互日志');
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

  test('P0-16d Console 切换会话后显示当前会话 trace', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);

    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleModal')).toBeVisible();
    await expect(page.locator('#consoleLogArea')).toContainText('Session trace for Visual Sandbox (Main)');
    await page.locator('#consoleClose').click();
    await expect(page.locator('#consoleModal')).toBeHidden();

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Another App Concurrency', { timeout: 10_000 });

    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleModal')).toBeVisible();
    await expect(page.locator('#consoleLogArea')).toContainText('Session trace for Another App Concurrency');
    await expect(page.locator('#consoleLogArea')).not.toContainText('Session trace for Visual Sandbox (Main)');

    await expectNoBrowserErrors(page);
  });

  test('P0-16e Console 清空后新日志到来可重新显示且不清聊天', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('Simulated Terminal StatusLine updated successfully');

    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleModal')).toBeVisible();
    await expect(page.locator('#consoleLogArea')).toContainText('[MOCK_LOG]');
    await page.locator('#consoleClear').click();
    await expect(page.locator('#consoleLogArea')).toBeEmpty();
    await page.locator('#consoleClose').click();
    await expect(page.locator('#consoleModal')).toBeHidden();

    await sendChatMessage(page, 'test:console-log-after-clear');
    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('Console log after clear completed.');

    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleModal')).toBeVisible();
    await expect(page.locator('#consoleLogArea')).toContainText('[MOCK_LOG_AFTER_CLEAR]');
    await expect(page.locator('#consoleLogArea')).toContainText('test:console-log-after-clear');

    await expect(page.locator('#messages')).toContainText('Simulated Terminal StatusLine updated successfully');
    await expect(page.locator('#messages')).toContainText('Console log after clear completed.');

    await expectNoBrowserErrors(page);
  });
});
