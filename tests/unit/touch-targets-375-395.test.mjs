// #375 / #395：消息操作栏热区互不重叠；断线重试与长消息「展开」达到触控热区。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAppJsSource } from '../helpers/frontend-source.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const css = readFileSync(join(root, 'app/public/css/app.css'), 'utf8');
const appJs = readAppJsSource();

function ruleBody(selector) {
  // Non-greedy body until the matching close brace (single-level rules only).
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  assert.ok(m, `缺少规则 ${selector}`);
  return m[1];
}

test('#375 .msg-action-btn::after 横向不扩，避免与相邻操作钮热区重叠', () => {
  const body = ruleBody('.msg-action-btn::after');
  assert.match(body, /inset:\s*-7px\s+0\s*;/, '须为 inset: -7px 0（纵向扩、横向不动）');
  assert.doesNotMatch(body, /inset:\s*-7px\s+-6px/, '不得恢复左右 -6px 横向扩展');
});

test('#375 .msg-action-bar 保留 gap，热区相接而不重叠', () => {
  const body = ruleBody('.msg-action-bar');
  assert.match(body, /gap:\s*0\.5rem/, '操作栏 gap 须保持 0.5rem（8px）');
});

test('#395 .conn-banner__retry 自身抬到 ≥32px，不用向外扩的 ::after', () => {
  const body = ruleBody('.conn-banner__retry');
  assert.match(body, /min-height:\s*32px/, '立即重试须 min-height: 32px');
  assert.match(body, /padding:\s*0\.3rem\s+0\.75rem/, '须加大 padding');
  assert.doesNotMatch(body, /min-height:\s*26px/, '不得回落到 26px');
  assert.doesNotMatch(css, /\.conn-banner__retry::after\s*\{/, '不得用 ::after 外扩压住下方消息');
});

test('#395 长用户消息「展开」按钮挂 hit-44', () => {
  assert.match(
    appJs,
    /hit-44[^`]*\$\{t\(['"]展开['"]\)\}|class="hit-44[^"]*"\$\{?[^`]*展开/,
    'foldLongUserText 的展开按钮须带 hit-44',
  );
  // Tighter: the exact template used by foldLongUserText
  assert.match(
    appJs,
    /el\(`<button type="button" class="hit-44 text-xs text-accent mt-1 block">\$\{t\('展开'\)\}<\/button>`\)/,
    '展开按钮模板须为 hit-44 + type=button',
  );
});
