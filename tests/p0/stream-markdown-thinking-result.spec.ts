// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-03 流式回复、Markdown、thinking 与结果栏', async ({ page }) => {
    await gotoMock(page);

    // 1. 起始状态/假设：fresh state。向聊天输入框发送 test:stream。
    await sendChatMessage(page, 'test:stream');
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:stream');
    await expect(page.locator('#activeStatusPill')).toBeVisible();
    await expect(page.locator('#activeStatusText')).toContainText(/Claude 正在|执行|思考/);
    await expect(page.locator('#btnStopNew')).toBeVisible();
    await expect(page.locator('details.thinking')).toBeVisible();

    // 2. 等待流式输出结束。
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('fully visual-oriented', { timeout: 20_000 });
    await waitForIdle(page);
    await expect(page.locator('#messages strong').first()).toContainText('fully visual-oriented');
    await expect(page.locator('[data-testid="assistant-message"]').last().locator('pre')).toBeVisible();
    await expect(page.locator('[data-testid="assistant-message"]').last().locator('pre code')).toContainText('tester');
    await expect(page.locator('#messages .msg-frame.text-center.text-xs.text-ink-faint').last()).toContainText('$0.0015');

    await expectNoBrowserErrors(page);
  });
});
