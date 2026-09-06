// tests/invariants/auth-strategy.test.mjs —— 公网身份验证策略与 Cloudflare Access 门禁单测
// 守护：AUTH-01（未授权客户端拦截）、AUTH-02（公网 Host ownsHost 命中时强制 JWT 验签，不得回退 token）
// 测什么：createCfAccessStrategy 策略封装；NULL_AUTH_STRATEGY fail-closed 默认；initCfAccess 三要素判定；isPublicHost 大小写与端口剥离；verifyAccessJwt 各失败态（缺头、坏头、过期、aud/iss 不匹配、无证书）
// 不测什么 + 为什么：不测真实 Cloudflare 网络拉取——单测中离线运行，使用本地生成密钥对与本地缓存
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { createCfAccessStrategy, NULL_AUTH_STRATEGY } from '../../app/src/auth/auth-strategy.js';

test.describe('createCfAccessStrategy 策略层契约与接线', () => {
  const stubDeps = (over = {}) => ({
    init: () => true,
    isEnabled: () => true,
    ownsHost: (h) => h === 'chat.example.com',
    verify: async (t) => {
      if (!t) throw new Error('missing token');
      return { sub: 'user@example.com' };
    },
    env: { CF_ACCESS_HOSTNAME: '  Chat.Example.COM  ' },
    ...over,
  });

  test('包含完整六项成员，id 固定为 cf-access', () => {
    const s = createCfAccessStrategy(stubDeps());
    assert.equal(s.id, 'cf-access');
    assert.equal(typeof s.init, 'function');
    assert.equal(typeof s.isEnabled, 'function');
    assert.equal(typeof s.ownsHost, 'function');
    assert.equal(typeof s.verifyRequest, 'function');
    assert.equal(typeof s.publicHostname, 'function');
  });

  test('publicHostname 进行 trim 和小写归一化', () => {
    const s = createCfAccessStrategy(stubDeps());
    assert.equal(s.publicHostname(), 'chat.example.com');
  });

  test('verifyRequest 精确从 cf-access-jwt-assertion 抽取凭证并传递', async () => {
    let captured = null;
    const s = createCfAccessStrategy(stubDeps({
      verify: async (token) => { captured = token; return { sub: 'test' }; },
    }));

    const payload = await s.verifyRequest({
      'cf-access-jwt-assertion': 'valid-jwt-token',
      'authorization': 'Bearer other',
    });
    assert.equal(captured, 'valid-jwt-token');
    assert.equal(payload.sub, 'test');
  });

  test('AUTH-02: verifyRequest 失败时向外抛错（fail-closed，调用方绝不得回退 token）', async () => {
    const s = createCfAccessStrategy(stubDeps({
      verify: async () => { throw new Error('jwt expired'); },
    }));

    await assert.rejects(
      () => s.verifyRequest({ 'cf-access-jwt-assertion': 'expired-jwt' }),
      /jwt expired/
    );
  });
});

test.describe('NULL_AUTH_STRATEGY 安全默认（AUTH-01 / AUTH-02）', () => {
  test('isEnabled 与 ownsHost 恒 false，不认领公网 Host', () => {
    assert.equal(NULL_AUTH_STRATEGY.isEnabled(), false);
    assert.equal(NULL_AUTH_STRATEGY.ownsHost('anything.com'), false);
    assert.equal(NULL_AUTH_STRATEGY.init(), false);
    assert.equal(NULL_AUTH_STRATEGY.publicHostname(), '');
  });

  test('verifyRequest 必抛（防空策略意外放行）', async () => {
    await assert.rejects(
      () => NULL_AUTH_STRATEGY.verifyRequest({ 'cf-access-jwt-assertion': 'test' }),
      /no auth strategy configured/
    );
  });

  test('NULL_AUTH_STRATEGY 对象已被完全冻结', () => {
    assert.ok(Object.isFrozen(NULL_AUTH_STRATEGY));
  });
});

test.describe('cf-access.js 运行时凭据与 JWT 校验', () => {
  let tempDir;
  let cacheFile;
  let cfAccess;

  const savedEnv = { ...process.env };

  test.beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ccm-cf-access-inv-'));
    process.env.CCM_DATA_DIR = tempDir;
    cacheFile = join(tempDir, 'cf-access-certs.json');
    // 动态 import 破除模块级状态缓存
    cfAccess = await import(`../../app/src/auth/cf-access.js?t=${Date.now()}_${Math.random()}`);
  });

  test.afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  async function makeJwk(kid) {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const pubJwk = await exportJWK(publicKey);
    pubJwk.kid = kid;
    return { publicJwk: pubJwk, privateKey };
  }

  async function signJwt(privateKey, kid, { issuer, audience, payload = {}, expiresIn = '1h' } = {}) {
    return await new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(expiresIn)
      .setSubject(payload.sub || 'test-user')
      .sign(privateKey);
  }

  function writeJwksCache(keys) {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ keys }, null, 2), { mode: 0o600 });
  }

  test('AUTH-02: initCfAccess 缺少任一要素整层关闭（HOSTNAME / TEAM / AUD）', () => {
    process.env.CF_ACCESS_HOSTNAME = 'chat.example.com';
    process.env.CF_ACCESS_TEAM = 'myteam';
    delete process.env.CF_ACCESS_AUD;

    assert.equal(cfAccess.initCfAccess(), false);
    assert.equal(cfAccess.isAccessEnabled(), false);
    assert.equal(cfAccess.isPublicHost('chat.example.com'), false);
  });

  test('initCfAccess 三要素齐全时启用', () => {
    process.env.CF_ACCESS_HOSTNAME = 'chat.example.com';
    process.env.CF_ACCESS_TEAM = 'myteam';
    process.env.CF_ACCESS_AUD = 'aud-tag-12345';

    assert.equal(cfAccess.initCfAccess(), true);
    assert.equal(cfAccess.isAccessEnabled(), true);
  });

  test('isPublicHost 忽略端口且不区分大小写', () => {
    process.env.CF_ACCESS_HOSTNAME = 'chat.example.com';
    process.env.CF_ACCESS_TEAM = 'myteam';
    process.env.CF_ACCESS_AUD = 'aud-tag-12345';
    cfAccess.initCfAccess();

    assert.equal(cfAccess.isPublicHost('chat.example.com'), true);
    assert.equal(cfAccess.isPublicHost('Chat.Example.COM:443'), true);
    assert.equal(cfAccess.isPublicHost('chat.example.com:8443'), true);
    assert.equal(cfAccess.isPublicHost('other.example.com'), false);
    assert.equal(cfAccess.isPublicHost(''), false);
    assert.equal(cfAccess.isPublicHost(null), false);
  });

  test('verifyAccessJwt: 未启用时抛出异常', async () => {
    delete process.env.CF_ACCESS_HOSTNAME;
    cfAccess.initCfAccess();
    await assert.rejects(() => cfAccess.verifyAccessJwt('any-token'), /cf-access not enabled/);
  });

  test('verifyAccessJwt: 缺失 token 抛出异常', async () => {
    process.env.CF_ACCESS_HOSTNAME = 'chat.example.com';
    process.env.CF_ACCESS_TEAM = 'myteam';
    process.env.CF_ACCESS_AUD = 'aud-tag-12345';
    cfAccess.initCfAccess();
    await assert.rejects(() => cfAccess.verifyAccessJwt(''), /missing Cf-Access-Jwt-Assertion/);
  });

  test('verifyAccessJwt: 无效 JWT 格式抛出 Invalid JWT header', async () => {
    process.env.CF_ACCESS_HOSTNAME = 'chat.example.com';
    process.env.CF_ACCESS_TEAM = 'myteam';
    process.env.CF_ACCESS_AUD = 'aud-tag-12345';
    cfAccess.initCfAccess();
    await assert.rejects(() => cfAccess.verifyAccessJwt('not.a.jwt'), /Invalid JWT header/);
  });

  test('verifyAccessJwt: 本地有效证书且签名正确时成功校验并返回 payload', async () => {
    const team = 'myteam';
    const aud = 'aud-tag-12345';
    const issuer = `https://${team}.cloudflareaccess.com`;
    process.env.CF_ACCESS_HOSTNAME = 'chat.example.com';
    process.env.CF_ACCESS_TEAM = team;
    process.env.CF_ACCESS_AUD = aud;

    const key1 = await makeJwk('kid-1');
    writeJwksCache([key1.publicJwk]);

    cfAccess.initCfAccess();

    const token = await signJwt(key1.privateKey, 'kid-1', {
      issuer,
      audience: aud,
      payload: { email: 'alice@example.com' },
    });

    const payload = await cfAccess.verifyAccessJwt(token);
    assert.equal(payload.email, 'alice@example.com');
    assert.equal(payload.iss, issuer);
    assert.equal(payload.aud, aud);
  });

  test('AUTH-02: AUD 或 Issuer 不匹配时验证失败拒绝', async () => {
    const team = 'myteam';
    const aud = 'aud-tag-12345';
    const issuer = `https://${team}.cloudflareaccess.com`;
    process.env.CF_ACCESS_HOSTNAME = 'chat.example.com';
    process.env.CF_ACCESS_TEAM = team;
    process.env.CF_ACCESS_AUD = aud;

    const key1 = await makeJwk('kid-1');
    writeJwksCache([key1.publicJwk]);
    cfAccess.initCfAccess();

    // 错误的 AUD
    const badAudToken = await signJwt(key1.privateKey, 'kid-1', {
      issuer,
      audience: 'wrong-aud',
    });
    await assert.rejects(() => cfAccess.verifyAccessJwt(badAudToken));

    // 错误的 Issuer
    const badIssToken = await signJwt(key1.privateKey, 'kid-1', {
      issuer: 'https://evil.cloudflareaccess.com',
      audience: aud,
    });
    await assert.rejects(() => cfAccess.verifyAccessJwt(badIssToken));
  });

  test('AUTH-02: 过期 JWT 验证失败拒绝', async () => {
    const team = 'myteam';
    const aud = 'aud-tag-12345';
    const issuer = `https://${team}.cloudflareaccess.com`;
    process.env.CF_ACCESS_HOSTNAME = 'chat.example.com';
    process.env.CF_ACCESS_TEAM = team;
    process.env.CF_ACCESS_AUD = aud;

    const key1 = await makeJwk('kid-1');
    writeJwksCache([key1.publicJwk]);
    cfAccess.initCfAccess();

    // 已经过期的 token (-10s)
    const expiredToken = await new SignJWT({ sub: 'user' })
      .setProtectedHeader({ alg: 'ES256', kid: 'kid-1' })
      .setIssuer(issuer)
      .setAudience(aud)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(key1.privateKey);

    await assert.rejects(() => cfAccess.verifyAccessJwt(expiredToken));
  });
});
