// helpers: tests/helpers/playwright.ts
// 后台任务横幅与详情面板；终端只读锁与接管在 terminal-readonly-takeover.spec.ts（2026-10-25 按主题从本文件拆出）。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import {
  ANOTHER_WORKSPACE,
  expandWorkspace,
  expectSessionStatusChip,
  openSessionsSidebar,
  sessionRowByInstance,
  startNewSessionInWorkspace,
  workspaceRow
} from '../../helpers/sidebar-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-17 后台 task_progress 横幅原地刷新', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:taskprogress 后出现后台任务进度横幅。
    await sendChatMessage(page, 'test:taskprogress');
    await expect(page.locator('#taskProgressBanner')).toBeVisible();
    // mock 是单条 local_agent：标题「子代理」，状态「运行中」；步骤明细在任务列表行
    await expect(page.locator('#taskBannerLabel')).toHaveText('子代理');
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

  test('P0-17e 后台 task_progress 不污染当前会话但保留忙碌角标', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:background-taskprogress');
    await waitForIdle(page);

    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#taskProgressBanner')).toBeHidden();
    await expect(page.locator('#messages')).not.toContainText('另一个工作区正在运行后台任务');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('aria-label', '运行中');
    await expect(page.locator('#sessionsDot')).toHaveAttribute('title', '其他文件夹 · 运行中');

    await openSessionsSidebar(page);
    const backgroundDir = workspaceRow(page, ANOTHER_WORKSPACE);
    await expect(backgroundDir.locator('.dir-badge')).toHaveText('运行中');
    await expect(backgroundDir.locator('.dir-badge')).toHaveAttribute('aria-label', '运行中');
    await expandWorkspace(page, ANOTHER_WORKSPACE);
    await expectSessionStatusChip(page, 'inst_2', '运行中');

    await expectNoBrowserErrors(page);
  });

  test('P0-17j 多任务后台横幅默认折叠，点击横幅头行可展开/收起', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:taskprogress-multi');
    await expect(page.locator('#taskProgressBanner')).toBeVisible();
    // mock 是 2 local_agent + 1 local_bash：头行报构成，不再写「3 个运行中」
    await expect(page.locator('#taskBannerLabel')).toHaveText('运行中');
    await expect(page.locator('#taskProgressText')).toContainText('2 个子代理 · 1 条命令', { timeout: 10_000 });

    // 默认折叠：行已渲染在 DOM（供断言/无障碍），但列表容器不可见。
    // 折叠热区是整条头行（#taskBannerToggle），尾随 #taskBannerChevron 作 ▸/▾；右侧「停止」在多任务下隐藏（每行自带「停」）。
    const toggle = page.locator('[data-testid="bg-task-toggle"]');
    await expect(page.locator('[data-testid="task-stop-btn"]')).toBeHidden();
    const list = page.locator('[data-testid="bg-task-list"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toBeHidden();
    await expect(page.locator('[data-testid="bg-task-row"]')).toHaveCount(3);

    // 点开：组头按种类（子代理→后台命令），行也按组走——快照里 bash 更靠前，不得仍排第一。
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(list).toBeVisible();
    const rows = page.locator('[data-testid="bg-task-row"]');
    await expect(rows.first()).toBeVisible();
    await expect(page.locator('[data-testid="bg-task-group"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="bg-task-group"]').nth(0)).toHaveText('子代理');
    await expect(page.locator('[data-testid="bg-task-group"]').nth(1)).toHaveText('后台命令');
    await expect(rows.nth(0)).toContainText('Explore');
    await expect(rows.nth(1)).toContainText('Synthesize');
    await expect(rows.nth(2)).toContainText('npm test');

    // 组头不是任务行：点了不得展开详情。
    await page.locator('[data-testid="bg-task-group"]').nth(0).click();
    await expect(page.locator('[data-testid="task-detail-panel"]')).toHaveCount(0);

    // 第一行是被提前的 Explore，不是快照第一的 bash。
    await rows.nth(0).click();
    await expect(page.locator('[data-testid="task-detail-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="task-detail-entry"]')).toContainText('Explore');

    // 行内「停」绑的是该行 id（mock 不回 ack，1.5s 兜底仍打「已请求停止」）。
    await expect(page.locator('[data-testid="bg-task-stop"]')).toHaveCount(3);
    await page.locator('[data-testid="bg-task-stop"]').first().click();
    await expect(page.locator('#messages')).toContainText('已请求停止后台任务', { timeout: 5_000 });

    // 再停同一条 → 真 server 的 agent.stopTask 会返回 false（任务已结束 / control_request 10s 超时），
    // 前端据 `res?.ok === true` 分流到橙色「停止请求未生效」。这一支此前在整套 E2E 里不可达：mock 的
    // task:stop handler 签名连 ack 参数都没有、从不回调，前端只能吃 1.5s 兜底、恒走灰色支——用户以为
    // 停掉了，而那一行任务仍挂在面板上。前端也没有任何单测碰这段（2026-09-07 补 mock 的 ack 后才可测）。
    await page.locator('[data-testid="bg-task-stop"]').first().click();
    const warnBar = page.locator('#messages .text-warning', { hasText: '停止请求未生效：任务可能已结束' });
    await expect(warnBar).toBeVisible({ timeout: 5_000 });

    // 再点收起。
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toBeHidden();

    await waitForIdle(page);
    await expect(page.locator('#taskProgressBanner')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // B2（2026-09-07）：后台任务完成后从完成条读 CLI 落盘的 stdout。
  // 入口刻意挂在【消息流的完成条】而非任务面板——面板在没有活任务时整个隐藏，
  // 而「跑完了回头看输出」恰恰发生在那个时刻。
  test('P0-17p 后台任务完成条可展开查看 CLI 输出，再点收起', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:taskprogress');

    // 等任务跑完：完成条落进消息流，且带「查看输出」入口（mock 的 task_notification 带 outputFile）
    const btn = page.locator('[data-testid="bg-task-output"]');
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await waitForIdle(page);
    // 横幅此时已撤下——正是这个入口存在的理由
    await expect(page.locator('#taskProgressBanner')).toBeHidden();

    // 点开 → 读到 mock 的输出正文。断言【可见性】而不是 textContent：收起用的是 hidden 类，
    // 文本仍留在 DOM 里，用 not.toContainText 判收起会恒绿（本仓踩过的坑）。
    const outBody = page.locator('[data-testid="bg-task-output-body"]');
    await expect(outBody).toBeHidden();
    await btn.click();
    await expect(outBody).toBeVisible({ timeout: 10_000 });
    await expect(outBody).toContainText('MOCK_TASK_OUTPUT_LINE');
    await expect(outBody).toContainText('=== e2e finished ok ===');

    // 再点 → 收起（不是一次性展开）
    await btn.click();
    await expect(outBody).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // 运行中看输出（对齐终端 /tasks 详情页）。这条守真 DOM 上才看得见的东西：行怎么展开、输出不被当 HTML、
  // 滚动跟随、手机宽度不横向溢出、visibilitychange 真接在 document 上。隐藏期间不轮询、单飞这些时序在
  // tests/unit/frontend-task-live-output.test.mjs 用假定时器守；真 server 那一侧在 socket-task-output.test.mjs。
  test('P0-17v 运行中的后台命令展开就能看输出并持续刷新，子代理没有这个入口', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoMock(page);
    await sendChatMessage(page, 'test:taskoutput-running');

    await page.locator('#taskBannerToggle').click(); // 两个任务默认折叠
    const rows = page.locator('[data-testid="bg-task-row"]');
    const output = page.locator('[data-testid="bg-task-live-output"]');
    const list = page.locator('[data-testid="bg-task-list"]');

    await rows.filter({ hasText: 'Explore' }).click();
    await expect(page.locator('[data-testid="bg-task-expand"][aria-expanded="true"]')).toHaveCount(1);
    await expect(output).toHaveCount(0);

    await rows.filter({ hasText: 'npm run build' }).click();
    await expect(output).toBeVisible();
    await expect(output).toContainText('POLL_1_END');
    await expect(output).toContainText('…（仅显示末尾）');
    await expect(output).toContainText('<b>not html</b>');
    await expect(output.locator('b')).toHaveCount(0);

    // 没人操作也会刷新，最新一行在视野里（8 KiB 的输出比列表高，要看的是末尾）
    await expect(output).toContainText('POLL_2_END', { timeout: 6_000 });
    const tailInView = () => page.evaluate(() => {
      const bottom = (testid: string) => document.querySelector(`[data-testid="${testid}"]`)!.getBoundingClientRect().bottom;
      return bottom('bg-task-live-output') <= bottom('bg-task-list') + 1;
    });
    await expect.poll(tailInView).toBe(true);
    const overflow = await output.evaluate(el => el.scrollWidth - el.clientWidth);
    expect(overflow, '手机宽度下长行要换行，不能撑出横向滚动').toBeLessThanOrEqual(0);

    // 往上翻着看的时候不把人拽回末尾
    await list.evaluate(el => { el.scrollTop = 0; });
    await expect(output).toContainText('POLL_3_END', { timeout: 6_000 });
    expect(await list.evaluate(el => el.scrollTop)).toBe(0);

    // 回到前台不用等下一拍：上一拍刚落地，离下一拍还有约 3 秒，1 秒内出现新内容只可能来自 visibilitychange
    await page.evaluate(() => {
      for (const state of ['hidden', 'visible']) {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
        document.dispatchEvent(new Event('visibilitychange'));
      }
    });
    await expect(output).toContainText('POLL_4_END', { timeout: 1_000 });

    // 收起就没了
    await rows.filter({ hasText: 'npm run build' }).click();
    await expect(output).toHaveCount(0);

    await waitForIdle(page);
    await expect(page.locator('#taskProgressBanner')).toBeHidden();
    await expectNoBrowserErrors(page);
  });

  test('P0-17k 点击任务行展开详情面板显示进度历史，再次点击收起', async ({ page }) => {
    await gotoMock(page);

    // -hold 变体：同样 3 条 task_progress 心跳（两个变体走 mock 里同一段代码，只是末尾 delay 不同），
    // 但三拍之后长驻 8s 再收尾。必须用它：默认变体从「步骤 3/3」到 task_notification 撤横幅只有
    // 600ms，而下面是「点开 → 断言面板 → 断言 3 条历史 → 再点收起」的多步联动，600ms 装不下——
    // 低负载下勉强挤得进所以一直是绿的，2026-09-07 把 E2E 并发提到 8 分片后当场暴露：
    // locator.click 等不到元素 stable，45s 超时。同文件的 P0-17m / P0-17n 一直用的就是 -hold。
    await sendChatMessage(page, 'test:taskprogress-hold');
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

  test('P0-17n 折叠热区可键盘操作，且「停止」按钮上的 Enter 不连带折叠', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:taskprogress-hold');
    await expect(page.locator('#taskProgressBanner')).toBeVisible();
    await expect(page.locator('[data-testid="bg-task-row"]')).toContainText('步骤 3/3', { timeout: 10_000 });

    const toggle = page.locator('[data-testid="bg-task-toggle"]');
    const list = page.locator('[data-testid="bg-task-list"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // 折叠热区是 role="button" 的 div，没有原生键盘语义，Enter/Space 全靠自己接
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toBeHidden();

    await toggle.press(' ');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(list).toBeVisible();

    // 「停止」是热区的**兄弟**而非后代：聚焦它按 Enter 只触发停止，不得连带折叠。
    // 反向验证过（把按钮挪进热区内部）这条会红，且后果比"连带折叠"更重：热区 keydown 里的
    // preventDefault() 会把原生 button 的 Enter→click 激活整个吃掉，「停止」根本发不出去——
    // 所以下面这条先炸的是「已请求停止后台任务」缺失。看到它红，先查 index.html 的父子结构。
    const stopBtn = page.locator('[data-testid="task-stop-btn"]');
    await expect(stopBtn).toBeVisible();
    await stopBtn.press('Enter');
    // 停止确实发出（mock 不回 ack，前端 1.5s 兜底写完成条）——以它为时序锚点，再断言折叠态没被连带翻转
    await expect(page.locator('#messages')).toContainText('已请求停止后台任务', { timeout: 5_000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(list).toBeVisible();

    await waitForIdle(page);
    await expectNoBrowserErrors(page);
  });

  // 转后台（#459，终端 Ctrl+B）。mock 的 test:fg-task 起一条前台 Bash 挡着本轮；转后台成功后照 CLI 的次序
  // 回事件：前台集合清空 → 进后台任务横幅 → 工具卡收到「running in background」→ 本轮收尾。
  test('P0-17q 前台命令挡着本轮时出「转后台」，点了整轮转后台、横幅接住', async ({ page }) => {
    await gotoMock(page);

    const composerBtn = page.locator('[data-testid="btn-background-tasks"]');
    await expect(composerBtn).toBeHidden();
    await sendChatMessage(page, 'test:fg-task');
    const card = page.locator('details.toolcard[data-tool-name="Bash"]');
    await expect(composerBtn).toBeVisible();
    await expect(card.locator('[data-testid="tool-background"]')).toBeVisible();

    await composerBtn.click();
    await expect(page.locator('#taskProgressBanner')).toBeVisible();
    await expect(page.locator('[data-testid="bg-task-row"]')).toContainText('sleep 120');
    await expect(composerBtn).toBeHidden();
    await expect(card.locator('[data-testid="tool-background"]')).toHaveCount(0);
    await expect(card).toContainText('running in background');
    // 点卡上的按钮不该顺手展开卡片；点输入条按钮更不该
    await expect(card).not.toHaveAttribute('open', '');

    await waitForIdle(page);
    await expectNoBrowserErrors(page);
  });

  test('P0-17r 工具卡上的「后台运行」只转这一条，且不连带展开卡片', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:fg-task');
    const card = page.locator('details.toolcard[data-tool-name="Bash"]');
    const cardBtn = card.locator('[data-testid="tool-background"]');
    await expect(cardBtn).toBeVisible();
    await expect(card).not.toHaveAttribute('open', '');

    await cardBtn.click();
    await expect(page.locator('[data-testid="bg-task-row"]')).toContainText('sleep 120');
    await expect(cardBtn).toHaveCount(0);
    await expect(page.locator('[data-testid="btn-background-tasks"]')).toBeHidden();
    await expect(card).not.toHaveAttribute('open', '');

    await waitForIdle(page);
    await expectNoBrowserErrors(page);
  });

  test('P0-17t 「转后台」只跟着当前查看的会话：切走就藏，切回来还在', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:fg-task');
    const composerBtn = page.locator('[data-testid="btn-background-tasks"]');
    const cardBtn = page.locator('details.toolcard[data-tool-name="Bash"] [data-testid="tool-background"]');
    await expect(composerBtn).toBeVisible();
    await expect(cardBtn).toBeVisible();

    // 切到同工作区的新会话：那边没有前台任务
    await openSessionsSidebar(page);
    await startNewSessionInWorkspace(page, '/Users/you/code/claude-chat-mobile');
    await expect(composerBtn).toBeHidden();

    // 切回 inst_1：它的前台任务还挡着本轮，两处按钮都回来。＋ 进新会话页不留 DOM 缓存，切回走拉历史：
    // 卡从历史渲染、不进 toolCards 表，而且比 sync:since 补推的前台任务快照晚到——卡上那颗得在历史落地后
    // 按 DOM 找回来（#469 review）
    await openSessionsSidebar(page);
    await sessionRowByInstance(page, 'inst_1').click();
    await expect(composerBtn).toBeVisible();
    await expect(cardBtn).toBeVisible();
    await cardBtn.click();
    await expect(page.locator('[data-testid="bg-task-row"]')).toContainText('sleep 120');
    await expect(cardBtn).toHaveCount(0);

    await expectNoBrowserErrors(page);
  });

  test('P0-17s 会话禁用了后台任务：点「转后台」把原因写进消息流，按钮留着', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:fg-task-disabled');
    const composerBtn = page.locator('[data-testid="btn-background-tasks"]');
    await expect(composerBtn).toBeVisible();

    await composerBtn.click();
    await expect(page.locator('#messages')).toContainText('这个会话禁用了后台任务（CLAUDE_CODE_DISABLE_BACKGROUND_TASKS）');
    await expect(composerBtn).toBeVisible();
    await expect(composerBtn).toBeEnabled();
    await expect(page.locator('#taskProgressBanner')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  // 真机 2026-11-02：主轮已结束、只剩后台子代理在跑，每条子代理 delta 都把运行条从 0s 重新点亮，
  // 30s 后被快照自检清掉，下一条又亮——用户看到「✻ Working… (29s)」反复从头计时。
  test('P0-17u 主轮结束后后台子代理继续推流：运行条与停止钮不得重新出现', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:bg-subagent-after-result');
    // 正向对照：三种子代理事件都确实到了前端，否则下面的「没亮」可能只是事件没发出来
    const card = page.locator('[data-testid="subagent-card"]');
    await expect(card).toContainText('BG_SUBAGENT_THINKING', { timeout: 10_000 });
    await expect(card.locator('details.toolcard')).toContainText('Grep');
    await expect(card.locator('[data-testid="subagent-text"]')).toContainText('BG_SUBAGENT_TEXT');

    await expect(page.locator('#streamLiveStatus')).toHaveCount(0);
    await expect(page.locator('#btnSend')).not.toHaveAttribute('data-mode', 'stop');

    await expectNoBrowserErrors(page);
  });
});
