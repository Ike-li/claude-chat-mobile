// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-15 设备信赖 TOFU、pending device request 与访问帮助', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:tofu 后显示等待授权 overlay。
    await sendChatMessage(page, 'test:tofu');
    await expect(page.locator('#deviceModal')).toBeVisible();
    await expect(page.locator('#deviceModalId')).toHaveText('unauthorized-fingerprint-999');
    await expect(page.locator('#deviceModal')).toContainText('node scripts/device.js approve');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#deviceModal')).toBeHidden({ timeout: 12_000 });
    await expect(page.locator('#input')).toBeEnabled();

    // 2. 可信设备视角出现 pending device request 卡片，并可打开访问帮助。
    await gotoMock(page);
    await sendChatMessage(page, 'test:devicerequests');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="device-card"]').first()).toContainText('aa-bb-cc-dd');
    await expect(page.locator('[data-testid="device-card"]').first()).toContainText('192.168.1.100');

    await page.locator('#btnSettings').click();
    await page.locator('#accessHelpOpen').click();
    await expect(page.locator('#accessHelp')).toBeVisible();
    await expect(page.locator('#accessHelp')).toContainText('令牌');
    await page.locator('#accessHelpClose').click();
    await expect(page.locator('#accessHelp')).toBeHidden();

    await expectNoBrowserErrors(page);
  });
});
