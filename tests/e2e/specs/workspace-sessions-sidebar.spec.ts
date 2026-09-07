// helpers: tests/helpers/playwright.ts

import { test, expect, type Page } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle, waitUntilConnected, waitUntilDisconnected } from '../../helpers/playwright';
import {
  ANOTHER_WORKSPACE,
  MAIN_WORKSPACE,
  expandWorkspace,
  expectNoSessionStatusChip,
  expectSessionStatusChip,
  expectSidebarClosed,
  expectSidebarOpen,
  openSessionByTitle,
  openSessionsSidebar,
  openWorkspaceSession,
  sessionButtonByTitle,
  sessionRowByInstance,
  startNewSessionInWorkspace,
  workspaceRow
} from '../../helpers/sidebar-ui';

// P3 抽屉局部重建 + SWR 保鲜回归专用：给指定工作区 subtree 下所有会话行元素打一个自定义 JS 属性
// （不是 DOM attribute）——如果这个目录的 DOM 子树曾被整段拆掉重建，新节点不会带着这个属性，重连
// 前后对比即可判定"有没有被连坐重建"，不依赖脆弱的像素/时序观测。dirRow 与 subtree 保持相邻兄弟
// 节点是 workspaceRow/expandWorkspace 已依赖的既有约定（见 helpers/playwright.ts）。
async function markSessionRows(page: Page, cwd: string) {
  await page.evaluate((targetCwd) => {
    const dirRow = Array.from(document.querySelectorAll('#sessionPanel [data-dir]'))
      .find(el => (el as HTMLElement).dataset.dir === targetCwd);
    const subtree = dirRow?.nextElementSibling;
    subtree?.querySelectorAll('[data-testid="session-row"]').forEach(row => {
      (row as unknown as Record<string, unknown>).__ccmMark = 'preserved';
    });
  }, cwd);
}

async function readSessionRowMarks(page: Page, cwd: string): Promise<(string | null)[]> {
  return page.evaluate((targetCwd) => {
    const dirRow = Array.from(document.querySelectorAll('#sessionPanel [data-dir]'))
      .find(el => (el as HTMLElement).dataset.dir === targetCwd);
    const subtree = dirRow?.nextElementSibling;
    if (!subtree) return [];
    return Array.from(subtree.querySelectorAll('[data-testid="session-row"]'))
      .map(row => ((row as unknown as Record<string, unknown>).__ccmMark as string | undefined) ?? null);
  }, cwd);
}

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-11 多工作区、多会话 tab、sidebar 与 history replay', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:tab 后出现第二个工作区/会话实例。
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel')).toContainText('claude-chat-mobile');
    await expect(page.locator('#sessionPanel')).toContainText('another-react-project');
    // 抽屉 = 需要你 + 服务异常 + 工作区树；不再占位「状态 · live / 图例 / 实例列表副本」
    await expect(page.locator('#sessionPanel')).not.toContainText('状态 · live');
    await expect(page.locator('#sessionPanel')).not.toContainText('状态图例');
    await expect(page.locator('#statusSection')).toHaveCount(0);
    await expect(page.locator('[data-testid="status-instance-row"]')).toHaveCount(0);

    // 2. 展开第二工作区并切换到 live 会话，验证 history replay。
    await openWorkspaceSession(page, ANOTHER_WORKSPACE, 'Another App Concurrency');
    await expectSidebarClosed(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('Another App Concurrency', { timeout: 10_000 });
    await expect(page.locator('#pillPermText')).toContainText('Plan');

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
    await expect(page.locator('#pillPermText')).toContainText('Plan');
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

    await backgroundRow.locator('button', { hasText: '✕' }).click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmOk').click();
    await expectSidebarClosed(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toContainText('Concurrency Mode Triggered');

    await openSessionsSidebar(page);
    await expect(page.locator('#sessionPanel')).toContainText('claude-chat-mobile');
    await expect(page.locator('#sessionPanel')).not.toContainText('another-react-project');

    await expectNoBrowserErrors(page);
  });

  test('P0-11c 后台工作区完成态不持续占用抽屉状态提示', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:background-done');
    await waitForIdle(page);
    await expect(page.locator('#sessionsDot')).toBeHidden();

    await openSessionsSidebar(page);
    const backgroundDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(backgroundDir.locator('.dir-badge')).toHaveClass(/hidden/);

    await backgroundDir.locator('button').first().click();
    const backgroundRow = sessionRowByInstance(page, 'inst_2');
    await expect(backgroundRow).toContainText('Another App Concurrency');
    await expectNoSessionStatusChip(page, 'inst_2');

    await expectNoBrowserErrors(page);
  });

  test('P0-11i 后台工作区出错态显示顶部和侧栏角标', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:background-error');
    await waitForIdle(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#sessionsDot')).toBeVisible();
    await expect(page.locator('#sessionsDot')).toHaveAttribute('aria-label', '出错');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区 · 出错');

    await openSessionsSidebar(page);
    const backgroundDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(backgroundDir.locator('.dir-badge')).toHaveText('出错');
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('aria-label', '出错');

    await backgroundDir.locator('button').first().click();
    const backgroundRow = sessionRowByInstance(page, 'inst_2');
    await expect(backgroundRow).toContainText('Another App Concurrency');
    await expectSessionStatusChip(page, 'inst_2', '出错');

    await expectNoBrowserErrors(page);
  });

  test('P0-11j 后台同工作区多状态优先显示需要你，运行态使用文字 chip', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:background-priority');
    await waitForIdle(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('aria-label', '需要你');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区 · 需要你');

    await openSessionsSidebar(page);
    const backgroundDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(backgroundDir.locator('.dir-badge')).toHaveText('需要你');
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('aria-label', '需要你');

    await backgroundDir.locator('button').first().click();
    const doneRow = sessionRowByInstance(page, 'inst_2');
    const busyRow = sessionRowByInstance(page, 'inst_3');
    const permissionRow = sessionRowByInstance(page, 'inst_4');
    await expect(doneRow).toContainText('Background Done Result');
    await expectNoSessionStatusChip(page, 'inst_2');
    await expect(busyRow).toContainText('Background Task Running');
    await expectSessionStatusChip(page, 'inst_3', '运行中');
    await expect(permissionRow).toContainText('Background Needs Approval');
    await expectSessionStatusChip(page, 'inst_4', '需要你');

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
    await expect(page.getByTestId('session-remaining-hint')).toBeVisible();
    await expect(page.getByTestId('session-remaining-hint')).toContainText('可用搜索查找');
    await expect(sessionButtonByTitle(page, 'Older Migration Session')).toBeVisible();

    await openSessionByTitle(page, 'Older Migration Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Review older migration notes', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('Older migration history loaded from session:list overflow.');
    await expect(page.locator('#messages')).not.toContainText('test:history-overflow');

    await expectNoBrowserErrors(page);
  });

  test('P0-11-search 工作区会话搜索按标题过滤', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(sessionButtonByTitle(page, 'Archived Planning Session')).toBeVisible();
    await expect(sessionButtonByTitle(page, 'Timeline Session')).toBeVisible();

    const search = page.getByTestId('session-search');
    await expect(search).toBeVisible();
    await search.fill('Timeline');
    await expect(sessionButtonByTitle(page, 'Timeline Session')).toBeVisible({ timeout: 5_000 });
    await expect(sessionButtonByTitle(page, 'Archived Planning Session')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '显示全部会话…' })).toHaveCount(0);

    await search.fill('definitely-no-match-xyz');
    await expect(page.getByTestId('session-search-empty')).toBeVisible({ timeout: 5_000 });

    await expectNoBrowserErrors(page);
  });

  test('P0-11-search-stable 搜索框在 debounce 后仍是同一节点且保持焦点', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const search = page.getByTestId('session-search');
    await expect(search).toBeVisible();
    await search.click();
    await search.evaluate((el) => { (el as HTMLElement).dataset.ccmAlive = '1'; });

    // delay > 前端 200ms debounce：每一键都会触发一次 populateSubtree。
    // fill() 一次写完锁不住「输入框被 innerHTML 拆掉」；必须按键间隔超过 debounce。
    await search.pressSequentially('Time', { delay: 260 });

    const alive = await page.getByTestId('session-search').evaluate((el) => (el as HTMLElement).dataset.ccmAlive);
    expect(alive).toBe('1');
    await expect(page.getByTestId('session-search')).toBeFocused();
    await expect(page.getByTestId('session-search')).toHaveValue('Time');
    await expect(sessionButtonByTitle(page, 'Timeline Session')).toBeVisible({ timeout: 5_000 });

    await expectNoBrowserErrors(page);
  });

  test('P0-11-delete 🗑 二次确认后从列表移除', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(sessionButtonByTitle(page, 'Archived Planning Session')).toBeVisible();

    const row = page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');
    await row.getByTestId('session-delete').click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.getByRole('button', { name: '彻底删除' }).click();
    await expect(page.locator('#confirmModal')).toBeHidden({ timeout: 5_000 });
    await expect(sessionButtonByTitle(page, 'Archived Planning Session')).toHaveCount(0, { timeout: 5_000 });

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

  // revalidate 改成无条件后新增的守卫：「显示全部会话…」是用户的显式意图，一次全量重建（这里用新增
  // 工作区触发结构性变化 → openSessionPanel）不该把它悄悄打回截断态。缓存本身不记这件事——记的是
  // expandedAllDirs，revalidate 得带着 all 一起发。
  test('P0-11x 点开"显示全部会话…"后遇到全量重建，展开态仍保持（不被 revalidate 打回截断）', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:history-overflow');
    await waitForIdle(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await page.getByRole('button', { name: '显示全部会话…' }).click();
    await expect(sessionButtonByTitle(page, 'Older Migration Session')).toBeVisible();
    await page.locator('#sidebarClose').click();

    // 新增第二工作区 → availableDirs 变化 → 结构性变化 → openSessionPanel 全量重建所有展开目录
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);

    await openSessionsSidebar(page);
    await expect(workspaceRow(page, ANOTHER_WORKSPACE)).toBeVisible();
    await expect(sessionButtonByTitle(page, 'Older Migration Session')).toBeVisible();

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
    // compose 页顶栏 pill 隐藏；#topProjectText 仍写工作区 basename
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    // 侧栏 ＋ → compose 干净新会话页（不再是带「当前工作区」的首页枢纽）
    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible();
    await expect(page.locator('#messages')).toContainText('another-react-project');
    await expect(page.locator('#messages')).not.toContainText('当前工作区');

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
    // 「不切走」的原意保持不变：viewing 实例没换，当前会话的历史也没被清掉
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toContainText('Concurrency Mode Triggered');
    await expect(page.locator('#historyLoadingCard')).toHaveCount(0);
    // 2026-09-07 起失败原因落在【目标会话自己的】落地页上。此前它走 addBar 插进 #messages，
    // 也就是当前会话的消息流——「不切走」做到了，但那句话读起来像是当前会话出的事。
    await expect(page.locator('[data-testid="session-blocked-title"]')).toHaveText('Deleted Remote Session');
    await expect(page.locator('[data-testid="session-blocked-reason"]')).toContainText('mock session not found');
    await expect(page.locator('#messages')).not.toContainText('mock session not found');

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
    await currentRow.locator('button', { hasText: '✕' }).click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmOk').click();

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

    await currentRow.locator('button', { hasText: '✕' }).click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmOk').click();

    await expectSidebarClosed(page);
    // 首页 pill 隐藏；文案仍是工作区 basename
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#messages')).toHaveClass(/empty-start/);
    // 关掉当前会话 → 回首页枢纽（无「当前工作区」pill）
    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible();
    await expect(page.locator('#messages')).not.toContainText('当前工作区');
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
    await expectSessionStatusChip(page, 'inst_1', '需要你');

    await currentRow.locator('button', { hasText: '✕' }).click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmOk').click();

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
    await expectSessionStatusChip(page, 'inst_1', '需要你');

    await currentRow.locator('button', { hasText: '✕' }).click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.locator('#confirmOk').click();

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
    // 首发后仍在其它工作区（不回跳默认仓）
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#messages')).toContainText('新会话设置回显');

    await expectNoBrowserErrors(page);
  });

  test('P0-11s “需要你”聚合展示待办并可深链到目标工作区', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:needsyou');
    await waitForIdle(page);
    // 顶栏文字 chip：把会话按钮上那颗琥珀色小点写成人话（手机看不到 title，之前只能猜）
    await expect(page.locator('[data-testid="header-attention-chip"]')).toHaveText('需要你 1');
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
    // 深链到待审批会话：顶栏仍显工作区名（会话标题在侧栏）
    await expect(page.locator('#topProjectText')).toHaveText('another-react-project');

    await expectNoBrowserErrors(page);
  });

  // R65 未读点（2026-08-30，替代当天撤除的 H1 聚合卡）：
  // 抽屉行与首页最近行上，「本设备上次打开后有新活动」的会话亮色点。
  // mock 的 lastUsedAt 相对请求时刻生成：旧会话（-600s 等）恒在基线（页面加载）前＝不亮；
  // 'Another App Concurrency' 恒为请求时刻＝基线后＝亮——恰好覆盖「基线不追溯」与「新活动亮点」。
  // 「打开即清」的时序语义在 tests/unit/logic-unread.test.mjs；此处验接线（localStorage 已记 seen）
  // 与「正在看的不亮」（mock 时间戳每次请求都前移，无法在 E2E 里稳定复现"打开后回来不亮"）。
  test('P0-11u 会话未读点：基线不追溯、新活动亮点、正在看的不亮', async ({ page }) => {
    await gotoMock(page);

    // 基线不追溯：冷启动首页只有默认工作区的历史会话（全在基线前）→ 零点
    await page.locator('#btnHome').click();
    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#dashRecentsList .dash-recent-item').first()).toBeVisible();
    await expect(page.locator('#dashRecentsList [data-testid="unread-mark"]')).toHaveCount(0);

    // 引入另一工作区的基线后活动（mock 该区会话的 lastUsedAt 恒为请求时刻）
    await sendChatMessage(page, 'test:needsyou');
    await waitForIdle(page);

    // 首页最近行：基线后有活动的会话亮「未读」chip（文字，不再是说不清自己是什么的色点）
    await page.locator('#btnHome').click();
    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#dashRecentsList [data-testid="unread-mark"]').first()).toHaveText('未读');

    // 抽屉：新活动的行亮 chip + 标题加粗；基线前的旧会话行不亮；目录头汇总「N 未读」（折叠时也看得见）
    await openSessionsSidebar(page);
    const otherDir = await expandWorkspace(page, ANOTHER_WORKSPACE);
    const freshRow = page.locator('[data-testid="session-row"]', { hasText: 'Another App Concurrency' });
    await expect(freshRow.locator('[data-testid="unread-mark"]')).toHaveText('未读');
    await expect(freshRow.locator('[data-session-head] > span').first()).toHaveClass(/font-semibold/);
    await expect(otherDir.locator('[data-testid="dir-unread"]')).toHaveText(/^\d+ 未读$/);
    const oldRow = page.locator('[data-testid="session-row"]', { hasText: 'Archived Planning Session' });
    await expect(oldRow.locator('[data-testid="unread-mark"]')).toHaveCount(0);
    await expect(oldRow.locator('[data-session-head] > span').first()).not.toHaveClass(/font-semibold/);

    // 当前会话行必须零点——无论其时间戳落在基线哪一侧都成立（在看=排除；基线前=不追溯），
    // 双保险断言；「正在看的不亮」的严格时序语义由 logic-unread 单测钉住。
    const viewingRow = page.locator('[data-testid="session-row"]', { hasText: 'Visual Sandbox (Main)' });
    await expect(viewingRow.locator('[data-testid="unread-mark"]')).toHaveCount(0);

    // 入场即记已读（markSeen 接线验证）：走 P0-11s 已验证的需要你深链进入另一会话，localStorage 落 seen
    await page.locator('[data-testid="needs-you-row"]').click();
    await expectSidebarClosed(page);
    await expect(page.locator('#topProjectText')).toHaveText('another-react-project');
    await expect.poll(async () => page.evaluate(() => {
      try { return typeof JSON.parse(localStorage.getItem('ccm-unread-v1') || '{}').seen?.['mock-session-needsyou']; } catch { return 'error'; }
    })).toBe('number');

    // 同一笔已读还要上报到服务端共享位点（2026-09-03），否则换台设备又会亮成未读。
    await expect.poll(async () => {
      const state = await (await page.request.get('/__read-state')).json();
      return typeof state?.seen?.['mock-session-needsyou'];
    }).toBe('number');

    await expectNoBrowserErrors(page);
  });

  // 2026-09-03 真机症状：换一台设备打开，读过的会话又整屏亮成「未读」。根因是已读位点只存
  // localStorage——新设备的 seen 表是空的，所有会话都回落去跟「本设备首次打开时刻」这个很老的
  // 基线比。位点搬到服务端共享后，此处钉住修复：本地基线老 + 本地无记录 + 服务端有记录 = 不亮。
  test('P0-11af 跨设备已读位点：另一台设备读过的会话，在本机不再复亮', async ({ page }) => {
    await gotoMock(page);

    // 必须用另一工作区：全局基线钉在 /__reset 时刻，主工作区所有会话（-10s 起）都在它之前，会先被
    // 「基线不追溯」挡掉——用它们做对照，这条用例就分辨不出 seen 位点到底有没有生效。另一工作区那组
    // 恒在基线之后（见 mock server 的 MOCK_LIST_CLOCK_LEAD_MS 注释），是唯一能把 seen 单独测出来的一组。
    await sendChatMessage(page, 'test:needsyou');
    await waitForIdle(page);

    // 另一台设备读过这一个会话（直接写服务端共享位点，本机 localStorage 里没有任何痕迹）
    await page.request.post('/__arm-read-elsewhere?sessionId=mock-session-another');

    // 造出「换设备」的处境：这台设备很久以前首次打开过（基线老），但那几次阅读都发生在另一台上
    // （本地 seen 空）。修复前这两条合起来就是那屏假未读。
    await page.evaluate(() => localStorage.setItem(
      'ccm-unread-v1',
      JSON.stringify({ baselineTs: Date.now() - 3_600_000, seen: {}, manual: {} }),
    ));
    await page.reload();
    await waitUntilConnected(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE);

    // 对照组先断言：同一工作区里同样晚于基线、同样没有本地 seen 记录的另一行仍然亮——没有这条，
    // 下面那句「不亮」会在任何把未读整体关掉的回归里恒绿。
    const stillUnread = page.locator('[data-testid="session-row"][data-session-id="mock-session-another-done"]');
    await expect(stillUnread.locator('[data-testid="unread-mark"]')).toHaveText('未读');

    const readElsewhere = page.locator('[data-testid="session-row"][data-session-id="mock-session-another"]');
    await expect(readElsewhere.locator('[data-testid="unread-mark"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  // P3 抽屉局部重建 + SWR 保鲜（切到后台重连后抽屉卡顿的修复）三条回归：
  // t 断线重连零变化 → 两个目录 DOM 原样保留、不出现骨架屏；
  // v 断线期间真实标题变化 → 抽屉必须显示新内容（防缓存优化引入"不刷新"回归）；
  // w 只有一个目录变化 → 另一个未变化目录的 DOM 不被连坐重建。
  // 三者共用 test:reconnect-drawer-quiet / test:reconnect-drawer-refresh 两个 mock 夹具（见
  // tests/e2e/mock/server.js），都靠"[MOCK_INFO] Reconnect drawer settle marker"哨兵消息确定性地
  // 等到本次重连触发的 instances 广播已处理完，不使用被 npm run check 禁掉的 waitForTimeout。
  test('P0-11t 断线重连无数据变化：抽屉两个工作区 DOM 子树原样保留，不出现骨架屏', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:reconnect-drawer-quiet');
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await expect(sessionButtonByTitle(page, 'Visual Sandbox (Main)')).toBeVisible();
    await expect(sessionButtonByTitle(page, 'Another App Concurrency')).toBeVisible();

    await markSessionRows(page, MAIN_WORKSPACE);
    await markSessionRows(page, ANOTHER_WORKSPACE);

    // mock 内部延时 2.5s 后才断线，上面的展开+打标记操作留有充足余量。服务端主动 disconnect(true) 的
    // reason 是 "io server disconnect"——socket.io 客户端按规范不会自动重连，需要显式触发（同
    // input-send-empty.spec.ts P0-02d 的既有断线重连套路：派发 online 事件走 app.js reconnectIfNeeded）。
    await waitUntilDisconnected(page);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);
    await expect(page.locator('#messages')).toContainText('Reconnect drawer settle marker');

    await expect(page.locator('#sessionPanel .skeleton-loader')).toHaveCount(0);
    const mainMarks = await readSessionRowMarks(page, MAIN_WORKSPACE);
    const anotherMarks = await readSessionRowMarks(page, ANOTHER_WORKSPACE);
    expect(mainMarks.length).toBeGreaterThan(0);
    expect(mainMarks.every(m => m === 'preserved')).toBe(true);
    expect(anotherMarks.length).toBeGreaterThan(0);
    expect(anotherMarks.every(m => m === 'preserved')).toBe(true);

    await expectNoBrowserErrors(page);
  });

  test('P0-11v 断线期间会话标题真的变了：重连后抽屉必须显示新标题（防缓存优化引入不刷新回归）', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:reconnect-drawer-refresh');
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await expect(sessionButtonByTitle(page, 'Visual Sandbox (Main)')).toBeVisible();
    await expect(sessionButtonByTitle(page, 'Another App Concurrency')).toBeVisible();

    // 服务端主动 disconnect(true) 的 reason 是 "io server disconnect"——socket.io 客户端按规范不会
    // 自动重连，需要显式触发（同 input-send-empty.spec.ts P0-02d 的既有断线重连套路）。
    await waitUntilDisconnected(page);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);
    await expect(page.locator('#messages')).toContainText('Reconnect drawer settle marker');

    await expect(sessionButtonByTitle(page, 'Renamed After Reconnect')).toBeVisible();
    await expect(page.locator('#sessionPanel')).not.toContainText('Visual Sandbox (Main)');

    await expectNoBrowserErrors(page);
  });

  test('P0-11w 只有一个工作区数据变化时，另一个未变化工作区的 DOM 子树不被连坐重建', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:reconnect-drawer-refresh');
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await expect(sessionButtonByTitle(page, 'Visual Sandbox (Main)')).toBeVisible();
    await expect(sessionButtonByTitle(page, 'Another App Concurrency')).toBeVisible();

    await markSessionRows(page, ANOTHER_WORKSPACE);

    // 服务端主动 disconnect(true) 的 reason 是 "io server disconnect"——socket.io 客户端按规范不会
    // 自动重连，需要显式触发（同 input-send-empty.spec.ts P0-02d 的既有断线重连套路）。
    await waitUntilDisconnected(page);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);
    await expect(page.locator('#messages')).toContainText('Reconnect drawer settle marker');
    // 主工作区新标题落地——它和"另一个目录 DOM 有没有被连带重建"同属一次 setInstances 判定的产物，
    // 用它做完成信号比额外哨兵更贴近真实回归点（这次判定确实处理过"只有 MAIN 变了"这件事）。
    await expect(sessionButtonByTitle(page, 'Renamed After Reconnect')).toBeVisible();

    const anotherMarks = await readSessionRowMarks(page, ANOTHER_WORKSPACE);
    expect(anotherMarks.length).toBeGreaterThan(0);
    expect(anotherMarks.every(m => m === 'preserved')).toBe(true);

    await expectNoBrowserErrors(page);
  });

  // P0-11y：terminal busy 即使与 idle live 实例并存也不能被遮蔽；会话行 chip 写「终端运行中」
  // 把来源放在标题行。terminal alive 不占主状态位，副文本「终端已打开」提到时间前面。
  test('P0-11y CLI busy 显示终端运行中，alive 仅显示终端已打开', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:terminal-badge');
    await openSessionsSidebar(page);
    const mainDir = await expandWorkspace(page, MAIN_WORKSPACE);

    await expect(mainDir.locator('.dir-badge')).toHaveText('运行中');

    // 同一会话已有 idle Web live 实例时，terminal busy 仍应显示，不能被 liveInst 分支遮蔽。
    const overlapRow = sessionRowByInstance(page, 'inst_1');
    await expectSessionStatusChip(page, 'inst_1', '终端运行中');
    await expect(overlapRow).toContainText('终端运行中');

    // 纯终端 busy：chip 本身写明终端，不再靠副行「· 终端」。
    const busyRow = page.locator('[data-testid="session-row"]', { hasText: 'Archived Planning Session' });
    await expect(busyRow.locator('[data-session-status]')).toHaveText('终端运行中');
    await expect(busyRow).toContainText('终端运行中');

    // alive：终端开着但空闲，不显示主状态 chip，只显示明确副文本。
    const aliveRow = page.locator('[data-testid="session-row"]', { hasText: 'Archived Gap Session' });
    await expect(aliveRow.locator('[data-session-status]')).toHaveCount(0);
    await expect(aliveRow).toContainText('终端已打开');

    // 没有终端状态的普通历史会话不凭空长出状态。
    const plainRow = page.locator('[data-testid="session-row"]', { hasText: 'Deleted Remote Session' });
    await expect(plainRow.locator('[data-session-status]')).toHaveCount(0);
    await expect(page.locator('[data-terminal-badge]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  // 2026-09-06：外部驾驶员不只有终端。桌面端 Code 模式（Claude.app 的 Code 标签）跑的是同一份
  // claude 二进制、写同一份 transcript，注册表条目自报 entrypoint=claude-desktop 但【不写 status】。
  // 此前它和 sdk 系一起被排除在终端标注之外，桌面端会话在抽屉里【只有一个未读点】，没有任何运行标识。
  // 这条守的是**渲染层最后一米**（与 P0-11ag 同理）：判据、Map 注入、纯函数文案都在单测里绿了，
  // 但字段还要过 dataset 往返 + DRAWER_STATUS_META 白名单——漏一环就静默显示成"终端"或干脆没有。
  test('P0-11ah 桌面端 Code 模式驾驶：显示「桌面端运行中」而非冒充终端', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:desktop-badge');
    await openSessionsSidebar(page);
    const mainDir = await expandWorkspace(page, MAIN_WORKSPACE);

    // 目录角标走状态轴，不带来源：桌面端在跑同样点亮工作区（此前完全不亮）
    await expect(mainDir.locator('.dir-badge')).toHaveText('运行中');

    // 同一会话已有 idle Web live 实例时不得被 liveInst 分支遮蔽（与 cli 同规矩）
    await expectSessionStatusChip(page, 'inst_1', '桌面端运行中');

    const busyRow = page.locator('[data-testid="session-row"]', { hasText: 'Archived Planning Session' });
    await expect(busyRow.locator('[data-session-status]')).toHaveText('桌面端运行中');
    // 措辞必须真的换掉：说成"终端"会让人去翻终端标签页，而回合跑在桌面 app 的窗口里
    await expect(busyRow).not.toContainText('终端运行中');

    // alive 档同样按来源分：桌面端窗口开着但闲着
    const aliveRow = page.locator('[data-testid="session-row"]', { hasText: 'Archived Gap Session' });
    await expect(aliveRow.locator('[data-session-status]')).toHaveCount(0);
    await expect(aliveRow).toContainText('桌面端已打开');
    await expect(aliveRow).not.toContainText('终端已打开');

    // 无终端状态的会话不凭空长出状态
    const plainRow = page.locator('[data-testid="session-row"]', { hasText: 'Deleted Remote Session' });
    await expect(plainRow.locator('[data-session-status]')).toHaveCount(0);

    // 增量重绘后来源不得丢。夹具 1.5s 后只改 inst_1 的 state 再广播 instances，前端走
    // 「非结构变化 → refreshSessionStatusChips」增量分支，逐行【从 row.dataset 重建 chip】。
    // dataset 少写一个 terminalSource，这里就静默退回"终端运行中"——而首次渲染完全看不出来
    // （它读的是 session:list 的原始行）。inst_1 变「需要你」是广播已到达的锚点。
    await expectSessionStatusChip(page, 'inst_1', '需要你');
    await expect(busyRow.locator('[data-session-status]')).toHaveText('桌面端运行中');
    await expect(busyRow).not.toContainText('终端运行中');

    await expectNoBrowserErrors(page);
  });

  // 2026-09-04：CLI 卡在权限审批框上时，注册表自报 status:"waiting"——这条通道此前被漏认，等审批的
  // 会话在抽屉里与「终端开着但闲着」完全同形（都只有一句副文本「终端已打开」）。
  // 这条用例守的是**渲染层最后一米**：判据/纯函数都在单测里绿了，但 chip 还要过 DRAWER_STATUS_META
  // 这道白名单——漏登记就静默不显示，判据全绿、界面照旧。单测碰不到这一段。
  test('P0-11ag CLI 等审批显示「终端需要你」，与 busy/alive 三态互不同形', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:terminal-waiting');
    await openSessionsSidebar(page);
    const mainDir = await expandWorkspace(page, MAIN_WORKSPACE);

    // 目录角标：抽屉折叠时用户只看得到这一行，等人的状态必须能穿透到这里
    await expect(mainDir.locator('.dir-badge')).toHaveText('终端需要你');

    // 会话行 chip：措辞与 Web 侧「需要你」区分开——终端那个在手机上批不了
    const waitingRow = page.locator('[data-testid="session-row"]', { hasText: 'Archived Planning Session' });
    await expect(waitingRow.locator('[data-session-status]')).toHaveText('终端需要你');
    await expect(waitingRow).not.toContainText('终端运行中');

    // 同屏对照：alive 仍只有副文本、无 chip。三态同形才是这次要修的缺陷本身
    const aliveRow = page.locator('[data-testid="session-row"]', { hasText: 'Archived Gap Session' });
    await expect(aliveRow.locator('[data-session-status]')).toHaveCount(0);
    await expect(aliveRow).toContainText('终端已打开');

    await expectNoBrowserErrors(page);
  });

  test('P0-11z 抽屉保持打开时低频刷新 CLI 运行态，无需 instances 结构变化', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:terminal-refresh');
    await openSessionsSidebar(page);
    const mainDir = await expandWorkspace(page, MAIN_WORKSPACE);
    const row = page.locator('[data-testid="session-row"]', { hasText: 'Archived Planning Session' });

    // 首次 session:list 尚无 terminal；随后 instances 只改 live 状态、不重建目录子树。
    await expect(row.locator('[data-session-status]')).toHaveCount(0);
    await expectSessionStatusChip(page, 'inst_1', '需要你');

    // 第二次列表刷新让另一行出现 terminal busy 并触发整段 rows 重画；live 行仍必须读最新 instances 状态。
    await expect(row.locator('[data-session-status]')).toHaveText('终端运行中', { timeout: 18_000 });
    await expect(row).toContainText('终端运行中');
    await expectSessionStatusChip(page, 'inst_1', '需要你');
    await expect(mainDir.locator('.dir-badge')).toHaveText('需要你');

    await expectNoBrowserErrors(page);
  });

  test('P0-11aa 页外 CLI busy 仍点亮工作区汇总，关闭抽屉后不残留陈旧提示', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:terminal-summary');
    await openSessionsSidebar(page);
    const otherDir = await expandWorkspace(page, ANOTHER_WORKSPACE);

    // 返回会话行都没有 terminal 字段，运行态只来自 session:list 的 cwd 级 terminalBusy 汇总。
    await expect(otherDir.locator('.dir-badge')).toHaveText('运行中');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('aria-label', '运行中');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区 · 运行中');
    // 2026-09-02：busy 不再占顶栏文字 chip。顶栏那一个位子只说「点开就能处理」的事，而「别的
    // 工作区在跑」点开抽屉也没有可执行动作，且它是能持续几十分钟的状态（不是事件），常驻会训练
    // 用户忽略这个位置、反过来拉低同槽位「需要你/出错」的信号强度。该信息由 #sessionsDot 图标
    // 独自承担——图标是被动的环境感知，不喊人。判定见 logic resolveHeaderAttentionChip。
    await expect(page.locator('[data-testid="header-attention-chip"]')).toBeHidden();
    const otherSubtree = otherDir.locator('xpath=following-sibling::*[1]');
    await expect(otherSubtree.locator('[data-session-status]')).toHaveCount(0);

    await page.locator('#sidebarClose').click();
    await expectSidebarClosed(page);
    await expect(page.locator('#sessionsDot')).toBeHidden();
    await expect(page.locator('[data-testid="header-attention-chip"]')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // P0-11ai（2026-09-06）：terminalBusy / terminalWaiting 是 session:list ack 上的一对 cwd 级汇总，
  // 存在的唯一理由是「默认分页只回 6 行，页外的终端状态否则完全看不见」。真 server 此前只回传了
  // terminalBusy 半边，waiting 漏传——前端 updateTerminalStateForDir 对两个字段各自判
  // `typeof === 'boolean'`，缺的那个静默回落成 rowHas('waiting')，只扫本页返回行。
  //
  // 这个缺陷为什么能活下来：页内有 waiting 行时回落照样点亮，P0-11ag 因此一直是绿的；而漏传与
  // 「连的是旧服务端」在客户端完全不可区分，所以没有任何报错。漏掉的还恰是更要紧的半边——
  // 目录行只有一个角标位，waiting 的优先级高于 busy（等人的那个才要用户动手）。
  //
  // 夹具与 P0-11aa 同形，只换汇总的那一位：另一工作区返回 5 行、全部不带 terminal 字段，
  // 运行态只可能来自 cwd 级 terminalWaiting。据此，「返回行无 [data-session-status]」这条断言不是
  // 装饰，它是本用例的仪器校验——没有它，角标亮了也说不清是汇总起的作用还是行回落起的作用。
  //
  // 同一条用例还守第二个面：抽屉一折叠，目录角标就没了，#sessionsDot 是页外等审批唯一的出口，而
  // summarizeOtherWorkspaces 的 rank 表此前也漏了 terminal_waiting。两个面在这里同屏才说得清完整的
  // 分流：图标点亮、顶栏安静——「让你知道」与「喊你去处理」是两件事。
  test('P0-11ai 页外 CLI 等审批必须可见：目录角标 + 顶部图标都点亮，顶栏 chip 仍安静', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:terminal-summary-waiting');
    await openSessionsSidebar(page);
    const otherDir = await expandWorkspace(page, ANOTHER_WORKSPACE);

    // 汇总里 terminalBusy=false、terminalWaiting=true：角标必须是「终端需要你」而不是「运行中」，
    // 也不得因为字段没到而整个消失（漏传时 next 塌成 null → .dir-badge hidden）。
    await expect(otherDir.locator('.dir-badge')).toHaveText('终端需要你');

    // 仪器校验：这一页 5 行没有任何一行带 terminal，行回落判不出 waiting。
    const otherSubtree = otherDir.locator('xpath=following-sibling::*[1]');
    await expect(otherSubtree.locator('[data-session-status]')).toHaveCount(0);

    // #sessionsDot：抽屉一折叠，目录角标就看不见了，顶部这颗图标是页外等审批唯一的出口。
    // summarizeOtherWorkspaces 的 rank 表此前不含 terminal_waiting（未登记 → rank 缺省 0 静默吞掉），
    // 于是这里恒隐藏；更糟的是同目录只要另有个在跑的会话反倒会亮「运行中」，更轻的盖过更重的。
    // 单测钉的是 rank 表本身，钉不到「图标真的画出来了」——那还要过 DRAWER_STATUS_META 这道渲染白名单。
    await expect(page.locator('#sessionsDot')).toHaveAttribute('aria-label', '终端需要你');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区 · 终端需要你');

    // 但顶栏文字 chip 必须【仍然】安静。图标与 chip 出自同一个 summarizeOtherWorkspaces，分流全靠
    // 两张表（DRAWER_STATUS_META 渲染白名单 / OTHER_WORKSPACE_CHIP_TONE 准入表）——给 rank 表加状态
    // 不得顺带从顶栏漏出去。终端里的审批 prompt 活在 CLI 的 TUI 里，手机上按不了键，不占「点开就能
    // 处理」的槽位。这一条与上面两条同屏，正是「图标点亮 ≠ 喊人」这个区分本身。
    await expect(page.locator('[data-testid="header-attention-chip"]')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // P0-11ae（2026-09-02 真机报告）：刷新后打开抽屉，折叠工作区的「N 未读」要等满一个 12s 周期才
  // 出现——移动端 onOpened 是三条打开路径里唯一没传 immediate 的（桌面 toggleSessions、
  // visibilitychange 回前台都传了），而移动端恰恰是本产品主场景。更糟的是空窗期不是「像在加载」：
  // 旧渲染把「缓存未到位」与「确定 0 未读」一并隐藏，用户读到的是一个错误事实。
  // 本用例把 timeout 压在 5s（远小于 SESSION_PANEL_REVALIDATE_MS=12s）：只有打开抽屉那一刻真的
  // 为折叠目录取过数，data-state 才会离开 pending。修复前这里必红。
  test('P0-11ae 打开抽屉即刻为折叠工作区取数：未读角标不停在 pending', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:tab'); // 第二个工作区要有实例才会进 dirs 广播
    await waitForIdle(page);
    await openSessionsSidebar(page);

    // ANOTHER 保持折叠：openSessionPanel 不会 populate 它，数据只可能来自打开抽屉时那次立即刷新。
    const otherDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(otherDir.locator('[data-testid="dir-unread"]'))
      .toHaveAttribute('data-state', /^(none|unread)$/, { timeout: 5_000 });

    await expectNoBrowserErrors(page);
  });

  test('P0-11ab 迟到的旧 session:list 不得覆盖较新的 terminal 状态', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:terminal-race');
    await openSessionsSidebar(page);
    const mainDir = await expandWorkspace(page, MAIN_WORKSPACE);
    const row = page.locator('[data-testid="session-row"]', { hasText: 'Archived Planning Session' });
    await expect(row.locator('[data-session-status]')).toHaveCount(0);

    // visibility 恢复路径会立即 revalidate；连续触发两次制造两个同 cwd 并发请求。
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('#messages')).toContainText('Delayed stale session list delivered.', { timeout: 5_000 });

    // 第二个新响应已确认无 terminal；随后到达的第一个旧 busy 响应必须被 request generation 丢弃。
    await expect(row.locator('[data-session-status]')).toHaveCount(0);
    await expect(mainDir.locator('.dir-badge')).toHaveClass(/hidden/);

    await expectNoBrowserErrors(page);
  });

  test('P0-11ac 关闭抽屉后才返回的 terminalBusy 不得重新点亮顶部', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:terminal-close-race');
    await openSessionsSidebar(page);
    await expandWorkspace(page, ANOTHER_WORKSPACE); // 发出延迟 session:list
    await page.locator('#sidebarClose').click();
    await expectSidebarClosed(page);

    await expect(page.locator('#messages')).toContainText('Delayed closed-drawer session list delivered.', { timeout: 5_000 });
    await expect(page.locator('#sessionsDot')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // 长按会话行 → 标为未读 / 标为已读（2026-09-02）。触屏路径只发 pointerdown、不发 pointerup——
  // 500ms 后由前端自己的计时器触发（web-first 断言等它到点，不用被门禁禁掉的 waitForTimeout）；
  // 桌面右键（contextmenu）走同一个入口。长按松手时浏览器仍会派发 click，必须被吞掉，否则弹出
  // 确认 sheet 的同时会话也被切走。标记落 localStorage，刷新后仍在；只有再次打开该会话才清。
  test('P0-11ad 长按会话行标为未读：行上出现「未读」、目录头计数、刷新仍在、再长按标回已读', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    const mainDir = await expandWorkspace(page, MAIN_WORKSPACE);
    const row = page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');
    await expect(row).toBeVisible();
    await expect(row.locator('[data-testid="unread-mark"]')).toHaveCount(0);
    await expect(mainDir.locator('[data-testid="dir-unread"]')).toBeHidden();
    await markSessionRows(page, MAIN_WORKSPACE);

    await row.dispatchEvent('pointerdown', { pointerId: 1, button: 0, isPrimary: true, clientX: 120, clientY: 200 });
    const modal = page.locator('#confirmModal');
    await expect(modal).toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmTitle')).toHaveText('Archived Planning Session');
    await expect(page.locator('#confirmOk')).toHaveText('标为未读');
    await page.locator('#confirmOk').click();
    await expect(modal).not.toHaveClass(/sheet-open/);
    // 答完确认要回到抽屉看见那一行的新状态：确认 sheet 上的点击不算「点抽屉外面」（app.js 全局 click 收抽屉的豁免）
    await expectSidebarOpen(page);
    // 标记是原地重刷这一行，不重建节点（长按监听仍挂在原节点上）
    expect(await readSessionRowMarks(page, MAIN_WORKSPACE)).toContain('preserved');

    await expect(row.locator('[data-testid="unread-mark"]')).toHaveText('未读');
    await expect(row.locator('[data-session-head] > span').first()).toHaveClass(/font-semibold/);
    await expect(mainDir.locator('[data-testid="dir-unread"]')).toHaveText('1 未读');

    // 长按松手：pointerup + click 落到行按钮上，click 必须被吞掉——抽屉仍开着、没有切会话
    await row.dispatchEvent('pointerup', { pointerId: 1, clientX: 120, clientY: 200 });
    await row.locator('button').first().dispatchEvent('click');
    await expectSidebarOpen(page);
    await expect(row.locator('[data-testid="unread-mark"]')).toHaveText('未读');

    // 刷新后仍未读（localStorage 持久）：手动标记不受「基线不追溯」影响
    await page.reload();
    await waitUntilConnected(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const rowAfter = page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');
    await expect(rowAfter.locator('[data-testid="unread-mark"]')).toHaveText('未读');
    await expect(workspaceRow(page, MAIN_WORKSPACE).locator('[data-testid="dir-unread"]')).toHaveText('1 未读');

    // 桌面右键同效；已标过的这次是「标为已读」
    await rowAfter.dispatchEvent('contextmenu');
    await expect(modal).toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmOk')).toHaveText('标为已读');
    await page.locator('#confirmOk').click();
    await expect(rowAfter.locator('[data-testid="unread-mark"]')).toHaveCount(0);
    await expect(rowAfter.locator('[data-session-head] > span').first()).not.toHaveClass(/font-semibold/);
    await expect(workspaceRow(page, MAIN_WORKSPACE).locator('[data-testid="dir-unread"]')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // P0-11ak（2026-09-07 真机报告）：在【当前正打开的】会话上长按标未读，屏幕上什么都没发生——
  // 确认框刚承诺「这一行会一直显示未读」，得切到别的会话才看见它浮出来。根因是 isSessionUnread 里
  // isViewing 短路排在 manual 前面，把「时间判据不可信」这条理由错施加到了用户的显式输入上。
  // 上面的 P0-11ad 标的是非当前会话（mock-session-archived），结构上走不到这条路径，故单开一条。
  // 夹具选 mock-session-visual-test：它既是 inst_1 正在看的会话，lastUsedAt 又落在基线之前
  // （时间判据对它恒为「不亮」）——所以下面出现的 chip 只可能来自手动标记这一条路径。
  // 「没有手动标记时 isViewing 仍压住时间判据」那一反向档在 logic-unread 单测里（E2E 控不住时间戳）。
  test('P0-11ak 当前会话标为未读：chip 与目录计数当场出现，不必先切走', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    const mainDir = await expandWorkspace(page, MAIN_WORKSPACE);
    const viewingRow = page.locator('[data-testid="session-row"][data-session-id="mock-session-visual-test"]');
    await expect(viewingRow).toBeVisible();
    await expect(viewingRow.locator('[data-testid="unread-mark"]')).toHaveCount(0);
    await expect(mainDir.locator('[data-testid="dir-unread"]')).toBeHidden();

    await viewingRow.dispatchEvent('contextmenu');
    const modal = page.locator('#confirmModal');
    await expect(modal).toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmOk')).toHaveText('标为未读');
    await page.locator('#confirmOk').click();
    await expect(modal).not.toHaveClass(/sheet-open/);

    // 核心：没有切会话、没有刷新，这一行当场就带上 chip（修复前此处恒为 0，正是那份真机报告）
    await expectSidebarOpen(page);
    await expect(viewingRow.locator('[data-testid="unread-mark"]')).toHaveText('未读');
    await expect(viewingRow.locator('[data-session-head] > span').first()).toHaveClass(/font-semibold/);
    await expect(mainDir.locator('[data-testid="dir-unread"]')).toHaveText('1 未读');

    // 标回已读同样当场生效：菜单此前靠 isManualUnread 旁路才能改口，现在 isUnread 一个口就够。
    // 这里连着第二次 contextmenu 是有意的——它同时是 long-press.js swallowNextClick 闩的集成层见证：
    // 那个闩此前由 contextmenu 也置起，而右键既不走主键 pointerdown 也不派发 click，两条清除路都不走，
    // 于是同一行右键第二次起静默无反应（2026-09-07 同批修复；P0-11ad 两次之间恰好夹了个 click 才没撞上）。
    await viewingRow.dispatchEvent('contextmenu');
    // 先断言 sheet 真的开了再读按钮文字：不然读到的是上一次残留的 DOM，这条断言会恒绿
    await expect(modal).toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmOk')).toHaveText('标为已读');
    await page.locator('#confirmOk').click();
    await expect(viewingRow.locator('[data-testid="unread-mark"]')).toHaveCount(0);
    await expect(mainDir.locator('[data-testid="dir-unread"]')).toBeHidden();

    await expectNoBrowserErrors(page);
  });
  // P0-11aj（2026-09-07 真机撞出）：会话被 `claude agents` 的后台 job 独占时，web 打不开它。
  // 修之前的形态：session:switch 被拒 → addBar 落进 #messages，而 #messages 是【当时正看着的
  // 那个会话】的消息流，视图从头到尾没动过；点击时又已经先关了侧栏。于是「blog_static 的会话被
  // 占用」这句话出现在另一个工作区会话的工具卡中间，读起来像是当前会话出了事。
  // 三条断言各自独立会红：①行上的预警 ②落地页自报的是目标会话 ③当前会话流一个字都没多。
  test('P0-11aj: 被后台 agent 独占的会话——行上先预警，点开落到目标会话自己的页面', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:bg-locked');
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);

    const gapRow = page.locator('[data-testid="session-row"]', { hasText: 'Archived Gap Session' });
    // ① 点之前就看得出来。占用者自报 idle（terminal='alive'），所以这一行在修之前【完全没有 chip】
    const chip = gapRow.locator('[data-session-status]');
    await expect(chip).toHaveText('后台占用');
    await expect(chip).toHaveAttribute('aria-label', '后台占用');

    // 当前会话流的红字条数——这是本次回归真正要钉住的量
    const dangerBars = page.locator('#messages .text-danger');
    const dangerBefore = await dangerBars.count();

    await openSessionByTitle(page, 'Archived Gap Session');

    // ② 落地页出现，并且自报的身份是【目标】会话，不是当前会话
    const surface = page.locator('[data-testid="session-blocked-surface"]');
    await expect(surface).toBeVisible();
    await expect(page.locator('[data-testid="session-blocked-title"]')).toHaveText('Archived Gap Session');
    await expect(page.locator('[data-testid="session-blocked-project"]')).toHaveText('claude-chat-mobile');
    await expect(page.locator('[data-testid="session-blocked-reason"]')).toContainText('后台任务');
    await expect(page.locator('[data-testid="session-blocked-reason"]')).toContainText('claude agents');

    // ③ 当前会话的消息流一个字都没多
    await expect(page.locator('#messages')).not.toContainText('后台任务');
    expect(await dangerBars.count()).toBe(dangerBefore);

    // ④ 重试仍被拒：留在原地刷新原因，不跳走也不叠加第二份
    await page.locator('[data-testid="session-blocked-retry"]').click();
    await expect(surface).toBeVisible();
    await expect(page.locator('[data-testid="session-blocked-reason"]')).toContainText('后台任务');
    await expect(page.locator('[data-testid="session-blocked-retry"]')).toBeEnabled();
    expect(await dangerBars.count()).toBe(dangerBefore);

    // ⑤ 返回 → 落地页收起，原会话原样还在（没被清空过）
    await page.locator('[data-testid="session-blocked-back"]').click();
    await expect(surface).toBeHidden();
    await expect(page.locator('#messages')).toContainText('test:bg-locked');

    await expectNoBrowserErrors(page);
  });
});
