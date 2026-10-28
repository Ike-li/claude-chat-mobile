// #392：@ / 斜杠候选浮层须带 listbox/option 与键盘接线（静态源检）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const appJs = readFileSync(join(root, 'app/public/js/app.js'), 'utf8');
const html = readFileSync(join(root, 'app/public/index.html'), 'utf8');

test('#392 #cmdHints / #atMentionHints 创建时带 role=listbox', () => {
  assert.match(appJs, /id="cmdHints"[^`]*role="listbox"/, 'cmdHints 须 role=listbox');
  assert.match(appJs, /id="atMentionHints"[^`]*role="listbox"/, 'atMentionHints 须 role=listbox');
});

test('#392 候选行须 role=option + aria-selected，并用 resolveComposerHintKeydown', () => {
  assert.match(appJs, /role="option"[^`]*aria-selected="false"[^`]*data-cmd/, '斜杠行须 option');
  assert.match(appJs, /role="option"[^`]*aria-selected="false"[^`]*data-path|role="option"[^`]*data-path[^`]*aria-selected/, '引用行须 option');
  assert.match(appJs, /resolveComposerHintKeydown/, '须接线纯函数键盘路由');
  assert.match(appJs, /aria-activedescendant/, 'textarea 须维护 aria-activedescendant');
  assert.match(appJs, /aria-expanded/, 'textarea 须维护 aria-expanded');
});

test('#392 #input 基线 aria-autocomplete / haspopup', () => {
  const m = html.match(/<textarea id="input"[^>]*>/);
  assert.ok(m, '#input textarea 须存在');
  assert.match(m[0], /aria-autocomplete="list"/);
  assert.match(m[0], /aria-haspopup="listbox"/);
  assert.match(m[0], /aria-expanded="false"/);
});
