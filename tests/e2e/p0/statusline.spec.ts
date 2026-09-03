// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-10 状态线、成本、模型与上下文信息（对齐 CLI statusline 文案）', async ({ page }) => {
    await gotoMock(page);

    // 1. 发送 test:statusline，展开状态线详情。
    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);
    await expect(page.locator('#cliStatusWrap')).toBeVisible();
    // 折叠摘要：git · ctx（不重复 pill 上的 model/effort）
    await expect(page.locator('#cliSummary')).toContainText('feature/visual-testing');
    await expect(page.locator('#cliSummary')).toContainText('ctx 23%');
    await page.locator('#cliStatusWrap summary').click();
    await expect(page.locator('#cliStatus')).toContainText('feature/visual-testing');
    await expect(page.locator('#cliStatus')).toContainText('+2 !1');          // git 三分
    await expect(page.locator('#cliStatus')).toContainText('effort high');
    await expect(page.locator('#cliStatus')).toContainText('claude-chat-mobile'); // location
    await expect(page.locator('#cliStatus')).toContainText('ctx 23%');
    await expect(page.locator('#cliStatus')).toContainText('left 155k/200k');
    // mock fixture：tokens:45000, r:21000 → formatCachePercent 取整 47%
    await expect(page.locator('#cliStatus')).toContainText('uncached 2.0k response 1.5k');
    await expect(page.locator('#cliStatus')).toContainText('cache 47%');
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

  // 顶栏工作区 pill 的改动角标：让「工作区改动」这个功能在有改动时自己招手，而不是等用户点进去才发现。
  // 数据源是 status_line 事件里现成的 git 段——无独立请求，故本用例复用 test:statusline 的 fixture
  // （git.changed = 3）。角标挂在顶栏而非状态栏内，须与 #cliStatus 的展开/折叠完全无关。
  test('P0-10f 顶栏工作区 pill 显示未提交改动数角标，切到无 git 的工作区即消失', async ({ page }) => {
    await gotoMock(page);

    const badge = page.locator('[data-testid="top-context-changes"]');
    await sendChatMessage(page, 'test:statusline');
    await waitForIdle(page);

    await expect(page.locator('#topContextPill')).toBeVisible();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('3');
    // 角标不依赖状态栏展开——此处从未点开 #cliStatusWrap，角标已在
    await expect(page.locator('#cliStatus')).not.toBeVisible();

    // cli-statusline 的 payload 无 git 段（非 git 仓库 / statusline 关闭同理）→ 优雅缺席，不留旧数字
    await sendChatMessage(page, 'test:cli-statusline');
    await waitForIdle(page);
    await expect(badge).toBeHidden();

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

  test('P0-10e CLI 状态暂不可用时，账号级额度快照回落仍可展示（明确标注非实时）', async ({ page }) => {
    await gotoMock(page);

    // 1. cli-unavailable + 账号级额度快照回落（rate + rateFromSnapshot:true）：
    //    "CLI 状态暂不可用" 提示与额度回落行应同时出现，且必须清楚标注非实时，防止用户误判 CLI 状态本身正常。
    await sendChatMessage(page, 'test:cli-statusline-unavailable-rate');
    await waitForIdle(page);
    await page.locator('#cliStatusWrap summary').click();
    await expect(page.locator('#cliStatus')).toContainText('CLI 状态暂不可用');
    await expect(page.locator('#cliStatus')).toContainText('5h 42%');
    await expect(page.locator('#cliStatus')).toContainText('7d 11%');
    await expect(page.locator('#cliStatus')).toContainText('非实时');

    // 2. 反向场景：cli-unavailable 但没有 rate 字段（本修复前的原始行为）——必须仍是干净的
    //    "CLI 状态暂不可用"，不能把上一条消息里的额度回落残留下来（防止本次改动引入"清空不彻底"的新 bug）。
    await sendChatMessage(page, 'test:cli-statusline-unavailable');
    await waitForIdle(page);
    await expect(page.locator('#cliStatus')).toContainText('CLI 状态暂不可用');
    await expect(page.locator('#cliStatus')).not.toContainText('5h');
    await expect(page.locator('#cliStatus')).not.toContainText('7d');
    await expect(page.locator('#cliStatus')).not.toContainText('非实时');

    await expectNoBrowserErrors(page);
  });
});
