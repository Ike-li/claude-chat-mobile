export function createInstanceManager() {
  let counter = 0;
  const agents = new Map();
  const permissionModes = new Map();
  const efforts = new Map();
  const done = new Set();
  const errors = new Set();
  const aborted = new Set();
  const unreadCounts = new Map();          // instanceId → number，非查看期间累加的顶层消息数（活计数器）
  const unreadSnapshotOnEntry = new Map(); // instanceId → number，最近一次"进入查看"时刻冻结的未读数，供前端展示；只在 user:ackUnread 才清
  const lastCountedTopLevelMessageId = new Map(); // instanceId → messageId，text_delta 未读去重游标（unread-tracker.js#resolveUnreadDelta 消费）

  const nextId = () => `inst_${++counter}`;
  const permissionModeOf = id => permissionModes.get(id) ?? 'default';
  const effortOf = id => efforts.get(id) ?? null;

  function forSession(sessionId) {
    if (!sessionId) return null;
    for (const agent of agents.values()) {
      if (agent.sessionId === sessionId) return agent;
    }
    return null;
  }

  function inheritedMode(cwd) {
    let mode = 'default';
    for (const agent of agents.values()) {
      if (agent.cwd === cwd) mode = agent.permissionMode;
    }
    return mode;
  }

  function inheritedEffort(cwd) {
    let effort = null;
    for (const agent of agents.values()) {
      if (agent.cwd === cwd) effort = agent.effort;
    }
    return effort;
  }

  function stateOf(id) {
    const agent = agents.get(id);
    if (!agent) return 'idle';
    if (agent.pendingPermissions.size > 0 || agent.pendingQuestions.size > 0) return 'permission';
    if (agent.pendingTurns > 0 || agent.hasBgTasks?.()) return 'busy';
    if (aborted.has(id)) return 'aborted';
    if (errors.has(id)) return 'error';
    if (done.has(id)) return 'done';
    return 'idle';
  }

  function remove(id) {
    const agent = agents.get(id);
    if (!agent) return null;
    agent.dispose();
    agents.delete(id);
    permissionModes.delete(id);
    efforts.delete(id);
    done.delete(id);
    errors.delete(id);
    aborted.delete(id);
    unreadCounts.delete(id);
    unreadSnapshotOnEntry.delete(id);
    lastCountedTopLevelMessageId.delete(id);
    return agent;
  }

  // 把活计数并入 entry 快照并清零活计数器。未 ack 的旧快照必须保留：重连抖动/二次 capture 时 live 常为 0，
  // 若直接覆盖会把用户尚未点掉的胶囊数字冲没（只在 user:ackUnread 才 delete 快照）。有新 live 则相加
  // （离开期间又攒了未读）。显式切视图与断线重连均可反复调用。
  function captureUnreadSnapshot(id) {
    if (id == null) return;
    const live = unreadCounts.get(id) || 0;
    const prev = unreadSnapshotOnEntry.get(id) || 0;
    unreadSnapshotOnEntry.set(id, prev + live);
    unreadCounts.delete(id);
  }

  return {
    agents,
    permissionModes,
    efforts,
    done,
    errors,
    aborted,
    unreadCounts,
    unreadSnapshotOnEntry,
    lastCountedTopLevelMessageId,
    nextId,
    permissionModeOf,
    effortOf,
    forSession,
    inheritedMode,
    inheritedEffort,
    stateOf,
    captureUnreadSnapshot,
    remove,
  };
}
