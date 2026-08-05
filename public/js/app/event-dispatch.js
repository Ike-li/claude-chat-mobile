import { shouldDropAgentEvent } from '../logic.js';

// Handler 契约：`(payload, envelope)`。
//  · 第一参永远是 event.payload —— 绝大多数 handler 只声明它，多传一个实参对它们无影响。
//  · 第二参是【整个信封】，需要 payload 之外的元信息时才取。目前只有 user_message / text_delta
//    用它拿 `ts`：payload 里没有时间，而 sync:since 补发的是环形缓冲里的旧信封（server 原样转发），
//    ts 是事件真实发生时刻。若改用客户端 Date.now()，离开三小时后切回的那整批会被盖成「现在」，
//    刷新页面又变回磁盘时间 —— 同一批消息两种时间。信封上的 replay 标记同样由此传递。
export function createAgentEventDispatcher(context, {
  handlers = () => ({}),
  logger = null,
  onEpochReset = () => {},
  onSessionId = () => {},
  onHandledEvent = () => {}, // 仅 'handled' 分支触发（已过实例过滤 + epoch/seq 去重）
  // handler 抛异常时的上报口。默认吞掉也比让异常冒出去强——见 dispatch 里的说明。
  onHandlerError = () => {},
  outOfBand = {},
} = {}) {
  const log = typeof logger === 'function' ? logger : (logger?.log || (() => {}));
  let streamCharacters = 0;
  let thinkingCharacters = 0;
  let streamingMessageId = null;

  function logEvent(event) {
    const payload = event.payload || {};
    if (event.type === 'init') {
      log('recv', `[WEB_RECV] 初始化 (init): model=${payload.model || ''}, cwd=${payload.cwd || ''}, commandsCount=${payload.slashCommands?.length || 0}`);
    } else if (event.type === 'models') {
      const modelNames = (payload.models || []).map(model => typeof model === 'string' ? model : (model.displayName || model.value)).join(', ');
      log('recv', `[WEB_RECV] 可用模型列表 (models): 共 ${payload.models?.length || 0} 个选项 [${modelNames}]`);
    } else if (event.type === 'result') {
      log('recv', `[WEB_RECV] 结果 (result): isError=${payload.isError || false}, duration=${payload.durationMs}ms, cost=$${payload.costUsd || 0}`);
      if (streamingMessageId) {
        log('stream', `[STREAM] 流式接收完成。共计: 文本 ${streamCharacters} 字符, 思考 ${thinkingCharacters} 字符`);
        streamCharacters = 0;
        thinkingCharacters = 0;
        streamingMessageId = null;
      }
    } else if (event.type === 'error') {
      log('recv', `[WEB_RECV] 错误 (error): ${payload.message || ''}`);
    } else if (event.type === 'system') {
      log('recv', `[WEB_RECV] 系统通知 (system): ${payload.message || ''}`);
    } else if (event.type === 'permission_request') {
      log('recv', `[WEB_RECV] 权限审批请求: tool=${payload.name || ''}`);
    } else if (event.type === 'question') {
      log('recv', `[WEB_RECV] 提问: "${payload.text?.slice(0, 50)}..."`);
    } else if (event.type === 'user_message') {
      log('recv', `[WEB_RECV] 广播用户消息 (user_message): "${payload.text?.slice(0, 50)}${payload.text?.length > 50 ? '...' : ''}" (${payload.text?.length || 0} chars)`);
    } else if (event.type === 'text_delta') {
      if (!streamingMessageId) {
        streamingMessageId = payload.messageId || 'default';
        log('stream', `[STREAM] 启动流式文本段接收 (messageId=${streamingMessageId})`);
      }
      streamCharacters += payload.text?.length || 0;
    } else if (event.type === 'thinking_delta') {
      if (!streamingMessageId) {
        streamingMessageId = payload.messageId || 'default';
        log('stream', `[STREAM] 启动流式思考段接收 (messageId=${streamingMessageId})`);
      }
      thinkingCharacters += payload.text?.length || 0;
    } else if (event.type === 'tool_use') {
      log('recv', `[WEB_RECV] 工具启动: ${payload.name || ''}`);
    } else if (event.type === 'tool_result') {
      log('recv', `[WEB_RECV] 工具返回: toolUseId=${payload.toolUseId || ''}, ok=${payload.ok || false}`);
    }
  }

  return function dispatch(event) {
    const state = context.state;
    const bypass = outOfBand[event.type];
    if (bypass) {
      // 与 handled 分支对称：补发 outOfBand（task_notification）也要静音 alertCue/OS notify，
      // try/finally 防 handler 抛错把 isReplayBatch 卡在 true。
      state.isReplayBatch = Boolean(event.replay);
      try {
        bypass(event);
      } finally {
        state.isReplayBatch = false;
      }
      return 'out-of-band';
    }

    if (shouldDropAgentEvent(event, state.viewingInstanceId, state.instancesReady)) return 'dropped';

    if (event.epoch && event.epoch !== 'server') {
      if (event.epoch !== state.curEpoch) {
        state.curEpoch = event.epoch;
        state.lastSeq = 0;
        onEpochReset(event.epoch);
      }
      if (!Number.isFinite(event.seq) || event.seq <= state.lastSeq) return 'duplicate';
      state.lastSeq = event.seq;
    }

    if (event.sessionId && event.sessionId !== state.currentSessionId) {
      state.currentSessionId = event.sessionId;
      onSessionId(event.sessionId);
    }

    logEvent(event);
    onHandledEvent(event);
    // sync:since 批量补发标记：仅在 handler 调用期间为真，供 alertCue / OS notify 判断是否静音
    state.isReplayBatch = Boolean(event.replay);
    try {
      handlers()[event.type]?.(event.payload, event);
    } catch (err) {
      // 异常绝不能冒出去：lastSeq 在上面就已前移，这条事件已经不可能被 sync:since 补回（服务端
      // eventsSince 按 lastSeq 过滤），若再让异常中断整条派发链，同批后续事件会一起丢 —— 手机上
      // 表现为「对话缺了一段」且永不自愈，而用户没有 devtools 可查。回放 flush 路径一直是包着
      // try/catch 的（flushQueue），这里补齐同等待遇，并把异常交给调用方上报（logs:clientError）。
      onHandlerError(err, event);
    } finally {
      state.isReplayBatch = false;
    }
    return 'handled';
  };
}

// 回放缓冲：见 public/js/logic.js resolveReplayBufferAction 顶部注释（根因/优先级/阈值理由）。这里只
// 负责"怎么攒、怎么收尾"的机制本身，reload/flush 的判断交调用方（app.js）传入 resolveReplayBufferAction
// 的结果。依赖全部显式注入（不碰 window/DOM），保持与 createAgentEventDispatcher 一致的可测试边界：
//   dispatch              事件真正派发的出口（app.js 的 dispatchAgentEvent）
//   scrollBottom          app.js 的落底函数，flush 收尾时调用一次 scrollBottom(true)
//   withScrollSuppressed  (fn)=>void，运行 fn() 期间抑制 scrollBottom 的实际生效（app.js 实现：置位一个
//                          模块级标志，scrollBottom() 顶部检查该标志直接返回，派发完毕后照常调一次落底）
//   setSeq/setEpoch        续传基线前移（桥接 app.js 的 lastSeq/curEpoch 两个闭包变量的 setter；只写
//                          不读——'reload' 收尾时直接把队尾值覆盖过去，调用方无需先读旧值）
//   timeoutMs             ack 迟迟不来的兜底超时（默认 3000ms：不能无限期黑屏攒着不渲染）
// 同一时刻只可能有一个实例在缓冲（当前查看实例），single-slot 而非 Map；bindView（切视图）与
// requestSync（重连/前台探活）两条入口共用同一份实现，不允许各写一份不一致的逻辑。用 begin() 返回的
// handle 做身份校验防串扰——迟到的 ack / 超时回调若发现自己的 handle 已被更晚一次 begin/discard 顶替，
// 一律安全丢弃（同 app.js 既有 WS-001/WS-002 迟到 ACK 守卫的思路）。
// out-of-band 事件（与 createAgentEventDispatcher 的 outOfBand 表同口径）：不进环形缓冲语义、不占
// lastSeq、也不该被 replay buffer 攒着——尤其 resolve('reload') 会整批丢弃队列，若 OOB 被误入队，
// mirror_state / history_append 会永久丢失（只读锁不亮、CLI 追平气泡不出现），直到下一次独立推送。
// 调用方也可通过 isOutOfBand 注入覆盖（单测 / 未来扩展），默认按生产 outOfBand 类型表判定。
const DEFAULT_REPLAY_OOB_TYPES = new Set([
  'task_notification',
  'task_progress',
  'api_retry',
  'history_append',
  'mirror_state',
]);

export function createReplayBuffer({
  dispatch,
  scrollBottom,
  withScrollSuppressed,
  setSeq,
  setEpoch,
  timeoutMs = 3000,
  // 超时兜底决策：默认走 resolveReplayBufferAction 同口径（超阈值 → reload 语义，只推进基线不逐条吐；
  // 未超阈值 → flush）。调用方注入，避免本模块 import logic.js 形成循环/耦合。
  // 形参：({ bufferedCount }) => 'reload' | 'flush'；缺省恒 'flush'（与旧行为兼容，但生产路径必注入）。
  decideTimeoutAction = () => 'flush',
  isOutOfBand = (event) => DEFAULT_REPLAY_OOB_TYPES.has(event?.type),
} = {}) {
  let active = null; // { instanceId, queue: Array<event>, timeoutId }

  // 无条件丢弃当前缓冲（若有）——bindView 切视图顶部调用，含它自身可能提前 return 的空首页/compose
  // 分支：不管这次切视图最终落在哪个分支，上一个实例的残留缓冲都必须先清掉，防止静默吞掉它后续的
  // 实时事件（缓冲一直挂着、却再也没人来 resolve() 它）。
  // 亦供 requestSync act() 在视图已切走的早退路径调用：否则迟到 ack 直接 return 会把缓冲挂到超时，
  // 或被后续 begin 无声 discard，已收到但未渲染的 live 事件永久丢失（服务端环窗可能已挤出）。
  function discard() {
    if (!active) return;
    clearTimeout(active.timeoutId);
    active = null;
  }

  // 兜底：ack 超时未至，按 decideTimeoutAction 决定 reload/flush（不能无限期黑屏攒着；也不能无脑
  // flush 把超阈值积压重新变成打字机——那正是本机制要修的问题）。
  function armTimeout(handle) {
    handle.timeoutId = setTimeout(() => {
      if (active !== handle) return; // 已被更晚一次 begin/discard 顶替，本次超时失效
      // 走 resolve 统一收尾（清 active / 清 timer 已在 resolve 内；这里 timer 已触发故 clear 无害）。
      const action = decideTimeoutAction({ bufferedCount: handle.queue.length }) === 'reload'
        ? 'reload'
        : 'flush';
      resolve(handle, action);
    }, timeoutMs);
  }

  // socket.emit('sync:since', ...) 之前调用：先丢弃陈旧缓冲（防御性——理论上上一轮该已经 resolve
  // 干净），再为 instanceId 开一个新队列并挂超时兜底。返回 handle，调用方须原样传给 resolve()。
  function begin(instanceId) {
    discard();
    const handle = { instanceId, queue: [] };
    armTimeout(handle);
    active = handle;
    return handle;
  }

  // socket.on('agent:event', ...) 的实际入口：命中当前缓冲实例的【对话流】事件先入队不渲染（保序，
  // 含期间穿插的非 replay 实时事件）；OOB（mirror_state/history_append/task_*）与其它实例/无
  // instanceId 的合成事件不归本次缓冲管，返回 false 由调用方照常 dispatch——OOB 若被入队，
  // resolve('reload') 会整批丢掉它们且无法从 session:history 恢复（它们不在磁盘历史里）。
  function offer(event) {
    if (!active || !event || event.instanceId !== active.instanceId) return false;
    if (isOutOfBand(event)) return false;
    active.queue.push(event);
    return true;
  }

  function bufferedCount(instanceId) {
    return (active && active.instanceId === instanceId) ? active.queue.length : 0;
  }

  // 缓冲队列尾部最后一条"真实"事件（跳过 seq:0/epoch:'server' 的合成事件，如 gap 提示）：'reload' 丢弃
  // 缓冲前，续传基线须从这里取，不能沿用缓冲前的旧值——否则下次 sync 会重复播放本次被丢弃的这批事件，
  // 或因 seq 跳跃被误判 gap。events 按到达顺序入队 = 按真实 seq 顺序，故末尾往前找到的第一条即最新。
  function lastRealSeqEpoch(queue) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const e = queue[i];
      if (e && e.epoch && e.epoch !== 'server' && Number.isFinite(e.seq)) return { seq: e.seq, epoch: e.epoch };
    }
    return null;
  }

  function flushQueue(queue) {
    if (!queue || !queue.length) return;
    withScrollSuppressed(() => {
      for (const event of queue) {
        try { dispatch(event); } catch (err) { console.error('[replay-buffer] flush dispatch failed', err); }
      }
    });
    scrollBottom(true);
  }

  // 调用方在 sync:since ack（或超时兜底，见 armTimeout）拿到 resolveReplayBufferAction 的判定后调用：
  //   'reload'  → 丢弃队列 + 续传基线前移到队列尾，不渲染（调用方随后自行走 clearView+loadHistory）；
  //   'flush'   → 按序真正派发缓冲事件（抑制中间滚动，最后一次强制落底）；
  //   其他/'discard' → 纯丢弃，不动续传基线、不派发——用于 requestSync 判定 'reconnect' 这类"整条连接
  //                都要重来"的场景：缓冲内容从未渲染过，交给重连后全新一轮 sync:since 用旧基线重新取，
  //                绝不能推进基线（否则这批事件会被当成"已经处理过"，永久丢失、再也不会被回放）。
  // handle 必须是 begin() 返回的同一对象；若已被顶替（陈旧回调）则安全 no-op，不影响更晚一次的缓冲。
  function resolve(handle, action) {
    if (!handle || active !== handle) return;
    clearTimeout(handle.timeoutId);
    active = null;
    if (action === 'reload') {
      const tail = lastRealSeqEpoch(handle.queue);
      if (tail) { setSeq(tail.seq); setEpoch(tail.epoch); }
      return;
    }
    if (action === 'flush') flushQueue(handle.queue);
  }

  return { begin, discard, offer, bufferedCount, resolve };
}
