// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, expectSidebarClosed, openSessionsSidebar, openWorkspaceSession, sessionRowByInstance } from '../../helpers/p0-ui';

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
    // 不能引导用户一键 resume（机主已否决该场景的自动/快捷 resume）。
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
  // server 重启误报修复：整机重启（常驻服务部署后重启是机主的常规操作）时 agents Map/viewingInstanceId
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

  test('P0-DESTROY-5 反向场景：用户主动关闭自己正在看的唯一会话 → 正常回落主页，不误判为摧毁', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);

    const row = sessionRowByInstance(page, 'inst_1');
    await row.locator('button', { hasText: '✕' }).click();
    await expect(page.locator('#confirmModal')).toBeVisible({ timeout: 3_000 });
    await page.locator('#confirmOk').click();

    await expect(page.locator('[data-testid="home-dashboard"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="instance-destroyed-surface"]')).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });
});
