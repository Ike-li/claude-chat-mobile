// 锁 session:list handler 不得再把 all=true 的 hasMore 强制成 false。
// listSessionsPage 的单测锁不住这一层——加回 `hasMore: all ? false : hasMore` 时 history 单测仍绿。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('session:list ack 不得在 all=true 时强制 hasMore=false', () => {
  const src = readFileSync(join(root, 'app/src/server/app.js'), 'utf8');
  const start = src.indexOf("on(socket, 'session:list'");
  const end = src.indexOf("on(socket, 'session:deletePermanent'");
  assert.ok(start >= 0 && end > start, '找不到 session:list / session:deletePermanent handler 边界');
  const handler = src.slice(start, end);
  assert.equal(
    /hasMore\s*:\s*all\s*\?\s*false/.test(handler),
    false,
    '禁止 `hasMore: all ? false : hasMore`——会把「还有更早的会话」对用户藏起来',
  );
  assert.match(handler, /hasMore,\s*total/);
});
