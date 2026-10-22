// spec: 小字与小按钮的实际对比度（验收 O79 / AC-21-03）。
// helpers: tests/helpers/playwright.ts
//
// token 本身的对比度由 tests/unit/contrast-tokens.test.mjs 钉住；这里钉的是【渲染出来的】那一份：
// 元素自己的 opacity、祖先的 opacity（消息操作栏整条 0.5）都会把字再压淡一截，token 达标也救不回来。
// 算法：计算色 × 沿祖先链累乘的 opacity，叠在最近一层不透明背景上，再按 WCAG 公式求对比度。
// 半透明的中间底色（如 bg-sunk/40）被跳过、按其下的不透明底算——误差方向是略偏乐观，所以 token 测试另外覆盖了 sunk。

import { test, expect, type Locator } from '@playwright/test';
import { ensureComposerReady, expectNoBrowserErrors, gotoMock, openSettingsSection, sendChatMessage, waitForIdle } from '../../helpers/playwright';
import { MAIN_WORKSPACE, expandWorkspace, openSessionsSidebar } from '../../helpers/sidebar-ui';

async function effectiveContrast(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const parse = (s: string) => {
      const p = (s.match(/rgba?\(([^)]+)\)/)?.[1] || '0,0,0,0').split(',').map(x => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
    };
    let opacity = 1;
    for (let n: Element | null = el; n; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity);
    let bg: { r: number; g: number; b: number; a: number } | null = null;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.a > 0.99) { bg = c; break; }
    }
    if (!bg) bg = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (bg.a <= 0.99) bg = { r: 255, g: 255, b: 255, a: 1 };
    const fg = parse(getComputedStyle(el).color);
    const a = fg.a * opacity;
    const f = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
    const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = (c: { r: number; g: number; b: number }) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const l1 = L(f), l2 = L(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  });
}

test.describe('P0 日常零 token Mock UI 回归', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`P0-A11Y-CONTRAST ${scheme}：代码块复制、消息复制、状态栏折叠箭头与小字都 ≥4.5:1`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await gotoMock(page);
      await sendChatMessage(page, 'test:stream');
      const last = page.locator('[data-testid="assistant-message"]').last();
      await expect(last.locator('pre code')).toContainText('tester', { timeout: 20_000 });
      await waitForIdle(page);

      const targets: Array<[string, Locator]> = [
        ['代码块「复制」', last.locator('.code-copy-btn').first()],
        ['消息「复制」', last.locator('.msg-action-btn').first()],
        ['状态栏折叠箭头', page.locator('#cliStatusWrap .cli-arrow')],
        ['状态栏「复制」小字', page.locator('#cliStatusCopy')],
      ];
      for (const [label, loc] of targets) {
        await expect(loc, `${label} 没渲染出来`).toBeVisible();
        const ratio = await effectiveContrast(loc);
        expect(ratio, `${scheme} ${label} 对比度 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
      await expectNoBrowserErrors(page);
    });

    // 验收 O102：不走 token 的几处——第三方配色（hljs github 主题、CM5 默认主题）、Tailwind 原色叠透明度
    // （Bypass 说明的 text-red-500/80）、白字压实底红（侧滑露出的「关闭」）。token 本身由 contrast-tokens 单测钉。
    test(`P0-A11Y-CONTRAST3 ${scheme}：代码高亮、Bypass 说明、侧滑「关闭」、markdown 标题 ≥4.5:1`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await gotoMock(page);
      await sendChatMessage(page, 'test:stream');
      const last = page.locator('[data-testid="assistant-message"]').last();
      await expect(last.locator('pre code')).toContainText('tester', { timeout: 20_000 });
      await waitForIdle(page);

      const targets: Array<[string, Locator]> = [
        ['代码块关键字 const', last.locator('pre code .hljs-keyword').first()],
      ];
      for (const [label, loc] of targets) {
        await expect(loc, `${label} 没渲染出来`).toBeVisible();
        const ratio = await effectiveContrast(loc);
        expect(ratio, `${scheme} ${label} 对比度 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }

      await page.locator('#pillDefaults').click();
      await openSettingsSection(page, 'perm');
      const bypassDesc = page.locator('.perm-tile[data-mode="bypassPermissions"] > div').nth(1);
      await expect(bypassDesc).toBeVisible();
      const descRatio = await effectiveContrast(bypassDesc);
      expect(descRatio, `${scheme} Bypass 说明对比度 ${descRatio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press('Escape');

      // 侧滑「关闭」平时压在行内容下面，不可见也照样按它自己的实底算
      await openSessionsSidebar(page);
      const swipeClose = page.locator('.swipe-row-container > div', { hasText: /^关闭$/ }).first();
      await expect(swipeClose).toHaveCount(1);
      const closeRatio = await effectiveContrast(swipeClose);
      expect(closeRatio, `${scheme} 侧滑「关闭」对比度 ${closeRatio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      await expectNoBrowserErrors(page);
    });

    // Codex review：确认 sheet 的危险档按钮（彻底删除、吊销设备、开 Bypass、重启服务）同样是白字压实底红
    test(`P0-A11Y-CONTRAST5 ${scheme}：危险确认按钮的白字 ≥4.5:1`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await gotoMock(page);
      await openSessionsSidebar(page);
      await expandWorkspace(page, MAIN_WORKSPACE);
      await page.locator('[data-testid="session-row"][data-session-id="mock-session-archived"]').getByTestId('session-delete').click();
      const ok = page.locator('#confirmOk');
      await expect(ok).toHaveText('彻底删除');
      await expect(page.locator('#confirmModal')).toHaveClass(/sheet-open/);
      // sheet 是淡入的：祖先 opacity 还没到 1 时量到的是过渡中的值，等它稳定（稳态不达标会在这里超时变红）
      await expect.poll(() => effectiveContrast(ok), { message: `${scheme} 「彻底删除」白字对比度` }).toBeGreaterThanOrEqual(4.5);
      await expectNoBrowserErrors(page);
    });

    test(`P0-A11Y-CONTRAST4 ${scheme}：文件页 markdown 标题 ≥4.5:1`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await gotoMock(page);
      await page.locator('#topContextPill').click();
      await page.locator('[data-testid="browse-entry"]', { hasText: 'README.md' }).click();
      const header = page.locator('#fileBrowseBody .cm-header').first();
      await expect(header).toContainText('CCM playground workspace');
      const ratio = await effectiveContrast(header);
      expect(ratio, `${scheme} markdown 标题对比度 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      const link = page.locator('#fileBrowseBody .cm-link').first();
      await expect(link).toContainText('docs');
      const linkRatio = await effectiveContrast(link);
      expect(linkRatio, `${scheme} markdown 链接对比度 ${linkRatio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      await expectNoBrowserErrors(page);
    });

    // #244 review：空输入框获得焦点时露出的「/ · @」提示，10px ink-faint 上还叠着 opacity 0.75。
    test(`P0-A11Y-CONTRAST2 ${scheme}：输入框聚焦时的「/ · @」提示 ≥4.5:1`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await gotoMock(page);
      await ensureComposerReady(page);
      await page.locator('#input').focus();
      const hint = page.locator('#composerDiscoverHint');
      await expect(hint, '提示没露出来').toBeVisible();
      const ratio = await effectiveContrast(hint);
      expect(ratio, `${scheme} 输入框提示对比度 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      await expectNoBrowserErrors(page);
    });
  }
});
