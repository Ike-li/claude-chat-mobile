// UI-001：设计 token 对比度程序化断言（WCAG 2.x AA 正文 ≥4.5）。
// 色值与 app/public/css/app.css :root 两主题保持同步；改 token 必改本表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../app/public/css/app.css');
const css = readFileSync(cssPath, 'utf8');

function lin(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function relativeLuminance(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrastRatio(a, b) {
  const L1 = relativeLuminance(a);
  const L2 = relativeLuminance(b);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

/** 从 css 文本里抽 :root 块内 `--name:#hex`（首个 :root = 浅色；dark 媒体内 :root = 深色） */
function tokenMap(block) {
  const map = {};
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})/g)) {
    map[m[1]] = m[2].toUpperCase();
  }
  return map;
}

const lightRoot = css.match(/:root\s*\{([^}]+)\}/)?.[1] || '';
const darkRoot = css.match(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/)?.[1] || '';
const light = tokenMap(lightRoot);
const dark = { ...light, ...tokenMap(darkRoot) }; // dark 覆盖同名

test('UI-001 token 表可从 app.css 解析出浅色/深色关键色', () => {
  for (const k of ['surface', 'accent', 'cta', 'warning', 'danger', 'info']) {
    assert.ok(light[k], `light missing --${k}`);
  }
  for (const k of ['surface', 'accent', 'cta', 'warning', 'danger', 'info']) {
    assert.ok(dark[k], `dark missing --${k}`);
  }
});

test('UI-001 浅色：白字/cta 底 ≥4.5', () => {
  assert.ok(contrastRatio('#FFFFFF', light.cta) >= 4.5, contrastRatio('#FFFFFF', light.cta));
});

test('UI-001 浅色：accent 文字/surface ≥4.5', () => {
  assert.ok(contrastRatio(light.accent, light.surface) >= 4.5, contrastRatio(light.accent, light.surface));
});

test('UI-001 浅色：warning 文字/surface ≥4.5', () => {
  assert.ok(contrastRatio(light.warning, light.surface) >= 4.5, contrastRatio(light.warning, light.surface));
});

test('UI-001 深色：白字/cta 底 ≥4.5', () => {
  assert.ok(contrastRatio('#FFFFFF', dark.cta) >= 4.5, contrastRatio('#FFFFFF', dark.cta));
});

test('UI-001 深色：danger 文字/surface ≥4.5', () => {
  assert.ok(contrastRatio(dark.danger, dark.surface) >= 4.5, contrastRatio(dark.danger, dark.surface));
});

test('UI-001 深色：info 文字/surface ≥4.5', () => {
  assert.ok(contrastRatio(dark.info, dark.surface) >= 4.5, contrastRatio(dark.info, dark.surface));
});

// 验收 O79（AC-21-03）：次要文字（text-ink-faint 的时间戳、副标题、小按钮）深色下只有 3.5–3.9:1。它是小字（10–11px），
// AA 要求 4.5。ink-faint 会落在 surface / canvas / surface-sunk / 用户气泡四种底上，四种都要过。
for (const [name, theme] of [['浅色', light], ['深色', dark]]) {
  test(`O79 ${name}：ink-faint 小字在 surface / canvas / surface-sunk / user-bubble 上都 ≥4.5`, () => {
    for (const bg of ['surface', 'canvas', 'surface-sunk', 'user-bubble']) {
      const ratio = contrastRatio(theme['ink-faint'], theme[bg]);
      assert.ok(ratio >= 4.5, `ink-faint / ${bg} = ${ratio.toFixed(2)}`);
    }
  });
}

// #244 review：连接横幅的小字（断线多久那一行，10px）落在 color-mix(<tone> N%, surface) 的横幅底上，不是 surface。
// 深色 warn 底上 ink-faint 只有约 4.18。从 app.css 里读出小字用的 token 与三种横幅底的配比，按 sRGB 线性混合算底色。
function mixHex(a, pct, b) {
  const ch = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return '#' + [0, 1, 2].map(i => Math.round(ch(a, i) * pct + ch(b, i) * (1 - pct)).toString(16).padStart(2, '0')).join('').toUpperCase();
}
const detailToken = css.match(/\.conn-banner__detail\s*\{[^}]*?color:\s*var\(--([a-z0-9-]+)\)/)?.[1];
const bannerTones = [...css.matchAll(/\.conn-banner--([a-z]+)\s*\{[^}]*?background:\s*color-mix\(in srgb,\s*var\(--([a-z0-9-]+)\)\s*(\d+)%,\s*var\(--surface\)\)/g)]
  .map(m => ({ tone: m[1], token: m[2], pct: Number(m[3]) / 100 }));
for (const [name, theme] of [['浅色', light], ['深色', dark]]) {
  test(`#244 ${name}：连接横幅的小字在 info / warn / success 三种横幅底上都 ≥4.5`, () => {
    assert.ok(detailToken && theme[detailToken], `读不出 .conn-banner__detail 的颜色 token：${detailToken}`);
    assert.equal(bannerTones.length, 3, JSON.stringify(bannerTones));
    for (const { tone, token, pct } of bannerTones) {
      const bg = mixHex(theme[token], pct, theme.surface);
      const ratio = contrastRatio(theme[detailToken], bg);
      assert.ok(ratio >= 4.5, `${tone}（${bg}）上 ${detailToken} = ${ratio.toFixed(2)}`);
    }
  });
}

// 验收 O102（AC-21-03）：语义色作为【文字】落在五种底上——surface / canvas / surface-sunk（未读 chip、代码块）/
// user-bubble（用户消息「展开」）/ accent-wash（语言选中项「中文 ✓」）。浅色 accent 在 wash 上只有 4.15、
// sunk 上 4.41；深色 danger 在 bubble 上 4.31；success 两套主题都不到 4.5（深色此前直接沿用浅色值）。
for (const [name, theme] of [['浅色', light], ['深色', dark]]) {
  test(`O102 ${name}：accent / danger / warning / info / success 文字在五种底上都 ≥4.5`, () => {
    const fails = [];
    for (const fg of ['accent', 'danger', 'warning', 'info', 'success']) {
      for (const bg of ['surface', 'canvas', 'surface-sunk', 'user-bubble', 'accent-wash']) {
        const ratio = contrastRatio(theme[fg], theme[bg]);
        if (ratio < 4.5) fails.push(`${fg} / ${bg} = ${ratio.toFixed(2)}`);
      }
    }
    assert.deepEqual(fails, []);
  });

  // 横幅主文案（「连接已断开…」与 ⚙）用的就是横幅自己的语气色，落在 color-mix 出来的淡底上：浅色 warn 只有 4.25。
  test(`O102 ${name}：warn / success 横幅的主文案在自己的淡底上 ≥4.5`, () => {
    for (const { tone, token, pct } of bannerTones.filter(b => b.tone !== 'info')) {
      const bg = mixHex(theme[token], pct, theme.surface);
      const ratio = contrastRatio(theme[token], bg);
      assert.ok(ratio >= 4.5, `${tone}（${bg}）上 ${token} = ${ratio.toFixed(2)}`);
    }
  });

  // 抽屉行侧滑露出的「关闭」是白字压实底红：深色 danger 为了当文字够亮而提亮，当底色白字只剩 3.5。
  // 实底另用 danger-solid（同 cta 的做法：深色实底仍用深一档的红）。
  test(`O102 ${name}：danger-solid 实底上的白字 ≥4.5`, () => {
    assert.ok(theme['danger-solid'], '缺 --danger-solid');
    const ratio = contrastRatio('#FFFFFF', theme['danger-solid']);
    assert.ok(ratio >= 4.5, `white / danger-solid = ${ratio.toFixed(2)}`);
  });
}
