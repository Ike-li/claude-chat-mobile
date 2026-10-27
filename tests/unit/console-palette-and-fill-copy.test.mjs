// #368：交互日志抽屉用 --console-* 设计 token，禁止 Tailwind gray 冷灰块
// #362：「填入输入框」文案——只回填，不暗示 rewind / Edit & resend
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const css = readFileSync(join(root, 'app/public/css/app.css'), 'utf8');
const tw = readFileSync(join(root, 'app/public/js/tw-config.js'), 'utf8');
const html = readFileSync(join(root, 'app/public/index.html'), 'utf8');
const appJs = readFileSync(join(root, 'app/public/js/app.js'), 'utf8');
const i18n = readFileSync(join(root, 'app/public/js/i18n.js'), 'utf8');

function consoleModalBlock() {
  const m = html.match(/<div id="consoleModal"[\s\S]*?<\/div>\s*<\/div>\s*\n\s*<!-- 工作区面板/);
  assert.ok(m, '#consoleModal 块须存在');
  return m[0];
}

test('#368 app.css 定义 --console-* 深色终端色板', () => {
  for (const name of [
    'console-bg', 'console-surface', 'console-sunk', 'console-line',
    'console-ink', 'console-ink-soft', 'console-ink-faint',
  ]) {
    assert.match(css, new RegExp(`--${name}\\s*:`), `missing --${name}`);
  }
  // 与深色 --canvas / --surface / --ink 同源（温色，非 Tailwind gray）
  assert.match(css, /--console-bg\s*:\s*#121211/i);
  assert.match(css, /--console-surface\s*:\s*#1C1B1A/i);
  assert.match(css, /--console-ink\s*:\s*#EEEEEC/i);
});

test('#368 tw-config 桥接 console 语义色', () => {
  assert.match(tw, /console\s*:\s*\{/);
  assert.match(tw, /DEFAULT:\s*'var\(--console-bg\)'/);
  assert.match(tw, /ink:\s*'var\(--console-ink\)'/);
});

test('#368 #consoleModal 壳层不用 Tailwind gray-*', () => {
  const block = consoleModalBlock();
  assert.doesNotMatch(block, /\b(?:bg|text|border|hover:bg|hover:text|hover:border)-gray-\d+/);
  assert.match(block, /\bbg-console\b|\bbg-console\/95\b/);
  assert.match(block, /\bborder-console-line\b/);
  assert.match(block, /\btext-console-ink\b/);
  assert.match(block, /id="consoleClose"[^>]*\btext-console-ink-soft\b/);
  assert.match(block, /id="consoleFilterAll"[^>]*\bbg-console-sunk\b/);
});

test('#368 过滤钮切换与默认日志正文用 console-*（非 gray）', () => {
  assert.match(appJs, /classList\.toggle\('bg-console-sunk',\s*active\)/);
  assert.match(appJs, /classList\.toggle\('text-console-ink',\s*active\)/);
  assert.match(appJs, /classList\.toggle\('text-console-ink-faint',\s*!active\)/);
  assert.doesNotMatch(appJs, /classList\.toggle\('bg-gray-\d+'/);
  assert.doesNotMatch(appJs, /classList\.toggle\('text-gray-\d+'/);
  assert.match(appJs, /textClass = 'text-console-ink'/);
  assert.match(appJs, /bg-console-surface text-console-ink-soft border border-console-line/);
  assert.doesNotMatch(
    appJs,
    /tsSpan\.className = 'text-gray-/,
    '时间戳不得再用 text-gray-*',
  );
});

test('#362 用户气泡动作文案为「填入输入框」，词典无「改写重发」', () => {
  assert.match(appJs, /\$\{t\('填入输入框'\)\}/);
  assert.match(appJs, /\$\{t\('将原文填入输入框（不回退历史）'\)\}/);
  assert.doesNotMatch(appJs, /t\('改写重发'\)|t\('改写后重发'\)/);
  assert.match(i18n, /'填入输入框'\s*:\s*'Fill into input'/);
  assert.match(i18n, /'将原文填入输入框（不回退历史）'\s*:/);
  assert.doesNotMatch(i18n, /'改写重发'\s*:/);
  assert.doesNotMatch(i18n, /'改写后重发'\s*:/);
  assert.doesNotMatch(i18n, /Edit & resend|Edit and resend/);
});
