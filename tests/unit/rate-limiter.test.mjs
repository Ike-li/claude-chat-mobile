// tests/unit/rate-limiter.test.mjs —— 鉴权端口防暴破限速纯函数状态机单测（零依赖，承接 docs/design.md / NFR-03）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  onAuthResult,
  freshState,
  rlSourceKey,
  shouldTrustCfConnectingIp,
  shouldBypassDeviceApproval,
  DEFAULT_RATE_LIMIT_CONFIG as CFG,
} from '../../src/auth/rate-limiter.js';

const T0 = 1_000_000; // 基准时刻（远大于 decayMs 起点，避免衰减分支歧义）

// 连续失败 n 次：每次都跳到上一次退避/锁定结束后再试（模拟真实攻击者到点重试）。
function failN(n) {
  let s = freshState();
  let now = T0;
  let last;
  for (let i = 0; i < n; i++) {
    last = onAuthResult(s, false, now, CFG);
    s = last.next;
    now = s.lockUntil + 1; // 跳过退避/锁定窗口
  }
  return { state: s, last, now };
}

test.describe('onAuthResult 纯函数状态机', () => {
  test('首次失败 → backoff，failCount=1，retryAfter=baseBackoff', () => {
    const r = onAuthResult(freshState(), false, T0, CFG);
    assert.equal(r.verdict, 'backoff');
    assert.equal(r.next.failCount, 1);
    assert.equal(r.retryAfterMs, CFG.baseBackoffMs);
  });

  test('连续失败到 threshold → locked，retryAfter=lockMs，failCount=threshold', () => {
    const { last } = failN(CFG.threshold);
    assert.equal(last.verdict, 'locked');
    assert.equal(last.retryAfterMs, CFG.lockMs);
    assert.equal(last.next.failCount, CFG.threshold);
  });

  test('锁定期内再尝试 → locked + retryAfter 递减，且不再累加计数（防自我 DoS）', () => {
    const { state } = failN(CFG.threshold); // state.lockUntil 已设为触发锁定时刻 + lockMs
    const lockedAt = state.lockUntil - CFG.lockMs;
    const probe = lockedAt + 1000; // 锁定期内
    const r = onAuthResult(state, false, probe, CFG);
    assert.equal(r.verdict, 'locked');
    assert.equal(r.retryAfterMs, state.lockUntil - probe);
    assert.equal(r.next.failCount, state.failCount, '锁定期内尝试不计数');
    const r2 = onAuthResult(state, false, probe + 500, CFG);
    assert.ok(r2.retryAfterMs < r.retryAfterMs, 'retryAfter 应随时间递减');
  });

  test('成功 → 清零（allow + failCount=0 + lockUntil=0）', () => {
    const { state } = failN(3);
    const now = state.lockUntil + 1;
    const r = onAuthResult(state, true, now, CFG);
    assert.equal(r.verdict, 'allow');
    assert.equal(r.next.failCount, 0);
    assert.equal(r.next.lockUntil, 0);
  });

  test('静默超过 decayMs 后再失败 → 计数重置为 1（不永久惩罚）', () => {
    let s = onAuthResult(freshState(), false, T0, CFG).next;   // failCount=1
    s = onAuthResult(s, false, s.lockUntil + 1, CFG).next;      // failCount=2
    const now = s.lastFailTs + CFG.decayMs + 1;                 // 静默超 decayMs
    const r = onAuthResult(s, false, now, CFG);
    assert.equal(r.next.failCount, 1, '静默超 decayMs 后失败计数应重置为 1');
    assert.equal(r.verdict, 'backoff');
    assert.equal(r.retryAfterMs, CFG.baseBackoffMs);
  });

  test('退避指数增长并封顶 maxBackoff', () => {
    let s = freshState();
    let now = T0;
    const backoffs = [];
    for (let i = 1; i < CFG.threshold; i++) {       // failCount 1..threshold-1 都是 backoff
      const r = onAuthResult(s, false, now, CFG);
      assert.equal(r.verdict, 'backoff');
      backoffs.push(r.retryAfterMs);
      s = r.next;
      now = s.lockUntil + 1;
    }
    assert.equal(backoffs[0], 500);
    assert.equal(backoffs[1], 1000);
    assert.equal(backoffs[2], 2000);
    for (const b of backoffs) assert.ok(b <= CFG.maxBackoffMs, '退避不得超封顶');
    assert.equal(backoffs[backoffs.length - 1], CFG.maxBackoffMs, '末次退避应已封顶');
  });

  test('默认参数 = OQ-03 已决值', () => {
    assert.equal(CFG.threshold, 8);
    assert.equal(CFG.baseBackoffMs, 500);
    assert.equal(CFG.maxBackoffMs, 30_000);
    assert.equal(CFG.lockMs, 15 * 60_000);
    assert.equal(CFG.decayMs, 15 * 60_000);
  });

  test('null/undefined state 视为 fresh，不崩', () => {
    const r = onAuthResult(undefined, false, T0, CFG);
    assert.equal(r.next.failCount, 1);
    assert.equal(r.verdict, 'backoff');
  });
});

test.describe('rlSourceKey 来源识别', () => {
  const norm = (x) => (x || '').replace(/^::ffff:/, ''); // 同 server.js clientIp

  test('公网路径 trustCfConnectingIp=true → 优先 CF-Connecting-IP', () => {
    const hs = { address: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.7' } };
    assert.equal(rlSourceKey(hs, norm, { trustCfConnectingIp: true }), 'cfip:203.0.113.7');
  });

  // AUTH-002：默认/LAN 不采信 CF-IP（客户端可伪造拆分限速桶）
  test('LAN 默认 trustCfConnectingIp=false → 忽略 CF-IP 用连接 IP（AUTH-002）', () => {
    const hs = { address: '10.0.0.9', headers: { 'cf-connecting-ip': '203.0.113.7' } };
    assert.equal(rlSourceKey(hs, norm), 'ip:10.0.0.9');
    assert.equal(rlSourceKey(hs, norm, { trustCfConnectingIp: false }), 'ip:10.0.0.9');
  });

  test('无 CF-IP → 回退连接 IP（去 ::ffff: 前缀）', () => {
    const hs = { address: '::ffff:192.168.1.5', headers: {} };
    assert.equal(rlSourceKey(hs, norm, { trustCfConnectingIp: true }), 'ip:192.168.1.5');
  });

  test('绝不信客户端伪造的 X-Forwarded-For', () => {
    const hs = { address: '10.0.0.2', headers: { 'x-forwarded-for': '1.2.3.4' } };
    assert.equal(rlSourceKey(hs, norm), 'ip:10.0.0.2', '有 XFF 无 CF-IP 时仍用连接 IP、不采 XFF');
  });

  test('CF-IP 为空串 → 回退连接 IP', () => {
    const hs = { address: '10.0.0.3', headers: { 'cf-connecting-ip': '  ' } };
    assert.equal(rlSourceKey(hs, norm, { trustCfConnectingIp: true }), 'ip:10.0.0.3');
  });
});

// AUTH-NEW-2：仅当 Host 公网且 peer 为 loopback（隧道终止）时采信 CF-IP
test.describe('shouldTrustCfConnectingIp（AUTH-NEW-2）', () => {
  const norm = (x) => (x || '').replace(/^::ffff:/, '');

  test('非公网 Host → 永不信', () => {
    assert.equal(shouldTrustCfConnectingIp({ publicHost: false, peerAddress: '127.0.0.1' }, norm), false);
  });

  test('公网 Host + loopback peer → 信（cloudflared 拓扑）', () => {
    assert.equal(shouldTrustCfConnectingIp({ publicHost: true, peerAddress: '127.0.0.1' }, norm), true);
    assert.equal(shouldTrustCfConnectingIp({ publicHost: true, peerAddress: '::1' }, norm), true);
    assert.equal(shouldTrustCfConnectingIp({ publicHost: true, peerAddress: '::ffff:127.0.0.1' }, norm), true);
  });

  test('公网 Host + LAN peer（Host spoof）→ 不信', () => {
    assert.equal(shouldTrustCfConnectingIp({ publicHost: true, peerAddress: '10.0.0.8' }, norm), false);
    assert.equal(shouldTrustCfConnectingIp({ publicHost: true, peerAddress: '192.168.1.10' }, norm), false);
  });
});

// 设备审批 bypass：反代 loopback 不得仅因 peer=127.0.0.1 跳过 deviceToken
test.describe('shouldBypassDeviceApproval', () => {
  const norm = (x) => (x || '').replace(/^::ffff:/, '');

  test('CF Access 已验 → bypass', () => {
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: true, peerAddress: '10.0.0.1', hostHeader: 'ccm.example.com',
    }, norm), true);
  });

  test('真本机：peer loopback + Host localhost → bypass', () => {
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: false, peerAddress: '127.0.0.1', hostHeader: 'localhost:3000',
    }, norm), true);
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: false, peerAddress: '::1', hostHeader: '127.0.0.1',
    }, norm), true);
  });

  test('隧道：peer loopback + 公网 Host → 不 bypass（须 deviceToken）', () => {
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: false, peerAddress: '127.0.0.1', hostHeader: 'ccm.example.com',
    }, norm), false);
  });

  test('LAN 直连 → 不 bypass', () => {
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: false, peerAddress: '192.168.1.20', hostHeader: '192.168.1.20:3000',
    }, norm), false);
  });
});

// R8（2026-08-06 BUG hunting review）：空 Host 不再等同「真本机」。
// 旧判据把 host === '' 与 localhost 并列 bypass 设备门，理由写的是「本机工具/健康探针」——但实测
// 项目内没有任何调用方发空 Host（浏览器 / socket.io-client / fetch 全都带），而 /health、/metrics
// 根本不走 bypass（只过 httpAuth）。留着它等于：反代若配成 proxy_set_header Host ""，公网请求
// 就被当成真本机直连、跳过设备审批——一行配置错误打穿一层防护。
// 收紧代价极轻：真发空 Host 的客户端落入待审列表，机主批准一次即可，不是硬拒绝。
test.describe('shouldBypassDeviceApproval：空 Host 不算本机（R8）', () => {
  const norm = (x) => (x || '').replace(/^::ffff:/, '');

  test('peer loopback + 空 Host → 不 bypass（反代置空 Host 的绕过面）', () => {
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: false, peerAddress: '127.0.0.1', hostHeader: '',
    }, norm), false);
  });

  test('peer loopback + 缺失 Host 头（undefined）→ 同样不 bypass', () => {
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: false, peerAddress: '127.0.0.1',
    }, norm), false);
  });

  test('CF Access 已验时空 Host 仍 bypass（JWT 是更强的边界，与 Host 无关）', () => {
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: true, peerAddress: '127.0.0.1', hostHeader: '',
    }, norm), true);
  });
});
