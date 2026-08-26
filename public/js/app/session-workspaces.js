const SEEN_DISK_LEN_CAP = 40; // 与 sessionDraft 同量级有界，防长生命周期 PWA 无限涨

export function createSessionWorkspaceState(context) {
  const sessionDomCache = new Map();
  const sessionDraftCache = new Map();
  const seenDiskLenBySession = new Map();
  const sessionsCache = new Map();
  // 每工作区会话搜索词（仅当前工作区范围）。空串/缺省 = 浏览模式。
  const sessionSearchQueryByDir = new Map();
  // 有界 set：超过 cap 丢最旧 key（Map 插入序）
  const origSet = seenDiskLenBySession.set.bind(seenDiskLenBySession);
  seenDiskLenBySession.set = (k, v) => {
    if (!seenDiskLenBySession.has(k) && seenDiskLenBySession.size >= SEEN_DISK_LEN_CAP) {
      seenDiskLenBySession.delete(seenDiskLenBySession.keys().next().value);
    }
    return origSet(k, v);
  };
  const state = {
    sessionDomCache,
    sessionDraftCache,
    sessionDrafts: sessionDraftCache,
    seenDiskLenBySession,
    sessionsCache,
    sessionSearchQueryByDir,
  };
  context.state.sessionWorkspaces = state;
  return state;
}
