// tests/unit/manifest.test.mjs —— PWA manifest 与 index.html PWA meta 静态契约测（零 token、零副作用）
// 防回归：maskable 图标被误删/丢 purpose、manifest 关键字段缺失、暗色 theme-color 与 :root dark 脱钩、
// 双 manifest 色板与 THEME_COLORS / 兼容路径不同步（#387）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { THEME_COLORS, MANIFEST_HREF } from '../../app/public/js/logic/theme.js';

const HERE = import.meta.dirname;
const PUB = join(HERE, '..', '..', 'app', 'public');
const light = JSON.parse(readFileSync(join(PUB, 'manifest-light.webmanifest'), 'utf8'));
const dark = JSON.parse(readFileSync(join(PUB, 'manifest-dark.webmanifest'), 'utf8'));
const legacy = JSON.parse(readFileSync(join(PUB, 'manifest.webmanifest'), 'utf8'));
const html = readFileSync(join(PUB, 'index.html'), 'utf8');
const bootSrc = readFileSync(join(PUB, 'js', 'theme-boot.js'), 'utf8');

const hasPurpose = (icon, p) => (icon.purpose || '').split(/\s+/).includes(p);

// 读 PNG IHDR 里的真实宽高（签名 8 字节 + 长度 4 字节 + "IHDR" 4 字节之后，宽/高各 4 字节大端）。
// 不用 pngjs 全量解码——只读文件头 24 字节即够，够本测试的目的（core-review P2：manifest sizes
// 字段此前从未反查真实像素，有人手滑换错尺寸的图也能通过全部测试）。
function pngDimensions(path) {
  const buf = readFileSync(path);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function assertIconsOk(manifest, label) {
  const maskable = manifest.icons.filter(i => hasPurpose(i, 'maskable'));
  const sizes = maskable.map(i => i.sizes);
  assert.ok(sizes.includes('192x192'), `${label}: 缺 maskable 192`);
  assert.ok(sizes.includes('512x512'), `${label}: 缺 maskable 512`);
  for (const i of manifest.icons) {
    assert.ok(existsSync(join(PUB, i.src.replace(/^\//, ''))), `${label}: 图标文件缺失: ${i.src}`);
    if (i.type !== 'image/png') continue;
    const [w, h] = i.sizes.split('x').map(Number);
    const real = pngDimensions(join(PUB, i.src.replace(/^\//, '')));
    assert.equal(real.width, w, `${label}: ${i.src} 真实宽度 ${real.width} ≠ manifest 声明 ${w}`);
    assert.equal(real.height, h, `${label}: ${i.src} 真实高度 ${real.height} ≠ manifest 声明 ${h}`);
  }
}

test('light/dark/legacy 三份 manifest 均有 maskable 192/512，且 PNG 尺寸与 sizes 一致', () => {
  assertIconsOk(light, 'light');
  assertIconsOk(dark, 'dark');
  assertIconsOk(legacy, 'legacy');
});

test('三份 manifest 共享 id / scope / launch_handler / short_name；仅色板不同', () => {
  for (const [label, m] of [['light', light], ['dark', dark], ['legacy', legacy]]) {
    assert.equal(m.id, '/', `${label}.id`);
    assert.equal(m.scope, '/', `${label}.scope`);
    assert.equal(m.launch_handler?.client_mode, 'focus-existing', `${label}.launch_handler`);
    assert.equal(m.short_name, 'CCM', `${label}.short_name`);
  }
  const { background_color: _lb, theme_color: _lt, ...lightRest } = light;
  const { background_color: _db, theme_color: _dt, ...darkRest } = dark;
  assert.deepEqual(darkRest, lightRest, 'dark 与 light 除色板外应完全一致');
  assert.deepEqual(legacy, light, '兼容路径 manifest.webmanifest 须与 light 字节级同形');
});

test('manifest 色板与 THEME_COLORS / index.html theme-color 同源', () => {
  assert.equal(light.theme_color, THEME_COLORS.light);
  assert.equal(light.background_color, THEME_COLORS.light);
  assert.equal(dark.theme_color, THEME_COLORS.dark);
  assert.equal(dark.background_color, THEME_COLORS.dark);
  assert.equal(MANIFEST_HREF.light, '/manifest-light.webmanifest');
  assert.equal(MANIFEST_HREF.dark, '/manifest-dark.webmanifest');
});

test('index.html theme-color 拆 light/dark 两条 media，暗色值与 :root dark --canvas 一致', () => {
  assert.match(html, /theme-color[^>]*prefers-color-scheme:\s*light[^>]*#F4F3EE/i, '缺 light theme-color');
  assert.match(html, /theme-color[^>]*prefers-color-scheme:\s*dark[^>]*#121211/i, '缺 dark theme-color(#121211)');
});

test('apple-touch-icon 指向 180×180（Apple 推荐尺寸）', () => {
  assert.match(html, /apple-touch-icon[^>]*180/i);
});

// CF Access 场景下浏览器抓 manifest 这个请求默认不带凭据——没有这个属性，
// 装 PWA 时 Access 会把这次匿名请求拦成登录页，manifest 解析失败，"添加到主屏幕" 直接不可用。
test('manifest link 带 crossorigin="use-credentials"（CF Access 保护下抓取需要带凭据，否则装不上 PWA）', () => {
  assert.match(html, /rel="manifest"[^>]*crossorigin="use-credentials"/);
});

test('index.html 默认挂 light manifest，且位于 theme-boot 之前（boot 才能改 href）', () => {
  assert.match(html, /rel="manifest"\s+href="\/manifest-light\.webmanifest"/);
  const manifestAt = html.indexOf('rel="manifest"');
  const bootAt = html.indexOf('/js/theme-boot.js');
  assert.ok(manifestAt >= 0 && bootAt >= 0 && manifestAt < bootAt, 'manifest link 必须在 theme-boot 之前');
});

test('theme-boot.js 字面量含双 manifest 路径（boot 不能 import module）', () => {
  assert.match(bootSrc, /\/manifest-light\.webmanifest/);
  assert.match(bootSrc, /\/manifest-dark\.webmanifest/);
});

// 主屏短名有两个独立来源（Android 读 manifest.short_name，iOS 读 apple-mobile-web-app-title），
// 改一处漏另一处会让两端主屏显示不同的名字——这里锁死「同一个值」而非各测各的。
test('主屏短名 = CCM，且 iOS/Android 两处不分叉', () => {
  const appleTitle = html.match(
    /<meta\s+name="apple-mobile-web-app-title"\s+content="([^"]*)"/i,
  )?.[1];
  assert.equal(light.short_name, 'CCM', 'manifest.short_name（Android 主屏名）');
  assert.equal(appleTitle, 'CCM', 'apple-mobile-web-app-title（iOS 主屏名）与 short_name 分叉');
});
