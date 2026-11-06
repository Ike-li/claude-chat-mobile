// tests/invariants/message-queue.test.mjs —— 排队消息的状态机：什么时候发、什么时候不发、怎么不丢
// 守护：MSG-03（排队消息只在回合正常结束后发出；任何一道闸不过都不得发，也不得丢）/ MSG-01（同一条至多发一次）/ SESSION-01（释放时终端在驾驶不得发）/ SRV-003（释放不得置换）/ SESSION-04（分叉时不得静默发）
// 测什么：队列接真发送闸（createSendGate 的无人值守模式），断言落在「发了几次」和快照上：
//   ① 回合结束后等 CLI 报 idle，汇报轮期间消息留在服务端 ② 汇报轮出错或被停时不发 ③ CLI 一直不报 idle 时兜底
//   ④ 闸门不过转 held，取得回 ⑤ 第 6 节竞态表：撤回、停止与释放的先后
// 不测什么 + 为什么：① result 帧里的事实怎么取出来归 agent-queued-next.test.mjs ② socket、ack 键集、真假 CLI 帧序
//   属 S2，见 tests/invariants/server/message-queue.test.mjs ③ 卡片和本地副本属前端
// 槽位：S1（编排，定时器注入）
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageQueue } from '../../app/src/server/message-queue.js';
import { createSendGate } from '../../app/src/server/send-gate.js';
import { terminalStateKey } from '../../app/src/sessions/session-registry.js';

const SID = '6f0c2a55-1b7e-4a4e-9d0f-0a1b2c3d4e5f';
const CWD = '/Users/you/code/app';
const OK = { isError: false, interrupted: false, approvalExpired: false, terminalReason: 'completed' };
const DIVERGENCE = Object.freeze({
  newestUuid: 'a-2', newestEntrypoint: 'sdk-ts', newestAt: '2026-09-03T12:34:01.953Z',
  droppedCount: 2, anchorEntrypoint: 'cli', anchorAt: '2026-09-03T12:26:43.779Z',
});

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function makeInstance(over = {}) {
  const inst = {
    instanceId: 'inst-1', sessionId: SID, cwd: CWD, authorizedRoot: CWD, permissionMode: 'default',
    pendingTurns: 1, externalDirty: false, resumeDivergence: null, resumeDivergencePending: null,
    bgTasks: new Map(), pendingPermissions: new Map(), pendingQuestions: new Map(), pendingElicitations: new Map(),
    sent: [], notices: [], swapped: 0,
    isBusy() { return this.pendingTurns > 0 || this.bgTasks.size > 0; },
    logKey() { return this.sessionId; },
    async send(text, model, { shouldSend, ...opts } = {}) {
      if (shouldSend && !shouldSend()) return false;
      this.sent.push({ text, model, opts });
      this.pendingTurns += 1;
      return true;
    },
    emitNotice(text, level) { this.notices.push({ text, level }); },
  };
  return Object.assign(inst, over);
}

// 卡在切模型上的实例：真 send 在 setModel 的 await 之后才判断、才入队
function slowSendInstance() {
  const gate = { release: null };
  const a = makeInstance({
    async send(text, model, { shouldSend } = {}) {
      await new Promise((r) => { gate.release = r; });
      if (shouldSend && !shouldSend()) return false;
      this.sent.push({ text });
      return true;
    },
  });
  return { a, gate };
}

function setup({ instance = makeInstance(), gateOver = {} } = {}) {
  const ctx = {
    a: instance, live: new Map([[SID, instance]]), timers: new Map(), seq: 0, changes: 0, t: 1000,
    viewing: 'inst-1', readonly: false, states: new Map(), location: async () => ({ status: 'found' }), commits: [],
  };
  const gate = createSendGate({
    recoverLocation: () => ctx.location(),
    disposeForSwap: () => { ctx.a.swapped += 1; },
    resume: async () => { throw new Error('无人值守路径不得置换'); },
    effortOf: () => null,
    effortSourceOf: () => null,
    getViewingInstanceId: () => ctx.viewing,
    claimViewing: () => {},
    reselectViewingAfter: () => {},
    broadcastInstances: () => {},
    listTerminalStates: async () => ctx.states,
    mirrorEngine: { isReadonly: () => ctx.readonly, takeOver: () => {} },
    saveAttachments: async () => [],
    commitProcessed: id => { ctx.commits.push(id); },
    onManualSend: () => {},
    noteLiveTerminalOnTakeover: () => {},
    takeWritesLost: () => null,
    interactionLog: { addSessionLog: () => {}, userMessageIn: () => {} },
    diagLog: { record: () => {} },
    ...gateOver,
  });
  ctx.q = createMessageQueue({
    sendGate: gate,
    getLiveInstance: sid => ctx.live.get(sid) ?? null,
    now: () => ctx.t,
    setTimeoutFn: (fn, ms) => { const id = ++ctx.seq; ctx.timers.set(id, { fn, ms }); return id; },
    clearTimeoutFn: id => { ctx.timers.delete(id); },
    onChange: () => { ctx.changes += 1; },
  });
  ctx.accept = (over = {}) => ctx.q.accept({ instance: ctx.a, clientMessageId: 'c1', text: '接下来跑测试', model: 'opus', attachments: undefined, ...over });
  // 回合结束：账面先归零再回调，与 agent.js 的次序相同
  ctx.endTurn = (facts = OK) => { ctx.a.pendingTurns = 0; return ctx.q.onTurnEnded(ctx.a, facts); };
  ctx.fireTimers = async () => {
    const pending = [...ctx.timers.values()];
    ctx.timers.clear();
    for (const t of pending) t.fn();
    await flush();
  };
  ctx.state = () => ctx.q.snapshot()[0]?.state ?? null;
  ctx.reason = () => ctx.q.snapshot()[0]?.reason ?? null;
  return ctx;
}

// ── 接收 ──

test('收下：快照只带预览，不带全文和附件数据（这条广播有近三十个触发点）', () => {
  const ctx = setup();
  const text = '长'.repeat(500);
  const r = ctx.accept({ text, attachments: [{ name: 'a.png', mimeType: 'image/png', data: 'BASE64' }] });
  assert.deepEqual(r, { ok: true });
  const [card] = ctx.q.snapshot();
  assert.equal(card.state, 'waiting');
  assert.equal(card.preview.length, 140);
  assert.equal(card.textLength, 500);
  assert.deepEqual(card.attachments, [{ name: 'a.png', mimeType: 'image/png' }]);
  assert.equal(card.sessionId, SID);
  assert.equal(card.instanceId, 'inst-1');
  assert.equal(card.clientMessageId, 'c1');
  assert.equal(card.reason, null);
  assert.equal(card.acceptedAt, 1000);
  assert.equal(card.heldAt, null);
  assert.ok(!JSON.stringify(card).includes('BASE64'));
  assert.equal(ctx.changes > 0, true, '收下要广播，别的设备靠它看到卡片');
});

test('还没有 sessionId 不收：实例死在拿到 id 之前时，条目就没有归属了', () => {
  const ctx = setup({ instance: makeInstance({ sessionId: null }) });
  const r = ctx.accept();
  assert.equal(r.ok, false);
  assert.equal(r.ack.ok, false);
  assert.equal(r.ack.busy, true);
  assert.equal(r.ack.retryable, false);
  assert.deepEqual(ctx.q.snapshot(), []);
});

test('每会话 1 条，未发送的也占这个位置（机主决定 ④）', () => {
  const ctx = setup();
  ctx.accept();
  const waiting = ctx.accept({ clientMessageId: 'c2' });
  assert.equal(waiting.ok, false);
  assert.equal(waiting.ack.queueFull, true);
  assert.equal(waiting.ack.busy, true);
  assert.equal(waiting.ack.retryable, false);
  ctx.q.hold(SID, 'stopped');
  assert.equal(ctx.accept({ clientMessageId: 'c3' }).ack.queueFull, true, 'held 也占位，否则同一会话堆出多条等决定的消息');
});

test('总条数有上限：防止常驻进程里无限累积', () => {
  const ctx = setup();
  for (let i = 0; i < 20; i++) {
    const a = makeInstance({ sessionId: `s-${i}`, instanceId: `i-${i}` });
    assert.equal(ctx.q.accept({ instance: a, clientMessageId: `c-${i}`, text: 'x' }).ok, true);
  }
  const r = ctx.accept();
  assert.equal(r.ok, false);
  assert.equal(r.ack.busy, true);
  assert.equal(r.ack.queueFull, undefined, '满的是全局，不是这个会话');
});

test('hasMessage：同 ID 重发时靠它在 ack 里补 queued', () => {
  const ctx = setup();
  ctx.accept();
  assert.equal(ctx.q.hasMessage('c1'), true);
  assert.equal(ctx.q.hasMessage('别的'), false);
});

// ── 释放时机 ──

test('正常结束：先等 CLI 报 idle，报了才发，只发一次，发完条目消失', async () => {
  const ctx = setup();
  ctx.accept();
  assert.equal(ctx.endTurn(), 'release', '这个返回值决定 result 带不带 queuedNext');
  await flush();
  assert.deepEqual(ctx.a.sent, [], 'CLI 可能紧接着起汇报轮，result 时立刻发会把消息交进 CLI 队列');
  assert.equal(ctx.state(), 'waiting', '等 idle 这一小段对外还是排队中');
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.deepEqual(ctx.a.sent, [{ text: '接下来跑测试', model: 'opus', opts: { clientMessageId: 'c1' } }]);
  assert.deepEqual(ctx.q.snapshot(), []);
  assert.equal(ctx.timers.size, 0, '发完不留定时器');
});

test('汇报轮：result 之后 CLI 又起一轮 → 消息留在服务端，到点也不发，汇报轮结束才发', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.endTurn();
  ctx.q.onTurnStarted(ctx.a);
  assert.equal(ctx.timers.size, 0, '汇报轮多长都有可能，不能用定时器等它');
  await ctx.fireTimers();
  assert.deepEqual(ctx.a.sent, []);
  ctx.a.pendingTurns = 1;
  assert.equal(ctx.endTurn(), 'release');
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.a.sent.length, 1);
});

test('汇报轮出错 → 未发送，不发', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.endTurn();
  ctx.q.onTurnStarted(ctx.a);
  assert.equal(ctx.endTurn({ ...OK, isError: true, terminalReason: 'api_error' }), 'hold');
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.deepEqual(ctx.a.sent, []);
  assert.equal(ctx.state(), 'held');
  assert.equal(ctx.reason(), 'turn_error');
});

test('CLI 一直不报 idle（后台子 agent 占着、旧 CLI 没有这个帧）→ 1.5 秒兜底发，不能被卡住', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.endTurn();
  assert.deepEqual([...ctx.timers.values()].map(t => t.ms), [1500]);
  await ctx.fireTimers();
  assert.equal(ctx.a.sent.length, 1);
  assert.deepEqual(ctx.q.snapshot(), []);
});

test('idle 和定时器都到了也只发一次', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.endTurn();
  const pending = [...ctx.timers.values()];
  ctx.q.onCliIdle(ctx.a);
  ctx.q.onCliIdle(ctx.a);
  for (const t of pending) t.fn();
  await flush();
  assert.equal(ctx.a.sent.length, 1);
});

test('在途轮中的 idle 不算（账面还有轮在跑）', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.deepEqual(ctx.a.sent, []);
  assert.equal(ctx.state(), 'waiting');
});

test('waiting 且账面已空时的 idle 要放行：init 不是汇报轮时不能卡死', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.endTurn();
  ctx.q.onTurnStarted(ctx.a);
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.a.sent.length, 1);
});

test('别的会话的回合结束、idle 不影响这一条', async () => {
  const ctx = setup();
  ctx.accept();
  const other = makeInstance({ sessionId: 's-other', instanceId: 'i-other', pendingTurns: 0 });
  assert.equal(ctx.q.onTurnEnded(other, OK), undefined);
  ctx.q.onCliIdle(other);
  await flush();
  assert.deepEqual(ctx.a.sent, []);
});

test('没有排队消息时回合结束返回 undefined：result 不带 queuedNext', () => {
  const ctx = setup();
  assert.equal(ctx.endTurn(), undefined);
});

// ── 不正常结束 ──

for (const [name, facts, reason] of [
  ['API 错误（subtype 仍是 success）', { ...OK, isError: true, terminalReason: 'api_error' }, 'turn_error'],
  ['中断', { ...OK, isError: true, interrupted: true, terminalReason: 'aborted_streaming' }, 'interrupted'],
  ['审批过期', { ...OK, approvalExpired: true }, 'approval_expired'],
  ['其它死因', { ...OK, terminalReason: 'max_turns' }, 'incomplete'],
]) {
  test(`MSG-03：${name} → 未发送，快照里还在，不等 idle 也不留定时器`, async () => {
    const ctx = setup();
    ctx.accept();
    assert.equal(ctx.endTurn(facts), 'hold');
    ctx.q.onCliIdle(ctx.a);
    await ctx.fireTimers();
    await flush();
    assert.deepEqual(ctx.a.sent, []);
    assert.equal(ctx.state(), 'held');
    assert.equal(ctx.reason(), reason);
    assert.equal(ctx.q.snapshot()[0].heldAt, 1000);
  });
}

test('MSG-03：hold 同步生效，迟到的 result 和 idle 都不释放，也不改 reason', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.q.hold(SID, 'stopped');
  assert.equal(ctx.state(), 'held', 'a.interrupt() 要等控制请求回包，这期间回合可能恰好正常结束，必须在那之前落定');
  assert.equal(ctx.endTurn(), undefined, 'held 不带 queuedNext');
  ctx.q.onCliIdle(ctx.a);
  await ctx.fireTimers();
  assert.deepEqual(ctx.a.sent, []);
  assert.equal(ctx.reason(), 'stopped');
  ctx.q.hold(SID, 'closed');
  assert.equal(ctx.reason(), 'stopped', '第一次 hold 的原因才是用户要看的');
});

test('等 idle 期间用户点停止 → 未发送，定时器作废', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.endTurn();
  ctx.q.hold(SID, 'stopped');
  assert.equal(ctx.timers.size, 0);
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.deepEqual(ctx.a.sent, []);
  assert.equal(ctx.reason(), 'stopped');
});

// ── 过闸 ──

for (const [name, entry, reason] of [
  ['终端在跑', { state: 'busy', source: 'cli' }, 'other_driver'],
  ['终端等审批', { state: 'waiting', source: 'cli' }, 'other_driver'],
  ['后台 agent 占用', { state: null, source: null, blocked: true }, 'other_driver'],
]) {
  test(`SESSION-01：释放时${name} → 未发送，消息没进实例`, async () => {
    const ctx = setup();
    ctx.states = new Map([[terminalStateKey(CWD, SID), entry]]);
    ctx.accept();
    ctx.endTurn();
    ctx.q.onCliIdle(ctx.a);
    await flush();
    assert.deepEqual(ctx.a.sent, []);
    assert.equal(ctx.reason(), reason);
  });
}

test('终端开着但闲着 → 照常发（机主决定 ②）', async () => {
  const ctx = setup();
  ctx.states = new Map([[terminalStateKey(CWD, SID), { state: 'alive', source: 'cli' }]]);
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.a.sent.length, 1);
});

test('SESSION-01：注册表读不全 → unverified，不当成没人', async () => {
  const ctx = setup({ gateOver: { listTerminalStates: async () => null } });
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.deepEqual(ctx.a.sent, []);
  assert.equal(ctx.reason(), 'unverified');
});

test('镜像锁着 → other_driver', async () => {
  const ctx = setup();
  ctx.readonly = true;
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.reason(), 'other_driver');
});

test('SRV-003：externalDirty → other_driver，实例不换', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.endTurn();
  ctx.a.externalDirty = true;
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.deepEqual(ctx.a.sent, []);
  assert.equal(ctx.a.swapped, 0, '用户不在跟前时不替他接管，也不杀后台任务');
  assert.equal(ctx.reason(), 'other_driver');
});

test('SESSION-04：有分叉结论 → diverged，结论留着', async () => {
  const ctx = setup();
  ctx.a.resumeDivergence = DIVERGENCE;
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.deepEqual(ctx.a.sent, []);
  assert.equal(ctx.reason(), 'diverged');
  assert.equal(ctx.a.resumeDivergence, DIVERGENCE);
});

test('记录位置失效 → location', async () => {
  const ctx = setup();
  ctx.location = async () => ({ status: 'not_found' });
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.reason(), 'location');
});

test('实例没了 → instance_exit，不替用户把会话拉起来', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.endTurn();
  ctx.live.clear();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.reason(), 'instance_exit');
});

test('过闸时又开了一轮 → 回 waiting，下一个 result 再发', async () => {
  const ctx = setup();
  ctx.location = async () => { ctx.a.pendingTurns = 1; return { status: 'found' }; };
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.deepEqual(ctx.a.sent, []);
  assert.equal(ctx.state(), 'waiting');
  ctx.location = async () => ({ status: 'found' });
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.a.sent.length, 1);
});

test('send 返回 false 且有在途轮（手动发送抢先）→ 回 waiting', async () => {
  const ctx = setup({ instance: makeInstance({ send: async function send() { this.pendingTurns = 1; return false; } }) });
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.state(), 'waiting');
});

test('send 返回 false 且没有在途轮 → send_failed，不丢', async () => {
  const ctx = setup({ instance: makeInstance({ send: async () => false }) });
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.reason(), 'send_failed');
  assert.deepEqual(ctx.q.take(SID, 'c1').text, '接下来跑测试');
});

test('附件落盘失败 → attachment_failed，取回时原始附件还在', async () => {
  const attachments = [{ name: 'a.png', mimeType: 'image/png', data: 'BASE64' }];
  const ctx = setup({ gateOver: { saveAttachments: async () => { throw new Error('磁盘满'); } } });
  ctx.accept({ attachments });
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.reason(), 'attachment_failed');
  assert.deepEqual(ctx.q.take(SID, 'c1').attachments, attachments);
});

test('附件释放时才落盘：回合中可能换目录，撤回不留孤儿文件', async () => {
  let saved = 0;
  const ctx = setup({ gateOver: { saveAttachments: async cwd => { saved += 1; assert.equal(cwd, '/新目录'); return []; } } });
  ctx.accept({ attachments: [{ name: 'a', data: 'x' }] });
  assert.equal(saved, 0);
  ctx.a.cwd = '/新目录';
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(saved, 1);
});

test('发出之后的副作用抛错 → 条目照样移除，绝不重发同一条', async () => {
  const ctx = setup({ gateOver: { onManualSend: () => { throw new Error('下游炸了'); } } });
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.a.sent.length, 1);
  assert.deepEqual(ctx.q.snapshot(), []);
});

test('判定阶段抛错 → send_failed，消息不丢', async () => {
  const ctx = setup();
  ctx.location = async () => { throw new Error('读盘失败'); };
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.reason(), 'send_failed');
});

// ── 竞态（设计第 6 节） ──

function deferredLocation(ctx) {
  let release;
  ctx.location = () => new Promise(r => { release = () => r({ status: 'found' }); });
  return () => release();
}

test('撤回赢闸门 await：释放醒来后不发', async () => {
  const ctx = setup();
  const release = deferredLocation(ctx);
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.q.take(SID, 'c1').ok, true);
  release();
  await flush();
  assert.deepEqual(ctx.a.sent, []);
});

test('sending 期间撤回：切模型还在等，消息没进实例，撤回成功且不再发', async () => {
  const { a, gate } = slowSendInstance();
  const ctx = setup({ instance: a });
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.state(), 'sending');
  assert.equal(ctx.q.take(SID, 'c1').text, '接下来跑测试');
  gate.release();
  await flush();
  assert.deepEqual(ctx.a.sent, []);
  assert.deepEqual(ctx.q.snapshot(), []);
});

test('两台设备同时撤回：先到的拿到全文，后到的 not_found', () => {
  const ctx = setup();
  ctx.accept();
  assert.deepEqual(ctx.q.take(SID, 'c1'), { ok: true, text: '接下来跑测试', model: 'opus', attachments: undefined });
  assert.deepEqual(ctx.q.take(SID, 'c1'), { ok: false, error: 'not_found' });
});

test('clientMessageId 对不上不给取：不能拿到别的消息', () => {
  const ctx = setup();
  ctx.accept();
  assert.deepEqual(ctx.q.take(SID, '别的 ID'), { ok: false, error: 'not_found' });
  assert.equal(ctx.state(), 'waiting');
});

test('停止赢闸门 await：不发，转未发送', async () => {
  const ctx = setup();
  const release = deferredLocation(ctx);
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  ctx.q.hold(SID, 'stopped');
  release();
  await flush();
  assert.deepEqual(ctx.a.sent, []);
  assert.equal(ctx.reason(), 'stopped');
});

test('MSG-03：sending 期间点停止（切模型还在等）→ 未发送，之后不发，取得回', async () => {
  const { a, gate } = slowSendInstance();
  const ctx = setup({ instance: a });
  ctx.accept();
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.state(), 'sending');
  ctx.q.hold(SID, 'stopped');
  assert.equal(ctx.state(), 'held', '消息还没进实例，interrupt 没东西可取消，只有这里拦得住');
  gate.release();
  await flush();
  assert.deepEqual(ctx.a.sent, [], '点了停止之后不得发出');
  assert.equal(ctx.reason(), 'stopped', '取消造成的 send=false 不得改写原因');
  assert.equal(ctx.q.take(SID, 'c1').text, '接下来跑测试');
});

test('MSG-03：附件还在落盘时点停止 → 未发送，附件还在', async () => {
  let finishSave;
  const attachments = [{ name: 'a.png', mimeType: 'image/png', data: 'BASE64' }];
  const ctx = setup({ gateOver: { saveAttachments: () => new Promise((r) => { finishSave = () => r([]); }) } });
  ctx.accept({ attachments });
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.state(), 'sending');
  ctx.q.hold(SID, 'stopped');
  finishSave();
  await flush();
  assert.deepEqual(ctx.a.sent, []);
  assert.equal(ctx.reason(), 'stopped');
  assert.deepEqual(ctx.q.take(SID, 'c1').attachments, attachments);
});

test('附件落盘失败与停止撞车：保留用户的停止原因，不改写成 attachment_failed', async () => {
  let failSave;
  const ctx = setup({ gateOver: { saveAttachments: () => new Promise((_, rej) => { failSave = () => rej(new Error('磁盘满')); }) } });
  ctx.accept({ attachments: [{ name: 'a', data: 'x' }] });
  ctx.endTurn();
  ctx.q.onCliIdle(ctx.a);
  await flush();
  ctx.q.hold(SID, 'stopped');
  failSave();
  await flush();
  assert.equal(ctx.reason(), 'stopped');
});

test('未发送的条目永不自动释放，只有用户取回', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.q.hold(SID, 'quota_wall');
  for (let i = 0; i < 3; i++) {
    assert.equal(ctx.endTurn(), undefined);
    ctx.q.onCliIdle(ctx.a);
    await ctx.fireTimers();
  }
  assert.deepEqual(ctx.a.sent, [], '到点代发的「继续」跑完也不能带上它');
  assert.equal(ctx.q.take(SID, 'c1').ok, true);
  assert.deepEqual(ctx.q.snapshot(), []);
});

// ── 会话变化 ──

test('/clear 换了会话：条目跟到新 id 并转未发送，这句话是对旧上下文说的', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.a.sessionId = 'new-sid';
  ctx.q.onSessionChanged(ctx.a, 'new-sid');
  assert.equal(ctx.state(), 'held');
  assert.equal(ctx.reason(), 'session_changed');
  assert.equal(ctx.q.snapshot()[0].sessionId, 'new-sid');
  assert.equal(ctx.q.take('new-sid', 'c1').ok, true);
});

test('同一个 id 重复回调（每轮 init 都会调）不动条目', () => {
  const ctx = setup();
  ctx.accept();
  ctx.q.onSessionChanged(ctx.a, SID);
  assert.equal(ctx.state(), 'waiting');
});

test('别的实例换会话不动这一条', () => {
  const ctx = setup();
  ctx.accept();
  ctx.q.onSessionChanged(makeInstance({ instanceId: 'inst-9' }), 'new-sid');
  assert.equal(ctx.state(), 'waiting');
});

test('删除会话 → 条目丢弃，用户删的是整个会话', async () => {
  const ctx = setup();
  ctx.accept();
  ctx.endTurn();
  ctx.q.discard(SID);
  assert.deepEqual(ctx.q.snapshot(), []);
  assert.equal(ctx.timers.size, 0);
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.deepEqual(ctx.a.sent, []);
});

test('hold 时刷新 cwd：会话中途进了 worktree，深链要落到新目录', () => {
  const ctx = setup();
  ctx.accept();
  ctx.a.cwd = '/worktree';
  ctx.q.hold(SID, 'stopped');
  assert.equal(ctx.q.snapshot()[0].cwd, '/worktree');
});

test('只有对外状态变了才广播：sending 要让别的设备看到（否则卡片停在排队中，撤回却失败），等 idle 不广播', async () => {
  let unblock;
  const ctx = setup({
    instance: makeInstance({
      async send(text) { await new Promise((r) => { unblock = r; }); this.sent.push({ text }); return true; },
    }),
  });
  ctx.accept();
  const afterAccept = ctx.changes;
  ctx.endTurn();
  assert.equal(ctx.changes, afterAccept, '进 settling 对外还是排队中，这条广播有近三十个触发点，别再添');
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.state(), 'sending');
  assert.equal(ctx.changes, afterAccept + 1, '转 sending 必须广播一次');
  unblock();
  await flush();
  assert.equal(ctx.changes, afterAccept + 2, '发完再广播一次，卡片才会消失');
});

test('快照对外只有三态：settling、releasing 都算 waiting', async () => {
  const ctx = setup();
  const release = deferredLocation(ctx);
  ctx.accept();
  ctx.endTurn();
  assert.equal(ctx.state(), 'waiting');
  ctx.q.onCliIdle(ctx.a);
  await flush();
  assert.equal(ctx.state(), 'waiting');
  release();
  await flush();
  assert.deepEqual(ctx.q.snapshot(), []);
});
