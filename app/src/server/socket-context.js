// 上下文面板（状态栏 ctx 段点进去）的数据：context:usage，打开面板时才取，不进 statusline 的 10s tick。
//
// 实测（CLI 真进程 + 假 Messages API，2026-11-07）：summary 走本地估算，零 count_tokens；full 首次 18 发，
// 之后同一进程里 0 发，跨回合也是。所以面板先要 summary 出数，再要 full 校准，开合多少次都不会放大请求。
// CLI 驾驶的会话没有 q，这里回 unavailable，面板只显示 bridge 给的总量。
const RPC_TIMEOUT_MS = { summary: 3000, full: 20_000 }; // full 的冷路径实测 7.6s

export function contextUsageView(usage) {
  const { totalTokens, maxTokens, percentage, autoCompactThreshold, isAutoCompactEnabled } = usage;
  return {
    totalTokens, maxTokens, percentage, autoCompactThreshold, isAutoCompactEnabled,
    categories: usage.categories
      .filter(c => c.kind !== 'deferred' && c.tokens > 0)
      .map(({ id, name, tokens, kind }) => ({ id, name, tokens, kind })),
  };
}

export function registerContextSocketHandlers({ socket, on, routeInstance }) {
  on(socket, 'context:usage', async ({ instanceId, detail } = {}, ack) => {
    if (typeof ack !== 'function') return;
    const agent = routeInstance(instanceId);
    if (!agent?.q?.getContextUsage || agent.disposed) return ack({ ok: false, code: 'unavailable' });
    const level = detail === 'full' ? 'full' : 'summary';
    let timer = null;
    try {
      const usage = await Promise.race([
        agent.q.getContextUsage({ detail: level }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), RPC_TIMEOUT_MS[level]); }),
      ]);
      return ack({ ok: true, detail: level, ...contextUsageView(usage) });
    } catch {
      return ack({ ok: false, code: 'failed' });
    } finally {
      clearTimeout(timer);
    }
  });
}
