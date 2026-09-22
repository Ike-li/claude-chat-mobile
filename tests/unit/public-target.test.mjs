// tests/unit/public-target.test.mjs —— 公网二维码「用哪个地址、带不带令牌」的决策。
//
// 【为什么在 unit/】不在 tests/README.md 的编号表里。但注意它守的东西不轻：判错方向的两个
// 后果不对称——多带令牌是**安全退化**（把一份全世界可用的凭据印进码里），漏带令牌只是
// 扫了进不去。两个方向都测。
//
// 【判据的出处】app/src/auth/cf-access.js:113 那条契约：Access 生效时按 Host 路由、
// 公网请求只走 JWT，**不回退 AUTH_TOKEN**。所以受 Access 保护的域名，二维码里的令牌
// 在那条路径上是死数据——带上它只增加暴露面，扫码后照样要过 2FA。
// 而 Access 的生效判据是**三项 env 齐全**（cf-access.js:92），只配了域名等于没开——
// 那时公网仍由 AUTH_TOKEN 独自把守，令牌必须带，否则做出来的是一张扫了进不去的码。

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublicTarget, protectedByAccess, isBareHostname } from '../../app/src/shared/public-target.js';

const PORT = 3000;

test('resolvePublicTarget：CF Access 三项齐全 → 用该域名且不带令牌', () => {
  const t = resolvePublicTarget({
    cfHostname: 'ccm.example.com', accessEnabled: true, tailscaleDns: '', port: PORT,
  });
  assert.equal(t.url, 'https://ccm.example.com');
  assert.equal(t.includeToken, false, 'Access 生效时令牌不参与鉴权，不该进二维码');
  assert.match(t.note, /Access/);
});

test('resolvePublicTarget：只配了域名、Access 未生效 → 仍用该域名但必须带令牌', () => {
  // 失败方向：这里若沿用「配了 CF_ACCESS_HOSTNAME 就是受保护」的直觉判成 false，
  // 做出来的二维码扫开是一个进不去的登录框，而用户完全看不出为什么。
  const t = resolvePublicTarget({
    cfHostname: 'ccm.example.com', accessEnabled: false, tailscaleDns: '', port: PORT,
  });
  assert.equal(t.url, 'https://ccm.example.com');
  assert.equal(t.includeToken, true, 'Access 没生效时公网只由 AUTH_TOKEN 把守');
  assert.match(t.warning, /未完全配置|AUTH_TOKEN/, '半配状态要说出来');
});

test('resolvePublicTarget：无 CF、有 Tailscale → 用 MagicDNS 的 https 且带令牌', () => {
  const t = resolvePublicTarget({
    cfHostname: '', accessEnabled: false, tailscaleDns: 'box.tail1234.ts.net', port: PORT,
  });
  assert.equal(t.url, 'https://box.tail1234.ts.net');
  assert.equal(t.includeToken, true);
  assert.match(t.note, /tailscale serve/, '没跑过 serve 时 https 不通，要提示');
});

test('resolvePublicTarget：两者都在 → 优先 CF Access（显式配置的长期入口）', () => {
  const t = resolvePublicTarget({
    cfHostname: 'ccm.example.com', accessEnabled: true, tailscaleDns: 'box.tail1234.ts.net', port: PORT,
  });
  assert.equal(t.url, 'https://ccm.example.com');
  assert.equal(t.includeToken, false);
  assert.deepEqual(t.alternatives, ['https://box.tail1234.ts.net'], '另一个要列出来供 --url 使用');
});

test('resolvePublicTarget：都没有 → 返回 null，由调用方提示用 --url', () => {
  assert.equal(resolvePublicTarget({ cfHostname: '', accessEnabled: false, tailscaleDns: '', port: PORT }), null);
});

test('resolvePublicTarget：域名大小写与首尾空白归一（与 cf-access 的 Host 判定同口径）', () => {
  const t = resolvePublicTarget({
    cfHostname: '  CCM.Example.COM  ', accessEnabled: true, tailscaleDns: '', port: PORT,
  });
  assert.equal(t.url, 'https://ccm.example.com');
});

// --url 是 docs/deployment.md 里教给 CF Access 用户的那条命令，走的不是 resolvePublicTarget，
// 但「受保护就不该带令牌」这条判据对它同样成立——两条路径必须用同一个判断，不能各写一份。
test('protectedByAccess：Access 生效且 Host 命中 → 判为受保护', () => {
  const opts = { cfHostname: 'ccm.example.com', accessEnabled: true };
  assert.equal(protectedByAccess('https://ccm.example.com', opts), true);
  assert.equal(protectedByAccess('https://CCM.Example.com/', opts), true, 'Host 比对不分大小写');
  assert.equal(protectedByAccess('https://ccm.example.com:8443/x', opts), true, '端口与路径不影响 Host 判定');
});

test('protectedByAccess：Access 未生效时恒 false（半配状态下公网仍靠令牌）', () => {
  assert.equal(protectedByAccess('https://ccm.example.com', { cfHostname: 'ccm.example.com', accessEnabled: false }), false);
});

test('protectedByAccess：别的域名不受本策略保护', () => {
  const opts = { cfHostname: 'ccm.example.com', accessEnabled: true };
  assert.equal(protectedByAccess('https://box.tail1234.ts.net', opts), false);
  assert.equal(protectedByAccess('http://192.168.1.1:3000', opts), false);
});

test('protectedByAccess：畸形地址不算受保护（宁可多带令牌也不做出一张进不去的码）', () => {
  assert.equal(protectedByAccess('not a url', { cfHostname: 'ccm.example.com', accessEnabled: true }), false);
});

// isBareHostname：CF_ACCESS_HOSTNAME 只接受裸域名。cf-access.js 的 isPublicHost 用
// host.split(':')[0] 比较，带 scheme/端口/路径的值永远比不出相等，Access 层会静默永远不触发。
test('isBareHostname：合法裸域名放行', () => {
  assert.equal(isBareHostname('ccm.example.com'), true);
  assert.equal(isBareHostname('a.b.c.example.co'), true);
  assert.equal(isBareHostname('CCM.Example.com'), true, '大小写不敏感');
  assert.equal(isBareHostname('  ccm.example.com  '), true, '首尾空白应被 trim');
});

test('isBareHostname：带 scheme 的完整 URL 一律拒绝（真实事故形态：用户粘贴了控制台给的完整链接）', () => {
  assert.equal(isBareHostname('https://ccm.example.com'), false);
  assert.equal(isBareHostname('http://ccm.example.com'), false);
});

test('isBareHostname：带端口 / 路径 / 尾部斜杠一律拒绝', () => {
  assert.equal(isBareHostname('ccm.example.com:8443'), false);
  assert.equal(isBareHostname('ccm.example.com/path'), false);
  assert.equal(isBareHostname('ccm.example.com/'), false);
});

test('isBareHostname：空值 / 纯空白 / 单标签（无点号）拒绝', () => {
  assert.equal(isBareHostname(''), false);
  assert.equal(isBareHostname('   '), false);
  assert.equal(isBareHostname(undefined), false);
  assert.equal(isBareHostname('localhost'), false, '生产用途要求至少一个点号，localhost 类单标签不是合法的公网 CF Access 域名');
});
