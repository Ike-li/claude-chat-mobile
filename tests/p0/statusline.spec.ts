// spec: specs/claude-chat-mobile-comprehensive-test-plan.md
// seed: tests/seed.goto-mock.spec.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../seed.goto-mock.spec';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-10 状态线、成本、模型与上下文信息', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:statusline，展开状态线详情。
    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);
    await expect(page.locator('#cliStatusWrap')).toBeVisible();
    // 折叠条只显 'statusline' 一词；全部数据在展开态（CLI 密集风）
    await expect(page.locator('#cliSummary')).toContainText('statusline');
    await page.locator('#cliStatusWrap summary').click();
    await expect(page.locator('#cliStatus')).toContainText('feature/visual-testing');
    await expect(page.locator('#cliStatus')).toContainText('+120');
    await expect(page.locator('#cliStatus')).toContainText('ctx 23%');        // model→窗口映射算出的上下文占用
    await expect(page.locator('#cliStatus')).toContainText('left 155k');      // windowSize − tokens
    await expect(page.locator('#cliStatus')).toContainText('45,000 tokens');
    await expect(page.locator('#cliStatus')).toContainText('cache 45%');
    await expect(page.locator('#cliStatus')).toContainText('reused 1.2m');
    await expect(page.locator('#cliStatus')).toContainText('$0.37');          // 成本移入展开态：est $0.37
    await expect(page.locator('#cliStatus')).toContainText('Ike-li/claude-chat-mobile');
    await expect(page.locator('#cliStatus')).toContainText('v2.1.178');
    await expect(page.locator('#cliStatus')).toContainText('sid 784e20b1');   // 会话元数据（sid）

    await expectNoBrowserErrors(page);
  });

  test('P0-10b 状态线缓存 TTL 显示估算语义', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);
    await page.locator('#cliStatusWrap summary').click();
    await expect(page.locator('#cliStatus .js-cache-ttl')).toBeVisible();
    await expect(page.locator('#cliStatus .js-cache-ttl')).toContainText(/ttl ~|cache cold/);
    await expect(page.locator('#cliStatus .js-cache-ttl')).toContainText('est');

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
});
