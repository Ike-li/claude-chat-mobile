// test/agent.test.mjs —— AgentSession 纯逻辑单测（不 start()、零 token）
// 覆盖构造函数、emit/buffer/eventsSince、map() 全部 SDK 消息类型、
// send()/interrupt()/权限闸门/AskUserQuestion/dispose()/checkIdle()/consume() 退出路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession } from '../agent.js';
import { getSessionLogs } from '../interaction-log.js';

// ---- helpers ----
function makeSession(opts = {}) {
  const events = [];
  const s = new AgentSession({
    instanceId: opts.instanceId || 'test',
    cwd: opts.cwd || '/tmp/test',
    claudeBin: 'fake-claude',
    model: opts.model || null,
    permissionMode: opts.permissionMode || 'default',
    effort: opts.effort || null,
    idleTimeoutMs: opts.idleTimeoutMs ?? 60_000,
    approvalTtlMs: opts.approvalTtlMs, // 未传 → 走 agent.js 内的默认值
    resumeId: opts.resumeId || null,
    historicalCostUsd: opts.historicalCostUsd || 0,
    onEvent(e) { events.push(e); },
    onSessionId: opts.onSessionId || (() => {}),
    onExit: opts.onExit || (() => {}),
    onUsage: opts.onUsage || (() => {}),
    onBgTaskChange: opts.onBgTaskChange || (() => {}),
  });
  return { s, events, dispose: () => s.dispose() };
}

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

  test('缓冲上限 500 条（BUFFER_CAP）→ 溢出后 bufferTrimmed=true、最旧 seq=2', () => {
    const { s, events } = makeSession();
    // push 501 条（seq 1..501），buffer 只保留最近 500 条（seq 2..501）
    for (let i = 0; i < 501; i++) s.emit('system', { n: i });
    assert.equal(s.buffer.length, 500);
    assert.equal(s.bufferTrimmed, true);
    assert.equal(s.buffer[0].seq, 2);  // seq 1 被挤出
    assert.equal(s.buffer[499].seq, 501);
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
    // push 502 条 → buffer 保留最近 500 条（seq 3..502），seq 1-2 被挤出
    for (let i = 0; i < 502; i++) s.emit('system', { n: i });
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
});

// ---- map() SDK 消息映射 ----
test.describe('map() — SDK 消息 → 契约事件', () => {
  test('system/init：sawInit=true、sessionId 更新、emit init + onSessionId', () => {
    let sidArg = null;
    const { s, events } = makeSession({ resumeId: 'old-sid', onSessionId(sid) { sidArg = sid; } });
    assert.equal(s.sessionId, 'old-sid');
    assert.equal(s.sawInit, false);

    s.map({ type: 'system', subtype: 'init', session_id: 'new-sid', model: 'opus', cwd: '/work',
      claude_code_version: '1.0.0', mcp_servers: [], skills: [], slash_commands: ['/help'] });

    assert.equal(s.sawInit, true);
    assert.equal(s.sessionId, 'new-sid');
    assert.equal(sidArg, 'new-sid');
    assert.equal(s.reportedModel, 'opus');

    const init = events.find(e => e.type === 'init');
    assert.ok(init);
    assert.equal(init.payload.model, 'opus');
    assert.equal(init.payload.cwd, '/work');
    assert.equal(init.payload.claudeVersion, '1.0.0');
    assert.equal(init.payload.permissionMode, 'default');
    assert.deepEqual(init.payload.slashCommands, ['/help']);
    s.dispose();
  });

  test('system/init：/clear 换会话 → firstMessage/lastUsage 重置', () => {
    const { s, events } = makeSession({ resumeId: 'sid-1', onSessionId() {} });
    s.firstMessage = 'hello';
    s.lastUsage = { input_tokens: 100 };
    s.sessionId = 'sid-1';

    s.map({ type: 'system', subtype: 'init', session_id: 'sid-2', model: null, cwd: '/tmp',
      claude_code_version: null, mcp_servers: [], skills: [], slash_commands: [] });

    assert.equal(s.sessionId, 'sid-2');
    assert.equal(s.firstMessage, null);
    assert.equal(s.lastUsage, null);
    s.dispose();
  });

  // 权限档以 SDK init 的 msg.permissionMode 为权威，对账本地 shadow（防「我们以为切了、SDK 没应用」）
  test('system/init：msg.permissionMode 与 shadow 一致 → 不漂移、echo 该档', () => {
    const { s, events } = makeSession({ permissionMode: 'acceptEdits', onSessionId() {} });
    s.map({ type: 'system', subtype: 'init', session_id: 'sid', model: 'opus', cwd: '/w',
      claude_code_version: '1', mcp_servers: [], skills: [], slash_commands: [], permissionMode: 'acceptEdits' });
    assert.equal(s.permissionMode, 'acceptEdits');
    assert.equal(events.find(e => e.type === 'init').payload.permissionMode, 'acceptEdits');
    s.dispose();
  });

  test('system/init：msg.permissionMode 漂移（本地 plan、SDK default）→ 以 SDK 为准对账 + echo default', () => {
    const { s, events } = makeSession({ permissionMode: 'plan', onSessionId() {} });
    s.map({ type: 'system', subtype: 'init', session_id: 'sid', model: 'opus', cwd: '/w',
      claude_code_version: '1', mcp_servers: [], skills: [], slash_commands: [], permissionMode: 'default' });
    assert.equal(s.permissionMode, 'default', '本地 shadow 被 SDK 真值校正');
    assert.equal(events.find(e => e.type === 'init').payload.permissionMode, 'default', 'init echo 反映 SDK 真值');
    s.dispose();
  });

  test('system/init：bypass 例外（本地 bypass、SDK default）→ 不漂移、保留用户档 bypass', () => {
    const { s, events } = makeSession({ permissionMode: 'bypassPermissions', onSessionId() {} });
    s.map({ type: 'system', subtype: 'init', session_id: 'sid', model: 'opus', cwd: '/w',
      claude_code_version: '1', mcp_servers: [], skills: [], slash_commands: [], permissionMode: 'default' });
    assert.equal(s.permissionMode, 'bypassPermissions', 'bypass 由 handleCanUseTool 自放行，SDK 报 default 属设计内，不覆盖');
    assert.equal(events.find(e => e.type === 'init').payload.permissionMode, 'bypassPermissions');
    s.dispose();
  });

  test('system/init：旧 CLI 无 msg.permissionMode → 跳过对账、维持 shadow', () => {
    const { s, events } = makeSession({ permissionMode: 'plan', onSessionId() {} });
    s.map({ type: 'system', subtype: 'init', session_id: 'sid', model: 'opus', cwd: '/w',
      claude_code_version: '1', mcp_servers: [], skills: [], slash_commands: [] });
    assert.equal(s.permissionMode, 'plan');
    assert.equal(events.find(e => e.type === 'init').payload.permissionMode, 'plan');
    s.dispose();
  });

  test('system/compacting → system 事件', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'status', status: 'compacting' });
    const sys = events.find(e => e.type === 'system' && e.payload.message === '正在压缩会话上下文…');
    assert.ok(sys);
    s.dispose();
  });

  test('system/compact_boundary → system 事件', () => {
    const { s, events } = makeSession();
    s.map({ type: 'system', subtype: 'compact_boundary' });
    const sys = events.find(e => e.type === 'system' && e.payload.message === '上下文已压缩');
    assert.ok(sys);
    s.dispose();
  });

  test('stream_event/text_delta → text_delta 批量缓冲（20ms timer 测试）', async () => {
    const { s, events } = makeSession();
    s.currentMessageId = 'msg-1';
    s.map({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-2' } },
      parent_tool_use_id: null, uuid: 'u1' });
    // send a small text delta — won't flush immediately (below 2048 bytes)
    s.map({ type: 'stream_event', event: { type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hello' } }, parent_tool_use_id: null, uuid: 'u1' });
    assert.equal(s._textBuf, 'Hello');
    // force flush
    s._flushText();
    const td = events.find(e => e.type === 'text_delta');
    assert.ok(td);
    assert.equal(td.payload.text, 'Hello');
    s.dispose();
  });

  test('stream_event/text_delta → 2048 字节阈值立即 flush', () => {
    const { s, events } = makeSession();
    s.currentMessageId = 'msg-1';
    const big = 'x'.repeat(2048);
    s.map({ type: 'stream_event', event: { type: 'content_block_delta',
      delta: { type: 'text_delta', text: big } }, parent_tool_use_id: null, uuid: 'u1' });
    const td = events.find(e => e.type === 'text_delta');
    assert.ok(td);
    assert.equal(td.payload.text, big);
    assert.equal(s._textBuf, '');
    s.dispose();
  });

  test('stream_event/thinking_delta → thinking_delta 缓冲', () => {
    const { s, events } = makeSession();
    s.currentMessageId = 'msg-1';
    s.map({ type: 'stream_event', event: { type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'Hmm...' } }, parent_tool_use_id: null, uuid: 'u1' });
    s._flushThink();
    const td = events.find(e => e.type === 'thinking_delta');
    assert.ok(td);
    assert.equal(td.payload.text, 'Hmm...');
    s.dispose();
  });

  test('assistant 带 error → error 事件（透传 content 原文）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'assistant', error: 'rate_limit',
      message: { content: [{ type: 'text', text: 'API Error: 429 Too Many Requests' }] } });
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('429'));
    assert.equal(err.payload.recoverable, true);
    s.dispose();
  });

  test('assistant 带 error 但 content 为空 → 兜底用 error 枚举', () => {
    const { s, events } = makeSession();
    s.map({ type: 'assistant', error: 'unknown', message: { content: [] } });
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('unknown'));
    s.dispose();
  });

  // 回归锚点(轮⇒result 假设) —— code-review #2 结论：pendingTurns 全套配平压在一条 SDK 契约上：
  // 每个已启动轮次恰好产出一个 result（成功/报错/被中断都算）。assistant{error} 分支只 emit error、
  // 【不】碰 pendingTurns，纯靠随后的 result 减掉本轮。此锚点把该隐式依赖钉成显式回归门：若某 SDK/网关
  // 版本改成「终态错误只发 assistant{error} 不发 result」，第二段断言即红 → pendingTurns 泄漏预警
  // （症状：排队提示早一轮 / idle 仍 busy）。见 agent.js:769 assistant{error} 分支注释。
  test('回归锚点(轮⇒result 假设)：错误轮 assistant{error}+随后 result → pendingTurns 归零、不泄漏', () => {
    const { s } = makeSession();
    s.pendingTurns = 1; // 一轮在途
    s.map({ type: 'assistant', error: 'rate_limit',
      message: { content: [{ type: 'text', text: 'API Error: 429 Too Many Requests' }] } });
    assert.equal(s.pendingTurns, 1, 'assistant{error} 本身不减 pendingTurns（依赖随后的 result）');
    s.map({ type: 'result', subtype: 'error', is_error: true, duration_ms: 10, modelUsage: {} });
    assert.equal(s.pendingTurns, 0, '随后的 result 才减掉在途轮；轮⇒result 假设成立则不泄漏');
    s.dispose();
  });

  test('assistant 带 tool_use → tool_use 事件', () => {
    const { s, events } = makeSession();
    s.map({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/a.txt' } }
    ] } });
    const tu = events.find(e => e.type === 'tool_use');
    assert.ok(tu);
    assert.equal(tu.payload.toolUseId, 'tool-1');
    assert.equal(tu.payload.name, 'Read');
    assert.ok(tu.payload.inputSummary.includes('file_path'));
    s.dispose();
  });

  test('文件类工具 tool_use → payload.file{path,changeKind}；非文件工具无 file（③）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tool-e', name: 'Edit', input: { file_path: '/repo/a.txt', old_string: 'x', new_string: 'y' } }
    ] } });
    const tu = events.find(e => e.type === 'tool_use' && e.payload.toolUseId === 'tool-e');
    assert.deepEqual(tu.payload.file, { path: '/repo/a.txt', changeKind: 'edit' });

    s.map({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tool-b', name: 'Bash', input: { command: 'ls' } }
    ] } });
    const tb = events.find(e => e.type === 'tool_use' && e.payload.toolUseId === 'tool-b');
    assert.equal(tb.payload.file, undefined);
    s.dispose();
  });

  test('getToolInput：文件类工具缓存完整 input（无损供预览 diff），非文件/不存在 → null（③）', () => {
    const { s } = makeSession();
    s.map({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tool-e', name: 'Edit', input: { file_path: '/repo/a.txt', old_string: 'aaa', new_string: 'bbb' } },
      { type: 'tool_use', id: 'tool-b', name: 'Bash', input: { command: 'ls' } }
    ] } });
    const cached = s.getToolInput('tool-e');
    assert.equal(cached.name, 'Edit');
    assert.equal(cached.input.old_string, 'aaa'); // 完整、未截断
    assert.equal(s.getToolInput('tool-b'), null); // 非文件工具不缓存
    assert.equal(s.getToolInput('nonexistent'), null);
    s.dispose();
  });

  test('assistant 带 text 块（非流式网关兜底）→ text_delta', () => {
    const { s, events } = makeSession();
    s.map({ type: 'assistant', message: { content: [
      { type: 'text', text: 'Full response text' }
    ] } });
    const td = events.find(e => e.type === 'text_delta');
    assert.ok(td);
    assert.equal(td.payload.text, 'Full response text');
    s.dispose();
  });

  test('assistant 带 usage → lastUsage 更新 + onUsage 回调（回归原有测试）', () => {
    let calls = 0;
    const a = new AgentSession({ instanceId: 't1', cwd: '/tmp', claudeBin: 'x', onEvent() {}, onUsage() { calls++; } });
    try {
      a.map({ type: 'assistant', message: { usage: { input_tokens: 1234 }, content: [] } });
      assert.equal(calls, 1);
      assert.deepEqual(a.lastUsage, { input_tokens: 1234 });
    } finally { a.dispose(); }
  });

  test('user/tool_result → tool_result 事件 + denyKind 处理', () => {
    const { s, events } = makeSession();
    s.denyKinds.set('tool-1', 'denied');
    s.map({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'denied' }
    ] } });
    const tr = events.find(e => e.type === 'tool_result');
    assert.ok(tr);
    assert.equal(tr.payload.toolUseId, 'tool-1');
    assert.equal(tr.payload.ok, false);
    assert.equal(tr.payload.denyKind, 'denied');
    assert.equal(s.denyKinds.has('tool-1'), false); // 消费后 delete
    s.dispose();
  });

  test('tool_use：input 里的长 base64 载荷被脱敏，不占用 TOOL_SUMMARY_CAP 截断额度', () => {
    const { s, events } = makeSession();
    const bigBase64 = 'A'.repeat(50000); // 纯 base64 字符集，远超截断上限
    s.map({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tool-img-in', name: 'SomeTool', input: { file_path: '/a.jpg', file: { base64: bigBase64 } } }
    ] } });
    const tu = events.find(e => e.type === 'tool_use' && e.payload.toolUseId === 'tool-img-in');
    assert.ok(tu.payload.inputSummary.includes('file_path')); // 正常字段仍可见，未被挤没
    assert.ok(!tu.payload.inputSummary.includes(bigBase64.slice(0, 300))); // 原始 base64 未原样吐出
    assert.match(tu.payload.inputSummary, /已省略/);
    s.dispose();
  });

  test('tool_result：Read 读图片等场景 raw 里的长 base64 被脱敏（真实病灶：outputSummary）', () => {
    const { s, events } = makeSession();
    const bigBase64 = 'B'.repeat(50000);
    s.map({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tool-img-out', is_error: false,
        content: [{ type: 'image', file: { base64: bigBase64 } }] }
    ] } });
    const tr = events.find(e => e.type === 'tool_result' && e.payload.toolUseId === 'tool-img-out');
    assert.ok(!tr.payload.outputSummary.includes(bigBase64.slice(0, 300)));
    assert.match(tr.payload.outputSummary, /已省略/);
    s.dispose();
  });

  test('base64 脱敏不误伤真实长代码（保护 Edit/Write 预览 diff，含换行大括号不会被判成二进制）', () => {
    const { s, events } = makeSession();
    const longCode = 'function foo() {\n  return 1;\n}\n'.repeat(50);
    s.map({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tool-edit', name: 'Edit', input: { file_path: '/a.js', old_string: 'x', new_string: longCode } }
    ] } });
    const tu = events.find(e => e.type === 'tool_use' && e.payload.toolUseId === 'tool-edit');
    assert.ok(tu.payload.inputSummary.includes('function foo')); // 真代码原样保留
    s.dispose();
  });

  test('base64 脱敏不误伤短 base64 状字符串（如短 hash/id，长度不到阈值）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tool-short', name: 'Bash', input: { command: 'echo', hash: 'YWJjMTIz' } }
    ] } });
    const tu = events.find(e => e.type === 'tool_use' && e.payload.toolUseId === 'tool-short');
    assert.ok(tu.payload.inputSummary.includes('YWJjMTIz'));
    s.dispose();
  });

  test('result → pendingTurns 递减、cost/duration 累加、text 字段随发', () => {
    const { s, events } = makeSession();
    s.pendingTurns = 1;
    s.assistantResponseBuffer = 'This is the full reply';
    s.currentMessageId = 'msg-1';
    s.map({ type: 'result', subtype: 'success', duration_ms: 1500, total_cost_usd: 0.123,
      is_error: false, modelUsage: { 'claude-sonnet': { input_tokens: 100 } } });
    assert.equal(s.pendingTurns, 0);
    assert.equal(s.totalCostUsd, 0.123);
    assert.equal(s.totalDurationMs, 1500);
    const r = events.find(e => e.type === 'result');
    assert.ok(r);
    assert.equal(r.payload.durationMs, 1500);
    assert.equal(r.payload.costUsd, 0.123);
    assert.equal(r.payload.isError, false);
    assert.deepEqual(r.payload.models, ['claude-sonnet']);
    assert.equal(r.payload.text, 'This is the full reply');
    assert.equal(s.assistantResponseBuffer, ''); // 清零
    s.dispose();
  });

  test('result：subtype != success → errors 字段', () => {
    const { s, events } = makeSession();
    s.map({ type: 'result', subtype: 'error', duration_ms: 100, is_error: true,
      errors: ['timeout'], modelUsage: {} });
    const r = events.find(e => e.type === 'result');
    assert.equal(r.payload.isError, true);
    assert.deepEqual(r.payload.errors, ['timeout']);
    s.dispose();
  });

  test('stream_event 的 parent_tool_use_id 非空 → 跳过', () => {
    const { s, events } = makeSession();
    s.map({ type: 'stream_event', event: { type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'sub' } }, parent_tool_use_id: 'parent-1', uuid: 'u1' });
    // 无 text_delta 事件
    assert.equal(events.length, 0);
    s.dispose();
  });

  test('assistant 的 parent_tool_use_id 非空 → 跳过（子 agent 不外露，与 history isSidechain 侧对称）', () => {
    const { s, events } = makeSession();
    // 子 agent 的 assistant 消息（带 tool_use + 文字正文）——运行期守卫应整条跳过，不 emit 任何事件。
    s.map({ type: 'assistant', parent_tool_use_id: 'parent-1', message: { content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', text: '子 agent 内部文字' },
    ] } });
    assert.equal(events.length, 0, '带 parent_tool_use_id 的 assistant 不应 emit tool_use/text_delta');
    s.dispose();
  });

  test('assistant 带 error 且 parent_tool_use_id 非空 → 子 agent 内部报错不应误报为主会话 error（code-review P0）', () => {
    const { s, events } = makeSession();
    // 子 agent（Task 工具内部）自己的一次 API 报错（如限流），不是主会话级别的失败。
    s.map({ type: 'assistant', error: 'rate_limit', parent_tool_use_id: 'parent-1',
      message: { content: [{ type: 'text', text: 'API Error: 429 Too Many Requests' }] } });
    assert.equal(events.length, 0, '子 agent 自己的 API 报错不应外露为主会话 error 事件');
    s.dispose();
  });

  test('user 的 parent_tool_use_id 非空 → 跳过（子 agent 不外露）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'user', parent_tool_use_id: 'parent-1', message: { content: [
      { type: 'text', text: '子 agent 的 user 回合' },
    ] } });
    assert.equal(events.length, 0, '带 parent_tool_use_id 的 user 不应 emit 任何事件');
    s.dispose();
  });
});

// ---- 后台任务完成通知（Workflow / 后台 Agent / 后台 Bash）----
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

  test('SDK interrupt 抛错 → 队列不动、pendingTurns 不动', async () => {
    const { s, events } = makeSession();
    s.pendingTurns = 2;
    s.queue.push({ text: 'msg' });
    s.q = { interrupt() { return Promise.reject(new Error('no task')); } };
    await s.interrupt();
    assert.equal(s.queue.length, 1); // 未清
    assert.equal(s.pendingTurns, 2); // 未变
    const sys = events.find(e => e.type === 'system' && e.payload.message === '当前没有可中断的任务');
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

// ---- 权限闸门 ----
test.describe('权限闸门', () => {
  test('sdkPermissionMode：bypass → default，其余原样', () => {
    const { s } = makeSession();
    assert.equal(s.sdkPermissionMode(), 'default');
    s.permissionMode = 'plan';
    assert.equal(s.sdkPermissionMode(), 'plan');
    s.permissionMode = 'bypassPermissions';
    assert.equal(s.sdkPermissionMode(), 'default');
    s.permissionMode = 'dontAsk';
    assert.equal(s.sdkPermissionMode(), 'dontAsk');
    s.dispose();
  });

  test('handleCanUseTool：AskUserQuestion → handleQuestion', () => {
    const { s, events } = makeSession();
    const result = s.handleCanUseTool('AskUserQuestion', { questions: [] }, { signal: new AbortController().signal, toolUseID: 'q1' });
    // 空 questions → allow
    assert.deepEqual(result, { behavior: 'allow', updatedInput: { questions: [] } });
    s.dispose();
  });

  test('handleCanUseTool：dontAsk → deny（防御纵深）', () => {
    const { s } = makeSession({ permissionMode: 'dontAsk' });
    const result = s.handleCanUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 't1' });
    assert.equal(result.behavior, 'deny');
    assert.equal(result.interrupt, true);
    s.dispose();
  });

  test('handleCanUseTool：bypassPermissions → allow', () => {
    const { s } = makeSession({ permissionMode: 'bypassPermissions' });
    const result = s.handleCanUseTool('Read', { file_path: '/a' }, { signal: new AbortController().signal, toolUseID: 't1' });
    assert.equal(result.behavior, 'allow');
    s.dispose();
  });

  test('handleCanUseTool：default → askPermission（返回 Promise）', () => {
    const { s } = makeSession();
    const result = s.handleCanUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 't1' });
    assert.ok(result instanceof Promise);
    // 不应影响已有 Promise — 清理
    s.resolvePermission('t1', 'deny');
    s.dispose();
  });

  test('askPermission：emit permission_request + pendingPermissions 写入', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const promise = s.askPermission('Bash', { command: 'rm -rf /' }, { signal: ac.signal, toolUseID: 't1' });
    assert.ok(promise instanceof Promise);
    assert.equal(s.pendingPermissions.size, 1);
    const pr = events.find(e => e.type === 'permission_request');
    assert.ok(pr);
    assert.equal(pr.payload.requestId, 't1');
    assert.equal(pr.payload.name, 'Bash');
    assert.ok(pr.payload.input.command.includes('rm'));
    // 清理
    s.resolvePermission('t1', 'deny');
    s.dispose();
  });

  test('resolvePermission(allow)：removeEventListener + emit request_resolved + alwaysThisSession', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    let removed = false;
    const origRemove = ac.signal.removeEventListener;
    ac.signal.removeEventListener = (type, fn) => { removed = true; origRemove.call(ac.signal, type, fn); };

    const promise = s.askPermission('Read', { file_path: '/a.txt' }, {
      signal: ac.signal, toolUseID: 't1',
      suggestions: [{ destination: 'session', permission: 'allow', toolName: 'Read' }]
    });
    // NFR-17 审批完整性绑定：allow 决策须回传与 askPermission 时锚定 fp 匹配的 op，否则 fail-closed 拒绝。
    s.resolvePermission('t1', 'allow', true, { tool: 'Read', args: { file_path: '/a.txt' }, cwd: s.cwd });

    assert.equal(removed, true);
    assert.equal(s.pendingPermissions.size, 0);
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
    assert.ok(rr);
    assert.equal(rr.payload.outcome, 'allow');
    s.dispose();
  });

  test('resolvePermission(deny)：denyKinds 设置 + request_resolved', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.askPermission('Bash', { command: 'rm' }, { signal: ac.signal, toolUseID: 't1' });
    s.resolvePermission('t1', 'deny');
    assert.equal(s.denyKinds.get('t1'), 'denied');
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
    assert.equal(rr.payload.outcome, 'deny');
    s.dispose();
  });

  // 审批 TTL（LLD §3.5.2/§4，承接 OQ-05 fail-closed）
  test('askPermission：permission_request payload 附 createdAt/expiresAt（expiresAt=createdAt+TTL）', () => {
    const { s, events } = makeSession({ approvalTtlMs: 5000 });
    const ac = new AbortController();
    s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });
    const pr = events.find(e => e.type === 'permission_request');
    assert.ok(typeof pr.payload.createdAt === 'number');
    assert.equal(pr.payload.expiresAt, pr.payload.createdAt + 5000);
    s.resolvePermission('t1', 'deny');
    s.dispose();
  });

  test('resolvePermission：已过期 → 不论 decision 一律按 deny 处理，outcome=expired', async () => {
    const { s, events } = makeSession({ approvalTtlMs: 1 }); // 1ms TTL，立刻过期
    const ac = new AbortController();
    const promise = s.askPermission('Bash', { command: 'rm -rf /' }, { signal: ac.signal, toolUseID: 't1' });
    await new Promise(r => setTimeout(r, 20)); // 确保已越过 1ms TTL
    // 过期检查先于完整性校验，op 是否匹配不影响本测试结论——仍传正确 op 保持调用形态真实。
    s.resolvePermission('t1', 'allow', false, { tool: 'Bash', args: { command: 'rm -rf /' }, cwd: s.cwd }); // 即便传 allow，过期后也不应放行
    const result = await promise;
    assert.equal(result.behavior, 'deny', '过期后不可再兑现，即便传 allow 也必须 deny（fail-closed）');
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
    assert.equal(rr.payload.outcome, 'expired', 'outcome 应标 expired，区别于用户主动 allow/deny');
    assert.equal(s.denyKinds.get('t1'), 'denied');
    s.dispose();
  });

  test('resolvePermission：未过期时 TTL 机制不影响正常 allow/deny（回归）', async () => {
    const { s, events } = makeSession({ approvalTtlMs: 60_000 }); // 60s，测试期间不可能过期
    const ac = new AbortController();
    const promise = s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });
    s.resolvePermission('t1', 'allow', false, { tool: 'Bash', args: { command: 'ls' }, cwd: s.cwd });
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
    assert.equal(rr.payload.outcome, 'allow');
    s.dispose();
  });

  // 审批完整性绑定（LLD §3.1.3/§5.5，承接 AD-7/NFR-17，"所批即所行"）
  test.describe('审批完整性绑定（NFR-17）', () => {
    test('askPermission：permission_request payload 附 fp，且等于 fingerprintSync({tool,args,cwd})', async () => {
      const { fingerprintSync } = await import('../fingerprint.js');
      const { s, events } = makeSession({ cwd: '/tmp/proj' });
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'ls -la' }, { signal: ac.signal, toolUseID: 't1' });
      const pr = events.find(e => e.type === 'permission_request');
      assert.equal(pr.payload.fp, fingerprintSync({ tool: 'Bash', args: { command: 'ls -la' }, cwd: '/tmp/proj' }));
      s.resolvePermission('t1', 'deny');
      s.dispose();
    });

    test('resolvePermission(allow)：clientOp 与锚定 fp 不符（参数被篡改）→ fail-closed deny，outcome=integrity_mismatch', async () => {
      const { s, events } = makeSession();
      const ac = new AbortController();
      const promise = s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });
      // 客户端回传的 op 与卡片渲染/锚定时的 { command: 'ls' } 不一致——模拟传输层被篡改
      s.resolvePermission('t1', 'allow', false, { tool: 'Bash', args: { command: 'rm -rf /' }, cwd: s.cwd });
      const result = await promise;
      assert.equal(result.behavior, 'deny', '完整性不符必须 fail-closed 拒绝，即便 decision 是 allow');
      assert.equal(result.interrupt, false);
      const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
      assert.equal(rr.payload.outcome, 'integrity_mismatch');
      assert.equal(s.denyKinds.get('t1'), 'denied');
      s.dispose();
    });

    test('resolvePermission(allow)：clientOp 缺失（未回传 op）→ fail-closed deny，outcome=integrity_mismatch', async () => {
      const { s, events } = makeSession();
      const ac = new AbortController();
      const promise = s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });
      s.resolvePermission('t1', 'allow', false); // 不传 clientOp（如旧客户端/协议缺字段）
      const result = await promise;
      assert.equal(result.behavior, 'deny');
      const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
      assert.equal(rr.payload.outcome, 'integrity_mismatch');
      s.dispose();
    });

    test('resolvePermission(allow)：clientOp 的 cwd 与锚定不符（args/tool 不变）→ fail-closed deny', async () => {
      const { s, events } = makeSession({ cwd: '/workdir-a' });
      const ac = new AbortController();
      const promise = s.askPermission('Read', { file_path: '/x' }, { signal: ac.signal, toolUseID: 't1' });
      s.resolvePermission('t1', 'allow', false, { tool: 'Read', args: { file_path: '/x' }, cwd: '/workdir-b' });
      const result = await promise;
      assert.equal(result.behavior, 'deny');
      const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
      assert.equal(rr.payload.outcome, 'integrity_mismatch');
      s.dispose();
    });

    test('resolvePermission(deny)：不校验完整性——clientOp 缺失/不符也不影响 deny 决策本身正常生效', async () => {
      const { s, events } = makeSession();
      const ac = new AbortController();
      const promise = s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });
      s.resolvePermission('t1', 'deny', false); // deny 决策：不传 clientOp，不应被误判为 integrity_mismatch
      const result = await promise;
      assert.equal(result.behavior, 'deny');
      const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 't1');
      assert.equal(rr.payload.outcome, 'deny', 'deny 路径的 outcome 应保持 deny，不应被完整性校验分支抢先接管');
      s.dispose();
    });

    test('pendingRequestsSnapshot()：真实 askPermission 产生的 fp 原样出现在快照里（非手造数据）', async () => {
      const { fingerprintSync } = await import('../fingerprint.js');
      const { s } = makeSession({ cwd: '/tmp/proj' });
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 't1' });
      const snap = s.pendingRequestsSnapshot();
      assert.equal(snap.permissions[0].fp, fingerprintSync({ tool: 'Bash', args: { command: 'ls' }, cwd: '/tmp/proj' }));
      s.resolvePermission('t1', 'deny');
      s.dispose();
    });
  });

  // 持久化台账（LLD §4 approval_request 表，承接 NFR-16/19/22，Phase 4）——askPermission/resolvePermission
  // 写穿透到 approval-store.js。测试用真实模块（非 mock）：CCM_APPROVAL_STORE_FILE 由
  // test/_preload-env.mjs 重定向到一次性临时文件，不碰真实 data/approval-requests.json。
  test.describe('审批持久化台账（NFR-16/19，Phase 4）', () => {
    test('askPermission：立即在台账里生成一条 status=pending 记录', async () => {
      const AS = await import('../approval-store.js');
      const { s } = makeSession({ cwd: '/tmp/proj-store-1' });
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'echo a' }, { signal: ac.signal, toolUseID: 'store-t1' });
      const r = AS.getByReqId('store-t1');
      assert.ok(r);
      assert.equal(r.status, 'pending');
      assert.equal(r.tool, 'Bash');
      assert.equal(r.cwd, '/tmp/proj-store-1');
      assert.equal(r.sessionId, s.sessionId);
      s.resolvePermission('store-t1', 'deny');
      s.dispose();
    });

    test('resolvePermission(allow)：台账 status 更新为 allow，返回值为 "allow"', async () => {
      const AS = await import('../approval-store.js');
      const { s } = makeSession();
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 'store-t2' });
      const outcome = s.resolvePermission('store-t2', 'allow', false, { tool: 'Bash', args: { command: 'ls' }, cwd: s.cwd });
      assert.equal(outcome, 'allow');
      assert.equal(AS.getByReqId('store-t2').status, 'allow');
      s.dispose();
    });

    test('resolvePermission(deny)：台账 status 更新为 deny，返回值为 "deny"', async () => {
      const AS = await import('../approval-store.js');
      const { s } = makeSession();
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 'store-t3' });
      const outcome = s.resolvePermission('store-t3', 'deny');
      assert.equal(outcome, 'deny');
      assert.equal(AS.getByReqId('store-t3').status, 'deny');
      s.dispose();
    });

    test('resolvePermission：完整性校验失败 → 台账 status=integrity_mismatch，返回值同 outcome', async () => {
      const AS = await import('../approval-store.js');
      const { s } = makeSession();
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 'store-t4' });
      const outcome = s.resolvePermission('store-t4', 'allow', false, { tool: 'Bash', args: { command: 'rm -rf /' }, cwd: s.cwd });
      assert.equal(outcome, 'integrity_mismatch');
      assert.equal(AS.getByReqId('store-t4').status, 'integrity_mismatch');
      s.dispose();
    });

    test('resolvePermission：已过期 → 台账 status=expired，返回值为 "expired"', async () => {
      const AS = await import('../approval-store.js');
      const { s } = makeSession({ approvalTtlMs: 1 });
      const ac = new AbortController();
      const promise = s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 'store-t5' });
      await new Promise(r => setTimeout(r, 20));
      const outcome = s.resolvePermission('store-t5', 'allow', false, { tool: 'Bash', args: { command: 'ls' }, cwd: s.cwd });
      assert.equal(outcome, 'expired');
      assert.equal(AS.getByReqId('store-t5').status, 'expired');
      await promise;
      s.dispose();
    });

    test('resolvePermission：找不到 pending（已消费/已 abort）→ 返回 undefined，不写台账', async () => {
      const { s } = makeSession();
      const outcome = s.resolvePermission('never-existed-reqid', 'allow');
      assert.equal(outcome, undefined);
      s.dispose();
    });

    test('abort：台账 status 更新为 aborted', async () => {
      const AS = await import('../approval-store.js');
      const { s } = makeSession();
      const ac = new AbortController();
      s.askPermission('Bash', { command: 'ls' }, { signal: ac.signal, toolUseID: 'store-t6' });
      ac.abort();
      assert.equal(AS.getByReqId('store-t6').status, 'aborted');
      s.dispose();
    });
  });

  test('abort signal 触发 → pendingPermissions.delete + request_resolved(aborted) + denyKinds(cancelled)', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.askPermission('Bash', { command: 'rm' }, { signal: ac.signal, toolUseID: 't1' });
    ac.abort();
    assert.equal(s.pendingPermissions.size, 0);
    assert.equal(s.denyKinds.get('t1'), 'cancelled');
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.outcome === 'aborted');
    assert.ok(rr);
    s.dispose();
  });

  test('setPermissionMode：无效档 → emit error', () => {
    const { s, events } = makeSession();
    s.setPermissionMode('invalid');
    const err = events.find(e => e.type === 'error');
    assert.ok(err);
    assert.ok(err.payload.message.includes('未知权限档'));
    s.dispose();
  });

  test('setPermissionMode：有效档 → 更新 permissionMode', async () => {
    const { s } = makeSession();
    // setPermissionMode 是 async——可选链 await this.q?.setPermissionMode 对 null q 即 no-op
    await s.setPermissionMode('plan');
    assert.equal(s.permissionMode, 'plan');
    s.dispose();
  });

  test("setPermissionMode：'auto'（SDK 实际支持的第 6 档，模型分类器自动批准/拒绝）应被接受，不报未知权限档（code-review P1）", async () => {
    const { s, events } = makeSession();
    const ok = await s.setPermissionMode('auto');
    assert.equal(ok, true);
    assert.equal(s.permissionMode, 'auto');
    assert.equal(events.find(e => e.type === 'error'), undefined);
    s.dispose();
  });

  // 批准内含的模式切换：若 SDK 经 canUseTool 的 suggestions 给出 setMode PermissionUpdate，批准时应始终
  // 应用（非「始终允许」可选项）→ 回传 SDK + 更新本实例档 + emit permission_mode 让 server 同步手机端图标。
  // 注：这是「SDK 主动下发 suggestion」的前向兼容路径——实测当前 SDK 的 ExitPlanMode 并不走这里（见下条），
  // 但别的工具/未来版本可能给 setMode，故此路径优先于兜底。
  test('resolvePermission(allow)：setMode suggestion → 应用 + emit permission_mode + 更新 permissionMode', async () => {
    const { s, events } = makeSession({ permissionMode: 'plan' });
    const ac = new AbortController();
    const promise = s.askPermission('SomeTool', { x: 1 }, {
      signal: ac.signal, toolUseID: 't1',
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    });
    s.resolvePermission('t1', 'allow', false, { tool: 'SomeTool', args: { x: 1 }, cwd: s.cwd }); // 非「始终允许」，但 setMode 仍应应用
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(result.updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
    assert.equal(s.permissionMode, 'acceptEdits'); // 本实例档跟随
    const pm = events.find(e => e.type === 'permission_mode');
    assert.ok(pm, '应 emit permission_mode 供 server 同步前端图标');
    assert.equal(pm.payload.mode, 'acceptEdits');
    s.dispose();
  });

  // 回归（核心 bug）：实测 SDK 的 ExitPlanMode checkPermissions 只回 {behavior:'ask'}、不带任何 setMode
  // suggestion → 批准后若不兜底则 updatedPermissions 为空、SDK 内部仍停 plan、前端图标停「计划模式」。
  // 兜底须对 ExitPlanMode 合成「退出到 default」=回传 SDK 退 plan + emit permission_mode 同步前端。
  test('resolvePermission(allow)：ExitPlanMode 无 suggestion → 兜底合成 setMode default（退出 plan）', async () => {
    const { s, events } = makeSession({ permissionMode: 'plan' });
    const ac = new AbortController();
    const promise = s.askPermission('ExitPlanMode', { plan: '…' }, {
      signal: ac.signal, toolUseID: 't1', suggestions: undefined // 真 SDK 行为：无 suggestions
    });
    s.resolvePermission('t1', 'allow', false, { tool: 'ExitPlanMode', args: { plan: '…' }, cwd: s.cwd });
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(result.updatedPermissions, [{ type: 'setMode', mode: 'default', destination: 'session' }],
      '须回传合成 setMode default 让 SDK 真退出 plan');
    assert.equal(s.permissionMode, 'default'); // 本实例档退出 plan
    const pm = events.find(e => e.type === 'permission_mode');
    assert.ok(pm, '应 emit permission_mode 供 server 同步前端图标');
    assert.equal(pm.payload.mode, 'default');
    s.dispose();
  });

  // 对齐 CLI plan-exit：用户批准时可选手 default / acceptEdits / bypassPermissions
  test('resolvePermission(allow)：ExitPlanMode + exitMode=acceptEdits → setMode acceptEdits', async () => {
    const { s, events } = makeSession({ permissionMode: 'plan' });
    const ac = new AbortController();
    const promise = s.askPermission('ExitPlanMode', { plan: '…' }, {
      signal: ac.signal, toolUseID: 't1', suggestions: undefined
    });
    s.resolvePermission('t1', 'allow', false, { tool: 'ExitPlanMode', args: { plan: '…' }, cwd: s.cwd }, { exitMode: 'acceptEdits' });
    const result = await promise;
    assert.deepEqual(result.updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
    assert.equal(s.permissionMode, 'acceptEdits');
    assert.equal(events.find(e => e.type === 'permission_mode')?.payload.mode, 'acceptEdits');
    s.dispose();
  });

  test('resolvePermission(allow)：ExitPlanMode + exitMode=bypassPermissions → setMode bypass', async () => {
    const { s } = makeSession({ permissionMode: 'plan' });
    const ac = new AbortController();
    const promise = s.askPermission('ExitPlanMode', { plan: '…' }, {
      signal: ac.signal, toolUseID: 't1', suggestions: undefined
    });
    s.resolvePermission('t1', 'allow', false, { tool: 'ExitPlanMode', args: { plan: '…' }, cwd: s.cwd }, { exitMode: 'bypassPermissions' });
    const result = await promise;
    assert.equal(result.updatedPermissions[0].mode, 'bypassPermissions');
    assert.equal(s.permissionMode, 'bypassPermissions');
    s.dispose();
  });

  test('resolvePermission(allow)：ExitPlanMode + 非法 exitMode → 回落 default', async () => {
    const { s } = makeSession({ permissionMode: 'plan' });
    const ac = new AbortController();
    const promise = s.askPermission('ExitPlanMode', { plan: '…' }, {
      signal: ac.signal, toolUseID: 't1', suggestions: undefined
    });
    s.resolvePermission('t1', 'allow', false, { tool: 'ExitPlanMode', args: { plan: '…' }, cwd: s.cwd }, { exitMode: 'nope' });
    const result = await promise;
    assert.equal(result.updatedPermissions[0].mode, 'default');
    s.dispose();
  });

  test('resolvePermission(allow)：无 setMode 且非 alwaysThisSession → 不改档、不 emit permission_mode、updatedPermissions 为空', async () => {
    const { s, events } = makeSession({ permissionMode: 'default' });
    const ac = new AbortController();
    const promise = s.askPermission('Bash', { command: 'ls' }, {
      signal: ac.signal, toolUseID: 't1',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }]
    });
    s.resolvePermission('t1', 'allow', false, { tool: 'Bash', args: { command: 'ls' }, cwd: s.cwd });
    const result = await promise;
    assert.equal(result.updatedPermissions, undefined); // 非 always + 无 setMode → 不带
    assert.equal(s.permissionMode, 'default');
    assert.equal(events.find(e => e.type === 'permission_mode'), undefined);
    s.dispose();
  });

  test('resolvePermission(allow)：alwaysThisSession → 回传 session 范围规则（保持原行为）', async () => {
    const { s } = makeSession();
    const ac = new AbortController();
    const rules = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }];
    const promise = s.askPermission('Bash', { command: 'ls' }, {
      signal: ac.signal, toolUseID: 't1', suggestions: rules
    });
    s.resolvePermission('t1', 'allow', true, { tool: 'Bash', args: { command: 'ls' }, cwd: s.cwd });
    const result = await promise;
    assert.deepEqual(result.updatedPermissions, rules);
    s.dispose();
  });
});

// ---- AskUserQuestion ----
test.describe('AskUserQuestion', () => {
  test('handleQuestion：空 questions → allow', () => {
    const { s } = makeSession();
    const result = s.handleQuestion({ questions: [] }, { signal: new AbortController().signal, toolUseID: 'q1' });
    assert.deepEqual(result, { behavior: 'allow', updatedInput: { questions: [] } });
    s.dispose();
  });

  test('handleQuestion：正常 → emit question 事件 × N、pendingQuestions 写入', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Pick one', options: ['A', 'B'] }, { question: 'Why?', options: ['reason1'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    assert.ok(promise instanceof Promise);
    assert.equal(s.pendingQuestions.size, 1);
    const qs = events.filter(e => e.type === 'question');
    assert.equal(qs.length, 2);
    assert.equal(qs[0].payload.requestId, 'q1#0');
    assert.equal(qs[1].payload.requestId, 'q1#1');
    // 清理
    s.resolveQuestion('q1#0', 0);
    s.resolveQuestion('q1#1', 0);
    s.dispose();
  });

  test('resolveQuestion：部分答题不 resolve', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A', 'B'] }, { question: 'Q2', options: ['X'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', 1); // 选 B
    assert.equal(s.pendingQuestions.size, 1); // 还在
    s.dispose();
  });

  test('resolveQuestion：全部答完 → removeEventListener + request_resolved + denyKinds(answered)', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    let removed = false;
    const origRemove = ac.signal.removeEventListener;
    ac.signal.removeEventListener = (type, fn) => { removed = true; origRemove.call(ac.signal, type, fn); };

    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A', 'B'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', 0);
    assert.equal(s.pendingQuestions.size, 0);
    assert.equal(removed, true);
    assert.equal(s.denyKinds.get('q1'), 'answered');
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.kind === 'question');
    assert.ok(rr);
    assert.ok(rr.payload.outcome.includes('「'));
    s.dispose();
  });

  test('abort signal 触发 → 逐个 request_resolved(aborted) + denyKinds(cancelled)', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A'] }, { question: 'Q2', options: ['B'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    ac.abort();
    assert.equal(s.pendingQuestions.size, 0);
    assert.equal(s.denyKinds.get('q1'), 'cancelled');
    const aborted = events.filter(e => e.type === 'request_resolved' && e.payload.outcome === 'aborted');
    assert.equal(aborted.length, 2);
    s.dispose();
  });

  test('resolveQuestion：越界 optionIndex 不作答', () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', 99); // 越界
    assert.equal(s.pendingQuestions.size, 1); // 还在
    s.dispose();
  });

  // 对齐 CLI：AskUserQuestion 自动提供 Other，用户可自由文本作答（不在模型给的 options 下标里）
  test('resolveQuestion：freeText（Other）作答 → answered，文案含自由文本', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Which lib?', options: ['dayjs', 'luxon'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', null, { freeText: '  date-fns  ' });
    assert.equal(s.pendingQuestions.size, 0);
    assert.equal(s.denyKinds.get('q1'), 'answered');
    const result = await promise;
    assert.equal(result.behavior, 'deny');
    assert.match(result.message, /date-fns/);
    assert.ok(!result.message.includes('dayjs') || result.message.includes('date-fns'));
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.kind === 'question');
    assert.ok(rr.payload.outcome.includes('date-fns'));
    s.dispose();
  });

  test('resolveQuestion：freeText 空白 → 不作答（防空 Other）', () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', null, { freeText: '   ' });
    assert.equal(s.pendingQuestions.size, 1);
    s.dispose();
  });

  test('resolveQuestion：freeText 优先于 optionIndex（同时传时用自由文本）', async () => {
    const { s } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A', 'B'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', 0, { freeText: 'custom answer' });
    const result = await promise;
    assert.match(result.message, /custom answer/);
    assert.ok(!result.message.includes('「A」') || result.message.includes('custom'));
    s.dispose();
  });

  // 对齐 CLI：透传 header / multiSelect / option.description|preview，不再只剩 label 字符串
  test('handleQuestion：emit 保留 header/multiSelect/option 详情', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{
        question: 'Which features?',
        header: 'Features',
        multiSelect: true,
        options: [
          { label: 'A', description: 'Alpha', preview: '```a```' },
          { label: 'B', description: 'Beta' },
        ],
      }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    const q = events.find(e => e.type === 'question');
    assert.equal(q.payload.header, 'Features');
    assert.equal(q.payload.multiSelect, true);
    assert.deepEqual(q.payload.options[0], { label: 'A', description: 'Alpha', preview: '```a```' });
    assert.deepEqual(q.payload.options[1], { label: 'B', description: 'Beta' });
    s.resolveQuestion('q1#0', null, { optionIndexes: [0] });
    s.dispose();
  });

  test('resolveQuestion：multiSelect optionIndexes 多选合并', async () => {
    const { s } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Pick many', multiSelect: true, options: ['A', 'B', 'C'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', null, { optionIndexes: [0, 2] });
    const result = await promise;
    // 多选合并进同一对书名号：用户选择了：「A、C」
    assert.match(result.message, /「A、C」/);
    assert.ok(!result.message.includes('B'));
    s.dispose();
  });

  test('resolveQuestion：optionIndexes 空/非法 → 不作答', () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q', multiSelect: true, options: ['A', 'B'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', null, { optionIndexes: [] });
    assert.equal(s.pendingQuestions.size, 1);
    s.resolveQuestion('q1#0', null, { optionIndexes: [99] });
    assert.equal(s.pendingQuestions.size, 1);
    s.dispose();
  });

  test('pendingRequestsSnapshot：未答问题保留 rich options/header/multiSelect', () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{
        question: 'Q',
        header: 'H',
        multiSelect: true,
        options: [{ label: 'A', description: 'desc' }],
      }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    const snap = s.pendingRequestsSnapshot();
    assert.equal(snap.questions.length, 1);
    assert.equal(snap.questions[0].header, 'H');
    assert.equal(snap.questions[0].multiSelect, true);
    assert.deepEqual(snap.questions[0].options[0], { label: 'A', description: 'desc' });
    s.dispose();
  });
});

// ---- 跨实例隔离（跨 tab 审批/提问回答不串台）----
// 坐实诊断「安全」结论的服务端支柱：user:approve/answer → routeInstance(instanceId)?.resolvePermission/
// resolveQuestion(requestId)。不变量 = 回答按 (instanceId→实例) + (requestId→该实例内挂起项) 双重定位。
// 错 instanceId（切到 tab Y 后误用 Y 的 instanceId 回答 tab X 的弹窗）→ 目标实例无此 requestId →
// no-op：X 审批仍挂起、Y 审批不受波及，绝不跨实例误批/误拒。配合前端 clearView 切 tab 清弹窗（已静态确认），
// 即便前端那道闸失守，服务端这道双重定位仍兜底。
test.describe('跨实例隔离（跨 tab 回答不串台）', () => {
  test('resolvePermission：错 instanceId 路由是 no-op，两实例审批互不影响', () => {
    const X = makeSession({ instanceId: 'inst_X' });
    const Y = makeSession({ instanceId: 'inst_Y' });
    X.s.askPermission('Bash', { command: 'x' }, { signal: new AbortController().signal, toolUseID: 'reqX' });
    Y.s.askPermission('Bash', { command: 'y' }, { signal: new AbortController().signal, toolUseID: 'reqY' });
    // 切到 Y 后误用 Y 的 instanceId 答 X 弹窗的 requestId：routeInstance(Y).resolvePermission(reqX)
    Y.s.resolvePermission('reqX', 'allow');
    assert.equal(X.s.pendingPermissions.size, 1, 'reqX 仍挂起（错路由 no-op，未被误批）');
    assert.equal(Y.s.pendingPermissions.size, 1, 'reqY 未受波及');
    X.s.dispose(); Y.s.dispose();
  });

  test('resolvePermission：正确路由只解决目标实例，邻居 Promise 不 resolve', async () => {
    const X = makeSession({ instanceId: 'inst_X' });
    const Y = makeSession({ instanceId: 'inst_Y' });
    let outY = 'pending';
    const pX = X.s.askPermission('Bash', { command: 'x' }, { signal: new AbortController().signal, toolUseID: 'reqX' });
    Y.s.askPermission('Bash', { command: 'y' }, { signal: new AbortController().signal, toolUseID: 'reqY' }).then(r => { outY = r.behavior; });
    X.s.resolvePermission('reqX', 'allow', false, { tool: 'Bash', args: { command: 'x' }, cwd: X.s.cwd });
    assert.equal((await pX).behavior, 'allow', 'reqX 解决为 allow');
    assert.equal(X.s.pendingPermissions.size, 0);
    assert.equal(Y.s.pendingPermissions.size, 1, 'reqY 仍挂起');
    assert.equal(outY, 'pending', 'reqY 的 Promise 未被 resolve');
    X.s.dispose(); Y.s.dispose();
  });

  test('相同 requestId 跨实例不碰撞（各自 pendingPermissions 独立）', async () => {
    const X = makeSession({ instanceId: 'inst_X' });
    const Y = makeSession({ instanceId: 'inst_Y' });
    const pX = X.s.askPermission('Bash', { command: 'x' }, { signal: new AbortController().signal, toolUseID: 'dup' });
    const pY = Y.s.askPermission('Bash', { command: 'y' }, { signal: new AbortController().signal, toolUseID: 'dup' });
    X.s.resolvePermission('dup', 'deny'); // 只动 X 的 'dup'
    assert.equal((await pX).behavior, 'deny');
    assert.equal(X.s.pendingPermissions.size, 0);
    assert.equal(Y.s.pendingPermissions.size, 1, '同名 requestId 在 Y 仍挂起');
    Y.s.resolvePermission('dup', 'allow', false, { tool: 'Bash', args: { command: 'y' }, cwd: Y.s.cwd });
    assert.equal((await pY).behavior, 'allow');
    X.s.dispose(); Y.s.dispose();
  });

  test('resolveQuestion：错 instanceId 路由是 no-op，两实例提问互不影响', () => {
    const X = makeSession({ instanceId: 'inst_X' });
    const Y = makeSession({ instanceId: 'inst_Y' });
    X.s.handleQuestion({ questions: [{ question: 'QX', options: ['A', 'B'] }] }, { signal: new AbortController().signal, toolUseID: 'qX' });
    Y.s.handleQuestion({ questions: [{ question: 'QY', options: ['A', 'B'] }] }, { signal: new AbortController().signal, toolUseID: 'qY' });
    Y.s.resolveQuestion('qX#0', 0); // 误用 Y 回答 X 的 question requestId
    assert.equal(X.s.pendingQuestions.size, 1, 'qX 仍挂起');
    assert.equal(Y.s.pendingQuestions.size, 1, 'qY 未受波及');
    X.s.dispose(); Y.s.dispose();
  });
});

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
  test('pendingTurns=0 → 直接 return（不设 terminating）', () => {
    const { s } = makeSession();
    s.pendingTurns = 0;
    s.checkIdle();
    assert.equal(s.terminating, false);
    s.dispose();
  });

  test('pendingPermissions 非空 → lastActivity 刷新，不触发超时', () => {
    const { s } = makeSession({ idleTimeoutMs: 1 });
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
    const { s } = makeSession({ idleTimeoutMs: 1 });
    s.pendingTurns = 1;
    s.lastActivity = 0;
    // 模拟合法 pending 条目（含 questions 数组 + resolve，防 dispose 报错）
    s.pendingQuestions.set('x', { questions: [], resolve() {}, signal: null, abortHandler: null });
    s.checkIdle();
    assert.ok(s.lastActivity > 0);
    s.pendingQuestions.clear();
    s.dispose();
  });

  test('超时 → emit error + terminating=true + abort', () => {
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

// E16：缓存复用累计（reused 指标）+ 失效倒计时数据源（lastCacheHitAt）。
// 二者皆从 assistant.message.usage.cache_read_input_tokens 派生：累计量供「本会话复用了多少 token」，
// 命中墙钟时刻供 statusline 推算 ephemeral cache 失效 deadline（TTL 约定值在 statusline.js，此处只记观测时刻）。
test.describe('AgentSession 缓存复用累计 + 命中时刻（reused / lastCacheHitAt）', () => {
  const assistantUsage = u => ({ type: 'assistant', uuid: 'u1', message: { usage: u, content: [] } });

  test('构造默认：totalCacheReadTokens=0、lastCacheHitAt=0', () => {
    const { s } = makeSession();
    assert.equal(s.totalCacheReadTokens, 0);
    assert.equal(s.lastCacheHitAt, 0);
    s.dispose();
  });

  test('cache_read>0 → 累加 totalCacheReadTokens + 记录 lastCacheHitAt 墙钟', () => {
    const { s } = makeSession();
    const before = Date.now();
    s.map(assistantUsage({ input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 120_000 }));
    assert.equal(s.totalCacheReadTokens, 120_000);
    assert.ok(s.lastCacheHitAt >= before);
    s.dispose();
  });

  test('多轮累加（reused 是会话累计，非 lastUsage 那样单轮覆盖）', () => {
    const { s } = makeSession();
    s.map(assistantUsage({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 }));
    s.map(assistantUsage({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 250 }));
    assert.equal(s.totalCacheReadTokens, 350);
    s.dispose();
  });

  test('cache_read=0（未命中）→ 不累加、不刷新 lastCacheHitAt（首轮全 creation 即此情形）', () => {
    const { s } = makeSession();
    s.map(assistantUsage({ input_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 }));
    assert.equal(s.totalCacheReadTokens, 0);
    assert.equal(s.lastCacheHitAt, 0);
    s.dispose();
  });

  test('换会话（init 新 session_id）→ reused/lastCacheHitAt 清零（不跨会话残留，与 lastUsage 同步清）', () => {
    const { s } = makeSession({ resumeId: 'sess-A' });
    s.map(assistantUsage({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 }));
    assert.equal(s.totalCacheReadTokens, 500);
    s.map({ type: 'system', subtype: 'init', session_id: 'sess-B' });
    assert.equal(s.totalCacheReadTokens, 0);
    assert.equal(s.lastCacheHitAt, 0);
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
