// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

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
    await expect(page.locator('#questionModal')).toBeHidden();
    await expect(page.locator('#activeStatusText')).toContainText('Claude 正在思考中...');
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
    await page.locator('#questionModal').click({ position: { x: 12, y: 12 } });

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
