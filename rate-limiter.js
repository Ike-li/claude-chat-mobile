// rate-limiter.js —— 鉴权端口防暴破限速（纯函数状态机，承接 LLD §3.5.2 / NFR-03）
//
// 边界：只在鉴权门口用、不限已鉴权操作（单操作者/机主即 root，已鉴权=全权，对操作面限速违背产品目的）。
// 机制：按 sourceKey 计数 + 指数退避 + 阈值锁定，静默衰减不永久惩罚。状态由调用方存于内存 Map（n=1 瘦快；
// 重启清零 = 残余风险，见 LLD §3.5.2/§8.3）。本模块只含纯函数状态转移，sourceKey 取值与审计由调用方（server.js）负责。

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

// sourceKey：限速计数的来源标识（承接 LLD §3.5.2 "来源识别"）。
// 优先级：边缘层可信注入的真实来源(CF-Connecting-IP) → 连接 IP。
// 信任边界：只信自己边缘层（Cloudflare）注入的头，【绝不信客户端自称的 X-Forwarded-For】——
// 后者可伪造，用它做 key 等于给攻击者一把绕过 per-source 限速的钥匙。normalizeIp 由调用方注入（去 ::ffff: 前缀）。
export function rlSourceKey(handshake, normalizeIp = (x) => x) {
  const cfip = handshake?.headers?.['cf-connecting-ip'];
  if (cfip && typeof cfip === 'string' && cfip.trim()) return `cfip:${cfip.trim()}`;
  return `ip:${normalizeIp(handshake?.address || '')}`;
}
