// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import {
  ANOTHER_WORKSPACE,
  MAIN_WORKSPACE,
  expandWorkspace,
  expectSessionBadge,
  expectSidebarClosed,
  openSessionByTitle,
  openSessionsSidebar,
  openWorkspaceSession,
  sessionButtonByTitle,
  sessionRowByInstance,
  startNewSessionInWorkspace,
  workspaceRow
} from '../../helpers/p0-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-11 多工作区、多会话 tab、sidebar 与 history replay', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:tab 后出现第二个工作区/会话实例。
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel')).toContainText('claude-chat-mobile');
    await expect(page.locator('#sessionPanel')).toContainText('another-react-project');

    // 2. 展开第二工作区并切换到 live 会话，验证 history replay。
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');
    await expectSidebarClosed(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Another App Concurrency', { timeout: 10_000 });
    await expect(page.locator('#pillPermText')).toContainText('计划模式');

    await expectNoBrowserErrors(page);
  });

  test('P0-11p 切换会话后模型和思考强度跟随目标实例', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab-model-effort');
    await waitForIdle(page);

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');

    await expectSidebarClosed(page);
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#pillPermText')).toContainText('计划模式');
    await expect(page.locator('#pillModelText')).toContainText('claude-3-opus[1m]');
    await expect(page.locator('#pillEffort')).toBeVisible();
    await expect(page.locator('#pillEffortText')).toContainText('high');

    await expectNoBrowserErrors(page);
  });

  test('P0-11q 切换会话会清空未发送草稿避免串线', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await page.locator('#input').fill('draft that belongs to the main session only');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');

    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#input')).toHaveValue('');
    await expect(page.locator('#btnSend')).toBeDisabled();

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    const sent = page.locator('[data-testid="user-message"]').last();
    await expect(sent).toContainText('test:settings-echo');
    await expect(sent).not.toContainText('draft that belongs to the main session only');

    await expectNoBrowserErrors(page);
  });

  test('P0-11b 关闭后台会话不影响当前会话', async ({ page }) => {
    await gotoMock(page);
    await page.setViewportSize({ width: 900, height: 812 });

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toContainText('Concurrency Mode Triggered');

    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    const backgroundRow = sessionRowByInstance(page, 'inst_2');
    await expect(backgroundRow).toContainText('Another App Concurrency');

    page.once('dialog', dialog => dialog.accept());
    await backgroundRow.locator('button', { hasText: '✕' }).click();
    await expectSidebarClosed(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toContainText('Concurrency Mode Triggered');

    await openSessionsSidebar(page);
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

    await openSessionsSidebar(page);
    const backgroundDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(backgroundDir.locator('.dir-badge')).toHaveText('✅');
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('title', '已完成');

    await backgroundDir.locator('button').first().click();
    const backgroundRow = sessionRowByInstance(page, 'inst_2');
    await expect(backgroundRow).toContainText('Another App Concurrency');
    await expectSessionBadge(page, 'inst_2', '✅');

    await expectNoBrowserErrors(page);
  });

  test('P0-11i 后台工作区出错态显示顶部和侧栏角标', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:background-error');
    await waitForIdle(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#sessionsDot')).toBeVisible();
    await expect(page.locator('#sessionsDot')).toHaveText('❗');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区出错');

    await openSessionsSidebar(page);
    const backgroundDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(backgroundDir.locator('.dir-badge')).toHaveText('❗');
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('title', '出错');

    await backgroundDir.locator('button').first().click();
    const backgroundRow = sessionRowByInstance(page, 'inst_2');
    await expect(backgroundRow).toContainText('Another App Concurrency');
    await expectSessionBadge(page, 'inst_2', '❗', '出错');

    await expectNoBrowserErrors(page);
  });

  test('P0-11j 后台同工作区多状态优先显示待审批', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:background-priority');
    await waitForIdle(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#sessionsDot')).toHaveText('⚠️');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区待审批');

    await openSessionsSidebar(page);
    const backgroundDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(backgroundDir.locator('.dir-badge')).toHaveText('⚠️');
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('title', '待审批');

    await backgroundDir.locator('button').first().click();
    const doneRow = sessionRowByInstance(page, 'inst_2');
    const busyRow = sessionRowByInstance(page, 'inst_3');
    const permissionRow = sessionRowByInstance(page, 'inst_4');
    await expect(doneRow).toContainText('Background Done Result');
    await expectSessionBadge(page, 'inst_2', '✅');
    await expect(busyRow).toContainText('Background Task Running');
    await expectSessionBadge(page, 'inst_3', '🤖');
    await expect(permissionRow).toContainText('Background Needs Approval');
    await expectSessionBadge(page, 'inst_4', '⚠️', '待审批');

    await expectNoBrowserErrors(page);
  });

  test('P0-11d 未打开的历史会话可从 sidebar 切换并回放历史', async ({ page }) => {
    await gotoMock(page);

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');

    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Summarize archived plan', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history');

    await expectNoBrowserErrors(page);
  });

  test('P0-11m sidebar 显示全部后可打开较早历史会话', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:history-overflow');

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(page.getByRole('button', { name: '显示全部会话…' })).toBeVisible();
    await expect(page.locator('#sessionPanel')).not.toContainText('Older Migration Session');

    await page.getByRole('button', { name: '显示全部会话…' }).click();
    await expect(page.getByRole('button', { name: '显示全部会话…' })).toHaveCount(0);
    await expect(sessionButtonByTitle(page, 'Older Migration Session')).toBeVisible();

    await openSessionByTitle(page, 'Older Migration Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Review older migration notes', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('Older migration history loaded from session:list overflow.');
    await expect(page.locator('#messages')).not.toContainText('test:history-overflow');

    await expectNoBrowserErrors(page);
  });

  test('P0-11n sidebar 刷新已缓存的会话列表后显示较早历史入口', async ({ page }) => {
    await gotoMock(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(sessionButtonByTitle(page, 'Archived Planning Session')).toBeVisible();
    await expect(page.getByRole('button', { name: '显示全部会话…' })).toHaveCount(0);
    await page.locator('#sidebarClose').click();

    await sendChatMessage(page, 'test:history-overflow');
    await waitForIdle(page);

    await openSessionsSidebar(page);
    await expect(page.getByRole('button', { name: '显示全部会话…' })).toBeVisible();
    await expect(page.locator('#sessionPanel')).not.toContainText('Older Migration Session');

    await page.getByRole('button', { name: '显示全部会话…' }).click();
    await expect(sessionButtonByTitle(page, 'Older Migration Session')).toBeVisible();
    await openSessionByTitle(page, 'Older Migration Session');
    await expect(page.locator('#messages')).toContainText('Older migration history loaded from session:list overflow.', { timeout: 10_000 });

    await expectNoBrowserErrors(page);
  });

  test('P0-11k sync gap 后回退 history 且不残留旧会话内容', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('Concurrency Mode Triggered');

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Gap Session');

    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Gap recovery prompt', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('History fallback after sync gap.');
    await expect(page.locator('#messages')).not.toContainText('Concurrency Mode Triggered');
    await expect(page.locator('#messages')).not.toContainText('Partial gap buffer that must be discarded');
    await expect(page.locator('#historyLoadingCard')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-11e 可从 sidebar 在其它工作区新建空会话', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await startNewSessionInWorkspace(page, ANOTHER_WORKSPACE);

    await expectSidebarClosed(page);
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

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Deleted Remote Session');

    await expectSidebarClosed(page);
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

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Another App Concurrency', { timeout: 10_000 });

    await openSessionsSidebar(page);
    const currentRow = sessionRowByInstance(page, 'inst_2');
    if (!(await currentRow.isVisible())) {
      await expandWorkspace(page, ANOTHER_WORKSPACE);
    }
    await expect(currentRow).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await currentRow.locator('button', { hasText: '✕' }).click();

    await expectSidebarClosed(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toContainText('Concurrency Mode Triggered');
    await expect(page.locator('#messages')).not.toContainText('This is the concurrent session');
    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel')).not.toContainText('another-react-project');

    await expectNoBrowserErrors(page);
  });

  test('P0-11r 关闭最后一个可见会话后回到同工作区空首页', async ({ page }) => {
    await gotoMock(page);
    await page.setViewportSize({ width: 900, height: 812 });

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toContainText('test:settings-echo');
    await expect(page.locator('#messages')).toContainText('设置回显：model=');

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const currentRow = sessionRowByInstance(page, 'inst_1');
    await expect(currentRow).toContainText('Visual Sandbox (Main)');

    page.once('dialog', dialog => dialog.accept());
    await currentRow.locator('button', { hasText: '✕' }).click();

    await expectSidebarClosed(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    await expect(page.locator('#messages')).toContainText('当前工作区');
    await expect(page.locator('#messages')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).not.toContainText('test:settings-echo');
    await expect(page.locator('#messages')).not.toContainText('设置回显：model=');
    await expect(page.locator('#btnSend')).toBeDisabled();

    await openSessionsSidebar(page);
    await expect(sessionRowByInstance(page, 'inst_1')).toHaveCount(0);
    await expect(page.locator('#sessionPanel')).toContainText('Visual Sandbox (Main)');
    await expect(workspaceRow(page, MAIN_WORKSPACE)).toContainText('claude-chat-mobile');

    await expectNoBrowserErrors(page);
  });

  test('P0-11l 关闭当前待审批会话后切到剩余会话且不残留待审批状态', async ({ page }) => {
    await gotoMock(page);
    await page.setViewportSize({ width: 900, height: 812 });

    await sendChatMessage(page, 'test:close-current-pending');
    await expect(page.locator('#messages')).toContainText('Close current pending source session');

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const currentRow = sessionRowByInstance(page, 'inst_1');
    await expect(currentRow).toContainText('Visual Sandbox (Main)');
    await expectSessionBadge(page, 'inst_1', '⚠️');

    page.once('dialog', dialog => dialog.accept());
    await currentRow.locator('button', { hasText: '✕' }).click();

    await expectSidebarClosed(page);
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#permModal')).toBeHidden();
    await expect(page.locator('#messages')).not.toContainText('Close current pending source session');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Another App Concurrency', { timeout: 10_000 });
    await expect(page.locator('#sessionsDot')).toBeHidden();

    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel')).not.toContainText('Visual Sandbox (Main)');
    await expect(page.locator('#sessionPanel')).not.toContainText('claude-chat-mobile');

    await expectNoBrowserErrors(page);
  });

  test('P0-11o 关闭当前会话后迟到事件不污染回退视图', async ({ page }) => {
    await gotoMock(page);
    await page.setViewportSize({ width: 900, height: 812 });

    await sendChatMessage(page, 'test:late-closed-current-events');
    await expect(page.locator('#messages')).toContainText('Close current stale source session');

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const currentRow = sessionRowByInstance(page, 'inst_1');
    await expect(currentRow).toContainText('Visual Sandbox (Main)');
    await expectSessionBadge(page, 'inst_1', '⚠️');

    page.once('dialog', dialog => dialog.accept());
    await currentRow.locator('button', { hasText: '✕' }).click();

    await expectSidebarClosed(page);
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#messages')).toContainText('Closed-session stale replay finished for current view.', { timeout: 10_000 });
    await expect(page.locator('#messages')).not.toContainText('Close current stale source session');
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

  test('P0-11h 其它工作区新会话首发后不回跳默认工作区', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await startNewSessionInWorkspace(page, ANOTHER_WORKSPACE);
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);

    await sendChatMessage(page, 'test:fresh-settings-echo');
    await waitForIdle(page);
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#messages')).toContainText('新会话设置回显');

    await expectNoBrowserErrors(page);
  });

  test('P0-11s “需要你”聚合展示待办并可深链到目标工作区', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:needsyou');
    await waitForIdle(page);
    await openSessionsSidebar(page);

    const section = page.locator('#needsYouSection');
    const row = page.locator('[data-testid="needs-you-row"]');
    await expect(section.locator(':scope > *').first()).toHaveText('需要你 (1)');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Background Approval Demo');
    await expect(row).toContainText('等待审批');
    await expect(row).toContainText('Bash');
    await expect(row).toContainText('已等待 3 分钟');

    await row.click();
    await expectSidebarClosed(page);
    await expect(page.locator('#topProjectText')).toHaveText('another-react-project');

    await expectNoBrowserErrors(page);
  });
});
