// #364：全局 :focus-visible 焦点环契约——键盘可见、鼠标点击不留粘性 outline。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const css = readFileSync(join(root, 'app/public/css/app.css'), 'utf8');

const FOCUS_VISIBLE_RULE =
  /:where\(\s*button\s*,\s*\[role=["']button["']\]\s*,\s*a\s*,\s*input\s*,\s*textarea\s*,\s*select\s*,\s*summary\s*\)\s*:focus-visible\s*\{([^}]*)\}/;

test('#364 app.css 为可交互控件提供 :focus-visible 焦点环', () => {
  const m = css.match(FOCUS_VISIBLE_RULE);
  assert.ok(m, '须有 button/[role=button]/a/input/textarea/select/summary 的 :focus-visible 规则');
  assert.match(m[1], /outline:\s*2px\s+solid\s+var\(--accent\)/, '焦点环须用 --accent');
  assert.match(m[1], /outline-offset:\s*2px/, '须有 outline-offset: 2px');
});

test('#364 焦点环用 :focus-visible 而非裸 :focus（避免鼠标粘性描边）', () => {
  assert.match(css, /:focus-visible\s*\{/, '须使用 :focus-visible');
  // 同一 :where(...) 组不得挂裸 :focus（:focus-visible 除外）
  assert.doesNotMatch(
    css,
    /:where\(\s*button\s*,\s*\[role=["']button["']\][\s\S]*?\)\s*:focus(?!-visible)\s*\{/,
    '不得对全局可交互组使用裸 :focus',
  );
  const hitAfter = css.match(/\.hit-44::after\s*\{([^}]*)\}/);
  assert.ok(hitAfter, '须保留 .hit-44::after 热区规则');
  assert.doesNotMatch(hitAfter[1], /outline\s*:/, '不得对 .hit-44::after 加 outline');
});
