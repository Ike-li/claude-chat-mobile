// rate-limiter.js —— 鉴权端口防暴破限速（纯函数状态机，承接 docs/design.md / NFR-03）
//
// 边界：只在鉴权门口用、不限已鉴权操作（单操作者/机主即 root，已鉴权=全权，对操作面限速违背产品目的）。
// 机制：按 sourceKey 计数 + 指数退避 + 阈值锁定，静默衰减不永久惩罚。状态由调用方存于内存 Map（n=1 瘦快；
// 重启清零 = 残余风险，见 docs/design.md）。本模块只含纯函数状态转移，sourceKey 取值与审计由调用方（server.js）负责。

// 参数（OQ-03 已决，采纳为可配置默认）：手滑容忍 + 暴破不经济 + 久未失败自动原谅。
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

// sourceKey：限速计数的来源标识（承接 docs/design.md "来源识别"）。
// 优先级：边缘层可信注入的真实来源(CF-Connecting-IP) → 连接 IP。
// 信任边界：只信自己边缘层（Cloudflare）注入的头，【绝不信客户端自称的 X-Forwarded-For】——
// 后者可伪造，用它做 key 等于给攻击者一把绕过 per-source 限速的钥匙。normalizeIp 由调用方注入（去 ::ffff: 前缀）。
//
// AUTH-002：CF-Connecting-IP 仅在 trustCfConnectingIp=true 时采信（调用方应只在 isPublicHost 公网
// Access 路径下置 true）。LAN/直连上该头可被客户端伪造，采信会把限速状态拆成无限 source key 绕过。
export function rlSourceKey(handshake, normalizeIp = (x) => x, { trustCfConnectingIp = false } = {}) {
  if (trustCfConnectingIp) {
    const cfip = handshake?.headers?.['cf-connecting-ip'];
    if (cfip && typeof cfip === 'string' && cfip.trim()) return `cfip:${cfip.trim()}`;
  }
  return `ip:${normalizeIp(handshake?.address || '')}`;
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
