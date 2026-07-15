import test from 'node:test';
import assert from 'node:assert/strict';

import { lanIPv4s } from '../../src/server/http.js';

// 夹具：networkInterfaces() 同形数据
const IF = (family, address, internal = false) => ({ family, address, internal });

test('lanIPv4s：保留物理网卡上的常规局域网 IPv4', () => {
  const ips = lanIPv4s({
    en0: [IF('IPv6', 'fe80::1'), IF('IPv4', '192.168.1.110')],
    en1: [IF('IPv4', '10.0.0.5')],
  });
  assert.deepEqual(ips, ['192.168.1.110', '10.0.0.5']);
});

test('lanIPv4s：排除 VPN/代理虚拟网卡（utun/tun/tap/ppp，手机不可达）', () => {
  const ips = lanIPv4s({
    utun4: [IF('IPv4', '198.18.0.1')],
    tun0: [IF('IPv4', '10.8.0.2')],
    tap1: [IF('IPv4', '10.9.0.2')],
    ppp0: [IF('IPv4', '10.10.0.2')],
    en0: [IF('IPv4', '192.168.1.110')],
  });
  assert.deepEqual(ips, ['192.168.1.110']);
});

test('lanIPv4s：排除 loopback/link-local/RFC2544 基准段（TUN 代理假网段）', () => {
  const ips = lanIPv4s({
    lo0: [IF('IPv4', '127.0.0.1', true)],
    en0: [IF('IPv4', '169.254.7.7'), IF('IPv4', '198.18.5.5'), IF('IPv4', '198.19.5.5'), IF('IPv4', '192.168.1.110')],
  });
  assert.deepEqual(ips, ['192.168.1.110']);
});

test('lanIPv4s：空/畸形地址条目安全跳过', () => {
  const ips = lanIPv4s({ en0: [null, undefined, IF('IPv4', '192.168.1.2')] });
  assert.deepEqual(ips, ['192.168.1.2']);
});
