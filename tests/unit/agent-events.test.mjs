import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession } from '../../src/agent/agent.js';
import { makeSession } from '../helpers/agent-unit.mjs';

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
    const { s } = makeSession({ resumeId: 'sid-1', onSessionId() {} });
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

  test('tool_result：超长输出 → truncated:true + getToolOutput 可取全文（展开全文）', () => {
    const { s, events } = makeSession();
    // 必须含空白/标点：纯 base64 字符集会被 redactBase64 整段省略，测不到截断路径
    const long = ('line of tool output with spaces.\n').repeat(40); // >600
    s.map({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tool-long', is_error: false, content: long }
    ] } });
    const tr = events.find(e => e.type === 'tool_result' && e.payload.toolUseId === 'tool-long');
    assert.equal(tr.payload.truncated, true);
    assert.ok(tr.payload.outputSummary.includes('…（已截断）'));
    assert.equal(s.getToolOutput('tool-long'), long);
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

  // 注：原「stream_event / assistant 的 parent_tool_use_id → 整条跳过」两测已删除——
  // 行为从「丢弃子 agent 消息」改为「分流 emit 带 parentToolUseId」（子 agent 可见），
  // 见下方 describe「map() — 子 agent 消息分流」。此处仅保留「error 不误报主会话」「user 仍跳过」两条回归。

  test('assistant 带 error 且 parent_tool_use_id 非空 → 子 agent 内部报错不应误报为主会话 error（code-review P0）', () => {
    const { s, events } = makeSession();
    // 子 agent（Task 工具内部）自己的一次 API 报错（如限流），不是主会话级别的失败。
    s.map({ type: 'assistant', error: 'rate_limit', parent_tool_use_id: 'parent-1',
      message: { content: [{ type: 'text', text: 'API Error: 429 Too Many Requests' }] } });
    assert.equal(events.length, 0, '子 agent 自己的 API 报错不应外露为主会话 error 事件');
    s.dispose();
  });

  test('user 的 parent_tool_use_id 非空、仅 text 块 → 不外露（只分流 tool_result 块，非 text）', () => {
    const { s, events } = makeSession();
    // 子 agent 正文走 stream_event（text_delta）分流；user 角色里的 text 块不重复外露，只有 tool_result 块才分流。
    s.map({ type: 'user', parent_tool_use_id: 'parent-1', message: { content: [
      { type: 'text', text: '子 agent 的 user 回合' },
    ] } });
    assert.equal(events.length, 0, '子 agent user 的 text 块不 emit（tool_result 块才分流，见子 agent 分流 describe）');
    s.dispose();
  });
});

// ---- 后台任务完成通知（Workflow / 后台 Agent / 后台 Bash）----
