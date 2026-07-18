// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
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
    await ensureComposerReady(page);

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

  test('P0-16f 客户端日志落盘 localStorage 并在 reload 后恢复（抗 PWA 被杀）+ recv 对账锚点', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);

    // turn 结果到达记 recv 锚点（send↔recv 对账）
    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleLogArea')).toContainText('WEB_RECV');
    await page.locator('#consoleClose').click();

    // 落盘：环形缓冲已同步写入 localStorage（首条 log 即写，不等节流）
    const persisted = await page.evaluate(() => localStorage.getItem('ccm_client_logs'));
    expect(persisted).toBeTruthy();
    expect(persisted).toContain('client_');

    // reload：localStorage 保留 → 恢复上次会话日志（restored），抽屉非空、不报错
    await page.reload();
    await ensureComposerReady(page);
    const afterReload = await page.evaluate(() => localStorage.getItem('ccm_client_logs'));
    expect(afterReload).toBeTruthy();

    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleModal')).toBeVisible();
    await expect(page.locator('#consoleLogArea')).not.toBeEmpty();

    await expectNoBrowserErrors(page);
  });

  test('P0-16g Console「复制全部」按钮存在且点击有反馈', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await gotoMock(page);

    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);

    await page.locator('#btnConsole').click();
    await expect(page.locator('#consoleCopy')).toBeVisible();
    await page.locator('#consoleCopy').click();
    await expect(page.locator('#consoleCopy')).toHaveText(/已复制|复制失败/);

    await expectNoBrowserErrors(page);
  });
});
