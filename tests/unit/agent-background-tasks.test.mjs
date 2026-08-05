import test from 'node:test';
import assert from 'node:assert/strict';
import { getSessionLogs } from '../../src/agent/interaction-log.js';
import { buildAgentQueryOptions } from '../../src/agent/agent.js';
import { makeSession } from '../helpers/agent-unit.mjs';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir } from '../../src/sessions/history.js';

test.describe('buildAgentQueryOptions — 后台进度加强开关', () => {
  test('默认 agentProgressSummaries=true（~30s AI 进度 summary）', () => {
    const { s } = makeSession();
    s.abort = new AbortController();
    const opts = buildAgentQueryOptions(s, { ...process.env });
    assert.equal(opts.agentProgressSummaries, true);
    assert.equal(opts.forwardSubagentText, true);
    assert.equal(opts.includePartialMessages, true);
    s.dispose();
  });

  test('CCM_AGENT_PROGRESS_SUMMARIES=0 可关（省 fork token）', () => {
    const { s } = makeSession();
    s.abort = new AbortController();
    const opts = buildAgentQueryOptions(s, { ...process.env, CCM_AGENT_PROGRESS_SUMMARIES: '0' });
    assert.equal(opts.agentProgressSummaries, false);
    s.dispose();
  });
});

// 2270453 fix(security): resolvedEnv（worktree settings.local.json 的 env 块）曾不加过滤直接 spread 进
// 子进程环境，能覆盖 PORT/AUTH_TOKEN/CCM_DATA_DIR 等服务端关键变量；白名单只放行 ANTHROPIC_*/CLAUDE_CODE_*。
test.describe('buildAgentQueryOptions — resolvedEnv 白名单（防 worktree settings 覆盖服务端关键变量）', () => {
  test('PORT/AUTH_TOKEN/CCM_DATA_DIR 等非白名单 key 被过滤，不覆盖服务端原值', () => {
    const { s } = makeSession();
    s.resolvedEnv = { PORT: '9999', AUTH_TOKEN: 'stolen', CCM_DATA_DIR: '/evil' };
    const opts = buildAgentQueryOptions(s, { PORT: '3000', AUTH_TOKEN: 'real-secret', CCM_DATA_DIR: '/real' });
    assert.equal(opts.env.PORT, '3000', 'worktree resolvedEnv 不得覆盖服务端 PORT');
    assert.equal(opts.env.AUTH_TOKEN, 'real-secret', 'worktree resolvedEnv 不得覆盖服务端 AUTH_TOKEN');
    assert.equal(opts.env.CCM_DATA_DIR, '/real', 'worktree resolvedEnv 不得覆盖服务端 CCM_DATA_DIR');
    s.dispose();
  });

  test('ANTHROPIC_*/CLAUDE_CODE_* 前缀正常放行（worktree 网关/模型映射的预期用途）', () => {
    const { s } = makeSession();
    s.resolvedEnv = { ANTHROPIC_BASE_URL: 'https://gateway.example.com', CLAUDE_CODE_FOO: 'bar' };
    const opts = buildAgentQueryOptions(s, { ...process.env });
    assert.equal(opts.env.ANTHROPIC_BASE_URL, 'https://gateway.example.com');
    assert.equal(opts.env.CLAUDE_CODE_FOO, 'bar');
    s.dispose();
  });

  test('大小写不绕过：小写前缀不视为合法 key', () => {
    const { s } = makeSession();
    s.resolvedEnv = { anthropic_base_url: 'https://evil.example.com' };
    const opts = buildAgentQueryOptions(s, { ...process.env });
    assert.equal(opts.env.anthropic_base_url, undefined, '小写前缀不应被放行');
    s.dispose();
  });

  test('空/undefined resolvedEnv 安全，不影响 env', () => {
    const { s } = makeSession();
    s.resolvedEnv = undefined;
    const opts = buildAgentQueryOptions(s, { ...process.env, PORT: '3000' });
    assert.equal(opts.env.PORT, '3000');
    s.dispose();
  });

  test('原型污染键（JSON.parse 出的 __proto__ 自有属性）不生效、不污染 Object.prototype', () => {
    const { s } = makeSession();
    s.resolvedEnv = JSON.parse('{"__proto__": {"polluted": "yes"}, "ANTHROPIC_API_KEY": "ok"}');
    const opts = buildAgentQueryOptions(s, { ...process.env });
    assert.equal(({}).polluted, undefined, 'Object.prototype 不应被污染');
    assert.equal(opts.env.ANTHROPIC_API_KEY, 'ok', '合法 key 仍正常放行');
    s.dispose();
  });
});

test.describe('map() — 后台任务通知（task_notification）', () => {
  test('system/task_notification → emit(source:system) + 武装 pendingAutoTurn，pendingTurns 不变', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'task_notification', task_id: 'w60tplm3a',
      tool_use_id: 'toolu_01', status: 'completed', summary: '深度调研完成', output_file: '/tmp/out.md' });
    const ev = events.find(e => e.type === 'task_notification');
    assert.ok(ev, '应 emit task_notification');
    assert.equal(ev.payload.source, 'system');
    assert.equal(ev.payload.taskId, 'w60tplm3a');
    assert.equal(ev.payload.status, 'completed');
    assert.equal(ev.payload.summary, '深度调研完成');
    assert.equal(ev.payload.toolUseId, 'toolu_01');
    assert.equal(ev.payload.outputFile, '/tmp/out.md');
    assert.equal(s.pendingAutoTurn, true);
    assert.equal(s.pendingTurns, 0); // 通知本身不启轮
    s.dispose();
  });

  test('user 字符串注入 <task-notification> → 武装 flag + emit(source:user_injection)，pendingTurns 不变', () => {
    const { s, events } = makeSession();
    // 实证形态：content 是纯字符串（终端 jsonl d8e59a10 第 26 行）
    s.map({ type: 'user', message: { content:
      '<task-notification>\n<task-id>w60tplm3a</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>/tmp/out.md</output-file>\n</task-notification>' } });
    const ev = events.find(e => e.type === 'task_notification');
    assert.ok(ev, '字符串 content 也应识别');
    assert.equal(ev.payload.source, 'user_injection');
    assert.equal(ev.payload.taskId, 'w60tplm3a');
    assert.equal(ev.payload.toolUseId, 'toolu_01');
    assert.equal(s.pendingAutoTurn, true);
    assert.equal(s.pendingTurns, 0);
    s.dispose();
  });

  test('user text-block 数组形态的 <task-notification> → 同样识别', () => {
    const { s, events } = makeSession();
    s.map({ type: 'user', message: { content: [
      { type: 'text', text: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>' }
    ] } });
    const ev = events.find(e => e.type === 'task_notification');
    assert.ok(ev);
    assert.equal(ev.payload.source, 'user_injection');
    assert.equal(ev.payload.taskId, 'abc');
    s.dispose();
  });

  test('4 条注入合并 1 轮：4 注入 + 1 message_start → pendingTurns=1（合并轮情形）', () => {
    const { s } = makeSession();
    for (let i = 0; i < 4; i++) {
      s.map({ type: 'user', message: { content: `<task-notification>\n<task-id>t${i}</task-id>\n</task-notification>` } });
    }
    assert.equal(s.pendingTurns, 0); // 注入不直接 ++
    assert.equal(s.pendingAutoTurn, true);
    s.map({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, parent_tool_use_id: null, uuid: 'u1' });
    assert.equal(s.pendingTurns, 1, '合并轮只合成一次');
    assert.equal(s.pendingAutoTurn, false, 'flag 消费后清零');
    s.dispose();
  });

  test('逐轮情形：注入→轮→result→再注入→再轮 → 每轮各合成一次', () => {
    const { s } = makeSession();
    s.map({ type: 'user', message: { content: '<task-notification>\n<task-id>a</task-id>\n</task-notification>' } });
    s.map({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, parent_tool_use_id: null, uuid: 'u1' });
    assert.equal(s.pendingTurns, 1);
    s.map({ type: 'result', subtype: 'success', duration_ms: 10, modelUsage: {} });
    assert.equal(s.pendingTurns, 0);
    s.map({ type: 'user', message: { content: '<task-notification>\n<task-id>b</task-id>\n</task-notification>' } });
    s.map({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } }, parent_tool_use_id: null, uuid: 'u2' });
    assert.equal(s.pendingTurns, 1, '第二轮独立合成');
    s.dispose();
  });

  test('回归锚点：无 flag 的 message_start（pendingTurns=0）不得合成（防 auto-compact 误伤）', () => {
    const { s } = makeSession();
    assert.equal(s.pendingAutoTurn, false);
    s.map({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, parent_tool_use_id: null, uuid: 'u1' });
    assert.equal(s.pendingTurns, 0, '无 pendingAutoTurn 不合成');
    s.dispose();
  });

  test('assistant 兜底合成（非流式网关无 message_start）：pendingAutoTurn + assistant → pendingTurns=1', () => {
    const { s } = makeSession();
    s.pendingAutoTurn = true;
    s.pendingAutoTurnAt = Date.now(); // 新鲜武装（TTL 内）
    s.map({ type: 'assistant', message: { content: [{ type: 'text', text: '报告正文' }] }, uuid: 'a1' });
    assert.equal(s.pendingTurns, 1);
    assert.equal(s.pendingAutoTurn, false);
    s.dispose();
  });

  test('普通 user 文本（非通知）→ 不触发、pendingTurns/flag 不动（回归）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'user', message: { content: '这是一条普通用户消息' } });
    assert.equal(events.find(e => e.type === 'task_notification'), undefined);
    assert.equal(s.pendingAutoTurn, false);
    assert.equal(s.pendingTurns, 0);
    s.dispose();
  });

  test('以 <task-notification> 开头但无闭合标签 → 不误判为注入（收紧）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'user', message: { content: '<task-notification> 这个标签啥意思' } }); // 无 </task-notification>
    assert.equal(events.find(e => e.type === 'task_notification'), undefined);
    assert.equal(s.pendingAutoTurn, false);
    s.dispose();
  });

  test('合成轮受 checkIdle 静默看护（静默超限 → terminating）', () => {
    const { s } = makeSession({ idleTimeoutMs: 1000 });
    s.map({ type: 'user', message: { content: '<task-notification>\n<task-id>a</task-id>\n</task-notification>' } });
    s.map({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, parent_tool_use_id: null, uuid: 'u1' });
    assert.equal(s.pendingTurns, 1);
    s.lastActivity = 0; // 远古静默
    s.q = { setModel: async () => {} }; // checkIdle 内 abort 前置
    s.abort = { abort: () => {} };
    s.checkIdle();
    assert.equal(s.terminating, true, '合成轮也被看护，不会永挂');
    s.dispose();
  });

  test('未映射 SDK 消息 type → 不抛错 + 记入日志抽屉（可观测性）', () => {
    const { s } = makeSession({ resumeId: 'sess-bogus' });
    assert.doesNotThrow(() => s.map({ type: 'bogus_never_seen' }));
    const logs = getSessionLogs('sess-bogus');
    assert.ok(logs.some(l => l.type === 'sys_info' && l.text.includes('未映射 SDK 消息 type=bogus_never_seen')));
    s.dispose();
  });

  test('system/task_progress → 瞬时广播进度事件（transient，不进 replay buffer）、不记未映射、不武装汇报轮', () => {
    const { s, events } = makeSession({ resumeId: 'sess-prog' });
    const bufBefore = s.buffer.length;
    // SDK 对每个 running 后台任务周期性推送的进度心跳；高频——须走 emitTransient 旁路，
    // 否则进 buffer 挤爆环形缓冲、占 seq 制造空洞误判 gap
    s.map({ type: 'system', subtype: 'task_progress', task_id: 't1', task_type: 'local_agent', message: '正在跑测试…' });
    const prog = events.find(e => e.type === 'task_progress');
    assert.ok(prog, '应 emit task_progress 供前端原地刷新进度横幅');
    assert.equal(prog.transient, true, '瞬时事件：前端据此带外分流、不占 seq / 不更新 lastSeq');
    assert.equal(prog.payload.message, '正在跑测试…');
    assert.equal(prog.payload.taskId, 't1');
    // 同一心跳还把该任务登记为"活的后台任务"→ 驱动纯后台 busy 角标（⏳/🤖/🖥），但不改 pendingTurns、不进 buffer
    assert.equal(s.hasBgTasks(), true, 'task_progress 应把任务登记进 bgTasks（驱动会话列表 ⏳）');
    assert.equal(s.bgTaskSummary()?.taskType, 'local_agent', 'bgTaskSummary 带回 task_type 供 server 映射 activeTool（🤖/🖥）');
    assert.equal(s.buffer.length, bufBefore, '瞬时事件不进 replay buffer（防高频进度挤爆环形缓冲）');
    const logs = getSessionLogs('sess-prog');
    assert.ok(!logs.some(l => l.text.includes('未映射')), 'task_progress 不该被记为未映射子类型');
    assert.equal(s.pendingAutoTurn, false, '进度不触发汇报轮（区别于 task_notification 完成通知）');
    s.dispose();
  });

  test('system/hook_* 生命周期事件 → 不记未映射、不进 buffer、不启轮（高频噪声，静默吞）', () => {
    const { s } = makeSession({ resumeId: 'sess-hook' });
    const bufBefore = s.buffer.length;
    // 新版 SDK 每次 hook 运行推送 hook_started + hook_progress（后者高频）；属已知生命周期噪声，
    // 与 task_progress 同类——须显式识别后不落交互日志抽屉（否则连续刷屏），也不进 buffer、不启汇报轮。
    assert.doesNotThrow(() => {
      s.map({ type: 'system', subtype: 'hook_started', hook_name: 'PreToolUse' });
      s.map({ type: 'system', subtype: 'hook_progress', hook_name: 'PreToolUse' });
    });
    const logs = getSessionLogs('sess-hook');
    assert.ok(!logs.some(l => l.text.includes('未映射')), 'hook_* 子类型不该被记为未映射（否则日志刷屏）');
    assert.equal(s.buffer.length, bufBefore, 'hook 生命周期事件不进 replay buffer');
    assert.equal(s.pendingAutoTurn, false, 'hook 事件不触发汇报轮');
    s.dispose();
  });

  test('system/thinking_tokens → 不记未映射、不进 buffer、不启轮（高频噪声，静默吞）', () => {
    const { s, events } = makeSession({ resumeId: 'sess-system-noise' });
    const bufBefore = s.buffer.length;
    const eventCountBefore = events.length;
    assert.doesNotThrow(() => {
      s.map({ type: 'system', subtype: 'thinking_tokens', tokens: 2 });
    });
    const logs = getSessionLogs('sess-system-noise');
    assert.ok(!logs.some(l => l.text.includes('未映射')), 'thinking_tokens 不该被记为未映射（否则日志刷屏）');
    assert.equal(s.buffer.length, bufBefore, 'thinking_tokens 不进 replay buffer');
    assert.equal(events.length, eventCountBefore, 'thinking_tokens 不广播 agent:event');
    assert.equal(s.pendingAutoTurn, false, 'thinking_tokens 不触发汇报轮');
    s.dispose();
  });

  // api_retry：CLI 会显 "Retrying in Ns · attempt i/max"；web 对齐为瞬时横幅（emitTransient），
  // 不进 buffer、不占 seq、不启轮——与 task_progress 同类，避免重连回放一堆过期重试行。
  test('system/api_retry → emitTransient(api_retry)，不进 buffer、不占 seq、不启轮', () => {
    const { s, events } = makeSession({ resumeId: 'sess-api-retry' });
    const bufBefore = s.buffer.length;
    const seqBefore = s.seq;
    s.map({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 4000,
      error_status: 429,
      error: 'rate_limit',
    });
    const logs = getSessionLogs('sess-api-retry');
    assert.ok(!logs.some(l => l.text.includes('未映射')), 'api_retry 是已知子类型，不记未映射');
    assert.equal(s.buffer.length, bufBefore, 'api_retry 不进 replay buffer');
    assert.equal(s.seq, seqBefore, 'api_retry 不递增 seq');
    assert.equal(s.pendingAutoTurn, false, 'api_retry 不触发汇报轮');
    const retry = events.filter(e => e.type === 'api_retry');
    assert.equal(retry.length, 1);
    assert.equal(retry[0].transient, true);
    assert.deepEqual(retry[0].payload, {
      attempt: 2,
      maxRetries: 10,
      delayMs: 4000,
      errorStatus: 429,
      error: 'rate_limit',
    });
    s.dispose();
  });

  test('system/api_retry 兼容旧字段 delay_ms，缺字段安全', () => {
    const { s, events } = makeSession({ resumeId: 'sess-api-retry-legacy' });
    s.map({ type: 'system', subtype: 'api_retry', attempt: 1, delay_ms: 1500 });
    const retry = events.find(e => e.type === 'api_retry');
    assert.ok(retry);
    assert.equal(retry.payload.attempt, 1);
    assert.equal(retry.payload.delayMs, 1500);
    assert.equal(retry.payload.maxRetries, null);
    assert.equal(retry.payload.errorStatus, null);
    assert.equal(retry.payload.error, null);
    s.dispose();
  });

  // ---- pendingAutoTurn 复位 + TTL 门（防 sticky flag 卡死会话）----
  test('interrupt() 复位 pendingAutoTurn（用户显式停止，无自动汇报可期）', async () => {
    const { s } = makeSession();
    s.pendingAutoTurn = true;
    s.q = { interrupt: async () => {} };
    await s.interrupt();
    assert.equal(s.pendingAutoTurn, false);
    s.dispose();
  });

  test('dispose() 复位 pendingAutoTurn（实例销毁不留残留 flag）', () => {
    const { s } = makeSession();
    s.pendingAutoTurn = true;
    s.dispose();
    assert.equal(s.pendingAutoTurn, false);
  });

  test('TTL 门：flag 武装但超时（pendingAutoTurnAt 远古）→ message_start 不合成且清 flag', () => {
    const { s } = makeSession();
    s.pendingAutoTurn = true;
    s.pendingAutoTurnAt = 1; // 远古时间戳，远超 TTL
    s.map({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, parent_tool_use_id: null, uuid: 'u1' });
    assert.equal(s.pendingTurns, 0, '超时不合成');
    assert.equal(s.pendingAutoTurn, false, '超时清 flag，防长尾误触');
    s.dispose();
  });

  test('TTL 门：flag 新鲜武装 → message_start 正常合成', () => {
    const { s } = makeSession();
    // 走真实置位路径以设 pendingAutoTurnAt=now
    s.map({ type: 'user', message: { content: '<task-notification>\n<task-id>a</task-id>\n</task-notification>' } });
    assert.equal(s.pendingAutoTurn, true);
    s.map({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, parent_tool_use_id: null, uuid: 'u1' });
    assert.equal(s.pendingTurns, 1, '新鲜 flag 正常合成');
    s.dispose();
  });
});

test.describe('map() — 活的后台任务注册表（bgTasks，驱动纯后台 ⏳）', () => {
  const prog = (taskId, taskType = 'local_agent', message = 'x') =>
    ({ type: 'system', subtype: 'task_progress', task_id: taskId, task_type: taskType, message });

  test('upsert：同 id 心跳更新不增计，不同 id 增计；summary 取最新一条', () => {
    const { s } = makeSession();
    s.map(prog('t1', 'local_agent', 'a'));
    assert.equal(s.hasBgTasks(), true);
    assert.equal(s.bgTasks.size, 1);
    s.map(prog('t1', 'local_agent', 'b'));        // 同 id：更新非新增
    assert.equal(s.bgTasks.size, 1, '同 taskId 心跳更新、不增计');
    s.map(prog('t2', 'local_bash', 'c'));         // 不同 id：新增
    assert.equal(s.bgTasks.size, 2);
    const sum = s.bgTaskSummary();
    assert.equal(sum.count, 2);
    assert.equal(sum.message, 'c', 'summary 取 lastSeenAt 最新一条');
    assert.equal(sum.taskType, 'local_bash');
    s.dispose();
  });

  test('taskId 缺失用稳定合成键：同类型无 id 心跳不膨胀', () => {
    const { s } = makeSession();
    s.map(prog(null, 'local_agent', 'a'));
    s.map(prog(undefined, 'local_agent', 'b'));
    assert.equal(s.bgTasks.size, 1, '同 taskType 的无 id 心跳合成同一键，不膨胀');
    s.dispose();
  });

  test('防御性双读：camelCase taskId/taskType 也能登记', () => {
    const { s } = makeSession();
    s.map({ type: 'system', subtype: 'task_progress', taskId: 'c1', taskType: 'local_bash', message: 'x' });
    assert.equal(s.hasBgTasks(), true);
    assert.equal(s.bgTaskSummary().taskType, 'local_bash', 'camelCase 字段被防御性读到（扛投递层字段名版本差异）');
    s.dispose();
  });

  test('真实字段：description → 横幅文案；subagent_type → local_agent(🤖) + 前缀', () => {
    const { s, events } = makeSession();
    // 实测生产 task_progress 真实形状：无 message/task_type，有 description/subagent_type/last_tool_name/usage
    s.map({ type: 'system', subtype: 'task_progress', task_id: 'a1', subagent_type: 'Plan',
      description: 'Reading public/js/app.js', last_tool_name: 'Read', usage: { tool_uses: 16 } });
    const sum = s.bgTaskSummary();
    assert.equal(sum.taskType, 'local_agent', '有 subagent_type → 归为 local_agent（server 映射 🤖）');
    assert.equal(sum.message, 'Plan：Reading public/js/app.js', 'description 作进度文案 + subagent_type 前缀');
    const prog = events.find(e => e.type === 'task_progress');
    assert.equal(prog.payload.message, 'Plan：Reading public/js/app.js', '横幅拿到真实活动文案（修旧代码读不存在的 msg.message 恒空）');
    assert.ok(Array.isArray(prog.payload.tasks), 'task_progress 附带全量 tasks 快照供前端列表明细');
    assert.equal(prog.payload.tasks.length, 1);
    assert.equal(prog.payload.tasks[0].taskId, 'a1');
    assert.equal(prog.payload.tasks[0].lastToolName, 'Read');
    assert.equal(prog.payload.lastToolName, 'Read');
    s.dispose();
  });

  test('agentProgressSummaries：无 description 时用 summary（~30s AI 短句）作横幅文案', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'task_progress', task_id: 'a1', subagent_type: 'Explore',
      summary: 'Analyzing authentication module', usage: { tool_uses: 3, total_tokens: 1, duration_ms: 1000 } });
    assert.equal(s.bgTaskSummary().message, 'Explore：Analyzing authentication module');
    const prog = events.find(e => e.type === 'task_progress');
    assert.equal(prog.payload.message, 'Explore：Analyzing authentication module');
    s.dispose();
  });

  test('description 优先于 summary（tool 即时态 > AI 30s 摘要）', () => {
    const { s } = makeSession();
    s.map({ type: 'system', subtype: 'task_progress', task_id: 'a1', subagent_type: 'Plan',
      description: 'Reading app.js', summary: 'Thinking about structure' });
    assert.equal(s.bgTaskSummary().message, 'Plan：Reading app.js');
    s.dispose();
  });

  test('checkIdle：有活任务且未 sweep 时软补推 task_progress 快照（前端粘性）', () => {
    const { s, events } = makeSession();
    s.map(prog('live1', 'local_agent', 'still going'));
    const before = events.filter(e => e.type === 'task_progress').length;
    s.checkIdle();
    const after = events.filter(e => e.type === 'task_progress');
    assert.ok(after.length > before, '应软补推一次全量快照');
    assert.equal(after[after.length - 1].payload.tasks.length, 1);
    assert.equal(after[after.length - 1].payload.tasks[0].taskId, 'live1');
    assert.equal(s.hasBgTasks(), true, '软补推不改 lastSeenAt / 不清表');
    s.dispose();
  });

  test('多任务 task_progress：payload.tasks 含全部在跑 id', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'task_progress', task_id: 's1', description: 'Search A' });
    s.map({ type: 'system', subtype: 'task_progress', task_id: 's2', description: 'Search B' });
    const progs = events.filter(e => e.type === 'task_progress');
    const last = progs[progs.length - 1];
    assert.equal(last.payload.tasks.length, 2);
    const ids = last.payload.tasks.map(t => t.taskId).sort();
    assert.deepEqual(ids, ['s1', 's2']);
    s.dispose();
  });

  test('真实字段：workflow 阶段（无 subagent_type）→ description 直出、类型 null（⏳）', () => {
    const { s } = makeSession();
    s.map({ type: 'system', subtype: 'task_progress', task_id: 'wi3xg9gn4',
      description: 'Synthesize: synthesize', last_tool_name: 'synthesize' });
    const sum = s.bgTaskSummary();
    assert.equal(sum.message, 'Synthesize: synthesize', 'workflow 阶段名直出（用户看到"在合成"）');
    assert.equal(sum.taskType, null, '无 subagent_type → taskType null → 前端 ⏳');
    s.dispose();
  });

  test('真实字段：description 缺失回退 last_tool_name', () => {
    const { s } = makeSession();
    s.map({ type: 'system', subtype: 'task_progress', task_id: 'x', last_tool_name: 'Bash' });
    assert.equal(s.bgTaskSummary().message, 'Bash', 'description 缺失回退 last_tool_name');
    s.dispose();
  });

  test('onBgTaskChange：空↔非空 / 新成员触发；稳态同 id 心跳不再触发', () => {
    let calls = 0;
    const { s } = makeSession({ onBgTaskChange: () => { calls++; } });
    s.map(prog('t1'));                             // 空→非空：触发
    assert.equal(calls, 1);
    s.map(prog('t1')); s.map(prog('t1'));          // 稳态同 id：不触发
    assert.equal(calls, 1, '稳态心跳只刷 lastSeenAt、不广播（节流关键）');
    s.map(prog('t2'));                             // 新成员：触发
    assert.equal(calls, 2);
    s.dispose();
  });

  test('onBgTaskChange：同 id 但 taskType 变化也触发（会话列表图标 ⏳→🤖 需刷新）', () => {
    let calls = 0;
    const { s } = makeSession({ onBgTaskChange: () => { calls++; } });
    s.map({ type: 'system', subtype: 'task_progress', task_id: 't1', description: 'x' });          // 无 subagent_type → taskType null，空→非空触发
    assert.equal(calls, 1);
    s.map({ type: 'system', subtype: 'task_progress', task_id: 't1', description: 'y' });          // 同 id 同 taskType(null)：稳态不触发
    assert.equal(calls, 1, '同 id 同 taskType 稳态心跳不触发（节流）');
    s.map({ type: 'system', subtype: 'task_progress', task_id: 't1', subagent_type: 'Plan', description: 'z' }); // 同 id、null→local_agent：触发
    assert.equal(calls, 2, 'taskType 变化触发回调 → 会话列表图标 ⏳→🤖 刷新（修 #4）');
    s.dispose();
  });

  test('bgTaskDone：带匹配 id 精确删该条、留其他', () => {
    const { s } = makeSession();
    s.map(prog('t1')); s.map(prog('t2'));
    s.bgTaskDone('t1');
    assert.equal(s.bgTasks.size, 1);
    assert.equal(s.bgTasks.has('t2'), true, '只删匹配 id，其他仍在跑者保留');
    s.dispose();
  });

  test('bgTaskDone：快任务(未心跳)完成 id 不在表 → no-op 不误清；无 id 才整清兜底', () => {
    const { s } = makeSession();
    s.map(prog('t1')); s.map(prog('t2'));
    // 实测 bedkhlnbd：progress=0/notification=1——完成 id 从未心跳、不在表内。绝不能因此整清其他仍在跑者。
    s.bgTaskDone('bedkhlnbd-未曾心跳的快任务');
    assert.equal(s.bgTasks.size, 2, 'id 不在表 → no-op，绝不整清（否则每个快任务完成都误灭其他 ⏳）');
    s.bgTaskDone('');                             // 空串（畸形/空 <task-id> 标签）：delete('') no-op，不误清
    assert.equal(s.bgTasks.size, 2, '空串 id → no-op 不误清（修 #5：旧 if(taskId) 会把空串当无 id 整清全部 ⏳）');
    s.bgTaskDone(null);                            // 仅真无 id：整清兜底（罕见）
    assert.equal(s.bgTasks.size, 0, 'null/undefined → 整清兜底，仍在跑者下拍心跳复亮');
    s.dispose();
  });

  test('end-to-end：system/task_notification 按 task_id 清对应活任务（⏳ 熄）', () => {
    const { s } = makeSession();
    s.map(prog('t1'));
    s.map({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' });
    assert.equal(s.hasBgTasks(), false, '完成通知清掉对应活任务');
    s.dispose();
  });

  test('end-to-end：<task-notification> user 注入按 task-id 清活任务', () => {
    const { s } = makeSession();
    s.map(prog('t1'));
    s.map({ type: 'user', message: { content: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n</task-notification>' } });
    assert.equal(s.hasBgTasks(), false, 'user 注入完成也清活任务');
    s.dispose();
  });

  test('BUG-1 回归：<task-notification> 缺 <task-id> 不误清其他在跑的 bgTasks', () => {
    const { s } = makeSession();
    s.map(prog('t1'));
    s.map(prog('t2'));
    assert.equal(s.bgTasks.size, 2);
    // 有闭合标签但无 <task-id> 子标签 —— pick('task-id') 返回 null
    s.map({ type: 'user', message: { content: '<task-notification>\n<status>completed</status>\n</task-notification>' } });
    assert.equal(s.bgTasks.size, 2, '缺 <task-id> 时不整清：t1 和 t2 仍在跑者保留');
    assert.equal(s.bgTasks.has('t1'), true);
    assert.equal(s.bgTasks.has('t2'), true);
    assert.equal(s.pendingAutoTurn, true, '通知仍应武装 pendingAutoTurn（触发汇报轮）');
    s.dispose();
  });

  test('TTL sweep：合成键 __notask_* 超短 TTL 被清；真实 id 3min 静默保留', () => {
    const { s } = makeSession();
    s.map(prog(null, 'local_agent', 'orphan-a')); // → __notask_local_agent
    s.map(prog('real1', 'local_agent', 'alive'));
    const orphanKey = [...s.bgTasks.keys()].find(k => String(k).startsWith('__notask_'));
    assert.ok(orphanKey, '无 task_id 应合成 __notask_ 键');
    s.bgTasks.get(orphanKey).lastSeenAt = Date.now() - 180000 - 1;
    s.bgTasks.get('real1').lastSeenAt = Date.now() - 180000 - 1;
    assert.equal(s.sweepBgTasks(), true, '孤儿应被清');
    assert.equal(s.bgTasks.has(orphanKey), false, '合成键走 3min 短 TTL');
    assert.equal(s.bgTasks.has('real1'), true, '真实 task_id 3min 静默不误清（完成靠 lifecycle 通道）');
    s.dispose();
  });

  test('TTL sweep：真实 id 的 bash/agent/workflow 3min 静默均不误清', () => {
    const { s } = makeSession();
    s.map({ type: 'system', subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 'bash1', task_type: 'local_bash', description: 'npm run test:e2e' },
        { task_id: 'agent1', task_type: 'local_agent', description: 'Plan：long think' },
        { task_id: 'wf1', task_type: 'local_workflow', description: 'Synthesize' },
      ] });
    for (const id of ['bash1', 'agent1', 'wf1']) {
      s.bgTasks.get(id).lastSeenAt = Date.now() - 180000 - 1;
    }
    assert.equal(s.sweepBgTasks(), false, '全员真实 id → 3min 静默不触发清扫');
    assert.equal(s.bgTasks.size, 3);
    s.dispose();
  });

  test('TTL sweep：真实 id 超 2h 兜底仍清（漏完成信号安全网）', () => {
    const { s } = makeSession();
    s.map({ type: 'system', subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bash1', task_type: 'local_bash', description: 'stuck' }] });
    s.map(prog('agent1', 'local_agent', 'stuck-agent'));
    s.bgTasks.get('bash1').lastSeenAt = Date.now() - (2 * 60 * 60 * 1000) - 1;
    s.bgTasks.get('agent1').lastSeenAt = Date.now() - (2 * 60 * 60 * 1000) - 1;
    assert.equal(s.sweepBgTasks(), true);
    assert.equal(s.bgTasks.has('bash1'), false, 'bash 2h 兜底清');
    assert.equal(s.bgTasks.has('agent1'), false, 'agent 2h 兜底清');
    s.dispose();
  });

  test('checkIdle 惰性清扫：合成键过期仍被清 + 回调 + 推全量快照', () => {
    let calls = 0;
    const { s, events } = makeSession({ onBgTaskChange: () => { calls++; } });
    s.map(prog(null, 'local_agent', 'orphan'));     // calls=1（空→非空）
    const orphanKey = [...s.bgTasks.keys()][0];
    s.bgTasks.get(orphanKey).lastSeenAt = Date.now() - 180000 - 1;
    assert.equal(s.pendingTurns, 0, '后台运行期 pendingTurns 正是 0');
    const before = events.filter(e => e.type === 'task_progress').length;
    s.checkIdle();
    assert.equal(s.hasBgTasks(), false, 'checkIdle 须在 pendingTurns===0 提前返回前清过期孤儿');
    assert.equal(calls, 2, '清出变化触发回调重算角标');
    const afterProg = events.filter(e => e.type === 'task_progress');
    assert.ok(afterProg.length > before, 'TTL 清扫后须 emitBgTasksSnapshot 让前端立刻对齐（含空表收横幅）');
    const last = afterProg[afterProg.length - 1];
    assert.equal(last.payload?.tasks?.length, 0, '空表快照 tasks=[]');
    s.dispose();
  });

  test('dispose 清空活后台注册表', () => {
    const { s } = makeSession();
    s.map(prog('t1'));
    s.dispose();
    assert.equal(s.bgTasks.size, 0);
  });

  test('换会话（init 新 session_id）清空活后台注册表', () => {
    const { s } = makeSession({ resumeId: 'old-sess' });
    s.map(prog('t1'));
    assert.equal(s.hasBgTasks(), true);
    s.map({ type: 'system', subtype: 'init', session_id: 'new-sess' });
    assert.equal(s.hasBgTasks(), false, '换会话清空，旧会话后台任务不串到新会话');
    s.dispose();
  });
});

// ---- logMeta()：统一模型/effort/permission 解析（消除 send vs result 的 defaultModel/'default' 漂移）----
test.describe('map() — background_tasks_changed 全量 reconcile bgTasks（CLI 2.1.209 后台任务真实通道）', () => {
  // probe 实证（CLI 2.1.209）：后台任务（local_bash 等）走 background_tasks_changed【全量快照】——
  // 开始发 tasks=[N]、stopTask/完成发 tasks=[]。旧 map() 只认 task_progress/task_notification，
  // 故 background bash 从不进 bgTasks（⏳ 抓不到、stopTask 无 taskId 来源）。本组是该 bug 的回归防线。
  test('tasks=[1] → 纳入 bgTasks（修 background bash 漏进注册表的 bug）', () => {
    const { s } = makeSession();
    s.map({ type: 'system', subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bt1', task_type: 'local_bash', description: '在后台运行 sleep 30' }] });
    assert.equal(s.hasBgTasks(), true);
    assert.ok(s.bgTasks.has('bt1'));
    assert.equal(s.bgTasks.get('bt1').taskType, 'local_bash');
    assert.equal(s.bgTasks.get('bt1').message, '在后台运行 sleep 30');
    s.dispose();
  });

  test('全量空快照 tasks=[] → 清空 bgTasks（停止/完成后 ⏳ 熄灭）', () => {
    const { s } = makeSession();
    s.map({ type: 'system', subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bt1', task_type: 'local_bash', description: 'x' }] });
    assert.equal(s.hasBgTasks(), true);
    s.map({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    assert.equal(s.hasBgTasks(), false);
    assert.equal(s.bgTasks.size, 0);
    s.dispose();
  });

  test('全量 reconcile：快照少一个 → 只删消失的、保留仍在的', () => {
    const { s } = makeSession();
    s.map({ type: 'system', subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'a', task_type: 'local_bash', description: 'A' },
              { task_id: 'b', task_type: 'local_agent', description: 'B' }] });
    assert.equal(s.bgTasks.size, 2);
    s.map({ type: 'system', subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'b', task_type: 'local_agent', description: 'B' }] });
    assert.equal(s.bgTasks.size, 1);
    assert.ok(!s.bgTasks.has('a'), 'a 消失应删');
    assert.ok(s.bgTasks.has('b'), 'b 仍在应留');
    s.dispose();
  });

  test('size 变化才触发 onBgTaskChange（与注册表节流一致）', () => {
    let changes = 0;
    const { s } = makeSession({ onBgTaskChange: () => changes++ });
    s.map({ type: 'system', subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'a', task_type: 'local_bash', description: 'A' }] });
    assert.equal(changes, 1, '0→1 应广播');
    s.map({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    assert.equal(changes, 2, '1→0 应广播');
    s.dispose();
  });
});

// worktree 网关隔离（2026-07-30 实证）：主 checkout 的 settings.local.json env 块会经 CLI 的
// canonical-repo-root 解析污染所有 worktree 会话。修复必须走 flag settings——实测往子进程注入
// options.env 压不过 CLI 自己的 settings.env（那正是 resolvedEnv 机制一直没生效的原因）。
// 但 flag settings 的**对象**形式会被 SDK 序列化成 `--settings <json>` 拼进子进程 argv（ps 可见明文），
// 故 env 一律走「settings 文件路径」形式下发，对象形式只保留给不含机密的 ultracode。
test.describe('buildAgentQueryOptions — worktree 网关隔离经 settings 文件下发', () => {
  test('有 worktreeSettingsPath → options.settings 是该路径字符串', () => {
    const { s } = makeSession();
    s.abort = new AbortController();
    s.worktreeSettingsPath = '/tmp/ccm-test/worktree-settings/abc.json';
    const opts = buildAgentQueryOptions(s, { ...process.env });
    assert.equal(opts.settings, '/tmp/ccm-test/worktree-settings/abc.json');
    s.dispose();
  });

  test('settings 里绝不出现明文 env（凭据不得进子进程 argv）', () => {
    const { s } = makeSession();
    s.abort = new AbortController();
    s.worktreeSettingsPath = '/tmp/ccm-test/worktree-settings/abc.json';
    s.ultracode = true;
    const opts = buildAgentQueryOptions(s, { ...process.env });
    assert.equal(typeof opts.settings, 'string', 'settings 必须是文件路径而非内联对象');
    assert.equal(JSON.stringify(opts).includes('ANTHROPIC_AUTH_TOKEN'), false);
    s.dispose();
  });

  test('ultracode 与文件路径并存时用路径（ultracode 已写在文件里，不能因此退回对象形式）', () => {
    const { s } = makeSession();
    s.abort = new AbortController();
    s.ultracode = true;
    s.worktreeSettingsPath = '/tmp/ccm-test/worktree-settings/abc-uc.json';
    const opts = buildAgentQueryOptions(s, { ...process.env });
    assert.equal(opts.settings, '/tmp/ccm-test/worktree-settings/abc-uc.json');
    s.dispose();
  });

  test('两者都无 → 完全不传 settings（保持现状，不给 CLI 平添一层 flag settings）', () => {
    const { s } = makeSession();
    s.abort = new AbortController();
    const opts = buildAgentQueryOptions(s, { ...process.env });
    assert.equal('settings' in opts, false);
    s.dispose();
  });

  test('只有 ultracode（非 worktree 工作区）→ settings 仍是 {ultracode:true} 对象，既有行为不回归', () => {
    const { s } = makeSession();
    s.abort = new AbortController();
    s.ultracode = true;
    const opts = buildAgentQueryOptions(s, { ...process.env });
    assert.deepEqual(opts.settings, { ultracode: true });
    s.dispose();
  });
});

// ---- 本地 slash 命令的进度可见性（扫 subagents → 喂 bgTasks）----
// 病灶：CLI 把 /code-review 这类命令跑在独立 fork 上下文里，主链 transcript 零条目、SDK 流零消息
// （2026-08-05 探针实测 stream_event = 0）。用户只看得见 status_line 心跳，真机等 13 分钟后按了停止。
// 执行过程唯一的可观测来源是 <sessionId>/subagents/agent-*.jsonl。
test.describe('本地 slash 命令进度：subagents → bgTasks', () => {
  const BASE = join(tmpdir(), `ccm-localcmd-${process.pid}`);

  function seed(cwd, sid, agents) {
    const dir = join(BASE, getProjectDir(cwd), sid, 'subagents');
    mkdirSync(dir, { recursive: true });
    for (const a of agents) {
      writeFileSync(join(dir, `agent-${a.id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', ...(a.desc ? { description: a.desc } : {}) }));
      writeFileSync(join(dir, `agent-${a.id}.jsonl`), JSON.stringify({
        type: 'assistant', isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: a.tool || 'Read', input: {} }] },
      }) + '\n');
    }
  }

  test('扫到的子代理进入 bgTasks，description/lastToolName 原样带出（前端明细行的内容来源）', async () => {
    const cwd = '/test/localcmd-basic';
    seed(cwd, 'lc-basic', [{ id: 'a00b4eae6', desc: 'Angle A: line-by-line diff scan', tool: 'Grep' }]);
    const { s } = makeSession({ cwd, transcriptBaseDir: BASE });
    s.sessionId = 'lc-basic';
    s._armSlashQuietNotice('/code-review'); // 生产前提：poll 只在命令在途期间被 tick 调用

    await s._pollLocalCommandProgress();

    const tasks = s.bgTasksList();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].description, 'Angle A: line-by-line diff scan');
    assert.equal(tasks[0].lastToolName, 'Grep');
    assert.equal(tasks[0].subagentType, 'general-purpose');
    assert.equal(s.hasBgTasks(), true, '有活任务 → checkIdle 的既有豁免随之生效（看门狗多一道保险）');
    s.dispose();
  });

  // 【变异检查记录】把 _pollLocalCommandProgress 里的 `if (!this.sessionId) return` 删掉，本用例仍绿
  // ——因为 scanSubagents 内的 isSafeSessionId 也会挡下 null。两道守卫是双保险，单测无法区分谁在起
  // 作用。本用例锁的是「没有 id 时不得凭空造出任务」这个可观测结果，不是那一行 return 的存在。
  test('sessionId 未到时不造任务（本地命令下 init 晚到，真机首个带 id 的消息在 9.5s）', async () => {
    const { s } = makeSession({ cwd: '/test/localcmd-nosid', transcriptBaseDir: BASE });
    s.sessionId = null;
    await s._pollLocalCommandProgress();
    assert.equal(s.hasBgTasks(), false, '没有 id 就没有目录名，不该凭空造任务');
    s.dispose();
  });

  test('命令收尾 → 扫出来的任务被清掉（磁盘观察没有完成信号，不清就一直挂 ⏳）', async () => {
    const cwd = '/test/localcmd-clear';
    seed(cwd, 'lc-clear', [{ id: 'aone' }, { id: 'atwo' }]);
    const { s } = makeSession({ cwd, transcriptBaseDir: BASE });
    s.sessionId = 'lc-clear';
    s._armSlashQuietNotice('/code-review');
    await s._pollLocalCommandProgress();
    assert.equal(s.bgTasksList().length, 2);

    s._clearLocalCommandProgress();

    assert.equal(s.hasBgTasks(), false, '收尾后必须熄灭，否则面板与角标永远挂着');
    s.dispose();
  });

  test('result 收尾即清（命令被中断/出错、没有输出的那条路径）', async () => {
    const cwd = '/test/localcmd-result';
    seed(cwd, 'lc-result', [{ id: 'ares' }]);
    const { s } = makeSession({ cwd, transcriptBaseDir: BASE });
    s.sessionId = 'lc-result';
    s._armSlashQuietNotice('/code-review');
    await s._pollLocalCommandProgress();
    assert.equal(s.hasBgTasks(), true);

    s.map({ type: 'result', subtype: 'success', session_id: 'lc-result', usage: {}, total_cost_usd: 0 });

    assert.equal(s.hasBgTasks(), false);
    assert.equal(s._localCommandInFlight(), false);
    s.dispose();
  });

  test('轮询只在命令在途期间起表：普通消息不开表（常态零开销）', () => {
    const { s } = makeSession({ cwd: '/test/localcmd-idle' });
    s._armSlashQuietNotice('帮我看下这段代码');
    assert.equal(s._localCmdProgressTimer, null, '非 slash 不该起进度轮询');
    s._armSlashQuietNotice('/code-review');
    assert.ok(s._localCmdProgressTimer, 'slash 命令须起表');
    s.dispose();
    assert.equal(s._localCmdProgressTimer, null, 'dispose 须停表，不留悬挂 timer');
  });

  // E2 回归（2026-08-05 真机 /code-review 自查抓出）：tick() 只在 await 之前检查 disposed/in-flight，
  // 扫盘返回后无条件 upsert。命令若在 await 期间收尾并清理，poll 完成时会把任务重新塞回去——
  // 而那批 ghost 键此后没有任何路径会再清它们（清理只发生在 output/result/下一条 slash/dispose），
  // hasBgTasks() 因此长期为真：会话列表 ⏳ 常亮、isBusy 挂住、dispose/effort 置换被拦。
  // #5 回归（2026-08-05 第二轮 review）：poll 只 upsert、从不删。中途跑完的子代理仍显示「运行中」，
  // 面板计数与 ⏳ 虚高到整轮 result 才归位。
  test('#5：本轮扫不到的子代理须从面板移除（跑完就不该还显示运行中）', async () => {
    const cwd = '/test/localcmd-diff';
    seed(cwd, 'lc-diff', [{ id: 'aalive' }, { id: 'adone' }]);
    const { s } = makeSession({ cwd, transcriptBaseDir: BASE });
    s.sessionId = 'lc-diff';
    s._armSlashQuietNotice('/code-review');
    await s._pollLocalCommandProgress();
    assert.equal(s.bgTasksList().length, 2, '前提：两个子代理都在跑');

    rmSync(join(BASE, getProjectDir(cwd), 'lc-diff', 'subagents', 'agent-adone.jsonl')); // 一个结束并被清理
    await s._pollLocalCommandProgress();

    const ids = s.bgTasksList().map(t => t.taskId);
    assert.deepEqual(ids, ['localcmd:aalive'], '扫不到的须移除，否则计数虚高');
    s.dispose();
  });

  // #5b：scanSubagents 无 mtime 过滤 → 同会话第二次 /code-review 会把上一轮【已完成】的子代理
  // 立刻「复活」成运行中。
  test('#5b：早于本次命令起点的历史子代理不算本轮进度', async () => {
    const cwd = '/test/localcmd-stale';
    seed(cwd, 'lc-stale', [{ id: 'aprev' }]);
    // 把上一轮的产物时间拨到 1 小时前
    const f = join(BASE, getProjectDir(cwd), 'lc-stale', 'subagents', 'agent-aprev.jsonl');
    const old = new Date(Date.now() - 3600_000);
    utimesSync(f, old, old);

    const { s } = makeSession({ cwd, transcriptBaseDir: BASE });
    s.sessionId = 'lc-stale';
    s._armSlashQuietNotice('/code-review'); // 新一轮命令刚开始
    await s._pollLocalCommandProgress();

    assert.equal(s.hasBgTasks(), false, '上一轮已完成的子代理不该复活为本轮进度');
    s.dispose();
  });

  // #4 回归（2026-08-05 第二轮 review）：stopTask 只校验 string 非空就打给 SDK。合成键
  // （localcmd:* 磁盘观察、__notask_* 无 task_id 占位）在 SDK 侧根本不存在，打过去只会空转到超时；
  // 与前端 1.5s 后假报「已请求停止」叠加，用户看到的是「点了、说停了、其实没停」。
  // 前端已挡一层（taskStopUiState），但那不能是唯一防线——旧客户端/手工 emit/行按钮都能绕过。
  test('#4：stopTask 直接拒绝合成 id，不打给 SDK', async () => {
    const calls = [];
    const { s } = makeSession();
    s.q = { stopTask: async id => { calls.push(id); } };
    assert.equal(await s.stopTask('localcmd:a00b4eae6'), false, '磁盘观察出来的子代理停不了');
    assert.equal(await s.stopTask('__notask_local_agent'), false, '无 task_id 的占位键同理');
    assert.deepEqual(calls, [], '一次都不该打给 SDK');
    assert.equal(await s.stopTask('w60tplm3a'), true, '真实 taskId 照常放行（防修过头）');
    assert.deepEqual(calls, ['w60tplm3a']);
    s.dispose();
  });

  // E4 回归（2026-08-05 真机 /code-review 自查抓出）：reconcileBgTasks 按 SDK 全量快照删除所有
  // 不在快照里的键。localcmd:* 本就不会出现在 SDK 快照里（它们是我们扫盘造的），于是任何一次
  // background_tasks_changed 都会把进度行抹掉，下一拍轮询又加回来 → 面板闪烁。
  test('E4：SDK 全量 reconcile 不得抹掉 localcmd 进度行', async () => {
    const cwd = '/test/localcmd-reconcile';
    seed(cwd, 'lc-rec', [{ id: 'akeep' }]);
    const { s } = makeSession({ cwd, transcriptBaseDir: BASE });
    s.sessionId = 'lc-rec';
    s._armSlashQuietNotice('/code-review');
    await s._pollLocalCommandProgress();
    assert.equal(s.bgTasksList().length, 1);

    s.reconcileBgTasks([{ task_id: 'sdk-real', task_type: 'workflow', description: 'SDK 的任务' }]);

    const ids = s.bgTasksList().map(t => t.taskId);
    assert.ok(ids.includes('localcmd:akeep'), 'localcmd 行须保留，它不归 SDK 快照管');
    assert.ok(ids.includes('sdk-real'), 'SDK 任务照常进来');
    s.dispose();
  });

  test('E4 对照：SDK 自己的陈旧任务仍被 reconcile 清掉（防修过头）', () => {
    const { s } = makeSession();
    s.bgTaskUpsert('sdk-stale', 'workflow', '已消失的任务');
    s.reconcileBgTasks([{ task_id: 'sdk-new', task_type: 'workflow' }]);
    const ids = s.bgTasksList().map(t => t.taskId);
    assert.ok(!ids.includes('sdk-stale'), 'SDK 键不在快照里就该删');
    assert.ok(ids.includes('sdk-new'));
    s.dispose();
  });

  test('E5：扫出的任务用前端认识的 local_agent 类型（拿得到 🤖 行标签）', async () => {
    const cwd = '/test/localcmd-type';
    seed(cwd, 'lc-type', [{ id: 'atype', desc: 'Angle A' }]);
    const { s } = makeSession({ cwd, transcriptBaseDir: BASE });
    s.sessionId = 'lc-type';
    s._armSlashQuietNotice('/code-review');
    await s._pollLocalCommandProgress();
    assert.equal(s.bgTasksList()[0].taskType, 'local_agent', "'subagent' 不是前端一等类型，行标签会退化成裸文本");
    s.dispose();
  });

  test('E2：扫盘与收尾竞态不得留下 ghost 任务', async () => {
    const cwd = '/test/localcmd-race';
    seed(cwd, 'lc-race', [{ id: 'aghost' }]);
    const { s } = makeSession({ cwd, transcriptBaseDir: BASE });
    s.sessionId = 'lc-race';
    s.pendingTurns = 1;
    s._armSlashQuietNotice('/code-review');

    const inflight = s._pollLocalCommandProgress(); // 扫盘开始（异步）
    s._clearLocalCommandProgress();                  // await 期间命令收尾
    await inflight;                                   // 扫盘返回

    assert.equal(s.hasBgTasks(), false, '收尾后扫盘返回，不得把任务重新塞回去');
    assert.equal(s._localCmdTaskIds.size, 0);
    s.dispose();
  });

  test('E2b：dispose 后扫盘返回同样不得复活任务', async () => {
    const cwd = '/test/localcmd-race2';
    seed(cwd, 'lc-race2', [{ id: 'aghost2' }]);
    const { s } = makeSession({ cwd, transcriptBaseDir: BASE });
    s.sessionId = 'lc-race2';
    s._armSlashQuietNotice('/code-review');
    const inflight = s._pollLocalCommandProgress();
    s.dispose();
    await inflight;
    assert.equal(s.hasBgTasks(), false, '实例已没，扫盘结果不该再落进它的账上');
  });

  test('扫盘键与 SDK 真实 task_id 分属不同命名空间（不互相覆盖）', async () => {
    const cwd = '/test/localcmd-ns';
    seed(cwd, 'lc-ns', [{ id: 'adup' }]);
    const { s } = makeSession({ cwd, transcriptBaseDir: BASE });
    s.sessionId = 'lc-ns';
    s._armSlashQuietNotice('/code-review');
    s.bgTaskUpsert('adup', 'workflow', 'SDK 报来的同名任务');   // 同名，但来自 SDK
    await s._pollLocalCommandProgress();
    assert.equal(s.bgTasksList().length, 2, '同名不同源须并存，不得互相覆盖');
    s._clearLocalCommandProgress();
    assert.equal(s.bgTasksList().length, 1, '只清扫盘那条，SDK 那条不动');
    assert.equal(s.bgTasksList()[0].taskType, 'workflow');
    s.dispose();
  });
});
