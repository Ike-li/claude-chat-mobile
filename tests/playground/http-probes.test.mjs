// 长驻 app 接线探针。整次 run 未鉴权失败预算为 0：不要打无 token 的 /health 或 socket。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TOKEN = 'playground-local-not-a-secret';
const BASE = 'http://127.0.0.1:3000';

test('GET / without token is the static shell', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /id="authGate"/);
});

test('GET /js/app.js without token', async () => {
  const res = await fetch(`${BASE}/js/app.js`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.length > 0);
});

test('GET /health with playground token', async () => {
  const res = await fetch(`${BASE}/health?token=${encodeURIComponent(TOKEN)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.match(String(body.versions?.cli ?? ''), /0\.0\.0-fake/);
});

test('GET /metrics with x-auth-token', async () => {
  const res = await fetch(`${BASE}/metrics`, { headers: { 'x-auth-token': TOKEN } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.metrics || body.timestamp);
});
