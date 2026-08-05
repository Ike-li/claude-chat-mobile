// 拉历史在途期间的 out-of-band 事件闸门。
//
// loadHistory 是异步的：发 session:history → 等 ack → renderHistoryBubbles 分块渲染
// （chunk=40、idle timeout=200ms，2000 条约 50 块，最坏可达秒级）→ 最后一次性插入 #messages。
// 这整段窗口里，server 的 catchUpTick（mirror-engine 常态 2500ms 一轮）完全可能检出终端刚落定的
// 消息并推 history_append。它是 out-of-band，不进 replay buffer（见 event-dispatch.js 的
// DEFAULT_REPLAY_OOB_TYPES），也就是说 buffer 挡不住，任何时候都直接渲染。
//
// 后果有两层，第二层更隐蔽：
//  ① 顺序：增量先落地、历史后落地 → 新消息在上、整段旧历史在下。
//  ② 时间戳：增量是对着【尚被 clearView 清空的】#messages 判定的，prevTs 取不到就命中
//     「会话首条」规则，凭空带上一条日期分隔行——于是同一天出现两条「今天」。
//
// 曾经试过事后把节点挪回正确位置：那只治得了 ①，②的 marker 早已按错误基准算出来了，
// 顺序修了、状态没修，是非原子更新。所以改成从根上消掉竞态——在途期间把事件扣住，
// 历史落地后按原顺序放行，届时 DOM 已是最终态，顺序与打戳同时正确。
// 【为什么 begin() 要发 handle】同一时刻只可能有一轮历史加载在扣事件（single-slot），但**迟到的
// ACK 可以来自上一轮**：A 会话发起加载 → 用户切到 B → B 的 begin() 接管闸门并扣住了若干追平 →
// 这时 A 的 ACK 才回来，命中 loadHistory 的迟到守卫。若它无条件关闸，会把 B 已扣住的队列一并清空，
// 而 B 随后只能释放空队列——那些没进历史快照的增量就永久消失了（终端在跑、手机上却少了几条）。
// 所以 abort/release 都按 handle 结算：不是自己那一轮就安全地什么都不做。
// 同款思路见 event-dispatch.js 的 createReplayBuffer（WS-001/WS-002 迟到 ACK 守卫）。
//
// 【为什么必须有看门狗】上面那套 handle 结算只保证「谁该关闸」，不保证「闸门一定会被关上」——
// 它要求每条早退路径都记得调 abort/release。实测有两条路径没人记得，且都无声无息：
//  ① renderHistoryBubbles 是分块渲染，中途切走时 processChunk 直接 return，而 onDone 是
//     flushHeldHistoryAppends 的唯一调用点，于是既不 release 也不 abort；
//  ② session:history 用的是裸 ack，socket.io-client 断线时 _clearAcks() 会 delete 掉非 withError
//     的 handler 并且**不调用它**（见 socket.io-client/build/esm/socket.js 的 _clearAcks），
//     手机锁屏/切后台就能触发，回调永不执行。
// 后果一样：闸门永久开着，此后该实例每条 history_append 都被 hold 掉——终端在跑、手机再也不刷新、
// 没有任何报错。逐条补 abort 是打地鼠，新增一条早退路径就再漏一次；所以照 createReplayBuffer 的
// armTimeout 补一道兜底：到点就把扣住的事件放行并关闸。宁可顺序稍差，也绝不静默吞消息。
// 20s：必须长于 app.js 的 session:history ack 超时（15s）+ 分块渲染最坏耗时，让 release/abort 这两条
// 显式路径永远有先手，看门狗只在「回调压根没来过」时才兜底。它不是正常路径的一部分，调到这里就说明
// 有代码路径失职了；阈值宁可保守，也不要把慢加载误判成失职而抢跑。
const DEFAULT_TIMEOUT_MS = 20000;

export function createHistoryLoadGate({ timers = globalThis, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let current = null;   // { instanceId, queue, timeoutId }；null = 闸门关闭。对象身份即 handle
  let onTimeoutFlush = () => {};

  const isStale = handle => handle != null && handle !== current;

  function disarm() {
    if (current?.timeoutId != null) timers.clearTimeout(current.timeoutId);
  }

  return {
    // 兜底放行的接收方（app.js 注入，走与正常放行同一条 onHistoryAppend 路径）。
    onTimeout(fn) { onTimeoutFlush = typeof fn === 'function' ? fn : () => {}; },

    // 开闸，返回本轮的 handle。同实例重新加载（gap reload）时也换新 handle，
    // 上一轮的残留队列自然作废，不会被带进新一轮。
    begin(instanceId) {
      disarm(); // 换轮：撤掉上一轮的兜底，避免旧定时器到点后打中新一轮的队列
      const handle = { instanceId: instanceId ?? null, queue: [], timeoutId: null };
      current = handle;
      handle.timeoutId = timers.setTimeout(() => {
        if (current !== handle) return; // 已被更晚一次 begin/release/abort 顶替，本次兜底失效
        const held = handle.queue;
        current = null;
        onTimeoutFlush(held);
      }, timeoutMs);
      return handle;
    },
    // 返回 true 表示已扣住，调用方不要再渲染这条。
    // 只扣当前加载目标的事件——与 loadHistory 的迟到 ACK 守卫同口径；别的实例的追平必须照常放行，
    // 否则切走后那边会被静默扣住，表现为「终端在跑但手机上再也不更新」。
    hold(event) {
      if (!current || current.instanceId == null) return false;
      if (event?.instanceId !== current.instanceId) return false;
      current.queue.push(event);
      return true;
    },
    // 关闸并交出队列。幂等（再调返回空）；非本轮的 handle 拿不到任何东西，也不影响当前轮。
    release(handle) {
      if (!current || isStale(handle)) return [];
      disarm();
      const released = current.queue;
      current = null;
      return released;
    },
    // 关闸并丢弃。loadHistory 的每条早退路径（空历史 / error / 迟到 ACK 被守卫丢弃）都要调，
    // 否则闸门永远开着，之后所有追平被静默吞掉。非本轮的 handle 是 no-op。
    abort(handle) {
      if (isStale(handle)) return;
      disarm();
      current = null;
    },
  };
}
