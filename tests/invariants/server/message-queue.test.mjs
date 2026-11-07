// tests/invariants/server/message-queue.test.mjs —— 消息排队的接线：真 server 上收下、等回合结束、发出或转未发送
// 守护：MSG-03（排队消息只在回合正常结束后发出；任何一道闸不过都不得发，也不得丢）/ MSG-01（同一条至多发一次）/ SESSION-01（释放时终端在驾驶不得发）/ NOTIFY-01（带 queuedNext 的 result 不是「任务完成」；转未发送无条件推，用户点的停止、关闭除外）/ ALERT-01（未发送进「需要你」，取回后退出）
// 测什么：真 app/server.js + 假 CLI。外部能观察到的只有 ack、user_message 事件（数气泡就是数 send）、result 和 instances 快照：
//   ① 一条走完：ack 键集、快照、queuedNext、发出后快照清空 ② 同 ID 重发不重复 ③ 取回后不再发 ④ 停止、关标签转未发送
//   ⑤ 汇报轮帧序：tail 档等汇报轮跑完才发，汇报轮出错不发；fold 档靠 idle 立刻发；后台子 agent、旧 CLI 走 1.5 秒兜底
//   ⑥ 终端在驾驶时转未发送 ⑦ 未批准设备取不到全文 ⑧ 转未发送的推送（本机 ntfy 截获）与 needsYou
// 不测什么 + 为什么：① 判定规则与竞态表在 tests/invariants/message-queue.test.mjs（S1，能卡住 await）
//   ② 释放时 externalDirty：要在 result 到 idle 那 2ms 里标脏，S2 造不出，S1 覆盖 ③ 额度墙：假 CLI 造不出，S1 覆盖
//   ④ 真帧序：假 CLI 照 2.1.318 探针写，真帧序靠零 token 真链路 ⑤ FRESH 首轮没有 sessionId 时拒收：窗口取决于 ack 和 init
//   谁先到，S2 造不稳，S1 覆盖
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR + 可驱动假 CLI）

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from '../../integration/_spawn-server.mjs';

const TOKEN = 'inv-message-queue-token';
const SESSION_ID = '22222222-3333-4444-5555-666666666666';
const OUTER_KEYS = ['instanceId', 'ok', 'queued', 'sessionId'];

async function withServer(env, run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-queue-')));
  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: root, CCM_DATA_DIR: root, CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
    CCM_PROMPT_SUGGESTION: '0', ...env,
  });
  const events = [];
  let lastInstances = null;
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-queue-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  sock.on('agent:event', (e) => {
    events.push({ ...e, at: Date.now() });
    if (e.type === 'instances') lastInstances = e.payload;
  });
  const send = payload => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`user:message ack 超时：${JSON.stringify(payload).slice(0, 120)}`)), 15000);
    sock.emit('user:message', { cwd: root, ...payload }, (res) => { clearTimeout(timer); resolve(res); });
  });
  const take = payload => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('user:takeQueued ack 超时')), 5000);
    sock.emit('user:takeQueued', payload, (res) => { clearTimeout(timer); resolve(res); });
  });
  const ctx = {
    root, events, send, take, sock,
    queued: () => lastInstances?.queuedMessages,
    needsYou: () => lastInstances?.needsYou,
    bubbles: text => events.filter(e => e.type === 'user_message' && e.payload?.text === text),
    results: () => events.filter(e => e.type === 'result'),
  };
  try {
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });
    await run(ctx);
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
}

// 开一轮并在它收尾之前排一条，返回排队的 ack
async function queueOne(ctx, { text = '排队的话', id = 'q1', attachments } = {}) {
  const first = await ctx.send({ text: '第一条', clientMessageId: 'first' });
  assert.equal(first.ok, true, `首发应被接受，实际 ${JSON.stringify(first)}`);
  // FRESH 首轮要等 init 带来 sessionId 才收，前端同样要等 instances 带上它才显示排队入口
  await waitForCondition(() => ctx.events.some(e => e.type === 'init'), { timeoutMs: 5000, label: '首轮拿到 sessionId' });
  const ack = await ctx.send({ text, clientMessageId: id, instanceId: first.instanceId, queue: true, attachments });
  return { first, ack };
}

test('一条走完：收下 → 回合结束 → 发出，全程只发一次', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '600', CCM_FAKE_CLAUDE_INIT_EACH_TURN: '1' }, async (ctx) => {
    const { first, ack } = await queueOne(ctx);
    assert.deepEqual(Object.keys(ack).sort(), OUTER_KEYS, `收下的 ack 键集变了：${JSON.stringify(ack)}`);
    assert.equal(ack.ok, true);
    assert.equal(ack.queued, true);
    assert.equal(ack.instanceId, first.instanceId);
    assert.equal(ack.sessionId, SESSION_ID);
    await waitForCondition(() => ctx.queued()?.length === 1, { timeoutMs: 3000, label: '快照里出现这一条' });
    const [card] = ctx.queued();
    assert.equal(card.state, 'waiting');
    assert.equal(card.preview, '排队的话');
    assert.equal(card.clientMessageId, 'q1');
    assert.equal(ctx.bubbles('排队的话').length, 0, '排队期间不进消息流');

    await waitForCondition(() => ctx.bubbles('排队的话').length === 1, { timeoutMs: 8000, label: '回合结束后发出' });
    await waitForCondition(() => ctx.results().length === 2, { timeoutMs: 8000, label: '排队那条也跑完' });
    await waitForCondition(() => ctx.queued()?.length === 0, { timeoutMs: 3000, label: '快照清空' });
    assert.equal(ctx.bubbles('排队的话').length, 1, '同一条不得发两次');
    assert.equal(ctx.results()[0].payload.queuedNext, true, '第一轮的 result 要带 queuedNext，不然会推「任务完成」');
    assert.equal(ctx.results()[1].payload.queuedNext, undefined, '后面没有排队的了');
  });
});

test('回合恰好结束：queue:true 按普通发送走，ack 不带 queued', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn' }, async (ctx) => {
    const first = await ctx.send({ text: '第一条', clientMessageId: 'first' });
    await waitForCondition(() => ctx.results().length === 1, { timeoutMs: 8000, label: '第一轮结束' });
    const ack = await ctx.send({ text: '刚好结束', clientMessageId: 'q1', instanceId: first.instanceId, queue: true });
    assert.equal(ack.ok, true);
    assert.equal(ack.queued, undefined);
    assert.deepEqual(ctx.queued() ?? [], []);
  });
});

test('同 ID 重发：不重复存，ack 补 queued；第二条被占位拒收', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '1500' }, async (ctx) => {
    const { first } = await queueOne(ctx);
    const again = await ctx.send({ text: '排队的话', clientMessageId: 'q1', instanceId: first.instanceId, queue: true });
    assert.equal(again.ok, true);
    assert.equal(again.deduped, true);
    assert.equal(again.queued, true, '首发 ack 丢了的客户端靠这个知道它排上了');
    const second = await ctx.send({ text: '再来一条', clientMessageId: 'q2', instanceId: first.instanceId, queue: true });
    assert.equal(second.ok, false);
    assert.equal(second.queueFull, true);
    assert.equal(second.busy, true);
    assert.equal(second.retryable, false);
    await waitForCondition(() => ctx.bubbles('排队的话').length === 1, { timeoutMs: 8000, label: '发出' });
    assert.equal(ctx.bubbles('再来一条').length, 0);
  });
});

test('没带 queue 的普通发送撞在途轮：负 ack 逐字不变', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '1000' }, async (ctx) => {
    const first = await ctx.send({ text: '第一条', clientMessageId: 'first' });
    const busy = await ctx.send({ text: '不排队', clientMessageId: 'b1', instanceId: first.instanceId });
    assert.deepEqual(busy, { ok: false, error: '当前任务运行中，请等待完成后再发送', busy: true, retryable: false });
  });
});

test('排队请求没带 clientMessageId：按普通发送拒收，不收下一条取不回的消息', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'init' }, async (ctx) => {
    const first = await ctx.send({ text: '第一条', clientMessageId: 'first' });
    await waitForCondition(() => ctx.events.some(e => e.type === 'init'), { timeoutMs: 5000, label: '首轮拿到 sessionId' });
    const ack = await ctx.send({ text: '没有 ID', instanceId: first.instanceId, queue: true });
    assert.deepEqual(ack, { ok: false, error: '当前任务运行中，请等待完成后再发送', busy: true, retryable: false });
    assert.deepEqual(ctx.queued() ?? [], []);
  });
});

test('取回：全文和附件回到发送方，回合结束后不再发；后到的 not_found', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '1000' }, async (ctx) => {
    const attachments = [{ name: 'a.txt', mimeType: 'text/plain', size: 5, data: Buffer.from('hello').toString('base64') }];
    const text = '长'.repeat(300);
    await queueOne(ctx, { text, attachments });
    await waitForCondition(() => ctx.queued()?.length === 1, { timeoutMs: 3000, label: '快照里出现' });
    assert.equal(ctx.queued()[0].preview.length, 140, '快照不下发全文');
    const taken = await ctx.take({ sessionId: SESSION_ID, clientMessageId: 'q1' });
    assert.equal(taken.ok, true);
    assert.equal(taken.text, text);
    assert.deepEqual(taken.attachments, attachments);
    assert.deepEqual(await ctx.take({ sessionId: SESSION_ID, clientMessageId: 'q1' }), { ok: false, error: 'not_found' });
    await waitForCondition(() => ctx.results().length === 1, { timeoutMs: 8000, label: '第一轮结束' });
    await waitForCondition(() => ctx.queued()?.length === 0, { timeoutMs: 3000, label: '快照清空' });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(ctx.bubbles(text).length, 0, '取回之后不得再发');
    assert.equal(ctx.results()[0].payload.queuedNext, undefined);
  });
});

test('user:takeQueued 校验 sessionId', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn' }, async (ctx) => {
    assert.deepEqual(await ctx.take({ sessionId: '../etc/passwd', clientMessageId: 'q1' }), { ok: false, error: 'invalid_payload' });
  });
});

test('MSG-03：用户点停止 → 同步转未发送，迟到的 result 不发', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '800' }, async (ctx) => {
    const { first } = await queueOne(ctx);
    ctx.sock.emit('user:interrupt', { instanceId: first.instanceId });
    await waitForCondition(() => ctx.queued()?.[0]?.state === 'held', { timeoutMs: 3000, label: '转未发送' });
    assert.equal(ctx.queued()[0].reason, 'stopped');
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(ctx.bubbles('排队的话').length, 0, '点了停止之后不得自动发');
    assert.equal(ctx.queued()[0].state, 'held', '不得丢，用户要能取回');
  });
});

test('MSG-03：关标签 → 未发送，条目还在，取得回', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'init' }, async (ctx) => {
    const { first } = await queueOne(ctx);
    await new Promise((resolve) => { ctx.sock.emit('session:close', { instanceId: first.instanceId }, resolve); setTimeout(resolve, 1000); });
    await waitForCondition(() => ctx.queued()?.[0]?.state === 'held', { timeoutMs: 3000, label: '转未发送' });
    assert.equal(ctx.queued()[0].reason, 'closed');
    const taken = await ctx.take({ sessionId: SESSION_ID, clientMessageId: 'q1' });
    assert.equal(taken.text, '排队的话');
  });
});

test('汇报轮紧跟：result 后消息留在服务端，汇报轮跑完才发', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn-autoreport-tail', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '400', CCM_FAKE_CLAUDE_AUTOREPORT_MS: '2500' }, async (ctx) => {
    await queueOne(ctx);
    await waitForCondition(() => ctx.bubbles('排队的话').length === 1, { timeoutMs: 10000, label: '发出' });
    assert.ok(ctx.results().length >= 2, '汇报轮的 result 必须先到：提前发就是把消息交进 CLI 队列，停止和额度墙都拦不住了');
    const reportResultAt = ctx.results()[1].at;
    assert.ok(ctx.bubbles('排队的话')[0].at >= reportResultAt, '消息要排在汇报轮结束之后');
    assert.equal(ctx.results()[0].payload.queuedNext, true);
    assert.equal(ctx.results()[1].payload.queuedNext, true, '汇报轮结束时也还有下一条，不是任务完成');
  });
});

test('汇报轮出错 → 未发送，不发', async () => {
  await withServer({
    CCM_FAKE_CLAUDE_MODE: 'turn-autoreport-tail', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '400',
    CCM_FAKE_CLAUDE_AUTOREPORT_MS: '300', CCM_FAKE_CLAUDE_AUTOREPORT_FAIL: '1',
  }, async (ctx) => {
    await queueOne(ctx);
    await waitForCondition(() => ctx.queued()?.[0]?.state === 'held', { timeoutMs: 8000, label: '转未发送' });
    assert.equal(ctx.queued()[0].reason, 'turn_error');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(ctx.bubbles('排队的话').length, 0);
  });
});

test('通知并进当前回合：CLI 立刻报 idle，不用等兜底', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn-autoreport-fold', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '400' }, async (ctx) => {
    await queueOne(ctx);
    await waitForCondition(() => ctx.bubbles('排队的话').length === 1, { timeoutMs: 8000, label: '发出' });
    const waited = ctx.bubbles('排队的话')[0].at - ctx.results()[0].at;
    assert.ok(waited < 1000, `应该靠 idle 立刻发，实际等了 ${waited}ms（走到兜底了：flag 滞留的老路）`);
  });
});

test('后台子 agent 占着 CLI：不报 idle 也不能卡住，兜底发出', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn-bg-agent', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '400' }, async (ctx) => {
    await queueOne(ctx);
    await waitForCondition(() => ctx.bubbles('排队的话').length === 1, { timeoutMs: 8000, label: '发出' });
    const waited = ctx.bubbles('排队的话')[0].at - ctx.results()[0].at;
    assert.ok(waited >= 1200, `这一档没有 idle，只能是兜底，实际 ${waited}ms`);
  });
});

test('旧 CLI 没有会话状态帧：照样发得出去', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '400', CCM_FAKE_CLAUDE_NO_STATE_FRAMES: '1' }, async (ctx) => {
    await queueOne(ctx);
    await waitForCondition(() => ctx.bubbles('排队的话').length === 1, { timeoutMs: 8000, label: '发出' });
  });
});

test('SESSION-01：释放时终端在驾驶 → 未发送，消息没进实例', async () => {
  const registry = join(homedir(), '.claude', 'sessions');
  mkdirSync(registry, { recursive: true });
  const entry = join(registry, `${process.pid}.json`);
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '500' }, async (ctx) => {
    writeFileSync(entry, JSON.stringify({
      pid: process.pid, sessionId: SESSION_ID, cwd: ctx.root, kind: 'interactive', entrypoint: 'cli', status: 'busy', startedAt: 1, version: '2.1.318',
    }));
    try {
      await queueOne(ctx);
      await waitForCondition(() => ctx.queued()?.[0]?.state === 'held', { timeoutMs: 8000, label: '转未发送' });
      assert.equal(ctx.queued()[0].reason, 'other_driver');
      assert.equal(ctx.bubbles('排队的话').length, 0);
    } finally {
      rmSync(entry, { force: true });
    }
  });
});

// 这里走到的是统一注册器那道（deviceApproved===false）。handler 里的 !== true 防的是连接建立中的未定态，S2 造不稳。
test('待审批的设备取不到全文', async () => {
  await withServer({ CCM_FAKE_CLAUDE_MODE: 'init', DEVICE_APPROVAL_SCOPE: 'all' }, async (ctx) => {
    const res = await ctx.take({ sessionId: SESSION_ID, clientMessageId: 'q1' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'device_not_approved', `待审批设备不得走到取回，实际 ${JSON.stringify(res)}`);
  });
});

// 本机 ntfy 截获：推送走真 emitNotify → ntfyNotify，这里只收请求体
async function withNtfy(run) {
  const hits = [];
  const ntfy = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { hits.push(JSON.parse(body)); } catch { hits.push({ raw: body }); } res.end('{"id":"mock"}'); });
  });
  await new Promise(resolve => ntfy.listen(0, '127.0.0.1', resolve));
  try {
    await run({ NTFY_URL: `http://127.0.0.1:${ntfy.address().port}`, NTFY_TOPIC: 'ccm-inv-queue' }, hits);
  } finally {
    await new Promise(resolve => ntfy.close(resolve));
  }
}
const heldItems = ctx => (ctx.needsYou() ?? []).filter(n => n.reason === 'queued_held');
const heldPushes = hits => hits.filter(h => /排队消息没有发出/.test(h.title ?? ''));

test('NOTIFY-01 / ALERT-01：汇报轮出错转未发送 → 推一条、进「需要你」，取回后退出', async () => {
  await withNtfy(async (ntfyEnv, hits) => {
    await withServer({
      CCM_FAKE_CLAUDE_MODE: 'turn-autoreport-tail', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '400',
      CCM_FAKE_CLAUDE_AUTOREPORT_MS: '300', CCM_FAKE_CLAUDE_AUTOREPORT_FAIL: '1', ...ntfyEnv,
    }, async (ctx) => {
      await queueOne(ctx);
      await waitForCondition(() => ctx.queued()?.[0]?.state === 'held', { timeoutMs: 8000, label: '转未发送' });
      assert.equal(ctx.queued()[0].reason, 'turn_error');
      await waitForCondition(() => heldItems(ctx).length === 1, { timeoutMs: 3000, label: '进「需要你」' });
      const [item] = heldItems(ctx);
      assert.equal(item.sessionId, SESSION_ID);
      assert.equal(typeof item.instanceId, 'string', '没有实例号的话点这一条深链不过去');
      assert.equal(typeof item.waitingSince, 'number');
      await waitForCondition(() => heldPushes(hits).length === 1, { timeoutMs: 8000, label: 'ntfy 收到未发送推送' });
      const [push] = heldPushes(hits);
      assert.match(push.message ?? '', /本轮出错/, `正文要说原因：${JSON.stringify(push)}`);
      assert.doesNotMatch(JSON.stringify(push), /排队的话/, 'SEC-04：消息原文进了 ntfy 明文通道');
      assert.equal(push.priority, 5);

      const taken = await ctx.take({ sessionId: SESSION_ID, clientMessageId: 'q1' });
      assert.equal(taken.ok, true);
      await waitForCondition(() => heldItems(ctx).length === 0, { timeoutMs: 3000, label: '取回后退出「需要你」' });
      assert.equal(heldPushes(hits).length, 1, '一次转未发送只推一条');
    });
  });
});

test('NOTIFY-01 / ALERT-01：用户自己点停止转未发送 → 不推、不进「需要你」，卡片照样在', async () => {
  await withNtfy(async (ntfyEnv, hits) => {
    await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '800', ...ntfyEnv }, async (ctx) => {
      const { first } = await queueOne(ctx);
      ctx.sock.emit('user:interrupt', { instanceId: first.instanceId });
      await waitForCondition(() => ctx.queued()?.[0]?.state === 'held', { timeoutMs: 3000, label: '转未发送' });
      assert.equal(ctx.queued()[0].reason, 'stopped');
      await new Promise(r => setTimeout(r, 1500));
      assert.equal(heldItems(ctx).length, 0, '用户刚点的停止，再把它列成待办是打扰');
      assert.equal(heldPushes(hits).length, 0, `用户刚点的停止不该推：${JSON.stringify(hits)}`);
      assert.equal(ctx.queued()[0].state, 'held', '不提醒不等于丢掉');
    });
  });
});

test('NOTIFY-01 / ALERT-01：回合中途进程退出转未发送 → 推一条带深链，「需要你」那条实例号不为空', async () => {
  await withNtfy(async (ntfyEnv, hits) => {
    await withServer({ CCM_FAKE_CLAUDE_MODE: 'turn', CCM_FAKE_CLAUDE_RESULT_DELAY_MS: '600', CCM_FAKE_CLAUDE_EXIT_MID_TURN: '1', ...ntfyEnv }, async (ctx) => {
      const { first } = await queueOne(ctx);
      await waitForCondition(() => ctx.queued()?.[0]?.state === 'held', { timeoutMs: 8000, label: '转未发送' });
      assert.equal(ctx.queued()[0].reason, 'instance_exit');
      await waitForCondition(() => heldItems(ctx).length === 1, { timeoutMs: 3000, label: '进「需要你」' });
      assert.equal(heldItems(ctx)[0].instanceId, first.instanceId, '实例没了也要给排队时的实例号，前端按 sessionId 切过去；给 null 就点不动');
      await waitForCondition(() => heldPushes(hits).length === 1, { timeoutMs: 8000, label: 'ntfy 收到未发送推送' });
      assert.match(heldPushes(hits)[0].message ?? '', /会话进程退出了/);
    });
  });
});

