// tests/integration/effort-source.test.mjs —— 思考档的「来源」从服务端哪几环出去（真 server + 假 CLI）
//
// 验收 O15：CLI settings 里存了 effortLevel 时，新会话首发照样把它当显式档下发（与终端读 settings
// 一致），但用户没选过它，界面得显示「<档> · CLI 默认」。前端只认服务端给的来源；来源在哪一环断了，
// 发完一条（或续接一次）胶囊就又变回光秃的档。这里钉服务端那几环：
//   ① 空首页 instances 的 defaultEffortSource
//   ② 首发开出的实例：instances[].effortSource，并随 sessions.json 落盘
//   ③ 用户点了同一档：来源改成 user（不被「同档幂等」挡掉），回执与落盘跟着改
//   ④ 续接：sessions.json 里记的来源读回来——settings 来的档跟随 settings 此刻的值，用户选的照旧
//
// 不测什么：
//  · 优先级与「跟随 settings 此刻的值」的各分支——纯函数，unit/cli-settings-defaults 与
//    unit/display-contracts 覆盖；这里每环只取一个代表态，证明接线接上了。
//  · 前端怎么显示——E2E P0-09za 覆盖（mock 是平行实现，不经过这里）。
//  · CLI 真按 --effort 跑了没有——假 CLI 不跑模型，归 S5。
//
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR + 可驱动假 CLI）

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from './_spawn-server.mjs';
import { encodeProjectDir } from '../../app/src/shared/project-dir.js';

const TOKEN = 'effort-source-token';
const SESSION_ID = '5e1f0c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';

// 续接要有盘上的会话可打开：一问一答、线性链，不触发续接分叉判定。
function transcriptText(cwd) {
  const [u1, a1] = [randomUUID(), randomUUID()];
  const row = fields => JSON.stringify({ sessionId: SESSION_ID, cwd, isSidechain: false, timestamp: '2026-10-01T00:00:00.000Z', ...fields });
  return [
    row({ type: 'user', uuid: u1, parentUuid: null, entrypoint: 'sdk-ts', message: { role: 'user', content: '旧问题' } }),
    row({ type: 'assistant', uuid: a1, parentUuid: u1, entrypoint: 'sdk-ts', message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] } }),
  ].map(l => `${l}\n`).join('');
}

// 一台隔离 server + 一条已连上的 socket，跑完必定收尸。settings 写在一次性工作区的项目层
// （<cwd>/.claude/settings.json），不碰 HOME 下的用户层。seedSession 给定时预置 sessions.json
// 与盘上 transcript，供续接用例打开。
async function withServer({ tag, settingsEffort, seedSession = null }, fn) {
  const root = mkdtempSync(join(tmpdir(), `ccm-effort-src-${tag}-`));
  const ws = join(root, 'ws');
  mkdirSync(join(ws, '.claude'), { recursive: true });
  const cwd = realpathSync(ws);
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ effortLevel: settingsEffort }));
  let projectDir = null;
  if (seedSession) {
    writeFileSync(join(root, 'sessions.json'), JSON.stringify({
      currentByCwd: {},
      sessions: [{ id: SESSION_ID, title: '旧会话', cwd, model: null, permissionMode: null, createdAt: 1, lastUsedAt: 1, ...seedSession }],
    }));
    // 一次性 cwd ⇒ 编码出来的项目目录也是一次性的。只在容器 / CI 跑（集成层不在宿主机白名单），
    // 那里的 HOME 本身就是一次性目录。
    projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), transcriptText(cwd));
  }

  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: root,
    CCM_FAKE_CLAUDE_MODE: 'init',                 // 吐 init 拿 sessionId（会话这才落盘），不吐 result
    CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
  });
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: `effort-src-${tag}-device` },
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
    const emitAck = (event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时：${JSON.stringify(payload)}`)), 15000);
      sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
    });
    const lastInstances = () => [...events].reverse().find(e => e.type === 'instances')?.payload;
    const savedSession = () => {
      try {
        return JSON.parse(readFileSync(join(root, 'sessions.json'), 'utf8')).sessions?.find(x => x.id === SESSION_ID) ?? null;
      } catch { return null; }
    };
    // 空首页的默认档到齐，才说明 L3（settings）已经读进缓存——续接用例靠它排除「这次 settings 没读到」那条分支
    await waitForCondition(() => lastInstances()?.defaultEffort === settingsEffort,
      { timeoutMs: 15000, label: `空首页 defaultEffort === ${settingsEffort}` });
    return await fn({ sock, cwd, events, emitAck, lastInstances, savedSession });
  } finally {
    try { sock.close(); } catch { /* 已断开 */ }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true });                       // safe-rm: mkdtemp 一次性目录
    if (projectDir) rmSync(projectDir, { recursive: true, force: true }); // safe-rm: 目录名由本用例一次性 cwd 编码而来
  }
}

test('新会话：settings 来的档从空首页到首发、落盘都标 cli-settings；用户点同一档后改成 user', async () => {
  await withServer({ tag: 'fresh', settingsEffort: 'high' }, async ({ sock, cwd, events, emitAck, lastInstances, savedSession }) => {
    assert.equal(lastInstances().defaultEffortSource, 'cli-settings', '① 空首页：下一条新会话的档来自 CLI settings');

    const ack = await emitAck('user:message', { text: '起一轮', cwd, clientMessageId: 'es-1' });
    assert.equal(ack.ok, true, `首发应被接受：${JSON.stringify(ack)}`);
    const inst = await waitForCondition(
      () => lastInstances()?.instances?.find(x => x.sessionId === SESSION_ID),
      { timeoutMs: 15000, label: '首发开出的实例出现在 instances 里' });
    assert.equal(inst.effort, 'high', '行为不变：settings 的档照样当显式档用');
    assert.equal(inst.effortSource, 'cli-settings', '② 首发之后来源仍是 CLI settings——断在这里，胶囊就变回光秃的 high');
    const persisted = await waitForCondition(() => (savedSession()?.effortSource ? savedSession() : null),
      { timeoutMs: 5000, label: 'sessions.json 记下来源' });
    assert.deepEqual([persisted.effort, persisted.effortSource], ['high', 'cli-settings'],
      '② 落盘要带来源：续接时靠它分辨会话自己选的与 settings 来的');

    const before = events.length;
    sock.emit('user:setEffort', { level: 'high' });
    const echoed = await waitForCondition(
      () => events.slice(before).find(e => e.type === 'effort_mode' && e.payload?.source === 'user'),
      { timeoutMs: 15000, label: '③ 点同一档：回执来源改成 user' });
    assert.equal(echoed.payload.level, 'high');
    await waitForCondition(() => savedSession()?.effortSource === 'user',
      { timeoutMs: 5000, label: '③ sessions.json 的来源改成 user' });
    assert.equal(lastInstances().instances.find(x => x.sessionId === SESSION_ID)?.effortSource, 'user');
  });
});

test('续接：sessions.json 记的是 settings 来的档 → 跟随 settings 此刻的值，仍标 cli-settings', async () => {
  await withServer({ tag: 'resume-cli', settingsEffort: 'low', seedSession: { effort: 'high', effortSource: 'cli-settings' } },
    async ({ cwd, emitAck, lastInstances }) => {
      const opened = await emitAck('session:switch', { cwd, sessionId: SESSION_ID });
      assert.equal(opened?.ok, true, `前提：会话要能打开：${JSON.stringify(opened)}`);
      const inst = await waitForCondition(
        () => lastInstances()?.instances?.find(x => x.instanceId === opened.instanceId),
        { timeoutMs: 15000, label: '续接开出的实例出现在 instances 里' });
      assert.deepEqual([inst.effort, inst.effortSource], ['low', 'cli-settings'],
        '④ settings 已改成 low：终端 claude --resume 现读 settings 用 low，这里不能还钉着当初的 high');
    });
});

test('续接：sessions.json 记的是用户选的档 → 照旧用它，标 user', async () => {
  await withServer({ tag: 'resume-user', settingsEffort: 'low', seedSession: { effort: 'high', effortSource: 'user' } },
    async ({ cwd, emitAck, lastInstances }) => {
      const opened = await emitAck('session:switch', { cwd, sessionId: SESSION_ID });
      assert.equal(opened?.ok, true, `前提：会话要能打开：${JSON.stringify(opened)}`);
      const inst = await waitForCondition(
        () => lastInstances()?.instances?.find(x => x.instanceId === opened.instanceId),
        { timeoutMs: 15000, label: '续接开出的实例出现在 instances 里' });
      assert.deepEqual([inst.effort, inst.effortSource], ['high', 'user'], '④ 用户自己选的档不随 settings 变');
    });
});
