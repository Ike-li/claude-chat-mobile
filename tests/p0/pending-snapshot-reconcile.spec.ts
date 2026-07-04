// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-14 pending snapshot 对账重建审批卡片', async ({ page }) => {
    await gotoMock(page);

    // 1. 原始 permission_request 未回放时，sync:since ack.pending 快照重建审批弹窗。
    await sendChatMessage(page, 'test:tab');
    await sendChatMessage(page, 'test:pendingsnapshot');
    await expect(page.locator('#permModal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permInput')).toContainText('rm -rf /tmp/stale');

    await expectNoBrowserErrors(page);
  });
});
