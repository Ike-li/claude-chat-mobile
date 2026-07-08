// test/manifest.test.mjs —— PWA manifest 与 index.html PWA meta 静态契约测（零 token、零副作用）
// 防回归：maskable 图标被误删/丢 purpose、manifest 关键字段缺失、暗色 theme-color 与 :root dark 脱钩。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const PUB = join(HERE, '..', 'public');
const manifest = JSON.parse(readFileSync(join(PUB, 'manifest.webmanifest'), 'utf8'));
const html = readFileSync(join(PUB, 'index.html'), 'utf8');

const hasPurpose = (icon, p) => (icon.purpose || '').split(/\s+/).includes(p);

test('manifest 有 maskable 192 与 512（Android 自适应图标不被裁）', () => {
  const maskable = manifest.icons.filter(i => hasPurpose(i, 'maskable'));
  const sizes = maskable.map(i => i.sizes);
  assert.ok(sizes.includes('192x192'), '缺 maskable 192');
  assert.ok(sizes.includes('512x512'), '缺 maskable 512');
});

test('manifest 引用的 maskable 图标文件真实存在', () => {
  for (const i of manifest.icons) {
    if (hasPurpose(i, 'maskable')) {
      assert.ok(existsSync(join(PUB, i.src.replace(/^\//, ''))), `图标文件缺失: ${i.src}`);
    }
  }
});

test('manifest 有 id / scope / launch_handler:focus-existing', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.launch_handler?.client_mode, 'focus-existing');
});

test('index.html theme-color 拆 light/dark 两条 media，暗色值与 :root dark --canvas 一致', () => {
  assert.match(html, /theme-color[^>]*prefers-color-scheme:\s*light[^>]*#F4F3EE/i, '缺 light theme-color');
  assert.match(html, /theme-color[^>]*prefers-color-scheme:\s*dark[^>]*#121211/i, '缺 dark theme-color(#121211)');
});

test('apple-touch-icon 指向 180×180（Apple 推荐尺寸）', () => {
  assert.match(html, /apple-touch-icon[^>]*180/i);
});
