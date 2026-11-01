import { createRingBuffer } from '../ring-buffer.js';
import { deserializeClientLogs, serializeClientLogs, shouldPersistLog } from '../logic/service-diag.js';

// 客户端日志内存环形缓冲 + localStorage 持久化。
// 为什么持久化：手机上最需要日志的时刻恰是「刚才白屏了 / PWA 被 iOS 杀了，重新打开」——
// 纯内存缓冲会在事故瞬间连同证据一起蒸发。落盘节流（push 高频、localStorage 同步写贵），
// 靠 pagehide flush 兜住被杀前的最后几条（app.js 接线）。storage 缺失/隐私模式/配额满一律优雅缺席。
const STORAGE_KEY = 'ccm_client_logs';

// clock：量落盘耗时用的高精度时钟。落盘在主线程同步序列化整个缓冲，本身可能就是卡顿源，
// 所以把它的代价随性能上报一起报上去（persistStats，见 app/perf-report.js）
const defaultClock = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

export function createClientLogger(context, { capacity = 500, onEntry = null, storage = null, persistIntervalMs = 2000, clock = defaultClock } = {}) {
  const buffer = createRingBuffer(capacity);
  const now = context.dependencies.now || Date.now;
  let lastPersistTs = null;
  let stats = { n: 0, totalMs: 0, maxMs: 0, bytes: 0 };

  // 启动恢复：把上次会话日志载入缓冲（deserialize 已打 restored 标记，渲染层据此画「本次会话」分隔）。
  if (storage) {
    try {
      for (const e of deserializeClientLogs(storage.getItem(STORAGE_KEY))) buffer.push(e);
    } catch { /* getItem 抛（隐私模式）：无恢复，纯内存起步 */ }
  }

  function persist(force = false) {
    if (!storage) return;
    const nowTs = now();
    if (!force && !shouldPersistLog(lastPersistTs, nowTs, persistIntervalMs)) return;
    const startedAt = clock();
    try {
      const serialized = serializeClientLogs(buffer.toArray());
      storage.setItem(STORAGE_KEY, serialized);
      lastPersistTs = nowTs;
      stats.bytes = serialized.length;
    } catch { /* 配额满/隐私模式：忽略，日志非关键、不反噬主流程 */ }
    const ms = clock() - startedAt;
    stats.n++;
    stats.totalMs += ms;
    stats.maxMs = Math.max(stats.maxMs, ms);
  }

  function log(type, text) {
    const entry = {
      ts: now(),
      type: `client_${type}`,
      text,
      instanceId: context.state.viewingInstanceId ?? null,
    };
    if ((type === 'send' || type === 'recv') && context.state.currentModel) {
      entry.model = context.state.currentModel;
    }
    buffer.push(entry);
    onEntry?.(entry);
    persist();
    return entry;
  }

  return {
    log,
    entries: () => buffer.toArray(),
    size: () => buffer.size(),
    clear: () => { buffer.clear(); persist(true); }, // 强制落盘空缓冲，否则重开又恢复已清的旧条目
    flush: () => persist(true),                       // pagehide/隐藏时兜住节流窗口内未落盘的尾巴
    persistStats: () => {                             // 上次读取以来的落盘代价；读完清零，没落过盘为 null
      if (!stats.n) return null;
      const out = stats;
      stats = { n: 0, totalMs: 0, maxMs: 0, bytes: 0 };
      return out;
    },
  };
}
