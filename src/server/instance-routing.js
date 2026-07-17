// instance-routing.js —— 台阶3 实例路由目标解析（BE-001）。
//
// 客户端可为某个 tab（instanceId）发送消息 / 审批 / 中断 / 切档等控制事件。旧实现把「未提供 ID」和
// 「显式给了但已不在 live」都回退到 viewingInstanceId——后者会把发给已关闭会话的消息 / 中断静默改投到
// 当前查看的另一段会话（BE-001 误投：隔离复现中向已关闭实例发消息，ACK 与事件目标显示落到 live 实例）。
//
// 本纯函数区分三态，调用方据此 fail-closed：
//   - 未提供（null / undefined）        → { id: viewingInstanceId, stale: false } 回退当前查看实例（向后兼容缺参旧调用）
//   - 显式命中 live                     → { id: <该 id>, stale: false }
//   - 显式但不在 live（含空串等非 null 假值）→ { id: null, stale: true } 目标已失效，调用方应负 ACK / no-op，
//                                          【绝不】回退 viewing、【绝不】懒开新实例
//
// 缺省且无 viewing（首发 / 无 open tab）返回 { id: null, stale: false }：id 为空但非 stale，调用方据 stale=false
// 走懒开而非拒绝。据此 { id:null } 的两种成因（缺省无 viewing vs 显式 stale）由 stale 字段区分。
//
// isLive(id) 由调用方注入（server 侧即 id => agents.has(id)），保持本模块无状态、可单测。

export function resolveInstanceTarget(requestedId, viewingInstanceId, isLive) {
  if (requestedId == null) return { id: viewingInstanceId ?? null, stale: false };
  if (isLive(requestedId)) return { id: requestedId, stale: false };
  return { id: null, stale: true };
}

// BE-016 + resumeFailed UX：当前查看的实例被移除（退出 / dispose）后，重选查看目标并【原子同步】viewingCwd。
// 旧实现只更新 viewingInstanceId、不动 viewingCwd：落到剩余实例时 viewingCwdOf 会用实例 cwd 兜住（无感），
// 但两实例先后关闭最终落到空视图(null)时，裸 viewingCwd 停在更早的旧值 → 新会话选目录 / statusline git 段 /
// pendingMode 键跳回旧工作区。
//
// 策略（2026-07-17）：
//   1. 一律优先同 removedCwd 的剩余实例（同工作区其它 tab）
//   2. 无同 cwd 时：
//      · allowCrossWorkspace=false（默认；进程退出 / resumeFailed）→ null + 保留 removedCwd
//        —— 禁止把视图静默弹到其它工作区（用户切会话 resume 失败时曾闪回 mimo）
//      · allowCrossWorkspace=true（用户主动 session:close）→ 插入序第一个剩余，cwd 随该实例
//   3. 无任何剩余 → null + (removedCwd ?? fallbackCwd)
//
// remainingIds：移除后仍存活的实例 id（按插入序，对齐 agents.keys()）；removedCwd：刚移除实例的 cwd；
// cwdOf(id)：id→cwd；fallbackCwd：removedCwd 缺失时的兜底（当前 viewingCwd）。
export function reselectViewingTarget(remainingIds, removedCwd, cwdOf, fallbackCwd, opts = {}) {
  const ids = Array.isArray(remainingIds) ? remainingIds : [];
  const allowCross = opts.allowCrossWorkspace === true;
  if (removedCwd != null) {
    const sameCwd = ids.find(id => cwdOf(id) === removedCwd);
    if (sameCwd) return { viewingInstanceId: sameCwd, viewingCwd: removedCwd };
  }
  if (allowCross && ids.length) {
    const next = ids[0];
    return { viewingInstanceId: next, viewingCwd: cwdOf(next) };
  }
  return { viewingInstanceId: null, viewingCwd: removedCwd ?? fallbackCwd };
}

// 置换（externalDirty / setEffort）await 结束后是否应接管 viewing。
// 前提：silent dispose 不 reselect——viewing 仍指向已删 id（死指针），或用户已主动切走。
//   · viewingNow === disposedId → 用户未切走（仍停在被换实例）→ claim 新实例
//   · 否则（切到其他 live / home null / 已是 openedId）→ 不抢
export function shouldClaimViewingAfterSwap({ disposedId, viewingNow } = {}) {
  if (disposedId == null) return false;
  return viewingNow === disposedId;
}

// 懒开 await 结束后是否应接管 viewing。
//   · viewingNow === viewingAtStart → 用户未在 open 窗口内切走（含双方皆 null 的空首页首发）→ claim
//   · 否则 → 不抢
export function shouldClaimViewingAfterLazyOpen({ viewingAtStart, viewingNow } = {}) {
  return viewingNow === viewingAtStart;
}

// SRV-NEW-004：session:delete / deletePermanent 是否允许继续删除。
// liveInstance=true → web 正驱动；resumeInFlight=true → 并发 switch/open 正在 spawn。
// 两道闸任一命中 → fail-closed 拒绝（避免 hide/删文件与 resume 写盘竞态）。
export function canDeleteSessionGuard({ liveInstance = false, resumeInFlight = false } = {}) {
  if (liveInstance) {
    return { ok: false, reason: 'live', error: '会话正在被本产品驱动，请先结束或关闭该会话再删除' };
  }
  if (resumeInFlight) {
    return { ok: false, reason: 'opening', error: '会话正在打开中，请稍后再删除' };
  }
  return { ok: true, reason: null, error: null };
}

// SRV-003：externalDirty 需 dispose+resume 置换，但 isBusy 时禁止置换（会 kill 在途 turn / bg / 审批）。
// 负 ACK 须同时说明「为何要置换」+「为何现在不能」——旧文案「会话正在处理」在 UI 已 result「完成」时极误导
// （例如仅 bgTasks 残留、或 turn 刚结束与发送竞态）。detail 供 interact 日志排障。
// 优先级：turn > permission/question > bgTasks > busy 兜底。
export function externalDirtyBusyNack({
  pendingTurns = 0,
  bgTaskCount = 0,
  pendingPermissionCount = 0,
  pendingQuestionCount = 0,
} = {}) {
  const turns = Number(pendingTurns) > 0 ? Number(pendingTurns) : 0;
  const bgs = Number(bgTaskCount) > 0 ? Number(bgTaskCount) : 0;
  const perms = Number(pendingPermissionCount) > 0 ? Number(pendingPermissionCount) : 0;
  const qs = Number(pendingQuestionCount) > 0 ? Number(pendingQuestionCount) : 0;
  const bits = [];
  if (turns) bits.push(`pendingTurns=${turns}`);
  if (bgs) bits.push(`bgTasks=${bgs}`);
  if (perms) bits.push(`permissions=${perms}`);
  if (qs) bits.push(`questions=${qs}`);
  const detail = bits.length ? bits.join(' ') : 'busy=true';

  if (turns > 0) {
    return {
      error: '需先吸收终端写入，但上一轮仍在处理，请完成后重试',
      reason: 'turn',
      detail,
      retryable: true,
    };
  }
  if (perms > 0 || qs > 0) {
    return {
      error: '需先吸收终端写入，但仍有待处理的审批或提问',
      reason: 'permission',
      detail,
      retryable: true,
    };
  }
  if (bgs > 0) {
    return {
      error: '需先吸收终端写入，但后台任务仍在运行，请完成后重试',
      reason: 'bg_tasks',
      detail,
      retryable: true,
    };
  }
  return {
    error: '需先吸收终端写入，但会话仍忙，请稍后重试',
    reason: 'busy',
    detail,
    retryable: true,
  };
}
