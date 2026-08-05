// tests/unit/frontend-event-dispatch.test.mjs —— agent:event 派发器的行为域单测。
// 从 frontend-app-modules.test.mjs 分出：按行为域拆分是硬门禁（见 source-layout.test.mjs）。
// 覆盖：实例/epoch/seq 边界、onHandledEvent 分支、isReplayBatch 语义、handler 异常隔离。

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppContext } from '../../public/js/app/context.js';
import { createAgentEventDispatcher } from '../../public/js/app/event-dispatch.js';

test('agent event dispatcher keeps instance, epoch and sequence boundaries in shared state', () => {
  const handled = [];
  const resets = [];
  const sessions = [];
  const state = {
    viewingInstanceId: 'inst-1',
    instancesReady: true,
    curEpoch: null,
    lastSeq: 0,
    currentSessionId: null,
  };
  const context = createAppContext({ state });
  const dispatch = createAgentEventDispatcher(context, {
    handlers: () => ({ result: payload => handled.push(payload) }),
    onEpochReset: epoch => resets.push(epoch),
    onSessionId: sessionId => sessions.push(sessionId),
  });

  assert.equal(dispatch({ type: 'result', instanceId: 'inst-2', epoch: 'e1', seq: 1 }), 'dropped');
  assert.equal(dispatch({ type: 'result', instanceId: 'inst-1', epoch: 'e1', seq: 1, sessionId: 's1', payload: { ok: true } }), 'handled');
  assert.equal(dispatch({ type: 'result', instanceId: 'inst-1', epoch: 'e1', seq: 1, payload: { ok: false } }), 'duplicate');
  assert.equal(dispatch({ type: 'result', instanceId: 'inst-1', epoch: 'e1', payload: { ok: false } }), 'duplicate'); // seq 缺失的畸形信封必须判重复，不能永远当新事件

  assert.deepEqual(resets, ['e1']);
  assert.deepEqual(sessions, ['s1']);
  assert.deepEqual(handled, [{ ok: true }]);
  assert.equal(state.curEpoch, 'e1');
  assert.equal(state.lastSeq, 1);
});

// onHandledEvent 仅在 'handled' 分支触发：dropped / duplicate 不触发，handled 触发一次。
test('agent event dispatcher invokes onHandledEvent only for the handled branch', () => {
  const handledCalls = [];
  const state = {
    viewingInstanceId: 'inst-1',
    instancesReady: true,
    curEpoch: null,
    lastSeq: 0,
    currentSessionId: null,
  };
  const context = createAppContext({ state });
  const dispatch = createAgentEventDispatcher(context, {
    handlers: () => ({ text_delta: () => {} }),
    onHandledEvent: (ev) => handledCalls.push(ev.type),
  });

  dispatch({ type: 'text_delta', instanceId: 'inst-2', epoch: 'e1', seq: 1 }); // dropped：其他实例
  dispatch({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 1 }); // handled
  dispatch({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 1 }); // duplicate（同 seq 重放）

  assert.deepEqual(handledCalls, ['text_delta']);
});

// 未读补发防连响：sync:since 批量补发的事件带 replay:true，dispatch 期间应把 state.isReplayBatch
// 置为 true 供 alertCue 消费方判断是否静音；实时事件（无 replay 标记）则应为 false。处理完必须复位，
// 不能污染下一条事件——用不同 seq 各调用一次 dispatch 模拟"补发一条、实时到一条"的真实顺序。
test('agent event dispatcher marks replay batches in shared state only for the duration of the handler call', () => {
  const seenDuringHandler = [];
  const state = {
    viewingInstanceId: 'inst-1',
    instancesReady: true,
    curEpoch: null,
    lastSeq: 0,
    currentSessionId: null,
  };
  const context = createAppContext({ state });
  const dispatch = createAgentEventDispatcher(context, {
    handlers: () => ({ result: () => seenDuringHandler.push(state.isReplayBatch) }),
  });

  dispatch({ type: 'result', instanceId: 'inst-1', epoch: 'e1', seq: 1, replay: true, payload: {} });
  dispatch({ type: 'result', instanceId: 'inst-1', epoch: 'e1', seq: 2, payload: {} });

  assert.deepEqual(seenDuringHandler, [true, false]);
  assert.equal(state.isReplayBatch, false); // 处理完复位，不遗留污染状态
});

// 防永久静音：handler 抛错也必须复位 isReplayBatch（与 applyPendingSnapshot 的 try/finally 对称）
test('agent event dispatcher resets isReplayBatch even when the handler throws', () => {
  const state = {
    viewingInstanceId: 'inst-1',
    instancesReady: true,
    curEpoch: null,
    lastSeq: 0,
    currentSessionId: null,
  };
  const context = createAppContext({ state });
  const caught = [];
  const dispatch = createAgentEventDispatcher(context, {
    handlers: () => ({ result: () => { throw new Error('boom'); } }),
    onHandlerError: err => caught.push(err.message),
  });

  // 契约变更（有意）：异常不再向外冒。此前它会成为 socket.on('agent:event') 上的 uncaught error 并
  // 中断整条派发链——而 lastSeq 已前移，同批后续事件会一起永久丢失且不可补（服务端 eventsSince
  // 按 lastSeq 过滤）。现在改为交给 onHandlerError 上报。本用例真正要守的仍是下面那条 finally 语义。
  assert.doesNotThrow(() => {
    dispatch({ type: 'result', instanceId: 'inst-1', epoch: 'e1', seq: 1, replay: true, payload: {} });
  });
  assert.deepEqual(caught, ['boom'], '异常必须被上报，不能静默吞掉');
  assert.equal(state.isReplayBatch, false);
});

// outOfBand（task_notification）也要在 handler 期间置 isReplayBatch，否则补发仍连响
test('agent event dispatcher marks isReplayBatch for out-of-band replay events', () => {
  const seen = [];
  const state = {
    viewingInstanceId: 'inst-1',
    instancesReady: true,
    curEpoch: null,
    lastSeq: 0,
    currentSessionId: null,
  };
  const context = createAppContext({ state });
  const dispatch = createAgentEventDispatcher(context, {
    outOfBand: {
      task_notification: () => { seen.push(state.isReplayBatch); },
    },
  });

  dispatch({ type: 'task_notification', instanceId: 'inst-1', epoch: 'e1', seq: 1, replay: true, payload: {} });
  dispatch({ type: 'task_notification', instanceId: 'inst-1', epoch: 'e1', seq: 2, payload: {} });

  assert.deepEqual(seen, [true, false]);
  assert.equal(state.isReplayBatch, false);
});

// 实时派发链此前无 try/catch：lastSeq 在调 handler【之前】就已前移（event-dispatch.js:84），handler 一抛
// 异常，异常冒到 socket.on('agent:event') 成为 uncaught error，该事件永久不可补 —— 服务端 eventsSince
// 按 lastSeq 过滤，sync:since 再也不会回放它。更糟的是整条派发链当场中断，此后同批事件全丢。
// 回放 flush 路径本来就包了 try/catch（flushQueue），说明作者知道 handler 会抛，只是实时路径漏了。
// 代码里已有两处「被 handler 抛错咬过」的伤疤注释（app.js FE-NEW-002 / FE-003），都是逐点打补丁。
test('agent event dispatcher isolates handler exceptions so the chain keeps flowing', () => {
  const seen = [];
  const errors = [];
  const context = createAppContext({ state: { viewingInstanceId: null, instancesReady: true } });
  const dispatch = createAgentEventDispatcher(context, {
    handlers: () => ({
      boom() { throw new TypeError('handler exploded'); },
      ok(payload) { seen.push(payload); },
    }),
    onHandlerError: (err, event) => errors.push([event.type, err.message]),
  });

  assert.equal(dispatch({ seq: 1, epoch: 'e1', type: 'boom', payload: {} }), 'handled');
  assert.equal(dispatch({ seq: 2, epoch: 'e1', type: 'ok', payload: 'after' }), 'handled');

  assert.deepEqual(seen, ['after'], '前一条事件的 handler 抛异常后，后续事件必须照常处理');
  assert.deepEqual(errors, [['boom', 'handler exploded']], '异常要能被上报，不是静默吞掉');
  assert.equal(context.state.isReplayBatch, false, 'isReplayBatch 不得被异常卡在 true');
});

// handler 除 payload 外还要拿到整个信封 —— 消息流时间戳要用信封上的 ts。
// 【为什么不能用客户端 Date.now() 代替】sync:since 补发是 { ...envelope, replay: true } 原样转发
// 环形缓冲里的旧信封（src/server/app.js），ts 是事件真实发生时刻。离开三小时后切回，那整批回放
// 若按 Date.now() 记，跨天分隔不出现、HH:mm 全错；而刷新页面后同一批消息改从磁盘 timestamp 渲染，
// 时间当场变了。这不是毫秒级偏差，是分钟到小时级的自相矛盾。
test('dispatch 把完整信封作为第二参交给 handler，回放批次带的是事件原始时刻', () => {
  const seen = [];
  const state = { viewingInstanceId: 'inst-1', instancesReady: true, curEpoch: null, lastSeq: 0, currentSessionId: null };
  const dispatch = createAgentEventDispatcher(createAppContext({ state }), {
    handlers: () => ({ user_message: (payload, envelope) => seen.push({ payload, envelope }) }),
  });

  const oldTs = Date.now() - 26 * 3600 * 1000; // 26 小时前：跨天
  dispatch({
    type: 'user_message', instanceId: 'inst-1', epoch: 'e1', seq: 1, sessionId: 's1',
    ts: oldTs, replay: true, payload: { text: 'hi' },
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].payload, { text: 'hi' }, '第一参仍是 payload，既有 handler 签名不变');
  assert.equal(seen[0].envelope?.ts, oldTs, '第二参须带信封原始 ts，不能是当下时刻');
  assert.equal(seen[0].envelope?.replay, true);
});
