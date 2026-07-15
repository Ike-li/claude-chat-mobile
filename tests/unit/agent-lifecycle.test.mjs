import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, sdkChildEnv } from '../../src/agent/agent.js';
import { getSessionLogs } from '../../src/agent/interaction-log.js';
import { makeSession } from '../helpers/agent-unit.mjs';

// ---- dispose() ----
test.describe('dispose()', () => {
  test('dispose：设置 disposed/inputEnded、clearInterval、abort', () => {
    const { s, events } = makeSession();
    let cleared = false;
    s.idleTimer = setInterval(() => {}, 99999);
    const origClear = clearInterval;
    globalThis.clearInterval = (t) => { cleared = true; origClear(t); };
    let aborted = false;
    s.abort = { abort() { aborted = true; } };

    s.dispose();
    assert.equal(s.disposed, true);
    assert.equal(s.inputEnded, true);
    assert.equal(cleared, true);
    assert.equal(aborted, true);
    assert.equal(s.idleTimer, null);
    s.dispose();
  });

  test('dispose：resolve 所有待处理权限（permission → deny）', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.askPermission('Bash', { command: 'rm' }, { signal: ac.signal, toolUseID: 't1' });
    assert.equal(s.pendingPermissions.size, 1);
    s.dispose();
    assert.equal(s.pendingPermissions.size, 0);
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.kind === 'permission');
    assert.equal(rr.payload.outcome, 'deny');
  });

  test('dispose：resolve 所有待处理问题 + emit request_resolved + denyKinds 清理', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    assert.equal(s.pendingQuestions.size, 1);
    s.dispose();
    assert.equal(s.pendingQuestions.size, 0);
    // dispose() line ~443 先设 denyKinds.set(toolUseID,'cancelled') 再 clear()，
    // 故 dispose 后 denyKinds 为空
    assert.equal(s.denyKinds.size, 0);
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.kind === 'question');
    assert.ok(rr);
    assert.equal(rr.payload.outcome, 'aborted');
  });

  test('dispose 后再 send → disposed 守卫', async () => {
    const { s } = makeSession({ model: 'sonnet' });
    s.dispose();
    // send with same model（无 setModel await），disposed 守卫在 line ~219 拦截
    const result = await s.send('hi');
    assert.equal(result, false);
  });

  test('dispose 的 abort 抛错 → 不崩', () => {
    const { s } = makeSession();
    s.abort = { abort() { throw new Error('boom'); } };
    // 不应抛到调用方
    assert.doesNotThrow(() => s.dispose());
  });
});

// ---- checkIdle() ----
test.describe('checkIdle()', () => {
  test('pendingTurns=0 且未超空闲回收阈 → 不回收', () => {
    const { s } = makeSession({ instanceIdleReclaimMs: 60_000 });
    s.pendingTurns = 0;
    s.lastActivity = Date.now();
    s.checkIdle();
    assert.equal(s.terminating, false);
    s.dispose();
  });

  test('pendingTurns=0 且超空闲回收阈 → 回收子进程（abort + recoverable error）', () => {
    const { s, events } = makeSession({ instanceIdleReclaimMs: 1 });
    s.pendingTurns = 0;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.terminating, true);
    assert.equal(aborted, true);
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('空闲') || err.payload.message.includes('回收'));
    assert.equal(err.payload.recoverable, true);
    s.dispose();
  });

  test('instanceIdleReclaimMs=0 → 禁用空闲回收', () => {
    const { s, events } = makeSession({ instanceIdleReclaimMs: 0 });
    s.pendingTurns = 0;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.terminating, false);
    assert.equal(aborted, false);
    assert.equal(events.find(e => e.type === 'error'), undefined);
    s.dispose();
  });

  test('有后台任务 isBusy → 不走空闲回收', () => {
    const { s } = makeSession({ instanceIdleReclaimMs: 1 });
    s.pendingTurns = 0;
    s.lastActivity = 0;
    s.bgTasks.set('bg1', { taskType: 'local_agent', message: '跑', lastSeenAt: Date.now() });
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.terminating, false);
    assert.equal(aborted, false);
    s.bgTasks.clear();
    s.dispose();
  });

  test('pendingPermissions 非空 → lastActivity 刷新，不触发超时', () => {
    const { s } = makeSession({ idleTimeoutMs: 1, instanceIdleReclaimMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0; // 很久以前
    // 模拟合法 pending 条目（含 resolve，防 dispose 报错）
    s.pendingPermissions.set('x', { resolve() {}, signal: null, abortHandler: null, suggestions: null, input: null });
    s.checkIdle();
    assert.ok(s.lastActivity > 0); // 刷新为当前时间
    assert.equal(s.terminating, false);
    // 手动清理（不走 dispose 的 resolvePermission 完整路径）
    s.pendingPermissions.clear();
    s.dispose();
  });

  test('pendingQuestions 非空 → lastActivity 刷新', () => {
    const { s } = makeSession({ idleTimeoutMs: 1, instanceIdleReclaimMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    // 模拟合法 pending 条目（含 questions 数组 + resolve，防 dispose 报错）
    s.pendingQuestions.set('x', { questions: [], resolve() {}, signal: null, abortHandler: null });
    s.checkIdle();
    assert.ok(s.lastActivity > 0);
    s.pendingQuestions.clear();
    s.dispose();
  });

  test('在途轮静默超时 → emit error + terminating=true + abort', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.terminating, true);
    assert.equal(aborted, true);
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('静默'));
    assert.equal(err.payload.recoverable, true);
    s.dispose();
  });
});

// ---- consume() 退出路径 ----
test.describe('consume() 退出路径', () => {
  test('正常结束 + sawInit 已到 + 无 resumeId → emit error(进程已退出) + onExit', async () => {
    let exited = false;
    const { s, events } = makeSession({ onExit() { exited = true; } });
    s.sawInit = true;
    s.resumeId = null;

    // 模拟一个立即可迭代完的 async iterator
    const fakeQ = {
      [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ done: true }); } }; }
    };
    await s.consume(fakeQ);

    assert.equal(exited, true);
    const err = events.find(e => e.type === 'error' && e.payload.message.includes('进程已退出'));
    assert.ok(err);
    s.dispose();
  });

  test('正常结束 + sawInit 未到 + resumeId 存在 → resumeFailed + emit error(recoverable:false) + onExit', async () => {
    let exited = false;
    const { s, events } = makeSession({ resumeId: 'bad-id', onExit() { exited = true; } });
    s.sawInit = false;

    const fakeQ = {
      [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ done: true }); } }; }
    };
    await s.consume(fakeQ);

    assert.equal(s.resumeFailed, true);
    assert.equal(exited, true);
    const err = events.find(e => e.type === 'error' && !e.payload.recoverable);
    assert.ok(err);
    assert.ok(err.payload.message.includes('无法恢复会话'));
    s.dispose();
  });

  test('异常结束 → caught 路径 emit error(recoverable:true) + onExit', async () => {
    let exited = false;
    const { s, events } = makeSession({ onExit() { exited = true; } });
    s.sawInit = true;

    const fakeQ = {
      [Symbol.asyncIterator]() {
        return {
          next() { return Promise.reject(new Error('process exited with code 1')); }
        };
      }
    };
    await s.consume(fakeQ);

    assert.equal(exited, true);
    const err = events.find(e => e.type === 'error' && e.payload.recoverable === true);
    assert.ok(err);
    assert.ok(err.payload.message.includes('会话异常'));
    s.dispose();
  });

  test('terminating=true → 跳过 error emit 但不跳过 onExit', async () => {
    let exited = false;
    const { s, events } = makeSession({ onExit() { exited = true; } });
    s.terminating = true;

    const fakeQ = {
      [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ done: true }); } }; }
    };
    const countBefore = events.length;
    await s.consume(fakeQ);

    // onExit 在 `if (!this.disposed)` 块中（line ~188），不受 terminating 影响
    assert.equal(exited, true);
    // 但 error emit 在 `if (!this.disposed && !this.terminating)` 中被跳过
    assert.equal(events.length, countBefore);
    s.dispose();
  });

  test('disposed=true → 不调 onExit', async () => {
    let exited = false;
    const { s, events } = makeSession({ onExit() { exited = true; } });
    s.disposed = true;

    const fakeQ = {
      [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ done: true }); } }; }
    };
    await s.consume(fakeQ);

    assert.equal(exited, false);
    s.dispose();
  });

  test('consume 清理：pendingTurns 清零、denyKinds clear、pendingPermissions 全部 deny', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.pendingTurns = 3;
    s.askPermission('Read', { file_path: '/a' }, { signal: ac.signal, toolUseID: 't1' });
    s.denyKinds.set('old', 'denied');

    const fakeQ = {
      [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ done: true }); } }; }
    };
    await s.consume(fakeQ);

    assert.equal(s.pendingTurns, 0);
    assert.equal(s.pendingPermissions.size, 0);
    assert.equal(s.denyKinds.size, 0);
    s.dispose();
  });
});

// ---- lastActivity 刷新（修复验证）----
test.describe('lastActivity 刷新', () => {
  test('send() 后 lastActivity 更新为当前时间', () => {
    const { s } = makeSession();
    const before = Date.now() - 10000;
    s.lastActivity = before;
    s.send('hi');
    assert.ok(s.lastActivity > before);
    s.dispose();
  });

  test('resolvePermission() 后 lastActivity 刷新', () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.askPermission('Read', { file_path: '/a' }, { signal: ac.signal, toolUseID: 't1' });
    s.lastActivity = 0;
    s.resolvePermission('t1', 'allow');
    assert.ok(s.lastActivity > 0);
    s.dispose();
  });
});

// ---- pendingRequestsSnapshot()：切入(sync:since)时重建待审批/提问卡片的权威快照 ----
// 修「角标 ⚠️ 待审批但会话内无卡片」：原始 permission_request/question 事件可能被环形缓冲 trim
// 或切视图时被前端分流丢弃，pendingPermissions/pendingQuestions 才是权威真相。payload 必须与
// askPermission 的 emit('permission_request')、handleQuestion 的 emit('question') 逐字段一致。
test.describe('pendingRequestsSnapshot()', () => {
  test('全空 → { permissions:[], questions:[] }', () => {
    const { s } = makeSession();
    assert.deepEqual(s.pendingRequestsSnapshot(), { permissions: [], questions: [] });
  });

  test('permission：requestId/name/input/cwd/fp/createdAt/expiresAt 与 emit(permission_request) 一致', () => {
    const { s } = makeSession({ cwd: '/tmp/proj' });
    // fp/createdAt/expiresAt：真实 pendingPermissions 条目总由 askPermission 写入（NFR-17 完整性绑定
    // + FR-22 悬置时长/TTL），此处手造数据代表真实形态，断言快照原样透传（而非只透传 name/input）。
    s.pendingPermissions.set('req_1', { name: 'Bash', input: { command: 'ls -la' }, resolve() {}, fp: 'abc123', createdAt: 1000, expiresAt: 2000 });
    const snap = s.pendingRequestsSnapshot();
    assert.deepEqual(snap.permissions, [{ requestId: 'req_1', name: 'Bash', input: { command: 'ls -la' }, cwd: '/tmp/proj', fp: 'abc123', createdAt: 1000, expiresAt: 2000 }]);
    assert.deepEqual(snap.questions, []);
  });

  test('question：仅补发未答项（answers[i]===null），options 归一为 {label,...} 对象', () => {
    const { s } = makeSession();
    s.pendingQuestions.set('tool_1', {
      questions: [
        { question: 'Q0?', options: ['A', 'B'] },
        { question: 'Q1?', options: [{ label: 'X' }, { label: 'Y' }] }, // 已答 → 不补发
      ],
      answers: [null, 'X'],
      resolve() {},
    });
    const snap = s.pendingRequestsSnapshot();
    // 对齐 CLI rich options：字符串选项也会归一成 {label}；multiSelect 缺省 false
    assert.deepEqual(snap.questions, [{
      requestId: 'tool_1#0', text: 'Q0?', header: undefined, multiSelect: false,
      options: [{ label: 'A' }, { label: 'B' }],
    }]);
    assert.deepEqual(snap.permissions, []);
  });

  test('permission + question 并存', () => {
    const { s } = makeSession({ cwd: '/w' });
    s.pendingPermissions.set('p1', { name: 'Write', input: { path: 'a.txt' }, resolve() {} });
    s.pendingQuestions.set('t1', { questions: [{ question: 'pick?', options: ['one'] }], answers: [null], resolve() {} });
    const snap = s.pendingRequestsSnapshot();
    assert.equal(snap.permissions.length, 1);
    assert.equal(snap.questions.length, 1);
    assert.equal(snap.questions[0].requestId, 't1#0');
  });
});
