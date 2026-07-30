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
  // 排队已移除（2026-07-30）：在途轮期间不再接受新消息，闸门从「封顶 2」收紧到「有轮就拒」。
  test('pendingTurns >= 1 → reject + emit system', async () => {
    const { s, events } = makeSession();
    s.pendingTurns = 1;
    const result = await s.send('hello');
    assert.equal(result, false);
    const sys = events.find(e => e.type === 'system');
    assert.ok(sys);
    assert.ok(sys.payload.message.includes('运行中'));
    s.dispose();
  });

  // 被拒时不得留下任何副作用：气泡已上屏但消息没进 SDK = 用户以为发了、实际石沉大海。
  test('在途轮期间被拒 → 不 emit user_message、不入 queue、不动在途轮账目', async () => {
    const { s, events } = makeSession();
    await s.send('first');
    const queueLenAfterFirst = s.queue.length;
    events.length = 0;

    const result = await s.send('second');
    assert.equal(result, false);
    assert.equal(events.filter(e => e.type === 'user_message').length, 0, '被拒的消息不该有气泡');
    assert.equal(s.queue.length, queueLenAfterFirst, '被拒的消息不该进输入泵队列');
    assert.equal(s.pendingTurns, 1, '被拒不该改动在途轮记账');
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

  // 排队移除后 user_message 不再带 queued 字段（前端已无排队气泡态可渲染）
  test('user_message 不再带 queued 字段', async () => {
    const { s, events } = makeSession();
    await s.send('first');
    const um = events.find(e => e.type === 'user_message');
    assert.ok(um);
    assert.equal('queued' in um.payload, false);
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

  // F1 回归：FRESH 会话不 pin 模型（server 端 startModel=undefined，让 CLI 按原生优先级自行解析），
  // 用户又没选模型时前端发 model:null → target 为空。此时绝不能下发 setModel(undefined)——
  // CLI 会把网关模型重置成裸默认（实测：init 从 mimo 变成 opus 并报错，见 agent.js F1 注释）。
  test('target 为空（FRESH 空发）→ 绝不调 setModel', async () => {
    const { s } = makeSession(); // model 缺省 → defaultModel/activeModel 均为 undefined
    let setModelCalls = 0;
    s.q = { setModel() { setModelCalls++; return Promise.resolve(); } };
    const result = await s.send('hi', null);
    assert.equal(result, true);
    assert.equal(setModelCalls, 0, 'FRESH 空发不得下发 setModel(undefined) 重置网关模型');
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

  test('setModel 抛错 → 不崩、emit error、activeModel 不谎报', async () => {
    const { s, events } = makeSession({ model: 'sonnet' });
    s.q = { setModel() { return Promise.reject(new Error('model not found')); } };
    const result = await s.send('hi', 'unknown-model');
    assert.equal(result, true); // 仍然发送（用原模型）
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('模型切换失败'), '明确 reject=确定没切，文案说"失败"');
    assert.equal(s.activeModel, 'sonnet', '切换没成功 → activeModel 不推进（前端显示的是真生效模型）');
    assert.equal(s.attemptedModel, 'unknown-model', '已尝试过 → 差分基准推进，同一目标不再重试');
    s.dispose();
  });

  // 回归：q.setModel 和 q.interrupt 走同一条 control_request 通道，限流重试期间同样可能永不回包。
  // 此前只有 interrupt() 有超时保护，setModel 会话起来 send() 直接永久 hang（既不报错也不发出）。
  // 超时后应等同于 setModel 抛错——优雅降级继续发送，而不是把整条 send() 一起挂死。
  test('setModel 挂起超时 → 优雅降级继续发送，activeModel 不谎报', async () => {
    const { s, events } = makeSession({ model: 'sonnet' });
    s.interruptTimeoutMs = 20; // 单测加速：与 interrupt 共用同一超时配置
    s.q = { setModel() { return new Promise(() => {}); } }; // 永不 resolve
    const result = await s.send('hi', 'opus');
    assert.equal(result, true, '超时后仍应继续发送，不是整条卡死');
    const err = events.find(e => e.type === 'error');
    assert.ok(err, '应像其它 setModel 失败一样 emit error');
    assert.ok(err.payload.message.includes('模型切换未确认'), '超时=可能切了也可能没切，文案说"未确认"');
    assert.equal(s.activeModel, 'sonnet', '未确认生效 → 不推进 activeModel');
    s.dispose();
  });

  // 真机 2026-07-30：set_model 恒超时的第三方网关下，若失败后不推进差分基准，
  // 每条消息都会重下发一次 setModel → 每轮白等 interruptTimeoutMs(10s) 并重复弹错。
  test('setModel 失败后同一目标不再重试（防每轮白等超时）', async () => {
    const { s, events } = makeSession({ model: 'sonnet' });
    s.interruptTimeoutMs = 20;
    let setModelCalls = 0;
    s.q = { setModel() { setModelCalls++; return new Promise(() => {}); } }; // 永不 resolve
    await s.send('hi', 'opus');
    assert.equal(setModelCalls, 1, '第一次 send 尝试下发');
    s.pendingTurns = 0; // 排队已移除：须先结算上一轮才收得下第二条
    await s.send('hi again', 'opus');
    assert.equal(setModelCalls, 1, '同一目标已尝试过 → 不再重复下发');
    assert.equal(events.filter(e => e.type === 'error').length, 1, '错误只提示一次，不每轮刷屏');
    s.dispose();
  });

  test('setModel 失败后切到别的模型 → 允许重新尝试', async () => {
    const { s } = makeSession({ model: 'sonnet' });
    const calls = [];
    s.q = { setModel(m) { calls.push(m); return Promise.reject(new Error('model not found')); } };
    await s.send('hi', 'bad-model');
    s.pendingTurns = 0; // 排队已移除：须先结算上一轮才收得下第二条
    await s.send('hi again', 'other-model');
    assert.deepEqual(calls, ['bad-model', 'other-model'], '目标变了就该重新下发，不因上次失败被永久锁死');
    s.dispose();
  });

  test('双重检查：setModel await 后已有在途轮 → reject', async () => {
    const { s, events } = makeSession({ model: 'sonnet' });
    // 模拟：await 期间其他 send 已开了一轮（setModel 是让出点，这道二次检查仍必要）
    let resolveSetModel;
    s.q = { setModel() { return new Promise(r => { resolveSetModel = r; }); } };
    const sendPromise = s.send('hi', 'opus');
    // 此时 send 在 await setModel 中
    s.pendingTurns = 1; // 模拟并发开轮
    resolveSetModel();
    const result = await sendPromise;
    assert.equal(result, false);
    const sys = events.find(e => e.type === 'system');
    assert.ok(sys);
    assert.ok(sys.payload.message.includes('运行中'));
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
  // 排队移除后 this.queue 最多 1 条（send 完成到 SDK 输入泵取走之间的窄竞态窗），
  // 它仍是「已记账但未送达 SDK」，停止时必须丢弃并配平。
  test('SDK interrupt 成功 → 队列清空、pendingTurns 调整、emit system(kind:interrupted)', async () => {
    const { s, events } = makeSession();
    s.pendingTurns = 1;
    s.queue.push({ text: 'a' });
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    assert.equal(s.queue.length, 0);
    assert.equal(s.pendingTurns, 0); // 1 - 1 = 0（唯一那条尚未送达 SDK，随停止丢弃）
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

  // 2026-07-26 现场：web 发 /clear 后账面 pendingTurns 卡在 1，用户点停止 → q.interrupt() 正常
  // resolve（diag: outcome=success / droppedCount=0 / pendingTurnsAfter=1），但 SDK 侧那一轮早在
  // 10 分钟前就结束了、不会再产生配对 result → busy 永挂 30min，只能靠 idleTimeoutMs(10min) 兜底，
  // 而用户每次切进该 tab 都会刷新 lastActivity 给它续命，实际等于无解。
  // 不对称之处：interrupt 抛错/超时的 catch 分支反有 settleForce() 强制清零 —— 成功路径比失败路径
  // 更容易卡死。这里给成功路径补一层结算兜底。
  test('interrupt 成功但配对 result 不到 → 结算兜底清账（且不 abort 子进程）', async () => {
    const { s, events } = makeSession();
    s.pendingTurns = 1;
    s.interruptSettleGraceMs = 20; // 单测加速
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    assert.equal(s.pendingTurns, 1, '成功路径当下不减：先等 SDK 的终态 result');
    assert.equal(s._awaitingInterruptResult, true);

    await new Promise(r => setTimeout(r, 60));
    assert.equal(s.pendingTurns, 0, '兜底到期须清账，否则 busy 永挂');
    assert.equal(s._awaitingInterruptResult, false, '已放弃等待，标记不留悬挂');
    assert.equal(s.terminating, false, '兜底不杀子进程：SDK 本就空闲，abort 会把可用会话变成「已中断」');
    // 只发一次 interrupted（成功路径已发过），兜底不重复刷系统条
    assert.equal(events.filter(e => e.type === 'system' && e.payload.kind === 'interrupted').length, 1);
    s.dispose();
  });

  test('interrupt 成功后 result 按时到达 → 兜底撤销，不二次扣账', async () => {
    const { s } = makeSession();
    s.pendingTurns = 1;
    s.interruptSettleGraceMs = 20;
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    s.map({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, modelUsage: {} });
    assert.equal(s.pendingTurns, 0, 'result 正常结算');

    s.pendingTurns = 1; // 模拟兜底撤销后又开了新一轮：悬挂 timer 若未清会把它误清
    await new Promise(r => setTimeout(r, 60));
    assert.equal(s.pendingTurns, 1, 'result 到达即撤销兜底，不得再动后续轮次的账');
    s.dispose();
  });

  test('interrupt 成功且账面已空 → 不武装兜底（无账可清）', async () => {
    const { s } = makeSession();
    s.pendingTurns = 0;
    s.interruptSettleGraceMs = 20;
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    assert.equal(s._interruptSettleTimer, null, '没有在途轮就不该起兜底计时');
    s.dispose();
  });

  test('dispose 清掉悬挂的结算兜底计时（不留跨实例定时器）', async () => {
    const { s } = makeSession();
    s.pendingTurns = 1;
    s.interruptSettleGraceMs = 20;
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    assert.notEqual(s._interruptSettleTimer, null);
    s.dispose();
    assert.equal(s._interruptSettleTimer, null);
  });

  // 回归：watchdog force 清账后用户又发一轮，迟到的旧 result 不得把新轮 pendingTurns 扣成 0（假 idle）。
  // 场景要模拟「消息已泵出 this.queue 进 CLI」：queue 空、pendingTurns=1、openTurns 有槽；
  // 若消息仍在 queue，interrupt 会当排队丢弃并 _dropOpenTurnSlots，不会武装 watchdog。
  test('watchdog force 清账后新发一轮 + 迟到旧 result → 新轮 pendingTurns 仍为 1', async () => {
    const { s } = makeSession();
    s.interruptSettleGraceMs = 20;
    s.q = { interrupt() { return Promise.resolve(); }, setModel() { return Promise.resolve(); } };
    assert.equal(await s.send('old'), true);
    assert.equal(s.pendingTurns, 1);
    assert.equal(s._openTurns.length, 1);
    s.queue = []; // 已泵进 CLI：中断收口靠配对 result / watchdog，而非 queue 丢弃
    await s.interrupt();
    assert.equal(s._awaitingInterruptResult, true);
    assert.equal(s.pendingTurns, 1, '成功路径当下不减：先等 SDK 的终态 result');
    await new Promise(r => setTimeout(r, 60));
    assert.equal(s.pendingTurns, 0, 'watchdog 已 force 清账');
    assert.equal(s._openTurns.length, 1, 'force 槽仍在，等迟到 result 出槽');
    assert.equal(s._openTurns[0].forceSettled, true);

    assert.equal(await s.send('new after force'), true);
    assert.equal(s.pendingTurns, 1, '新轮在途');
    assert.equal(s._openTurns.length, 2);

    // 迟到的中断轮 result：只消耗 force 槽，不得 -- 新轮
    s.map({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, modelUsage: {} });
    assert.equal(s.pendingTurns, 1, '迟到 result 不得把新轮扣成假 idle');
    assert.equal(s._openTurns.length, 1);
    assert.equal(s._openTurns[0].forceSettled, false);

    // 新轮真正结束
    s.map({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, modelUsage: {} });
    assert.equal(s.pendingTurns, 0);
    assert.equal(s._openTurns.length, 0);
    s.dispose();
  });

  // 回归（上一条的对偶）：watchdog 的触发【前提】就是「配对 result 永不到达」（见 _armInterruptSettleWatchdog
  // 注释：q.interrupt() 照样 resolve，却永不产生配对 result）。这种情况下只标记不移除的 force 槽会永久堵在
  // 队首，把此后每一轮真 result 都吸收成 applied:false → pendingTurns 再也回不到 0：
  // stateOf 恒 busy（spinner/停止按钮不消失）、queued 恒 true（每条新消息标排队）、queueFull 恒真（发送禁用）。
  // 且每次 10min 静默看门狗又 interrupt 一次、再造一个 force 槽 —— 自我复现不自愈。
  test('watchdog force 清账后迟到 result 永不到达 → 过期 force 槽不得吃掉后续真 result', async () => {
    const { s } = makeSession();
    s.interruptSettleGraceMs = 20;
    s.forceSlotTtlMs = 30; // 单测加速；生产默认宽于任何真实 SDK 迟到
    s.q = { interrupt() { return Promise.resolve(); }, setModel() { return Promise.resolve(); } };
    assert.equal(await s.send('old'), true);
    s.queue = [];
    await s.interrupt();
    await new Promise(r => setTimeout(r, 60));
    assert.equal(s.pendingTurns, 0, 'watchdog 已 force 清账');
    assert.equal(s._openTurns.length, 1, 'force 槽留下等迟到 result');

    // 迟到 result 始终没来，等过 TTL：这个槽已经不可能再被消耗
    await new Promise(r => setTimeout(r, 40));

    assert.equal(await s.send('turn A'), true);
    assert.equal(s.pendingTurns, 1);
    s.map({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, modelUsage: {} });
    assert.equal(s.pendingTurns, 0, '过期 force 槽必须被回收，真 result 要能把账减到 0');
    assert.equal(s.isBusy(), false, '否则 stateOf 恒 busy：spinner 与停止按钮永不消失');

    // 再来一轮，确认稳态不残留
    assert.equal(await s.send('turn B'), true);
    assert.equal(s.pendingTurns, 1);
    s.map({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, modelUsage: {} });
    assert.equal(s.pendingTurns, 0, '稳态不得卡在 1');
    assert.equal(s._openTurns.length, 0);
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
  // 排队移除后这个竞态窗被闸门堵死：interrupt 尚未结算前 pendingTurns 仍 >0，此时 send 直接被拒。
  // 断言的价值在于「拒得干净」——不能出现「进了 queue 又被本次 interrupt 卷走」的静默丢字。
  test('竞态：interrupt 的 await 期间发消息 → 被拒且不入队（不静默丢字）', async () => {
    const { s } = makeSession();
    s.pendingTurns = 1;                 // 1 个在途轮（interrupt 发起时 dropped=0）
    let release;
    s.q = { interrupt: () => new Promise(r => { release = r; }) }; // 可控延迟的中断
    const p = s.interrupt();            // 卡在 await q.interrupt()
    const sent = await s.send('after-interrupt'); // await 间隙用户又发一条
    assert.equal(sent, false, '在途轮未结算前不收新消息');
    assert.equal(s.queue.length, 0, '被拒的消息不入队，也就无从被 interrupt 卷走');
    release();                          // 释放中断
    await p;
    assert.equal(s.queue.length, 0);
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
    s.pendingTurns = 1;
    s.queue.push({ text: 'a' });
    s.q = { stopTask() { return Promise.resolve(); } };
    await s.stopTask('task-1');
    assert.equal(s.queue.length, 1, '停单个后台任务不清主队列');
    assert.equal(s.pendingTurns, 1, '不动 pendingTurns');
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
