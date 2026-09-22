// tests/invariants/bind-host.test.mjs —— 监听地址与对外可达性判定单测
// 守护：AUTH-01（启动前置令牌门）、CONFIG-01（绑定模式归一）
// 测什么：resolveBindPlan 无 token / 空白 token 启动拒绝；各 BIND_MODE（loopback, lan, custom）解析；isLoopbackBindHost 判定
// 不测什么 + 为什么：不测真端口绑定与网络监听——属于 server 集成测试
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBindPlan,
  isLoopbackBindHost,
  isBlankToken,
  BIND_MODES,
} from '../../app/src/shared/bind-host.js';

test.describe('AUTH-01 & CONFIG-01: resolveBindPlan 启动前提与模式判定', () => {
  test('缺 token 无论任何绑定模式一律拒绝（AUTH-01 启动前提）', () => {
    for (const token of [undefined, '', null]) {
      const plan = resolveBindPlan({ authToken: token });
      assert.notEqual(plan.refuse, null);
      assert.equal(plan.refuse.code, 'token_required');
      assert.equal(plan.publiclyReachable, false);
      assert.match(plan.refuse.detail, /AUTH_TOKEN/);
      assert.match(plan.refuse.detail, /setup/);
    }
  });

  test('纯空白 token 同样拒绝（防 truthy 误判导致 0.0.0.0 裸奔）', () => {
    for (const blank of ['   ', '\t\n', ' \t ']) {
      const plan = resolveBindPlan({ authToken: blank });
      assert.notEqual(plan.refuse, null);
      assert.equal(plan.refuse.code, 'token_required');
      assert.equal(plan.publiclyReachable, false);
    }
  });

  test('loopback 模式下无 token 依然拒绝（本机亦需令牌）', () => {
    const plan = resolveBindPlan({ bindMode: 'loopback' });
    assert.notEqual(plan.refuse, null);
    assert.equal(plan.refuse.code, 'token_required');
  });

  test('未知 BIND_MODE 无论有无 token 均拒绝，绝不静默猜一种模式', () => {
    const plan = resolveBindPlan({ authToken: 'secret123', bindMode: 'invalid_mode' });
    assert.notEqual(plan.refuse, null);
    assert.equal(plan.refuse.code, 'unknown_bind_mode');
    assert.match(plan.refuse.detail, /BIND_MODE/);
  });

  test('custom 模式若未指定 BIND_HOST 拒绝', () => {
    const plan = resolveBindPlan({ authToken: 'secret123', bindMode: 'custom', bindHost: '' });
    assert.notEqual(plan.refuse, null);
    assert.equal(plan.refuse.code, 'custom_requires_host');
    assert.match(plan.refuse.detail, /BIND_HOST/);
  });

  test('默认未显式声明 BIND_MODE 时绑 0.0.0.0（对外可达）', () => {
    const plan = resolveBindPlan({ authToken: 'secret123' });
    assert.equal(plan.refuse, null);
    assert.equal(plan.host, '0.0.0.0');
    assert.equal(plan.publiclyReachable, true);
  });

  test('BIND_MODE=loopback 绑 127.0.0.1（对外不可达）', () => {
    const plan = resolveBindPlan({ authToken: 'secret123', bindMode: 'loopback' });
    assert.equal(plan.refuse, null);
    assert.equal(plan.host, '127.0.0.1');
    assert.equal(plan.publiclyReachable, false);
  });

  test('BIND_MODE=lan 绑 0.0.0.0（对外可达）', () => {
    const plan = resolveBindPlan({ authToken: 'secret123', bindMode: 'lan' });
    assert.equal(plan.refuse, null);
    assert.equal(plan.host, '0.0.0.0');
    assert.equal(plan.publiclyReachable, true);
  });

  test('BIND_MODE=custom 绑定用户自定义地址并按地址判定可达性', () => {
    const p1 = resolveBindPlan({ authToken: 'secret123', bindMode: 'custom', bindHost: '127.0.0.2' });
    assert.equal(p1.refuse, null);
    assert.equal(p1.host, '127.0.0.2');
    assert.equal(p1.publiclyReachable, false);

    const p2 = resolveBindPlan({ authToken: 'secret123', bindMode: 'custom', bindHost: '192.168.1.100' });
    assert.equal(p2.refuse, null);
    assert.equal(p2.host, '192.168.1.100');
    assert.equal(p2.publiclyReachable, true);

    const p3 = resolveBindPlan({ authToken: 'secret123', bindMode: 'custom', bindHost: '::' });
    assert.equal(p3.refuse, null);
    assert.equal(p3.host, '::');
    assert.equal(p3.publiclyReachable, true);
  });

  test('BIND_MODES 包含且仅包含 loopback, lan, custom 且被冻结', () => {
    assert.deepEqual(BIND_MODES, ['loopback', 'lan', 'custom']);
    assert.ok(Object.isFrozen(BIND_MODES));
  });
});

test.describe('isLoopbackBindHost & isBlankToken 辅助判定', () => {
  test('isLoopbackBindHost 准确识别 127/8 段及 IPv6 loopback 与 localhost', () => {
    assert.equal(isLoopbackBindHost('127.0.0.1'), true);
    assert.equal(isLoopbackBindHost('127.0.0.254'), true);
    assert.equal(isLoopbackBindHost('127.12.34.56'), true);
    assert.equal(isLoopbackBindHost('localhost'), true);
    assert.equal(isLoopbackBindHost('::1'), true);

    // 非 loopback
    assert.equal(isLoopbackBindHost('0.0.0.0'), false);
    assert.equal(isLoopbackBindHost('::'), false);
    assert.equal(isLoopbackBindHost('192.168.1.1'), false);
    assert.equal(isLoopbackBindHost('10.0.0.1'), false);
    assert.equal(isLoopbackBindHost(''), false);
    assert.equal(isLoopbackBindHost(null), false);
  });

  test('isBlankToken 精确识别非空纯空白字符串', () => {
    assert.equal(isBlankToken('   '), true);
    assert.equal(isBlankToken('\t\r\n'), true);
    assert.equal(isBlankToken(''), false); // 严格空串不是 blank token（是未设置）
    assert.equal(isBlankToken('valid_token'), false);
    assert.equal(isBlankToken(null), false);
    assert.equal(isBlankToken(undefined), false);
  });
});
