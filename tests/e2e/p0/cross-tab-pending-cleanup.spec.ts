// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import {
  expandWorkspace,
  expectSidebarClosed,
  MAIN_WORKSPACE,
  openSessionsSidebar,
  openWorkspaceSession,
  sessionRowByInstance
} from '../../helpers/p0-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-13 跨 tab 审批弹窗清理与错路由防护', async ({ page }) => {
    await gotoMock(page);

    // 1. 当前 inst_1 出现权限弹窗，mock 自动切到 inst_2 后清除弹窗。
    await sendChatMessage(page, 'test:permCrossTab');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permModal')).toBeHidden({ timeout: 8_000 });

    // 2. 当前视图不保留 inst_1 的审批弹窗，不应可见地解决旧请求。
    await page.evaluate(() => document.getElementById('permAllow')?.click());
    await expect(page.locator('#permModal')).toBeHidden();
    await expect(page.locator('#pillPermText')).toContainText('计划模式');

    await expectNoBrowserErrors(page);
  });

  test('P0-13b 切回后台待审批实例后才显示并处理审批', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:permCrossTab');
    await expect(page.locator('#permModal')).toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permModal')).toBeHidden({ timeout: 8_000 });
    await expect(page.locator('#pillPermText')).toContainText('计划模式');

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');

    await expectSidebarClosed(page);
    await expect(page.locator('#pillPermText')).toContainText('默认审批');
    await expect(page.locator('#permModal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#permCwd')).toContainText('/Users/you/code/claude-chat-mobile');
    await expect(page.locator('#permInput')).toContainText('git push origin main');

    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('#pillPermText')).toContainText('默认审批');

    await expectNoBrowserErrors(page);
  });

  test('P0-13c 跨 tab 问题弹窗切走后清理并切回重建', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:questionCrossTab');
    await expect(page.locator('#questionModal')).toBeVisible();
    await expect(page.locator('#questionText')).toContainText('Which branch should be our target publish destination?');
    await expect(page.locator('#questionModal')).toBeHidden({ timeout: 8_000 });
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');

    await page.evaluate(() => document.querySelector('#questionOptions button')?.click());
    await expect(page.locator('#questionModal')).toBeHidden();
    await expect(page.locator('#pillPermText')).toContainText('计划模式');

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Visual Sandbox (Main)');

    await expectSidebarClosed(page);
    await expect(page.locator('#pillPermText')).toContainText('默认审批');
    await expect(page.locator('#questionModal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#questionText')).toContainText('Which branch should be our target publish destination?');

    await page.locator('#questionOptions button').nth(1).click();
    await expect(page.locator('#questionModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('dev (Bleeding-Edge Integration)');

    await expectNoBrowserErrors(page);
  });

  test('P0-13d 关闭后台问题待答会话后不复活选择弹窗', async ({ page }) => {
    await gotoMock(page);
    await page.setViewportSize({ width: 900, height: 812 });

    await sendChatMessage(page, 'test:close-background-question-pending');
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#questionModal')).toBeHidden();

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const questionRow = sessionRowByInstance(page, 'inst_1');
    await expect(questionRow).toContainText('Visual Sandbox (Main)');
    await expect(questionRow.locator('[data-instance-badge]')).toHaveAttribute('aria-label', '待审批');

    page.once('dialog', dialog => dialog.accept());
    await questionRow.locator('button', { hasText: '✕' }).click();

    await expectSidebarClosed(page);
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#questionModal')).toBeHidden();
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Another App Concurrency', { timeout: 10_000 });

    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel')).not.toContainText('Visual Sandbox (Main)');
    await expect(page.locator('#sessionPanel')).not.toContainText('Which branch should be our target publish destination?');
    await expect(page.locator('#questionModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-13e 关闭后台会话后迟到事件不污染当前视图', async ({ page }) => {
    await gotoMock(page);
    await page.setViewportSize({ width: 900, height: 812 });

    await sendChatMessage(page, 'test:late-closed-session-events');
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#questionModal')).toBeHidden();
    await expect(page.locator('#permModal')).toBeHidden();

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const closedRow = sessionRowByInstance(page, 'inst_1');
    await expect(closedRow).toContainText('Visual Sandbox (Main)');
    await expect(closedRow.locator('[data-instance-badge]')).toHaveAttribute('aria-label', '待审批');

    page.once('dialog', dialog => dialog.accept());
    await closedRow.locator('button', { hasText: '✕' }).click();

    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Closed-session stale replay finished for current view.', { timeout: 10_000 });
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#messages')).not.toContainText('STALE CLOSED SESSION TEXT MUST NOT RENDER');
    await expect(page.locator('#messages')).not.toContainText('rm -rf /tmp/closed-session-stale');
    await expect(page.locator('#messages')).not.toContainText('This closed session question must not appear');
    await expect(page.locator('#permModal')).toBeHidden();
    await expect(page.locator('#questionModal')).toBeHidden();

    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel')).not.toContainText('Visual Sandbox (Main)');
    await expect(page.locator('#sessionPanel')).not.toContainText('claude-chat-mobile');

    await expectNoBrowserErrors(page);
  });
});
