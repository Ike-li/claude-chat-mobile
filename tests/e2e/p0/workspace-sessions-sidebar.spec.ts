// spec: docs/testing.md
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
} from '../../helpers/p0-ui';

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

  // R65 未读点（2026-08-30，替代当天撤除的 H1 聚合卡，计划见 draft/plan-unread-dot-fable-5.md）：
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
    // 顶栏文字 chip 与 #sessionsDot 同源同步：图标说不清的，这里用字说
    await expect(page.locator('[data-testid="header-attention-chip"]')).toHaveText('其他工作区 · 运行中');
    const otherSubtree = otherDir.locator('xpath=following-sibling::*[1]');
    await expect(otherSubtree.locator('[data-session-status]')).toHaveCount(0);

    await page.locator('#sidebarClose').click();
    await expectSidebarClosed(page);
    await expect(page.locator('#sessionsDot')).toBeHidden();
    await expect(page.locator('[data-testid="header-attention-chip"]')).toBeHidden();

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
});
