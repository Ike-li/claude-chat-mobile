// UI-001：设计 token 对比度程序化断言（WCAG 2.x AA 正文 ≥4.5）。
// 色值与 public/css/app.css :root 两主题保持同步；改 token 必改本表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../../public/css/app.css');
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
