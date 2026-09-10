// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';
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
    await expect(card.locator('> .t-in')).toContainText('code-reviewer');
    await expect(card.locator('.t-full-host > .t-out')).toContainText('Subagent code-reviewer finished review.');

    await card.locator('summary').first().click();
    await expect(card).toHaveAttribute('open', '');
    await expect(card.locator('.sa-body')).toBeVisible();

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
    await expect(card.locator('> .t-in')).toContainText('code-reviewer');
    await expect(card.locator('.t-full-host > .t-out')).toContainText('Subagent code-reviewer finished review.');
    // sidechain 子流进卡内、不落主流。「不落主流」只能用结构判据表达——卡本身就在 #messages 里，
    // 对 #messages 断 not.toContainText 在结构上永远不成立（第一版就是这么写错的）。
    await expect(card.locator('.sa-body')).toContainText('CSRF');
    await expect(page.locator('#messages > [data-testid="assistant-message"]'))
      .not.toContainText('Found 1 CSRF gap in login handler.');

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
});
