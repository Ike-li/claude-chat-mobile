// tests/integration/new-session-compose-routing.test.mjs —— 新会话页的首发开新会话，不落进别人的会话
//
// 形态（验收 O107）：服务端 viewingInstanceId 是全局单值（AD-5）。设备 B 停在新会话页时发第一条消息，
// 消息不带 instanceId，resolveInstanceTarget 回退「当前查看实例」——那可能是设备 A 刚开、正在看的会话，
// B 的话于是进了 A 的会话。修复：新会话页每次发送都带上它的 composeId（每个新会话页一枚），服务端据此
// 开新会话，不回退全局 viewing、不续项目的「当前会话」指针；同一页面的后续消息按 composeId 落回它自己
// 开出来的那个实例。
//
// 不测什么：多设备共享一份视图本身（AD-5，已决不做）；前端什么时候带 composeId 由 E2E/单测管，
// 这里只证明服务端收到它之后的路由。
// 执行位守卫：必须是第一条 import。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from './_spawn-server.mjs';

const TOKEN = 'int-compose-routing-token';

test('新会话页带 composeId 的首发开新会话；同一页面的下一条回到它自己开的实例', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-int-compose-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);

  // turn 档：回合会收尾，实例回到空闲——否则第二条消息被「当前任务运行中」挡下，看不出它路由去了哪
  const server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: repo, CCM_DATA_DIR: join(root, 'data'), CCM_FAKE_CLAUDE_MODE: 'turn' });
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'int-compose-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  sock.on('agent:event', e => events.push(e));
  const turnDone = (instanceId, label) => waitForCondition(
    () => events.some(e => e.type === 'result' && e.instanceId === instanceId), { timeoutMs: 10_000, label });
  try {
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });
    const emit = (event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 20000);
      sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
    });

    // 设备 A：新会话页发第一条，开出实例 X，服务端 viewing = X
    await emit('session:new', { cwd: repo });
    const a = await emit('user:message', { text: 'A 的会话', cwd: repo, composeId: 'page-a', clientMessageId: 'compose-a1' });
    assert.equal(a?.ok, true, `A 的首发应被接受：${JSON.stringify(a)}`);
    assert.ok(a.instanceId, '前提：A 的首发懒开出实例');
    await turnDone(a.instanceId, 'A 的回合收尾');

    // 设备 B：停在自己的新会话页（前端 viewing 为空，不带 instanceId），服务端全局 viewing 仍是 X
    const b = await emit('user:message', { text: 'B 在新会话页', cwd: repo, composeId: 'page-b', clientMessageId: 'compose-b1' });
    assert.equal(b?.ok, true, `B 的首发应被接受：${JSON.stringify(b)}`);
    assert.notEqual(b.instanceId, a.instanceId, 'B 的第一条落进了 A 的会话——回退了全局 viewing');
    await turnDone(b.instanceId, 'B 的回合收尾');

    // 全局 viewing 被 A 切回 X 之后，B 那一页（广播还没到、或离线重放）再发一条：仍回到 B 自己开的实例
    sock.emit('user:setViewing', { instanceId: a.instanceId });
    const b2 = await emit('user:message', { text: 'B 的第二条', cwd: repo, composeId: 'page-b', clientMessageId: 'compose-b2' });
    assert.equal(b2?.ok, true, `B 的第二条应被接受：${JSON.stringify(b2)}`);
    assert.equal(b2.instanceId, b.instanceId, '同一个新会话页的第二条没回到它自己开的实例');

    // #328 review P2：B 那一页开出的实例没了（关闭、空闲回收、置换），这一页还排着的消息到达——续接它已有的会话，
    // 不另开一个没有前文的新会话
    const sessionOf = id => events.filter(e => e.type === 'instances').pop()?.payload?.instances?.find(i => i.instanceId === id)?.sessionId;
    const bSession = sessionOf(b.instanceId);
    assert.ok(bSession, '前提：B 的实例已经有了会话 id');
    sock.emit('session:close', { instanceId: b.instanceId });
    await waitForCondition(() => {
      const last = events.filter(e => e.type === 'instances').pop();
      return last && !last.payload.instances.some(i => i.instanceId === b.instanceId);
    }, { timeoutMs: 10_000, label: 'B 的实例已关闭' });
    const b3 = await emit('user:message', { text: 'B 的第三条', cwd: repo, composeId: 'page-b', clientMessageId: 'compose-b3', fromOutbox: true });
    assert.equal(b3?.ok, true, `B 的第三条应被接受：${JSON.stringify(b3)}`);
    await waitForCondition(() => sessionOf(b3.instanceId), { timeoutMs: 10_000, label: 'B 第三条的实例有了会话 id' });
    assert.equal(sessionOf(b3.instanceId), bSession, '实例没了之后，这一页的消息另开了一个新会话，前文丢了');
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});

// #328 review：两个新会话页并发首发、都勾了「在新 worktree 里开」——是两个会话，就得是两棵树。只按页拆开
// 下游的实例单飞、不拆 worktree 的建树单飞，两个实例会落在同一棵树里同时改它。
test('两个新会话页并发首发到新 worktree：各开各的实例，也各在各的树里', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-int-compose-wt-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-m', 'init');

  const server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: repo, CCM_DATA_DIR: join(root, 'data') });
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'int-compose-wt-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  sock.on('agent:event', e => events.push(e));
  try {
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });
    const emit = (event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 30000);
      sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
    });
    await emit('session:new', { cwd: repo });
    const [x, y] = await Promise.all([
      emit('user:message', { text: '页面 X', cwd: repo, useWorktree: true, sourceBranch: 'main', composeId: 'page-x', clientMessageId: 'wt-x' }),
      emit('user:message', { text: '页面 Y', cwd: repo, useWorktree: true, sourceBranch: 'main', composeId: 'page-y', clientMessageId: 'wt-y' }),
    ]);
    assert.equal(x?.ok, true, JSON.stringify(x));
    assert.equal(y?.ok, true, JSON.stringify(y));
    assert.notEqual(x.instanceId, y.instanceId, '两个新会话页并成了一个会话');
    const cwdOf = id => events.filter(e => e.type === 'instances').pop()?.payload?.instances?.find(i => i.instanceId === id)?.cwd;
    assert.ok(cwdOf(x.instanceId)?.includes(join('.claude', 'worktrees')), `前提：X 开在新 worktree 里，实际 ${cwdOf(x.instanceId)}`);
    assert.notEqual(cwdOf(x.instanceId), cwdOf(y.instanceId), '两个会话落在同一棵 worktree 里，会同时改它');
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
