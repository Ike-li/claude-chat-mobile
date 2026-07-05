// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-11 多工作区、多会话 tab、sidebar 与 history replay', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:tab 后出现第二个工作区/会话实例。
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await page.locator('#btnSessions').click();
    await expect(page.locator('#leftSidebar')).not.toHaveClass(/-translate-x-full/);
    await expect(page.locator('#sessionPanel')).toContainText('claude-chat-mobile');
    await expect(page.locator('#sessionPanel')).toContainText('another-react-project');

    // 2. 展开第二工作区并切换到 live 会话，验证 history replay。
    await page.locator('div[data-dir="/Users/you/code/another-react-project"] button').first().click();
    await expect(page.locator('button[title="Another App Concurrency"]')).toBeVisible();
    await page.locator('button[title="Another App Concurrency"]').click();
    await expect(page.locator('#leftSidebar')).toHaveClass(/-translate-x-full/);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Another App Concurrency', { timeout: 10_000 });
    await expect(page.locator('#pillPermText')).toContainText('计划模式');

    await expectNoBrowserErrors(page);
  });

  test('P0-11b 关闭后台会话不影响当前会话', async ({ page }) => {
    await gotoMock(page);
    await page.setViewportSize({ width: 900, height: 812 });

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toContainText('Concurrency Mode Triggered');

    await page.locator('#btnSessions').click();
    await page.locator('div[data-dir="/Users/you/code/another-react-project"] button').first().click();
    const backgroundRow = page.locator('[data-testid="session-row"][data-instance-id="inst_2"]');
    await expect(backgroundRow).toContainText('Another App Concurrency');

    page.once('dialog', dialog => dialog.accept());
    await backgroundRow.locator('button', { hasText: '✕' }).click();
    await expect(page.locator('#leftSidebar')).toHaveClass(/-translate-x-full/);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toContainText('Concurrency Mode Triggered');

    await page.locator('#btnSessions').click();
    await expect(page.locator('#sessionPanel')).toContainText('claude-chat-mobile');
    await expect(page.locator('#sessionPanel')).not.toContainText('another-react-project');

    await expectNoBrowserErrors(page);
  });

  test('P0-11c 后台工作区完成态显示顶部和侧栏角标', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:background-done');
    await waitForIdle(page);
    await expect(page.locator('#sessionsDot')).toBeVisible();
    await expect(page.locator('#sessionsDot')).toHaveText('✅');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区已完成');

    await page.locator('#btnSessions').click();
    const backgroundDir = page.locator('#sessionPanel div[data-dir="/Users/you/code/another-react-project"]');
    await expect(backgroundDir.locator('.dir-badge')).toHaveText('✅');
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('title', '已完成');

    await backgroundDir.locator('button').first().click();
    const backgroundRow = page.locator('[data-testid="session-row"][data-instance-id="inst_2"]');
    await expect(backgroundRow).toContainText('Another App Concurrency');
    await expect(backgroundRow.locator('[data-instance-badge]')).toHaveText('✅');

    await expectNoBrowserErrors(page);
  });

  test('P0-11d 未打开的历史会话可从 sidebar 切换并回放历史', async ({ page }) => {
    await gotoMock(page);

    await page.locator('#btnSessions').click();
    await expect(page.locator('#leftSidebar')).not.toHaveClass(/-translate-x-full/);
    await page.locator('div[data-dir="/Users/you/code/claude-chat-mobile"] button').first().click();
    await expect(page.locator('button[title="Archived Planning Session"]')).toBeVisible();
    await page.locator('button[title="Archived Planning Session"]').click();

    await expect(page.locator('#leftSidebar')).toHaveClass(/-translate-x-full/);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history');

    await expectNoBrowserErrors(page);
  });

  test('P0-11e 可从 sidebar 在其它工作区新建空会话', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await page.locator('#btnSessions').click();
    await page.locator('div[data-dir="/Users/you/code/another-react-project"] button[title="在此工作区新建会话"]').click();

    await expect(page.locator('#leftSidebar')).toHaveClass(/-translate-x-full/);
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await expect(page.locator('#messages')).toContainText('当前工作区');
    await expect(page.locator('#messages')).toContainText('another-react-project');

    await expectNoBrowserErrors(page);
  });

  test('P0-11f sidebar 历史会话切换失败只提示不切走当前会话', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toContainText('Concurrency Mode Triggered');

    await page.locator('#btnSessions').click();
    await page.locator('div[data-dir="/Users/you/code/claude-chat-mobile"] button').first().click();
    await expect(page.locator('button[title="Deleted Remote Session"]')).toBeVisible();
    await page.locator('button[title="Deleted Remote Session"]').click();

    await expect(page.locator('#leftSidebar')).toHaveClass(/-translate-x-full/);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toContainText('Concurrency Mode Triggered');
    await expect(page.locator('#messages')).toContainText('mock session not found');
    await expect(page.locator('#historyLoadingCard')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-11g 关闭当前会话后切到剩余会话且不残留旧历史', async ({ page }) => {
    await gotoMock(page);
    await page.setViewportSize({ width: 900, height: 812 });

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('Concurrency Mode Triggered');

    await page.locator('#btnSessions').click();
    await page.locator('div[data-dir="/Users/you/code/another-react-project"] button').first().click();
    await page.locator('button[title="Another App Concurrency"]').click();
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Another App Concurrency', { timeout: 10_000 });

    await page.locator('#btnSessions').click();
    const currentRow = page.locator('[data-testid="session-row"][data-instance-id="inst_2"]');
    if (!(await currentRow.isVisible())) {
      await page.locator('div[data-dir="/Users/you/code/another-react-project"] button').first().click();
    }
    await expect(currentRow).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await currentRow.locator('button', { hasText: '✕' }).click();

    await expect(page.locator('#leftSidebar')).toHaveClass(/-translate-x-full/);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toContainText('Concurrency Mode Triggered');
    await expect(page.locator('#messages')).not.toContainText('This is the concurrent session');
    await page.locator('#btnSessions').click();
    await expect(page.locator('#sessionPanel')).not.toContainText('another-react-project');

    await expectNoBrowserErrors(page);
  });

  test('P0-11h 其它工作区新会话首发后不回跳默认工作区', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await page.locator('#btnSessions').click();
    await page.locator('div[data-dir="/Users/you/code/another-react-project"] button[title="在此工作区新建会话"]').click();
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    await sendChatMessage(page, 'test:fresh-settings-echo');
    await waitForIdle(page);
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#messages')).toContainText('新会话设置回显');

    await expectNoBrowserErrors(page);
  });
});
