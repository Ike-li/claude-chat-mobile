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
});
