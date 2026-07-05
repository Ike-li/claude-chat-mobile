// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-17 后台 task_progress 横幅原地刷新', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:taskprogress 后出现后台任务进度横幅。
    await sendChatMessage(page, 'test:taskprogress');
    await expect(page.locator('#taskProgressBanner')).toBeVisible();
    await expect(page.locator('#taskProgressText')).toContainText('步骤', { timeout: 10_000 });

    // 2. 心跳原地刷新，完成后撤下。
    await expect(page.locator('#taskProgressText')).toContainText('步骤 3/3', { timeout: 10_000 });
    await expect(page.locator('#taskProgressBanner')).toHaveCount(1);
    await waitForIdle(page);
    await expect(page.locator('#taskProgressBanner')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-17b 后台任务失败通知撤下进度横幅', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:taskprogress-failed');
    await expect(page.locator('#taskProgressBanner')).toBeVisible();
    await expect(page.locator('#taskProgressText')).toContainText('步骤 2/3', { timeout: 10_000 });
    await waitForIdle(page);
    await expect(page.locator('#taskProgressBanner')).toBeHidden();
    await expect(page.locator('#messages')).toContainText('后台任务失败');
    await expect(page.locator('#messages')).toContainText('mock background task failed');

    await expectNoBrowserErrors(page);
  });

  test('P0-17c 终端只读追平会锁定输入并允许显式接管', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:mirror-readonly');
    await expect(page.locator('#mirrorBanner')).toBeVisible();
    await expect(page.locator('#mirrorBanner')).toContainText('此会话正在终端运行');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#btnSend')).toBeDisabled();

    await page.locator('#btnMirrorOverride').click();
    await expect(page.locator('#mirrorBanner')).toBeHidden();
    await expect(page.locator('#input')).toBeEnabled();

    await sendChatMessage(page, 'take over from terminal');
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('take over from terminal');

    await expectNoBrowserErrors(page);
  });

  test('P0-17d 切换会话会清除只读追平锁', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await sendChatMessage(page, 'test:mirror-readonly');
    await expect(page.locator('#mirrorBanner')).toBeVisible();
    await expect(page.locator('#input')).toBeDisabled();

    await page.locator('#btnSessions').click();
    await page.locator('div[data-dir="/Users/you/code/another-react-project"] button').first().click();
    await page.locator('button[title="Another App Concurrency"]').click();
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#mirrorBanner')).toBeHidden();
    await expect(page.locator('#input')).toBeEnabled();
    await expect(page.locator('#btnSend')).toBeDisabled();

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:settings-echo');

    await expectNoBrowserErrors(page);
  });

  test('P0-17f 终端只读锁到来时保留草稿且接管后可发送', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:mirror-readonly-delayed');
    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expect(page.locator('#mirrorBanner')).toBeVisible();
    await expect(page.locator('#mirrorBanner')).toContainText('此会话正在终端运行');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveAttribute('title', '请先完成设备授权或解除只读状态');

    await page.locator('#btnMirrorOverride').click();
    await expect(page.locator('#mirrorBanner')).toBeHidden();
    await expect(page.locator('#input')).toBeEnabled();
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await page.locator('#btnSend').click();
    await waitForIdle(page);
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:settings-echo');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');
    await expect(page.locator('#input')).toHaveValue('');

    await expectNoBrowserErrors(page);
  });

  test('P0-17e 后台 task_progress 不污染当前会话但保留忙碌角标', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:background-taskprogress');
    await waitForIdle(page);

    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#taskProgressBanner')).toBeHidden();
    await expect(page.locator('#messages')).not.toContainText('另一个工作区正在运行后台任务');
    await expect(page.locator('#sessionsDot')).toHaveText('⏳');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区运行中');

    await page.locator('#btnSessions').click();
    const backgroundDir = page.locator('#sessionPanel div[data-dir="/Users/you/code/another-react-project"]');
    await expect(backgroundDir.locator('.dir-badge')).toHaveText('⏳');
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('title', '运行中');
    await backgroundDir.locator('button').first().click();
    const backgroundRow = page.locator('[data-testid="session-row"][data-instance-id="inst_2"]');
    await expect(backgroundRow.locator('[data-instance-badge]')).toHaveText('🤖');
    await expect(backgroundRow.locator('[data-instance-badge]')).toHaveAttribute('title', '运行中：Task');

    await expectNoBrowserErrors(page);
  });
});
