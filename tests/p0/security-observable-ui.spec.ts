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

  test('P0-20b 鉴权失败显示令牌输入页且重输后恢复连接', async ({ page }) => {
    const consoleText: string[] = [];
    captureBrowserErrors(page);
    page.on('console', message => consoleText.push(message.text()));
    await page.request.post('/__reset');

    await page.goto('/#token=bad-token');
    await expect.poll(() => page.url()).not.toContain('bad-token');
    await expect(page.locator('#authGate')).toBeVisible();
    await expect(page.locator('#authError')).toContainText('令牌无效，请重新输入');
    await expect(page.locator('#connDot')).not.toHaveClass(/bg-success/);
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('bad-token');
    expect(consoleText.join('\n')).not.toContain('bad-token');

    await page.locator('#authToken').fill('mock-token');
    await page.locator('#authSubmit').click();
    await expect(page.locator('#authGate')).toBeHidden();
    await expect(page.locator('#connDot')).toHaveClass(/bg-success/);
    await expect(page.locator('#input')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('mock-token');
    expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe('mock-token');
    expect(consoleText.join('\n')).not.toContain('mock-token');

    await expectNoBrowserErrors(page);
  });
});
