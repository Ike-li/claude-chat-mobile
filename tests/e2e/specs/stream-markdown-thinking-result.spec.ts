// helpers: tests/helpers/playwright.ts

import { test, expect } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, sendChatMessage, waitForIdle } from '../../helpers/playwright';

test.describe('P0 日常零 token Mock UI 回归', () => {
  test('P0-03 流式回复、Markdown、thinking 与结果栏', async ({ page }) => {
    await gotoMock(page);

    // 1. 起始状态/假设：fresh state。向聊天输入框发送 test:stream。
    await sendChatMessage(page, 'test:stream');
    await expect(page.locator('[data-testid="user-message"]').last()).toContainText('test:stream');
    await expect(page.locator('#streamLiveStatus')).toBeVisible();
    // CLI 式动态状态行：✻ 动词… (Ns …)；thinking_delta 已到 → thinking 段（进行中或已收束为 thought for）
    await expect(page.locator('#streamLiveStatusText')).toContainText(/^✻ .+… \(\d+s/);
    await expect(page.locator('#streamLiveStatusText')).toContainText(/thinking|thought for/);
    await expect(page.locator('#btnSend')).toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('details.thinking')).toBeVisible();
    // status_line.turn 权威帧 → ↓ token 段；秒表已 ≥1s（startedAt 提前 1.5s，断言轮询免 1s 粒度 flake）
    await expect(page.locator('#streamLiveStatusText')).toContainText(/↓ 3\.3k tokens/);
    await expect(page.locator('#streamLiveStatusText')).toContainText(/\([1-9]\d*s/);
    // 正文开流 → thinking 阶段事件驱动收束为 thought for Ns
    await expect(page.locator('#streamLiveStatusText')).toContainText(/thought for \d+s/);

    // 2. 等待流式输出结束。
    await expect(page.locator('[data-testid="assistant-message"]').last()).toContainText('fully visual-oriented', { timeout: 20_000 });
    await waitForIdle(page);
    await expect(page.locator('#messages strong').first()).toContainText('fully visual-oriented');
    await expect(page.locator('[data-testid="assistant-message"]').last().locator('pre')).toBeVisible();
    await expect(page.locator('[data-testid="assistant-message"]').last().locator('pre code')).toContainText('tester');
    // 回合收尾行对齐 CLI turn_duration：✻ <过去式动词> for <时长>（动词随机，累计 cost 不再挂后缀）
    await expect(page.locator('#messages .msg-frame.text-center.text-xs.text-ink-faint').last())
      .toHaveText(/^✻ (Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked) for \d+s$/);

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

  test('P0-03c 用户气泡「改写重发」填回提问原文（UX-012）', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:message-edit 复制 README');
    await waitForIdle(page);
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('message edit fixture');
    // UX-012：改写重发放在用户气泡，不再挂在助手动作栏
    const user = page.locator('[data-testid="user-message"]').last();
    await user.getByRole('button', { name: /改写重发/ }).click();
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
    await expect(reply.locator('code', { hasText: 'safe_inline_code' })).toHaveCount(1);

    // class 走白名单：Tailwind 运行时会把任意 class 现编成 CSS，工具类不剥就能做出盖住审批按钮的遮罩；
    // 而 markdown 自己产出的 language-xxx 必须留下（hljs 靠它选语言）。
    const overlay = reply.locator('[data-probe="class-overlay"]');
    await expect(overlay).toHaveCount(1);
    expect(await overlay.evaluate(el => ({ cls: el.getAttribute('class'), position: getComputedStyle(el).position })))
      .toEqual({ cls: null, position: 'static' });
    await expect(reply.locator('pre code')).toHaveClass(/\blanguage-js\b/);

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

  // result.text 是服务端随每轮收尾下发的权威全文（供前端断网恢复后校正因遗漏 text_delta 而
  // 截断的内容）。mock 场景刻意只发一小段 delta，result.text 带着更长的权威全文——断言最终
  // 渲染的是全文而不是 delta 累积的截断版本。
  test('P0-03e result.text 权威全文覆盖因遗漏 text_delta 而截断的内容', async ({ page }) => {
    await gotoMock(page);

    await sendChatMessage(page, 'test:result-text-recovery');
    await waitForIdle(page);

    // 这个字符串只存在于 result.text，不在 text_delta 里——出现即证明覆盖生效了
    // （若覆盖逻辑被删/改错，渲染内容只会停在 delta 累积的 'TRUNCATED-PREFIX-ONLY'）。
    const reply = page.locator('[data-testid="assistant-message"]').last();
    await expect(reply).toContainText('AUTHORITATIVE-FULL-TEXT');
    // 覆盖是整体替换（s.raw = p.text）而非追加：若误写成追加，delta 前缀会重复出现两次。
    const rendered = await reply.innerText();
    expect(rendered.split('TRUNCATED-PREFIX-ONLY').length - 1).toBe(1);

    await expectNoBrowserErrors(page);
  });
});
