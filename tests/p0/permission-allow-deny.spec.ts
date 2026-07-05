// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-06 权限审批 allow/deny 与本会话总是允许', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:permission 后显示权限请求 bottom sheet。
    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permCwd')).toContainText('/Users/you/code/claude-chat-mobile');
    await expect(page.locator('#permInput')).toContainText('"git push origin main"');
    await expect(page.locator('#permAlways')).toBeVisible();

    // 2. 点击允许，工具卡片成功。
    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveText('✅');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Successfully pushed');

    // 3. fresh state 后点击拒绝，工具卡片拒绝。
    await gotoMock(page);
    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveText('🚫');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('rejected by user');

    await expectNoBrowserErrors(page);
  });

  test('P0-06b 本会话总是允许同类操作后不再重复弹审批', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await page.locator('#permAlways').check();
    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);

    await sendChatMessage(page, 'test:permission');
    await waitForIdle(page);
    await expect(page.locator('#permModal')).toBeHidden();
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Successfully pushed');

    await expectNoBrowserErrors(page);
  });

  test('P0-06c 其它设备解决权限请求后当前审批弹窗自动关闭', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission-remote-resolved');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permInput')).toContainText('git push origin main');

    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveText('✅');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('approved on another trusted device');

    await expectNoBrowserErrors(page);
  });

  test('P0-06d 本会话总是允许不会泄漏到另一会话', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await page.locator('#permAlways').check();
    await page.locator('#permAllow').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await page.locator('#btnSessions').click();
    await page.locator('div[data-dir="/Users/you/code/another-react-project"] button').first().click();
    await page.locator('button[title="Another App Concurrency"]').click();
    await expect(page.locator('#pillPermText')).toContainText('计划模式');

    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');

    await expectNoBrowserErrors(page);
  });
});
