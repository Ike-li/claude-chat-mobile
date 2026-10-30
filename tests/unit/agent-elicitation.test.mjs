// tests/unit/agent-elicitation.test.mjs —— MCP elicitation（#460）在 agent 层的生命周期
// 不传 onElicitation 时 SDK 一律自动 decline：MCP 服务器要个确认、要个 key、要用户去浏览器授权，手机上都被静默拒绝。
// 这里钉住：回调接上了；卡片事件发得出去；作答按 schema 校验（非法的拒收、卡片不关）；拒绝 / 取消 / abort / TTL /
// dispose / 中断 / 进程退出都结算成一个确定的结果并广播 request_resolved（多设备关卡）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentQueryOptions } from '../../app/src/agent/agent.js';
import { makeSession, awaitTtlSettled } from '../helpers/agent-unit.mjs';

const FORM = {
  serverName: 'notes', message: '新笔记叫什么', mode: 'form',
  requestedSchema: { type: 'object', properties: { name: { type: 'string', minLength: 2 }, pin: { type: 'boolean' } }, required: ['name'] },
};
const URL_REQ = { serverName: 'gh', message: '去授权', mode: 'url', url: 'https://github.com/login/oauth?x=1', elicitationId: 'el-1' };

const elicitEvents = events => events.filter(e => e.type === 'elicitation');
const resolvedOf = (events, requestId) => events.filter(e => e.type === 'request_resolved' && e.payload.requestId === requestId);

test('buildAgentQueryOptions 接上了 onElicitation：SDK 调它就出卡片事件（不接 SDK 会自动 decline）', () => {
  const { s, events, dispose } = makeSession();
  try {
    const opts = buildAgentQueryOptions(s, { ...process.env });
    assert.equal(typeof opts.onElicitation, 'function');
    const ac = new AbortController();
    opts.onElicitation(FORM, { signal: ac.signal, requestId: 'req-built' });
    const [ev] = elicitEvents(events);
    assert.equal(ev?.payload.requestId, 'req-built');
    assert.equal(ev.payload.serverName, 'notes');
  } finally { dispose(); }
});

test('表单：卡片事件带字段描述与 TTL；合法作答 → accept + 校验后的 content，广播 request_resolved', async () => {
  const { s, events, dispose } = makeSession({ approvalTtlMs: 60_000 });
  try {
    const p = s.handleElicitation(FORM, { signal: new AbortController().signal, requestId: 'r1' });
    const [ev] = elicitEvents(events);
    assert.equal(ev.payload.mode, 'form');
    assert.deepEqual(ev.payload.fields.map(f => f.name), ['name', 'pin']);
    assert.ok(ev.payload.expiresAt - ev.payload.createdAt === 60_000);
    assert.equal(s.isBusy(), true, '等用户作答时实例不可被置换');

    assert.deepEqual(s.resolveElicitation('r1', 'accept', { name: '周报', pin: true }), { ok: true });
    assert.deepEqual(await p, { action: 'accept', content: { name: '周报', pin: true } });
    assert.equal(resolvedOf(events, 'r1').length, 1);
    assert.equal(resolvedOf(events, 'r1')[0].payload.kind, 'elicitation');
    assert.equal(s.pendingElicitations.size, 0);
    assert.equal(s.resolveElicitation('r1', 'decline').ok, false, '结算过的不能再答');
  } finally { dispose(); }
});

test('表单：非法作答拒收并说明原因，卡片不关（还在 pending、没有 request_resolved），改对了能再交', async () => {
  const { s, events, dispose } = makeSession();
  try {
    const p = s.handleElicitation(FORM, { signal: new AbortController().signal, requestId: 'r2' });
    for (const bad of [{}, { name: 'x' }, { name: '好名字', extra: 1 }, null]) {
      const r = s.resolveElicitation('r2', 'accept', bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(typeof r.error, 'string');
    }
    assert.equal(s.pendingElicitations.size, 1);
    assert.equal(resolvedOf(events, 'r2').length, 0);
    assert.deepEqual(s.resolveElicitation('r2', 'accept', { name: '好名字' }), { ok: true });
    assert.deepEqual(await p, { action: 'accept', content: { name: '好名字' } });
  } finally { dispose(); }
});

test('拒绝 / 取消照原样回给 SDK；不认的 action 拒收', async () => {
  const { s, dispose } = makeSession();
  try {
    const p1 = s.handleElicitation(FORM, { signal: new AbortController().signal, requestId: 'd1' });
    const p2 = s.handleElicitation(FORM, { signal: new AbortController().signal, requestId: 'c1' });
    assert.equal(s.resolveElicitation('d1', 'approve').ok, false);
    assert.deepEqual(s.resolveElicitation('d1', 'decline'), { ok: true });
    assert.deepEqual(s.resolveElicitation('c1', 'cancel'), { ok: true });
    assert.deepEqual(await p1, { action: 'decline' });
    assert.deepEqual(await p2, { action: 'cancel' });
  } finally { dispose(); }
});

test('schema 超出子集：不能 accept（不替用户瞎填），只能拒绝 / 取消', async () => {
  const { s, events, dispose } = makeSession();
  try {
    const req = { ...FORM, requestedSchema: { type: 'object', properties: { tags: { type: 'array' } } } };
    const p = s.handleElicitation(req, { signal: new AbortController().signal, requestId: 'u1' });
    assert.equal(elicitEvents(events)[0].payload.unsupported, true);
    assert.equal(s.resolveElicitation('u1', 'accept', {}).ok, false);
    assert.deepEqual(s.resolveElicitation('u1', 'decline'), { ok: true });
    assert.deepEqual(await p, { action: 'decline' });
  } finally { dispose(); }
});

test('URL 模式：卡片带 url / origin / elicitationId；accept 不带 content', async () => {
  const { s, events, dispose } = makeSession();
  try {
    const p = s.handleElicitation(URL_REQ, { signal: new AbortController().signal, requestId: 'url1' });
    const [ev] = elicitEvents(events);
    assert.equal(ev.payload.urlOrigin, 'https://github.com');
    assert.equal(ev.payload.elicitationId, 'el-1');
    assert.deepEqual(s.resolveElicitation('url1', 'accept', { ignored: true }), { ok: true });
    assert.deepEqual(await p, { action: 'accept' });
  } finally { dispose(); }
});

test('abort 信号 → cancel，广播 aborted；已经 abort 的信号不出卡', async () => {
  const { s, events, dispose } = makeSession();
  try {
    const ac = new AbortController();
    const p = s.handleElicitation(FORM, { signal: ac.signal, requestId: 'a1' });
    ac.abort();
    assert.deepEqual(await p, { action: 'cancel' });
    assert.equal(resolvedOf(events, 'a1')[0].payload.outcome, 'aborted');
    assert.equal(s.pendingElicitations.size, 0);

    const pre = new AbortController();
    pre.abort();
    assert.deepEqual(await s.handleElicitation(FORM, { signal: pre.signal, requestId: 'a2' }), { action: 'cancel' });
    assert.equal(elicitEvents(events).filter(e => e.payload.requestId === 'a2').length, 0);
  } finally { dispose(); }
});

test('TTL 到期 → cancel，广播 expired（不让 canUseTool 那样永久悬置、实例永不回收）', async () => {
  const { s, events, dispose } = makeSession({ approvalTtlMs: 30 });
  try {
    const p = s.handleElicitation(FORM, { signal: new AbortController().signal, requestId: 't1' });
    // 到期 timer 是 unref 的：直接 await，Node 20 上事件循环会先收尾，本条连同后面几条报 cancelledByParent（见 helper 注释）
    assert.deepEqual(await awaitTtlSettled(p), { action: 'cancel' });
    assert.equal(resolvedOf(events, 't1')[0].payload.outcome, 'expired');
    assert.equal(s.pendingElicitations.size, 0);
  } finally { dispose(); }
});

test('dispose / 中断 / CLI 进程退出：挂着的都结算成 cancel 并广播', async () => {
  {
    const { s, events } = makeSession();
    const p = s.handleElicitation(FORM, { signal: new AbortController().signal, requestId: 'x-dispose' });
    s.dispose();
    assert.deepEqual(await p, { action: 'cancel' });
    assert.equal(resolvedOf(events, 'x-dispose').length, 1);
  }
  {
    const { s, events, dispose } = makeSession();
    const p = s.handleElicitation(FORM, { signal: new AbortController().signal, requestId: 'x-interrupt' });
    s.q = { interrupt() { return Promise.resolve(); } };
    await s.interrupt();
    assert.deepEqual(await p, { action: 'cancel' });
    assert.equal(resolvedOf(events, 'x-interrupt').length, 1);
    dispose();
  }
  {
    const { s, events, dispose } = makeSession();
    const p = s.handleElicitation(FORM, { signal: new AbortController().signal, requestId: 'x-exit' });
    await s.consume({ [Symbol.asyncIterator]() { return { next: () => Promise.resolve({ done: true }) }; } });
    assert.deepEqual(await p, { action: 'cancel' });
    assert.equal(resolvedOf(events, 'x-exit').length, 1);
    dispose();
  }
});

test('重连快照带上仍待作答的卡；sync:since 回放滤掉已结算的卡片事件', async () => {
  const { s, dispose } = makeSession();
  try {
    s.handleElicitation(FORM, { signal: new AbortController().signal, requestId: 's1' });
    s.handleElicitation(URL_REQ, { signal: new AbortController().signal, requestId: 's2' });
    s.resolveElicitation('s1', 'decline');
    const snap = s.pendingRequestsSnapshot();
    assert.deepEqual(snap.elicitations.map(e => e.requestId), ['s2']);
    assert.equal(snap.elicitations[0].urlOrigin, 'https://github.com');
    assert.ok(snap.elicitations[0].expiresAt > 0);
    const replayed = s.eventsSince(0).events.filter(e => e.type === 'elicitation').map(e => e.payload.requestId);
    assert.deepEqual(replayed, ['s2']);
  } finally { dispose(); }
});

test('system/elicitation_complete（URL 授权完成）→ system 事件，带 elicitationId 供前端关「等待完成」', () => {
  const { s, events, dispose } = makeSession();
  try {
    s.map({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'gh', elicitation_id: 'el-1', uuid: 'u', session_id: 'sid' });
    const ev = events.find(e => e.type === 'system' && e.payload.kind === 'elicitation_complete');
    assert.ok(ev, '没映射成 system 事件');
    assert.equal(ev.payload.elicitationId, 'el-1');
    assert.equal(ev.payload.serverName, 'gh');
    assert.equal(typeof ev.payload.message, 'string');
  } finally { dispose(); }
});
