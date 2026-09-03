// playground mock profile 接线。聊天契约仍由 tests/e2e/p0 + test:docker:e2e 覆盖。
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('mock /__ready is reachable on the compose network', async () => {
  const res = await fetch('http://mock:3100/__ready');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});
