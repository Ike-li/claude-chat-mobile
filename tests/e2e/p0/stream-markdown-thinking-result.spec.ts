// spec: docs/testing.md
// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

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

  test('P0-03b 代码块复制按钮提供可见反馈', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:stream');
    await expect(page.locator('[data-testid="assistant-message"]').last().locator('pre code')).toContainText('tester', { timeout: 20_000 });
    await waitForIdle(page);

    const copyButton = page.locator('[data-testid="assistant-message"]').last().getByRole('button', { name: /复制代码|复制/ }).first();
    await expect(copyButton).toBeVisible();
    // UI-003：触点 ≥32px，pre 顶留白防遮代码
    const metrics = await copyButton.evaluate((btn) => {
      const style = getComputedStyle(btn);
      const wrap = btn.closest('.code-block-wrap');
      const pre = wrap?.querySelector('pre');
      const prePadTop = pre ? parseFloat(getComputedStyle(pre).paddingTop) : 0;
      return {
        minH: parseFloat(style.minHeight) || btn.getBoundingClientRect().height,
        minW: parseFloat(style.minWidth) || btn.getBoundingClientRect().width,
        prePadTop,
      };
    });
    expect(metrics.minH).toBeGreaterThanOrEqual(32);
    expect(metrics.minW).toBeGreaterThanOrEqual(32);
    expect(metrics.prePadTop).toBeGreaterThanOrEqual(24); // 2rem ≈ 32px，宽松 ≥24
    await copyButton.click();
    await expect(copyButton).toContainText(/已复制|失败/);

    await expectNoBrowserErrors(page);
  });

  test('P0-03c 助手消息编辑按钮保留上一条用户原文', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:message-edit 复制 README');
    await waitForIdle(page);
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('message edit fixture');

    await reply.getByRole('button', { name: /编辑/ }).click();
    await expect(page.locator('#input')).toHaveValue('test:message-edit 复制 README');

    await expectNoBrowserErrors(page);
  });

  test('P0-03d Markdown sanitization blocks executable HTML while keeping safe markdown', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:unsafe-markdown');
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('safe bold markdown', { timeout: 20_000 });
    await waitForIdle(page);

    await expect(reply.locator('strong')).toContainText('safe bold markdown');
    await expect(reply.locator('code')).toContainText('safe_inline_code');

    const unsafeState = await reply.evaluate(el => {
      const win = window as typeof window & {
        __ccmUnsafeMarkdownScriptFired?: boolean;
        __ccmUnsafeMarkdownImageFired?: boolean;
        __ccmUnsafeMarkdownClickFired?: boolean;
      };
      return {
        scriptTags: el.querySelectorAll('script').length,
        eventAttributes: el.querySelectorAll('[onerror], [onclick], [onload]').length,
        javascriptHrefs: [...el.querySelectorAll('a')]
          .filter(a => /^javascript:/i.test(a.getAttribute('href') || '')).length,
        scriptFired: win.__ccmUnsafeMarkdownScriptFired === true,
        imageFired: win.__ccmUnsafeMarkdownImageFired === true,
        clickFired: win.__ccmUnsafeMarkdownClickFired === true
      };
    });
    expect(unsafeState).toEqual({
      scriptTags: 0,
      eventAttributes: 0,
      javascriptHrefs: 0,
      scriptFired: false,
      imageFired: false,
      clickFired: false
    });

    await expectNoBrowserErrors(page);
  });
});
