// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-10 状态线、成本、模型与上下文信息（对齐 CLI statusline 文案）', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:statusline，展开状态线详情。
    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);
    await expect(page.locator('#cliStatusWrap')).toBeVisible();
    // 折叠条只显 'statusline' 一词；全部数据在展开态（CLI 密集风）
    await expect(page.locator('#cliSummary')).toContainText('statusline');
    await page.locator('#cliStatusWrap summary').click();
    await expect(page.locator('#cliStatus')).toContainText('feature/visual-testing');
    await expect(page.locator('#cliStatus')).toContainText('+2 !1');          // git 三分
    await expect(page.locator('#cliStatus')).toContainText('effort high');
    await expect(page.locator('#cliStatus')).toContainText('claude-chat-mobile'); // location
    await expect(page.locator('#cliStatus')).toContainText('ctx 23%');
    await expect(page.locator('#cliStatus')).toContainText('left 155k');
    // mock fixture：tokens:45000, r:21000 → 21000/45000*100=46.67%
    await expect(page.locator('#cliStatus')).toContainText('uncached 2.0k response 1.5k');
    await expect(page.locator('#cliStatus')).toContainText('cache 46.67%');
    await expect(page.locator('#cliStatus')).toContainText('5h 42%');
    await expect(page.locator('#cliStatus')).toContainText('7d 11%');
    await expect(page.locator('#cliStatus')).toContainText('$0.37');
    await expect(page.locator('#cliStatus')).toContainText('lines +12/-4');
    await expect(page.locator('#cliStatus')).toContainText('Ike-li/claude-chat-mobile');
    await expect(page.locator('#cliStatus')).toContainText('v2.1.178');
    await expect(page.locator('#cliStatus')).toContainText('sid 784e20b1');
    // web 独有字段已删
    await expect(page.locator('#cliStatus')).not.toContainText('reused');
    await expect(page.locator('#cliStatus')).not.toContainText('Skills');

    await expectNoBrowserErrors(page);
  });

  test('P0-10c 陈旧跨工作区状态线不会覆盖当前状态线', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);
    await page.locator('#cliStatusWrap summary').click();
    await expect(page.locator('#cliStatus')).toContainText('Ike-li/claude-chat-mobile');
    await expect(page.locator('#cliStatus')).toContainText('feature/visual-testing');

    await sendChatMessage(page, 'test:stale-statusline-replay');
    await waitForIdle(page);
    await expect(page.locator('#topProjectText')).toContainText('claude-chat-mobile');
    await expect(page.locator('#cliStatus')).toContainText('Ike-li/claude-chat-mobile');
    await expect(page.locator('#cliStatus')).not.toContainText('Ike-li/another-react-project');
    await expect(page.locator('#cliStatus')).not.toContainText('feature/other-workspace');

    await expectNoBrowserErrors(page);
  });

  test('P0-10d CLI 镜像状态线标明唯一来源，快照不可用时不回退 SDK 陈值', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:cli-statusline');
    await waitForIdle(page);
    await page.locator('#cliStatusWrap summary').click();
    await expect(page.locator('#cliStatus')).toContainText('Opus 4.8');
    await expect(page.locator('#cliStatus')).toContainText('effort max');
    await expect(page.locator('#cliStatus')).toContainText('think on');
    await expect(page.locator('#cliStatus')).toContainText('source CLI');

    await sendChatMessage(page, 'test:cli-statusline-unavailable');
    await waitForIdle(page);
    await expect(page.locator('#cliStatus')).toContainText('CLI 状态暂不可用');
    await expect(page.locator('#cliStatus')).not.toContainText('Opus 4.8');
    await expect(page.locator('#cliStatus')).not.toContainText('claude-3-5-sonnet');

    await expectNoBrowserErrors(page);
  });
});
