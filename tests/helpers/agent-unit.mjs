import { AgentSession } from '../../src/agent/agent.js';

export function makeSession(opts = {}) {
  const events = [];
  const session = new AgentSession({
    instanceId: opts.instanceId || 'test',
    cwd: opts.cwd || '/tmp/test',
    claudeBin: 'fake-claude',
    model: opts.model || null,
    permissionMode: opts.permissionMode || 'default',
    effort: opts.effort || null,
    idleTimeoutMs: opts.idleTimeoutMs ?? 60_000,
    instanceIdleReclaimMs: opts.instanceIdleReclaimMs,
    approvalTtlMs: opts.approvalTtlMs,
    resumeId: opts.resumeId || null,
    historicalCostUsd: opts.historicalCostUsd || 0,
    onEvent(event) { events.push(event); },
    onSessionId: opts.onSessionId || (() => {}),
    onExit: opts.onExit || (() => {}),
    onUsage: opts.onUsage || (() => {}),
    onBgTaskChange: opts.onBgTaskChange || (() => {}),
    onStateSettled: opts.onStateSettled || (() => {}),
  });
  return { s: session, events, dispose: () => session.dispose() };
}

// 等一个「只能由 TTL 到期 timer 结算」的 Promise。
//
// 产品侧那些 expiryTimer 都调了 .unref()（agent.js:886/1021），这是对的：30 分钟的审批 TTL
// 不该拖住 server 进程退出。但测试里 await 它就踩了 unref 的语义——事件循环若没有别的 ref'd
// handle，Node 判定「无事可做」直接收尾，于是该用例连同其后同 suite 的用例全报
// failureType: 'cancelledByParent'（不是断言失败，`fail 0` 却 `exit 1`）。
//
// Node 20 CI 上确定性复现：两次独立跑都是同一批 5 个（agent-questions 的 not ok 12-16）。
// 之所以别处没炸只是侥幸——Node 24 的 test runner 内部持有 ref'd handle；askPermission 那几个
// 则是 approvalStore.recordCreated 的异步落盘 I/O 恰好撑住了事件循环。两者都不是保证。
//
// 真实 server 靠 listening socket 撑着事件循环，这里用一个 ref'd interval 还原同一前提。
export async function awaitTtlSettled(promise) {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}
