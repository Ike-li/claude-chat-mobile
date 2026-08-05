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
    slashQuietNoticeMs: opts.slashQuietNoticeMs,
    resumeId: opts.resumeId || null,
    historicalCostUsd: opts.historicalCostUsd || 0,
    transcriptBaseDir: opts.transcriptBaseDir, // 扫盘类逻辑的隔离根（不传 = 生产默认 ~/.claude/projects）
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
//
// ★ keepAlive 必须有界。若 TTL 真的回归、promise 永不 settle（正是这些用例要抓的失败），
// 控制流到不了 finally，这个 ref'd interval 就永不清除：node:test 照常报 per-test timeout，
// 但进程被它吊住不退出，job 一路挂到 CI 的 timeout-minutes。实测过——测试 1s 就判失败，
// 进程 20s 后仍在，得靠外部杀。等于把几秒的局部失败换成挂死的 job。
// 所以用 budgetMs 兜底：到点主动 reject，finally 清掉 handle，进程照常退出，
// 且错误信息比 node:test 的泛型 timeout 更能指认病灶。budgetMs 需小于用例自己的 timeout。
export async function awaitTtlSettled(promise, budgetMs = 2000) {
  const keepAlive = setInterval(() => {}, 50);
  let bail;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        bail = setTimeout(() => reject(new Error(`TTL 未在 ${budgetMs}ms 内结算——到期 timer 没触发`)), budgetMs);
      }),
    ]);
  } finally {
    clearInterval(keepAlive);
    clearTimeout(bail);
  }
}
