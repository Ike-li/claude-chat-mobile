import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, sdkChildEnv } from '../../src/agent/agent.js';
import { getSessionLogs } from '../../src/agent/interaction-log.js';
import { makeSession } from '../helpers/agent-unit.mjs';

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

  test('TTL sweep：超 BG_TASK_TTL_MS 无心跳者被清、未过期者留', () => {
    const { s } = makeSession();
    s.map(prog('old')); s.map(prog('fresh'));
    s.bgTasks.get('old').lastSeenAt = Date.now() - 180000 - 1; // 造过期，不真等 3min
    assert.equal(s.sweepBgTasks(), true, '有过期任务被清 → 返回 true');
    assert.equal(s.bgTasks.has('old'), false, '过期被清');
    assert.equal(s.bgTasks.has('fresh'), true, '未过期保留');
    s.dispose();
  });

  test('checkIdle 惰性清扫：pendingTurns=0 下过期任务仍被清 + 回调（提前 return 前清扫）', () => {
    let calls = 0;
    const { s } = makeSession({ onBgTaskChange: () => { calls++; } });
    s.map(prog('t1'));                              // calls=1（空→非空）
    s.bgTasks.get('t1').lastSeenAt = Date.now() - 180000 - 1;
    assert.equal(s.pendingTurns, 0, '后台运行期 pendingTurns 正是 0');
    s.checkIdle();
    assert.equal(s.hasBgTasks(), false, 'checkIdle 须在 pendingTurns===0 提前返回前清过期任务');
    assert.equal(calls, 2, '清出变化触发回调重算角标');
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
