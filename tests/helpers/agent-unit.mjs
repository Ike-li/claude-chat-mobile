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
  });
  return { s: session, events, dispose: () => session.dispose() };
}
