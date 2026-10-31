// app/history-prefetch.js —— 点开非活会话时，历史和 session:switch 并行拉（2026-10-31 性能改造 Stage 3b）
//
// 原来要等 session:switch 回执、instances 广播、bindView 发 sync:since 再等它回来，才发 session:history，
// 读盘和传 1MB 级的历史全排在这三段往返之后。现在点击那一刻就发出去；bindView 的 sync:since 回来后凭
// 同一次打开来认领，由 loadHistory 按 prefetchedHistoryFits 判能不能直接画，判不过照常重新拉。
//
// 认领凭的是 perfTrace 的 open 对象而不是 sid：用户在中间又点了别的会话、A→B→A，或者同一个会话换了实例重新绑，
// 都会换一个 open，这份预取不会被另一次打开拿走，回执也不会记到它头上。
// 只留最近一次：后点的顶掉先点的。被顶掉的那次 ack 照样会回来，没人取，随槽一起丢掉。
export function createHistoryPrefetch({ socket, timeoutMs }) {
  let slot = null;

  function start({ open, sessionId, cwd }) {
    slot = null;
    if (!open || !sessionId) return;
    // prefetch 只是标记：真 server 只读 sessionId 和 cwd；mock 靠它区分出预取，不让预取吃掉按页面那次拉取写的一次性夹具
    const settled = new Promise(resolve => {
      socket.timeout(timeoutMs).emit('session:history', { sessionId, cwd, prefetch: true }, (err, res) => resolve({ err, res }));
    });
    slot = { open, sessionId, cwd, settled };
  }

  // 一次性：凭据对上就清槽。会话或目录对不上说明预取读的不是这次要画的那份 transcript，作废、返回 null
  function take({ open, sessionId, cwd }) {
    if (!slot || slot.open !== open) return null;
    const claimed = slot;
    slot = null;
    return claimed.sessionId === sessionId && claimed.cwd === cwd ? claimed.settled : null;
  }

  return { start, take };
}
