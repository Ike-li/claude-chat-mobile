// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../seed.goto-mock.spec';

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
});
