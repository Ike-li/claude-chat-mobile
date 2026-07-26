// usage-snapshot.js —— 账号级（非会话级）额度快照回落：owner=sdk 走 agent.fetchUsage()（1.5s 超时,
// 任一失手即整段无额度）、owner=cli 走落盘 bridge 快照（非 fresh 也整段无额度）——两条来源各自都有
// 短暂断档的窗口，下一拍多半又恢复，肉眼看就是额度"时有时无"。本模块提供最近一次温热数据的回落，
// 消除这种闪断：断档这一拍用上次的值垫上，比整段消失更接近事实（账号级额度本就不会逐拍剧烈跳变）。
//
// 纯内存单例、进程重启清零、不持久化、不分账号——项目定位"每实例单用户"（见 CLAUDE.md），不需要
// 多账号区分。store 由调用方持有并显式传入（本模块不维护隐藏的模块级单例），两个函数都是纯函数：
// 相同输入永远产出相同效果，天然可测、可在多处按需构造独立实例互相隔离。
// now 必须由调用方传入——本模块自身从不读系统时钟，单测可注入任意时间点验证 TTL 边界。

export const USAGE_SNAPSHOT_TTL_MS = 15 * 60 * 1000; // 15 分钟：够盖过 RPC 超时/bridge TTL(30-180s)量级的短暂断档，又不至于陈到跨会话冒充"实时"

// 新建一个空快照 store。调用方（如 statusline.js）在模块作用域持有一份单例并显式传给下面两个函数；
// 单测各自构造独立实例即天然隔离，无需 reset 钩子。形状故意简单——{rate, at}，不做持久化/多账号。
export function createUsageSnapshotStore() {
  return { rate: null, at: 0 };
}

// 记住这次的 rate 数据。rateBits 为空/undefined/非对象/无 key → 不写入：不覆盖已有快照，也不能
// 污染 store——第三方鉴权账号（rate_limits_available:false）、utilization 越界等"本就不该有额度"
// 的场景从未产生过合法 rate，不该在 store 里留痕；否则后续回落会把这类场景也误当"最近一次真实
// 数据"垫出去，违反"不该显示的场景不垫快照"的红线（见 statusline.js usageBitsForStatusLine）。
export function rememberUsage(store, rateBits, now) {
  if (!store || !rateBits || typeof rateBits !== 'object' || !Object.keys(rateBits).length) return;
  store.rate = rateBits;
  store.at = now;
}

// 取回落值：从未写入过（store.rate 为 null）或已超过 ttl → null；否则原样返回存的 rate 数据，
// 调用方自行决定是否要在 payload 上标记 rateFromSnapshot。用 `>` 而非 `>=`——恰好等于 ttl 那一刻
// 仍算温热，避免边界一刀切掉本该可用的最后一拍。
export function fallbackUsage(store, now, ttl = USAGE_SNAPSHOT_TTL_MS) {
  if (!store?.rate) return null;
  if (now - store.at > ttl) return null;
  return store.rate;
}
