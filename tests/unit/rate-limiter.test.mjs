// tests/unit/rate-limiter.test.mjs —— 鉴权端口防暴破限速纯函数状态机单测（零依赖，承接 docs/design.md / NFR-03）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  onAuthResult,
  freshState,
  rlSourceKey,
  ipRateBucket,
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

// SEC（2026-09-01）：IPv6 限速按 /64 归桶。
// IPv4 时代「一个 IP ≈ 一个来源」的假设在 IPv6 下失效——终端用户拿到的最小分配就是一整个 /64
// （2^64 个地址），逐地址计桶等于每换一个源地址就得到一个全新的 failCount=0 桶，登录暴破限速被绕过。
// BIND_MODE=custom + BIND_HOST=:: 打开 IPv6 监听后这条路径才真正可达，是新开的风险面。
test.describe('rlSourceKey：IPv6 按 /64 归桶（防换源地址绕过限速）', () => {
  const norm = (x) => (x || '').replace(/^::ffff:/, '');
  const key = (addr) => rlSourceKey({ address: addr, headers: {} }, norm);

  test('同一 /64 内的不同地址 → 同一个桶（本机实测的三个绕过样本）', () => {
    const a = key('2408:8207:1:2::1');
    const b = key('2408:8207:1:2::99ff');
    const c = key('2408:8207:1:2:aaaa:bbbb:cccc:dddd');
    assert.equal(a, b);
    assert.equal(b, c);
    assert.match(a, /\/64$/, '桶标识须显式带 /64，日志/审计里能一眼看出是前缀而非某个具体地址');
  });

  test('不同 /64 → 不同桶（归桶不得过度合并）', () => {
    assert.notEqual(key('2408:8207:1:2::1'), key('2408:8207:1:3::1'), '相邻 /64 是不同来源');
    assert.notEqual(key('2408:8207:1:2::1'), key('2001:db8:1:2::1'));
  });

  test('书写形式归一：压缩 / 前导零 / 大小写 落同一个桶', () => {
    const canonical = key('2001:db8:1:2::1');
    assert.equal(key('2001:0db8:0001:0002:0000:0000:0000:0001'), canonical, '前导零');
    assert.equal(key('2001:DB8:1:2::1'), canonical, '大写');
    assert.equal(key('2001:db8:1:2:0:0:0:1'), canonical, '未压缩');
  });

  test('zone id 剥离：不因网卡名把同一地址拆成两个桶', () => {
    assert.equal(key('fe80::1%en0'), key('fe80::1%en1'));
  });

  test('IPv4 行为逐字节不变（不带 /64、不被改写）', () => {
    assert.equal(key('203.0.113.7'), 'ip:203.0.113.7');
    assert.equal(key('10.0.0.9'), 'ip:10.0.0.9');
    assert.equal(key('127.0.0.1'), 'ip:127.0.0.1');
    assert.notEqual(key('10.0.0.9'), key('10.0.0.10'), 'IPv4 仍按整地址分桶');
  });

  test('IPv4-mapped ::ffff:x.x.x.x 走 IPv4 路径（clientIp 已剥前缀）', () => {
    assert.equal(key('::ffff:192.168.1.5'), 'ip:192.168.1.5');
    assert.notEqual(key('::ffff:192.168.1.5'), key('::ffff:192.168.1.6'));
  });

  test('IPv4-mapped 在 normalizeIp 缺省（恒等）时也还原成 IPv4，不塌成同一个桶', () => {
    // rlSourceKey 的 normalizeIp 默认是恒等函数。若缺了 IPv4-mapped 判定，::ffff:0:0/96 里所有地址
    // 的前 4 组 hextet 都是 0 → 全世界的 IPv4 来源合并成一个 `0:0:0:0::/64` 桶，一台机器触发锁定
    // 就把所有 IPv4 客户端一起锁死。这是过度合并里最严重的一种，必须有测试钉住。
    const raw = (addr) => rlSourceKey({ address: addr, headers: {} });
    assert.equal(raw('::ffff:192.168.1.5'), 'ip:192.168.1.5');
    assert.notEqual(raw('::ffff:192.168.1.5'), raw('::ffff:10.0.0.1'));
  });

  test('IPv6 loopback 归入自己的桶，不与公网地址混', () => {
    assert.notEqual(key('::1'), key('2408:8207:1:2::1'));
    assert.equal(key('::1'), key('::2'), '同 /64 一致归并（loopback 段只有本机，合并无副作用）');
  });

  test('CF-Connecting-IP 为 IPv6 时同样按 /64 归桶（同一个绕过面）', () => {
    const hs = ip => ({ address: '127.0.0.1', headers: { 'cf-connecting-ip': ip } });
    const opt = { trustCfConnectingIp: true };
    assert.equal(rlSourceKey(hs('2408:8207:1:2::1'), norm, opt),
      rlSourceKey(hs('2408:8207:1:2::beef'), norm, opt));
    assert.equal(rlSourceKey(hs('203.0.113.7'), norm, opt), 'cfip:203.0.113.7', 'IPv4 的 CF-IP 行为不变');
  });

  test('畸形 / 非地址输入原样落桶：不崩，且宁可多分桶也不误合并', () => {
    assert.equal(key(''), 'ip:');
    assert.equal(key('not-an-ip'), 'ip:not-an-ip');
    assert.equal(key('2001:db8::1::2'), 'ip:2001:db8::1::2', '两处 :: 非法');
    assert.equal(key('2001:db8:zzzz::1'), 'ip:2001:db8:zzzz::1', '非 hex 组');
    assert.equal(key('1:2:3:4:5:6:7:8:9'), 'ip:1:2:3:4:5:6:7:8:9', '超 8 组');
  });
});

test.describe('ipRateBucket 直接边界（归桶纯函数）', () => {
  test('/64 前缀取前 4 组 hextet，输出规范小写去前导零', () => {
    assert.equal(ipRateBucket('2408:8207:0001:0002:0000:0000:0000:0001'), '2408:8207:1:2::/64');
    assert.equal(ipRateBucket('FE80::1'), 'fe80:0:0:0::/64');
  });

  test('未压缩全零 / unspecified 不崩', () => {
    assert.equal(ipRateBucket('::'), '0:0:0:0::/64');
  });

  test('带方括号形式（[::1]）也能解析', () => {
    assert.equal(ipRateBucket('[2001:db8:1:2::5]'), '2001:db8:1:2::/64');
  });

  test('非字符串输入不崩', () => {
    assert.equal(ipRateBucket(null), '');
    assert.equal(ipRateBucket(undefined), '');
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
