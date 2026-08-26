// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

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

  // VC-D2-04（2026-08-26 探索性测试，真机已通过）：**审批不依赖 socket 会话内存**。
  // 上面 P0-14 系列走的是「mock 在 sync:since ack 里带回快照」这条脚本化路径，
  // 中间没有任何一次真实的页面销毁——而用户的实际操作是「把浏览器整个关掉再打开」。
  // 这里用真 reload 覆盖那一维：**刻意不走 gotoMock**（它会 POST /__reset 把待审批一起清掉，
  // 那样这条用例就变成在一张干净页面上断言「卡片回来了」，恒绿且毫无意义）。
  test('P0-14f 真实 reload 后审批卡片自动恢复，参数不空（不靠 socket 会话内存）', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:tab');
    await waitForIdle(page);
    await sendChatMessage(page, 'test:pendingsnapshot');
    await expect(page.locator('#permModal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#permTool')).toHaveText('run_command');

    // ★ 真 reload：整棵 DOM、所有前端状态、socket 连接全部销毁重建。
    await page.reload();
    await expect(page.locator('#connDot')).toHaveClass(/bg-success/, { timeout: 10_000 });

    // 卡片必须自己回来，且**参数完整**——只回来一个空壳等于要求用户盲批。
    await expect(page.locator('#permModal')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#permTool')).toHaveText('run_command');
    await expect(page.locator('#permInput')).toContainText('rm -rf /tmp/stale');

    // 恢复出来的卡片是能真答复的，不是只能看的残影
    await page.locator('#permDeny').click();
    await expect(page.locator('#permModal')).toBeHidden();

    await expectNoBrowserErrors(page);
  });
});
