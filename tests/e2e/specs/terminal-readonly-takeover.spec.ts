// helpers: tests/helpers/playwright.ts
// 终端只读追平锁、接管排队与强制续接；2026-10-25 按主题从 task-progress.spec.ts 拆出，横幅与详情面板留在那边。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import {
  ANOTHER_WORKSPACE,
  expandWorkspace,
  expectSidebarClosed,
  openSessionByTitle,
  openSessionsSidebar,
  openWorkspaceSession,
  sessionButtonByTitle
} from '../../helpers/sidebar-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
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

    // 后两态由用例显式推进，不再等 mock 的定时窗口。原实现是 delay(1500)→stale→delay(5000)→解锁，
    // 于是这条用例得在那 5 秒内点完 tile、等到「设置已冻结」、再断言两次——谁快谁慢取决于机器。
    // 窗口早先是 1500ms、因同样的原因被调宽到 5000ms；2026-09-12 e2e 接进 4 分片并行后 CPU 争抢又让
    // 5000ms 不够用，dev 与当时在审的 PR 双双【稳定】红在下面这条 toBeEnabled（retry 也红）。
    // 显式推进之后没有窗口可赌，用例还快了约 6.5 秒。测的东西没变：产品侧「自动解锁」是服务端释放
    // 镜像锁的行为，这里验的始终是前端【收到 mirror_state 之后】怎么反应，与事件何时到达无关。
    await page.request.post('/__mirror-state?readonly=1&stale=1');
    await expect(page.locator('#input')).toHaveAttribute('placeholder', /疑似中断/, { timeout: 5_000 });

    await page.request.post('/__mirror-state?readonly=0&stale=0&withResult=1');
    await expect(page.locator('#input')).toBeEnabled({ timeout: 5_000 });
    await waitForIdle(page);

    await expectNoBrowserErrors(page);
  });
});
