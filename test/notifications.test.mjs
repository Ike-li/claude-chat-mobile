// test/notifications.test.mjs —— notificationForEvent 纯映射单测（零副作用，不碰 web-push 传输）
import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationForEvent, ntfyMetaFor, ntfyRequestInit } from '../notifications.js';

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

// ── ②2c：notificationForEvent 带 instanceId 时附 data（供 push/ntfy 深链回会话）───────
test('带 instanceId → 返回附 data{instanceId,sessionId,cwd}', () => {
  const n = notificationForEvent('permission_request', { name: 'Bash' },
    { hasClients: true, instanceId: 'inst_2', sessionId: 'sess_9', cwd: '/repo' });
  assert.deepEqual(n.data, { instanceId: 'inst_2', sessionId: 'sess_9', cwd: '/repo' });
});

test('不带 instanceId → 无 data 字段（向后兼容，现有 deepEqual 不破）', () => {
  const n = notificationForEvent('question', { text: 'x' }, { hasClients: true });
  assert.equal('data' in n, false);
});

test('result 无客户端 + instanceId → 附 data', () => {
  const n = notificationForEvent('result', { durationMs: 1000 }, { hasClients: false, instanceId: 'inst_1' });
  assert.equal(n.data.instanceId, 'inst_1');
});

// ── ②2b：ntfyMetaFor（渠道元数据：优先级 / 标签 / 深链 click）──────────────────────
test('ntfyMetaFor: permission_request → 高优先级 5 + warning 标签', () => {
  const m = ntfyMetaFor('permission_request', {}, '');
  assert.equal(m.priority, 5);
  assert.deepEqual(m.tags, ['warning']);
});

test('ntfyMetaFor: result → 默认优先级 3', () => {
  assert.equal(ntfyMetaFor('result', {}, '').priority, 3);
});

test('ntfyMetaFor: 有 publicUrl + instanceId → click 深链含 instance/session/cwd（URL 编码）', () => {
  const m = ntfyMetaFor('permission_request', { instanceId: 'i1', sessionId: 's1', cwd: '/r' }, 'https://x.example.com');
  assert.match(m.click, /^https:\/\/x\.example\.com\/#/);
  assert.match(m.click, /instance=i1/);
  assert.match(m.click, /session=s1/);
  assert.match(m.click, /cwd=%2Fr/);
});

test('ntfyMetaFor: 无 publicUrl 或无 instanceId → 无 click', () => {
  assert.equal(ntfyMetaFor('result', { instanceId: 'i1' }, '').click, undefined);
  assert.equal(ntfyMetaFor('result', {}, 'https://x.example.com').click, undefined);
});

test('ntfyMetaFor: publicUrl 尾斜杠不产生双斜杠', () => {
  assert.match(ntfyMetaFor('question', { instanceId: 'i1' }, 'https://x.example.com/').click, /^https:\/\/x\.example\.com\/#/);
});

// ── ②2b：ntfyRequestInit（构造 fetch 参数，纯函数不发网络；中文走 JSON body 避开 header 编码）──
test('ntfyRequestInit: JSON body 含 topic/title/message，POST', () => {
  const { url, init } = ntfyRequestInit({ url: 'https://ntfy.local', topic: 'ccm' }, '标题', '正文', {});
  assert.equal(url, 'https://ntfy.local');
  assert.equal(init.method, 'POST');
  const b = JSON.parse(init.body);
  assert.equal(b.topic, 'ccm');
  assert.equal(b.title, '标题');
  assert.equal(b.message, '正文');
});

test('ntfyRequestInit: token → Authorization Bearer；无 token → 无该头', () => {
  const withTok = ntfyRequestInit({ url: 'u', topic: 't', token: 'secret' }, 'a', 'b', {});
  assert.equal(withTok.init.headers.Authorization, 'Bearer secret');
  const noTok = ntfyRequestInit({ url: 'u', topic: 't' }, 'a', 'b', {});
  assert.equal('Authorization' in noTok.init.headers, false);
});

test('ntfyRequestInit: meta 的 tags/priority/click 进 body', () => {
  const { init } = ntfyRequestInit({ url: 'u', topic: 't' }, 'a', 'b',
    { tags: ['warning'], priority: 5, click: 'https://x/#instance=i1' });
  const b = JSON.parse(init.body);
  assert.deepEqual(b.tags, ['warning']);
  assert.equal(b.priority, 5);
  assert.equal(b.click, 'https://x/#instance=i1');
});
