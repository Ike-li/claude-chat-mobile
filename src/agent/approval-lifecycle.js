// 审批台账生命周期（重启 fail-closed + NFR-16 留存治理），从 server/app.js 下沉。
import * as approvalStore from './approval-store.js';
import * as audit from '../ops/audit.js';

// NFR-16："建议 90 天，可配"（docs/design.md）。0/负数/非数字一律回落默认。
export function approvalRetentionMs(env = process.env) {
  const days = Number(env.APPROVAL_RETENTION_DAYS) > 0 ? Number(env.APPROVAL_RETENTION_DAYS) : 90;
  return days * 24 * 60 * 60 * 1000;
}

// 重启后 pending 审批的 fail-closed 处置（docs/design.md §4）：canUseTool 回调绑在上一进程的
// 内存里，随进程终止已无法兑现——遗留在持久化台账里的 status=pending 记录一律标 expired，
// 绝不能让它们在"等我"聚合或任何未来查询里看起来"仍可批准"（批一个已无执行上下文的操作是危险假象）。
// 必须在 httpServer.listen 之前跑完：这之后 io 才可能真正开始接受连接、驱动新的实例。
export function expireOrphanedPending({
  store = approvalStore,
  recordAudit = audit.recordAudit,
} = {}) {
  const count = store.expireAllPending({ decidedBy: 'system:restart', decidedAt: Date.now() });
  if (count > 0) {
    console.log(`[approval-store] 重启恢复：${count} 条遗留 pending 审批已标记 expired`);
    recordAudit({ action: 'approval_restart_expired', outcome: 'expired', meta: { count } });
  }
  return count;
}

// 留存治理：approval_request 终态记录超过保留期即清理，清理动作记一条汇总审计（条数，不含内容），
// 呼应设计明文"不无声无限增长"。启动即跑一次（覆盖"长期不重启的常驻 server 也需要治理"）+
// 之后每 24h 一次；audit_record 自己的留存是写入时环形上限（见 audit.js），无需周期清理。
export function startApprovalRetentionSweep({
  env = process.env,
  store = approvalStore,
  recordAudit = audit.recordAudit,
  setIntervalImpl = setInterval,
} = {}) {
  const retentionMs = approvalRetentionMs(env);
  const sweep = () => {
    const purged = store.purgeTerminalOlderThan(Date.now() - retentionMs);
    if (purged > 0) {
      console.log(`[approval-store] 留存治理：清理 ${purged} 条超过保留期的终态审批记录`);
      recordAudit({ action: 'retention_cleanup', outcome: 'success', meta: { table: 'approval_request', count: purged } });
    }
  };
  sweep();
  const timer = setIntervalImpl(sweep, 24 * 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}
