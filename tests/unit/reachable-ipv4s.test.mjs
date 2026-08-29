import test from 'node:test';
import assert from 'node:assert/strict';

import { reachableIPv4s } from '../../src/server/http.js';

// 夹具：networkInterfaces() 同形数据
const IF = (family, address, internal = false) => ({ family, address, internal });

test('reachableIPv4s：保留物理网卡上的常规局域网 IPv4', () => {
  const ips = reachableIPv4s({
    en0: [IF('IPv6', 'fe80::1'), IF('IPv4', '192.168.1.110')],
    en1: [IF('IPv4', '10.0.0.5')],
  });
  assert.deepEqual(ips, ['192.168.1.110', '10.0.0.5']);
});

// 2026-08-28：判据从「接口名」改成「地址段」。旧判据按 utun/tun/tap/ppp 排除整个接口，
// 前提是「虚拟网卡上的地址手机不可达」——而这个前提对 VPN 类入口恰好是反的：走 WireGuard /
// Tailscale 时，隧道内地址是手机**唯一**可达的那个。旧判据还带来平台分裂：同一个 WireGuard
// 在 macOS 上叫 utun0（被滤），在 Linux 上叫 wg0（保留）。接口名是 OS 实现细节，不是可达性判据。
test('reachableIPv4s：保留隧道接口上的私网地址（macOS 的 WireGuard/Tailscale 都落在 utun*）', () => {
  const ips = reachableIPv4s({
    utun3: [IF('IPv4', '100.101.102.103')],   // Tailscale：CGNAT 段
    utun0: [IF('IPv4', '10.8.0.2')],          // WireGuard：自定义私网段
    en0: [IF('IPv4', '192.168.1.110')],
  });
  assert.deepEqual(ips, ['100.101.102.103', '10.8.0.2', '192.168.1.110']);
});

// 输入是刻意交叉构造的：假网段放在**非**隧道命名的接口上，好地址放在隧道命名的接口上。
// 新旧判据在这里给出不同结果（旧实现 → `[]`，新实现 → `['10.8.0.2']`），这条才真的在测判据。
// 上一版把 198.18 放在 utun4 上，旧实现按名字先丢掉整个接口、地址段规则根本没机会跑，
// 两种实现返回同一个结果——测试恒绿，证不了它名字里声称的「与接口名无关」。
test('reachableIPv4s：判据与接口名无关——假网段在哪种接口上都排除，好地址在哪种接口上都保留', () => {
  const ips = reachableIPv4s({
    wg0: [IF('IPv4', '198.18.0.1')],    // 非隧道命名，但地址是 TUN 代理假段 → 排除
    utun0: [IF('IPv4', '10.8.0.2')],    // 隧道命名，但地址是正常私网 → 保留
  });
  assert.deepEqual(ips, ['10.8.0.2']);
});

test('reachableIPv4s：排除 loopback/link-local/RFC2544 基准段（TUN 代理假网段）', () => {
  const ips = reachableIPv4s({
    lo0: [IF('IPv4', '127.0.0.1', true)],
    en0: [IF('IPv4', '169.254.7.7'), IF('IPv4', '198.18.5.5'), IF('IPv4', '198.19.5.5'), IF('IPv4', '192.168.1.110')],
  });
  assert.deepEqual(ips, ['192.168.1.110']);
});

// ppp* 的覆盖在判据切换时一度丢失。旧实现按名字排除它，而 PPPoE 拨号主机上那个地址恰恰是
// 本机的公网 IP——现在会被列出。这是有意的（公网地址确实可达，且隐藏「唯一可达的地址」是更坏的失败），
// 钉在这里以免日后被当成回归改回去。
test('reachableIPv4s：PPPoE 接口上的公网地址会被列出（判据不看接口名）', () => {
  const ips = reachableIPv4s({ ppp0: [IF('IPv4', '203.0.113.5')] });
  assert.deepEqual(ips, ['203.0.113.5']);
});

test('reachableIPv4s：空/畸形地址条目安全跳过', () => {
  const ips = reachableIPv4s({ en0: [null, undefined, IF('IPv4', '192.168.1.2')] });
  assert.deepEqual(ips, ['192.168.1.2']);
});
