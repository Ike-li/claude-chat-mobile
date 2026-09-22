// public-target.js —— 公网二维码「用哪个地址、带不带令牌」的决策。纯函数，叶子层。
//
// 【为什么参数是算好的而不是自己去读】判据分散在两个域：Access 是否生效在 auth/cf-access.js，
// Tailscale 地址要 spawn 探测（ops/doctor-runtime.js）。shared 是叶子层、不得反向 import 那两个域，
// 所以由调用方（scripts/qr.js）组装参数送进来。这样这一层也就没有任何 I/O，可以直接测。
//
// 【带不带令牌是安全判据，不是便利判据】cf-access.js:113 那条契约：Access 生效时按 Host 路由，
// 公网请求**只走 JWT、不回退 AUTH_TOKEN**。于是受 Access 保护的域名，令牌在那条路径上是死数据，
// 带进二维码纯属把一份「全世界可用」的凭据多印一份。
// 反过来，Access 的生效判据是三项 env 齐全（cf-access.js:92）——只填了域名等于整层没开，
// 那时公网仍由 AUTH_TOKEN 独自把守，**必须带**，否则做出来的是一张扫开进不去的码。
// 两个方向错的代价不对称，但都真实存在，所以两个方向都由测试钉住。

const normalizeHost = (value) => String(value || '').trim().toLowerCase();

/**
 * 这台 server 前面有没有中间节点（反向代理 / 隧道）。
 *
 * 用途只有一个：判「限速锁定来自 127.0.0.1」时，能不能断言"多半是你自己的旧 token"。
 * 有中间节点时应用层看到的直连地址恒是它自己，背后可能是任何经它转发的公网来源，
 * 那句断言就成了在真有人暴力尝试时说反话（hard-rules：本机来源绝不说成「有人在暴力尝试」，
 * 反过来也一样——不能把公网暴力尝试说成「是你自己」）。
 *
 * 【绝不能只看 trustedProxy】那个开关的语义是「允许采信反代追加的 XFF 末跳」，本仓刻意不让它
 * 随 ACCESS_PROFILE=reverse-proxy 自动打开（XFF 是客户端可写的，采信必须用户显式声明）。
 * 于是最常见的反代/托管隧道部署恰恰是 trustedProxy 未设、peer 恒 127.0.0.1 的那一档——
 * 只看它就会把这条判断精确地漏在最需要它的配置上。
 *
 * 判据是「声明的拓扑里有没有中间节点」：
 *   · trustedProxy === 'loopback' —— 用户明说了前面有可信反代；
 *   · accessProfile 是 reverse-proxy / cloudflare —— 拓扑本身含中间节点。托管隧道
 *     （ngrok / Quick Tunnel / Tailscale Funnel）并入 reverse-proxy，env-schema.js 明写它们的
 *     连带变化含「peer 是 loopback 导致限速桶全塌」；
 *   · 未声明 profile 但 CF_ACCESS_* 齐全 —— 按 schema 的「未声明时按 CF_ACCESS_* 推断」，
 *     流量经 cloudflared 进来，peer 同样是 loopback。
 * vpn / direct / lan 一律 false：它们的 peer 就是真实客户端地址（tailnet IP / 公网 IP /
 * 局域网 IP），此时 127.0.0.1 确实就是本机。
 */
export function isProxyFronted({ trustedProxy = '', accessProfile = '', accessConfigured = false } = {}) {
  if (trustedProxy === 'loopback') return true;
  const profile = String(accessProfile || '').trim();
  if (profile === 'reverse-proxy' || profile === 'cloudflare') return true;
  return profile === '' && accessConfigured === true;
}

/**
 * 这个地址是否由 Cloudflare Access 把守（⇒ 二维码不该带令牌）。
 *
 * 判据与 cf-access.js 的 isPublicHost 同口径：只比 Host、不看端口与路径（CF 按域名路由）。
 * `--public` 与用户手敲的 `--url` 共用本函数——docs/deployment.md 教给 CF Access 用户的
 * 正是那条 `--url https://<your-domain>`，两条路径各写一份判断迟早分叉。
 *
 * 解析不出 Host 时返回 false：宁可多带一次令牌，也不做出一张扫开进不去的码。
 * @param {string} url
 * @param {{cfHostname?: string, accessEnabled?: boolean}} opts accessEnabled 须是运行时真实启用态
 */
export function protectedByAccess(url, { cfHostname, accessEnabled = false } = {}) {
  if (!accessEnabled) return false;
  const expected = normalizeHost(cfHostname);
  if (!expected) return false;
  try {
    return new URL(String(url)).hostname.toLowerCase() === expected;
  } catch {
    return false;
  }
}

/**
 * 决定公网二维码指向哪里。
 * @param {{cfHostname?: string, accessEnabled?: boolean, tailscaleDns?: string, port?: number}} input
 *   accessEnabled 必须是**运行时真实的启用态**（三项 env 齐全），不是「配没配域名」。
 * @returns {{url: string, includeToken: boolean, note: string, warning?: string, alternatives: string[]}|null}
 *   没有任何可用的公网地址时返回 null——由调用方提示改用 --url，而不是在这里编一个出来。
 */
export function resolvePublicTarget({ cfHostname, accessEnabled = false, tailscaleDns, port } = {}) {
  const cf = normalizeHost(cfHostname);
  const ts = normalizeHost(tailscaleDns);
  const cfUrl = cf ? `https://${cf}` : null;
  const tsUrl = ts ? `https://${ts}` : null;

  if (cfUrl && accessEnabled) {
    return {
      url: cfUrl,
      includeToken: false,
      note: '该域名受 Cloudflare Access 保护：公网只认 Access 的 JWT，AUTH_TOKEN 在这条路上不参与鉴权，'
        + '因此二维码里不含令牌。扫码后按提示完成 2FA 登录即可。',
      alternatives: tsUrl ? [tsUrl] : [],
    };
  }
  if (cfUrl) {
    // 半配状态：域名填了、TEAM/AUD 没齐 ⇒ server 侧 Access 整层关闭，公网请求回落 AUTH_TOKEN。
    // 判据与运行时保持一致才有意义——按「配了域名就是受保护」做，会做出一张进不去的码。
    return {
      url: cfUrl,
      includeToken: true,
      note: '公网地址取自 CF_ACCESS_HOSTNAME。',
      warning: 'Cloudflare Access 未完全配置（需 CF_ACCESS_HOSTNAME / CF_ACCESS_TEAM / CF_ACCESS_AUD 三项齐全），'
        + '当前该域名只由 AUTH_TOKEN 把守——二维码含完整令牌，等同于一把公网可用的钥匙。',
      alternatives: tsUrl ? [tsUrl] : [],
    };
  }
  if (tsUrl) {
    return {
      url: tsUrl,
      includeToken: true,
      note: `Tailscale MagicDNS 地址。HTTPS 需要先跑一次 tailscale serve --bg ${port}；`
        + '没跑过的话这个 https 不通，改用 --url 指定 http 形式。',
      alternatives: [],
    };
  }
  return null;
}
