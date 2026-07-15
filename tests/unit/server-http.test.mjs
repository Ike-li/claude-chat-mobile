import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHttpAuth,
  setSecurityHeaders,
  tokenMatches,
} from '../../src/server/http.js';

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
    const response = { statusCode: 200, body: null };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
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
