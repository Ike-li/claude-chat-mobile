// rate-limiter.js —— 鉴权端口防暴破限速（纯函数状态机）
//
// 边界：只在鉴权门口用、不限已鉴权操作（单操作者/机主即 root，已鉴权=全权，对操作面限速违背产品目的）。
// 机制：按 sourceKey 计数 + 指数退避 + 阈值锁定，静默衰减不永久惩罚。状态由调用方存于内存 Map（n=1 瘦快；
// 重启清零 = 残余风险、已接受）。本模块只含纯函数状态转移，sourceKey 取值与审计由调用方（src/server/app.js）负责。

// 参数（已决，采纳为可配置默认）：手滑容忍 + 暴破不经济 + 久未失败自动原谅。
export const DEFAULT_RATE_LIMIT_CONFIG = Object.freeze({
  threshold: 8,           // 连续失败达此数 → 锁定
  baseBackoffMs: 500,     // 退避基数
  maxBackoffMs: 30_000,   // 退避封顶 30s
  lockMs: 15 * 60_000,    // 锁定 15min
  decayMs: 15 * 60_000,   // 静默 15min 未失败 → 计数重置
});

export function freshState() {
  return { failCount: 0, lockUntil: 0, lastFailTs: 0 };
}

// 纯函数状态机：给定当前状态 + 本次鉴权结果 ok + now(ms) + 配置，返回 { next, verdict, retryAfterMs? }。
// verdict: 'allow' | 'backoff' | 'locked'。调用方据 verdict 放行/拒绝，并把 next 写回 Map。
export function onAuthResult(s, ok, now, cfg = DEFAULT_RATE_LIMIT_CONFIG) {
  const state = s || freshState();

  // 1. 统一门：锁定期（长锁）或退避期（短锁）内一律拦截，且【不计数】
  //    —— 避免攻击者在锁定期持续戳、把机主自己越锁越久（自我 DoS）；持续尝试的审计由调用方记。
  if (now < state.lockUntil) {
    return { next: state, verdict: 'locked', retryAfterMs: state.lockUntil - now };
  }

  // 2. 成功 → 清零
  if (ok) {
    return { next: freshState(), verdict: 'allow' };
  }

  // 3. 失败：静默衰减（久未失败则重新从 1 计），否则累加
  const failCount = (now - state.lastFailTs > cfg.decayMs) ? 1 : state.failCount + 1;

  // 4. 达阈值 → 长锁定
  if (failCount >= cfg.threshold) {
    return {
      next: { failCount, lockUntil: now + cfg.lockMs, lastFailTs: now },
      verdict: 'locked', retryAfterMs: cfg.lockMs,
    };
  }

  // 5. 未达阈值 → 指数退避短锁（经 lockUntil 强制生效，非仅建议头）
  const backoff = Math.min(cfg.baseBackoffMs * 2 ** (failCount - 1), cfg.maxBackoffMs);
  return {
    next: { failCount, lockUntil: now + backoff, lastFailTs: now },
    verdict: 'backoff', retryAfterMs: backoff,
  };
}

// ---- IPv6 分桶（SEC，2026-09-01）----
// IPv4 时代「一个 IP ≈ 一个来源」的假设在 IPv6 下失效：终端用户拿到的最小分配就是一整个 /64
// （2^64 个地址），逐地址计桶意味着攻击者每换一个源地址就得到一个全新的 failCount=0 桶——
// 登录暴破限速形同虚设。BIND_MODE=custom + BIND_HOST=:: 打开 IPv6 监听后这条路径才真正可达。
//
// 代价（已接受）：同一 /64 内的多台设备共用一个限速桶，一台连错到阈值会连累同网段其他设备锁 15min。
// 这正是限速本该有的语义——从公网侧看 NAT 后的 IPv4 LAN 本来也是共用一个桶，而「同 /64 = 同一站点」
// 在 IPv6 编址下的成立度比「同公网 IPv4 = 同一站点」更高。误锁的逃生口仍是重启 server（状态是内存态）。

// 把 IPv6 文本展开成 8 组归一化 hextet（小写、去前导零）；不是合法 IPv6 则返回 null。
function ipv6Hextets(ip) {
  let s = String(ip ?? '').trim().toLowerCase();
  if (s.startsWith('[')) {                 // [::1] / [::1]:3000
    const end = s.indexOf(']');
    if (end < 0) return null;
    s = s.slice(1, end);
  }
  const zone = s.indexOf('%');             // link-local 的 zone id：fe80::1%en0
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;       // 无冒号 ⇒ 不是 IPv6（IPv4 与畸形串走原样路径）

  // 尾部嵌入的点分 IPv4（::ffff:192.0.2.1、64:ff9b::192.0.2.33）先折成两组 hextet
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.slice(lastColon + 1));
    if (!m) return null;
    const b = m.slice(1).map(Number);
    if (b.some(n => n > 255)) return null;
    s = `${s.slice(0, lastColon + 1)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }

  const dbl = s.indexOf('::');
  let parts;
  if (dbl >= 0) {
    if (s.includes('::', dbl + 1)) return null;              // 只允许一处 ::
    const head = s.slice(0, dbl) ? s.slice(0, dbl).split(':') : [];
    const tail = s.slice(dbl + 2) ? s.slice(dbl + 2).split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;                               // :: 至少代表一组 0
    parts = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    parts = s.split(':');
  }
  if (parts.length !== 8 || parts.some(p => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map(p => p.replace(/^0+(?=.)/, ''));
}

// 限速桶标识：IPv6 → 所在 /64 前缀（形如 `2408:8207:1:2::/64`）；IPv4 与无法解析的输入原样返回。
export function ipRateBucket(ip) {
  const raw = String(ip ?? '').trim();
  const h = ipv6Hextets(raw);
  if (!h) return raw;   // IPv4 / 畸形串：逐字节不变（保守方向——宁可多分桶，绝不误合并）
  // IPv4-mapped（::ffff:0:0/96）语义上是 IPv4 来源，还原成点分十进制按整地址计桶。
  // 少了这一步，该段所有地址的前 4 组 hextet 都是 0 → 全世界的 IPv4 来源塌成同一个桶，
  // 一台机器触发锁定就把所有 IPv4 客户端一起锁死（比原漏洞更糟）。
  if (h.slice(0, 5).every(x => x === '0') && h[5] === 'ffff') {
    const hi = parseInt(h[6], 16), lo = parseInt(h[7], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${h.slice(0, 4).join(':')}::/64`;
}

// sourceKey：限速计数的来源标识。
// 优先级：边缘层可信注入的真实来源(CF-Connecting-IP) → 连接 IP。两条路径都过 ipRateBucket 归桶：
// CF-Connecting-IP 是客户端的真实地址，IPv6 客户端换地址同样能拆桶，是同一个绕过面。
// 信任边界：只信自己边缘层（Cloudflare）注入的头，【绝不信客户端自称的 X-Forwarded-For】——
// 后者可伪造，用它做 key 等于给攻击者一把绕过 per-source 限速的钥匙。normalizeIp 由调用方注入（去 ::ffff: 前缀）。
//
// CF-Connecting-IP 仅在 trustCfConnectingIp=true 时采信（调用方应只在 isPublicHost 公网
// Access 路径下置 true）。LAN/直连上该头可被客户端伪造，采信会把限速状态拆成无限 source key 绕过。
export function rlSourceKey(handshake, normalizeIp = (x) => x, { trustCfConnectingIp = false } = {}) {
  if (trustCfConnectingIp) {
    const cfip = handshake?.headers?.['cf-connecting-ip'];
    if (cfip && typeof cfip === 'string' && cfip.trim()) return `cfip:${ipRateBucket(cfip)}`;
  }
  return `ip:${ipRateBucket(normalizeIp(handshake?.address || ''))}`;
}

// AUTH-NEW-2：是否采信 CF-Connecting-IP。
// 拓扑前提：公网流量经 cloudflared/nginx 终止在本机 loopback 再进 Node——此时 peer=127.0.0.1/::1
// 且 Host=公网域名，CF-IP 由边缘注入可信。
// 若 peer 是 LAN/公网直连 IP，即使 Host 被伪造为 CF_ACCESS_HOSTNAME，也【不】信 CF-IP
// （否则攻击者 Host spoof + 随机 CF-Connecting-IP 可无限拆限速桶）。
export function shouldTrustCfConnectingIp({ publicHost, peerAddress }, normalizeIp = (x) => x) {
  if (!publicHost) return false;
  const ip = String(normalizeIp(peerAddress || '') || '').toLowerCase();
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

// 设备审批 bypass（SEC 第二因子）：仅当 CF Access 已验，或「真·本机直连」才跳过 deviceToken。
// 反代/隧道（cloudflared/nginx/SSH）终止后 peer 常为 127.0.0.1，但 Host 是公网域名——旧逻辑
// 只看 peer loopback 会把「拿到 AUTH_TOKEN 的远程客户端」当成已设备审批。必须同时满足 Host 本机样。
// accessEnabled=true：JWT 已过，bypass 有意保留（与 CF Access 作为边界的设计一致）。
export function shouldBypassDeviceApproval({
  accessEnabled = false,
  peerAddress = '',
  hostHeader = '',
} = {}, normalizeIp = (x) => x) {
  if (accessEnabled) return true;
  const ip = String(normalizeIp(peerAddress || '') || '').toLowerCase();
  const peerLocal = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
  if (!peerLocal) return false;
  const host = String(hostHeader || '').split(':')[0].toLowerCase();
  // R8（2026-08-06）：空 Host【不】视为本机。旧判据把它与 localhost 并列，理由是「本机工具/健康探针」，
  // 但实测项目内无任何调用方发空 Host（浏览器 / socket.io-client / fetch 全带），而 /health、/metrics
  // 也不走本判据（只过 httpAuth）。留着它等于：反代若配成 proxy_set_header Host ""，公网请求会被当成
  // 真本机直连、跳过设备审批——一行配置错误打穿一层防护。真发空 Host 的客户端落入待审列表、
  // 机主批准一次即可（非硬拒绝）。公网域名（含 tunnel）本就不 bypass。
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
