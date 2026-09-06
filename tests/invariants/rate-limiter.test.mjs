// tests/v2/rate-limiter.test.mjs —— 鉴权端口防暴破限速与来源分桶单测
// 守护：AUTH-03（限速仅打鉴权口，退避冷却与长锁定分档提示，防自我 DoS）、AUTH-04（不可信网络来源绝不采信可伪造标头）、DEVICE-01（双本机 bypass 判定，空 Host 不得绕过）
// 测什么：onAuthResult 纯函数状态机转移与指数退避；gateCheck 单一事实源；authRejection 统一拒绝语义；rlSourceKey 来源分桶与 IPv6 /64 归一化；IPv4-mapped 防过度归并；shouldTrustCfConnectingIp 判定；shouldBypassDeviceApproval 双本机与空 Host 守卫
// 不测什么 + 为什么：不测真实 Express 中间件或 Socket.io 握手流程——纯函数与边界计算在此层全覆盖
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  onAuthResult,
  freshState,
  rlSourceKey,
  ipRateBucket,
  authRejection,
  gateCheck,
  shouldTrustCfConnectingIp,
  shouldBypassDeviceApproval,
  DEFAULT_RATE_LIMIT_CONFIG as CFG,
} from '../../app/src/auth/rate-limiter.js';

const T0 = 2_000_000;

function failN(n) {
  let s = freshState();
  let now = T0;
  let last;
  for (let i = 0; i < n; i++) {
    last = onAuthResult(s, false, now, CFG);
    s = last.next;
    now = s.lockUntil + 1;
  }
  return { state: s, last, now };
}

test.describe('AUTH-03: onAuthResult 纯函数状态机与指数退避', () => {
  test('首次失败返回 backoff，failCount=1，retryAfterMs=500ms', () => {
    const r = onAuthResult(freshState(), false, T0, CFG);
    assert.equal(r.verdict, 'backoff');
    assert.equal(r.next.failCount, 1);
    assert.equal(r.retryAfterMs, CFG.baseBackoffMs);
  });

  test('连续失败未达阈值指数退避并封顶 maxBackoffMs (30s)', () => {
    let s = freshState();
    let now = T0;
    const backoffs = [];
    for (let i = 1; i < CFG.threshold; i++) {
      const r = onAuthResult(s, false, now, CFG);
      assert.equal(r.verdict, 'backoff');
      backoffs.push(r.retryAfterMs);
      s = r.next;
      now = s.lockUntil + 1;
    }
    assert.deepEqual(backoffs.slice(0, 3), [500, 1000, 2000]);
    assert.equal(backoffs[backoffs.length - 1], CFG.maxBackoffMs);
  });

  test('连续失败达到 threshold (8次) 触发 locked 长锁 (15分钟)', () => {
    const { last } = failN(CFG.threshold);
    assert.equal(last.verdict, 'locked');
    assert.equal(last.retryAfterMs, CFG.lockMs);
    assert.equal(last.next.failCount, CFG.threshold);
  });

  test('锁定期内再次尝试：拦截且不增加 failCount（防自我 DoS）', () => {
    const { state } = failN(CFG.threshold);
    const probe = state.lockUntil - 5000;
    const r = onAuthResult(state, false, probe, CFG);
    assert.equal(r.verdict, 'locked');
    assert.equal(r.retryAfterMs, 5000);
    assert.equal(r.next.failCount, CFG.threshold);
  });

  test('鉴权成功重置状态机为 freshState（failCount=0, lockUntil=0）', () => {
    const { state } = failN(3);
    const r = onAuthResult(state, true, state.lockUntil + 1, CFG);
    assert.equal(r.verdict, 'allow');
    assert.equal(r.next.failCount, 0);
    assert.equal(r.next.lockUntil, 0);
  });

  test('静默超过 decayMs (15分钟) 后再失败重置 failCount 为 1', () => {
    let s = onAuthResult(freshState(), false, T0, CFG).next;
    s = onAuthResult(s, false, s.lockUntil + 1, CFG).next;
    assert.equal(s.failCount, 2);

    const now = s.lastFailTs + CFG.decayMs + 10;
    const r = onAuthResult(s, false, now, CFG);
    assert.equal(r.verdict, 'backoff');
    assert.equal(r.next.failCount, 1);
  });
});

test.describe('AUTH-03: 冷却期 (cooldown) 与长锁 (locked) 分档及单一事实源', () => {
  test('只失败 1 次在退避期内的下一次请求判为 cooldown 而非 locked', () => {
    const first = onAuthResult(freshState(), false, T0, CFG);
    assert.equal(first.verdict, 'backoff');
    const second = onAuthResult(first.next, false, T0 + 200, CFG);
    assert.equal(second.verdict, 'cooldown');
    assert.equal(second.next.failCount, 1);
  });

  test('authRejection 语义：cooldown 返回 401 unauthorized（不提示 retryAfter，语义是令牌错）', () => {
    const r = authRejection({ verdict: 'cooldown', retryAfterMs: 300 });
    assert.equal(r.reason, 'unauthorized');
    assert.equal(r.httpStatus, 401);
    assert.equal(r.retryAfterMs, null);
    assert.equal(r.retryAfterSeconds, null);
  });

  test('authRejection 语义：locked 返回 429 rate_limited 且提供向上取整的秒数', () => {
    const r = authRejection({ verdict: 'locked', retryAfterMs: 65432 });
    assert.equal(r.reason, 'rate_limited');
    assert.equal(r.httpStatus, 429);
    assert.equal(r.retryAfterMs, 65432);
    assert.equal(r.retryAfterSeconds, 66);
  });

  test('gateCheck 统一锁定门判断：无锁返回 null，退避返回 cooldown，超阈值返回 locked', () => {
    assert.equal(gateCheck(freshState(), T0, CFG), null);

    const backoffState = onAuthResult(freshState(), false, T0, CFG).next;
    assert.equal(gateCheck(backoffState, T0 + 100, CFG).verdict, 'cooldown');
    assert.equal(gateCheck(backoffState, T0 + CFG.baseBackoffMs, CFG), null);

    const { state } = failN(CFG.threshold);
    assert.equal(gateCheck(state, state.lockUntil - 1000, CFG).verdict, 'locked');
  });
});

test.describe('AUTH-04: 来源识别、防伪造与 IPv6 归桶', () => {
  const norm = (x) => (x || '').replace(/^::ffff:/, '');

  test('公网且启用 trustCfConnectingIp 时采信 CF-Connecting-IP', () => {
    const hs = { address: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.195' } };
    assert.equal(rlSourceKey(hs, norm, { trustCfConnectingIp: true }), 'cfip:203.0.113.195');
  });

  test('LAN 默认 trustCfConnectingIp=false 时忽略 CF-IP，绝不采信客户端声明', () => {
    const hs = { address: '192.168.1.50', headers: { 'cf-connecting-ip': '203.0.113.195' } };
    assert.equal(rlSourceKey(hs, norm), 'ip:192.168.1.50');
    assert.equal(rlSourceKey(hs, norm, { trustCfConnectingIp: false }), 'ip:192.168.1.50');
  });

  test('绝不采信 X-Forwarded-For 标头', () => {
    const hs = { address: '10.0.0.5', headers: { 'x-forwarded-for': '1.1.1.1' } };
    assert.equal(rlSourceKey(hs, norm), 'ip:10.0.0.5');
  });

  test('IPv6 按 /64 前缀分桶，同一 /64 内的不同地址共用限速桶', () => {
    const key = (addr) => rlSourceKey({ address: addr, headers: {} }, norm);
    const ip1 = key('2408:8207:1:2::1');
    const ip2 = key('2408:8207:1:2::ffff');
    const ip3 = key('2408:8207:1:2:aaaa:bbbb:cccc:dddd');
    assert.equal(ip1, ip2);
    assert.equal(ip2, ip3);
    assert.equal(ip1, 'ip:2408:8207:1:2::/64');

    const differentSubnet = key('2408:8207:1:3::1');
    assert.notEqual(ip1, differentSubnet);
  });

  test('IPv4-mapped 地址还原为独立 IPv4，不坍缩到 0:0:0:0::/64 桶', () => {
    const raw = (addr) => rlSourceKey({ address: addr, headers: {} });
    assert.equal(raw('::ffff:192.168.1.1'), 'ip:192.168.1.1');
    assert.equal(raw('::ffff:10.0.0.1'), 'ip:10.0.0.1');
    assert.notEqual(raw('::ffff:192.168.1.1'), raw('::ffff:10.0.0.1'));
  });

  test('shouldTrustCfConnectingIp: 仅当 publicHost 为真且 peerAddress 为本机 loopback 时采信', () => {
    assert.equal(shouldTrustCfConnectingIp({ publicHost: true, peerAddress: '127.0.0.1' }, norm), true);
    assert.equal(shouldTrustCfConnectingIp({ publicHost: true, peerAddress: '::1' }, norm), true);
    assert.equal(shouldTrustCfConnectingIp({ publicHost: true, peerAddress: 'localhost' }, norm), true);

    // 伪造公网 Host 的局域网流量不得采信
    assert.equal(shouldTrustCfConnectingIp({ publicHost: true, peerAddress: '192.168.1.20' }, norm), false);
    assert.equal(shouldTrustCfConnectingIp({ publicHost: false, peerAddress: '127.0.0.1' }, norm), false);
  });

  test('ipRateBucket 直接边界：IPv6 取前 4 组 /64，IPv4 原样返回', () => {
    assert.equal(ipRateBucket('2408:8207:0001:0002:0000:0000:0000:0001'), '2408:8207:1:2::/64');
    assert.equal(ipRateBucket('FE80::1'), 'fe80:0:0:0::/64');
    assert.equal(ipRateBucket('192.168.1.1'), '192.168.1.1');
    assert.equal(ipRateBucket(null), '');
  });
});

test.describe('DEVICE-01: shouldBypassDeviceApproval 设备审批跳过判定', () => {
  const norm = (x) => (x || '').replace(/^::ffff:/, '');

  test('CF Access 验签通过直接跳过审批', () => {
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: true,
      peerAddress: '203.0.113.1',
      hostHeader: 'ccm.example.com',
    }, norm), true);
  });

  test('真本机（peer 为 loopback 且 Host 为 localhost/127.0.0.1）跳过审批', () => {
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: false,
      peerAddress: '127.0.0.1',
      hostHeader: 'localhost:3000',
    }, norm), true);
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: false,
      peerAddress: '::1',
      hostHeader: '127.0.0.1:3000',
    }, norm), true);
  });

  test('隧道终止在本机（peer 为 loopback 但 Host 为公网域名）不得跳过审批', () => {
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: false,
      peerAddress: '127.0.0.1',
      hostHeader: 'chat.example.com',
    }, norm), false);
  });

  test('LAN 访问不得跳过审批', () => {
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: false,
      peerAddress: '192.168.1.100',
      hostHeader: '192.168.1.5:3000',
    }, norm), false);
  });

  // ★ 变异实测（2026-09-05）：把 peerLocal 那行三个 === 里的任意一个改成 !==，本 describe 的
  // 其余用例【全绿】。原因是它们的 Host 也非本机（公网域名 / LAN IP / 空），第二道闸兜住了结果
  // ——于是「peer 那半边到底有没有在守」测试根本不知道，谁把它简化掉都不会红。
  //
  // 双条件的两半必须各有一条用例【只让那一半说话】：上面「隧道终止在本机」固定 peer 为 loopback、
  // 只动 Host；这一条反过来固定 Host 为本机样、只动 peer。缺了本条，变异后 LAN 客户端只要发
  // `Host: localhost` 就跳过设备审批（peerLocal 对任何非 localhost 的 IP 都为真）。
  //
  // Host 不取 '::1'：split(':')[0] 会得到空串，落不到 localhost 分支，那样本条会因为第二道闸
  // 而非第一道闸通过——用例就白写了。
  test('非 loopback peer + 本机样 Host 不得跳过审批（只让 peer 那一半说话）', () => {
    for (const peerAddress of ['192.168.1.100', '203.0.113.9', '10.0.0.7']) {
      for (const hostHeader of ['localhost:3000', 'localhost', '127.0.0.1']) {
        assert.equal(
          shouldBypassDeviceApproval({ accessEnabled: false, peerAddress, hostHeader }, norm),
          false,
          `peer=${peerAddress} host=${hostHeader} 必须落入待审批，不得当成真本机直连`,
        );
      }
    }
  });

  test('空 Host 或缺失 Host 绝不视为本机（防反代置空 Host 绕过）', () => {
    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: false,
      peerAddress: '127.0.0.1',
      hostHeader: '',
    }, norm), false);

    assert.equal(shouldBypassDeviceApproval({
      accessEnabled: false,
      peerAddress: '127.0.0.1',
      hostHeader: undefined,
    }, norm), false);
  });
});

// ── IPv6 解析与 CF-IP 提取的边界 ────────────────────────────────────────────
// 本节补的是变异对比里「旧测试独占咬住、v2 原先漏掉」的四个点（117/132/176×2）。
// 共同点是【两个条件必须同时成立】，写成 || 都不会让任何既有用例变红。
test.describe('ipRateBucket：畸形 IPv6 一律原样返回，绝不猜着分桶', () => {
  test('段数不足但格式合法 → 原样（长度与格式是两道独立校验）', () => {
    // `parts.length !== 8 || 格式非法` 若写成 &&，'1:2:3' 会被当合法地址继续算 /64，
    // 产出一个凭空捏造的桶——保守方向是宁可多分桶，绝不误合并。
    assert.equal(ipRateBucket('1:2:3'), '1:2:3');
  });

  test('段数正确但含非法字符 → 原样', () => {
    assert.equal(ipRateBucket('gggg:1:2:3:4:5:6:7'), 'gggg:1:2:3:4:5:6:7');
  });

  test('多个 :: 或 :: 填不出一组零 → 原样', () => {
    assert.equal(ipRateBucket('1::2::3'), '1::2::3');
    assert.equal(ipRateBucket('1:2:3:4:5:6:7::8'), '1:2:3:4:5:6:7::8');
  });

  test('IPv4 与空串原样返回', () => {
    assert.equal(ipRateBucket('192.168.1.1'), '192.168.1.1');
    assert.equal(ipRateBucket(''), '');
    assert.equal(ipRateBucket(null), '');
  });
});

test.describe('IPv4-mapped 识别：前 5 段全零【且】第 6 段是 ffff', () => {
  // 少了这一步，::ffff:x.x.x.x 段所有地址的前 4 组 hextet 都是 0 → 全世界 IPv4 来源
  // 塌成同一个桶，一台机器触发锁定就把所有 IPv4 客户端一起锁死。
  // 但判据放松成「或」同样危险：会把普通 IPv6 地址误还原成点分十进制，凭空并桶。
  test('真正的 IPv4-mapped 还原成点分十进制，按整地址计桶', () => {
    assert.equal(ipRateBucket('::ffff:127.0.0.1'), '127.0.0.1');
    assert.equal(ipRateBucket('::ffff:7f00:1'), '127.0.0.1');
  });

  test('前 5 段全零但第 6 段不是 ffff → 仍按 /64，不得当成 IPv4', () => {
    assert.equal(ipRateBucket('::1:2:3'), '0:0:0:0::/64');
  });

  test('第 6 段是 ffff 但前 5 段不全零 → 仍按 /64', () => {
    assert.equal(ipRateBucket('1::ffff:2:3'), '1:0:0:0::/64');
  });
});

test.describe('cf-connecting-ip：存在、是字符串、非空白，三者缺一不可', () => {
  test('非字符串的 CF-IP 不采用，回落到 peer 地址', () => {
    // `cfip && typeof cfip === 'string' && cfip.trim()` 三个条件任一写成 ||，
    // 数字型 CF-IP 要么被当成合法值分桶、要么在 .trim() 上直接抛 TypeError。
    for (const bad of [123, true, {}, []]) {
      const hs = { address: '10.0.0.7', headers: { 'cf-connecting-ip': bad } };
      assert.equal(rlSourceKey(hs, x => x, { trustCfConnectingIp: true }), 'ip:10.0.0.7',
        `CF-IP=${JSON.stringify(bad)} 不是字符串，必须回落 peer`);
    }
  });

  test('空白字符串的 CF-IP 不采用', () => {
    const hs = { address: '10.0.0.7', headers: { 'cf-connecting-ip': '   ' } };
    assert.equal(rlSourceKey(hs, x => x, { trustCfConnectingIp: true }), 'ip:10.0.0.7');
  });

  test('缺省 normalizeIp 是恒等函数：IPv4-mapped 的 peer 地址会真走到还原分支', () => {
    // 调用方通常注入剥前缀的 normalizeIp，但缺省是恒等——BIND_HOST=:: 双栈监听下
    // 客户端 address 本来就长这样，这条路随时会真走到。
    assert.equal(rlSourceKey({ address: '::ffff:127.0.0.1', headers: {} }), 'ip:127.0.0.1');
  });
});

test.describe('shouldBypassDeviceApproval 的默认参数：缺省必须是「不放行」', () => {
  test('不传 accessEnabled 时不得默认 bypass（默认值写成 true 等于设备门形同虚设）', () => {
    // 这是第二因子。默认值一旦反向，任何忘记传参的调用方都会静默跳过设备审批，
    // 而症状是「一切正常」——新设备直接就能操作。
    assert.equal(shouldBypassDeviceApproval({ peerAddress: '203.0.113.9', hostHeader: 'chat.example.com' }), false);
    assert.equal(shouldBypassDeviceApproval({}), false, '空参数必须落到拒绝侧');
  });

  test('显式 accessEnabled=true 才 bypass（CF Access 已验是合法豁免）', () => {
    assert.equal(shouldBypassDeviceApproval({ accessEnabled: true, peerAddress: '203.0.113.9', hostHeader: 'x.com' }), true);
  });
});
