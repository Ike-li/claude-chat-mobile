// test/notifications.test.mjs —— notificationForEvent 纯映射单测（零副作用，不碰 web-push 传输）
import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationForEvent } from '../notifications.js';

// ── result：仅在无客户端连接时推 ──────────────────────────────────────────────

test('result + 无客户端 → 推「任务完成」含耗时', () => {
  const n = notificationForEvent('result', { durationMs: 3210, isError: false }, { hasClients: false });
  assert.deepEqual(n, { title: '✅ 任务完成', body: '用时 3.2s' });
});

test('result + isError + 无客户端 → 推「任务出错」', () => {
  const n = notificationForEvent('result', { durationMs: 0, isError: true }, { hasClients: false });
  assert.equal(n.title, '⚠️ 任务出错');
});

test('result + 有客户端连接 → 不推（客户端自己看得到）', () => {
  assert.equal(notificationForEvent('result', { durationMs: 3210 }, { hasClients: true }), null);
});

// ── permission_request / question：无条件推 ──────────────────────────────────

test('permission_request → 无条件推，body 含工具名', () => {
  const n = notificationForEvent('permission_request', { name: 'Bash', input: { command: 'ls' } }, { hasClients: true });
  assert.equal(n.title, '⚠️ Claude 请求许可');
  assert.match(n.body, /^Bash：/);
});

test('question → 无条件推，空文本回退兜底文案', () => {
  assert.equal(notificationForEvent('question', { text: '选哪个?' }, { hasClients: true }).body, '选哪个?');
  assert.equal(notificationForEvent('question', { text: '' }, { hasClients: false }).body, 'Claude 需要你的回答');
});

// ── task_notification：后台任务（Workflow/后台 Agent/Bash）完成，本次新补的推送 ──────

test('task_notification 成功 → 推「后台任务完成」，无条件（有客户端也推）', () => {
  const n = notificationForEvent('task_notification', { status: 'completed', summary: '生成了 3 个测试' }, { hasClients: true });
  assert.deepEqual(n, { title: '✅ 后台任务完成', body: '生成了 3 个测试' });
});

test('task_notification 失败（status=failed/error）→ 推「后台任务失败」', () => {
  assert.equal(notificationForEvent('task_notification', { status: 'failed' }, {}).title, '⚠️ 后台任务失败');
  assert.equal(notificationForEvent('task_notification', { status: 'error' }, {}).title, '⚠️ 后台任务失败');
});

test('task_notification 无 summary → 兜底文案', () => {
  assert.equal(notificationForEvent('task_notification', { status: 'completed' }, {}).body, 'Claude 即将汇报结果');
});

// ── 其余 STATE_BOUNDARY 事件不推 ─────────────────────────────────────────────

test('init / tool_use / error / request_resolved → 一律不推', () => {
  for (const t of ['init', 'tool_use', 'error', 'request_resolved']) {
    assert.equal(notificationForEvent(t, {}, { hasClients: false }), null, `${t} 不该推`);
  }
});

test('缺省 payload/opts 不抛', () => {
  assert.equal(notificationForEvent('init'), null);
  assert.doesNotThrow(() => notificationForEvent('task_notification'));
});
