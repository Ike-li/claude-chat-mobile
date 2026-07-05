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
    await page.locator('#cliStatusWrap summary').click();
    await expect(page.locator('#cliSummary')).toContainText('45k');
    await expect(page.locator('#cliSummary')).toContainText('$0.37');
    await expect(page.locator('#cliStatus')).toContainText('feature/visual-testing');
    await expect(page.locator('#cliStatus')).toContainText('+120');
    await expect(page.locator('#cliStatus')).toContainText('45,000 tokens');
    await expect(page.locator('#cliStatus')).toContainText('cache 45%');
    await expect(page.locator('#cliStatus')).toContainText('reused 1.2m');
    await expect(page.locator('#cliStatus')).toContainText('Ike-li/claude-chat-mobile');
    await expect(page.locator('#cliStatus')).toContainText('v2.1.178');

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
});
