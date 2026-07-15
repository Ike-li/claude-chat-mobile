// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-14 pending snapshot 对账重建审批卡片', async ({ page }) => {
    await gotoMock(page);

    // 1. 原始 permission_request 未回放时，sync:since ack.pending 快照重建审批弹窗。
    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await sendChatMessage(page, 'test:pendingsnapshot');
    await expect(page.locator('#permModal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permInput')).toContainText('rm -rf /tmp/stale');

    await expectNoBrowserErrors(page);
  });

  test('P0-14b pending snapshot 同 requestId 重复对账不重复弹审批', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await sendChatMessage(page, 'test:pendingsnapshot-duplicate');
    await expect(page.locator('#permModal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#permInput')).toContainText('rm -rf /tmp/stale');

    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });

  test('P0-14c pending snapshot 可重建 AskUserQuestion 选择弹窗', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await sendChatMessage(page, 'test:questionsnapshot');
    await expect(page.locator('#questionModal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#questionText')).toContainText('Which release branch should receive the restored pending answer?');
    await expect(page.locator('#questionOptions button')).toHaveText([
      'main',
      'dev',
      'release-v1.0'
    ]);

    await page.locator('#questionOptions button').nth(2).click();
    await expect(page.locator('#questionModal')).toBeHidden();
    await waitForIdle(page);
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('release-v1.0');

    await expectNoBrowserErrors(page);
  });

  test('P0-14d sync gap 后仍保留 pending snapshot 审批弹窗', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:gap-pending-snapshot');
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#messages')).toContainText('Gap pending fallback prompt', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('Gap pending history after buffer trim.');
    await expect(page.locator('#messages')).not.toContainText('Partial pending gap buffer that must be discarded');
    await expect(page.locator('#historyLoadingCard')).toHaveCount(0);
    await expect(page.locator('#permModal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permInput')).toContainText('rm -rf /tmp/gap-stale');

    await expectNoBrowserErrors(page);
  });

  test('P0-14e sync gap 后仍保留 AskUserQuestion pending snapshot', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:gap-question-snapshot');
    await expect(page.locator('#topProjectText')).toContainText('another-react-project');
    await expect(page.locator('#messages')).toContainText('Gap question fallback prompt', { timeout: 10_000 });
    await expect(page.locator('#messages')).toContainText('Gap question history after buffer trim.');
    await expect(page.locator('#messages')).not.toContainText('Partial question gap buffer that must be discarded');
    await expect(page.locator('#historyLoadingCard')).toHaveCount(0);
    await expect(page.locator('#questionModal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#questionText')).toContainText('Which release branch should receive the gap-restored pending answer?');
    await expect(page.locator('#questionOptions button')).toHaveText([
      'main',
      'dev',
      'release-v1.0'
    ]);

    await expectNoBrowserErrors(page);
  });
});
