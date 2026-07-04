// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { captureBrowserErrors, expectNoBrowserErrors } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-20 安全与鉴权可观测 UI 行为', async ({ page }) => {
    const consoleText: string[] = [];
    captureBrowserErrors(page);
    page.on('console', message => consoleText.push(message.text()));
    await page.request.post('/__reset');

    // 1. URL hash #token=mock-token 打开后 token 存入 localStorage，地址栏清理。
    await page.goto('/#token=mock-token');
    await expect(page.locator('#input')).toBeVisible();
    await expect.poll(() => page.url()).not.toContain('mock-token');
    expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe('mock-token');
    await expect(page.locator('body')).not.toContainText('mock-token');

    // 2. 日志只允许脱敏 token，不应泄露完整 token。
    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleModal')).toBeVisible();
    await expect(page.locator('#consoleModal')).not.toContainText('mock-token');
    expect(consoleText.join('\n')).not.toContain('mock-token');

    await expectNoBrowserErrors(page);
  });
});
