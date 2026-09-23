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
  // 已移出 agents、CLI 子进程还没退完的实例（remove 放进来，exitPromise 结算后自行移出）。
  // 它们退出前还会往 transcript 追加收尾元数据，彻底删除必须等（见 waitForSessionExits）。
  // 空闲回收中的实例不在这里：它们带着 terminating 留在 agents 里，直到 consume 走完才被 onExit 清表。
  const exiting = new Set();

  const nextId = () => `inst_${++counter}`;
  const permissionModeOf = id => permissionModes.get(id) ?? 'default';
  const effortOf = id => efforts.get(id) ?? null;

  function forSession(sessionId) {
    if (!sessionId) return null;
    for (const agent of agents.values()) {
      if (agent.sessionId !== sessionId) continue;
      // 空闲回收 checkIdle 置 terminating 后、onExit 删 Map 前有竞态窗：若仍命中这份「正在死」
      // 的实例，session:switch 会 bind 到即将消失的 instanceId → 历史分块渲染中途被 reselect
      // 打断 → 聊天区只剩「加载了 N 条」/回收横幅、气泡未落地（7134c083 复现）。
      // disposed 同理（dispose 后 onExit 可能尚未删 Map）。跳过，让调用方走 fresh resume。
      if (agent.terminating || agent.disposed) continue;
      return agent;
    }
    return null;
  }

  function inheritedEffort(cwd) {
    let effort = null;
    for (const agent of agents.values()) {
      if (agent.cwd === cwd) effort = agent.effortAuto ? 'auto' : agent.effort;
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

  // 单驾驶员判定（镜像引擎）用的口径：'busy' = 己方在写主链 transcript，只认在途轮。
  // 不得复用 stateOf——它把 hasBgTasks 折进 'busy'，纯后台任务期（dev server 挂几小时、
  // pendingTurns=0）会被镜像引擎当成己方在写盘：终端在同一会话写的内容既不追平也不标
  // externalDirty，而发送闸只拦在途轮，手机消息送进陈旧实例、分叉（2026-09-22 review P0）。
  // 后台任务期 SDK 注入的 <task-notification> 与随后的自动汇报自报 sdk-ts，由 catchUpStep 的
  // entrypoint 判据吸收，不需要靠这里把整段时间豁免掉。
  function driverStateOf(id) {
    const state = stateOf(id);
    return state === 'busy' && !(agents.get(id)?.pendingTurns > 0) ? 'idle' : state;
  }

  // /health.busy 与 instances.turnRunning 同口径：只认在途轮。不得复用 stateOf === 'busy'——
  // 那把 hasBgTasks 也折进去，后台任务期抽屉会显示运行中，但发送仍放行（见 app.js turnRunning 注释）。
  // health 若跟 stateOf 对齐，巡检会把「有后台任务」说成「有在途轮」。
  function anyTurnRunning() {
    for (const agent of agents.values()) {
      if (agent.pendingTurns > 0) return true;
    }
    return false;
  }

  // 只清表、不 dispose。onExit 与 remove 共用这一份——两处各自手写九行 delete 时曾漏掉
  // unread* 三张表（2026-08-03 F3），instanceId 自增不复用，条目永远无人再读。收敛后加新表只改这里。
  function clearTables(id) {
    agents.delete(id);
    permissionModes.delete(id);
    efforts.delete(id);
    done.delete(id);
    errors.delete(id);
    aborted.delete(id);
    unreadCounts.delete(id);
    unreadSnapshotOnEntry.delete(id);
    lastCountedTopLevelMessageId.delete(id);
  }

  function remove(id) {
    const agent = agents.get(id);
    if (!agent) return null;
    agent.dispose();
    clearTables(id);
    exiting.add(agent);
    Promise.resolve(agent.exitPromise).then(() => exiting.delete(agent));
    return agent;
  }

  // 该会话名下「已关、没退完」的实例的退出确认。活实例不算：它由删除保护①直接拒绝，等它只会白等到上限。
  function exitPromisesOf(sessionId) {
    const pending = [];
    for (const agent of agents.values()) {
      if (agent.sessionId === sessionId && (agent.terminating || agent.disposed)) pending.push(agent.exitPromise);
    }
    for (const agent of exiting) {
      if (agent.sessionId === sessionId) pending.push(agent.exitPromise);
    }
    return pending;
  }

  // 等它们全部退出，最多等 timeoutMs；返回是否在上限内等到。
  // 每轮等完要重新收集：等待期间另一台设备可能又开又关了这个会话，只等开头那一批会漏掉新关的那个。
  // 重新收集时跳过已经等过的：dispose 过却没走 onExit 清表的实例会一直留在表里，它那个早已结算的
  // promise 每轮都会被收回来——不跳过就是在已结算的 promise 上空转，微任务队列停不下来，整个进程卡死。
  async function waitForSessionExits(sessionId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const awaited = new Set();
    for (;;) {
      const fresh = exitPromisesOf(sessionId).filter(p => !awaited.has(p));
      if (!fresh.length) return true;
      for (const p of fresh) awaited.add(p);
      let timer;
      const settled = await Promise.race([
        Promise.all(fresh).then(() => true),
        new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), false); }),
      ]).finally(() => clearTimeout(timer));
      if (!settled) return false;
    }
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
    inheritedEffort,
    stateOf,
    driverStateOf,
    anyTurnRunning,
    captureUnreadSnapshot,
    clearTables,
    remove,
    waitForSessionExits,
  };
}
