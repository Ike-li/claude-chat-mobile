import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHttpAuth,
  rewriteAppModuleImports,
  rewriteIndexAssetUrls,
  setSecurityHeaders,
  tokenMatches,
} from '../../src/server/http.js';

// 前端拆到 public/js/app/* 后，若只给 logic.js 打 ?v=，connection-sync 等子模块会吃浏览器缓存——
// 手机顶栏「延迟」改文案却不生效就是这个坑。与 e2e mock transport 对齐：所有相对 import + css 都戳版本。
test('rewriteAppModuleImports versions every relative ESM import, not only logic.js', () => {
  const src = [
    "import { createRttMonitor } from './app/connection-sync.js';",
    'import { esc } from "./logic.js";',
    "import { x } from '../logic.js';",
    "export const keep = from('./not-an-import.js');", // 非 import 语法不误伤
  ].join('\n');
  const out = rewriteAppModuleImports(src, 'abc12345');
  assert.match(out, /from '\.\/app\/connection-sync\.js\?v=abc12345'/);
  assert.match(out, /from '\.\/logic\.js\?v=abc12345'/);
  assert.match(out, /from '\.\.\/logic\.js\?v=abc12345'/);
  assert.match(out, /from\('\.\/not-an-import\.js'\)/); // 保持原样
});

test('rewriteIndexAssetUrls versions js and css under /js and /css', () => {
  const html = [
    '<script type="module" src="/js/app.js"></script>',
    '<script src="/js/sw-cleanup.js"></script>',
    '<link rel="stylesheet" href="/css/app.css">',
    '<link rel="icon" href="/icons/icon.svg">',
  ].join('\n');
  const out = rewriteIndexAssetUrls(html, 'deadbeef');
  assert.match(out, /\/js\/app\.js\?v=deadbeef/);
  assert.match(out, /\/js\/sw-cleanup\.js\?v=deadbeef/);
  assert.match(out, /\/css\/app\.css\?v=deadbeef/);
  assert.match(out, /\/icons\/icon\.svg"/); // 图标不进 assetVersion 链
  // 已带 ?v= 的不重复追加
  assert.equal(
    rewriteIndexAssetUrls('/js/app.js?v=old', 'new'),
    '/js/app.js?v=old',
  );
});

test('tokenMatches compares exact byte sequences and rejects missing configuration', () => {
  assert.equal(tokenMatches('', 'anything'), false);
  assert.equal(tokenMatches('secret', undefined), false);
  assert.equal(tokenMatches('secret', 'secret'), true);
  assert.equal(tokenMatches('secret', 'Secret'), false);
  assert.equal(tokenMatches('密钥', '密钥'), true);
  assert.equal(tokenMatches('密钥', '密钥x'), false);
});

test('setSecurityHeaders applies the browser security boundary', () => {
  const headers = new Map();
  setSecurityHeaders({ setHeader: (name, value) => headers.set(name, value) });

  assert.match(headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(headers.get('X-Frame-Options'), 'DENY');
  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(headers.get('Referrer-Policy'), 'no-referrer');
});

test('createHttpAuth uses Access JWT for public hosts and token fallback for local requests', async () => {
  const verified = [];
  const auth = createHttpAuth({
    authToken: 'secret',
    isPublicHost: host => host === 'public.example',
    verifyAccessJwt: async token => verified.push(token),
  });

  const run = async req => {
    const response = { statusCode: 200, body: null, headers: new Map() };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
      setHeader(k, v) { response.headers.set(k, v); return this; },
    };
    let nextCalled = false;
    await auth(req, res, () => { nextCalled = true; });
    return { ...response, nextCalled };
  };

  assert.equal((await run({ headers: { host: 'localhost', 'x-auth-token': 'secret' }, query: {} })).nextCalled, true);
  assert.equal((await run({ headers: { host: 'localhost' }, query: {} })).statusCode, 401);
  assert.equal((await run({ headers: { host: 'public.example', 'cf-access-jwt-assertion': 'jwt' }, query: { token: 'secret' } })).nextCalled, true);
  assert.deepEqual(verified, ['jwt']);
});

// AUTH-001：HTTP 鉴权失败计入共享限速，达阈值 → 429
test('createHttpAuth rateLimit：连续失败锁定 → 429（AUTH-001）', async () => {
  const states = new Map();
  let locked = 0;
  let now = 1_000_000;
  const { onAuthResult } = await import('../../src/auth/rate-limiter.js');
  const auth = createHttpAuth({
    authToken: 'secret',
    isPublicHost: () => false,
    verifyAccessJwt: async () => {},
    rateLimit: {
      active: true,
      sourceKey: () => 'ip:9.9.9.9',
      getState: (k) => states.get(k),
      setState: (k, st) => { states.set(k, st); },
      onResult: onAuthResult,
      now: () => now,
      onLocked: () => { locked++; },
    },
  });
  const run = async () => {
    const response = { statusCode: 200, body: null, headers: new Map() };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
      setHeader(k, v) { response.headers.set(k, v); return this; },
    };
    let nextCalled = false;
    await auth({ headers: { host: 'lan' }, query: {}, socket: { remoteAddress: '9.9.9.9' } }, res, () => { nextCalled = true; });
    return { ...response, nextCalled };
  };
  // threshold=8：每次失败后跳过 backoff 再试
  for (let i = 0; i < 8; i++) {
    const r = await run();
    assert.equal(r.nextCalled, false);
    // 前 7 次 401，第 8 次 locked → 429
    if (i < 7) {
      assert.equal(r.statusCode, 401, `fail ${i + 1} → 401`);
      const st = states.get('ip:9.9.9.9');
      now = (st?.lockUntil || now) + 1;
    } else {
      assert.equal(r.statusCode, 429, '第 8 次失败应 429 rate_limited');
      assert.equal(r.body?.status, 'rate_limited');
    }
  }
  assert.equal(locked, 1);
});
