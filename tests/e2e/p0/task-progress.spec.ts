// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import {
  ANOTHER_WORKSPACE,
  expandWorkspace,
  expectSessionStatusChip,
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
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区 · 运行中');

    await openSessionsSidebar(page);
    const backgroundDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(backgroundDir.locator('.dir-badge')).toHaveText('运行中');
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('aria-label', '运行中');
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await expectSessionStatusChip(page, 'inst_2', '运行中');

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

  // 2026-07-28 真机 b06fb05d：用户亲手杀掉 CLI 后排队续接——他比判定链更早知道终端已死，
  // 但排队只承诺「最长约 5 分钟」自动判定，且当时没有任何不等判定的出口，逼得他去重启服务。
  test('P0-17j 排队续接给「强制立即续接」入口：确认分叉风险后立即解锁，不等自动判定', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:mirror-armed-force');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveText('续接');

    // 排队 → 提示条内出现强制入口
    await page.locator('#btnSend').click();
    await expect(page.locator('#input')).toHaveAttribute('placeholder', /已请求续接|等待终端/);
    const forceBtn = page.locator('[data-testid="mirror-force-resume"]');
    await expect(forceBtn).toBeVisible();

    // 点强制 → 项目风格确认 sheet → 确认后立即解锁 + 分叉风险警示留痕（mock 不放行，解锁只能来自强制路径）
    await forceBtn.click();
    await page.locator('#confirmOk').click();
    await expect(page.locator('#input')).toBeEnabled();
    await expect(page.locator('#messages')).toContainText('分叉风险');

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

  test('P0-17j 多任务后台横幅默认折叠，点击横幅头行可展开/收起', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:taskprogress-multi');
    await expect(page.locator('#taskProgressBanner')).toBeVisible();
    await expect(page.locator('#taskProgressText')).toContainText('3 个运行中', { timeout: 10_000 });

    // 默认折叠：行已渲染在 DOM（供断言/无障碍），但列表容器不可见。
    // 折叠热区是整条头行（无三角按钮），恒可见；右侧「停止」在多任务下隐藏（每行自带「停」）。
    const toggle = page.locator('[data-testid="bg-task-toggle"]');
    await expect(page.locator('[data-testid="task-stop-btn"]')).toBeHidden();
    const list = page.locator('[data-testid="bg-task-list"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toBeHidden();
    await expect(page.locator('[data-testid="bg-task-row"]')).toHaveCount(3);

    // 点开：展开列表，三行任务详情可见。
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(list).toBeVisible();
    await expect(page.locator('[data-testid="bg-task-row"]').first()).toBeVisible();

    // 再点收起。
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toBeHidden();

    await waitForIdle(page);
    await expect(page.locator('#taskProgressBanner')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-17k 点击任务行展开详情面板显示进度历史，再次点击收起', async ({ page }) => {
    await gotoMock(page);

    // 发送 test:taskprogress，mock 推送 3 条 task_progress 心跳
    await sendChatMessage(page, 'test:taskprogress');
    await expect(page.locator('#taskProgressBanner')).toBeVisible();
    await expect(page.locator('[data-testid="bg-task-row"]')).toContainText('步骤 3/3', { timeout: 10_000 });

    // 点击任务行 → 详情面板展开，显示进度历史条目
    await page.locator('[data-testid="bg-task-row"]').first().click();
    await expect(page.locator('[data-testid="task-detail-panel"]')).toBeVisible();
    // 3 条 progress 应对应 3 行历史记录
    const entries = page.locator('[data-testid="task-detail-entry"]');
    await expect(entries).toHaveCount(3, { timeout: 5_000 });

    // 再次点击同一行 → 详情面板收起
    await page.locator('[data-testid="bg-task-row"]').first().click();
    await expect(page.locator('[data-testid="task-detail-panel"]')).toBeHidden();

    // 完成后横幅撤下
    await waitForIdle(page);
    await expect(page.locator('#taskProgressBanner')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-17m 详情内联在任务卡片里：不冒泡收起，且随整列表折叠一起隐藏', async ({ page }) => {
    await gotoMock(page);

    // -hold 变体：三拍心跳后长驻 8s，够跑完下面的多步联动断言
    await sendChatMessage(page, 'test:taskprogress-hold');
    await expect(page.locator('#taskProgressBanner')).toBeVisible();
    await expect(page.locator('[data-testid="bg-task-row"]')).toContainText('步骤 3/3', { timeout: 10_000 });

    const list = page.locator('[data-testid="bg-task-list"]');
    const detail = page.locator('[data-testid="task-detail-panel"]');
    const toggle = page.locator('[data-testid="bg-task-toggle"]');

    await page.locator('[data-testid="bg-task-row"]').first().click();
    // 详情必须落在任务列表**内部**（旧实现挂在横幅外的兄弟节点上，这条会红）
    await expect(list.locator('[data-testid="task-detail-panel"]')).toHaveCount(1);

    // 点详情自身不冒泡回任务行，不会误收起
    await page.locator('[data-testid="task-detail-entry"]').first().click();
    await expect(detail).toBeVisible();

    // 折叠整列表 → 详情随卡片一起隐藏（旧实现下详情继续显示且再也点不到）
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toBeHidden();
    await expect(detail).toBeHidden();

    // 重新展开 → 详情保持原展开态，且仍可点行收起
    await toggle.click();
    await expect(detail).toBeVisible();
    await page.locator('[data-testid="bg-task-row"]').first().click();
    await expect(detail).toBeHidden();

    await waitForIdle(page);
    await expect(page.locator('#taskProgressBanner')).toBeHidden();

    await expectNoBrowserErrors(page);
  });
});
