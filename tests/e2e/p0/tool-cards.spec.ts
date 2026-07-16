// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

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
    await expect(page.locator('#activeStatusPill')).toBeVisible();

    // 2. 等待完成并展开第一个工具卡片。
    await waitForIdle(page);
    await page.locator('details.toolcard summary').first().click();
    await expect(page.locator('details.toolcard').first()).toHaveAttribute('open', '');
    await expect(page.locator('details.toolcard pre').first()).toContainText('utils/date.js');
    await expect(page.locator('details.toolcard .t-status')).toHaveText(['✅', '✅', '✅']);
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
    await expect(page.locator('details.toolcard .t-status')).toHaveText(['✅', '✅']);

    await expectNoBrowserErrors(page);
  });

  test('P0-05c 工具执行中出错会收敛卡片并恢复输入', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tool-error');
    const failedCard = page.locator('details.toolcard').filter({ hasText: 'run_command' }).first();
    await expect(failedCard).toBeVisible();

    await waitForIdle(page);
    await expect(page.locator('#messages')).toContainText('mock tool crashed');
    await expect(failedCard.locator('.t-status')).toHaveText('❌');
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
});
