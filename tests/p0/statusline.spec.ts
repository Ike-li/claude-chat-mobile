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
    // 复核发现：这两条断言在另一并发会话的 "categories 明细 UI" 改动（commit bfbe3a8/eae8a0c，
    // 早于本次 TC-002/003/004/005/006/007/009 六项修复）后就已经和实际渲染对不上——旧的独立"总
    // token 数"段被移除（app.js:1452 注释：ctx 段已含）、cache 命中率也改成按 r/tokens 现算 2 位
    // 小数（app.js:1446）而非 mock fixture 里已不再使用的 cacheHitPct 字段。按 mock fixture
    // （scripts/visual-mock-server.js:894：tokens:45000, r:21000）现算：21000/45000*100=46.67%。
    // 这不是本次审计 7 项的范围，但会让 TC-003 刚接进 CI 的 playwright-p0 job 一上来就红，故顺带
    // 把断言改成跟当前真实渲染一致（不改 app.js/statusline.js 生产代码，只改这条过期断言）。
    await expect(page.locator('#cliStatus')).toContainText('uncached 2.0k response 1.5k');
    await expect(page.locator('#cliStatus')).toContainText('cache 46.67%');
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
