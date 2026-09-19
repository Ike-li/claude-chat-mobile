// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-08 AskUserQuestion 多选弹窗', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:question 后显示多选问题。
    await sendChatMessage(page, 'test:question');
    await expect(page.locator('#questionModal')).toBeVisible();
    await expect(page.locator('#questionText')).toContainText('Which branch should be our target publish destination?');
    await expect(page.locator('#questionOptions button')).toHaveText([
      'main (Stable Production)',
      'dev (Bleeding-Edge Integration)',
      'release-v1.0 (LTS)'
    ]);

    // 2. 点击第二个选项 dev。
    await page.locator('#questionOptions button').nth(1).click();
    // 答完最后一题：live 行回纯 spinner（✻ 动词… (Ns…)），且不含 AskUserQuestion。
    // 后半条守的是 formatCliSpinnerLine「对齐 CLI、不挂工具后缀段」那条决策（bg-tasks.js 的
    // 同名函数上方注释），不是守一个会自然发生的回归——实测把后缀段加回去它才红。
    //
    // 【这两条必须排在 toBeHidden 之前，顺序是承重的】live 行是 ephemeral 的，本轮 result 一到
    // 就被 hideStreamLiveStatus 整个摘掉——mock 里那是答完后 800ms（user:answer handler 的
    // delay(800)）。而 closeSheet 要等 300ms 滑出动画才给弹窗加 .hidden，叠上 Playwright
    // expect 自身退避的轮询间隔（100/250/500/1000ms），toBeHidden 实测要 810ms 才兑现。
    // 排在它后面，这两条就是在跟回合收尾赛跑，而且只输 10ms：本机稳定红（element(s) not found，
    // 不是文本不符），CI 上恰好绿——2026-09-18 逐帧量过，点击后 0–350ms 内文本就已经是
    // 「✻ Mustering… (1s · thought for 1s)」，断言本身从第一次轮询就该命中。
    await expect(page.locator('#streamLiveStatusText')).toContainText(/^✻ .+… \(\d+s/);
    await expect(page.locator('#streamLiveStatusText')).not.toContainText('AskUserQuestion');
    await expect(page.locator('#questionModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveAttribute('aria-label', '已回答');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('dev (Bleeding-Edge Integration)');

    await expectNoBrowserErrors(page);
  });

  test('P0-08b AskUserQuestion 同 requestId 重放不重复弹窗', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:question-duplicate');
    await expect(page.locator('#questionModal')).toBeVisible();
    await expect(page.locator('#questionText')).toContainText('Which branch should be our target publish destination?');
    await expect(page.locator('#questionOptions button')).toHaveCount(3);

    await page.locator('#questionOptions button').nth(1).click();
    await expect(page.locator('#questionModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('dev (Bleeding-Edge Integration)');
    await expect(page.locator('#questionModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-08c 其它设备回答问题后当前选择弹窗自动关闭', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:question-remote-resolved');
    await expect(page.locator('#questionModal')).toBeVisible();
    await expect(page.locator('#questionText')).toContainText('Which branch should be our target publish destination?');
    await expect(page.locator('#questionOptions button')).toHaveCount(3);

    await expect(page.locator('#questionModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('details.toolcard .t-status').last()).toHaveAttribute('aria-label', '已回答');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('answered on another trusted device');

    await expectNoBrowserErrors(page);
  });

  test('P0-08d 当前提问轮失败结果会关闭选择弹窗并恢复输入', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:question-result-error');
    await expect(page.locator('#questionModal')).toBeVisible();
    await expect(page.locator('#questionText')).toContainText('Which branch should be our target publish destination?');
    await expect(page.locator('#questionOptions button')).toHaveCount(3);

    await expect(page.locator('#questionModal')).toBeHidden({ timeout: 10_000 });
    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('出错：mock question turn failed');
    const failedQuestionCard = page.locator('details.toolcard').filter({ hasText: 'AskUserQuestion' }).last();
    await expect(failedQuestionCard.locator('.t-status')).toHaveAttribute('aria-label', '出错');
    await failedQuestionCard.locator('summary').click();
    await expect(failedQuestionCard.locator('.t-out')).toContainText('mock question turn failed');

    await sendChatMessage(page, 'test:settings-echo');
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    await expectNoBrowserErrors(page);
  });

  test('P0-08e 选择弹窗打开时触屏 Enter 不提交且保留换行草稿', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:question');
    await expect(page.locator('#questionModal')).toBeVisible();
    await expect(page.locator('#questionText')).toContainText('Which branch should be our target publish destination?');
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);

    await page.locator('#input').fill('test:settings-echo');
    await expect(page.locator('#btnSend')).toBeDisabled();
    await expect(page.locator('#btnSend')).toHaveAttribute('title', '请先处理当前审批或选择');
    await page.locator('#input').press('Enter');

    await expect(page.locator('#questionModal')).toBeVisible();
    await expect(page.locator('#questionOptions button')).toHaveCount(3);
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
    await expect(page.locator('#input')).toHaveValue('test:settings-echo\n');

    await page.locator('#questionOptions button').nth(1).click();
    await expect(page.locator('#questionModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('#input')).toHaveValue('test:settings-echo\n');
    await expect(page.locator('#btnSend')).toBeEnabled();
    await page.locator('#btnSend').click();
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('设置回显：model=');

    await expectNoBrowserErrors(page);
  });

  test('P0-08f 点击选择弹窗遮罩不会关闭或提交背景草稿', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:question');
    await expect(page.locator('#questionModal')).toBeVisible();
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);

    await page.locator('#input').fill('draft while choosing');
    // 取点避开顶栏：审批/提问挂起时导航层抬到 sheet 之上（body.nav-escape），左上角 (12,12)
    // 已归 header —— 那里点下去是切会话，不再是「被遮罩吞掉」。y=140 落在遮罩空白区。
    await page.locator('#questionModal').click({ position: { x: 12, y: 140 } });

    await expect(page.locator('#questionModal')).toBeVisible();
    await expect(page.locator('#questionOptions button')).toHaveCount(3);
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
    await expect(page.locator('#input')).toHaveValue('draft while choosing');
    await expect(page.locator('#btnSend')).toBeDisabled();

    await page.locator('#questionOptions button').nth(1).click();
    await expect(page.locator('#questionModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('#input')).toHaveValue('draft while choosing');

    await expectNoBrowserErrors(page);
  });

  // P0-08h（2026-09-07）：多选这一档此前在整套 E2E 里【不可达】——mock 从不发 multiSelect，于是
  // approval-questions.js:235 的 `const multi = Boolean(activeQuestion.multiSelect)` 恒 false，☐ 前缀、
  // 提示行、「确认选择」按钮、optionIndexes 回程四段代码一行都没被走过。刺眼的是 mock 的【入站】handler
  // 早就解析 optionIndexes 了（server.js 的 user:answer 分支有完整的 multi label 合并），回程建好了、
  // 去程从未建起来。真机后果：模型问多选题，用户看到单选卡片，手指点中第一个想选的弹窗就关，
  // 模型拿着残缺答案继续跑，界面上没有任何东西提示他这题本可多选。
  // 单选仍然「点一下就关」的对照档由上面的 P0-08 钉住（第 21-22 行），此处不重复。
  test('P0-08h AskUserQuestion 多选：☐ 勾选累积、计数按钮、一次提交多项', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:question-multi');
    await expect(page.locator('#questionModal')).toBeVisible();

    // header 与 multiSelect 是同一批补上的去程字段，一起断言
    await expect(page.locator('#questionHeader')).toBeVisible();
    await expect(page.locator('#questionHeader')).toHaveText('Deploy targets');
    await expect(page.locator('#questionMultiHint')).toBeVisible();

    const submit = page.locator('#questionMultiSubmit');
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveText('确认选择');

    const opts = page.locator('#questionOptions button');
    await expect(opts).toHaveText([
      '☐ main (Stable Production)',
      '☐ dev (Bleeding-Edge Integration)',
      '☐ release-v1.0 (LTS)'
    ]);

    // 勾一项 → 变 ☑、按钮启用并带计数
    await opts.nth(0).click();
    await expect(opts.nth(0)).toHaveText('☑ main (Stable Production)');
    await expect(submit).toBeEnabled();
    await expect(submit).toHaveText('确认选择 (1)');
    // 弹窗【不】关闭——这正是与单选路径的分水岭
    await expect(page.locator('#questionModal')).toBeVisible();

    // 再勾一项 → 计数累积
    await opts.nth(2).click();
    await expect(submit).toHaveText('确认选择 (2)');

    // 取消勾选 → 回落
    await opts.nth(0).click();
    await expect(opts.nth(0)).toHaveText('☐ main (Stable Production)');
    await expect(submit).toHaveText('确认选择 (1)');

    // 补回来后一次提交两项，回程走 optionIndexes（mock 侧的 multi label 合并分支此前不可达）
    await opts.nth(1).click();
    await expect(submit).toHaveText('确认选择 (2)');
    await submit.click();
    await expect(page.locator('#questionModal')).toBeHidden();
    await waitForIdle(page);
    const answer = page.locator('[data-testid="assistant-message"]').last();
    await expect(answer).toContainText('dev (Bleeding-Edge Integration)');
    await expect(answer).toContainText('release-v1.0 (LTS)');

    await expectNoBrowserErrors(page);
  });

  test('P0-08g AskUserQuestion 可跳过并按取消收敛', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:question');
    await expect(page.locator('#questionModal')).toBeVisible();
    await expect(page.locator('#questionSkip')).toBeVisible();
    await expect(page.locator('#questionSkip')).toContainText('跳过');

    await page.locator('#questionSkip').click();
    await expect(page.locator('#questionModal')).toBeHidden();
    await expect(page.locator('details.toolcard .t-status').last()).toHaveAttribute('aria-label', '已拒绝');

    await expectNoBrowserErrors(page);
  });
});
