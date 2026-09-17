// origin-gate.js —— 公网 IdP 路径上的跨站握手门（M3，2026-09-17 安全审查）。
//
// 【解决的是什么】Socket.io 的 WebSocket 握手不受同源策略约束：任意页面都能对任意源开 WS。
// 通常这不构成 CSRF，因为凭据得由页面自己提供。但 Cloudflare Access 那条路不一样——
// 凭据是**边缘按 Cookie 注入**的 `Cf-Access-Jwt-Assertion`，而 Access 登录跳转常见把
// `CF_Authorization` 设成 SameSite=None。于是用户登录过之后，任意恶意页对公网 Host 开
// WebSocket，边缘都可能带着 Cookie 放行并注入 JWT；而默认 `DEVICE_APPROVAL_SCOPE` 下
// 这条连接**直接 deviceApproved=true**，连设备审批都不过。
//
// 【为什么只管这一条路，不对所有拓扑统一开】CSRF 的前提是「浏览器自动带上受害者的凭据」：
//   · AUTH_TOKEN 路径的令牌在 `handshake.auth` 的 JSON 里，由页面 JS 从 localStorage 读出来，
//     浏览器**不会**自动附加；恶意页读不到别的源的 localStorage。那条路本来就不可 CSRF。
//   · 给它也加 Origin 校验换不来安全，却会多一个把人挡在门外的判据：nginx 默认的
//     `proxy_set_header Host $proxy_host` 把 Host 改写成上游地址，那时 Origin 与 Host 天然
//     不相等——而这类部署现在是能正常工作的。为一个未证实的问题去弄坏一批能用的部署，
//     方向是反的。
//
// 【这条没有被实证】原审查稿把它标成「未在浏览器证实的纵深缺口」，我也没有复现真实的
// Cookie SameSite 行为。所以它按纵深加固做、不按已证漏洞做，判据窄到只覆盖那条真有 Cookie
// 的路径。
//
// 判据是**主机名精确相等**，不是前缀或后缀包含：`ccm.example.com.evil.example` 与
// `evilccm.example.com` 都得拒，而那两种恰好是字符串包含判据会漏掉的形态。
// 与 cf-access.js 的 isPublicHost 同一口径（剥端口 + 小写）——两处不同源就会出现
// 「Access 认这个 Host、这道门不认」的分叉，而鉴权分叉从来不会自己报错。

/**
 * 公网 IdP 路径上，这个 Origin 是否允许握手。
 *
 * @param {string|null|undefined} originHeader  握手请求的 Origin 头原值
 * @param {string} publicHostname  已配置的公网域名（strategy.publicHostname()，已 trim + 小写）
 * @returns {boolean}
 */
export function originAllowedOnPublicHost(originHeader, publicHostname) {
  const expected = String(publicHostname ?? '').trim().toLowerCase();
  // 没配公网域名时无从判定。只有 ownsHost() 为真才会走到这里（那蕴含 hostname 非空），
  // 这一行是万一被别处调用时的失败方向：拒绝，不是放行。
  if (!expected) return false;

  // **没有 Origin 头**（非浏览器客户端：CF Access service token、curl、菜单栏）→ 放行。
  // 它们拿不到受害者的 Cookie，不构成 CSRF；拒了只会砍掉合法用法。
  // 注意与下面 `'null'` 的区别：那是**有**这个头、值为不透明源。
  if (originHeader === undefined || originHeader === null || originHeader === '') return true;

  let url;
  try {
    // 'null'（sandboxed iframe / data: / file:）在 URL 构造器里直接抛，落进 catch 被拒——
    // 那些仍是浏览器上下文，SameSite=None 的 Cookie 照样可能被带上，不能与「没有头」合并。
    url = new URL(String(originHeader));
  } catch {
    return false; // 畸形 Origin：fail-closed，不猜意图
  }
  // **比完整的源，不是只比主机名。** 只比 hostname 会把 scheme 与端口一起丢掉，而
  // Cookie **不按端口隔离**：同一域名另一个端口上的页面（自托管的人在同域跑第二个服务很常见）
  // 拿得到同一份 CF_Authorization，能带着受害者的 Access 会话开 wss。http:// 那条同理——
  // 页面本身不安全，但它开 wss:// 时浏览器照样附上 Secure Cookie。
  // Access 的边缘恒在 443/https，合法来源只有一种形态，收紧是零代价的。
  // port 为空串即默认端口：`https://h` 与 `https://h:443` 经 URL 解析后都是空串。
  return url.protocol === 'https:'
    && url.hostname.toLowerCase() === expected
    && url.port === '';
}
