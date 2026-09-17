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

// H1（2026-09-17 安全审查）：这里此前把整份 process.env 原样传给 claude，而 server 会把
// ccm.config.json 的值投影进 process.env（app/src/ops/config.js 的投影循环）。于是 AUTH_TOKEN /
// VAPID 私钥 / ntfy 令牌都进了子进程——**比用户终端里的 claude 更宽**：在普通终端里跑 claude，
// 进程环境里根本没有这几个键，它们只存在于 CCM 自己的配置文件里。
//
// 后果不是"又一次本地 shell"：工作区里的提示注入 + 一次已放行的 Bash，模型就能 `echo $AUTH_TOKEN`。
// 拿到的是 Web 控制面钥匙，公网绑着时等于远程入口凭据。
//
// 剥掉它们**不违反**"终端等价性"，恰恰是恢复它：终端里的 claude 本来就没有这些。
test('sdkChildEnv：剥掉 CCM 自己的控制面密钥（AUTH_TOKEN / VAPID_* / NTFY_* / CF_ACCESS_*）', () => {
  const out = sdkChildEnv({
    AUTH_TOKEN: 'ccm-control-plane-key',
    VAPID_PRIVATE_KEY: 'vapid-priv',
    VAPID_PUBLIC_KEY: 'vapid-pub',
    VAPID_SUBJECT: 'mailto:someone@example.com',
    NTFY_TOKEN: 'ntfy-tk',
    NTFY_TOPIC: 'my-secret-topic',
    NTFY_URL: 'https://ntfy.sh',
    CF_ACCESS_AUD: 'aud-value',
    CF_ACCESS_HOSTNAME: 'ccm.example.com',
    CF_ACCESS_TEAM: 'myteam',
  });
  for (const key of Object.keys(out)) {
    assert.ok(!key.startsWith('VAPID_'), `VAPID_* 不得进子进程：${key}`);
    assert.ok(!key.startsWith('NTFY_'), `NTFY_* 不得进子进程：${key}`);
    assert.ok(!key.startsWith('CF_ACCESS_'), `CF_ACCESS_* 不得进子进程：${key}`);
  }
  assert.ok(!Object.hasOwn(out, 'AUTH_TOKEN'), 'AUTH_TOKEN 是控制面钥匙，绝不进子进程');
  // 值层面也查一遍：换个键名把同一个秘密带出去，上面的键名断言看不见。
  const values = Object.values(out);
  assert.ok(!values.includes('ccm-control-plane-key'));
  assert.ok(!values.includes('vapid-priv'));
  assert.ok(!values.includes('my-secret-topic'));
});

// 反向：剥得过头会静默砍掉第三方网关那条支持路径（走网关的用户靠 shell 里 export 的 ANTHROPIC_*
// 生效），而症状是"claude 在 web 里连不上网关、在终端里好好的"，很难归因到这一行。
// 两侧都断言，缺一侧就只证明了"改动有效"或"改动无害"中的一个。
test('sdkChildEnv：claude 自己那份环境原样透传（终端等价性不能被剥没）', () => {
  const out = sdkChildEnv({
    ANTHROPIC_BASE_URL: 'https://gateway.example',
    ANTHROPIC_AUTH_TOKEN: 'gateway-key',
    ANTHROPIC_API_KEY: 'sk-x',
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    NO_PROXY: 'localhost',
    PATH: '/usr/bin',
    HOME: '/home/u',
  });
  assert.equal(out.ANTHROPIC_BASE_URL, 'https://gateway.example');
  assert.equal(out.ANTHROPIC_AUTH_TOKEN, 'gateway-key', '网关凭据是 claude 的，不是 CCM 的——不能剥');
  assert.equal(out.ANTHROPIC_API_KEY, 'sk-x');
  assert.equal(out.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  assert.equal(out.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(out.HTTP_PROXY, 'http://127.0.0.1:7890');
  assert.equal(out.NO_PROXY, 'localhost');
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.HOME, '/home/u');
});

// 漂移闸：child-env.js 在 src/shared（叶子层），**不能** import src/ops 的 env-schema —— 模块边界
// 守卫会拦（check 一环）。所以那份剥离清单只能是硬编码的，而硬编码清单会随 schema 新增密钥而过期，
// 且过期的表现是"新密钥照样进子进程"，没有任何东西会报错。
// 这条测试就是那个报错：schema 里每一个标了密钥的键，都必须被 sdkChildEnv 剥掉。
test('sdkChildEnv：env-schema 里每一个密钥键都必须被剥掉（防清单随 schema 漂移）', async () => {
  const { ENV_SCHEMA } = await import('../../app/src/ops/env-schema.js');
  // 与 env-schema.js 内部 buildEnvView 同一条判据（`!!def.secret || def.kind === 'secret'`）
  const secretKeys = Object.entries(ENV_SCHEMA)
    .filter(([, def]) => !!def.secret || def.kind === 'secret')
    .map(([key]) => key);

  assert.ok(secretKeys.length >= 4, `schema 里应有若干密钥键，实际 ${secretKeys.length} 个——判据可能改了`);
  const probe = Object.fromEntries(secretKeys.map(k => [k, `SECRET_VALUE_OF_${k}`]));
  const out = sdkChildEnv(probe);
  for (const key of secretKeys) {
    assert.ok(!Object.hasOwn(out, key),
      `env-schema 把 ${key} 标成了密钥，但 child-env.js 的剥离清单漏了它——把它加进去`);
  }
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

  // 【为什么光改 instance.cwd 不够】openInstance 的回调闭包捕获的是**开实例那一刻**的 cwd。
  // 会话中途 EnterWorktree 之后，凡是「本实例 cwd」语义的消费点若还读那个闭包值就会分叉，
  // 其中 writeSessionEntrypoint 最险：/clear 拿到新 sid 时它的 `!getSession(sid)` 守卫会放行，
  // 于是在**父仓**的 project 目录里凭空造出一个只含 entrypoint-marker 的 <新sid>.jsonl。
  // 那之后 sessionFileExists(父仓) 变成 true——本修复治的「报错 + 空白」退化成「不报错 + 空白」，
  // 更隐蔽；那个幽灵文件还会让会话在父仓与 worktree 两个列表里各出现一次。
  test('换 cwd 后「本实例 cwd」的消费点走驾驶轴，不是开实例时的闭包值', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../app/src/server/app.js'), 'utf8',
    );
    assert.match(src, /writeSessionEntrypoint\(sid,\s*drivingCwd\)/,
      'entrypoint 写进旧 cwd 的 project 目录 = 在父仓造幽灵 jsonl，把「查不到」变成「查到一个空的」');
    assert.match(src, /cwd:\s*drivingCwd,\s*routeCwd:\s*cwd/,
      '条目 cwd 必须是驾驶轴、路由键必须是工作区轴——两轴合一时必有一条是错的');
    assert.match(src, /recordCwdDefaultModel\(drivingCwd,/,
      'defaultModelByCwd 的消费方是 viewingCwdOf()（驾驶轴），归键必须同轴');
    assert.match(src, /slashCommandsCache\.set\(drivingCwd,/,
      'slash/models 缓存的消费方 pushSlashCommandsForCwd(a.cwd) 是驾驶轴，归键必须同轴');
    assert.match(src, /modelsCache\.set\(drivingCwd,/);
  });

  test('没接 onCwdChanged 时不改 cwd、也不抛——裁决方缺席即视为不采信', async () => {
    const { s, dispose, hook } = cwdHook({ cwd: '/tmp/repo' });
    try {
      await hook({ hook_event_name: 'CwdChanged', old_cwd: '/tmp/repo', new_cwd: '/tmp/elsewhere' });
      assert.equal(s.cwd, '/tmp/repo');
    } finally { dispose(); }
  });
});
