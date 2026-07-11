// test/notifications.test.mjs —— notificationForEvent 纯映射单测（零副作用，不碰 web-push 传输）
import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationForEvent, ntfyMetaFor, ntfyRequestInit, throttleNotify, clearNotifyPending, NOTIFY_CATEGORY } from '../notifications.js';

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

test('permission_request → 无条件推，body 含工具名但【不含命令/参数正文】（SEC-04 最小化）', () => {
  const n = notificationForEvent('permission_request', { name: 'Bash', input: { command: 'rm -rf /tmp/x' } }, { hasClients: true });
  assert.equal(n.title, '⚠️ Claude 请求许可');
  assert.match(n.body, /Bash/, 'body 保留工具名（辨识度，泄露面小）');
  assert.ok(!n.body.includes('rm'), 'body 不得含命令正文');
  assert.ok(!n.body.includes('command'), 'body 不得含 input JSON');
});

test('question → 无条件推，body 【不含问题正文】（最小化，正文回 app 内经鉴权取）', () => {
  const n = notificationForEvent('question', { text: '要删除生产库吗?' }, { hasClients: true });
  assert.ok(!n.body.includes('生产库'), 'body 不得含问题正文');
  assert.equal(n.body, 'Claude 需要你的回答');
});

// ── task_notification：后台任务（Workflow/后台 Agent/Bash）完成 ──────

test('task_notification 成功 → 「后台任务完成」，body 【不含 summary 正文】', () => {
  const n = notificationForEvent('task_notification', { status: 'completed', summary: '改了 auth.js 的鉴权分支' }, { hasClients: true });
  assert.equal(n.title, '✅ 后台任务完成');
  assert.ok(!n.body.includes('auth.js'), 'body 不得含 summary 正文');
});

test('task_notification 失败（status=failed/error）→ 「后台任务失败」', () => {
  assert.equal(notificationForEvent('task_notification', { status: 'failed' }, {}).title, '⚠️ 后台任务失败');
  assert.equal(notificationForEvent('task_notification', { status: 'error' }, {}).title, '⚠️ 后台任务失败');
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

test('ntfyMetaFor: click 深链含 instance/session，但【不含完整 cwd】（ntfy 明文第三方，SEC-04）', () => {
  const m = ntfyMetaFor('permission_request', { instanceId: 'i1', sessionId: 's1', cwd: '/Users/me/secret-proj' }, 'https://x.example.com');
  assert.match(m.click, /^https:\/\/x\.example\.com\/#/);
  assert.match(m.click, /instance=i1/);
  assert.match(m.click, /session=s1/);
  assert.ok(!/cwd=/.test(m.click), 'ntfy click 深链不得含完整 cwd 路径');
  assert.ok(!m.click.includes('secret'), '不得经第三方明文泄露工作目录路径');
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

// ── throttleNotify / clearNotifyPending：per-会话推送节流（LLD §3.6.1 TriggerPolicy，承接 FR-14 另一半）──
// 两层规则：①同一会话同一类别已有未决通知（未被 request_resolved 清除）不重复推；
// ②即便已清除，同类事件最小间隔内仍抑制。纯函数、状态外置（EP-2）。
test.describe('throttleNotify', () => {
  test('首次推送：不节流，记为该类别未决', () => {
    const r = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    assert.equal(r.throttled, false);
  });

  test('同会话同类别已有未决通知（如上一个 approval 还没被处理）→ 第二次节流', () => {
    const r1 = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    const r2 = throttleNotify('s1', 'approval', 2000, r1.next, 60000); // 未 clearNotifyPending，仍未决
    assert.equal(r2.throttled, true, '未决时第二次同类别通知应被节流');
  });

  test('未决被清除（request_resolved）后、仍在最小间隔内 → 仍节流（间隔层兜底）', () => {
    const r1 = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    const cleared = clearNotifyPending('s1', 'approval', r1.next);
    const r2 = throttleNotify('s1', 'approval', 30000, cleared, 60000); // 30s < 60s 最小间隔
    assert.equal(r2.throttled, true, '已清未决但未过最小间隔仍应节流');
  });

  test('未决被清除且已过最小间隔 → 放行', () => {
    const r1 = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    const cleared = clearNotifyPending('s1', 'approval', r1.next);
    const r2 = throttleNotify('s1', 'approval', 62000, cleared, 60000); // 61s > 60s
    assert.equal(r2.throttled, false);
  });

  test('不同会话互不影响', () => {
    const r1 = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    const r2 = throttleNotify('s2', 'approval', 1001, r1.next, 60000);
    assert.equal(r2.throttled, false, '不同会话的节流态应独立');
  });

  test('不同类别（approval vs finished）互不影响', () => {
    const r1 = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    const r2 = throttleNotify('s1', 'finished', 1001, r1.next, 60000);
    assert.equal(r2.throttled, false, '同会话不同类别应独立节流');
  });

  test('finished 类别（result/task_notification）无"未决"语义，只受最小间隔节流', () => {
    const r1 = throttleNotify('s1', 'finished', 1000, new Map(), 60000);
    const r2 = throttleNotify('s1', 'finished', 2000, r1.next, 60000); // 未调用 clearNotifyPending
    assert.equal(r2.throttled, true, 'finished 类别短时间内连续两次也应节流（无需 clear 才能受最小间隔约束）');
    const r3 = throttleNotify('s1', 'finished', 62000, r1.next, 60000);
    assert.equal(r3.throttled, false, '过了最小间隔应放行');
  });

  test('未知/空 sessionId → 不节流（保守，不误伤）', () => {
    assert.equal(throttleNotify(null, 'approval', 1000, new Map()).throttled, false);
    assert.equal(throttleNotify('', 'approval', 1000, new Map()).throttled, false);
  });

  test('NOTIFY_CATEGORY 映射：permission_request→approval, question→input, result/task_notification→finished', () => {
    assert.equal(NOTIFY_CATEGORY.permission_request, 'approval');
    assert.equal(NOTIFY_CATEGORY.question, 'input');
    assert.equal(NOTIFY_CATEGORY.result, 'finished');
    assert.equal(NOTIFY_CATEGORY.task_notification, 'finished');
  });
});

test.describe('clearNotifyPending', () => {
  test('清除不存在的会话/类别 → 原样返回，不抛错', () => {
    const state = new Map();
    const next = clearNotifyPending('nope', 'approval', state);
    assert.equal(next, state);
  });

  test('清除后，notifiedAt 不受影响（只清 pending，最小间隔仍生效）', () => {
    const r1 = throttleNotify('s1', 'approval', 1000, new Map(), 60000);
    const cleared = clearNotifyPending('s1', 'approval', r1.next);
    const r2 = throttleNotify('s1', 'approval', 1500, cleared, 60000); // 500ms < 60s
    assert.equal(r2.throttled, true, 'clear 只清未决标记，不重置最小间隔计时');
  });
});
