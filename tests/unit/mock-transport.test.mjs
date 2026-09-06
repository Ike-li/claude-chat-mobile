// tests/unit/mock-transport.test.mjs —— E2E 假后端的就绪探针绑定
// 探针必须绑到【本轮 spawn 的 server】（nonce 匹配）——端口上残留的旧进程回 409，
// 否则 Playwright 会对着一个错误的进程跑完整套 P0 契约并给出假绿/假红。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMockTransport } from '../e2e/mock/transport.js';

test('visual mock transport readiness probe is bound to the current build nonce', async t => {
  const { httpServer } = createMockTransport({ buildNonce: 'test-build-nonce' });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => httpServer.close(resolve)));
  const { port } = httpServer.address();

  const ready = await fetch(`http://127.0.0.1:${port}/__ready?nonce=test-build-nonce`);
  const stale = await fetch(`http://127.0.0.1:${port}/__ready?nonce=another-build`);

  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, nonce: 'test-build-nonce' });
  assert.equal(stale.status, 409);
});
