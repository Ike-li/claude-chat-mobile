// #383：抽屉会话行「未读」chip 必须是看得见、点得着的标已读入口（不只挂在「⋯」/长按里）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const appJs = readFileSync(join(root, 'app/public/js/app.js'), 'utf8');
const i18nJs = readFileSync(join(root, 'app/public/js/i18n.js'), 'utf8');

test('#383 会话行 unread-mark 是 role=button + tabindex，点按走 setManualUnread(false)', () => {
  assert.match(
    appJs,
    /data-testid="unread-mark"[^>]*role="button"[^>]*tabindex="0"/,
  );
  // 点按 / Enter / Space 都要拦住冒泡，否则会落到外面的会话打开按钮上
  assert.match(appJs, /mark\.onclick = onMarkActivate/);
  assert.match(
    appJs,
    /mark\.onkeydown = \(e\) => \{ if \(e\.key === 'Enter' \|\| e\.key === ' '\) onMarkActivate\(e\); \}/,
  );
  assert.match(appJs, /onMarkActivate[\s\S]{0,200}?e\.stopPropagation\(\)/);
  assert.match(appJs, /unread\.setManualUnread\(s\.id, false\)/);
});

test('#383 unread-mark 的 aria-label 说明「点按标为已读」，不只报「未读」', () => {
  assert.match(appJs, /\$\{t\('未读'\)\} · \$\{t\('点按标为已读'\)\}/);
  assert.match(i18nJs, /'点按标为已读': 'Tap to mark as read'/);
});

test('#383 「⋯」菜单仍保留 toggle-read（chip 只覆盖已未读 → 标已读；标未读仍靠菜单）', () => {
  assert.match(appJs, /action === 'toggle-read'/);
  assert.match(appJs, /data-testid="session-menu"/);
});
