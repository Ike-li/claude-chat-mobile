// metrics.js —— 运行时指标收集器 + 状态探针（LLD §3.7 MetricsCollector/StateProbe，承接 NFR-15）
//
// 纯内存、重启清零（EP-1 运行时易失态，与 RingBuffer/RateLimitState 同层）——指标是当前进程的运行统计，
// 跨重启无意义，不落盘、无 CCM_ 隔离口。快照只经**鉴权保护**的端点暴露（server.js /metrics，守 LLD §3.7
// "不开无鉴权数据端点"），不推 Prometheus 文本、不主动遥测。
//
// 边界（承接 OQ-09，别混淆）：本模块只收"系统管道健康"指标（会话数/事件速率/补齐率/限速数/推送成功率）——
// 这些是 LLD §3.7 明列要做的。OQ-09 拒绝的是"授权闭环时延"这类**人机/价值指标**的埋点遥测，不在此列
// （见 LLD §3.7 原文对二者的区分）；本模块不采集任何审批时延/闭环时长。

const counters = new Map(); // name → number（累计，只增）
const gauges = new Map();   // name → number（瞬时，覆盖式）

// 计数器递增（LLD §3.7 MetricsCollector.inc）。用于"发生过 N 次"类指标：事件数、限速锁定、推送成功/失败。
export function inc(name, delta = 1) {
  counters.set(name, (counters.get(name) || 0) + delta);
}

// 瞬时值设置（LLD §3.7 MetricsCollector.gauge）。用于需要"事件驱动更新、消费者随时读最新"的瞬时指标。
// 注：能在 /metrics 拉取时实时算准的当前值（如活跃会话数=agents.size）直接实时算、不走 gauge 中转更准；
// gauge 留给未来那类"变化点分散、拉取时算不出全貌"的瞬时指标。API 完整性按 §3.7 保留 + 单测覆盖。
export function gauge(name, value) {
  gauges.set(name, value);
}

export function snapshot() {
  return {
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
  };
}

// 仅测试用：清空全部指标，隔离用例间的累计干扰。
export function reset() {
  counters.clear();
  gauges.clear();
}

// StateProbe.classify（LLD §3.7）——把当前系统观测归为 NFR-15 五类中后端可产出的四类之一，或 null（无需
// 关注）。返回单个优先级最高的类：failed > awaiting > notify_failed > mobile_offline。host_offline 不在
// 此列（LLD 明说后端存活即主机在线，由客户端心跳缺席判定，不由后端探针产生）。纯函数、不依赖模块状态，
// 调用方（server.js /metrics）传入当下实时观测——failed/awaiting 为当前计数，notifyFailed 为进程内累计
// （>0 即持续提示去查审计，非"必然仍在失败"），mobileClients 为当前已连接的客户端数。
export function classifyState({ failed = 0, awaiting = 0, notifyFailed = 0, mobileClients = 0 } = {}) {
  if (failed > 0) return 'failed';
  if (awaiting > 0) return 'awaiting';
  if (notifyFailed > 0) return 'notify_failed';
  if (mobileClients === 0) return 'mobile_offline';
  return null;
}

// 服务状态可见性（第一性原理重新设计版，见 docs/hld-ccm.md 附近）——刻意不复用 classifyState：
// 那是给 /metrics 外部消费的粗分类（failed/awaiting 已被会话 ❗ 角标与"需要你(N)"聚合覆盖，重复无意义；
// mobile_offline 对正在看 UI 的设备是自指悖论）。这里只取"推送投递健康"这一条真正没有 UI 覆盖过的信号，
// 且必须带时间语义——notifyFailed 计数器进程重启前累计不衰减，原样展示布尔值会有"狼来了/过期红灯"问题，
// 故只在时效窗口内（默认 24h）才判定为"最近失败"，超窗自动退场。纯函数、不读 counters/gauges 模块状态，
// 调用方（server.js computeServiceHealth）传入当下 gauge 快照。
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h：超过这个时长的失败不再视为"最近"

export function recentDeliveryFailure({ pushFailureAt, ntfyFailureAt, now, staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const candidates = [];
  if (typeof pushFailureAt === 'number' && now - pushFailureAt <= staleAfterMs) {
    candidates.push({ channel: 'push', at: pushFailureAt });
  }
  if (typeof ntfyFailureAt === 'number' && now - ntfyFailureAt <= staleAfterMs) {
    candidates.push({ channel: 'ntfy', at: ntfyFailureAt });
  }
  if (!candidates.length) return null;
  return candidates.reduce((latest, c) => (c.at > latest.at ? c : latest));
}
