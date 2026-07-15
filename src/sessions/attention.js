// attention.js —— "等我"跨会话聚合纯函数（需求与状态语义见 docs/design.md §3）
// 读模型投影：把已有派生状态 + 持久化 pending 审批投影成"需要你"聚合视图，不新增数据源、即时派生不落盘。
// 两条数据源互不重叠：
//   ①审批维度——直接来自调用方传入的 pendingApprovals（每项即一条 needsYou，waitingSince=createdAt）；
//   ②输入维度——来自 sessions 里 status==='awaiting_input' 的项（waitingSince=awaitingSince）。
// 边界（继承 AD-3，如实登记非缺陷）：纯终端会话的输入等待在后端不可见，其审批也仅在经后端拦截时才出现在
// pendingApprovals 里——两条数据源天然只覆盖 web 后端拦截/驱动过的会话，不假装全知。

// risk 字段仅展示标签（OQ-07 已决：不自建风险分类，判定权完全归上游 SDK），当前无上游提供的分级来源时保持
// undefined，不臆造分类；不参与排序（OQ-01 已决）。
export function deriveAttention(sessions, pendingApprovals) {
  const needsYou = [];
  for (const ap of pendingApprovals) {
    needsYou.push({
      sessionId: ap.sessionId,
      cwd: ap.cwd,
      title: ap.title ?? null,
      reason: 'awaiting_approval',
      waitingSince: ap.createdAt,
      risk: ap.risk,
      toolName: ap.toolName ?? null
    });
  }

  const needsYouSessionIds = new Set(needsYou.map(x => x.sessionId));
  for (const s of sessions) {
    if (s.status !== 'awaiting_input') continue;
    if (typeof s.awaitingSince !== 'number') continue; // 数据不完整：防御性跳过，不参与排序，但仍留在 others
    needsYou.push({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title ?? null,
      reason: 'awaiting_input',
      waitingSince: s.awaitingSince
    });
    needsYouSessionIds.add(s.sessionId);
  }

  // OQ-01 已决：纯按 waitingSince 升序（值越小=开始等待越早=等得越久，排越前）；risk/cwd 只是展示标签不参与排序。
  needsYou.sort((a, b) => a.waitingSince - b.waitingSince);

  const others = sessions
    .filter(s => !needsYouSessionIds.has(s.sessionId))
    .slice()
    .sort((a, b) => {
      if (a.cwd !== b.cwd) return a.cwd < b.cwd ? -1 : 1;
      return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
    });

  return { needsYou, others };
}
