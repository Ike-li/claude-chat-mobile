// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-02 输入框、发送按钮与空输入边界', async ({ page }) => {
    await gotoMock(page);

    // 1. 起始状态/假设：fresh state，已连接，输入框为空。
    await expect(page.locator('#btnSend')).toBeDisabled();
    await page.locator('#btnSend').click({ force: true });
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);

    // 2. 在输入框输入普通文本 hello。
    await page.locator('#input').fill('hello');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await expect(page.locator('#input')).toHaveValue('hello');

    // 3. 清空输入框。
    await page.locator('#input').fill('');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });
});
