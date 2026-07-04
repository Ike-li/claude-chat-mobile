// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

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
    await expect(page.locator('details.toolcard .t-status').last()).toHaveText('☑️');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('dev (Bleeding-Edge Integration)');

    await expectNoBrowserErrors(page);
  });
});
