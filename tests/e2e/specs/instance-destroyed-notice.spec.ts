// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { MAIN_WORKSPACE, chooseSessionMenuItem, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession, sessionRowByInstance } from '../../helpers/sidebar-ui';

// 修「点击在跑的会话的停止按钮时，点完会顿一下，然后直接跳到主页」：中断失败（不限时超时——任何
// 原因 SDK interrupt() reject 都会走 app/src/agent/agent.js settleForce() 强杀子进程，见
// tests/unit/agent-control.test.mjs）→ 子进程退出 → onExit → 该 instanceId 从 agents Map 删除、
// 且无同 cwd 存活实例可回退（app/src/server/instance-routing.js reselectViewingTarget 默认
// allowCrossWorkspace=false）→ viewingInstanceId 广播为 null。前端旧逻辑把"viewingInstanceId 变
// null"一律当作该显示空表面(home/compose)处理，导致用户刚点停止就被静默弹回主页，看不到任何反馈。
//
// 修复：app/public/js/logic.js 新增 wasViewingInstanceDestroyed 纯函数，区分"正在查看的实例真的被摧毁"
// 与"用户主动导航离开"（返回主页/新建会话/切到其他会话——这些场景 viewingInstanceId 同样会变化，
// 但原实例仍在 instances 列表里，或者有下一个可看的目标，不应误判）；resolveEmptySurface 新增
// 'destroyed' 返回值（优先于 home/compose/none），bindView 命中时渲染专属提示
// （data-testid="instance-destroyed-surface"），不自动跳转，交由用户手动点「回首页」/「新建会话」。
//
// mock 场景 test:instance-destroyed（tests/e2e/mock/scenarios/status.js）直接构造这个广播终态，
// 不需要真的走完整 SDK abort 链路（那是 agent.js 的既有职责，已有单测覆盖）。
test.describe('P0 停止在跑会话后误跳主页（回归修复）', () => {
  test('P0-DESTROY-1 核心场景：正在查看的实例被摧毁 → 显示"会话已中断"提示而非静默跳主页；点「回首页」可正常导航（非死胡同）', async ({ page }) => {
    await gotoMock(page);
    // 冷启动默认即 viewing inst_1（mock-session-visual-test）：一个"正在看的、存活的会话"。
    await expect(page.locator('[data-testid="home-dashboard"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="instance-destroyed-surface"]')).toHaveCount(0);

    await sendChatMessage(page, 'test:instance-destroyed');

    // 断言：出现"会话已中断"提示，而不是 dashboard 的欢迎语/最近会话列表。
    const destroyedSurface = page.locator('[data-testid="instance-destroyed-surface"]');
    await expect(destroyedSurface).toBeVisible({ timeout: 10_000 });
    await expect(destroyedSurface).toContainText('会话已中断');
    await expect(page.locator('[data-testid="home-dashboard"]')).toHaveCount(0);

    // 提示上有明确可点击的下一步入口（回首页 / 新建会话）。
    const homeBtn = page.locator('[data-testid="instance-destroyed-home"]');
    const newBtn = page.locator('[data-testid="instance-destroyed-new"]');
    await expect(homeBtn).toBeVisible();
    await expect(newBtn).toBeVisible();
    // 反向守卫（P0-DESTROY-6 引入「继续此会话」后）：单实例被摧毁（非 server 重启，广播不带
    // service.startedAt 变化）不该出现重启专属的「继续此会话」按钮——SDK 子进程被强杀后
    // 不能引导用户一键 resume（维护者已否决该场景的自动/快捷 resume）。
    await expect(page.locator('[data-testid="instance-destroyed-resume"]')).toHaveCount(0);

    // 点击后能正常导航到主页——不是死胡同。
    await homeBtn.click();
    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible({ timeout: 5_000 });
    await expect(destroyedSurface).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-DESTROY-1b 核心场景变体：提示上的「新建会话」按钮可正常导航到 compose 页', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:instance-destroyed');

    const destroyedSurface = page.locator('[data-testid="instance-destroyed-surface"]');
    await expect(destroyedSurface).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="instance-destroyed-new"]').click();
    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible({ timeout: 5_000 });
    await expect(destroyedSurface).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  // 反向场景（回归保护，防止这次改动误伤正常导航）：用户主动点 ＋ 新建会话——原实例（inst_1）仍在
  // instances 列表里，只是不再被查看，不该被误判为"被摧毁"。
  test('P0-DESTROY-2 反向场景：用户主动新建会话不应误判为摧毁', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnNew').click();

    await expect(page.locator('[data-testid="compose-surface"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="instance-destroyed-surface"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  // 反向场景：用户主动回首页——mock session:home 只清 viewingInstanceId，不动 instances 列表
  // （inst_1 仍存活），精确对应"曾在列表、现在仍在列表"这个不命中分支。
  test('P0-DESTROY-3 反向场景：用户主动回首页不应误判为摧毁', async ({ page }) => {
    await gotoMock(page);
    await page.locator('#btnHome').click();

    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="instance-destroyed-surface"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  // 反向场景：正常切换到另一个存活会话（viewingInstanceId 变成另一个非 null 的 id），不受影响。
  test('P0-DESTROY-4 反向场景：切换到另一个存活会话不应误判为摧毁', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expectSidebarClosed(page);

    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history.', { timeout: 10_000 });
    await expect(page.locator('[data-testid="instance-destroyed-surface"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  // 反向场景（额外发现，超出诊断给出的三个反例，见任务汇报「遗留风险」说明）：用户主动关闭自己
  // 正在查看的唯一会话（抽屉 ✕，无其它存活实例可回退）——服务端 disposeInstance 广播的形态与
  // "被摧毁"完全相同（viewingInstanceId 变 null + 该实例从列表消失），但这是用户自己确认过的操作，
  // 不该显示"会话已中断"。前端在点击时记录 explicitCloseInstanceId（app.js）供
  // wasViewingInstanceDestroyed 排除；本测试验证按钮真实点击路径（不止纯函数单测）。
  // server 重启误报修复：整机重启（常驻服务部署后重启是常规运维操作）时 agents Map/viewingInstanceId
  // 全部归零，重连后首条 instances 广播形态与「实例被单独摧毁」完全同构——修复前每次重启都弹
  // 「停止操作未能正常结束」（用户根本没点停止，纯误导）。区分信号 = 广播恒带的 service.startedAt
  //（进程级常量，重启必变），前端 detectServerRestart（app/public/js/logic.js）识别后换准确文案 +
  // 「继续此会话」一键重开（走既有 session:switch 打开路径；不自动切换，尊重「重启后不自动
  // session:switch」的既有产品决策——按钮是用户主动点的）。
  test('P0-DESTROY-6 server 重启：显示「服务已重启」提示 + 「继续此会话」按钮，而非误导性的停止失败文案', async ({ page }) => {
    await gotoMock(page);
    await expect(page.locator('[data-testid="instance-destroyed-surface"]')).toHaveCount(0);

    await sendChatMessage(page, 'test:server-restart');

    const destroyedSurface = page.locator('[data-testid="instance-destroyed-surface"]');
    await expect(destroyedSurface).toBeVisible({ timeout: 10_000 });
    // 准确文案：说的是「服务已重启」，不是「停止操作未能正常结束」（用户没点停止）。
    await expect(destroyedSurface).toContainText('服务已重启');
    await expect(destroyedSurface).not.toContainText('停止操作未能正常结束');
    await expect(destroyedSurface).not.toContainText('会话已中断');
    // 三个入口都在：继续此会话（重启专属）/ 回首页 / 新建会话。
    await expect(page.locator('[data-testid="instance-destroyed-resume"]')).toBeVisible();
    await expect(page.locator('[data-testid="instance-destroyed-home"]')).toBeVisible();
    await expect(page.locator('[data-testid="instance-destroyed-new"]')).toBeVisible();
    // 不自动跳转：仍停在提示页，没有静默变成 dashboard。
    await expect(page.locator('[data-testid="home-dashboard"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-DESTROY-6b server 重启后点「继续此会话」→ 走 session:switch 重开原会话，回到之前的聊天内容', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:server-restart');

    const destroyedSurface = page.locator('[data-testid="instance-destroyed-surface"]');
    await expect(destroyedSurface).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="instance-destroyed-resume"]').click();
    // 重开成功：提示页消失，回到原会话——重启前发出的那条消息气泡（test:server-restart）重新可见
    //（DOM 缓存秒恢复或磁盘 history 回填，两条路径都以「用户能看到之前的内容」为准）。
    await expect(destroyedSurface).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('test:server-restart');
    await expect(page.locator('[data-testid="home-dashboard"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  // 验收 O60 后一半：进程异常退出的提示，切走再切回就不见了，看起来像什么都没发生。重开该会话走清屏全量
  // 重载时，历史从磁盘重画，transcript 里没有这句提示。mock 的 test:process-crash 发出带 processExited 的
  // error、摘掉实例，并让重开后的头一次 sync:since 报磁盘 ahead，逼出这条重载路径。
  test('P0-DESTROY-CRASH 进程异常退出后重开该会话 → 历史重画完仍看得到那条崩溃提示，且只有一条', async ({ page }) => {
    await gotoMock(page);
    // 用有磁盘历史的会话：重开后能看出 DOM 是从磁盘重画的，而不是 DOM 缓存原样恢复
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history.');
    await sendChatMessage(page, 'test:process-crash');
    const crashText = 'Claude Code process terminated by signal SIGKILL';
    const destroyedSurface = page.locator('[data-testid="instance-destroyed-surface"]');
    await expect(destroyedSurface).toBeVisible({ timeout: 10_000 });

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expect(destroyedSurface).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history.');
    // 走的是清屏全量重载：磁盘历史里没有崩溃前发的那条命令，DOM 缓存原样恢复的话它会一直在
    await expect(page.locator('#messages')).not.toContainText('test:process-crash');
    await expect(page.locator('#messages')).toContainText(crashText);
    await expect(page.locator('#messages')).toContainText('这个会话上次异常退出');
    await expect(page.locator('#messages [data-crash-notice]')).toHaveCount(1);

    await expectNoBrowserErrors(page);
  });

  // 验收 O121：进程被 kill 后「会话已中断」面只有通用文案，原因（SIGKILL 等）要点回该会话才看得到——
  // 表面一出来就清空了消息流，那条红字错误跟着没了。原因此刻已经到了（error 先于摘实例的广播），当场带上。
  test('P0-DESTROY-REASON 进程异常退出 →「会话已中断」面当场写出原因，不再说是停止操作没结束', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history.');
    await sendChatMessage(page, 'test:process-crash');
    const destroyedSurface = page.locator('[data-testid="instance-destroyed-surface"]');
    await expect(destroyedSurface).toBeVisible({ timeout: 10_000 });
    await expect(destroyedSurface.getByTestId('instance-destroyed-reason'), '原因没写在中断面上').toContainText('terminated by signal SIGKILL');
    await expect(destroyedSurface, '这不是停止操作引起的，那句说明是错的').not.toContainText('停止操作未能正常结束');
    await expectNoBrowserErrors(page);
  });

  test('P0-DESTROY-REASON2 刚切进会话、回放缓冲还开着时进程崩溃 → 中断面仍写出原因', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:arm-sync-ack-timeout-crash');
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Timeline Session');
    const destroyedSurface = page.locator('[data-testid="instance-destroyed-surface"]');
    await expect(destroyedSurface).toBeVisible({ timeout: 10_000 });
    await expect(destroyedSurface.getByTestId('instance-destroyed-reason'), '排在回放缓冲里的崩溃原因被切视图一起丢了').toContainText('terminated by signal SIGKILL');
    await expectNoBrowserErrors(page);
  });

  test('P0-DESTROY-REASON3 新开的进程还没有会话 id 就崩溃 → 中断面仍写出原因', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history.');
    await sendChatMessage(page, 'test:process-crash-before-init');
    const destroyedSurface = page.locator('[data-testid="instance-destroyed-surface"]');
    await expect(destroyedSurface).toBeVisible({ timeout: 10_000 });
    await expect(destroyedSurface.getByTestId('instance-destroyed-reason'), '没有会话 id 的实例崩溃，原因没地方记').toContainText('terminated by signal SIGKILL');
    await expect(destroyedSurface).not.toContainText('停止操作未能正常结束');
    await expectNoBrowserErrors(page);
  });

  test('P0-DESTROY-5 反向场景：用户主动关闭自己正在看的唯一会话 → 正常回落主页，不误判为摧毁', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);

    const row = sessionRowByInstance(page, 'inst_1');
    await chooseSessionMenuItem(page, row, 'close');
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click();

    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="instance-destroyed-surface"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });
  // PR #245 review：崩溃过的会话重开走分块重载；渲染途中切到别的会话时，renderHistoryBubbles 为了放行历史闸
  // 照样调 onDone，而补崩溃提示的那一步不看视图是否还在——旧会话的崩溃提示被补进新会话（并可能随之进缓存）。
  test('P0-DESTROY-CRASH2 重开崩溃过的长会话、渲染途中切走 → 崩溃提示不跟到新会话里', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expect(page.locator('#messages')).toContainText('Long history final message marker', { timeout: 15_000 });
    await sendChatMessage(page, 'test:process-crash');
    await expect(page.locator('[data-testid="instance-destroyed-surface"]')).toBeVisible({ timeout: 10_000 });

    // 分块调度改成排队不执行：渲染确定性地停在第一块之后，切走后再由用例手动把队列跑空（同 long-history-render 的 P0-LH3）。
    // 不用定时器放慢：被打断的那一块什么时候跑、跑没跑完，就成了和用例读状态赛跑（dev 的 push CI 红过 3 次）
    await page.evaluate(() => {
      const w = window as unknown as { __idleQueue: IdleRequestCallback[] };
      w.__idleQueue = [];
      window.requestIdleCallback = ((fn: IdleRequestCallback) => w.__idleQueue.push(fn)) as typeof window.requestIdleCallback;
    });
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Long History Session');
    await expect(page.locator('[data-testid="instance-destroyed-surface"]')).toHaveCount(0, { timeout: 10_000 });
    // 历史已回包、分块渲染进行中：提示条在，但 frag 要画完才一次性插入，最后一条还看不到
    // 提示文案随历史总数变（dev 上没加载全时是「仅显示最近 2000 条历史消息（共 N 条）」），只认共有的那段
    await expect(page.locator('#messages')).toContainText('2000 条历史消息', { timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __idleQueue: unknown[] }).__idleQueue.length), '前提：下一块已排队').toBeGreaterThan(0);
    await expect(page.locator('#messages'), '前提：切走时渲染还没画完').not.toContainText('Long history final message marker');
    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Archived Planning Session');
    await expect(page.locator('#messages')).toContainText('Archived plan replay from session history.', { timeout: 10_000 });
    // 现在才放行被打断的那一块：它发现视图已切走、调 onDone 收尾。跑到队列空为止，返回时收尾已同步做完
    const drained = await page.evaluate(() => {
      const q = (window as unknown as { __idleQueue: IdleRequestCallback[] }).__idleQueue;
      let n = 0;
      for (let fn = q.shift(); fn; fn = q.shift(), n += 1) fn({ didTimeout: true, timeRemaining: () => 0 } as IdleDeadline);
      return n;
    });
    expect(drained, '前提：被打断的那一块确实跑过').toBeGreaterThan(0);
    await expect(page.locator('#messages [data-crash-notice]'), '旧会话的崩溃提示被补进了新会话').toHaveCount(0);
    await expect(page.locator('#messages')).not.toContainText('Claude Code process terminated by signal SIGKILL');

    await expectNoBrowserErrors(page);
  });
});
