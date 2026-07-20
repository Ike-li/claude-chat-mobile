// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import {
  ANOTHER_WORKSPACE,
  expandWorkspace,
  expectSessionBadge,
  expectSidebarClosed,
  openSessionByTitle,
  openSessionsSidebar,
  openWorkspaceSession,
  sessionButtonByTitle,
  workspaceRow
} from '../../helpers/p0-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-17 后台 task_progress 横幅原地刷新', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:taskprogress 后出现后台任务进度横幅。
    await sendChatMessage(page, 'test:taskprogress');
    await expect(page.locator('#taskProgressBanner')).toBeVisible();
    // b4716e7 起横幅只写数量态「运行中」，步骤明细迁到任务列表行 bg-task-row
    await expect(page.locator('#taskProgressText')).toContainText('运行中', { timeout: 10_000 });
    await expect(page.locator('[data-testid="bg-task-row"]')).toContainText('步骤', { timeout: 10_000 });

    // 2. 心跳原地刷新，完成后撤下。
    await expect(page.locator('[data-testid="bg-task-row"]')).toContainText('步骤 3/3', { timeout: 10_000 });
    await expect(page.locator('#taskProgressBanner')).toHaveCount(1);
    await waitForIdle(page);
    await expect(page.locator('#taskProgressBanner')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-17b 后台任务失败通知撤下进度横幅', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:taskprogress-failed');
    await expect(page.locator('#taskProgressBanner')).toBeVisible();
    await expect(page.locator('[data-testid="bg-task-row"]')).toContainText('步骤 2/3', { timeout: 10_000 });
    await waitForIdle(page);
    await expect(page.locator('#taskProgressBanner')).toBeHidden();
    await expect(page.locator('#messages')).toContainText('后台任务失败');
    await expect(page.locator('#messages')).toContainText('mock background task failed');

    await expectNoBrowserErrors(page);
  });

  test('P0-17c 终端只读追平会锁定输入并允许显式接管', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:mirror-readonly');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveAttribute('placeholder', '只读镜像：终端会话运行中，移动端当前只读');
    await expect(page.locator('#btnSend')).toHaveText('续接');
    await expect(page.locator('#btnSend')).toBeEnabled();

    // 非 stale 只读态点续接 = 排队等终端本轮完结；mock 稍后发 readonly:false 自动放行
    await page.locator('#btnSend').click();
    await expect(page.locator('#input')).toBeEnabled({ timeout: 10_000 });

    await sendChatMessage(page, 'take over from terminal');
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('take over from terminal');

    await expectNoBrowserErrors(page);
  });

  test('P0-17d 切换会话会清除只读追平锁', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await sendChatMessage(page, 'test:mirror-readonly');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveText('续接');

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
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

    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveAttribute('placeholder', '只读镜像：终端会话运行中，移动端当前只读');
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');
    await expect(page.locator('#btnSend')).toHaveText('续接');

    // 点续接排队，终端本轮完结（mock 后续 readonly:false）后自动放行，草稿仍在
    await page.locator('#btnSend').click();
    await expect(page.locator('#input')).toBeEnabled({ timeout: 10_000 });
    await expect(page.locator('#input')).toHaveValue('test:settings-echo');

    await page.locator('#btnSend').click();
    await waitForIdle(page);
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:settings-echo');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');
    await expect(page.locator('#input')).toHaveValue('');

    await expectNoBrowserErrors(page);
  });

  test('P0-17g 迟到只读锁不会污染切走后的当前会话', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await expect(sessionButtonByTitle(page, 'Another App Concurrency')).toBeVisible();
    await page.locator('#sidebarClose').click();
    await expectSidebarClosed(page);

    const startedAt = Date.now();
    await sendChatMessage(page, 'test:mirror-readonly-delayed');

    await openSessionsSidebar(page);
    await openSessionByTitle(page, 'Another App Concurrency');
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Another App Concurrency', { timeout: 10_000 });

    await expect.poll(() => Date.now() - startedAt, { timeout: 2_000 }).toBeGreaterThan(900);
    // 迟到只读锁不污染已切走的会话：当前会话 input 仍可写（镜像横幅已恒 hidden，改判 input 态）
    await expect(page.locator('#input')).toBeEnabled();

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:settings-echo');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    await expectNoBrowserErrors(page);
  });

  test('P0-17e 后台 task_progress 不污染当前会话但保留忙碌角标', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:background-taskprogress');
    await waitForIdle(page);

    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#taskProgressBanner')).toBeHidden();
    await expect(page.locator('#messages')).not.toContainText('另一个工作区正在运行后台任务');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('aria-label', '运行中');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区运行中');

    await openSessionsSidebar(page);
    const backgroundDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('aria-label', '运行中');
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('title', '运行中');
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await expectSessionBadge(page, 'inst_2', '🤖', '运行中：Task');

    await expectNoBrowserErrors(page);
  });

  test('P0-17h 终端接管可排队、取消并在本轮结束后自动放行', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:mirror-armed');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveAttribute('placeholder', '只读镜像：终端会话运行中，移动端当前只读');
    await expect(page.locator('#btnSend')).toHaveText('续接');

    // 点续接 → 排队（armed），发送位变「取消」，仍只读
    await page.locator('#btnSend').click();
    await expect(page.locator('#input')).toHaveAttribute('placeholder', /已请求续接|等待终端/);
    await expect(page.locator('#btnSend')).toHaveText('取消');
    await expect(page.locator('#input')).toBeDisabled();

    // 点取消 → 回到只读驾驶态
    await page.locator('#btnSend').click();
    await expect(page.locator('#input')).toHaveAttribute('placeholder', '只读镜像：终端会话运行中，移动端当前只读');
    await expect(page.locator('#btnSend')).toHaveText('续接');
    await expect(page.locator('#input')).toBeDisabled();

    // 再点续接排队，终端本轮完结（mock 后续 readonly:false）后自动放行
    await page.locator('#btnSend').click();
    await expect(page.locator('#input')).toHaveAttribute('placeholder', /已请求续接|等待终端/);
    await expect(page.locator('#input')).toBeEnabled({ timeout: 10_000 });
    await waitForIdle(page);

    await expectNoBrowserErrors(page);
  });

  test('P0-17i 终端只读镜像经历驾驶、疑似中断与自动解锁三态', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:mirror');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#input')).toHaveAttribute('placeholder', '只读镜像：终端会话运行中，移动端当前只读');
    await expect(page.locator('#btnSend')).toHaveText('续接');

    const modelBefore = await page.locator('#modelInput').inputValue();
    await page.locator('#customModelGrid .model-tile').evaluateAll((tiles) => {
      const target = tiles.find(tile => (tile as HTMLElement).dataset.model);
      (target as HTMLElement | undefined)?.click();
    });
    await expect(page.locator('#modelInput')).toHaveValue(modelBefore);
    await expect(page.locator('#messages')).toContainText('设置已冻结');

    await expect(page.locator('#input')).toHaveAttribute('placeholder', /疑似中断/, { timeout: 5_000 });
    await expect(page.locator('#input')).toBeEnabled({ timeout: 5_000 });
    await waitForIdle(page);

    await expectNoBrowserErrors(page);
  });
});
