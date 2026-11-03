// tests/integration/background-tasks.test.mjs —— 转后台（#459，SDK backgroundTasks，等价终端 Ctrl+B）
//
// 测什么：
//   ① 一条前台 Bash 挡着本轮时，foreground_tasks 全量快照到达手机，sync:since（切回 / 重连）会补推；
//   ② task:background 不带 toolUseId = 全部转后台：控制请求到 CLI，本轮随即收尾，前台集合清空，
//      它进了后台任务快照；带一个对不上的 toolUseId → not_found；形状不对 → invalid_payload；
//   ③ 没有实例 → no_instance；会话禁用了后台任务 → disabled，带 CLI 原文；
//   ④ 终端在驾驶（只读镜像）时按没有实例处理：本进程的 SDK 子进程闲着，前台任务在终端那边。
// 假 CLI 的 turn-fg-task 档照 SDK d.ts 描述的次序吐事件（见 tests/fixtures/fake-claude.mjs 头注）；
// 真 CLI 下的表现列在 PR 的待实测里。零 token 成本。只在容器 / CI 跑。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from './_spawn-server.mjs';
import { encodeProjectDir } from '../../app/src/shared/project-dir.js';

const TOKEN = 'background-tasks-token';
const SESSION_ID = '88888888-9999-4aaa-8bbb-cccccccccccc';
const TICK_MS = 2500; // mirror-engine 的 CATCH_UP_INTERVAL_MS

async function startServer(root, env = {}) {
  mkdirSync(join(root, 'ws'), { recursive: true });
  const cwd = realpathSync(join(root, 'ws'));
  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: join(root, 'data'),
    CCM_FAKE_CLAUDE_MODE: 'turn-fg-task',
    CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
    IDLE_TIMEOUT_MS: '120000',
    ...env,
  });
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'background-tasks-device' },
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

const fgSnapshots = events => events.filter(e => e.type === 'foreground_tasks').map(e => e.payload?.tasks);

async function startForegroundTurn(ctx, clientMessageId) {
  const sent = await ctx.emitAck('user:message', { text: '跑个长命令', cwd: ctx.cwd, clientMessageId });
  assert.equal(sent.ok, true, `首发应被接受，实际 ${JSON.stringify(sent)}`);
  await waitForCondition(() => fgSnapshots(ctx.events).at(-1)?.length === 1, { timeoutMs: 10000, label: '前台任务快照' });
  return sent.instanceId;
}

test.describe('task:background', () => {
  let root, ctx;
  test.before(async () => {
    root = mkdtempSync(join(tmpdir(), 'ccm-bg-tasks-'));
    ctx = await startServer(root);
  });
  test.after(async () => {
    await ctx?.close();
    if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  });

  test('还没有实例：no_instance；toolUseId 形状不对：invalid_payload', async () => {
    assert.deepEqual(await ctx.emitAck('task:background', {}), { ok: false, reason: 'no_instance' });
    for (const toolUseId of ['', 42, 'x'.repeat(257)]) {
      assert.deepEqual(await ctx.emitAck('task:background', { toolUseId }), { ok: false, reason: 'invalid_payload' },
        JSON.stringify(toolUseId));
    }
  });

  test('前台 Bash 挡着本轮：快照带上它，sync:since 会补推；转后台后本轮收尾、它进了后台任务', async () => {
    const instanceId = await startForegroundTurn(ctx, 'bg-1');
    assert.deepEqual(fgSnapshots(ctx.events).at(-1), [
      { taskId: 'fake-fg-task', toolUseId: 'toolu_fake_fg', taskType: 'local_bash', description: 'sleep 120 && echo done' },
    ]);

    const before = fgSnapshots(ctx.events).length;
    await ctx.emitAck('sync:since', { instanceId, sessionId: SESSION_ID, lastSeq: 0 });
    await waitForCondition(() => fgSnapshots(ctx.events).length > before, { timeoutMs: 5000, label: 'sync:since 补推前台快照' });
    assert.equal(fgSnapshots(ctx.events).at(-1).length, 1);

    assert.deepEqual(await ctx.emitAck('task:background', { instanceId, toolUseId: 'toolu_other' }), { ok: false, reason: 'not_found' });
    assert.deepEqual(await ctx.emitAck('task:background', { instanceId }), { ok: true });
    await waitForCondition(() => ctx.events.some(e => e.type === 'result' && e.instanceId === instanceId),
      { timeoutMs: 10000, label: '本轮收尾（result）' });
    assert.deepEqual(fgSnapshots(ctx.events).at(-1), []);
    const bgSnapshot = ctx.events.filter(e => e.type === 'task_progress').at(-1);
    assert.ok(bgSnapshot?.payload?.tasks?.some(t => t.taskId === 'fake-fg-task'), '转后台之后它就是后台任务，横幅要接住');
    const toolResult = ctx.events.find(e => e.type === 'tool_result' && e.payload?.toolUseId === 'toolu_fake_fg');
    assert.match(toolResult?.payload?.outputSummary || '', /running in background/);
  });
});

test.describe('task:background：会话禁用了后台任务', () => {
  let root, ctx;
  test.before(async () => {
    root = mkdtempSync(join(tmpdir(), 'ccm-bg-tasks-off-'));
    ctx = await startServer(root, { CCM_FAKE_CLAUDE_BG_DISABLED: '1' });
  });
  test.after(async () => {
    await ctx?.close();
    if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  });

  test('回 disabled 和 CLI 原文，前台任务原样留着', async () => {
    const instanceId = await startForegroundTurn(ctx, 'bg-off-1');
    assert.deepEqual(await ctx.emitAck('task:background', { instanceId }), {
      ok: false, reason: 'disabled', error: 'Background tasks are disabled in this session.',
    });
    assert.equal(fgSnapshots(ctx.events).at(-1).length, 1);
  });
});

// 造只读镜像的办法与时序同 tests/invariants/server/external-dirty.test.mjs：先等镜像建好基线，
// 再往 transcript 追加一轮终端写的对话。用 turn 档：web 这一轮要收尾，镜像引擎才会判外部写入。
test.describe('task:background：终端驾驶的只读镜像', () => {
  let root, ctx, projectDir;
  test.before(async () => {
    root = mkdtempSync(join(tmpdir(), 'ccm-bg-tasks-mirror-'));
    ctx = await startServer(root, { CCM_FAKE_CLAUDE_MODE: 'turn' });
    projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(ctx.cwd));
    mkdirSync(projectDir, { recursive: true });
  });
  test.after(async () => {
    await ctx?.close();
    if (root) rmSync(root, { recursive: true, force: true });            // safe-rm: mkdtemp 一次性目录
    if (projectDir) rmSync(projectDir, { recursive: true, force: true }); // safe-rm: 目录名由本用例一次性 cwd 编码而来
  });

  test('终端一接手：按没有实例处理，回 no_instance', async () => {
    const transcript = join(projectDir, `${SESSION_ID}.jsonl`);
    const line = (type, text, parentUuid, uuid) => `${JSON.stringify({
      type, uuid, parentUuid, timestamp: new Date().toISOString(), sessionId: SESSION_ID, cwd: ctx.cwd, isMeta: false,
      entrypoint: 'cli', message: { role: type, content: [{ type: 'text', text }] },
    })}\n`;
    const seedUser = randomUUID(), seedAssistant = randomUUID();
    writeFileSync(transcript, line('user', '终端里先说的', null, seedUser) + line('assistant', '终端里的回答', seedUser, seedAssistant));
    const sent = await ctx.emitAck('user:message', { text: 'web 第一条', cwd: ctx.cwd, clientMessageId: 'bg-mirror-1' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await new Promise(r => setTimeout(r, TICK_MS * 2 + 500)); // 基线建牢之前追加会被当成基线本身
    const extUser = randomUUID();
    appendFileSync(transcript, line('user', '终端后来又说的', seedAssistant, extUser) + line('assistant', '终端的新回答', extUser, randomUUID()));
    await waitForCondition(() => ctx.events.some(e => e.type === 'mirror_state' && e.payload?.readonly === true),
      { timeoutMs: TICK_MS * 4, label: '镜像上锁' });
    assert.deepEqual(await ctx.emitAck('task:background', { instanceId: sent.instanceId }), { ok: false, reason: 'no_instance' });
  });
});
