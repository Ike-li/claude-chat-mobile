// test/interaction.test.mjs —— interaction-log.js 纯逻辑单测
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ilog from '../interaction-log.js';

test.describe('interaction-log', () => {
  test('enabled 默认 false（环境变量未设）', () => {
    assert.equal(ilog.enabled, false);
  });

  test('getSessionLogs：null sessionId → []', () => {
    assert.deepEqual(ilog.getSessionLogs(null), []);
    assert.deepEqual(ilog.getSessionLogs(undefined), []);
    assert.deepEqual(ilog.getSessionLogs(''), []);
  });

  test('getSessionLogs：不存在的 sessionId → []', () => {
    assert.deepEqual(ilog.getSessionLogs('nonexistent'), []);
  });

  test('addSessionLog + getSessionLogs：正常读写', () => {
    ilog.addSessionLog('s1', 'user_in', 'hello');
    const logs = ilog.getSessionLogs('s1');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].type, 'user_in');
    assert.equal(logs[0].text, 'hello');
    assert.ok(typeof logs[0].ts === 'number');
  });

  test('addSessionLog：多条追加 + 不同 session 隔离', () => {
    ilog.addSessionLog('s1', 'a', '1');
    ilog.addSessionLog('s1', 'b', '2');
    ilog.addSessionLog('s2', 'x', '3');
    assert.equal(ilog.getSessionLogs('s1').length, 3); // 2 new + 1 from previous test
    assert.equal(ilog.getSessionLogs('s2').length, 1);
  });

  test('addSessionLog：null sessionId → 不写入', () => {
    ilog.addSessionLog(null, 'x', 'y');
    assert.deepEqual(ilog.getSessionLogs(null), []);
  });

  test('addSessionLog：环形缓冲上限 100 条', () => {
    for (let i = 0; i < 150; i++) ilog.addSessionLog('buf-test', 'x', String(i));
    const logs = ilog.getSessionLogs('buf-test');
    assert.ok(logs.length <= 100);
    // 最旧的被挤出，保留最近 100 条
    assert.equal(logs[0].text, '50');  // 0-49 被挤出
    assert.equal(logs[99].text, '149');
  });

  test('setCallback：log 触发回调', () => {
    let called = null;
    ilog.setCallback((sid, entry) => { called = { sid, type: entry.type, text: entry.text }; });
    ilog.addSessionLog('cb-test', 'user_out', 'callback test');
    assert.ok(called);
    assert.equal(called.sid, 'cb-test');
    assert.equal(called.type, 'user_out');
    assert.equal(called.text, 'callback test');
    // 恢复
    ilog.setCallback(null);
  });

  test('userMessageIn → addSessionLog("user_in")', () => {
    ilog.userMessageIn('j1', 'inbound text');
    const logs = ilog.getSessionLogs('j1');
    const entry = logs.find(l => l.type === 'user_in');
    assert.ok(entry);
    assert.ok(entry.text.includes('inbound text'));
  });

  test('userMessageOut → addSessionLog("user_out")', () => {
    ilog.userMessageOut('j2', 'outbound text');
    const logs = ilog.getSessionLogs('j2');
    const entry = logs.find(l => l.type === 'user_out');
    assert.ok(entry);
    assert.ok(entry.text.includes('outbound text'));
  });

  test('agentSend → addSessionLog("agent_send")：model 走独立字段、text 不再含 model 前缀', () => {
    ilog.agentSend('j3', 'prompt text', 'opus');
    const logs = ilog.getSessionLogs('j3');
    const entry = logs.find(l => l.type === 'agent_send');
    assert.ok(entry);
    assert.equal(entry.model, 'opus');
    assert.ok(entry.text.includes('prompt text'));
    assert.ok(!entry.text.includes('model='));  // 前缀已移到独立 badge 字段
  });

  test('agentSend：model 缺省 → 字段兜底 default', () => {
    ilog.agentSend('j3b', 'text', null);
    const logs = ilog.getSessionLogs('j3b');
    const entry = logs.find(l => l.type === 'agent_send');
    assert.equal(entry.model, 'default');
  });

  test('agentResult → addSessionLog("agent_result")', () => {
    ilog.agentResult('j4', 'result text');
    const logs = ilog.getSessionLogs('j4');
    const entry = logs.find(l => l.type === 'agent_result');
    assert.ok(entry);
    assert.ok(entry.text.includes('result text'));
  });

  test('fmt：空/空白 → "(empty)"', () => {
    // 通过 userMessageIn 间接测试 fmt
    ilog.userMessageIn('fmt1', '');
    const logs = ilog.getSessionLogs('fmt1');
    const entry = logs.find(l => l.type === 'user_in');
    assert.equal(entry.text, '(empty)');
  });

  test('fmt：长文本截断 1500 字符', () => {
    const long = 'x'.repeat(2000);
    ilog.userMessageIn('fmt2', long);
    const logs = ilog.getSessionLogs('fmt2');
    const entry = logs.find(l => l.type === 'user_in');
    assert.ok(entry.text.length <= 1550); // 1500 + 截断后缀
    assert.ok(entry.text.includes('…'));
  });

  test('fmt：换行符替换为 \\\\n', () => {
    ilog.userMessageIn('fmt3', 'line1\nline2');
    const logs = ilog.getSessionLogs('fmt3');
    const entry = logs.find(l => l.type === 'user_in');
    assert.ok(entry.text.includes('\\n'));
    assert.ok(!entry.text.includes('\n'));
  });

  test('fmt：sanitize 脱敏', () => {
    // API key 应在日志中脱敏（sk-ant-* → ***，完全替换）
    ilog.userMessageIn('fmt4', 'key: sk-ant-test1234567890abcdef');
    const logs = ilog.getSessionLogs('fmt4');
    const entry = logs.find(l => l.type === 'user_in');
    // sk-ant-* 被 sanitize 完全替换为 ***
    assert.ok(!entry.text.includes('sk-ant-test'));
    assert.ok(!entry.text.includes('test1234567890abcdef'));
  });

  test('textDelta：不启用时不记日志', () => {
    ilog.textDelta('td1', 'some delta');
    // textDelta 仅在 enabled 时 console.log，总是 no-op for session buffers
    const logs = ilog.getSessionLogs('td1');
    assert.deepEqual(logs, []);
  });

  // ---- 模型 ID 独立字段（Web 交互日志 chip badge 数据源）----
  test('addSessionLog：model 参数 → entry.model（非空才带字段）', () => {
    ilog.addSessionLog('m1', 'user_in', 'hi', 'claude-opus-4-8');
    ilog.addSessionLog('m1', 'user_in', 'no-model');
    const logs = ilog.getSessionLogs('m1');
    assert.equal(logs[0].model, 'claude-opus-4-8');
    assert.equal(logs[1].model, undefined);  // 无 model → 不带字段，前端据此不渲染 chip
  });

  test('userMessageIn / userMessageOut：透传 model 到字段', () => {
    ilog.userMessageIn('m2', 'in', 'claude-sonnet-4-6');
    ilog.userMessageOut('m2', 'out', 'claude-sonnet-4-6');
    const logs = ilog.getSessionLogs('m2');
    assert.equal(logs.find(l => l.type === 'user_in').model, 'claude-sonnet-4-6');
    assert.equal(logs.find(l => l.type === 'user_out').model, 'claude-sonnet-4-6');
  });

  test('agentResult：透传 model 到字段', () => {
    ilog.agentResult('m3', 'result text', 'claude-opus-4-8');
    const entry = ilog.getSessionLogs('m3').find(l => l.type === 'agent_result');
    assert.equal(entry.model, 'claude-opus-4-8');
    assert.ok(entry.text.includes('result text'));
  });

  // ---- effort / permissionMode 独立 chip 字段（显示「那一刻」的档位）----
  test('addSessionLog：对象 meta → model/effort/permissionMode 各入独立字段', () => {
    ilog.addSessionLog('meta1', 'agent_send', 'txt', { model: 'claude-opus-4-8', effort: 'high', permissionMode: 'plan' });
    const e = ilog.getSessionLogs('meta1')[0];
    assert.equal(e.model, 'claude-opus-4-8');
    assert.equal(e.effort, 'high');
    assert.equal(e.permissionMode, 'plan');
  });

  test('addSessionLog：字符串 meta 仍兼容（旧调用只带 model）', () => {
    ilog.addSessionLog('meta2', 'user_in', 'txt', 'claude-sonnet-4-6');
    const e = ilog.getSessionLogs('meta2')[0];
    assert.equal(e.model, 'claude-sonnet-4-6');
    assert.equal(e.effort, undefined);
    assert.equal(e.permissionMode, undefined);
  });

  test('agentSend：effort/permissionMode 透传到独立字段', () => {
    ilog.agentSend('meta3', 'prompt', 'claude-opus-4-8', 'medium', 'acceptEdits');
    const e = ilog.getSessionLogs('meta3').find(l => l.type === 'agent_send');
    assert.equal(e.model, 'claude-opus-4-8');
    assert.equal(e.effort, 'medium');
    assert.equal(e.permissionMode, 'acceptEdits');
    assert.ok(!e.text.includes('effort='));  // 不再内联进 text
  });

  // 防 sessionBuffers 无界增长：常驻 server 长跑下，历史会话的日志缓冲会按 sessionId 无限累积
  // （每会话上限 100 条、但会话数无上限）。须给会话数也设 FIFO 上限（与 history/sessions 缓存同精神）。
  // 放最后：本用例创建大量 session 触发淘汰，会清掉前面用例的缓冲，故须在它们跑完后执行。
  test('addSessionLog：会话数超上限 → 最旧会话缓冲被 FIFO 淘汰（防 sessionBuffers 无界泄漏）', () => {
    for (let i = 0; i < 400; i++) ilog.addSessionLog(`lk-${i}`, 'x', 'd'); // 远超会话数上限(200)
    assert.deepEqual(ilog.getSessionLogs('lk-0'), [], '最旧会话缓冲应被淘汰');
    assert.equal(ilog.getSessionLogs('lk-399').length, 1, '最新会话缓冲应保留');
  });
});
