// helpers: tests/helpers/playwright.ts
// 抽屉的会话切换、关闭、历史、搜索、删除与打不开的会话；行上的未读与运行态在 workspace-sessions-sidebar-status.spec.ts。
// 两份原是一个文件，2026-10-25 按主题拆开：同一个 spec 不跨 CI 分片，它独自撑着 105s 的地板。

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
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
  showMoreSessions,
  startNewSessionInWorkspace,
  workspaceRow
} from '../../helpers/sidebar-ui';

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

  test('P0-11m sidebar 显示更多后可打开较早历史会话', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:history-overflow');

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(page.getByTestId('session-show-more')).toHaveText('显示更多 3 个（还有 13 个）');
    await expect(page.locator('#sessionPanel')).not.toContainText('Older Migration Session');

    await showMoreSessions(page, MAIN_WORKSPACE, 2); // 它排第 7，每档 3 条
    await expect(sessionButtonByTitle(page, 'Older Migration Session')).toBeVisible();

    await openSessionByTitle(page, 'Older Migration Session');
    await expectSidebarClosed(page);
    await expect(page.locator('#messages')).toContainText('Review older migration notes', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('Older migration history loaded from session:list overflow.');
    await expect(page.locator('#messages')).not.toContainText('test:history-overflow');

    await expectNoBrowserErrors(page);
  });

  // P0-11an（2026-09-07）：jsonl 被删/改名/读坏时，真 server 回 { messages: [], error }，前端据 error
  // 打一行灰字「历史消息加载失败」。此前这条路径在整套 E2E 里不可达——mock 的 session:history handler
  // 有 17 处 callback、无一带 error；前端也没有任何单测碰它。
  // 漏发时的形态是最糟的一种：loading 卡已被 hideLoadingCard() 抹掉，于是消息区【完全空白】——
  // 既没有内容，也没有「加载了 N 条」，更没有失败提示，用户无从判断是会话是空的还是读挂了。
  test('P0-11an 历史读不出来时给灰行提示，而不是留一屏空白', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    // 一次性 arm：只影响紧接着的那一次 session:history，不污染后续用例
    await page.request.post('/__arm-history-error');
    await openSessionByTitle(page, 'Archived Planning Session');
    await expectSidebarClosed(page);

    await expect(page.locator('#messages')).toContainText('历史消息加载失败', { timeout: 10_000 });
    // 反向档：这条用例要证的是「失败被说出来了」，不是「什么都没渲染」——若成功支也走到这里，
    // 会打「加载了 N 条历史消息」，两者互斥，同时断言才能区分「报错了」与「压根没加载」。
    await expect(page.locator('#messages')).not.toContainText('加载了');

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
    await expect(page.getByTestId('session-show-more-bar')).toHaveCount(0);

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

  // 2026-09-12 真机报障：「关闭会话→立刻点 🗑」必然撞上服务端 5 分钟静默期保护，而拒绝理由当时
  // 走 addBar 写进聊天消息流 #messages——抽屉打开时 #sidebarScrim（fixed inset-0 z-30）盖住整个
  // 视口，用户得到的是"点了没反应、会话还在"。
  test('P0-11-delete-reject 删除被拒绝时，理由显示在抽屉里且那一行不消失', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(sessionButtonByTitle(page, 'Deleted Remote Session')).toBeVisible();

    const row = page.locator('[data-testid="session-row"][data-session-id="mock-session-deleted"]');
    await row.getByTestId('session-delete').click();
    await expect(page.locator('#confirmModal')).toBeVisible();
    await page.getByRole('button', { name: '彻底删除' }).click();
    await expect(page.locator('#confirmModal')).toBeHidden({ timeout: 5_000 });

    // 判据是【位置】不是「可见」：Playwright 的 toBeVisible() 不做遮挡检测，消息流里那条被 scrim
    // 盖死的提示同样能过。所以这里锚在抽屉子树内，并反向钉住消息流不得再收到这条错误。
    const notice = page.locator('#leftSidebar [data-testid="drawer-notice"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('会话不存在');
    await expect(page.locator('#messages .msg-frame.text-danger')).toHaveCount(0);
    await expect(sessionButtonByTitle(page, 'Deleted Remote Session')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-11n sidebar 刷新已缓存的会话列表后显示较早历史入口', async ({ page }) => {
    await gotoMock(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(sessionButtonByTitle(page, 'Archived Planning Session')).toBeVisible();
    await expect(page.getByTestId('session-show-more')).toHaveCount(0);
    await page.locator('#sidebarClose').click();

    await sendChatMessage(page, 'test:history-overflow');
    await waitForIdle(page);

    await openSessionsSidebar(page);
    await expect(page.getByTestId('session-show-more')).toBeVisible();
    await expect(page.locator('#sessionPanel')).not.toContainText('Older Migration Session');

    await showMoreSessions(page, MAIN_WORKSPACE, 2);
    await expect(sessionButtonByTitle(page, 'Older Migration Session')).toBeVisible();
    await openSessionByTitle(page, 'Older Migration Session');
    await expect(page.locator('#messages')).toContainText('Older migration history loaded from session:list overflow.', { timeout: 10_000 });

    await expectNoBrowserErrors(page);
  });

  // revalidate 改成无条件后新增的守卫：「显示更多」是用户的显式意图，一次全量重建（这里用新增
  // 工作区触发结构性变化 → openSessionPanel）不该把它悄悄打回第一档。缓存本身不记这件事——记的是
  // moreStepsByDir，revalidate 得带着 more 一起发。
  test('P0-11x 点过"显示更多"后遇到全量重建，展开态仍保持（不被 revalidate 打回第一档）', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:history-overflow');
    await waitForIdle(page);

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await showMoreSessions(page, MAIN_WORKSPACE, 2);
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
    // 【先等新视图的历史真正上屏，再放迟到事件】这是「切换已完成、bindView 的 replayBuffer 已
    // resolve」的可观测证据。抢在它之前放，那批事件会被 shouldDropAgentEvent 丢掉，或者进了缓冲
    // 之后被 resolve(...,'reload') 连同缓冲一起丢弃——两条路都【不重发】，用例只能干等到超时。
    // 原实现让 mock 在 session:close 后固定 80ms 发，等于赌前端切得够快：本机 6 片 3/3 红。
    await expect(page.locator('#messages')).toContainText('Another App Concurrency');
    const lateEvents = await page.request.post('/__emit-late-closed-events');
    expect(lateEvents.ok()).toBeTruthy(); // 武装没生效时当场红，而不是静默空跑到超时
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
    // chip 本身就是入口：点它打开抽屉。此前同一次点击冒泡到「点外面收抽屉」，开了又立刻关上
    await page.locator('[data-testid="header-attention-chip"]').click();
    await expectSidebarOpen(page);

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

  // P0-11aj（2026-09-07 真机撞出）：会话被 `claude agents` 的后台 job 独占时，web 打不开它。
  // 修之前的形态：session:switch 被拒 → addBar 落进 #messages，而 #messages 是【当时正看着的
  // 那个会话】的消息流，视图从头到尾没动过；点击时又已经先关了侧栏。于是「blog_static 的会话被
  // 占用」这句话出现在另一个工作区会话的工具卡中间，读起来像是当前会话出了事。
  // 三条断言各自独立会红：①行上的预警 ②落地页自报的是目标会话 ③当前会话流一个字都没多。
  // 验收 O37：落地页上的「选择其他会话」打开抽屉，同一次点击冒泡到「点外面收抽屉」又把它关上，看起来跟「←」一样。
  test('P0-11aj2 打不开的会话落地页：「选择其他会话」打开抽屉并停在那里', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await sendChatMessage(page, 'test:bg-locked');
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openSessionByTitle(page, 'Archived Gap Session');
    await expect(page.locator('[data-testid="session-blocked-surface"]')).toBeVisible();

    await page.locator('[data-testid="session-blocked-sessions"]').click();
    await expect(page.locator('[data-testid="session-blocked-surface"]')).toBeHidden();
    await expectSidebarOpen(page);
    await expectNoBrowserErrors(page);
  });

  // 验收 O38：会话 A 有待批卡时切到打不开的会话 B，B 的落地页上仍浮着 A 的审批卡（切到能打开的会话时会收起，
  // 只有切换失败这条路没管）。落地页盖着时收起，回到 A 时原样恢复——那张卡还是 A 的，不能丢。
  test('P0-11aj3 当前会话有待批卡时撞上打不开的会话：落地页上不浮着它，返回后照旧在', async ({ page }) => {
    await gotoMock(page);
    await ensureComposerReady(page);
    await page.request.post('/__arm-bg-locked');
    await sendChatMessage(page, 'test:permission');
    await expect(page.locator('#permModal')).toBeVisible();

    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openSessionByTitle(page, 'Archived Gap Session');
    await expect(page.locator('[data-testid="session-blocked-surface"]')).toBeVisible();
    await expect(page.locator('#permModal'), '别的会话的审批卡浮在这个会话的落地页上').toBeHidden();

    await page.locator('[data-testid="session-blocked-back"]').click();
    await expect(page.locator('[data-testid="session-blocked-surface"]')).toBeHidden();
    await expect(page.locator('#permModal'), '回到原会话，那张没批的卡不见了').toBeVisible();
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expectNoBrowserErrors(page);
  });

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
