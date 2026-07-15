// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-01 首屏冷启动、hydration 与连接状态', async ({ page }) => {
    // 1. 起始状态/假设：fresh browser context；打开 mock 页面，不依赖真实 Claude。
    await gotoMock(page);

    await expect(page).toHaveTitle(/Claude Chat Mobile/);
    await expect(page.locator('#btnSessions')).toBeVisible();
    await expect(page.locator('#btnConsole')).toBeVisible();
    await expect(page.locator('#btnNew')).toBeVisible();
    await expect(page.locator('#messages')).toBeVisible();
    await expect(page.locator('#input')).toBeVisible();
    await expect(page.locator('#btnAttach')).toBeVisible();
    await expect(page.locator('#btnSettings')).toBeVisible();
    await expect(page.locator('#btnSend')).toBeVisible();

    // 2. 读取首屏用户可见文本与可交互控件。
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#input')).toHaveAttribute('placeholder', /给 Claude 发消息/);
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#pillModelText')).not.toHaveText('');
    await expect(page.locator('#pillPermText')).toContainText('默认审批');

    await expectNoBrowserErrors(page);
  });
});
