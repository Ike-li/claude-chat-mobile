import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, sdkChildEnv } from '../../src/agent/agent.js';
import { getSessionLogs } from '../../src/agent/interaction-log.js';
import { makeSession } from '../helpers/agent-unit.mjs';

test.describe('map() — 子 agent 消息分流（forwardSubagentText：parentToolUseId 标记，不再丢弃）', () => {
  // probe#6 实证（forwardSubagentText:true）：子 agent 消息经主 query 流实时投递、带 parent_tool_use_id；
  // assistant 消息另带 subagent_type。旧代码 3 处 `if(parent_tool_use_id) break` 整条丢弃 → 移动端看不到子 agent。
  // 改为分流 emit（带 parentToolUseId），但【不碰主 agent 状态/buffer】、【不把子 agent 错误当主会话错误】。
  test('子 agent stream_event text_delta → emit text_delta 带 parentToolUseId（不再丢弃）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'stream_event', parent_tool_use_id: 'agent-1', uuid: 'sa-1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '子agent正文' } } });
    const ev = events.find(e => e.type === 'text_delta' && e.payload?.parentToolUseId === 'agent-1');
    assert.ok(ev, '子 agent 文本应 emit 带 parentToolUseId');
    assert.equal(ev.payload.text, '子agent正文');
    s.dispose();
  });
  test('子 agent 文本不污染主 agent 文本缓冲', () => {
    const { s } = makeSession();
    s.map({ type: 'stream_event', parent_tool_use_id: 'agent-1', uuid: 'sa-1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '子agent正文' } } });
    assert.equal(s.assistantResponseBuffer, '', '主 buffer 不应被子 agent 文本污染');
    s.dispose();
  });
  test('子 agent stream_event thinking_delta → emit thinking_delta 带 parentToolUseId', () => {
    const { s, events } = makeSession();
    s.map({ type: 'stream_event', parent_tool_use_id: 'agent-1', uuid: 'sa-1',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '子agent思考' } } });
    const ev = events.find(e => e.type === 'thinking_delta' && e.payload?.parentToolUseId === 'agent-1');
    assert.ok(ev, '子 agent thinking 应 emit 带 parentToolUseId');
    s.dispose();
  });
  test('子 agent assistant tool_use → emit tool_use 带 parentToolUseId + subagentType', () => {
    const { s, events } = makeSession();
    s.map({ type: 'assistant', parent_tool_use_id: 'agent-1', subagent_type: 'general-purpose', uuid: 'sa-2',
      message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/x' } }] } });
    const ev = events.find(e => e.type === 'tool_use' && e.payload?.parentToolUseId === 'agent-1');
    assert.ok(ev, '子 agent tool_use 应 emit 带 parentToolUseId');
    assert.equal(ev.payload.subagentType, 'general-purpose');
    assert.equal(ev.payload.name, 'Read');
    s.dispose();
  });
  test('回归保留：子 agent assistant 的 API 错误【不】上报为主会话 error（code-review P0 守卫）', () => {
    const { s, events } = makeSession();
    s.map({ type: 'assistant', parent_tool_use_id: 'agent-1', error: 'rate_limit', uuid: 'sa-3',
      message: { content: [{ type: 'text', text: 'API Error: rate limited' }] } });
    const errEv = events.find(e => e.type === 'error');
    assert.ok(!errEv, '子 agent 的错误不得当主会话 error 冒泡');
    s.dispose();
  });

  // ---- 切片 1a：子 agent 的 tool_result 分流（user 分支，在主 <task-notification> 注入判断之前）----
  test('子 agent user tool_result → 分流 emit 带 parentToolUseId + subagentType（不带 denyKind）', () => {
    const { s, events } = makeSession();
    // 子 agent 先发 assistant（带 subagent_type + tool_use）——记住类型 + 发工具卡
    s.map({ type: 'assistant', parent_tool_use_id: 'agent-1', subagent_type: 'general-purpose', uuid: 'sa-a',
      message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/x' } }] } });
    // 子 agent 的工具结果回合（user 角色，不带 subagent_type）
    s.map({ type: 'user', parent_tool_use_id: 'agent-1', uuid: 'sa-b',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: false, content: '文件内容' }] } });
    const tr = events.find(e => e.type === 'tool_result' && e.payload?.parentToolUseId === 'agent-1');
    assert.ok(tr, '子 agent tool_result 应分流 emit 带 parentToolUseId');
    assert.equal(tr.payload.toolUseId, 'tu-1');
    assert.equal(tr.payload.ok, true);
    assert.ok(tr.payload.outputSummary.includes('文件内容'));
    assert.equal(tr.payload.subagentType, 'general-purpose', '从 subagentTypeByParent 补 subagentType');
    assert.ok(!('denyKind' in tr.payload), '子 agent tool_result 不带 denyKind（那是主会话审批语义）');
    s.dispose();
  });

  test('子 agent user tool_result raw 走 tool_use_result ?? content（长 base64 被脱敏）', () => {
    const { s, events } = makeSession();
    const bigBase64 = 'C'.repeat(50000);
    s.map({ type: 'user', parent_tool_use_id: 'agent-img', uuid: 'sa-img',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-img', is_error: false,
        content: [{ type: 'image', file: { base64: bigBase64 } }] }] } });
    const tr = events.find(e => e.type === 'tool_result' && e.payload?.parentToolUseId === 'agent-img');
    assert.ok(tr);
    assert.ok(!tr.payload.outputSummary.includes(bigBase64.slice(0, 300)), '子 agent tool_result 的长 base64 也脱敏');
    assert.match(tr.payload.outputSummary, /已省略/);
    s.dispose();
  });

  test('子 agent tool_result is_error=true → ok:false，且不当主会话 error 冒泡', () => {
    const { s, events } = makeSession();
    s.map({ type: 'user', parent_tool_use_id: 'agent-9', uuid: 'sa-e',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-9', is_error: true, content: 'boom' }] } });
    const tr = events.find(e => e.type === 'tool_result' && e.payload?.parentToolUseId === 'agent-9');
    assert.ok(tr);
    assert.equal(tr.payload.ok, false);
    assert.equal(tr.payload.subagentType, null, '未见过该 parent 的 assistant → subagentType 为 null（前端后续补）');
    assert.ok(!events.find(e => e.type === 'error'), '子 agent 工具报错不得当主会话 error 冒泡');
    s.dispose();
  });

  // ---- 切片 1b：subagentTypeByParent 缓存——纯文本子 agent（无 tool_use）的类型标签 ----
  test('纯文本子 agent：assistant 记住 subagent_type → 后续 stream_event delta 补 subagentType', () => {
    const { s, events } = makeSession();
    // 纯文本子 agent 的 assistant 只有 text 块（无 tool_use，当前不 emit），但带 subagent_type
    s.map({ type: 'assistant', parent_tool_use_id: 'agent-2', subagent_type: 'code-reviewer', uuid: 'sa-t',
      message: { content: [{ type: 'text', text: '子agent的完整文本' }] } });
    // 流式 delta 不带 subagent_type
    s.map({ type: 'stream_event', parent_tool_use_id: 'agent-2', uuid: 'sa-t2',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '增量' } } });
    const ev = events.find(e => e.type === 'text_delta' && e.payload?.parentToolUseId === 'agent-2');
    assert.ok(ev, '子 agent text_delta 应 emit');
    assert.equal(ev.payload.subagentType, 'code-reviewer', 'stream_event 从 subagentTypeByParent 补 subagentType');
    // thinking_delta 同样补
    s.map({ type: 'stream_event', parent_tool_use_id: 'agent-2', uuid: 'sa-t3',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '思考' } } });
    const th = events.find(e => e.type === 'thinking_delta' && e.payload?.parentToolUseId === 'agent-2');
    assert.equal(th.payload.subagentType, 'code-reviewer');
    s.dispose();
  });

  test('subagentTypeByParent：非 null 保护——后续不带 subagent_type 的子 agent 消息不抹掉已记标签', () => {
    const { s } = makeSession();
    s.map({ type: 'assistant', parent_tool_use_id: 'agent-3', subagent_type: 'researcher', uuid: 'sa-x',
      message: { content: [] } });
    assert.equal(s.subagentTypeByParent.get('agent-3'), 'researcher');
    // 后续一条不带 subagent_type 的子 agent assistant 不应把标签冲成 null
    s.map({ type: 'assistant', parent_tool_use_id: 'agent-3', uuid: 'sa-x2', message: { content: [] } });
    assert.equal(s.subagentTypeByParent.get('agent-3'), 'researcher', '已记标签不被后续 null 覆盖');
    s.dispose();
  });

  test('dispose 清空 subagentTypeByParent（不跨实例串子 agent 类型标签）', () => {
    const { s } = makeSession();
    s.map({ type: 'assistant', parent_tool_use_id: 'agent-4', subagent_type: 'x', uuid: 'sa',
      message: { content: [] } });
    assert.equal(s.subagentTypeByParent.size, 1);
    s.dispose();
    assert.equal(s.subagentTypeByParent.size, 0);
  });

  test('换会话（init 换 session_id）清空 subagentTypeByParent（旧会话子 agent 类型不串到新会话）', () => {
    const { s } = makeSession({ resumeId: 'old-sid' });
    s.map({ type: 'assistant', parent_tool_use_id: 'agent-5', subagent_type: 'y', uuid: 'sa',
      message: { content: [] } });
    assert.equal(s.subagentTypeByParent.size, 1);
    s.map({ type: 'system', subtype: 'init', session_id: 'new-sid', model: 'opus', cwd: '/w',
      slash_commands: [], mcp_servers: [] });
    assert.equal(s.subagentTypeByParent.size, 0, '换会话清空子 agent 类型缓存');
    s.dispose();
  });
});
