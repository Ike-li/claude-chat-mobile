// spec: 语义色的 Tailwind 透明度修饰（bg-danger/10、border-warning/40 …）真的渲染成半透明（#359 第 6 项）。
// helpers: tests/helpers/playwright.ts
//
// tw-config.js 曾把语义色写成裸 'var(--x)'：Tailwind 合不出 alpha，带 /NN 的类整条规则不产出——底色直接透明、
// 边框回落成默认灰、文字随父级，全仓几十处静默失效。这里扫页面上所有这类 class，逐个比对计算色的 alpha。

import { test, expect } from '@playwright/test';
import { expectNoBrowserErrors, gotoMock } from '../../helpers/playwright';

// class 里的色名 → :root 上的 token（与 tailwind.config.js 一致）
const TOKENS: Record<string, string> = {
  canvas: '--canvas', surface: '--surface', sunk: '--surface-sunk',
  ink: '--ink', 'ink-soft': '--ink-soft', 'ink-faint': '--ink-faint',
  accent: '--accent', 'accent-deep': '--accent-deep', 'accent-bright': '--accent-bright', 'accent-wash': '--accent-wash',
  cta: '--cta', user: '--user-bubble', info: '--info', success: '--success',
  danger: '--danger', 'danger-solid': '--danger-solid', warning: '--warning', line: '--line', 'line-soft': '--line-soft',
};

test.describe('P0 日常零 token Mock UI 回归', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`P0-TW-ALPHA ${scheme}：语义色带 /NN 的类渲染成对应透明度，不带的仍不透明`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await gotoMock(page);
      // 选中态卡片（model-tile 等）带 transition，刚加上 bg-accent-wash/30 时读到的是过渡中间值；关掉过渡读终态
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
      const result = await page.evaluate((tokens) => {
        // rgba(r, g, b, a) / rgb(r g b / a) / color(srgb r g b / a)（color-mix 的计算值）/ transparent
        const alphaOf = (c: string) => {
          if (c === 'transparent') return 0;
          let m = c.match(/\/\s*([\d.]+)(%?)\s*\)$/);
          if (m) return parseFloat(m[1]) / (m[2] ? 100 : 1);
          m = c.match(/^rgba\(([^)]+)\)$/);
          if (m) return parseFloat(m[1].split(',')[3]);
          return 1;
        };
        const probe = document.createElement('div');
        document.body.appendChild(probe);
        const tokenAlpha = (name: string) => { probe.style.backgroundColor = `var(${name})`; return alphaOf(getComputedStyle(probe).backgroundColor); };
        const prop = { bg: 'backgroundColor', border: 'borderTopColor', text: 'color' } as const;
        const re = new RegExp(`^(bg|border|text)-(${Object.keys(tokens).join('|')})/(\\d+)$`);
        let checked = 0;
        const bad: string[] = [];
        for (const el of Array.from(document.querySelectorAll('[class]'))) {
          for (const cls of Array.from(el.classList)) {
            const m = cls.match(re);
            if (!m) continue;
            checked++;
            const want = tokenAlpha(tokens[m[2]]) * Number(m[3]) / 100;
            const got = alphaOf(getComputedStyle(el)[prop[m[1] as keyof typeof prop]]);
            if (Math.abs(got - want) > 0.02) bad.push(`${el.id ? `#${el.id}` : el.tagName.toLowerCase()} .${cls}：alpha ${got}，应为 ${want.toFixed(2)}`);
          }
        }
        probe.remove();
        return { checked, bad, plainAlpha: alphaOf(getComputedStyle(document.body).backgroundColor) };
      }, TOKENS);
      expect(result.checked, '页面上没扫到带 /NN 的语义色 class，测试前提不成立').toBeGreaterThan(10);
      expect(result.bad).toEqual([]);
      expect(result.plainAlpha, 'body 的 bg-canvas（不带修饰）不该变透明').toBe(1);
      await expectNoBrowserErrors(page);
    });
  }
});

// app.css 自己也定义 --radius-lg；迁移到 v4 后不能让它改写工具类原来的固定尺寸。
test('P0-TW-SCALE：设计变量不改写工具类圆角，小号阴影和模糊保持原有尺寸', async ({ page }) => {
  await gotoMock(page);
  const styles = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'rounded-lg shadow-sm backdrop-blur-sm';
    probe.style.setProperty('--radius-lg', '99px');
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe);
    // Tailwind 会保留透明的 ring / inset 占位层；只比较实际可见的阴影。
    const shadow = computed.boxShadow.split(/,(?![^(]*\))/).map(value => value.trim())
      .filter(value => !value.startsWith('rgba(0, 0, 0, 0) '));
    const result = { radius: computed.borderRadius, shadow, blur: computed.backdropFilter };
    probe.remove();
    return result;
  });
  expect(styles.radius, 'rounded-lg 必须保留 8px，不继承 app.css 的同名设计变量').toBe('8px');
  expect(styles.shadow, 'shadow-sm 必须保留 v3 的 1px / 2px 小号阴影').toEqual(['rgba(0, 0, 0, 0.05) 0px 1px 2px 0px']);
  expect(styles.blur, 'backdrop-blur-sm 必须保留 v3 的 4px 模糊').toBe('blur(4px)');
  await expectNoBrowserErrors(page);
});
