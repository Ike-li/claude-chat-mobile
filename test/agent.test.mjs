// test/agent.test.mjs —— AgentSession 纯逻辑单测（不 start()、零 token）
// 覆盖构造函数、emit/buffer/eventsSince、map() 全部 SDK 消息类型、
// send()/interrupt()/权限闸门/AskUserQuestion/dispose()/checkIdle()/consume() 退出路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession } from '../agent.js';

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
    resumeId: opts.resumeId || null,
    historicalCostUsd: opts.historicalCostUsd || 0,
    onEvent(e) { events.push(e); },
    onSessionId: opts.onSessionId || (() => {}),
    onExit: opts.onExit || (() => {}),
    onUsage: opts.onUsage || (() => {}),
  });
  return { s, events, dispose: () => s.dispose() };
}

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
    s.resolvePermission('t1', 'allow', true);

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
    s.resolvePermission('t1', 'allow', false); // 非「始终允许」，但 setMode 仍应应用
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
    s.resolvePermission('t1', 'allow', false);
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

  test('resolvePermission(allow)：无 setMode 且非 alwaysThisSession → 不改档、不 emit permission_mode、updatedPermissions 为空', async () => {
    const { s, events } = makeSession({ permissionMode: 'default' });
    const ac = new AbortController();
    const promise = s.askPermission('Bash', { command: 'ls' }, {
      signal: ac.signal, toolUseID: 't1',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }]
    });
    s.resolvePermission('t1', 'allow', false);
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
    s.resolvePermission('t1', 'allow', true);
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
    X.s.resolvePermission('reqX', 'allow');
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
    Y.s.resolvePermission('dup', 'allow');
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
