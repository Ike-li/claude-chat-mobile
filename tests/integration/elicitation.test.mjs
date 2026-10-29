// tests/integration/elicitation.test.mjs —— MCP elicitation（#460）全链路：假 CLI → 真 SDK → onElicitation → 手机作答
//
// 测什么：
//   ① 假 CLI 发 control_request（subtype:'elicitation'），手机收到带字段描述的 elicitation 事件；
//      重连快照（sync:since 的 pending）里有它；
//   ② 非法作答被服务端拒收、卡片还在；合法作答原样（校验后）回到 CLI——假 CLI 把收到的结果写进助手正文；
//   ③ 拒绝 → CLI 收到 decline；
//   ④ URL 模式：卡片带 origin；accept 后 CLI 发 elicitation_complete，手机收到带 elicitationId 的 system 事件。
// 没接 onElicitation 时 SDK 自己回 {action:'decline'}，①②都会红（两侧验收见 commit）。零 token 成本，只在容器 / CI 跑。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from './_spawn-server.mjs';

const TOKEN = 'elicitation-token';
const SESSION_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

async function startServer(root, env = {}) {
  mkdirSync(join(root, 'ws'), { recursive: true });
  const cwd = realpathSync(join(root, 'ws'));
  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: join(root, 'data'),
    CCM_FAKE_CLAUDE_MODE: 'turn-elicitation',
    CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
    IDLE_TIMEOUT_MS: '120000',
    ...env,
  });
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'elicitation-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  sock.on('agent:event', e => events.push(e));
  await new Promise((resolve, reject) => {
    sock.on('connect', resolve);
    sock.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
  });
  const emitAck = (event, payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 15000);
    sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
  });
  const close = async () => {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
  };
  return { cwd, events, emitAck, close };
}

const elicitations = events => events.filter(e => e.type === 'elicitation');
const results = events => events.filter(e => e.type === 'result');

async function askAndWaitForCard(ctx, clientMessageId) {
  const before = elicitations(ctx.events).length;
  const sent = await ctx.emitAck('user:message', { text: '记一条笔记', cwd: ctx.cwd, clientMessageId });
  assert.equal(sent.ok, true, `发送应被接受，实际 ${JSON.stringify(sent)}`);
  await waitForCondition(() => elicitations(ctx.events).length > before, { timeoutMs: 10000, label: 'elicitation 卡片事件' });
  return { instanceId: sent.instanceId, card: elicitations(ctx.events).at(-1).payload };
}

async function waitForReply(ctx, count) {
  await waitForCondition(() => results(ctx.events).length >= count, { timeoutMs: 10000, label: '本轮收尾（result）' });
  return results(ctx.events).at(-1).payload.text;
}

test.describe('elicitation：表单', () => {
  let root, ctx;
  test.before(async () => {
    root = mkdtempSync(join(tmpdir(), 'ccm-elicit-form-'));
    ctx = await startServer(root);
  });
  test.after(async () => {
    await ctx?.close();
    if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  });

  test('卡片带字段描述、进重连快照；非法作答拒收卡片还在；合法作答原样回到 CLI', async () => {
    const { instanceId, card } = await askAndWaitForCard(ctx, 'el-1');
    assert.equal(card.serverName, 'fake-notes');
    assert.equal(card.mode, 'form');
    assert.deepEqual(card.fields.map(f => [f.name, f.type, f.required]), [['name', 'string', true], ['pin', 'boolean', false]]);

    // 等作答期间：实例算「等你」（与审批、提问同档），跨会话「需要你」里有它（输入维度）
    await waitForCondition(() => {
      const snap = ctx.events.filter(e => e.type === 'instances').at(-1)?.payload;
      return snap?.instances?.find(i => i.instanceId === instanceId)?.state === 'permission'
        && snap?.needsYou?.some(n => n.instanceId === instanceId);
    }, { timeoutMs: 5000, label: 'instances 广播里的等你状态与需要你' });

    const sync = await ctx.emitAck('sync:since', { instanceId, sessionId: SESSION_ID, lastSeq: 0 });
    assert.deepEqual(sync.pending?.elicitations?.map(e => e.requestId), [card.requestId], '重连后卡片要能重建');

    const bad = await ctx.emitAck('elicitation:respond', { instanceId, requestId: card.requestId, action: 'accept', content: { name: 'x' } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /name/);
    assert.equal(results(ctx.events).length, 0, '拒收的作答不能让 CLI 继续');

    const ok = await ctx.emitAck('elicitation:respond', { instanceId, requestId: card.requestId, action: 'accept', content: { name: '周报', pin: true } });
    assert.deepEqual(ok, { ok: true });
    const text = await waitForReply(ctx, 1);
    assert.equal(text, 'elicitation → {"action":"accept","content":{"name":"周报","pin":true}}');
    assert.ok(ctx.events.some(e => e.type === 'request_resolved' && e.payload.requestId === card.requestId && e.payload.kind === 'elicitation'));
  });

  test('拒绝 → CLI 收到 decline；形状不对 → invalid_payload；没有实例 → 会话已经关闭', async () => {
    assert.deepEqual(await ctx.emitAck('elicitation:respond', { requestId: 'x', action: 'approve' }), { ok: false, error: 'invalid_payload' });
    assert.deepEqual(await ctx.emitAck('elicitation:respond', { instanceId: 'nope', requestId: 'x', action: 'decline' }), { ok: false, error: '会话已经关闭' });
    const { instanceId, card } = await askAndWaitForCard(ctx, 'el-2');
    assert.deepEqual(await ctx.emitAck('elicitation:respond', { instanceId, requestId: card.requestId, action: 'decline' }), { ok: true });
    assert.equal(await waitForReply(ctx, 2), 'elicitation → {"action":"decline"}');
  });
});

test.describe('elicitation：URL 授权', () => {
  let root, ctx;
  test.before(async () => {
    root = mkdtempSync(join(tmpdir(), 'ccm-elicit-url-'));
    ctx = await startServer(root, { CCM_FAKE_CLAUDE_ELICIT: 'url' });
  });
  test.after(async () => {
    await ctx?.close();
    if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  });

  test('卡片带 url 与完整 origin；accept 后收到带 elicitationId 的完成事件', async () => {
    const { instanceId, card } = await askAndWaitForCard(ctx, 'el-url');
    assert.equal(card.mode, 'url');
    assert.equal(card.urlOrigin, 'https://auth.example.com');
    assert.equal(card.elicitationId, 'fake-el-1');
    assert.deepEqual(await ctx.emitAck('elicitation:respond', { instanceId, requestId: card.requestId, action: 'accept' }), { ok: true });
    assert.equal(await waitForReply(ctx, 1), 'elicitation → {"action":"accept"}');
    const done = ctx.events.find(e => e.type === 'system' && e.payload?.kind === 'elicitation_complete');
    assert.equal(done?.payload.elicitationId, 'fake-el-1');
  });
});
