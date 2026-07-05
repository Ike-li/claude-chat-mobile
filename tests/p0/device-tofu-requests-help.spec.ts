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

  test('P0-15b pending device request 准入/拒绝后卡片即时更新', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:devicerequests');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(2);

    const iphoneCard = page.locator('[data-testid="device-card"][data-device-id="aa-bb-cc-dd-iphone-15-pro"]');
    await iphoneCard.getByRole('button', { name: /准入/ }).click();
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(1);
    await expect(page.locator('#deviceRequests')).not.toContainText('aa-bb-cc-dd-iphone-15-pro');
    await expect(page.locator('#deviceRequests')).toContainText('ee-ff-00-11-ipad-air-m2');

    const ipadCard = page.locator('[data-testid="device-card"][data-device-id="ee-ff-00-11-ipad-air-m2"]');
    await ipadCard.getByRole('button', { name: /拒绝/ }).click();
    await expect(page.locator('[data-testid="device-card"]')).toHaveCount(0);
    await expect(page.locator('#deviceRequests')).toHaveClass(/hidden/);
    await expect(page.locator('#input')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-15c 设备被拒后显示拒绝页并可打开访问帮助', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tofu-denied');
    await expect(page.locator('#deviceDenied')).toBeVisible();
    await expect(page.locator('#deviceDenied')).toContainText('设备未获授权');
    await expect(page.locator('#deviceDenied')).toContainText('重新请求接入');

    await page.locator('#deviceDeniedHelp').click();
    await expect(page.locator('#accessHelp')).toBeVisible();
    await expect(page.locator('#accessHelp')).toContainText('新设备怎么获批');
    await page.locator('#accessHelpClose').click();
    await expect(page.locator('#accessHelp')).toBeHidden();
    await expect(page.locator('#deviceDenied')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-15d 设备被拒后可重新请求接入并回到等待授权态', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tofu-denied');
    await expect(page.locator('#deviceDenied')).toBeVisible();

    await page.locator('#deviceDeniedRetry').click();
    await expect(page.locator('#deviceDenied')).toBeHidden();
    await expect(page.locator('#deviceModal')).toBeVisible();
    await expect(page.locator('#deviceModalId')).toHaveText('unauthorized-fingerprint-999');
    await expect(page.locator('#deviceModal')).toContainText('node scripts/device.js approve');
    await expect(page.locator('#input')).toBeDisabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-15e 等待设备授权期间保留草稿且禁止发送', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tofu-delayed');
    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expect(page.locator('#deviceModal')).toBeVisible();
    await expect(page.locator('#deviceModalId')).toHaveText('unauthorized-fingerprint-999');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveAttribute('title', '请先完成设备授权或解除只读状态');

    await expect(page.locator('#deviceModal')).toBeHidden({ timeout: 12_000 });
    await expect(page.locator('#input')).toBeEnabled();
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await page.locator('#btnSend').click();
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    await expectNoBrowserErrors(page);
  });

  test('P0-15f 设备被拒期间保留草稿且继续禁止发送', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tofu-denied-delayed');
    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expect(page.locator('#deviceModal')).toBeVisible();
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeDisabled();

    await expect(page.locator('#deviceDenied')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('#deviceDenied')).toContainText('设备未获授权');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveAttribute('title', '请先完成设备授权或解除只读状态');

    await page.locator('#deviceDeniedRetry').click();
    await expect(page.locator('#deviceDenied')).toBeHidden();
    await expect(page.locator('#deviceModal')).toBeVisible();
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeDisabled();

    await expectNoBrowserErrors(page);
  });
});
