import { createRingBuffer } from '../ring-buffer.js';
import { serializeClientLogs, deserializeClientLogs, shouldPersistLog } from '../logic.js';

// 客户端日志内存环形缓冲 + localStorage 持久化。
// 为什么持久化：手机上最需要日志的时刻恰是「刚才白屏了 / PWA 被 iOS 杀了，重新打开」——
// 纯内存缓冲会在事故瞬间连同证据一起蒸发。落盘节流（push 高频、localStorage 同步写贵），
// 靠 pagehide flush 兜住被杀前的最后几条（app.js 接线）。storage 缺失/隐私模式/配额满一律优雅缺席。
const STORAGE_KEY = 'ccm_client_logs';

export function createClientLogger(context, { capacity = 500, onEntry = null, storage = null, persistIntervalMs = 2000 } = {}) {
  const buffer = createRingBuffer(capacity);
  const now = context.dependencies.now || Date.now;
  let lastPersistTs = null;

  // 启动恢复：把上次会话日志载入缓冲（deserialize 已打 restored 标记，渲染层据此画「本次会话」分隔）。
  if (storage) {
    try {
      for (const e of deserializeClientLogs(storage.getItem(STORAGE_KEY))) buffer.push(e);
    } catch { /* getItem 抛（隐私模式）：无恢复，纯内存起步 */ }
  }

  function persist(force = false) {
    if (!storage) return;
    const t = now();
    if (!force && !shouldPersistLog(lastPersistTs, t, persistIntervalMs)) return;
    try {
      storage.setItem(STORAGE_KEY, serializeClientLogs(buffer.toArray()));
      lastPersistTs = t;
    } catch { /* 配额满/隐私模式：忽略，日志非关键、不反噬主流程 */ }
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
  };
}
