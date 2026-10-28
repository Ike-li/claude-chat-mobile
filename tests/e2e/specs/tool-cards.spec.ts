// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { captureBrowserErrors, ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle, waitUntilConnected } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar, openWorkspaceSession } from '../../helpers/sidebar-ui';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-05 工具调用卡片生命周期', async ({ page }) => {
    await gotoMock(page);

    // 1. 起始状态/假设：fresh state。发送 test:tool。
    await sendChatMessage(page, 'test:tool');
    await expect(page.locator('details.thinking')).toBeVisible();
    await expect(page.locator('details.toolcard')).toHaveCount(3, { timeout: 15_000 });
    // UX-002：收起态标题带 inputSummary，扫读可见操作对象
    await expect(page.locator('details.toolcard .t-name').nth(0)).toHaveText('read_file · utils/date.js');
    await expect(page.locator('details.toolcard .t-name').nth(1)).toHaveText('edit_file · utils/date.js');
    await expect(page.locator('details.toolcard .t-name').nth(2)).toHaveText('run_command · npm test');
    await expect(page.locator('#streamLiveStatus')).toBeVisible();

    // 2. 等待完成并展开第一个工具卡片。
    await waitForIdle(page);
    await page.locator('details.toolcard summary').first().click();
    await expect(page.locator('details.toolcard').first()).toHaveAttribute('open', '');
    await expect(page.locator('details.toolcard pre').first()).toContainText('utils/date.js');
    const st = page.locator('details.toolcard .t-status');
    await expect(st).toHaveCount(3);
    // 图标维与颜色维分开断：实测过只断 aria-label 时，把 setStatusIcon 的染色整段删掉这里照样绿
    for (let i = 0; i < 3; i++) {
      await expect(st.nth(i)).toHaveAttribute('aria-label', '成功');
      await expect(st.nth(i)).toHaveClass(/text-success/);
    }
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('All tools executed cleanly');

    await page.locator('details.toolcard summary').last().click();
    const fullOutputButton = page.locator('[data-testid="tool-expand-full"]');
    await expect(fullOutputButton).toBeVisible();
    await fullOutputButton.click();
    await expect(page.locator('details.toolcard').last()).toContainText('extra full lines from tool:full mock');

    await expectNoBrowserErrors(page);
  });

  // PR #250 review：全文超过服务端上限（512KiB）时 tool:full 只回开头并带 truncated。此前只渲染 res.text、随即
  // 撤掉按钮，用户看到的是一段不完整的输出，却没有任何标记，也没有别的办法拿到其余部分。
  test('P0-05-FULL-TRUNC 展开全文超过上限：说清只显示了开头和原长', async ({ page }) => {
    await gotoMock(page);
    await page.request.post('/__arm-tool-full-truncated');
    await sendChatMessage(page, 'test:tool');
    await expect(page.locator('details.toolcard')).toHaveCount(3, { timeout: 15_000 });
    await waitForIdle(page);
    await page.locator('details.toolcard summary').last().click();
    await page.locator('[data-testid="tool-expand-full"]').click();
    const card = page.locator('details.toolcard').last();
    await expect(card).toContainText('HEAD_OF_HUGE_OUTPUT');
    const note = card.locator('[data-testid="tool-full-truncated"]');
    await expect(note, '拿到的只是开头，不说清楚就像已经完整了').toBeVisible();
    await expect(note).toContainText('700000');
    await expectNoBrowserErrors(page);
  });

  test('P0-05b 工具结果乱序返回仍落到正确卡片', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tool-out-of-order');
    await expect(page.locator('details.toolcard')).toHaveCount(2, { timeout: 10_000 });
    await expect(page.locator('details.toolcard').nth(0)).toContainText('read_file');
    await expect(page.locator('details.toolcard').nth(1)).toContainText('run_command');

    await waitForIdle(page);
    await page.locator('details.toolcard summary').nth(0).click();
    await page.locator('details.toolcard summary').nth(1).click();
    await expect(page.locator('details.toolcard').nth(0)).toContainText('read_file result: config.json');
    await expect(page.locator('details.toolcard').nth(0)).not.toContainText('command result: npm run check');
    await expect(page.locator('details.toolcard').nth(1)).toContainText('command result: npm run check');
    await expect(page.locator('details.toolcard').nth(1)).not.toContainText('read_file result: config.json');
    const st2 = page.locator('details.toolcard .t-status');
    await expect(st2).toHaveCount(2);
    for (let i = 0; i < 2; i++) await expect(st2.nth(i)).toHaveAttribute('aria-label', '成功');

    await expectNoBrowserErrors(page);
  });

  test('P0-05c 工具执行中出错会收敛卡片并恢复输入', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tool-error');
    const failedCard = page.locator('details.toolcard').filter({ hasText: 'run_command' }).first();
    await expect(failedCard).toBeVisible();

    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('mock tool crashed');
    await expect(failedCard.locator('.t-status')).toHaveAttribute('aria-label', '出错');
    await expect(failedCard.locator('.t-status')).toHaveClass(/text-danger/);
    await failedCard.locator('summary').click();
    await expect(failedCard.locator('.t-out')).toContainText('mock tool crashed');

    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeEnabled();

    await expectNoBrowserErrors(page);
  });

  test('P0-05d 工具输出默认折叠并在展开后可见', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tool');
    const firstToolCard = page.locator('details.toolcard').filter({ hasText: 'read_file' }).first();
    await expect(firstToolCard).toBeVisible({ timeout: 15_000 });

    await waitForIdle(page);
    await expect(page.getByText('Successfully read 124 lines from utils/date.js')).toBeHidden();

    await firstToolCard.locator('summary').click();
    await expect(page.getByText('Successfully read 124 lines from utils/date.js')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-05e 子代理卡默认折叠且展开后显示嵌套输出', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:subagent');
    await waitForIdle(page);

    const card = page.locator('[data-testid="subagent-card"]');
    await expect(card).toHaveCount(1);
    await expect(card).not.toHaveAttribute('open', '');
    await expect(card.locator('.sa-title')).toContainText('code-reviewer');
    await expect(card.locator('.sa-title')).toContainText('已完成');
    await expect(card.locator('details.toolcard')).toHaveCount(1);
    await expect(card.locator('[data-testid="subagent-text"]')).toContainText('CSRF');
    await expect(page.locator('#messages > details.thinking.msg-frame')).toHaveCount(0);

    // 合卡：一次 Agent spawn 只留【一张】卡。旧行为是主流里通用工具卡（Agent · 描述）与
    // 子代理卡并排两张——数 subagent-card 恒等于 1，抓不到它，必须数主流里的通用工具卡。
    await expect(page.locator('#messages > details.toolcard')).toHaveCount(0);
    // 合卡不得吞掉 spawn 工具自己的输入与结果：子代理的最终报告原本挂在那张通用卡的 .t-out 上，
    // 合卡后必须落到聚合卡里，否则「少一张卡」是靠丢结论换来的。
    // 定位到聚合卡【自己】的槽位：嵌套工具卡也有 .t-in/.t-out，裸 class 会撞 strict mode。
    // 只显 description：真机 2026-09-10 这里原样铺了整个 input JSON（含用户刚打的整段 prompt），
    // 展开卡片先撞一坨。正反两条都要——只断"有 description"抓不到"顺带把 JSON 也铺了"。
    await expect(card.locator('> .t-in')).toHaveText('Review auth module');
    await expect(card.locator('> .t-in')).not.toContainText('subagent_type');
    await expect(card.locator('.t-full-host > .t-out')).toContainText('Subagent code-reviewer finished review.');
    // 用量按 toolUseId 从 task_progress 挂上来（第 2 批）。这条同时钉住「标完成时不能把用量抹掉」——
    // 标题的三条改写路径共用 renderSubagentTitle，漏带 usage 的那条会在这里红。
    await expect(card.locator('.sa-title')).toContainText('15 tools');
    await expect(card.locator('.sa-title')).toContainText('65.4k tok');
    // 单行动作槽：跑完撤下（留着最后一条工具名会让已完成的卡看起来还在动）
    await expect(card.locator('[data-testid="subagent-last-tool"]')).toBeHidden();

    await card.locator('summary').first().click();
    await expect(card).toHaveAttribute('open', '');
    await expect(card.locator('.sa-body')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-05j 运行中的子代理卡：折叠态就能看见用量与最近工具，不必展开', async ({ page }) => {
    await gotoMock(page);

    // 这个场景【停在运行中】（不发 tool_result/result），所以下面断的都是稳定终态，无需等待技巧
    await sendChatMessage(page, 'test:subagent-running');

    const card = page.locator('[data-testid="subagent-card"]');
    await expect(card).toHaveCount(1);
    await expect(card).not.toHaveAttribute('open', ''); // 折叠态——以下全都要在不展开的前提下可见
    await expect(card.locator('.sa-title')).toContainText('🤖 Explore 运行中');
    await expect(card.locator('.sa-title')).toContainText('3 tools');
    await expect(card.locator('.sa-title')).toContainText('1.2k tok');
    // 错误显性化：子工具真错误累进标题。本条咬住的是「失败被记在【标题】上」——
    // 注入「改写单行动作槽」会红。至于"为什么不记在单行槽"（心跳每隔几秒覆盖它一次），
    // 那是设计理由、由本场景的事件顺序体现（心跳排在失败之后），不是这条断言证明的。
    await expect(card.locator('.sa-title')).toContainText('❌ 1');
    // 失败的那张嵌套卡本身也是红的（statusIconSpec 按 kind 给语义色）
    await expect(card.locator('.sa-body [data-tool-name="Read"] .t-status')).toHaveClass(/text-danger/);

    // 底栏权责归位：这条任务已经有流内聚合卡，底栏不再重复显示它（真机同屏复读过）。
    // 注意判据是「有没有流内卡」——P0-05f 那条 Workflow 场景的 task_progress 不带 toolUseId，
    // 底栏照常显示，两条合起来才证明这不是"把横幅一刀关掉"。
    await expect(page.locator('#taskProgressBanner')).toBeHidden();

    const lastTool = card.locator('[data-testid="subagent-last-tool"]');
    await expect(lastTool).toBeVisible();
    // 类型前缀被剥掉：后端 message 是「Explore：扫描导入边界」，标题里已经有 Explore 了
    await expect(lastTool).toHaveText('↳ Grep: 扫描导入边界');

    await expectNoBrowserErrors(page);
  });

  test('P0-05f Workflow 子流建卡 + 后台任务全量列表（含单任务详情行）', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:workflow-subagents');
    // mock 推 2 条 local_agent task_progress → 标题「子代理」+「2 个运行中」；多任务默认折叠，点头行展开。
    await expect(page.locator('#taskProgressBanner')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#taskBannerLabel')).toHaveText('子代理');
    await expect(page.locator('#taskProgressText')).toContainText('2 个运行中');
    await expect(page.locator('#taskProgressText')).not.toContainText('后台任务 后台任务');
    const taskToggle = page.locator('[data-testid="bg-task-toggle"]');
    await expect(taskToggle).toBeVisible();
    await expect(page.locator('[data-testid="bg-task-list"]')).toBeHidden();
    await expect(page.locator('[data-testid="bg-task-row"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="bg-task-group"]')).toHaveCount(0);
    await taskToggle.click();
    await expect(page.locator('[data-testid="bg-task-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="bg-task-row"]').first()).toContainText('Explore');
    await expect(page.locator('[data-testid="bg-task-group"]')).toHaveCount(0);

    await waitForIdle(page);

    // Workflow 不预建空卡；有 parentToolUseId 子流时才出现折叠卡
    const card = page.locator('[data-testid="subagent-card"]');
    await expect(card).toHaveCount(1);
    // 【有意的例外，不是漏改】合卡只发生在「spawn 当场就建了聚合卡」的 Agent/Task 上。
    // Workflow 的聚合卡是等首条子流事件才懒建的（预建会留下「🤖 workflow 已完成」空壳），
    // 此时通用工具卡早已 append 进主流，再摘掉它要动已插入的时间分隔行。故 Workflow 维持两张卡。
    // 这条断言是为了让「Workflow 还没合」变成显式契约——哪天合了它会红，提醒同步改这里。
    await expect(page.locator('#messages > details.toolcard')).toHaveCount(1);
    await expect(card.locator('.sa-title')).toContainText('workflow');
    await expect(card.locator('[data-testid="subagent-text"]')).toContainText('Five search agents');
    await expect(card.locator('details.toolcard')).toHaveCount(1);

    await expectNoBrowserErrors(page);
  });

  test('P0-05g turn-end 文件变更汇总卡：已编辑 N 个文件 + 行统计', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:file-changes');
    await waitForIdle(page);

    const card = page.locator('[data-testid="turn-file-changes"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('已编辑 2 个文件');
    await expect(card).toContainText('+5');
    await expect(card).toContainText('-1');
    await expect(page.locator('[data-testid="turn-file-row"]')).toHaveCount(2);
    await expect(card).toContainText('CLAUDE.md');
    await expect(card).toContainText('README.md');
    // Read 不进汇总
    await expect(card).not.toContainText('package.json');

    await expectNoBrowserErrors(page);
  });

  test('P0-DIFF Edit 工具卡预览变更显示行级 diff（上下文行原样、只改动行标 -/+），Write 维持整块绿', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:file-changes');
    await waitForIdle(page);

    // Edit（t_fc_edit）：三行片段只中间一行变 → 行级 diff 应拆成 4 个独立 <pre>（同/删/增/同）。
    // 工具卡默认折叠（<details>），「预览变更」按钮在卡体内——须先展开卡片。
    const editCard = page.locator('[data-tool-name="Edit"]');
    await editCard.locator('summary').click();
    await editCard.locator('.tp-btn').click();
    const editBody = editCard.locator('.tp-body');
    await expect(editBody).toBeVisible();
    await expect(editBody.locator('pre')).toHaveCount(4);
    await expect(editBody).toContainText('line one');
    await expect(editBody).toContainText('- old middle');
    await expect(editBody).toContainText('+ new middle');
    await expect(editBody).toContainText('line three');

    // Write（t_fc_write）：无 old，维持既有「整块绿」——单个 <pre> 装全部新增内容，不逐行拆分。
    const writeCard = page.locator('[data-tool-name="Write"]');
    await writeCard.locator('summary').click();
    await writeCard.locator('.tp-btn').click();
    const writeBody = writeCard.locator('.tp-body');
    await expect(writeBody).toBeVisible();
    await expect(writeBody.locator('pre')).toHaveCount(1);
    await expect(writeBody.locator('pre')).toContainText('line1');
    await expect(writeBody.locator('pre')).toContainText('line3');

    await expectNoBrowserErrors(page);
  });

  // P0-DIFF-R（2026-09-07）：Read 类走 snippet 而非 diff（真 server 只在 toolInput.name === 'Read' 时带
  // 这个字段）。此前 mock 的 tool:preview 没有 t_fc_read 分支，它落到兜底的 ok:false —— 于是 app.js:2283
  // 那整段「图片→缩略图 / 文本→代码高亮」在整套 E2E 里不可达，前端也没有任何单测碰它。
  // 漏发时的形态特别隐蔽：ok:true 走不到错误支，用户点开只看到一行路径归属，下面空白且没有任何提示。
  // 场景侧的 t_fc_read tool_use 早就在发了（scenarios/content.js），只有 mock 的应答缺这一支。
  test('P0-DIFF-R Read 工具卡预览走 snippet：出代码块而不是 diff', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:file-changes');
    await waitForIdle(page);

    const readCard = page.locator('[data-tool-name="Read"]');
    await readCard.locator('summary').click();
    await readCard.locator('.tp-btn').click();
    const readBody = readCard.locator('.tp-body');
    await expect(readBody).toBeVisible();
    // 路径归属那行本来就有（不带 snippet 时也有），所以它证明不了什么——真正的判据是代码块出没出来
    await expect(readBody).toContainText('claude-chat-mobile / package.json');
    await expect(readBody.locator('pre code')).toContainText('"name": "claude-chat-mobile"');
    // Read 不是变更类：不得走 diff 渲染。判据用【结构】而非文本——上面的 Edit 用例里 renderToolDiff
    // 把三行片段拆成 4 个 <pre>（同/删/增/同），snippet 路径恒为 1 个。
    // 别写成 not.toContainText('- ')：Playwright 会对期望串做空白归一化，尾空格被吃掉后变成 '-'，
    // 于是它命中路径里 claude-chat-mobile 的连字符，恒红。
    await expect(readBody.locator('pre')).toHaveCount(1);

    await expectNoBrowserErrors(page);
  });

  // P0-05h（2026-09-09）：历史回放路径的工具卡状态色。
  // live 路径在 tool_result 里换图标【并且】加 text-success；历史回放路径（renderHistoryBubbles）
  // 此前只调 setStatusIcon 换图标，模板里那个表示「进行中」的 text-warning 原样留着——
  // 同一张成功卡，实时看是绿 ✓，刷新 / 切回后变成棕色的 ✓（--warning #9A5F22）。
  // 上面所有既有断言都只查 aria-label，而 aria-label 两条路径都对，所以颜色这一维此前无人把守。
  test('P0-05i 历史回放的子代理卡与 live 同构：同样只有一张卡，且带上输入与结论', async ({ page }) => {
    await gotoMock(page);
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Subagent History Session');
    await expect(page.locator('#messages')).toContainText('Subagent history follow-up', { timeout: 10_000 });

    // 与 P0-05e 逐条同构：两边断言写成同一组，刷新前后形态不一致就必有一边红。
    const card = page.locator('[data-testid="subagent-card"]');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.sa-title')).toContainText('code-reviewer');
    await expect(card.locator('.sa-title')).toContainText('已完成');
    // 合卡：历史侧同样不再为 Agent 工具单独留一张通用工具卡
    await expect(page.locator('#messages > details.toolcard')).toHaveCount(0);
    // 与 live 同一口径：只显 description，不铺原始 JSON
    await expect(card.locator('> .t-in')).toHaveText('Review auth module');
    await expect(card.locator('> .t-in')).not.toContainText('subagent_type');
    await expect(card.locator('.t-full-host > .t-out')).toContainText('Subagent code-reviewer finished review.');
    // 空壳修复（3a）：主 transcript 里没有子代理执行内容，卡在折叠态下 body 是空的；
    // 展开才按需拉 subagent:flow。这两档必须分开断——只断展开后，等于没测「原先是空壳」。
    await expect(card.locator('.sa-body details.toolcard')).toHaveCount(0);

    await card.locator('summary').first().click();
    await expect(card).toHaveAttribute('open', '');
    // 拉回来的条目用的是 live/history 共用的那套渲染，所以形态与 live 一致：正文 + 嵌套工具卡
    await expect(card.locator('.sa-body')).toContainText('CSRF');
    await expect(card.locator('.sa-body details.toolcard')).toHaveCount(1);
    await expect(card.locator('[data-testid="subagent-flow-empty"]')).toHaveCount(0);
    // 「不落主流」只能用结构判据表达——卡本身就在 #messages 里，对 #messages 断
    // not.toContainText 在结构上永远不成立（第一版就是这么写错的）。
    await expect(page.locator('#messages > [data-testid="assistant-message"]'))
      .not.toContainText('Scanning auth handlers');

    await expectNoBrowserErrors(page);
  });

  test('P0-05h 历史回放的成功工具卡染成功色，而不是残留的进行中色', async ({ page }) => {
    await gotoMock(page);
    // Timeline Session 走 session:history 批量回放（fixture 里有一对 tl-tool-1 tool_use/tool_result ok:true）
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Timeline Session');
    await expect(page.locator('#messages')).toContainText('Timeline today follow-up', { timeout: 10_000 });

    const st = page.locator('[data-tool-name="Read"] .t-status');
    await expect(st).toHaveCount(1);
    // aria-label 是图标维，两条路径都对——它绿着也证明不了颜色维，必须分开断
    await expect(st).toHaveAttribute('aria-label', '成功');
    await expect(st).toHaveClass(/text-success/);
    await expect(st).not.toHaveClass(/text-warning/);

    await expectNoBrowserErrors(page);
  });

  // 验收 O55：从历史打开的会话，Bash 输出原来只给 600 字（契约写 2000，服务端那半由 display-contracts 守），
  // 并且历史卡片没有「展开全文」——那个按钮只挂在 live 卡片上、从实例内存取全文，刷新或换台设备就没了。
  // 历史卡片截断时同样挂按钮，请求带上会话坐标，服务端回落去 transcript 取（mock 只在带坐标时给全文）。
  // 附带：纯文本输出不再被 hljs 自动认成 css / vbnet 上色。
  test('P0-05-HIST-FULL 历史回放里被截断的 Bash 卡：有「展开全文」，点开从记录取回全文；纯文本不上语法色', async ({ page }) => {
    await gotoMock(page);
    await sendChatMessage(page, 'test:arm-history-long-tool');
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Timeline Session');
    await expect(page.locator('#messages')).toContainText('Timeline today follow-up', { timeout: 10_000 });

    const card = page.locator('details.toolcard[data-tool-name="Bash"]');
    await expect(card).toHaveCount(1);
    await card.locator('summary').click();
    const out = card.locator('.t-out code');
    await expect(out).toContainText('Compiling module 0: auth');
    await expect(out).not.toContainText('BUILD DONE');
    // 栅栏：历史里的代码块是空闲时一批高亮的；同一张卡的输入块（JSON）已高亮 ⇒ 输出块也已轮到过
    await expect(card.locator('.t-in code')).toHaveClass(/\bhljs\b/, { timeout: 5_000 });
    await expect(out.locator('[class^="hljs-"]')).toHaveCount(0);

    const expand = card.locator('[data-testid="tool-expand-full"]');
    await expect(expand).toBeVisible();
    await expand.click();
    await expect(out).toContainText('BUILD DONE');
    await expect(expand).toHaveCount(0);
    await expect(out.locator('[class^="hljs-"]')).toHaveCount(0);
    await expectNoBrowserErrors(page);
  });

  // 验收 O131（R9 AC-06-06）：英文界面里截断尾巴仍是服务端写的「…（已截断）」，同一张卡的按钮却已是「Show full text」。
  // 顺带补上 #288 只有单测的那半：英文界面下历史卡照样给「展开全文」（嗅探认服务端原文，不随界面语言变）。
  test('P0-05-HIST-FULL-EN 英文界面的历史 Bash 卡：截断尾巴显示成英文，照样有「展开全文」', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ccm_lang', 'en'));
    await gotoMock(page);
    await sendChatMessage(page, 'test:arm-history-long-tool');
    await openSessionsSidebar(page);
    await expandWorkspace(page, MAIN_WORKSPACE);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Timeline Session');
    await expect(page.locator('#messages')).toContainText('Timeline today follow-up', { timeout: 10_000 });

    const card = page.locator('details.toolcard[data-tool-name="Bash"]');
    await card.locator('summary').click();
    const out = card.locator('.t-out code');
    await expect(out).toContainText('…(truncated)');
    await expect(out, '英文界面里冒出服务端写的中文尾巴').not.toContainText('已截断');
    await expect(card.locator('[data-testid="tool-expand-full"]')).toHaveText('Show full text');
    await expectNoBrowserErrors(page);
  });

  // 桌面端 show_widget：SVG 必须作为 data URI 图片显示（不进页面 DOM、不执行脚本），颜色随主题；
  // HTML 组件只给提示；源码残缺 / XML 解析失败退回一行工具调用。
  const decodeSvgSrc = (src: string | null) => decodeURIComponent(String(src).replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));

  test('P0-05w 桌面端 show_widget：SVG 画成图片且按主题上色，HTML 不执行，残缺/坏 XML 退回工具卡', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await gotoMock(page);
    await sendChatMessage(page, 'test:widget');
    // 5 张工具卡一张不少：第 5 张是孤立代理字符，编码抛错的话连工具卡都插不进去
    await expect(page.locator('details.toolcard[data-tool-name="mcp__visualize__show_widget"]')).toHaveCount(5, { timeout: 10_000 });
    await waitForIdle(page);

    // ① SVG → 一张已解码成功的图片（naturalWidth 来自按 viewBox 补的固有尺寸；缺 xmlns 时根本解不出来）
    const svgFig = page.locator('figure.widget-card[data-widget-kind="svg"]');
    await expect(svgFig).toHaveCount(1);
    const img = svgFig.locator('img.widget-svg');
    await expect(img).toHaveAttribute('src', /^data:image\/svg\+xml/);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(680);
    expect(await svgFig.locator('svg, script, iframe').count(), 'SVG 源码不得进页面 DOM').toBe(0);
    // 浅色：c-purple 用 50 填充 / 600 描边（read_me quick pick）
    expect(decodeSvgSrc(await img.getAttribute('src'))).toContain('rect.c-purple,circle.c-purple,ellipse.c-purple{fill:#EEEDFE;stroke:#534AB7}');

    // ② HTML 组件：只有标题与提示，带来的 code 不进 DOM
    const htmlFig = page.locator('figure.widget-card[data-widget-kind="html"]');
    await expect(htmlFig).toHaveCount(1);
    await expect(htmlFig).toContainText('mock calculator');
    await expect(htmlFig).toContainText('交互图表，请在桌面端查看');
    expect(await htmlFig.locator('img, script, iframe').count(), 'HTML 组件源码不得进页面 DOM').toBe(0);

    // ③④⑤ 半截 SVG、坏 XML、孤立代理字符：只剩一行工具卡（坏 XML 要等图片解码失败后撤掉，故 poll）
    await expect(page.locator('figure.widget-card')).toHaveCount(2);
    expect(await page.evaluate(() => (window as unknown as { __widgetRan?: string }).__widgetRan ?? null), '组件里的脚本/事件处理器不得执行').toBeNull();

    // 系统切深色：已显示的图按深色重算（800 填充 / 200 描边）
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(async () => decodeSvgSrc(await img.getAttribute('src')))
      .toContain('rect.c-purple,circle.c-purple,ellipse.c-purple{fill:#3C3489;stroke:#AFA9EC}');
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(680);

    // #385 手动档压过系统：系统深色 + 手动浅色 → 已显示的图按浅色重算；改回跟随系统又回到深色。
    // （theme.js 的 applyThemeToDocument 就是写 / 清 <html data-theme>）
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await expect.poll(async () => decodeSvgSrc(await img.getAttribute('src')))
      .toContain('rect.c-purple,circle.c-purple,ellipse.c-purple{fill:#EEEDFE;stroke:#534AB7}');
    // 原生控件（滚动条、复选框、select 弹层）也要跟手动档，不跟系统
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light');
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await expect.poll(async () => decodeSvgSrc(await img.getAttribute('src')))
      .toContain('rect.c-purple,circle.c-purple,ellipse.c-purple{fill:#3C3489;stroke:#AFA9EC}');

    // 点开看大图：复用附件灯箱
    await img.click();
    await expect(page.locator('#attachPreviewModal')).not.toHaveClass(/\bhidden\b/);
    await expect(page.locator('#attachPreviewImg')).toHaveAttribute('src', /^data:image\/svg\+xml/);

    await expectNoBrowserErrors(page);
  });

  test('P0-05x 桌面端会话的 show_widget 经历史追平同样画成图片', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await gotoMock(page);
    await sendChatMessage(page, 'test:widget-history');
    await expect(page.locator('#messages')).toContainText('Draw the architecture', { timeout: 10_000 });
    const img = page.locator('figure.widget-card[data-widget-kind="svg"] img.widget-svg');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute('src', /^data:image\/svg\+xml/);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(680);
    expect(decodeSvgSrc(await img.getAttribute('src'))).toContain('rect.c-purple,circle.c-purple,ellipse.c-purple{fill:#3C3489;stroke:#AFA9EC}');
    // 图紧跟在自己的工具卡后面，工具卡仍在（一行工具调用 + 图）
    // 两张工具卡都在（孤立代理字符那张退回一行工具调用，且没中断这批历史的渲染）；图紧跟在自己的工具卡后面
    const cards = page.locator('details.toolcard[data-tool-name="mcp__visualize__show_widget"]');
    await expect(cards).toHaveCount(2);
    expect(await cards.nth(0).evaluate(el => el.nextElementSibling?.matches('figure.widget-card') ?? false)).toBe(false);
    expect(await cards.nth(1).evaluate(el => el.nextElementSibling?.matches('figure.widget-card') ?? false)).toBe(true);

    await expectNoBrowserErrors(page);
  });

  // 验收 AC-09-12 / O30：重启后过期的审批，transcript 里留下一条没配上 tool_result 的 tool_use；历史渲染恒把它画成
  // 「进行中」，而这个会话根本没在跑——那一行永远转着。没有在途轮时，没配上结果的历史工具卡应是「已中止」。
  test('P0-05-UNPAIRED 历史里没配上结果的工具卡：会话没在跑时显示「已中止」，不是一直「进行中」', async ({ page }) => {
    captureBrowserErrors(page);
    // 同 gotoMock：mock 与真 server 一样拒绝无令牌握手，先预置令牌再开页。
    await page.addInitScript(() => localStorage.setItem('auth_token', 'mock-token'));
    await page.request.post('/__reset');
    await page.request.post('/__arm-unpaired-tool-session');
    await page.goto('/');
    await waitUntilConnected(page);

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Unpaired Tool Session');
    await expect(page.locator('#messages')).toContainText('Push the release branch');
    const status = page.locator('details.toolcard .t-status').last();
    await expect(status).toHaveAttribute('aria-label', '已中止');

    await expectNoBrowserErrors(page);
  });
  // PR #233 review：重载与在途轮重叠——读盘时 tool_use 已写、tool_result 未写，回包前那一轮跑完。收尾时按「此刻没在跑」
  // 把这张卡判成「已中止」是错的（它真跑完了）；随后实时到达的结果也只在 live 表里找卡，修不回来。
  test('P0-05-UNPAIRED2 重载期间那一轮跑完：没配上结果的卡不判「已中止」，随后到的结果照常落上', async ({ page }) => {
    captureBrowserErrors(page);
    // 同 gotoMock：mock 与真 server 一样拒绝无令牌握手，先预置令牌再开页。
    await page.addInitScript(() => localStorage.setItem('auth_token', 'mock-token'));
    await page.request.post('/__reset');
    await page.request.post('/__arm-unpaired-tool-session?running=1');
    await page.goto('/');
    await waitUntilConnected(page);
    // 「已中止」只要出现过一次就记下：收尾判错之后被实时结果盖回来，最终态看不出来
    await page.evaluate(() => {
      (window as unknown as { __abortedSeen: number }).__abortedSeen = 0;
      new MutationObserver(records => {
        for (const r of records) {
          if ((r.target as Element).getAttribute?.('aria-label') === '已中止') (window as unknown as { __abortedSeen: number }).__abortedSeen += 1;
        }
      }).observe(document.getElementById('messages')!, { subtree: true, attributes: true, attributeFilter: ['aria-label'] });
    });

    await openSessionsSidebar(page);
    await openWorkspaceSession(page, MAIN_WORKSPACE, 'Unpaired Tool Session');
    await expect(page.locator('#messages')).toContainText('Push the release branch');
    const status = page.locator('details.toolcard .t-status').last();
    await expect(status, '实时到达的结果没落到历史里的那张卡上').toHaveAttribute('aria-label', '成功');
    expect(await page.evaluate(() => (window as unknown as { __abortedSeen: number }).__abortedSeen),
      '请求历史时那一轮还在跑：没配上结果不等于中止').toBe(0);

    await expectNoBrowserErrors(page);
  });
});
