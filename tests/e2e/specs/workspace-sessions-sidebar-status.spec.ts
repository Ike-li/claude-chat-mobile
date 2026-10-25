// helpers: tests/helpers/playwright.ts
// 抽屉行上的未读、已读位点、终端/镜像锁/桌面端运行态与重连后的 DOM 保留；切换、关闭、历史在 workspace-sessions-sidebar.spec.ts。
// 两份原是一个文件，2026-10-25 按主题拆开：同一个 spec 不跨 CI 分片，它独自撑着 105s 的地板。

import { test, expect, type Page } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle, waitUntilConnected, waitUntilDisconnected } from '../../helpers/playwright';
import {
  ANOTHER_WORKSPACE,
  MAIN_WORKSPACE,
  expandWorkspace,
  expectSessionStatusChip,
  expectSidebarClosed,
  expectSidebarOpen,
  openSessionsSidebar,
  sessionButtonByTitle,
  sessionRowByInstance,
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

  // 2026-09-07 真机报告：在手机上读完回复直接锁屏，换一台设备打开，那个会话又亮成「未读」。
  // 记 seen 的两个入口都在 bindView 里，两个都要求用户【主动切走】：入场记的是「进入那一刻」，
  // 离场要真的切到别的会话或首页才触发。而移动端最常见的退出方式是不切任何东西——读完就锁屏、
  // 切 app、关标签页。于是「进入之后才到达的那条回复」永远晚于位点，seen 停在进入时刻。
  // 这笔陈旧位点在原设备上完全不显形（isViewing 让当前会话恒不亮），只有换一台设备才看得见。
  test('P0-11al 切后台即落已读位点：不切走会话直接锁屏，位点也要推进到此刻', async ({ page }) => {
    await gotoMock(page);

    const seenOf = async (id: string): Promise<unknown> => {
      const state = await (await page.request.get('/__read-state')).json();
      return state?.seen?.[id];
    };

    // 进入会话时 markEntered 记下的那一笔——修复前这是整条路径上唯一的一笔
    await expect.poll(async () => typeof (await seenOf('mock-session-visual-test'))).toBe('number');
    const atEntry = Number(await seenOf('mock-session-visual-test'));

    // 【不切走任何东西】直接切后台——iOS 锁屏、切到别的 app、切标签页走的都是这一条。
    // 这里不发新消息：mock 的普通消息走 scenarioRegistry 后不收尾回合（waitForIdle 会挂死），
    // 而位点推进用的是「切后台那一刻」，与这期间有没有新内容无关——真实场景里正是那条
    // 「进入之后才到达的回复」把 lastUsedAt 推到了 atEntry 之后，位点不跟上就是假未读。
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // 位点必须推进到切后台那一刻；停在 atEntry 就等于在另一台设备上亮假未读
    await expect.poll(async () => Number(await seenOf('mock-session-visual-test'))).toBeGreaterThan(atEntry);

    // 对照组：没在看的那些会话不得被顺手盖章。没有这条，「切后台把所有会话一律标已读」这种假修复
    // 同样能让上面那句变绿，而它会静默吃掉真正的未读。
    const after = await (await page.request.get('/__read-state')).json();
    expect(after?.seen?.['mock-session-archived']).toBeUndefined();

    await expectNoBrowserErrors(page);
  });

  // 首页最近列表是「重连后停在原地」最常见的落点：手机锁屏再打开必然重连，而 read:sync 只在
  // connect 那一趟发。归并回来的位点若只重建抽屉（refreshUnreadMarks 原本只认 dirSectionNodes），
  // 已经画在屏幕上的首页行就会一直停在旧判定——在另一台设备上早已读过的会话，这里仍写着「未读」，
  // 直到用户自己离开首页再回来。ensureEmptySurface 不在重连路径上，首页不会被顺带重画。
  test('P0-11am 首页停在原地时，read:sync 归并回来的位点要落到已画出的最近行上', async ({ page }) => {
    await gotoMock(page);

    // 另一工作区那组恒在全局基线之后，是唯一能在首页亮出未读的一组（同 P0-11af 的理由）
    await sendChatMessage(page, 'test:needsyou');
    await waitForIdle(page);

    await page.locator('#btnHome').click();
    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible({ timeout: 5_000 });
    const row = page.locator('#dashRecentsList .dash-recent-item[data-session-id="mock-session-another"]');
    await expect(row.locator('[data-testid="unread-mark"]')).toHaveText('未读');

    // 另一台设备读了它：只动服务端共享位点，本机 DOM 与 localStorage 都还停在「未读」
    await page.request.post('/__arm-read-elsewhere?sessionId=mock-session-another');

    // 断线重连，用户全程停在首页没动过任何东西
    await page.context().setOffline(true);
    await waitUntilDisconnected(page);
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitUntilConnected(page);

    // 已经画出来的那一行必须跟着灭掉
    await expect(row.locator('[data-testid="unread-mark"]')).toHaveCount(0);

    // 对照：同工作区里没被别人读过的那一行仍然亮——否则「重连后把首页所有 chip 都抹掉」也能变绿
    const stillUnread = page.locator('#dashRecentsList .dash-recent-item[data-session-id="mock-session-another-done"]');
    await expect(stillUnread.locator('[data-testid="unread-mark"]')).toHaveText('未读');

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

  // O86：注册表没有自报（终端只往 transcript 落定消息，或 CLI 版本不写 ~/.claude/sessions）时，服务端
  // 照样能从磁盘观测到外部驾驶、给当前查看的会话上只读镜像锁。此前抽屉那一行只认注册表，被锁住的会话
  // 和普通「已打开」长得一样，只能逐个点进去看输入框。疑似中断不补：那时没人在驾驶。
  test('P0-11ar 镜像锁住的会话行标终端驾驶态，疑似中断与解锁后撤掉', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const row = sessionRowByInstance(page, 'inst_1');
    const chip = row.locator('[data-session-status]');
    await expect(row).toBeVisible();
    await expect(chip).toHaveCount(0);

    await page.request.post('/__mirror-state?readonly=1');
    await expect(page.locator('#input')).toBeDisabled();
    await expect(chip).toHaveText('终端运行中');

    await page.request.post('/__mirror-state?readonly=1&waiting=1');
    await expect(chip).toHaveText('终端需要你');

    await page.request.post('/__mirror-state?readonly=1&stale=1');
    await expect(page.locator('#input')).toHaveAttribute('placeholder', /疑似中断/);
    await expect(chip).toHaveCount(0);

    await page.request.post('/__mirror-state?readonly=1');
    await expect(chip).toHaveText('终端运行中');
    await page.request.post('/__mirror-state?readonly=0');
    await expect(page.locator('#input')).toBeEnabled();
    await expect(chip).toHaveCount(0);

    // 别的会话行不受这把锁影响
    await expect(page.locator('[data-testid="session-row"]', { hasText: 'Deleted Remote Session' }).locator('[data-session-status]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  // 本会话自己的自主循环（ScheduleWakeup/CronCreate）写 transcript 也会上只读镜像锁，但那时没有终端在驾驶：
  // composer 会单独说明这个来源，抽屉行不能合成一个「终端运行中」。
  test('P0-11as 自主循环造成的镜像锁不在抽屉行冒充终端驾驶', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const row = sessionRowByInstance(page, 'inst_1');
    const chip = row.locator('[data-session-status]');
    await expect(row).toBeVisible();

    await page.request.post('/__mirror-state?readonly=1&autonomous=1');
    await expect(page.locator('#input')).toHaveAttribute('placeholder', /自主循环/);
    await expect(chip).toHaveCount(0);

    // 同一把锁换成终端驾驶时照常标出来，证明上面的 0 不是行没刷新
    await page.request.post('/__mirror-state?readonly=1');
    await expect(chip).toHaveText('终端运行中');

    await expectNoBrowserErrors(page);
  });

  // #289 方案 F：行上的注册表快照优先于镜像锁（镜像侧的 waiting 只认 cli，桌面端等审批时会被说成运行中、丢「需要你」），
  // 快照过时靠源头补——镜像锁真正转变时立刻 revalidate 那一行所在目录，不等 12 秒一轮的周期刷新。
  // 超时只给 4 秒：开抽屉时排下的那一轮周期刷新还远，等得到就说明是转变触发的那一次。
  // 周期刷新给所有工作区一起发 session:list，转变触发的只发 MAIN。默认 mock 只有一个工作区，两者分不开，
  // 所以先挂上第二个工作区：计数窗口里出现非 MAIN 的请求，就是撞上了周期刷新。
  const sessionListLog = async (page: Page): Promise<{ cwd: string; query: string }[]> => (await page.request.get('/__session-list-log')).json();
  const mainListsSince = async (page: Page, from: number) =>
    (await sessionListLog(page)).slice(from).filter(e => e.cwd === MAIN_WORKSPACE).length;
  // 返回做判断用的那份日志：后续计数要用同一份，再取一次可能已经混进新的一轮
  const expectNoPeriodicRefreshSince = async (page: Page, from: number) => {
    const log = await sessionListLog(page);
    expect(log.slice(from).filter(e => e.cwd !== MAIN_WORKSPACE), '撞上了 12s 周期刷新，计数无效').toEqual([]);
    return log;
  };
  const openSidebarWithSecondWorkspace = async (page: Page) => {
    await sendChatMessage(page, 'test:scroll-replay-setup'); // 只广播 instances（ANOTHER 多一个实例），不产生 busy/result
    await openSessionsSidebar(page);
    await expect(workspaceRow(page, ANOTHER_WORKSPACE)).toBeVisible();
    // 开抽屉那一轮给 ANOTHER 的请求落进日志后再取基线，免得它被算进后面的窗口
    await expect.poll(async () => (await sessionListLog(page)).some(e => e.cwd === ANOTHER_WORKSPACE)).toBe(true);
  };

  test('P0-11at 镜像锁转变时立即刷新那一行的目录，换上注册表给的态与来源', async ({ page }) => {
    await gotoMock(page);
    await page.request.post('/__viewing-row-registry?terminal=alive&source=claude-desktop');
    await openSidebarWithSecondWorkspace(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const row = sessionRowByInstance(page, 'inst_1');
    const chip = row.locator('[data-session-status]');
    // 前置：快照是「桌面端开着、空闲」，没有 chip
    await expect(row).toContainText('桌面端已打开');
    await expect(chip).toHaveCount(0);

    const before = (await sessionListLog(page)).length;
    // 桌面端开跑：注册表先变，镜像锁随后推到（mock 的 session:list 只在被拉时才给出新态）
    await page.request.post('/__viewing-row-registry?terminal=busy&source=claude-desktop');
    await page.request.post('/__mirror-state?readonly=1');
    await expect(page.locator('#input')).toBeDisabled();
    await expect.poll(() => mainListsSince(page, before), { timeout: 4000 }).toBeGreaterThan(0);
    await expectNoPeriodicRefreshSince(page, before);
    // 来源是注册表给的桌面端，不是镜像锁推断出来的「终端」
    await expect(chip).toHaveText('桌面端运行中', { timeout: 4000 });

    // 回合结束：注册表先回到空闲，锁随后撤掉。锁消失后 mirrorRowLock() 是 null，
    // 只能按变化前那把锁的 sessionId 找到这一行；找不到就不刷新，chip 停在快照里的「运行中」。
    await page.request.post('/__viewing-row-registry?terminal=alive&source=claude-desktop');
    const beforeRelease = (await sessionListLog(page)).length;
    await page.request.post('/__mirror-state?readonly=0');
    await expect(page.locator('#input')).toBeEnabled();
    await expect.poll(() => mainListsSince(page, beforeRelease), { timeout: 4000 }).toBeGreaterThan(0);
    await expectNoPeriodicRefreshSince(page, beforeRelease);
    await expect(chip).toHaveCount(0, { timeout: 4000 });

    await expectNoBrowserErrors(page);
  });

  test('P0-11au 字段不变的重复镜像广播不额外发 session:list', async ({ page }) => {
    await gotoMock(page);
    await openSidebarWithSecondWorkspace(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const chip = sessionRowByInstance(page, 'inst_1').locator('[data-session-status]');
    await expect(sessionRowByInstance(page, 'inst_1')).toBeVisible();

    // 锁出现：一次真转变，等它触发的那一轮落进日志，作为基线
    const before = (await sessionListLog(page)).length;
    await page.request.post('/__mirror-state?readonly=1');
    await expect(chip).toHaveText('终端运行中');
    await expect.poll(() => mainListsSince(page, before), { timeout: 4000 }).toBeGreaterThan(0);
    const base = (await sessionListLog(page)).length;

    // 同一把锁再推一次（倒计时之类的重复广播），紧接着一次真转变（waiting）当栅栏。chip 换成「终端需要你」时，
    // 栅栏那次 session:list 已在同一个同步任务里发出（applyMirror 先刷 chip 再 revalidate），重复广播若也触发过，
    // 在同一条 socket 上发得更早。但日志里两条长得一样，认不出哪条是栅栏的；所以之后再从这条 socket 发一个
    // 认得出的哨兵（MAIN 的搜索请求）：哨兵落进日志时，排在它前面的必然都已被 mock 处理，数哨兵之前的即可。
    await page.request.post('/__mirror-state?readonly=1');
    await page.request.post('/__mirror-state?readonly=1&waiting=1');
    await expect(chip).toHaveText('终端需要你');
    const sentinel = 'p0-11au-sentinel';
    await workspaceRow(page, MAIN_WORKSPACE).locator('xpath=following-sibling::*[1]').getByTestId('session-search').fill(sentinel);
    await expect.poll(async () => (await sessionListLog(page)).some(e => e.query === sentinel), { timeout: 4000 }).toBe(true);
    const log = await expectNoPeriodicRefreshSince(page, before);
    const sentinelAt = log.findIndex(e => e.query === sentinel);
    expect(log.slice(base, sentinelAt).filter(e => e.cwd === MAIN_WORKSPACE)).toHaveLength(1);

    await expectNoBrowserErrors(page);
  });

  // 快照优先的方向守在渲染层：桌面端卡在审批上时，镜像侧推来的锁 waiting=0、非 stale（它只认 cli 注册表）。
  // 让锁压过快照，这一行就从「需要你」那一档（warning）掉成运行中（accent）。锁出现照样触发 revalidate，
  // mock 下一次 session:list 仍给 waiting/claude-desktop，所以正确实现下这一档从头到尾不变。
  test('P0-11av 镜像锁出现不压过行上快照：桌面端等审批时仍是「需要你」那一档', async ({ page }) => {
    await gotoMock(page);
    await page.request.post('/__viewing-row-registry?terminal=waiting&source=claude-desktop');
    await openSidebarWithSecondWorkspace(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    const chip = sessionRowByInstance(page, 'inst_1').locator('[data-session-status]');
    await expect(chip).toHaveClass(/\btext-warning\b/); // 前置：快照就是 waiting

    const before = (await sessionListLog(page)).length;
    await page.request.post('/__mirror-state?readonly=1');
    await expect(page.locator('#input')).toBeDisabled();
    await expect.poll(() => mainListsSince(page, before), { timeout: 4000 }).toBeGreaterThan(0);
    await expectNoPeriodicRefreshSince(page, before);
    await expect(chip).toHaveClass(/\btext-warning\b/);
    await expect(chip).not.toHaveClass(/\btext-accent\b/);

    await expectNoBrowserErrors(page);
  });

  // 2026-09-06：外部驾驶员不只有终端。桌面端 Code 模式（Claude.app 的 Code 标签）跑的是同一份
  // claude 二进制、写同一份 transcript，注册表条目自报 entrypoint=claude-desktop；2.1.260 时【不写 status】
  // （2.1.299 实测已自报 idle/busy/waiting）。
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

  // 长按会话行 → 标为未读 / 标为已读（2026-09-02）。触屏路径先只发 pointerdown——
  // 500ms 后由前端自己的计时器触发（web-first 断言等它到点，不用被门禁禁掉的 waitForTimeout）；
  // 桌面右键（contextmenu）走同一个入口。长按松手时浏览器仍会派发 click，必须被吞掉：触屏的 click
  // 按抬手位置命中，此时确认 sheet 已盖在行上，click 落在遮罩上会把 sheet 当场关掉（O101）。
  // 标记落 localStorage，刷新后仍在；只有再次打开该会话才清。
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
    // 抬手：pointerup 在行上，补发的 click 落在确认 sheet 的遮罩上——必须被吞掉，sheet 不能被它关掉
    await row.dispatchEvent('pointerup', { pointerId: 1, clientX: 120, clientY: 200 });
    await modal.dispatchEvent('click');
    await expect(modal).toHaveClass(/sheet-open/);
    await page.locator('#confirmOk').click();
    await expect(modal).not.toHaveClass(/sheet-open/);
    // 答完确认要回到抽屉看见那一行的新状态：确认 sheet 上的点击不算「点抽屉外面」（app.js 全局 click 收抽屉的豁免）
    await expectSidebarOpen(page);
    // 标记是原地重刷这一行，不重建节点（长按监听仍挂在原节点上）
    expect(await readSessionRowMarks(page, MAIN_WORKSPACE)).toContain('preserved');

    await expect(row.locator('[data-testid="unread-mark"]')).toHaveText('未读');
    await expect(row.locator('[data-session-head] > span').first()).toHaveClass(/font-semibold/);
    await expect(mainDir.locator('[data-testid="dir-unread"]')).toHaveText('1 未读');

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

  // 长按标未读的公共动作：桌面右键走与触屏长按同一个入口（见 P0-11ad）。
  async function markRowUnread(page: Page, sessionId: string) {
    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
    await expect(row).toBeVisible();
    await row.dispatchEvent('contextmenu');
    const modal = page.locator('#confirmModal');
    await expect(modal).toHaveClass(/sheet-open/);
    await expect(page.locator('#confirmOk')).toHaveText('标为未读');
    await page.locator('#confirmOk').click();
    await expect(modal).not.toHaveClass(/sheet-open/);
  }

  // P0-11aq（验收 O81）：一个文件夹超过 50 个会话时，「显示全部」只给前 50 个、更早的只能搜。
  // 现在显示全部之后还能「加载更多」，一页页往后拉；到了服务端上限再回落成「可用搜索查找」。
  test('P0-11aq 显示全部之后还能加载更多；到服务端上限后回落成搜索提示', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:history-overflow');
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await page.getByRole('button', { name: '显示全部会话…' }).click();

    const loadMore = page.getByTestId('session-load-more');
    await expect(loadMore).toBeVisible();
    await expect(loadMore).toContainText('还有 7 个');
    await expect(page.getByTestId('session-remaining-hint')).toHaveCount(0);
    await expect(page.locator('#sessionPanel')).not.toContainText('Overflow Older 1');

    await loadMore.click();
    await expect(sessionButtonByTitle(page, 'Overflow Older 1')).toBeVisible();
    await expect(sessionButtonByTitle(page, 'Overflow Older 4')).toBeVisible();
    await expect(loadMore).toHaveCount(0);
    await expect(page.getByTestId('session-remaining-hint')).toContainText('还有 3 个更早的会话');
    // 新拉到的更早会话接在原有行之后（时间序），不是插到前面
    const rowIds = () => page.locator('[data-testid="session-row"]').evaluateAll(rows => rows.map(r => r.getAttribute('data-session-id')));
    const ids = await rowIds();
    expect(ids.indexOf('mock-session-overflow-older-1')).toBeGreaterThan(ids.indexOf('mock-session-older-migration'));

    // 折叠再展开（缓存秒开 + 无条件 revalidate）：已加载的页数不能被打回第一页。缓存会先把行画出来，
    // 只看 DOM 判不出 revalidate 带没带页数，所以直接看折叠之后发出的 session:list。
    const listLog = async () => (await page.request.get('/__session-list-log')).json();
    const before = (await listLog()).length;
    await workspaceRow(page, MAIN_WORKSPACE).locator('button').first().click();
    await expandWorkspace(page, MAIN_WORKSPACE);
    await expect.poll(async () => {
      const sent = (await listLog()).slice(before)
        .filter((e: { cwd: string }) => e.cwd === MAIN_WORKSPACE)
        .map((e: { all: boolean; pages: number | null }) => `${e.all}:${e.pages}`);
      return sent.length > 0 && sent.every((x: string) => x === 'true:2');
    }).toBe(true);
    await expect(sessionButtonByTitle(page, 'Overflow Older 4')).toBeVisible();
    await expect(page.getByTestId('session-remaining-hint')).toContainText('还有 3 个更早的会话');

    await expectNoBrowserErrors(page);
  });

  // P0-11ao（2026-09-08）：session:list 按 limit 截断（默认 6 条），手动标「稍后再看」的会话滑出
  // 窗口就从抽屉里消失——标记还在 read-state 里，UI 上再也找不回来，而长按确认框刚承诺过
  // 「会一直显示未读，直到你再次打开它」。服务端现在把这些会话单独补回（ack 的 pinned 字段），
  // 前端渲染成「稍后再看」一组。验收 O81 起这一组排在本页之后（按时间它本来就更早），不再置顶。
  test('P0-11ao 手动标记的会话被 limit 挤出本页后，仍在列表里「稍后再看」组（排在本页之后）', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:history-overflow');
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);

    // 前置条件：截断态下这条确实不在列表里。少了这两句，用例在「服务端根本没截断」时也会绿。
    await expect(page.locator('#sessionPanel')).not.toContainText('Older Migration Session');
    await expect(page.getByTestId('session-pinned-head')).toHaveCount(0);

    await page.getByRole('button', { name: '显示全部会话…' }).click();
    await expect(sessionButtonByTitle(page, 'Older Migration Session')).toBeVisible();
    await markRowUnread(page, 'mock-session-older-migration');

    // 刷新回到截断态（「显示全部」是内存态，不落盘）——这正是缺陷现场：标记还在，承载它的行没了
    await page.reload();
    await waitUntilConnected(page);
    await openSessionsSidebar(page);
    const dirAfter = await expandWorkspace(page, MAIN_WORKSPACE);
    await expect(page.getByRole('button', { name: '显示全部会话…' })).toBeVisible();

    await expect(page.getByTestId('session-pinned-head')).toHaveText('稍后再看');
    const pinnedRow = page.locator('[data-testid="session-row"][data-session-id="mock-session-older-migration"]');
    await expect(pinnedRow).toBeVisible();
    // 按时间位置：本页的行在前，「稍后再看」组（小标 + 被补回的行）在后
    const order = await dirAfter.locator('xpath=following-sibling::*[1]').evaluate(el =>
      [...el.querySelectorAll('[data-testid="session-row"], [data-testid="session-pinned-head"]')]
        .map(n => (n.getAttribute('data-testid') === 'session-pinned-head' ? 'HEAD' : n.getAttribute('data-session-id'))));
    expect(order.indexOf('HEAD')).toBeGreaterThan(order.indexOf('mock-session-visual-test'));
    expect(order[order.indexOf('HEAD') + 1]).toBe('mock-session-older-migration');
    await expect(pinnedRow.locator('[data-testid="unread-mark"]')).toHaveText('未读');
    // 角标必须把这一行一起数进去：漏数就是反方向的同一个毛病——行亮着而角标说 0
    await expect(dirAfter.locator('[data-testid="dir-unread"]')).toHaveText('1 未读');

    await expectNoBrowserErrors(page);
  });

  // P0-11ap（2026-09-08）：抽屉列表按 lastUsedAt 降序排，未读判据是逐条独立的 lastUsedAt > seenAt——
  // 两条轴毫无关联，一条未读完全可能排在第 30 行。角标此前是纯展示的 span：准确报出「有 N 条未读」，
  // 却答不了「在哪」（真机报告：顶栏说 4 条、首屏一条都看不见）。
  test('P0-11ap 目录头「N 未读」角标可点：依次跳到下一条未读行，且不折叠目录', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    const mainDir = await expandWorkspace(page, MAIN_WORKSPACE);
    await markRowUnread(page, 'mock-session-archived');
    await markRowUnread(page, 'mock-session-gap');

    const badge = mainDir.locator('[data-testid="dir-unread"]');
    await expect(badge).toHaveText('2 未读');
    const archived = page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]');
    const gap = page.locator('[data-testid="session-row"][data-session-id="mock-session-gap"]');

    await badge.click();
    await expect(archived).toHaveClass(/drawer-row-flash/);
    await expect(gap).not.toHaveClass(/drawer-row-flash/);
    // 角标嵌在展开/折叠按钮里：不 stopPropagation 的话，点「跳到未读」的结果是把目录整个折叠起来
    await expect(page.getByTestId('session-pinned-head').or(archived)).toBeVisible();

    // 第二次点：轮到下一条。只跳第一条的话，散在列表里的其余未读永远够不着
    await badge.click();
    await expect(gap).toHaveClass(/drawer-row-flash/);

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
});
