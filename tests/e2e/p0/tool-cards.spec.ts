// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

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
    for (let i = 0; i < 3; i++) await expect(st.nth(i)).toHaveAttribute('aria-label', '成功');
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

    await card.locator('summary').first().click();
    await expect(card).toHaveAttribute('open', '');
    await expect(card.locator('.sa-body')).toBeVisible();

    await expectNoBrowserErrors(page);
  });

  test('P0-05f Workflow 子流建卡 + 后台任务全量列表（含单任务详情行）', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:workflow-subagents');
    // mock 推 2 条 task_progress → 标题「2 个运行中」+ 两行明细；多任务默认折叠列表，点横幅头行展开。
    await expect(page.locator('#taskProgressBanner')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#taskProgressText')).toContainText('2 个运行中');
    await expect(page.locator('#taskProgressText')).not.toContainText('后台任务 后台任务');
    const taskToggle = page.locator('[data-testid="bg-task-toggle"]');
    await expect(taskToggle).toBeVisible();
    await expect(page.locator('[data-testid="bg-task-list"]')).toBeHidden();
    await expect(page.locator('[data-testid="bg-task-row"]')).toHaveCount(2);
    await taskToggle.click();
    await expect(page.locator('[data-testid="bg-task-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="bg-task-row"]').first()).toContainText('Explore');

    await waitForIdle(page);

    // Workflow 不预建空卡；有 parentToolUseId 子流时才出现折叠卡
    const card = page.locator('[data-testid="subagent-card"]');
    await expect(card).toHaveCount(1);
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
});
