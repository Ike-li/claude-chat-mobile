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
    // 当前绑定表面的 cwd。存在的唯一理由是给【没有 sessionId 的新会话页】算草稿槽 key
    // （logic/composer.js 的 draftKeyFor），所以跟草稿缓存放在同一个模块里。
    // 【为什么不能直接读 currentCwd】它在 setInstances 里早于 bindView 就被改成【新】cwd 了，
    // 拿它当「离开的是哪个工作区」等于自己跟自己比。
    displayedCwd: null,
  };
  context.state.sessionWorkspaces = state;
  return state;
}
