// tests/unit/bind-host.test.mjs —— 监听地址判定。
//
// 这是「这台 server 会不会对外可达」的唯一判据（server 与两个 doctor 共用同一个函数）。
// 此前它只有两个硬编码分支（有 token → 0.0.0.0 / 无 token → 127.0.0.1），既没法绑特定网卡、
// 也没法绑 IPv6，更没法表达「有 token 但我只想绑 loopback、自己用 SSH 隧道转发」。
//
// 加 BIND_MODE 之后**不变量不动**：配不出「对外可达但无鉴权」——显式要求绑外网却没有
// AUTH_TOKEN 时拒绝启动，而不是静默降级（静默降级正是 config-file.js 记录过的失败形态：
// 手机全连不上，却没有任何错误信息）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBindPlan, resolveBindHost, bindsPublicly, isLoopbackBindHost, isBlankToken } from '../../src/shared/bind-host.js';

test.describe('resolveBindPlan —— 默认路径必须与改造前逐字节一致', () => {
  test('★ 未声明 BIND_MODE + 有 token → 0.0.0.0（现状，向后兼容钉子）', () => {
    const p = resolveBindPlan({ authToken: 'x' });
    assert.equal(p.host, '0.0.0.0');
    assert.equal(p.publiclyReachable, true);
    assert.equal(p.refuse, null);
  });

  test('★ 未声明 BIND_MODE + 无 token → 127.0.0.1，且不拒绝启动（本地试用是合法用法）', () => {
    for (const authToken of [undefined, '', null]) {
      const p = resolveBindPlan({ authToken });
      assert.equal(p.host, '127.0.0.1', `token=${JSON.stringify(authToken)}`);
      assert.equal(p.publiclyReachable, false);
      assert.equal(p.refuse, null, '默认路径无 token 只降级、不拒绝——这是既有行为');
    }
  });

  test('无参调用不抛（doctor 侧可能什么都没有）', () => {
    assert.equal(resolveBindPlan().host, '127.0.0.1');
    assert.equal(resolveBindPlan({}).host, '127.0.0.1');
  });

  test('纯空白 token 仍按「有 token」绑公网——最危险的那一格由 doctor 报 fail，不在这层改语义', () => {
    const p = resolveBindPlan({ authToken: '   ' });
    assert.equal(p.host, '0.0.0.0');
    assert.equal(p.publiclyReachable, true);
  });
});

test.describe('resolveBindPlan —— loopback 模式（机主的 SSH 隧道用法）', () => {
  test('有 token 也强制 127.0.0.1（这正是「我自己转发，产品别管公网」）', () => {
    const p = resolveBindPlan({ authToken: 'x', bindMode: 'loopback' });
    assert.equal(p.host, '127.0.0.1');
    assert.equal(p.publiclyReachable, false);
    assert.equal(p.refuse, null);
  });

  test('无 token 同样合法（不对外可达，不需要鉴权做前提）', () => {
    const p = resolveBindPlan({ bindMode: 'loopback' });
    assert.equal(p.host, '127.0.0.1');
    assert.equal(p.refuse, null);
  });
});

test.describe('resolveBindPlan —— lan 模式与不变量', () => {
  test('有 token → 0.0.0.0', () => {
    const p = resolveBindPlan({ authToken: 'x', bindMode: 'lan' });
    assert.equal(p.host, '0.0.0.0');
    assert.equal(p.publiclyReachable, true);
    assert.equal(p.refuse, null);
  });

  test('★ 无 token → 拒绝启动，不静默降级（不变量：配不出「对外可达但无鉴权」）', () => {
    const p = resolveBindPlan({ bindMode: 'lan' });
    assert.ok(p.refuse, '必须拒绝');
    assert.equal(p.refuse.code, 'lan_requires_token');
    assert.match(p.refuse.detail, /AUTH_TOKEN/, '要说清缺什么');
    assert.match(p.refuse.detail, /setup|BIND_MODE/, '要给出行动出路');
  });

  test('纯空白 token 不算数——它是 truthy 但形同虚设，绑外网前必须有真 token', () => {
    const p = resolveBindPlan({ authToken: '   ', bindMode: 'lan' });
    assert.ok(p.refuse, '显式要求绑外网时，空白 token 必须被拒');
    assert.equal(p.refuse.code, 'lan_requires_token');
  });
});

test.describe('resolveBindPlan —— custom 模式（IPv6 与特定网卡的逃生口）', () => {
  test('custom + :: + 有 token → 绑 ::（双栈，IPv6 缺口的解法）', () => {
    const p = resolveBindPlan({ authToken: 'x', bindMode: 'custom', bindHost: '::' });
    assert.equal(p.host, '::');
    assert.equal(p.publiclyReachable, true);
    assert.equal(p.refuse, null);
  });

  test('custom + 具体网卡地址 + 有 token → 绑该地址', () => {
    const p = resolveBindPlan({ authToken: 'x', bindMode: 'custom', bindHost: '192.168.1.5' });
    assert.equal(p.host, '192.168.1.5');
    assert.equal(p.publiclyReachable, true);
  });

  test('custom + loopback 地址 + 无 token → 合法（不对外可达）', () => {
    for (const bindHost of ['127.0.0.1', '::1', 'localhost']) {
      const p = resolveBindPlan({ bindMode: 'custom', bindHost });
      assert.equal(p.host, bindHost, bindHost);
      assert.equal(p.publiclyReachable, false, bindHost);
      assert.equal(p.refuse, null, bindHost);
    }
  });

  test('★ custom + 非 loopback 地址 + 无 token → 拒绝（同 lan 的不变量）', () => {
    for (const bindHost of ['::', '0.0.0.0', '192.168.1.5']) {
      const p = resolveBindPlan({ bindMode: 'custom', bindHost });
      assert.ok(p.refuse, bindHost);
      assert.equal(p.refuse.code, 'custom_requires_token', bindHost);
    }
  });

  test('custom 但 BIND_HOST 空 → 拒绝（配置半残，不猜一个地址）', () => {
    for (const bindHost of [undefined, '', '   ']) {
      const p = resolveBindPlan({ authToken: 'x', bindMode: 'custom', bindHost });
      assert.ok(p.refuse, JSON.stringify(bindHost));
      assert.equal(p.refuse.code, 'custom_requires_host');
      assert.match(p.refuse.detail, /BIND_HOST/);
    }
  });

  test('BIND_HOST 两端空白被 trim（配置文件里手打容易带空格）', () => {
    assert.equal(resolveBindPlan({ authToken: 'x', bindMode: 'custom', bindHost: '  ::  ' }).host, '::');
  });
});

test.describe('resolveBindPlan —— 未知 BIND_MODE 一律拒绝', () => {
  test('★ typo 必须报错，绝不静默回落到「按 token 推断」', () => {
    // 回落等于：用户以为自己限制了监听面，实际绑的是 0.0.0.0。安全关键项上，
    // 「猜一个」比「停下来」危险得多——与 ACCESS_PROFILE 那种纯声明键的处理刻意不同。
    const p = resolveBindPlan({ authToken: 'x', bindMode: 'lo0pback' });
    assert.ok(p.refuse);
    assert.equal(p.refuse.code, 'unknown_bind_mode');
    assert.match(p.refuse.detail, /lo0pback/, '要点名收到的是什么');
    assert.match(p.refuse.detail, /loopback/, '要列出合法值');
  });

  test('大小写与空白：BIND_MODE 归一后再判（配置文件手打容错）', () => {
    assert.equal(resolveBindPlan({ authToken: 'x', bindMode: ' LOOPBACK ' }).host, '127.0.0.1');
  });
});

test.describe('isLoopbackBindHost', () => {
  test('认全部 loopback 形态（127/8 整段 + IPv6 + 主机名）', () => {
    for (const h of ['127.0.0.1', '127.0.0.2', '127.1.2.3', '::1', 'localhost', 'LOCALHOST', ' 127.0.0.1 ']) {
      assert.equal(isLoopbackBindHost(h), true, h);
    }
  });

  test('通配符与具体地址都不是 loopback（绑它们就是对外可达）', () => {
    for (const h of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.2', '100.64.0.1', '', undefined]) {
      assert.equal(isLoopbackBindHost(h), false, String(h));
    }
  });

  test('不把 127 开头的非 loopback 地址误判（1270.0.0.1 / 127x）', () => {
    assert.equal(isLoopbackBindHost('1270.0.0.1'), false);
    assert.equal(isLoopbackBindHost('127x.0.0.1'), false);
  });
});

test.describe('向后兼容包装：resolveBindHost / bindsPublicly 保持旧签名', () => {
  test('resolveBindHost(token) 与改造前同义（两个 doctor 与门禁都依赖它）', () => {
    assert.equal(resolveBindHost('x'), '0.0.0.0');
    assert.equal(resolveBindHost(''), '127.0.0.1');
    assert.equal(resolveBindHost(undefined), '127.0.0.1');
    assert.equal(resolveBindHost('   '), '0.0.0.0');
  });

  test('bindsPublicly(token) 与改造前同义', () => {
    assert.equal(bindsPublicly('x'), true);
    assert.equal(bindsPublicly(''), false);
    assert.equal(bindsPublicly(undefined), false);
    assert.equal(bindsPublicly('   '), true);
  });

  test('isBlankToken 未受影响', () => {
    assert.equal(isBlankToken('   '), true);
    assert.equal(isBlankToken(''), false);
    assert.equal(isBlankToken('x'), false);
  });
});
