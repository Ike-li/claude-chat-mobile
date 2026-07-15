// tests/unit/cf-access.test.mjs —— Cloudflare Access JWT 校验单测（零 token、零网络依赖）
// 覆盖 initCfAccess / isPublicHost / verifyAccessJwt 全部路径。
//
// TC-002 隔离：cf-access.js 本已支持 CCM_DATA_DIR 覆盖状态根（同 devices.js/sessions.js），但本文件此前
// 没有使用它，而是直接操作真实 data/cf-access-certs.json（rename 成 .bak 备份、beforeEach 删除、after
// 用 renameSync 恢复）。中断（进程被杀/超时）或恰好落在“真实文件已删、.bak 还没改回来”的窗口内重启，会让
// 生产 Cloudflare Access 读到空缓存或测试用的假 JWKS——线上校验直接失败。改为 before 设一次性临时
// CCM_DATA_DIR（reloadModule() 本就是带 cache-busting 的动态 import，模块顶层 CACHE_FILE 常量在每次
// reload 时重新求值，天然支持运行期切换 DATA_DIR，不需要额外的 preload 时机处理），整套备份/还原逻辑
// 删除——测试彻底不接触真实 data/cf-access-certs.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = import.meta.dirname;
const REAL_CACHE_FILE = join(HERE, '..', '..', 'data', 'cf-access-certs.json');
let TEST_DATA_DIR;
let CACHE_FILE;

// ---- 测试用 JWK 生成器 ----
async function makeTestJwk(kid) {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const pubJwk = await exportJWK(publicKey);
  pubJwk.kid = kid;
  return { publicJwk: pubJwk, privateKey };
}

async function makeTestJwks(jwksObj) {
  writeOwnerOnly(CACHE_FILE, JSON.stringify(jwksObj, null, 2));
}

async function signAccessJwt(privateKey, kid, { issuer, audience, payload = {}, expiresIn = '1h' } = {}) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(expiresIn)
    .setSubject(payload.sub || 'test-user')
    .sign(privateKey);
}

function writeOwnerOnly(filepath, content) {
  mkdirSync(dirname(filepath), { recursive: true });
  writeFileSync(filepath, content, { mode: 0o600 });
}

// ---- 模块级动态导入（每次 initCfAccess 会改模块内部状态） ----
let cfAccess;

async function reloadModule() {
  // 动态导入 + 缓存破除以获取干净模块状态
  cfAccess = await import(`../../src/auth/cf-access.js?v=${Date.now()}`);
}

// ---- 环境变量辅助 ----
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearCfEnv() {
  delete process.env.CF_ACCESS_HOSTNAME;
  delete process.env.CF_ACCESS_TEAM;
  delete process.env.CF_ACCESS_AUD;
}

// ---- 全局 fetch mock（确保零网络依赖） ----
let origFetch;
const mockFetch = async () => { throw new Error('mock: network unreachable'); };

// ---- 测试生命周期 ----
let realCacheHashBefore; // 铁证：全程比对生产文件哈希不变（若本来就存在）

test.before(async () => {
  // Mock 全局 fetch，杜绝真实网络请求
  origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  realCacheHashBefore = existsSync(REAL_CACHE_FILE) ? readFileSync(REAL_CACHE_FILE, 'utf8') : null;

  // TC-002：套件专属临时 CCM_DATA_DIR——cf-access.js 的 CACHE_FILE 常量在 reloadModule() 每次 cache-busting
  // 动态 import 时重新求值，故只需在首次 reloadModule() 之前设好该 env，本文件全程不再触碰真实 data/。
  TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'ccm-cfaccess-test-'));
  process.env.CCM_DATA_DIR = TEST_DATA_DIR;
  CACHE_FILE = join(TEST_DATA_DIR, 'cf-access-certs.json');
});

test.after(() => {
  // 恢复 fetch
  globalThis.fetch = origFetch;

  delete process.env.CCM_DATA_DIR;
  try { rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
  clearCfEnv();

  // 铁证：生产 data/cf-access-certs.json 全程未被本文件读写。
  const realCacheHashAfter = existsSync(REAL_CACHE_FILE) ? readFileSync(REAL_CACHE_FILE, 'utf8') : null;
  assert.equal(realCacheHashAfter, realCacheHashBefore, '生产 data/cf-access-certs.json 不应被测试改动');
});

test.beforeEach(async () => {
  // 每个测试前清 env 并重载模块（得干净状态）
  clearCfEnv();
  // 删除可能残留的缓存文件（临时目录内，不碰真实 data/）
  if (existsSync(CACHE_FILE)) {
    try { rmSync(CACHE_FILE); } catch {}
  }
  await reloadModule();
});

// =========================================================================
// initCfAccess
// =========================================================================
test.describe('initCfAccess', () => {
  test('三项 env 齐全 → 返回 true，enabled=true', () => {
    setEnv({
      CF_ACCESS_HOSTNAME: 'chat.example.com',
      CF_ACCESS_TEAM: 'myteam',
      CF_ACCESS_AUD: 'abc123',
    });
    const result = cfAccess.initCfAccess();
    assert.equal(result, true);
    assert.equal(cfAccess.isAccessEnabled(), true);
  });

  test('缺 HOSTNAME → 返回 false，enabled=false', () => {
    setEnv({
      CF_ACCESS_TEAM: 'myteam',
      CF_ACCESS_AUD: 'abc123',
    });
    const result = cfAccess.initCfAccess();
    assert.equal(result, false);
    assert.equal(cfAccess.isAccessEnabled(), false);
  });

  test('缺 TEAM → 返回 false', () => {
    setEnv({
      CF_ACCESS_HOSTNAME: 'chat.example.com',
      CF_ACCESS_AUD: 'abc123',
    });
    assert.equal(cfAccess.initCfAccess(), false);
    assert.equal(cfAccess.isAccessEnabled(), false);
  });

  test('缺 AUD → 返回 false', () => {
    setEnv({
      CF_ACCESS_HOSTNAME: 'chat.example.com',
      CF_ACCESS_TEAM: 'myteam',
    });
    assert.equal(cfAccess.initCfAccess(), false);
    assert.equal(cfAccess.isAccessEnabled(), false);
  });

  test('空串 env 等同于未设置 → 返回 false', () => {
    setEnv({
      CF_ACCESS_HOSTNAME: '',
      CF_ACCESS_TEAM: 'myteam',
      CF_ACCESS_AUD: 'abc123',
    });
    assert.equal(cfAccess.initCfAccess(), false);

    setEnv({
      CF_ACCESS_HOSTNAME: 'chat.example.com',
      CF_ACCESS_TEAM: '   ',
      CF_ACCESS_AUD: 'abc123',
    });
    assert.equal(cfAccess.initCfAccess(), false);
  });

  test('team 不含点 → 追加 .cloudflareaccess.com', () => {
    setEnv({
      CF_ACCESS_HOSTNAME: 'chat.example.com',
      CF_ACCESS_TEAM: 'myteam',
      CF_ACCESS_AUD: 'abc123',
    });
    cfAccess.initCfAccess();
    // 通过 isPublicHost 间接验证 hostname 设置正确
    assert.equal(cfAccess.isPublicHost('chat.example.com'), true);
    assert.equal(cfAccess.isPublicHost('other.example.com'), false);
  });

  test('team 含点 → 原样使用作为 issuer 域名', () => {
    setEnv({
      CF_ACCESS_HOSTNAME: 'chat.example.com',
      CF_ACCESS_TEAM: 'custom.team.com',
      CF_ACCESS_AUD: 'abc123',
    });
    cfAccess.initCfAccess();
    assert.equal(cfAccess.isPublicHost('chat.example.com'), true);
  });
});

// =========================================================================
// isAccessEnabled
// =========================================================================
test.describe('isAccessEnabled', () => {
  test('未调用 initCfAccess → false', () => {
    assert.equal(cfAccess.isAccessEnabled(), false);
  });

  test('initCfAccess 返回 false 后 → false', () => {
    setEnv({ CF_ACCESS_HOSTNAME: 'x', CF_ACCESS_TEAM: 't' });
    cfAccess.initCfAccess(); // 缺 AUD
    assert.equal(cfAccess.isAccessEnabled(), false);
  });

  test('initCfAccess 返回 true 后 → true', () => {
    setEnv({ CF_ACCESS_HOSTNAME: 'x', CF_ACCESS_TEAM: 't', CF_ACCESS_AUD: 'a' });
    cfAccess.initCfAccess();
    assert.equal(cfAccess.isAccessEnabled(), true);
  });
});

// =========================================================================
// isPublicHost
// =========================================================================
test.describe('isPublicHost', () => {
  test('enabled=false → 始终 false', () => {
    // 未调用 initCfAccess = disabled
    assert.equal(cfAccess.isPublicHost('anything.com'), false);
    assert.equal(cfAccess.isPublicHost(''), false);
    assert.equal(cfAccess.isPublicHost(null), false);
  });

  test('enabled=true 时精确匹配 → true', () => {
    setEnv({ CF_ACCESS_HOSTNAME: 'chat.example.com', CF_ACCESS_TEAM: 't', CF_ACCESS_AUD: 'a' });
    cfAccess.initCfAccess();
    assert.equal(cfAccess.isPublicHost('chat.example.com'), true);
    assert.equal(cfAccess.isPublicHost('other.example.com'), false);
  });

  test('带端口的 Host → 剥离端口后匹配', () => {
    setEnv({ CF_ACCESS_HOSTNAME: 'chat.example.com', CF_ACCESS_TEAM: 't', CF_ACCESS_AUD: 'a' });
    cfAccess.initCfAccess();
    assert.equal(cfAccess.isPublicHost('chat.example.com:443'), true);
    assert.equal(cfAccess.isPublicHost('chat.example.com:8080'), true);
  });

  test('大小写不敏感', () => {
    setEnv({ CF_ACCESS_HOSTNAME: 'Chat.Example.COM', CF_ACCESS_TEAM: 't', CF_ACCESS_AUD: 'a' });
    cfAccess.initCfAccess();
    // initCfAccess 内部 toLowerCase
    assert.equal(cfAccess.isPublicHost('chat.example.com'), true);
    assert.equal(cfAccess.isPublicHost('CHAT.EXAMPLE.COM'), true);
    assert.equal(cfAccess.isPublicHost('Chat.Example.Com'), true);
  });

  test('null / undefined / 空串 → false', () => {
    setEnv({ CF_ACCESS_HOSTNAME: 'chat.example.com', CF_ACCESS_TEAM: 't', CF_ACCESS_AUD: 'a' });
    cfAccess.initCfAccess();
    assert.equal(cfAccess.isPublicHost(null), false);
    assert.equal(cfAccess.isPublicHost(undefined), false);
    assert.equal(cfAccess.isPublicHost(''), false);
  });
});

// =========================================================================
// verifyAccessJwt
// =========================================================================
test.describe('verifyAccessJwt', () => {
  // 这些测试需要 enabled=true + 预置 JWKS
  const ISSUER = 'https://test-team.cloudflareaccess.com';
  const AUD = 'test-aud-tag-001';
  const HOSTNAME = 'chat.example.com';

  let testKey; // { publicJwk, privateKey }

  test.before(async () => {
    testKey = await makeTestJwk('test-kid-001');
  });

  async function setupWithJwks(jwks) {
    // 写入 JWKS 到缓存文件
    writeOwnerOnly(CACHE_FILE, JSON.stringify(jwks, null, 2));
    // 设置 env 并初始化（loadLocalJwks 会从缓存文件读取；fetch 已被全局 mock）
    setEnv({ CF_ACCESS_HOSTNAME: HOSTNAME, CF_ACCESS_TEAM: 'test-team', CF_ACCESS_AUD: AUD });
    await reloadModule();
    cfAccess.initCfAccess();
    // 等待 fire-and-forget 的 fetchRemoteJwks 完成（被全局 mock 快速拒绝）
    await new Promise(r => setTimeout(r, 50));
  }

  test('enabled=false → 抛错 "cf-access not enabled"', async () => {
    // 未调用 initCfAccess → enabled=false
    await assert.rejects(
      () => cfAccess.verifyAccessJwt('some-token'),
      { message: 'cf-access not enabled' }
    );
  });

  test('token 为空/undefined → 抛错 "missing Cf-Access-Jwt-Assertion header"', async () => {
    setEnv({ CF_ACCESS_HOSTNAME: HOSTNAME, CF_ACCESS_TEAM: 'test-team', CF_ACCESS_AUD: AUD });
    await reloadModule();
    cfAccess.initCfAccess();
    await assert.rejects(
      () => cfAccess.verifyAccessJwt(''),
      { message: 'missing Cf-Access-Jwt-Assertion header' }
    );
    await assert.rejects(
      () => cfAccess.verifyAccessJwt(null),
      { message: 'missing Cf-Access-Jwt-Assertion header' }
    );
  });

  test('有效 JWT → 返回 payload', async () => {
    await setupWithJwks({ keys: [testKey.publicJwk] });

    const token = await signAccessJwt(testKey.privateKey, 'test-kid-001', {
      issuer: ISSUER, audience: AUD, payload: { sub: 'user-42', email: 'u@example.com' }
    });
    const payload = await cfAccess.verifyAccessJwt(token);
    assert.equal(payload.sub, 'user-42');
    assert.equal(payload.email, 'u@example.com');
    assert.equal(payload.iss, ISSUER);
    assert.equal(payload.aud, AUD);
  });

  test('无效 JWT header（乱码/非 JWT）→ 抛错', async () => {
    await setupWithJwks({ keys: [testKey.publicJwk] });

    await assert.rejects(
      () => cfAccess.verifyAccessJwt('not-a-valid-jwt'),
      /Invalid JWT header/
    );
  });

  test('过期 JWT → 抛错', async () => {
    await setupWithJwks({ keys: [testKey.publicJwk] });

    const token = await signAccessJwt(testKey.privateKey, 'test-kid-001', {
      issuer: ISSUER, audience: AUD, expiresIn: '0s'
    });
    await assert.rejects(
      () => cfAccess.verifyAccessJwt(token),
      /"exp" claim timestamp check failed/
    );
  });

  test('kid 不在本地缓存 + 冷却期阻止远程拉取 → 签名验证失败', async () => {
    await setupWithJwks({ keys: [testKey.publicJwk] });

    // 用另一个 kid 签 JWT
    const { publicKey: pk2, privateKey: sk2 } = await generateKeyPair('ES256', { extractable: true });
    const jwk2 = await exportJWK(pk2);
    jwk2.kid = 'unknown-kid-999';
    const token = await signAccessJwt(sk2, 'unknown-kid-999', {
      issuer: ISSUER, audience: AUD
    });

    // kid 不在缓存中 → fetchRemoteJwks 被冷却期阻止 → localResolver
    // 只有 'test-kid-001' 的 key → jwtVerify 用错 key 验证失败
    await assert.rejects(
      () => cfAccess.verifyAccessJwt(token),
      /signature|verification|key/i
    );
  });

  test('无本地缓存 + 无网络 → 抛 "certificates are not available"', async () => {
    // 不写任何缓存文件 → initCfAccess loadLocalJwks 无文件可读、fetch 被全局 mock 拒绝
    setEnv({ CF_ACCESS_HOSTNAME: HOSTNAME, CF_ACCESS_TEAM: 'test-team', CF_ACCESS_AUD: AUD });
    await reloadModule();
    cfAccess.initCfAccess();
    await new Promise(r => setTimeout(r, 50));

    const token = await signAccessJwt(testKey.privateKey, 'test-kid-001', {
      issuer: ISSUER, audience: AUD
    });
    await assert.rejects(
      () => cfAccess.verifyAccessJwt(token),
      { message: 'Cloudflare Access certificates are not available (network unreachable and no local cache)' }
    );
  });
});
