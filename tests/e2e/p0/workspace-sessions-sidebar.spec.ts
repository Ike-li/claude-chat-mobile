// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect, type Page } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
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

  test('P0-11c 后台工作区完成态显示顶部和侧栏角标', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:background-done');
    await waitForIdle(page);
    await expect(page.locator('#sessionsDot')).toBeVisible();
    await expect(page.locator('#sessionsDot')).toHaveAttribute('aria-label', '成功');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区已完成');

    await openSessionsSidebar(page);
    const backgroundDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('aria-label', '成功');
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
    await expect(page.locator('#sessionsDot')).toHaveAttribute('aria-label', '出错');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区出错');

    await openSessionsSidebar(page);
    const backgroundDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('aria-label', '出错');
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
    await expect(page.locator('#sessionsDot')).toHaveAttribute('aria-label', '待审批');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他工作区待审批');

    await openSessionsSidebar(page);
    const backgroundDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('aria-label', '待审批');
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
    await expectSessionBadge(page, 'inst_1', '⚠️');

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
    await expectSessionBadge(page, 'inst_1', '⚠️');

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
    await expect(page.locator('#connDot')).toHaveClass(/bg-danger/, { timeout: 10_000 });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });
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
    await expect(page.locator('#connDot')).toHaveClass(/bg-danger/, { timeout: 10_000 });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });
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
    await expect(page.locator('#connDot')).toHaveClass(/bg-danger/, { timeout: 10_000 });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('Reconnect drawer settle marker');
    // 主工作区新标题落地——它和"另一个目录 DOM 有没有被连带重建"同属一次 setInstances 判定的产物，
    // 用它做完成信号比额外哨兵更贴近真实回归点（这次判定确实处理过"只有 MAIN 变了"这件事）。
    await expect(sessionButtonByTitle(page, 'Renamed After Reconnect')).toBeVisible();

    const anotherMarks = await readSessionRowMarks(page, ANOTHER_WORKSPACE);
    expect(anotherMarks.length).toBeGreaterThan(0);
    expect(anotherMarks.every(m => m === 'preserved')).toBe(true);

    await expectNoBrowserErrors(page);
  });

  // P0-11y（P1，7/26 CCD 调研吸收）：终端直跑的外部会话在列表里必须有徽标。此前这类会话（没有 web
  // live 实例、只在电脑终端里跑）在抽屉里与已结束会话长得一模一样，只有点进去看只读镜像才知道在跑。
  // 数据源是 CLI 自报的进程注册表（server 侧 listTerminalSessionStates 标注到 session:list 行上）。
  test('P0-11y 终端直跑的外部会话在抽屉里显示 ⌨️ 徽标（busy/alive 两态可区分）', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:terminal-badge');
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);

    // busy：终端正在跑一轮 → 警示色徽标
    const busyRow = page.locator('[data-testid="session-row"]', { hasText: 'Archived Planning Session' });
    const busyBadge = busyRow.locator('[data-terminal-badge]');
    await expect(busyBadge).toBeVisible();
    await expect(busyBadge).toHaveAttribute('title', '终端运行中');
    await expect(busyBadge).toHaveClass(/text-warning/);

    // alive：终端开着但空闲等输入 → 弱化色，不与 busy 混同
    const aliveRow = page.locator('[data-testid="session-row"]', { hasText: 'Archived Gap Session' });
    const aliveBadge = aliveRow.locator('[data-terminal-badge]');
    await expect(aliveBadge).toBeVisible();
    await expect(aliveBadge).toHaveAttribute('title', '终端会话已打开');
    await expect(aliveBadge).toHaveClass(/text-ink-faint/);

    // 没有终端在跑的会话不得凭空长出徽标
    const plainRow = page.locator('[data-testid="session-row"]', { hasText: 'Visual Sandbox (Main)' });
    await expect(plainRow.locator('[data-terminal-badge]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });
});
