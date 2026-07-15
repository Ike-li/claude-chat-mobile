import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, sdkChildEnv } from '../../src/agent/agent.js';
import { getSessionLogs } from '../../src/agent/interaction-log.js';
import { makeSession } from '../helpers/agent-unit.mjs';

test('sdkChildEnv：SDK 子进程带项目自有 origin 标记且调用方不能覆盖', () => {
  assert.deepEqual(sdkChildEnv({ KEEP: 'yes', EMPTY: '', CCM_STATUSLINE_ORIGIN: 'terminal' }), {
    KEEP: 'yes',
    CCM_STATUSLINE_ORIGIN: 'web-sdk',
  });
});

// BE-008：isBusy 综合忙判定——effort 切档需 dispose+resume 置换实例，只有完全 idle 才能安全置换。
// 后台任务(bgTasks)/挂起审批/挂起问题都【不】计入 pendingTurns，只查 pendingTurns 会在它们进行时误杀。
test.describe('isBusy（BE-008：effort 切档前的综合忙判定）', () => {
  test('全空 → 空闲', () => {
    const { s, dispose } = makeSession();
    assert.equal(s.isBusy(), false);
    dispose();
  });
  test('在途轮 pendingTurns>0 → 忙', () => {
    const { s, dispose } = makeSession();
    s.pendingTurns = 1;
    assert.equal(s.isBusy(), true);
    s.pendingTurns = 0;
    dispose();
  });
  test('后台任务运行中（pendingTurns 仍为 0）→ 忙（防 effort 切档误杀 Workflow/后台 Agent/Bash）', () => {
    const { s, dispose } = makeSession();
    s.bgTasks.set('t1', { taskType: 'workflow', message: '', lastSeenAt: Date.now() });
    assert.equal(s.pendingTurns, 0);
    assert.equal(s.hasBgTasks(), true);
    assert.equal(s.isBusy(), true);
    dispose();
  });
  test('挂起审批 / 挂起问题 → 忙', () => {
    const { s, dispose } = makeSession();
    s.pendingPermissions.set('r1', {});
    assert.equal(s.isBusy(), true);
    s.pendingPermissions.clear();
    s.pendingQuestions.set('q1', {});
    assert.equal(s.isBusy(), true);
    s.pendingQuestions.clear(); // 清掉假 pending 再 dispose，避免 dispose 的 deny 回调触碰空对象
    dispose();
  });
});

// ---- 构造函数 + 默认值 ----
test.describe('AgentSession 构造函数', () => {
  test('默认值正确', () => {
    const { s } = makeSession();
    assert.equal(s.instanceId, 'test');
    assert.equal(s.cwd, '/tmp/test');
    assert.equal(s.disposed, false);
    assert.equal(s.pendingTurns, 0);
    assert.equal(s.permissionMode, 'default');
    assert.equal(s.effort, null);
    assert.equal(s.defaultModel, undefined);
    assert.equal(s.activeModel, undefined);
    assert.equal(s.sessionId, null);
    assert.equal(s.resumeFailed, false);
    assert.equal(s.sawInit, false);
    assert.equal(s.seq, 0);
    assert.equal(s.buffer.length, 0);
    assert.equal(s.bufferTrimmed, false);
    assert.equal(s.pendingPermissions.size, 0);
    assert.equal(s.pendingQuestions.size, 0);
    assert.equal(s.denyKinds.size, 0);
    assert.ok(s.epoch);
    s.dispose();
  });

  test('model 参数 → defaultModel + activeModel', () => {
    const { s } = makeSession({ model: 'claude-sonnet-4-5' });
    assert.equal(s.defaultModel, 'claude-sonnet-4-5');
    assert.equal(s.activeModel, 'claude-sonnet-4-5');
    s.dispose();
  });

  test('resumeId → sessionId 初始值', () => {
    const { s } = makeSession({ resumeId: 'abc123' });
    assert.equal(s.sessionId, 'abc123');
    assert.equal(s.resumeId, 'abc123');
    s.dispose();
  });

  test('permissionMode + effort 自定义', () => {
    const { s } = makeSession({ permissionMode: 'plan', effort: 'high' });
    assert.equal(s.permissionMode, 'plan');
    assert.equal(s.effort, 'high');
    s.dispose();
  });

  test('historicalCostUsd 初始化', () => {
    const { s } = makeSession({ historicalCostUsd: 1.5 });
    assert.equal(s.historicalCostUsd, 1.5);
    assert.equal(s.totalCostUsd, 0);
    s.dispose();
  });

  test('各实例 epoch 唯一', () => {
    const a = new AgentSession({ instanceId: 'a', cwd: '/tmp', claudeBin: 'x', onEvent() {} });
    const b = new AgentSession({ instanceId: 'b', cwd: '/tmp', claudeBin: 'x', onEvent() {} });
    assert.notEqual(a.epoch, b.epoch);
    a.dispose(); b.dispose();
  });
});

// ---- emit() + 环形缓冲 + eventsSince() ----
test.describe('emit / buffer / eventsSince', () => {
  test('emit：seq 递增、envelope 含全部 9 字段', () => {
    const { s, events } = makeSession();
    s.emit('system', { message: 'hello' });
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.seq, 1);
    assert.equal(e.epoch, s.epoch);
    assert.equal(e.sessionId, s.sessionId);
    assert.equal(e.instanceId, 'test');
    assert.equal(e.cwd, '/tmp/test');
    assert.equal(e.type, 'system');
    assert.deepEqual(e.payload, { message: 'hello' });
    assert.ok(typeof e.ts === 'number');
    s.dispose();
  });

  test('多次 emit → seq 单调递增', () => {
    const { s, events } = makeSession();
    s.emit('text_delta', { text: 'a' });
    s.emit('text_delta', { text: 'b' });
    s.emit('text_delta', { text: 'c' });
    assert.equal(events.length, 3);
    assert.equal(events[0].seq, 1);
    assert.equal(events[1].seq, 2);
    assert.equal(events[2].seq, 3);
    s.dispose();
  });

  test('缓冲上限 BUFFER_CAP(2000) → 溢出后 bufferTrimmed=true、最旧 seq=2', () => {
    const { s, events } = makeSession();
    // push 2001 条（seq 1..2001），buffer 只保留最近 2000 条（seq 2..2001）
    for (let i = 0; i < 2001; i++) s.emit('system', { n: i });
    assert.equal(s.buffer.length, 2000);
    assert.equal(s.bufferTrimmed, true);
    assert.equal(s.buffer[0].seq, 2);  // seq 1 被挤出
    assert.equal(s.buffer[1999].seq, 2001);
    s.dispose();
  });

  test('eventsSince(lastSeq)：过滤 seq > lastSeq', () => {
    const { s } = makeSession();
    s.emit('system', { n: 1 });  // seq=1
    s.emit('system', { n: 2 });  // seq=2
    s.emit('system', { n: 3 });  // seq=3
    const r = s.eventsSince(1);
    assert.equal(r.events.length, 2);
    assert.equal(r.events[0].seq, 2);
    assert.equal(r.events[1].seq, 3);
    assert.equal(r.gap, false);
    assert.equal(r.epoch, s.epoch);
    s.dispose();
  });

  test('eventsSince：gap 检测（bufferTrimmed + oldest 超出范围）', () => {
    const { s } = makeSession();
    // push 2002 条 → buffer 保留最近 2000 条（seq 3..2002），seq 1-2 被挤出
    for (let i = 0; i < 2002; i++) s.emit('system', { n: i });
    // 最旧 seq=3 > lastSeq+1=2 → 有 gap
    const r = s.eventsSince(1);
    assert.equal(r.gap, true);
    s.dispose();
  });

  test('eventsSince：lastSeq=0 且未溢出 → 无 gap', () => {
    const { s } = makeSession();
    s.emit('system', { n: 1 });
    const r = s.eventsSince(0);
    assert.equal(r.gap, false);
    assert.equal(r.events.length, 1);
    s.dispose();
  });

  // 修：已答 AskUserQuestion / 已决审批仍在环形缓冲 → sync:since 回放又弹窗。
  // pending* 是权威真相；eventsSince 回放须跳过已不再 pending 的 question/permission_request。
  test('eventsSince：已答 question 与已决 permission_request 不再回放', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q0', options: ['A', 'B'] }, { question: 'Q1', options: ['X'] }] },
      { signal: ac.signal, toolUseID: 'tool_q' },
    );
    // 只答第 0 题：q#0 已答、q#1 仍挂起
    s.resolveQuestion('tool_q#0', 0);
    const mid = s.eventsSince(0);
    const midQs = mid.events.filter(e => e.type === 'question').map(e => e.payload.requestId);
    assert.deepEqual(midQs, ['tool_q#1'], '已答 #0 不得回放，未答 #1 仍回放');

    // 再答完 #1：整组离开 pending → 两题都不再回放
    s.resolveQuestion('tool_q#1', 0);
    const done = s.eventsSince(0);
    assert.equal(done.events.filter(e => e.type === 'question').length, 0);
    // request_resolved 仍回放（供多设备关窗）；至少含单题 answered + 整组终态
    assert.ok(done.events.some(e => e.type === 'request_resolved' && e.payload.requestId === 'tool_q#0'));
    assert.ok(done.events.some(e => e.type === 'request_resolved' && e.payload.requestId === 'tool_q'));

    // permission：resolve 后不应再回放 permission_request
    const permEvents = [];
    const onEvent = s.onEvent;
    s.onEvent = (env) => { permEvents.push(env); onEvent?.(env); };
    // 手塞一条 permission_request 进缓冲 + pending，再 resolve 清 pending
    s.pendingPermissions.set('perm_1', { resolve() {}, name: 'Bash', input: {}, suggestions: [] });
    s.emit('permission_request', { requestId: 'perm_1', name: 'Bash', input: {} });
    assert.ok(s.eventsSince(0).events.some(e => e.type === 'permission_request' && e.payload.requestId === 'perm_1'));
    s.pendingPermissions.delete('perm_1');
    assert.equal(
      s.eventsSince(0).events.filter(e => e.type === 'permission_request' && e.payload.requestId === 'perm_1').length,
      0,
    );
    s.dispose();
  });
});
