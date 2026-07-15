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

// BE-016：当前查看的实例被移除（退出 / dispose）后，重选查看目标并【原子同步】viewingCwd。
// 旧实现只更新 viewingInstanceId、不动 viewingCwd：落到剩余实例时 viewingCwdOf 会用实例 cwd 兜住（无感），
// 但两实例先后关闭最终落到空视图(null)时，裸 viewingCwd 停在更早的旧值 → 新会话选目录 / statusline git 段 /
// pendingMode 键跳回旧工作区。此处落到剩余实例取其 cwd、落到 null 保留刚移除实例的 cwd（它是最后实际查看的）。
//
// remainingIds：移除后仍存活的实例 id（按插入序，对齐 agents.keys()）；removedCwd：刚移除实例的 cwd；
// cwdOf(id)：id→cwd；fallbackCwd：removedCwd 缺失时的兜底（当前 viewingCwd）。
export function reselectViewingTarget(remainingIds, removedCwd, cwdOf, fallbackCwd) {
  const next = remainingIds.length ? remainingIds[0] : null;
  return { viewingInstanceId: next, viewingCwd: next ? cwdOf(next) : (removedCwd ?? fallbackCwd) };
}
