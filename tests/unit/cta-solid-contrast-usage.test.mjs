// #390：实底白字必须用 bg-cta，禁止 bg-accent（深色 --accent 提亮后白字仅 ≈3.1:1）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAppJsSource } from '../helpers/frontend-source.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(root, 'app/public/index.html'), 'utf8');
const appJs = readAppJsSource();

test('#390 #envConfigSave 实底白字用 bg-cta（非 bg-accent）', () => {
  const m = html.match(/id="envConfigSave"[^>]*class="([^"]*)"/);
  assert.ok(m, '#envConfigSave 须存在');
  const cls = m[1];
  assert.match(cls, /\bbg-cta\b/, `#envConfigSave classes: ${cls}`);
  assert.doesNotMatch(cls, /\bbg-accent\b/, `#envConfigSave 不得用 bg-accent: ${cls}`);
  assert.match(cls, /\btext-white\b/, `#envConfigSave 须保留 text-white: ${cls}`);
});

test('#390 worktree 勾选 ✓ 实底用 bg-cta border-cta（非 accent）', () => {
  assert.match(
    appJs,
    /compose-worktree-toggle[\s\S]{0,400}bg-cta border-cta text-white/,
    '勾选态须 bg-cta border-cta text-white',
  );
  assert.doesNotMatch(
    appJs,
    /compose-worktree-toggle[\s\S]{0,400}bg-accent border-accent text-white/,
    '勾选态不得再写 bg-accent border-accent text-white',
  );
});

test('#390 禁止再引入实底白字 bg-accent（selection 高亮除外）', () => {
  const stripSelection = (s) => s.replace(/selection:bg-accent\/\d+/g, '');
  for (const [name, src] of [
    ['index.html', html],
    ['app.js', appJs],
  ]) {
    const cleaned = stripSelection(src);
    assert.doesNotMatch(
      cleaned,
      /bg-accent(?![-\w/])[^\n]{0,60}text-white|text-white[^\n]{0,60}bg-accent(?![-\w/])/,
      `${name} 不得出现 bg-accent + text-white 实底组合`,
    );
  }
});
