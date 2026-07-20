import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../helpers/agent-unit.mjs';

test.describe('logMeta()', () => {
  test('全空 → 兜底 default / model-default / default', () => {
    const { s } = makeSession();
    assert.deepEqual(s.logMeta(), { model: 'default', effort: 'model-default', permissionMode: 'default' });
    s.dispose();
  });

  test('activeModel 优先，effort/permissionMode 透传', () => {
    const { s } = makeSession({ model: 'claude-opus-4-8', effort: 'high', permissionMode: 'plan' });
    assert.deepEqual(s.logMeta(), { model: 'claude-opus-4-8', effort: 'high', permissionMode: 'plan' });
    s.dispose();
  });

  test('无 active/default，回退 reportedModel（修 default 漂移）', () => {
    const { s } = makeSession();
    s.activeModel = undefined; s.defaultModel = undefined; s.reportedModel = 'claude-sonnet-4-6';
    assert.equal(s.logMeta().model, 'claude-sonnet-4-6');
    s.dispose();
  });
});

// ---- send() ----
test.describe('send()', () => {
  test('pendingTurns >= 2 → reject + emit system', async () => {
    const { s, events } = makeSession();
    s.pendingTurns = 2;
    const result = await s.send('hello');
    assert.equal(result, false);
    const sys = events.find(e => e.type === 'system');
    assert.ok(sys);
    assert.ok(sys.payload.message.includes('排队'));
    s.dispose();
  });

  test('正常发送：user_message emit、队列 push、pendingTurns++', async () => {
    const { s, events } = makeSession();
    s.pendingTurns = 0;
    const result = await s.send('hello');
    assert.equal(result, true);
    assert.equal(s.pendingTurns, 1);
    assert.equal(s.queue.length, 1);
    assert.equal(s.queue[0].text, 'hello');

    const um = events.find(e => e.type === 'user_message');
    assert.ok(um);
    assert.equal(um.payload.text, 'hello');
    s.dispose();
  });

  // 排队可见性：user_message.queued 标记「这条发出时前面已有在途轮」（emit 在 pendingTurns++ 之前，≥1 即排队）
  test('queued 字段：空闲首条 false、busy 第二条 true', async () => {
    const { s, events } = makeSession();
    await s.send('first');
    await s.send('second');
    const ums = events.filter(e => e.type === 'user_message');
    assert.equal(ums.length, 2);
    assert.equal(ums[0].payload.queued, false);
    assert.equal(ums[1].payload.queued, true);
    s.dispose();
  });

  test('首条消息 → firstMessage 捕获', async () => {
    const { s } = makeSession();
    assert.equal(s.firstMessage, null);
    await s.send('hello world');
    assert.equal(s.firstMessage, 'hello world');
    s.dispose();
  });

  test('displayText 优先于 text（user_message 气泡用）', async () => {
    const { s, events } = makeSession();
    await s.send('/path/to/file.txt', null, { displayText: 'file.txt' });
    const um = events.find(e => e.type === 'user_message');
    assert.equal(um.payload.text, 'file.txt');
    s.dispose();
  });

  test('model 不变 → 跳过 setModel、activeModel 不变', async () => {
    const { s } = makeSession({ model: 'sonnet' });
    s.q = { setModel: () => { throw new Error('should not call'); } };
    const result = await s.send('hi', null/*空=defaultModel=sonnet=activeModel*/);
    assert.equal(result, true);
    assert.equal(s.activeModel, 'sonnet');
    s.dispose();
  });

  test('model 变化 → 调 setModel + activeModel 更新', async () => {
    const { s } = makeSession({ model: 'sonnet' });
    let setModelCalled = null;
    s.q = { setModel(m) { setModelCalled = m; return Promise.resolve(); } };
    const result = await s.send('hi', 'opus');
    assert.equal(result, true);
    assert.equal(setModelCalled, 'opus');
    assert.equal(s.activeModel, 'opus');
    s.dispose();
  });

  test('setModel 抛错 → 不崩、emit error', async () => {
    const { s, events } = makeSession({ model: 'sonnet' });
    s.q = { setModel() { return Promise.reject(new Error('model not found')); } };
    const result = await s.send('hi', 'unknown-model');
    assert.equal(result, true); // 仍然发送（用原模型）
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('模型切换失败'));
    assert.equal(s.activeModel, 'sonnet'); // 未变
    s.dispose();
  });

  // 回归：q.setModel 和 q.interrupt 走同一条 control_request 通道，限流重试期间同样可能永不回包。
  // 此前只有 interrupt() 有超时保护，setModel 会话起来 send() 直接永久 hang（既不报错也不发出）。
  // 超时后应等同于 setModel 抛错——优雅降级用原模型发送，而不是把整条 send() 一起挂死。
  test('setModel 挂起超时 → 优雅降级用原模型发送（不永久 hang），emit error', async () => {
    const { s, events } = makeSession({ model: 'sonnet' });
    s.interruptTimeoutMs = 20; // 单测加速：与 interrupt 共用同一超时配置
    s.q = { setModel() { return new Promise(() => {}); } }; // 永不 resolve
    const result = await s.send('hi', 'opus');
    assert.equal(result, true, '超时后仍应继续发送，不是整条卡死');
    const err = events.find(e => e.type === 'error');
    assert.ok(err, '应像其它 setModel 失败一样 emit error');
    assert.ok(err.payload.message.includes('模型切换失败'));
    assert.equal(s.activeModel, 'sonnet', '切换未完成，保留原模型');
    s.dispose();
  });

  test('双重检查：setModel await 后 pendingTurns 已达上限 → reject', async () => {
    const { s, events } = makeSession({ model: 'sonnet' });
    // 模拟：await 期间其他 send 把 pendingTurns 推到 2
    let resolveSetModel;
    s.q = { setModel() { return new Promise(r => { resolveSetModel = r; }); } };
    const sendPromise = s.send('hi', 'opus');
    // 此时 send 在 await setModel 中
    s.pendingTurns = 2; // 模拟并发推满
    resolveSetModel();
    const result = await sendPromise;
    assert.equal(result, false);
    const sys = events.find(e => e.type === 'system');
    assert.ok(sys);
    assert.ok(sys.payload.message.includes('排队'));
    // #2：双重检查拒绝路径不应已把 user_message 气泡推上屏（否则用户以为发了、实际被拒）
    assert.equal(events.find(e => e.type === 'user_message'), undefined, '拒绝时不应已 emit user_message');
    s.dispose();
  });

  test('setModel await 后 disposed → return false', async () => {
    const { s, events } = makeSession({ model: 'sonnet' });
    let resolveSetModel;
    s.q = { setModel() { return new Promise(r => { resolveSetModel = r; }); } };
    const sendPromise = s.send('hi', 'opus');
    s.dispose(); // 在 await 期间 dispose
    resolveSetModel();
    const result = await sendPromise;
    assert.equal(result, false);
    // #2：disposed 拒绝路径同样不应已 emit user_message 气泡
    assert.equal(events.find(e => e.type === 'user_message'), undefined, '拒绝时不应已 emit user_message');
  });
});

// ---- interrupt() ----
test.describe('interrupt()', () => {
  test('SDK interrupt 成功 → 队列清空、pendingTurns 调整、emit system(kind:interrupted)', async () => {
    const { s, events } = makeSession();
    s.pendingTurns = 3;
    s.queue.push({ text: 'a' }, { text: 'b' });
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    assert.equal(s.queue.length, 0);
    assert.equal(s.pendingTurns, 1); // 3 - 2 = 1（飞行中的那轮仍在）
    const sys = events.find(e => e.type === 'system' && e.payload.kind === 'interrupted');
    assert.ok(sys);
    assert.equal(sys.payload.message, '已中断');
    s.dispose();
  });

  // AG-004：interrupt 成功后须结算挂起的审批/提问，不依赖 SDK abort signal
  test('interrupt 成功 → pendingPermissions / pendingQuestions 清空（AG-004）', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.askPermission('Bash', { command: 'sleep 9' }, { signal: ac.signal, toolUseID: 't1' });
    s.handleQuestion(
      { questions: [{ question: 'Pick?', options: ['A', 'B'] }] },
      { signal: ac.signal, toolUseID: 'q1' },
    );
    assert.equal(s.pendingPermissions.size, 1);
    assert.equal(s.pendingQuestions.size, 1);
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    assert.equal(s.pendingPermissions.size, 0);
    assert.equal(s.pendingQuestions.size, 0);
    assert.ok(events.some(e => e.type === 'request_resolved' && e.payload.requestId === 't1'));
    assert.ok(events.some(e => e.type === 'request_resolved' && e.payload.requestId === 'q1#0' && e.payload.outcome === 'aborted'));
    s.dispose();
  });

  test('SDK interrupt 抛错且无在途轮 → 队列不动、pendingTurns 不动', async () => {
    const { s, events } = makeSession();
    s.pendingTurns = 0;
    s.queue.push({ text: 'msg' });
    s.q = { interrupt() { return Promise.reject(new Error('no task')); } };
    await s.interrupt();
    assert.equal(s.queue.length, 1); // 未清
    assert.equal(s.pendingTurns, 0); // 未变
    const sys = events.find(e => e.type === 'system' && e.payload.message === '当前没有可中断的任务');
    assert.ok(sys);
    s.dispose();
  });

  // 限流重试等场景：账面有在途轮但 SDK 拒中断 → 强制收口，否则前端 busy/「正在停止」永挂。
  test('SDK interrupt 抛错且 pendingTurns>0 → 强制结算并发 interrupted', async () => {
    const { s, events } = makeSession();
    s.pendingTurns = 1;
    s.queue = [];
    s.q = { interrupt() { return Promise.reject(new Error('no task')); } };
    await s.interrupt();
    assert.equal(s.pendingTurns, 0);
    const sys = events.find(e => e.type === 'system' && e.payload.kind === 'interrupted');
    assert.ok(sys, '应发 interrupted 让前端清 busy');
    s.dispose();
  });

  test('SDK interrupt 超时 → 强制 abort 结算并发 interrupted', async () => {
    const { s, events } = makeSession();
    s.pendingTurns = 1;
    s.interruptTimeoutMs = 20; // 单测加速
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.q = { interrupt() { return new Promise(() => {}); } }; // 永不 resolve
    await s.interrupt();
    assert.equal(s.pendingTurns, 0);
    assert.equal(aborted, true);
    const sys = events.find(e => e.type === 'system' && e.payload.kind === 'interrupted');
    assert.ok(sys);
    s.dispose();
  });

  // P1-4 实证发现：真实 SDK 在 interrupt() 成功后，消息流会紧接着自己吐出一条 result 事件
  // （实测 subtype:'error_during_execution', is_error:true）——这条 result 不是独立的新错误，
  // 而是这次中断的终态确认。但 error_during_execution 是 SDK 里"执行过程中出错"的泛化 subtype
  // （与 error_max_turns/error_max_budget_usd 同级），不能反推"就是用户中断"，故不能靠嗅探 SDK
  // 的 subtype 判断，必须在 interrupt() 内部显式标记"下一条 result 应视为这次中断的终态"。
  test('interrupt() 成功后，紧跟的下一条 result 事件 payload.interrupted=true（一次性消费）', async () => {
    const { s, events } = makeSession();
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    s.map({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 10, modelUsage: {} });
    const r1 = events.find(e => e.type === 'result');
    assert.equal(r1.payload.interrupted, true);

    // 一次性消费：紧接着的下一轮（全新、与本次中断无关）不应再被标记
    s.map({ type: 'result', subtype: 'success', is_error: false, duration_ms: 20, modelUsage: {} });
    const results = events.filter(e => e.type === 'result');
    assert.equal(results[1].payload.interrupted, false, '标记应一次性消费，不应残留到下一轮 result');
    s.dispose();
  });

  test('未调用 interrupt() 的正常 result → payload.interrupted=false（回归）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, modelUsage: {} });
    const r = events.find(e => e.type === 'result');
    assert.equal(r.payload.interrupted, false);
    s.dispose();
  });

  test('SDK interrupt 抛错（无可中断任务）→ 不设置标记，后续 result 不受影响', async () => {
    const { s, events } = makeSession();
    s.q = { interrupt() { return Promise.reject(new Error('no task')); } };
    await s.interrupt();
    s.map({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, modelUsage: {} });
    const r = events.find(e => e.type === 'result');
    assert.equal(r.payload.interrupted, false, '中断失败（无在途任务）不应误标记后续 result');
    s.dispose();
  });

  test('_flushText/_flushThink 在 interrupt 前调用', async () => {
    const { s, events } = makeSession();
    s._textBuf = 'pending text';
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    // 文本已刷新
    const td = events.find(e => e.type === 'text_delta' && e.payload.text === 'pending text');
    assert.ok(td);
    assert.equal(s._textBuf, '');
    s.dispose();
  });

  // 回归：await q.interrupt() 是让出点。原实现在 await 之后才 this.queue=[]，若用户在「点停止后、
  // 中断未完成」时又发一条消息，该消息会 push 进 queue 随后被整体清空（静默丢失）+ pendingTurns
  // 按旧 dropped 少扣。修复后 await 期间新发的消息应保留、不被吞。
  test('竞态：interrupt 的 await 期间新发的消息不被吞、不丢失', async () => {
    const { s } = makeSession();
    s.pendingTurns = 1;                 // 1 个在途轮、无排队（interrupt 发起时 dropped=0）
    let release;
    s.q = { interrupt: () => new Promise(r => { release = r; }) }; // 可控延迟的中断
    const p = s.interrupt();            // 卡在 await q.interrupt()
    await s.send('after-interrupt');    // await 间隙用户又发一条（不切模型→同步入队）
    assert.equal(s.queue.length, 1, '新消息已入队');
    release();                          // 释放中断
    await p;
    assert.equal(s.queue.length, 1, 'await 期间新发的消息不应被 interrupt 清空');
    assert.equal(s.queue[0]?.text, 'after-interrupt', '保留的正是那条新消息');
    s.dispose();
  });
});

test.describe('stopTask()（切片 2b：停单个后台任务，对应终端 Ctrl+X Ctrl+K；不碰主队列/pendingTurns）', () => {
  test('有有效 taskId + q → 调 q.stopTask(taskId)、返回 true', async () => {
    const { s } = makeSession();
    let stopped = null;
    s.q = { stopTask(id) { stopped = id; return Promise.resolve(); } };
    const ok = await s.stopTask('task-42');
    assert.equal(ok, true);
    assert.equal(stopped, 'task-42', '把 taskId 透传给 SDK stopTask');
    s.dispose();
  });

  test('stopTask 不动主队列 / pendingTurns（与 interrupt 停整轮不同）', async () => {
    const { s } = makeSession();
    s.pendingTurns = 2;
    s.queue.push({ text: 'a' });
    s.q = { stopTask() { return Promise.resolve(); } };
    await s.stopTask('task-1');
    assert.equal(s.queue.length, 1, '停单个后台任务不清主队列');
    assert.equal(s.pendingTurns, 2, '不动 pendingTurns');
    s.dispose();
  });

  test('disposed → 不调 SDK、返回 false（不往弃用实例发）', async () => {
    const { s } = makeSession();
    let called = false;
    s.q = { stopTask() { called = true; return Promise.resolve(); } };
    s.dispose();
    const ok = await s.stopTask('task-1');
    assert.equal(ok, false);
    assert.equal(called, false, 'disposed 后不调 SDK stopTask');
  });

  test('taskId 缺失 / 非字符串 → 不调 SDK、返回 false', async () => {
    const { s } = makeSession();
    let called = false;
    s.q = { stopTask() { called = true; return Promise.resolve(); } };
    assert.equal(await s.stopTask(null), false);
    assert.equal(await s.stopTask(''), false);
    assert.equal(await s.stopTask(123), false);
    assert.equal(called, false, '无有效 taskId 不调 SDK');
    s.dispose();
  });

  test('SDK stopTask 抛错（任务不存在/已结束）→ 返回 false、不抛（幂等，重复点停止无害）', async () => {
    const { s } = makeSession();
    s.q = { stopTask() { return Promise.reject(new Error('no such task')); } };
    const ok = await s.stopTask('gone');
    assert.equal(ok, false);
    s.dispose();
  });

  // 回归：q.stopTask 和 q.interrupt 走同一条 control_request 通道，限流重试期间同样可能永不回包。
  // 超时后应等同于既有的"SDK 抛错"分支——返回 false、不抛，而不是让 stopTask() 永久 hang。
  test('SDK stopTask 挂起超时 → 返回 false、不抛（不永久 hang）', async () => {
    const { s } = makeSession();
    s.interruptTimeoutMs = 20; // 单测加速：与 interrupt 共用同一超时配置
    s.q = { stopTask() { return new Promise(() => {}); } }; // 永不 resolve
    const ok = await s.stopTask('task-1');
    assert.equal(ok, false);
    s.dispose();
  });

  test('无 q（实例未 start）→ 返回 false、不抛', async () => {
    const { s } = makeSession();
    s.q = null;
    assert.equal(await s.stopTask('task-1'), false);
    s.dispose();
  });
});

test.describe('fetchUsage()（statusline 5h/7d 数据源：实验性 usage RPC + 超时降级）', () => {
  test('q 有 usage 方法 → 返回其原始结果（解析交给 statusline.usageBitsForStatusLine）', async () => {
    const { s } = makeSession();
    const fake = { subscription_type: 'max', rate_limits_available: true, rate_limits: {} };
    s.q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => fake };
    assert.equal(await s.fetchUsage(), fake);
    s.dispose();
  });

  test('无 q（实例未 start）→ null（不崩）', async () => {
    const { s } = makeSession();
    s.q = null;
    assert.equal(await s.fetchUsage(), null);
    s.dispose();
  });

  test('q 无该方法（旧 CLI / 网关不支持）→ null', async () => {
    const { s } = makeSession();
    s.q = { interrupt: async () => {} };
    assert.equal(await s.fetchUsage(), null);
    s.dispose();
  });

  test('RPC 抛错 → null（降级）', async () => {
    const { s } = makeSession();
    s.q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('rpc fail'); } };
    assert.equal(await s.fetchUsage(), null);
    s.dispose();
  });

  test('RPC 超时 → null（不阻塞，照 statusline getContextUsageSafe 1500ms 模式）', async () => {
    const { s } = makeSession();
    s.q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}) }; // 永不 resolve
    assert.equal(await s.fetchUsage(10), null); // 10ms 超时
    s.dispose();
  });
});

// ---- cancelQueued() / 排队撤回（CLI cancel_async_message 对齐）----
// SDK 泵是贪婪拉取（实证 2026-07-18 探针）：send 的消息几乎立即离开 this.queue 进 CLI 内部队列。
// 撤回主路径 = cancelAsyncMessage(uuid)；this.queue splice 仅覆盖罕见竞态窗（setModel await 间隙等）。
test.describe('cancelQueued() — 排队消息撤回', () => {
  test('排队第二条：queue 项带 clientMessageId/uuid/displayText，cliQueued 登记（首条不登记）', async () => {
    const { s } = makeSession();
    await s.send('first', null, { clientMessageId: 'c1' });
    assert.equal(s.cliQueued, null);
    await s.send('/tmp/x.txt second', null, { clientMessageId: 'c2', displayText: 'second' });
    assert.equal(s.queue.length, 2);
    assert.equal(s.queue[1].clientMessageId, 'c2');
    assert.ok(s.queue[1].uuid, 'queue 项须带 uuid 供 CLI 队列撤回');
    assert.equal(s.queue[1].displayText, 'second');
    assert.equal(s.cliQueued?.clientMessageId, 'c2');
    assert.equal(s.cliQueued?.uuid, s.queue[1].uuid);
    s.dispose();
  });

  test('竞态窗路径：消息仍在 this.queue → splice + pendingTurns-- + 回 displayText + emit queue_cancelled', async () => {
    const { s, events } = makeSession();
    await s.send('first', null, { clientMessageId: 'c1' });
    await s.send('prompt-with-path', null, { clientMessageId: 'c2', displayText: 'raw text' });
    assert.equal(s.pendingTurns, 2);
    const r = await s.cancelQueued('c2');
    assert.deepEqual(r, { ok: true, text: 'raw text' });
    assert.equal(s.queue.length, 1);
    assert.equal(s.pendingTurns, 1);
    assert.equal(s.cliQueued, null);
    const ev = events.find(e => e.type === 'system' && e.payload.kind === 'queue_cancelled');
    assert.ok(ev, '须 emit queue_cancelled 供前端（含 buffer 回放）标记气泡');
    assert.equal(ev.payload.clientMessageId, 'c2');
    s.dispose();
  });

  test('CLI 队列路径：queue 已被泵空 → cancelAsyncMessage(uuid)=true → pendingTurns-- + ok', async () => {
    const { s, events } = makeSession();
    await s.send('first', null, { clientMessageId: 'c1' });
    await s.send('second', null, { clientMessageId: 'c2' });
    const u2 = s.cliQueued.uuid;
    s.queue = []; // 模拟贪婪泵已抽走
    let calledWith = null;
    s.q = { cancelAsyncMessage: async u => { calledWith = u; return true; } };
    const r = await s.cancelQueued('c2');
    assert.equal(calledWith, u2);
    assert.deepEqual(r, { ok: true, text: 'second' });
    assert.equal(s.pendingTurns, 1);
    assert.equal(s.cliQueued, null);
    assert.ok(events.find(e => e.type === 'system' && e.payload.kind === 'queue_cancelled'));
    s.dispose();
  });

  test('CLI 队列路径：cancelled=false（已开始执行）→ ok:false、账目不动、cliQueued 放回', async () => {
    const { s } = makeSession();
    await s.send('first', null, { clientMessageId: 'c1' });
    await s.send('second', null, { clientMessageId: 'c2' });
    s.queue = [];
    s.q = { cancelAsyncMessage: async () => false };
    const r = await s.cancelQueued('c2');
    assert.equal(r.ok, false);
    assert.equal(s.pendingTurns, 2);
    assert.equal(s.cliQueued?.clientMessageId, 'c2');
    s.dispose();
  });

  // 回归：q.cancelAsyncMessage 和 q.interrupt 走同一条 control_request 通道，限流重试期间同样可能
  // 永不回包。超时后应等同于既有的"控制请求失败视同撤回失败"分支——ok:false、不永久 hang（撤回按钮
  // 此前会因为这里挂起而永远转不出结果）。
  test('CLI 队列路径：cancelAsyncMessage 挂起超时 → ok:false（不永久 hang）', async () => {
    const { s } = makeSession();
    s.interruptTimeoutMs = 20; // 单测加速：与 interrupt 共用同一超时配置
    await s.send('first', null, { clientMessageId: 'c1' });
    await s.send('second', null, { clientMessageId: 'c2' });
    s.queue = [];
    s.q = { cancelAsyncMessage: () => new Promise(() => {}) }; // 永不 resolve
    const r = await s.cancelQueued('c2');
    assert.equal(r.ok, false);
    s.dispose();
  });

  test('未命中（无此 id / 已处理）→ ok:false 账目不动', async () => {
    const { s } = makeSession();
    await s.send('first', null, { clientMessageId: 'c1' });
    const r = await s.cancelQueued('nope');
    assert.equal(r.ok, false);
    assert.equal(s.pendingTurns, 1);
    s.dispose();
  });

  test('result 到达 → cliQueued 清（排队条要么已开跑要么已结清，不再可撤）', async () => {
    const { s } = makeSession();
    await s.send('first', null, { clientMessageId: 'c1' });
    await s.send('second', null, { clientMessageId: 'c2' });
    s.map({ type: 'result', subtype: 'success', duration_ms: 10, modelUsage: {} });
    assert.equal(s.cliQueued, null);
    assert.equal(s.pendingTurns, 1);
    s.dispose();
  });
});

// ---- interrupt() 对 CLI 队列排队条的结算（幽灵 busy 修复）----
// 实证（探针场景2）：CLI interrupt 会丢弃其内部队列的排队消息且不产生 result——若不补扣
// pendingTurns 会泄漏 1（停止后 busy 卡到 idle 看护兜底）。
test.describe('interrupt() — CLI 队列排队条结算', () => {
  test('queue 已泵空 + cliQueued 存在 → 补扣 1 + queue_dropped(clientMessageIds) + cliQueued 清', async () => {
    const { s, events } = makeSession();
    await s.send('first', null, { clientMessageId: 'c1' });
    await s.send('second', null, { clientMessageId: 'c2' });
    s.queue = []; // 贪婪泵已抽走
    s.q = { interrupt: async () => {} };
    await s.interrupt();
    assert.equal(s.pendingTurns, 1, '在途轮的 1 留给 result 扣，排队条的 1 此处补扣');
    assert.equal(s.cliQueued, null);
    const ev = events.find(e => e.type === 'system' && e.payload.kind === 'queue_dropped');
    assert.ok(ev);
    assert.deepEqual(ev.payload.clientMessageIds, ['c2']);
    s.dispose();
  });

  test('竞态窗：排队条仍在 this.queue（toDrop 卷走）→ 不双扣，queue_dropped 仍含其 id', async () => {
    const { s, events } = makeSession();
    await s.send('first', null, { clientMessageId: 'c1' });
    await s.send('second', null, { clientMessageId: 'c2' });
    s.queue.shift(); // 只模拟首条被泵走，第二条仍在本地队列
    s.q = { interrupt: async () => {} };
    await s.interrupt();
    assert.equal(s.pendingTurns, 1, 'toDrop=1 扣一次，不得再按 cliQueued 双扣');
    assert.equal(s.cliQueued, null);
    const ev = events.find(e => e.type === 'system' && e.payload.kind === 'queue_dropped');
    assert.ok(ev);
    assert.deepEqual(ev.payload.clientMessageIds, ['c2']);
    s.dispose();
  });

  test('无排队条 → 不发 queue_dropped、账目照旧', async () => {
    const { s, events } = makeSession();
    await s.send('only', null, { clientMessageId: 'c1' });
    s.queue = [];
    s.q = { interrupt: async () => {} };
    await s.interrupt();
    assert.equal(s.pendingTurns, 1);
    assert.equal(events.find(e => e.type === 'system' && e.payload.kind === 'queue_dropped'), undefined);
    s.dispose();
  });

  // 回归：interrupt() 在 await q.interrupt() 之前同步快照 cliDropped，此前不「摘牌」——
  // await 期间若 cancelQueued() 并发命中同一条 cliQueued 消息并各自成功，两边都会对它扣一次
  // pendingTurns，制造假性空闲窗口（真正的主轮 result 还没到）。修复：interrupt() 摘牌与
  // cancelQueued() 对称，谁的同步前缀先跑谁摘牌，另一方发现槽位已空则不再重复处理/扣减。
  test('竞态：interrupt() 与 cancelQueued() 并发命中同一条 cliQueued → 不双扣 pendingTurns', async () => {
    const { s } = makeSession();
    await s.send('first', null, { clientMessageId: 'c1' });   // pendingTurns=1，主轮在途
    await s.send('second', null, { clientMessageId: 'c2' });  // pendingTurns=2，c2 登记进 cliQueued
    s.queue = []; // 模拟贪婪泵已把两条都抽离本地队列
    assert.equal(s.pendingTurns, 2);
    assert.equal(s.cliQueued?.clientMessageId, 'c2');

    let releaseInterrupt;
    // 注意：interrupt() 摘牌先于 cancelQueued 的同步前缀，故 cancelQueued 会在 cliQueued 已空时
    // 短路返回，根本不会走到 q.cancelAsyncMessage——此处无需为它提供可控 Promise。
    s.q = { interrupt: () => new Promise(r => { releaseInterrupt = r; }) };

    const pInterrupt = s.interrupt();   // 同步前缀先跑：摘牌 cliQueued、卡在 await q.interrupt()
    const pCancel = s.cancelQueued('c2'); // 槽位已被摘空，应直接 {ok:false}，不再碰 q.cancelAsyncMessage

    const cancelResult = await pCancel;
    assert.equal(cancelResult.ok, false, 'interrupt 已摘牌，cancelQueued 不应再对同一条消息生效');
    assert.equal(s.pendingTurns, 2, 'cancelQueued 落空，账目不动');

    releaseInterrupt();
    await pInterrupt;
    assert.equal(s.pendingTurns, 1, '主轮真正的 result 还没到，中间态应是 1（不能被双扣到 0）');
    s.dispose();
  });

  test('竞态（反序）：cancelQueued() 先摘牌 → interrupt() 不应对同一条 cliQueued 重复扣减', async () => {
    const { s } = makeSession();
    await s.send('first', null, { clientMessageId: 'c1' });
    await s.send('second', null, { clientMessageId: 'c2' });
    s.queue = [];
    assert.equal(s.pendingTurns, 2);

    let releaseInterrupt, releaseCancel;
    s.q = {
      interrupt: () => new Promise(r => { releaseInterrupt = r; }),
      cancelAsyncMessage: () => new Promise(r => { releaseCancel = r; }),
    };

    const pCancel = s.cancelQueued('c2'); // 同步前缀先摘牌，卡在 await cancelAsyncMessage
    const pInterrupt = s.interrupt();     // 发现 cliQueued 已空（cancelQueued 已摘牌），cliDropped 应为 null

    releaseCancel(true); // 撤回先落地
    const cancelResult = await pCancel;
    assert.equal(cancelResult.ok, true);
    assert.equal(s.pendingTurns, 1, 'c2 被 cancelQueued 扣掉后，只剩主轮的 1');

    releaseInterrupt(); // 主轮也被中断（成功中断不直接清主轮的 1，留给之后的 result 事件配平）
    await pInterrupt;
    assert.equal(s.pendingTurns, 1, 'interrupt 不应对已被 cancelQueued 摘走的 c2 重复扣减，仍是主轮的 1');
    s.dispose();
  });
});
