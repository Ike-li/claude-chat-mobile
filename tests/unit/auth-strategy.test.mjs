// tests/unit/auth-strategy.test.mjs —— 公网身份提供方策略层。
//
// 这一层存在的理由：核心代码（HTTP 鉴权、socket 握手、index.html 注入、doctor ctx）此前各自
// import cf-access.js 的四个符号，其中 HTTP 侧已经是注入式而 socket 侧是直接引用——同一份判据
// 有两种拿法。收敛成一个策略对象后，核心只认这个形状，换 IdP 不必改核心。
//
// **它不是插件机制**：策略仍在仓内、仍受模块边界与门禁约束（2026-08-14 已否决插件化，
// 理由是代码出仓库 = 三道门禁全失明）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCfAccessStrategy, NULL_AUTH_STRATEGY } from '../../app/src/auth/auth-strategy.js';

// 策略的每个成员都可注入，便于在不碰 cf-access 模块级状态的前提下断言接线。
const stubDeps = (over = {}) => ({
  init: () => true,
  isEnabled: () => true,
  ownsHost: () => true,
  verify: async () => ({ sub: 'user@example.com' }),
  env: {},
  ...over,
});

test.describe('createCfAccessStrategy：接口形状与接线', () => {
  test('六个成员齐全，且 id 标明具体实现（诊断/日志要认得出是哪种 IdP）', () => {
    const s = createCfAccessStrategy(stubDeps());
    assert.equal(s.id, 'cf-access');
    for (const m of ['init', 'isEnabled', 'ownsHost', 'verifyRequest', 'publicHostname']) {
      assert.equal(typeof s[m], 'function', `缺成员 ${m}`);
    }
  });

  test('init / isEnabled / ownsHost 原样透传给底层实现', () => {
    const calls = [];
    const s = createCfAccessStrategy(stubDeps({
      init: () => { calls.push('init'); return true; },
      isEnabled: () => { calls.push('isEnabled'); return false; },
      ownsHost: (h) => { calls.push(`ownsHost:${h}`); return h === 'x.example.com'; },
    }));
    assert.equal(s.init(), true);
    assert.equal(s.isEnabled(), false);
    assert.equal(s.ownsHost('x.example.com'), true);
    assert.equal(s.ownsHost('other.example.com'), false);
    assert.deepEqual(calls, ['init', 'isEnabled', 'ownsHost:x.example.com', 'ownsHost:other.example.com']);
  });

  test('★ verifyRequest 从 cf-access-jwt-assertion 头取值——头名是 Cloudflare 的外部契约，写错会静默变成「永远校验空 token」', async () => {
    const seen = [];
    const s = createCfAccessStrategy(stubDeps({ verify: async (t) => { seen.push(t); return { ok: true }; } }));
    await s.verifyRequest({ 'cf-access-jwt-assertion': 'jwt-abc', 'x-other': 'ignored' });
    assert.deepEqual(seen, ['jwt-abc']);
  });

  test('headers 缺失 / 为 undefined 时不崩，把 undefined 交给底层（底层负责抛 missing header）', async () => {
    const seen = [];
    const s = createCfAccessStrategy(stubDeps({ verify: async (t) => { seen.push(t); } }));
    await s.verifyRequest({});
    await s.verifyRequest(undefined);
    assert.deepEqual(seen, [undefined, undefined]);
  });

  test('verifyRequest 抛错原样向外传播（fail-closed 契约：调用方据此拒绝，绝不回退 token）', async () => {
    const s = createCfAccessStrategy(stubDeps({ verify: async () => { throw new Error('bad jwt'); } }));
    await assert.rejects(() => s.verifyRequest({ 'cf-access-jwt-assertion': 'x' }), /bad jwt/);
  });

  test('publicHostname 归一化 trim + 小写——与 cf-access.js:89 的 hostname 同一口径（此前启动横幅直读 env 未归一，可能与实际判据字面不同）', () => {
    const s = createCfAccessStrategy(stubDeps({ env: { CF_ACCESS_HOSTNAME: '  CCM.Example.COM  ' } }));
    assert.equal(s.publicHostname(), 'ccm.example.com');
    assert.equal(createCfAccessStrategy(stubDeps({ env: {} })).publicHostname(), '');
  });
});

test.describe('NULL_AUTH_STRATEGY：没有配置任何 IdP 时的安全默认', () => {
  test('★ verifyRequest 必抛——失败方向必须是「拒绝」，绝不能返回成功把公网请求放进来', async () => {
    await assert.rejects(() => NULL_AUTH_STRATEGY.verifyRequest({ 'cf-access-jwt-assertion': 'anything' }));
  });

  test('isEnabled / ownsHost 恒 false（不认领任何 Host ⇒ 全部走 AUTH_TOKEN 路）', () => {
    assert.equal(NULL_AUTH_STRATEGY.isEnabled(), false);
    assert.equal(NULL_AUTH_STRATEGY.ownsHost('anything.example.com'), false);
    assert.equal(NULL_AUTH_STRATEGY.init(), false);
    assert.equal(NULL_AUTH_STRATEGY.publicHostname(), '');
  });

  test('已冻结：运行时不可被改写成放行策略', () => {
    assert.equal(Object.isFrozen(NULL_AUTH_STRATEGY), true);
  });
});
