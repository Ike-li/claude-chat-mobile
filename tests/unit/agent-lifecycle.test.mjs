import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLifecycleIdleTimeout,
  formatLifecycleIdleReclaim,
  formatLifecycleProcessExited,
  formatLifecycleSessionError,
} from '../../src/agent/agent.js';
import { makeSession } from '../helpers/agent-unit.mjs';


// ---- lifecycle 文案（防「会话已结束」歧义）----
test.describe('formatLifecycle*', () => {
  test('idleTimeout / reclaim / processExited / sessionError 前缀稳定', () => {
    assert.equal(
      formatLifecycleIdleTimeout(10),
      '任务已中断：超过 10 分钟未收到 Claude 的任何消息（含思考/工具进度），已按挂死中断（可重新发送继续）',
    );
    assert.equal(
      formatLifecycleIdleTimeout(0.2),
      '任务已中断：超过 1 分钟未收到 Claude 的任何消息（含思考/工具进度），已按挂死中断（可重新发送继续）',
    );
    assert.equal(formatLifecycleIdleReclaim(30), '进程已回收：会话空闲超过 30 分钟（再发送或切换回来会自动续接）');
    assert.equal(formatLifecycleProcessExited(), '进程已退出：可重新发送消息继续（会话历史仍在）');
    assert.match(formatLifecycleSessionError('boom'), /^进程异常：boom$/);
    assert.match(formatLifecycleSessionError(''), /进程异常/);
  });
});

// ---- dispose() ----
test.describe('dispose()', () => {
  test('dispose：设置 disposed/inputEnded、clearInterval、abort', () => {
    const { s } = makeSession();
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

  // 用户正在看会话时不得空闲回收：否则 onExit reselect 会清屏，历史分块渲染的 frag 永远不落地 → 空屏。
  test('touchActivity 续期 lastActivity → 不触发空闲回收', () => {
    const { s, events } = makeSession({ instanceIdleReclaimMs: 1 });
    s.pendingTurns = 0;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.touchActivity();
    s.checkIdle();
    assert.equal(s.terminating, false);
    assert.equal(aborted, false);
    assert.equal(events.find(e => e.type === 'error'), undefined);
    s.dispose();
  });

  test('setViewed(true) → 当前查看实例不走空闲回收（即使用户长时间只读历史）', () => {
    const { s, events } = makeSession({ instanceIdleReclaimMs: 1 });
    s.pendingTurns = 0;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.setViewed(true);
    // 模拟用户读了很久：lastActivity 再变旧
    s.lastActivity = 0;
    s.checkIdle();
    assert.equal(s.terminating, false);
    assert.equal(aborted, false);
    assert.equal(events.find(e => e.type === 'error'), undefined);
    // 切走后可回收
    s.setViewed(false);
    s.lastActivity = 0;
    s.checkIdle();
    assert.equal(s.terminating, true);
    assert.equal(aborted, true);
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

  // CLI 等价性：CLI 里请求挂死只是报错停在原地（Esc 中断本轮），绝不自杀会话。看门狗超时
  // 应等价于替用户按 Esc——走 interrupt() 中断在途轮，实例存活可原地重发，兑现
  // formatLifecycleIdleTimeout 文案里的「可重新发送继续」（旧行为直接 abort 杀实例 →
  // onExit → 实例被删 → 前端「会话已中断」死路页，与文案自相矛盾）。
  test('在途轮静默超时 + SDK 可中断 → 自动中断本轮但实例存活（不 abort 不 terminating）', async () => {
    const { s, events } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    let interruptCalls = 0;
    s.q = { interrupt: async () => { interruptCalls++; } };
    s.checkIdle();
    await new Promise(r => setTimeout(r, 20)); // interrupt() 异步收尾
    assert.equal(interruptCalls, 1, '应走 q.interrupt() 而非直接 abort');
    assert.equal(s.terminating, false, '中断成功不得置 terminating');
    assert.equal(aborted, false, '中断成功不得 abort 子进程');
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('未收到 Claude 的任何消息'), '仍须发 idle 超时说明（用户可见原因）');
    assert.equal(err.payload.recoverable, true);
    const sys = events.find(e => e.type === 'system' && e.payload.kind === 'interrupted');
    assert.ok(sys, '应发「已中断」（等价用户按 Esc）');
    assert.ok(s.lastActivity > 0, '触发后须刷新 lastActivity，防 30s tick 在中断未决期间重复触发');
    s.dispose();
  });

  test('在途轮静默超时 + interrupt 被拒 → settleForce 兜底（terminating + abort + 账面收口）', async () => {
    const { s, events } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.q = { interrupt: async () => { throw new Error('control lost'); } };
    s.checkIdle();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(s.terminating, true, '控制通道失败 → 保留原强杀兜底');
    assert.equal(aborted, true);
    assert.equal(s.pendingTurns, 0, 'settleForce 应收口在途轮账面');
    const sys = events.find(e => e.type === 'system' && e.payload.kind === 'interrupted');
    assert.ok(sys);
    s.dispose();
  });

  // SDK 不可达（q 缺失/无 interrupt 方法，如启动早期或已半死）：无法「按 Esc」，
  // 保留直接强杀——否则 q.interrupt?.() 返回 undefined 会被当成功，僵尸实例永不清理。
  test('在途轮静默超时 + SDK 不可达（无 q.interrupt）→ 兜底 abort 强杀', () => {
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
    assert.ok(err.payload.message.includes('未收到 Claude 的任何消息'));
    assert.equal(err.payload.recoverable, true);
    s.dispose();
  });

  // 多子代理 / workflow 并行：主流通可长时间零消息，但 bgTasks 仍有心跳。
  // 旧行为只看 lastActivity，会在 10 分钟把整轮误杀（用户见 idle 零消息中断文案）。
  test('在途轮 + 活的后台任务 → 不静默中断，并刷新 lastActivity', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0; // 远古静默
    s.bgTasks.set('bg1', { taskType: 'local_agent', message: '子代理跑', lastSeenAt: Date.now() });
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.terminating, false, '有活 bgTasks 时不得 idleTimeout 误杀');
    assert.equal(aborted, false);
    assert.ok(s.lastActivity > 0, '应刷新 lastActivity，等同「仍有活动」');
    assert.equal(events.find(e => e.type === 'error'), undefined);
    s.bgTasks.clear();
    s.dispose();
  });

  test('在途轮 + 后台任务已 TTL 清掉 → 仍按静默超时中断', () => {
    const { s, events } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    // 过期孤儿（合成键，3min 短 TTL）：checkIdle 先 sweep，hasBgTasks 变 false，应走静默中断。
    // 真实 task_id 走 2h 长兜底，不能再用 3min 模拟「已死」——见 agent.js BG_TASK_ORPHAN_TTL_MS。
    s.bgTasks.set('__notask_stale', {
      taskType: 'local_agent',
      message: '已死',
      lastSeenAt: Date.now() - 180_000 - 1,
    });
    let aborted = false;
    s.abort = { abort() { aborted = true; } };
    s.checkIdle();
    assert.equal(s.hasBgTasks(), false, '过期孤儿 bg 应被 sweep');
    assert.equal(s.terminating, true);
    assert.equal(aborted, true);
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('未收到 Claude 的任何消息'));
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

  test('resume 失败且 stream throw → 文案附 caught 原因，仍 resumeFailed + recoverable:false', async () => {
    let exited = false;
    const { s, events } = makeSession({ resumeId: 'bad-id', onExit() { exited = true; } });
    s.sawInit = false;

    const fakeQ = {
      [Symbol.asyncIterator]() {
        return {
          next() { return Promise.reject(new Error('process exited with code 1')); }
        };
      }
    };
    await s.consume(fakeQ);

    assert.equal(s.resumeFailed, true);
    assert.equal(exited, true);
    const err = events.find(e => e.type === 'error' && !e.payload.recoverable);
    assert.ok(err);
    assert.ok(err.payload.message.includes('无法恢复会话'));
    assert.ok(err.payload.message.includes('process exited with code 1'));
    s.dispose();
  });

  test('resume 撞 background agent 锁 → 文案含后台 agent，不含「历史被清理」', async () => {
    let exited = false;
    const { s, events } = makeSession({ resumeId: 'bg-locked', onExit() { exited = true; } });
    s.sawInit = false;
    const fakeQ = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.reject(new Error(
              'Session bg-locked is currently running as a background agent (bg). Use claude agents…',
            ));
          },
        };
      },
    };
    await s.consume(fakeQ);
    assert.equal(s.resumeFailed, true);
    assert.equal(exited, true);
    const err = events.find(e => e.type === 'error' && !e.payload.recoverable);
    assert.ok(err);
    assert.match(err.payload.message, /后台 agent/);
    assert.doesNotMatch(err.payload.message, /历史可能已被清理/);
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
    assert.ok(err.payload.message.includes('进程异常'));
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
    const { s } = makeSession({ onExit() { exited = true; } });
    s.disposed = true;

    const fakeQ = {
      [Symbol.asyncIterator]() { return { next() { return Promise.resolve({ done: true }); } }; }
    };
    await s.consume(fakeQ);

    assert.equal(exited, false);
    s.dispose();
  });

  test('consume 清理：pendingTurns 清零、denyKinds clear、pendingPermissions 全部 deny', async () => {
    const { s } = makeSession();
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
      createdAt: 111,
      expiresAt: 222,
    });
    const snap = s.pendingRequestsSnapshot();
    // 对齐 CLI rich options：字符串选项也会归一成 {label}；multiSelect 缺省 false
    // AG-NEW-001：createdAt/expiresAt 与 live emit('question') 对称
    assert.deepEqual(snap.questions, [{
      requestId: 'tool_1#0', text: 'Q0?', header: undefined, multiSelect: false,
      options: [{ label: 'A' }, { label: 'B' }],
      createdAt: 111, expiresAt: 222,
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
