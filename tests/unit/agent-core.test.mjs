// tests/unit/agent-core.test.mjs —— AgentSession 的基础件：构造、忙判定、事件环形缓冲
// isBusy 是【综合】忙判定（BE-008）：pendingTurns 与后台任务任一非空都算忙。
// 这一点与 /health.busy 只认 pendingTurns（OPS-04）刻意不同——切 effort 档要用综合判定，
// 否则会在后台任务还跑着的时候误杀它；而运维探针要的是「有没有在途轮」。两个判据别混用。
// 覆盖：isBusy 各组合 · 构造函数 · emit/buffer/eventsSince · sdkChildEnv 的 origin 标记不可被调用方覆盖
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, buildAgentQueryOptions } from '../../app/src/agent/agent.js';
import { sdkChildEnv } from '../../app/src/shared/child-env.js';
import { makeSession } from '../helpers/agent-unit.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 两个 origin 标记都必须由本函数强制注入、调用方不可覆盖：statusline wrapper 据前者不捕获快照，
// hooks runner 据后者直接退出——SDK 会话 settingSources 含 'user' 会加载用户全局 hooks，不抑制则
// web 自己驱动的每轮都被自己的 Stop hook 再推一次通知。
test('sdkChildEnv：SDK 子进程带项目自有 origin 标记且调用方不能覆盖', () => {
  assert.deepEqual(sdkChildEnv({
    KEEP: 'yes', EMPTY: '', CCM_STATUSLINE_ORIGIN: 'terminal', CCM_HOOKS_ORIGIN: 'terminal',
  }), {
    KEEP: 'yes',
    CCM_STATUSLINE_ORIGIN: 'web-sdk',
    CCM_HOOKS_ORIGIN: 'web-sdk',
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
    const { s } = makeSession();
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
    const { s } = makeSession();
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

// maybeSuggest 的时序闸。
//
// 【为什么 pendingTurns 那道不够】它只看得见**还在跑**的新一轮。askSide 慢、用户又在这期间起了
// 一轮**短**的并跑完时，pendingTurns 已经回到 0，闸恰好失效——这条对上一轮说的建议就落进了新
// 对话。前端 7380ba3 修的是展示侧（新一轮开跑即收起 + _busyState 闸），而那道闸在「新一轮已经
// 跑完」时同样是 idle，两侧都不挡。completedTurns 每收一条 result 就 +1，拿它当序号才覆盖得住。
test.describe('maybeSuggest：迟到的建议不得落进新对话', () => {
  test('askSide 期间又结算了一轮 → 丢弃', async () => {
    const { s, events, dispose } = makeSession();
    try {
      s.completedTurns = 2;                     // shouldSuggest 要求 >= 2
      let release;
      s.askSide = () => new Promise(r => { release = r; });
      const p = s.maybeSuggest({});
      // 用户起了一轮短的并跑完：pendingTurns 回到 0（那道闸失效），但 completedTurns 前进了
      s.completedTurns = 3;
      s.pendingTurns = 0;
      release('下一步试试 X');
      assert.equal(await p, false, '对上一轮说的建议被发进了新对话');
      assert.equal(events.filter(e => e.type === 'prompt_suggestion').length, 0);
    } finally { dispose(); }
  });

  test('期间什么都没发生 → 照常发出（证明这道闸不是恒不发）', async () => {
    const { s, events, dispose } = makeSession();
    try {
      s.completedTurns = 2;
      s.pendingTurns = 0;
      s.askSide = async () => '下一步试试 X';
      assert.equal(await s.maybeSuggest({}), true);
      const sent = events.filter(e => e.type === 'prompt_suggestion');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].payload.text, '下一步试试 X');
    } finally { dispose(); }
  });

  test('新一轮仍在跑（pendingTurns>0）→ 照旧丢弃，既有闸不得被改坏', async () => {
    const { s, events, dispose } = makeSession();
    try {
      s.completedTurns = 2;
      s.askSide = async () => '下一步试试 X';
      s.pendingTurns = 1;
      assert.equal(await s.maybeSuggest({}), false);
      assert.equal(events.filter(e => e.type === 'prompt_suggestion').length, 0);
    } finally { dispose(); }
  });
});

// 接线：hasPriorHistory 必须真的从 resumeId 推出来并送进两道判据，否则 side-question.js 那组
// 用例全绿而产品行为一点没变（判据改对了、没人传）。
test.describe('hasPriorHistory 接线', () => {
  test('resume 进来的会话 → true；全新会话 → false', () => {
    const fresh = makeSession();
    const resumed = makeSession({ resumeId: 'sess-abc' });
    try {
      assert.equal(fresh.s.hasPriorHistory, false);
      assert.equal(resumed.s.hasPriorHistory, true);
    } finally { fresh.dispose(); resumed.dispose(); }
  });

  test('resume 的会话第一轮就给建议（本进程 completedTurns 还是 0）', async () => {
    const { s, events, dispose } = makeSession({ resumeId: 'sess-abc' });
    try {
      s.completedTurns = 0;
      s.pendingTurns = 0;
      s.askSide = async () => '继续修那个测试';
      assert.equal(await s.maybeSuggest({}), true, 'resume 回来的老会话被当成刚开的，第一轮建议被抑制');
      assert.equal(events.filter(e => e.type === 'prompt_suggestion').length, 1);
    } finally { dispose(); }
  });

  test('全新会话第一轮仍不给（门槛没被顺手拆掉）', async () => {
    const { s, events, dispose } = makeSession();
    try {
      s.completedTurns = 0;
      s.pendingTurns = 0;
      s.askSide = async () => '不该出现';
      assert.equal(await s.maybeSuggest({}), false);
      assert.equal(events.filter(e => e.type === 'prompt_suggestion').length, 0);
    } finally { dispose(); }
  });
});

// 会话中途换 cwd（EnterWorktree / ExitWorktree）。
//
// 【为什么实例的 cwd 必须跟着走】2026-09-13 真机形态：会话在父仓开，中途 EnterWorktree 进
// `.claude/worktrees/<name>`，CLI 把整份 transcript 迁到新 cwd 的 project 目录、父仓那边一个字节不留。
// 实例 cwd 停在父仓的话，getSessionHistory / scanSubagents / resume / saveAttachments 全部按一个
// 已经空掉的目录解析——用户侧的症状是切回会话「历史消息加载失败」，而磁盘上那份 transcript 完好。
//
// 【为什么采信权在 server 而不在这里】new_cwd 源自 EnterWorktree 的 path 参数，属用户可控面，
// 必须过白名单判据（SCOPE-01），而白名单的真相源在 server。这里只负责上报 + 按裁决写回。
test.describe('AgentSession — 会话中途换 cwd', () => {
  const cwdHook = (opts) => {
    const { s, dispose } = makeSession(opts);
    s.abort = new AbortController();
    const hook = buildAgentQueryOptions(s, { ...process.env })?.hooks?.CwdChanged?.[0]?.hooks?.[0];
    return { s, dispose, hook };
  };

  test('装了 CwdChanged hook——没有它，CLI 换了 cwd 服务端永远不会知道', () => {
    const { dispose, hook } = cwdHook();
    try {
      assert.equal(typeof hook, 'function', 'hook 缺席 = 这条修复整条不存在，且症状与没修一模一样');
    } finally { dispose(); }
  });

  test('server 采信时写回新 cwd', async () => {
    const seen = [];
    const { s, dispose, hook } = cwdHook({
      cwd: '/tmp/repo',
      onCwdChanged: (next, prev) => { seen.push([prev, next]); return '/tmp/repo/.claude/worktrees/wt'; },
    });
    try {
      await hook({ hook_event_name: 'CwdChanged', old_cwd: '/tmp/repo', new_cwd: '/tmp/repo/.claude/worktrees/wt' });
      assert.equal(s.cwd, '/tmp/repo/.claude/worktrees/wt');
      assert.deepEqual(seen, [['/tmp/repo', '/tmp/repo/.claude/worktrees/wt']]);
    } finally { dispose(); }
  });

  test('server 拒绝时 cwd 保持原样——越界的新 cwd 不得改写驾驶轴', async () => {
    const { s, dispose, hook } = cwdHook({ cwd: '/tmp/repo', onCwdChanged: () => null });
    try {
      await hook({ hook_event_name: 'CwdChanged', old_cwd: '/tmp/repo', new_cwd: '/etc' });
      assert.equal(s.cwd, '/tmp/repo', '拒绝必须是"保持原样"，不是回退到别的目录');
    } finally { dispose(); }
  });

  // 采信的是 server 归一后的那个值（realpath 解析过），不是 CLI 报来的原串——macOS 上
  // /var 与 /private/var 是同一个目录的两种写法，存未解析的那个会让 getProjectDir 静默查空。
  test('写回的是 server 归一后的路径，不是 CLI 报来的原串', async () => {
    const { s, dispose, hook } = cwdHook({ cwd: '/tmp/repo', onCwdChanged: () => '/private/tmp/repo/.claude/worktrees/wt' });
    try {
      await hook({ hook_event_name: 'CwdChanged', old_cwd: '/tmp/repo', new_cwd: '/tmp/repo/.claude/worktrees/wt' });
      assert.equal(s.cwd, '/private/tmp/repo/.claude/worktrees/wt');
    } finally { dispose(); }
  });

  // 改了 cwd 却不重播 instances，前端的 entry.cwd / panelCwd 会一直停在旧值——
  // 那正是这条修复要治的症状，只是病灶从 agent 挪到了广播链上，看起来与没修一模一样。
  test('采信后触发 onStateSettled 重播 instances', async () => {
    let settled = 0;
    const { s, dispose, hook } = cwdHook({
      cwd: '/tmp/repo',
      onCwdChanged: () => '/tmp/repo/.claude/worktrees/wt',
      onStateSettled: () => { settled += 1; },
    });
    try {
      await hook({ hook_event_name: 'CwdChanged', old_cwd: '/tmp/repo', new_cwd: '/tmp/repo/.claude/worktrees/wt' });
      assert.equal(settled, 1, '不广播 = 前端 entry.cwd 停在旧值，症状与完全没修一样');
      assert.equal(s.cwd, '/tmp/repo/.claude/worktrees/wt');
    } finally { dispose(); }
  });

  test('拒绝时不重播——没有状态变化就不该惊动前端', async () => {
    let settled = 0;
    const { dispose, hook } = cwdHook({
      cwd: '/tmp/repo', onCwdChanged: () => null, onStateSettled: () => { settled += 1; },
    });
    try {
      await hook({ hook_event_name: 'CwdChanged', old_cwd: '/tmp/repo', new_cwd: '/etc' });
      assert.equal(settled, 0);
    } finally { dispose(); }
  });

  // 【为什么这条是源码断言而不是行为断言】上面每一条在「server 压根没传 onCwdChanged」时都照样全绿——
  // agent 侧的裁决协议是对的，只是没人接。而没人接时的用户症状与完全没修一模一样（切回会话
  // 历史消息加载失败）。行为层要复现这条需要真 CLI 真的执行一次 EnterWorktree，属 S5。
  // 这就是 docs/testing.md §5 说的「架构守卫」形态：没有行为等价物，留在源码层。
  test('server 真的把裁决接上了——agent 侧协议再对，没人接也等于没修', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../app/src/server/app.js'), 'utf8',
    );
    assert.match(src, /onCwdChanged:\s*\(/, 'app.js 没给驾驶实例传 onCwdChanged，换 cwd 后实例仍停在旧目录');
    assert.match(src, /resolveDrivingCwd\(/, '裁决必须走 resolveDrivingCwd（SCOPE-01 同源判据），不得自行放行');
  });

  test('没接 onCwdChanged 时不改 cwd、也不抛——裁决方缺席即视为不采信', async () => {
    const { s, dispose, hook } = cwdHook({ cwd: '/tmp/repo' });
    try {
      await hook({ hook_event_name: 'CwdChanged', old_cwd: '/tmp/repo', new_cwd: '/tmp/elsewhere' });
      assert.equal(s.cwd, '/tmp/repo');
    } finally { dispose(); }
  });
});
