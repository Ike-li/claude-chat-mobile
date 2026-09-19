// tests/unit/origin-gate.test.mjs —— 公网 IdP 路径上的跨站握手门（M3，2026-09-17 安全审查）
//
// 【为什么只管公网 IdP 那条路】CSRF 的前提是「浏览器自动带上受害者的凭据」。
//   · AUTH_TOKEN 路径：令牌在 `handshake.auth` 的 JSON 里，由页面 JS 从 localStorage 读出来，
//     **不会被浏览器自动附加**。恶意页读不到别的源的 localStorage，跨站连上去也拿不出令牌。
//     这条路本来就不可 CSRF，给它加 Origin 校验换不来安全，只会多一个把人挡在门外的判据——
//     nginx 默认的 `proxy_set_header Host $proxy_host` 会把 Host 改写成上游地址，那时
//     Origin 与 Host 天然不等，而这类部署现在是能正常工作的。
//   · CF Access 路径：凭据是边缘按 Cookie 注入的 `Cf-Access-Jwt-Assertion`。Access 登录跳转
//     常见把 `CF_Authorization` 设成 SameSite=None，于是用户登录过之后，任意恶意页对公网 Host
//     开 WebSocket，边缘都可能带着 Cookie 放行并注入 JWT。而默认 DEVICE_APPROVAL_SCOPE 下
//     这条连接**直接 deviceApproved=true**，不经设备审批。
//
// 【这条没有被实证】原审查稿把 M3 标成「未在浏览器证实的纵深缺口」，我也没有复现。
// 所以它按纵深加固做、不按已证漏洞做：判据窄到只覆盖那条真有 Cookie 的路径，
// 不为一个未证实的问题去改变其余所有拓扑的行为。也因此**不登记不变量编号**——
// tests/README.md 的编号表是产品红线的枚举，不是「我需要一个编号所以加一个」。

import test from 'node:test';
import assert from 'node:assert/strict';

import { originAllowedOnPublicHost } from '../../app/src/auth/origin-gate.js';

const HOST = 'ccm.example.com';

test.describe('originAllowedOnPublicHost', () => {
  test('同源握手放行——这是真实用户走的那条路', () => {
    for (const origin of [
      `https://${HOST}`,
      `https://${HOST}:443`,          // 显式默认端口，URL 解析后 port 为空串
      `HTTPS://${HOST.toUpperCase()}`, // 大小写不敏感：Host 与 Origin 的大小写由客户端决定
    ]) {
      assert.equal(originAllowedOnPublicHost(origin, HOST), true, `${origin} 应放行`);
    }
  });

  // ★ 只比 hostname 会把 scheme 与端口一起丢掉（2026-09-17 由 PR #81 的 review 抓到）。
  // Cookie **不按端口隔离**：同一域名另一个端口上的页面（自托管的人在同域跑第二个服务很常见）
  // 拿得到同一份 CF_Authorization，于是它能带着受害者的 Access 会话开 wss。
  // http:// 那条同理——页面本身不安全，但它开 wss:// 时浏览器照样附上 Secure Cookie。
  // Access 的边缘恒在 443/https，所以合法来源只有一种形态，收紧零代价。
  test('同域但 scheme 或端口不同 → 拒（Cookie 不按端口隔离）', () => {
    for (const origin of [
      `https://${HOST}:8443`,
      `http://${HOST}`,
      `http://${HOST}:80`,
      `ws://${HOST}`,
    ]) {
      assert.equal(originAllowedOnPublicHost(origin, HOST), false, `${origin} 应被拒`);
    }
  });

  test('别的域名的页面发起的握手被拒——这正是要挡的那一格', () => {
    for (const origin of [
      'https://evil.example',
      'https://ccm.example.com.evil.example',  // 后缀拼接
      'https://evilccm.example.com',           // 前缀拼接
      'http://localhost:3000',                 // 本机页面也不是这条路的合法来源
    ]) {
      assert.equal(originAllowedOnPublicHost(origin, HOST), false, `${origin} 应被拒`);
    }
  });

  // 非浏览器客户端（CF Access service token、curl、菜单栏）根本不发 Origin。
  // 它们也拿不到受害者的 Cookie，不构成 CSRF —— 拒了只会砍掉合法用法。
  test('没有 Origin 头 → 放行（非浏览器客户端，不存在被借用的 Cookie）', () => {
    for (const origin of [undefined, null, '']) {
      assert.equal(originAllowedOnPublicHost(origin, HOST), true);
    }
  });

  // `Origin: null` 是**有**这个头、值为不透明源：sandboxed iframe、data: / file: 文档。
  // 那些仍是浏览器上下文，SameSite=None 的 Cookie 照样可能被带上。与「没有这个头」是两回事，
  // 合并处理会在这一格上悄悄放行。
  test('Origin: null（不透明源）被拒——它有头，与「没有头」不是一回事', () => {
    assert.equal(originAllowedOnPublicHost('null', HOST), false);
  });

  test('畸形 Origin 一律拒（fail-closed，不猜意图）', () => {
    for (const origin of ['not a url', '://x', 'https://', '   ']) {
      assert.equal(originAllowedOnPublicHost(origin, HOST), false, `${JSON.stringify(origin)} 应被拒`);
    }
  });

  // 没配公网域名时这道门无从判定。它只在 strategy.ownsHost() 为真时才被调用，
  // 而那蕴含 hostname 非空；这里钉住的是「万一被别处调用，失败方向是拒绝不是放行」。
  test('未配置公网域名 → 拒绝（fail-closed）', () => {
    for (const h of [undefined, null, '']) {
      assert.equal(originAllowedOnPublicHost(`https://${HOST}`, h), false);
    }
  });
});
