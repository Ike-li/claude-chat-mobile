// tests/integration/mcp-status.test.mjs —— MCP 服务器的实时状态与处置（#457），对应终端 /mcp
// mcp:status 现查当前实例的 mcpServerStatus()，没有活实例时回 live:false，前端退回 init 快照；
// mcp:reconnect / mcp:toggle 把 CLI 的错误原样回给 ack。toggle 会写项目配置（与终端 /mcp 停用同效），
// 所以三条都只认指定实例（缺省当前查看的那个），显式指定但已关闭的实例不得静默落到别的会话上。
// fake-claude 的 CCM_FAKE_CLAUDE_MCP_* 开关造状态清单与重连失败，CONTROL_LOG 记下 CLI 实际收到的控制请求。
// 零 token 成本（fake-claude，不起真 claude）。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from './_spawn-server.mjs';
import { encodeProjectDir } from '../../app/src/shared/project-dir.js';

const TOKEN = 'mcp-status-test-token';
const MCP_STATUS = [
  { name: 'github', status: 'connected', scope: 'user', tools: [{ name: 'search' }], config: { type: 'stdio', command: 'gh-mcp' } },
  { name: 'postgres', status: 'failed', error: 'spawn ENOENT', scope: 'project' },
];

function createClient(port) {
  const socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: TOKEN }, transports: ['websocket'], reconnection: false });
  const events = [];
  socket.on('agent:event', e => events.push(e));
  return {
    socket,
    waitForConnect(timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (socket.connected) return resolve();
        const timer = setTimeout(() => reject(new Error('connect timeout')), timeout);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
      });
    },
    waitForEvent(type, predicate, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const matches = e => e.type === type && (!predicate || predicate(e));
        const existing = events.find(matches);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
        const handler = e => {
          if (matches(e)) { clearTimeout(timer); socket.off('agent:event', handler); resolve(e); }
        };
        socket.on('agent:event', handler);
      });
    },
    emitAck(event, payload, timeout = 15000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), timeout);
        socket.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
      });
    },
    disconnect() { socket.disconnect(); },
  };
}

test.describe('mcp:status / mcp:reconnect / mcp:toggle', () => {
  let proc, port, workdir, dataDir, controlLog, client;

  test.before(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'ccm-mcp-wd-'));
    dataDir = mkdtempSync(join(tmpdir(), 'ccm-mcp-data-'));
    controlLog = join(dataDir, 'control.log');
    const started = await spawnServer({
      AUTH_TOKEN: TOKEN,
      WORK_DIR: workdir,
      CCM_DATA_DIR: dataDir,
      CLAUDE_BIN: join(process.cwd(), 'tests/fixtures/fake-claude.sh'),
      CCM_FAKE_CLAUDE_MODE: 'init',
      CCM_FAKE_CLAUDE_MCP_STATUS: JSON.stringify(MCP_STATUS),
      CCM_FAKE_CLAUDE_MCP_RECONNECT_ERROR: 'Server postgres failed to start: spawn ENOENT',
      CCM_FAKE_CLAUDE_CONTROL_LOG: controlLog,
      IDLE_TIMEOUT_MS: '120000',
    });
    proc = started.proc;
    port = started.port;
    client = createClient(port);
    await client.waitForConnect();
    await client.waitForEvent('instances');
  });

  test.after(async () => {
    client?.disconnect();
    if (proc) { await killServer(proc); proc = null; }
    for (const d of [workdir, dataDir]) {
      if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  });

  test('还没有活实例：live:false（前端退回 init 快照），处置类请求回 no_instance', async () => {
    assert.deepEqual(await client.emitAck('mcp:status', {}), { ok: true, live: false });
    assert.deepEqual(await client.emitAck('mcp:reconnect', { name: 'postgres' }), { ok: false, error: 'no_instance' });
  });

  test('有活实例：现查 mcpServerStatus()，只回面板要的字段', async () => {
    client.socket.emit('user:message', { text: 'hello', clientMessageId: 'mcp-1' });
    await client.waitForEvent('instances', e => (e.payload?.instances?.length ?? 0) > 0, 20000);
    const res = await client.emitAck('mcp:status', {});
    assert.deepEqual(res, {
      ok: true,
      live: true,
      servers: [
        { name: 'github', status: 'connected', scope: 'user', toolCount: 1 },
        { name: 'postgres', status: 'failed', error: 'spawn ENOENT', scope: 'project' },
      ],
    });
  });

  test('重连失败：CLI 的错误原样回给手机', async () => {
    assert.deepEqual(await client.emitAck('mcp:reconnect', { name: 'postgres' }),
      { ok: false, error: 'Server postgres failed to start: spawn ENOENT' });
  });

  test('停用：参数原样到 CLI，ack ok', async () => {
    assert.deepEqual(await client.emitAck('mcp:toggle', { name: 'github', enabled: false }), { ok: true });
    const requests = readFileSync(controlLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(requests.some(r => r.subtype === 'mcp_toggle' && r.serverName === 'github' && r.enabled === false),
      `CLI 没收到停用请求：${JSON.stringify(requests.map(r => r.subtype))}`);
  });

  test('形状不对的请求不发给 CLI：invalid_payload；显式指定已关闭的实例：no_instance', async () => {
    assert.deepEqual(await client.emitAck('mcp:toggle', { name: 'github', enabled: 'no' }), { ok: false, error: 'invalid_payload' });
    assert.deepEqual(await client.emitAck('mcp:reconnect', { name: '' }), { ok: false, error: 'invalid_payload' });
    assert.deepEqual(await client.emitAck('mcp:toggle', { name: 'github', enabled: true, instanceId: 'gone-instance' }),
      { ok: false, error: 'no_instance' });
  });
});

// 终端在驾驶这个会话时（只读镜像），本进程的 SDK 子进程还活着、只是闲着：它的 MCP 状态不是终端里那份，
// 对它重连 / 启停也作用不到终端。必须按「没有活实例」处理——status 退回快照、处置拒绝、CLI 收不到请求
// （#467 review）。造只读镜像的办法与时序同 tests/invariants/server/external-dirty.test.mjs：
// 先等镜像建好基线，再往 transcript 追加一轮终端写的对话。
test.describe('终端驾驶的只读镜像：MCP 只给快照', () => {
  const SESSION_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
  const TICK_MS = 2500; // mirror-engine 的 CATCH_UP_INTERVAL_MS
  let proc, root, cwd, projectDir, transcript, controlLog, client;

  const line = (type, text, parentUuid, uuid) => `${JSON.stringify({
    type, uuid, parentUuid, timestamp: new Date().toISOString(), sessionId: SESSION_ID, cwd, isMeta: false,
    entrypoint: 'cli', message: { role: type, content: [{ type: 'text', text }] },
  })}\n`;

  test.before(async () => {
    root = mkdtempSync(join(tmpdir(), 'ccm-mcp-mirror-'));
    mkdirSync(join(root, 'ws'));
    cwd = realpathSync(join(root, 'ws'));
    // 一次性 cwd ⇒ 项目目录也是一次性的；只在容器 / CI 跑，那里的 HOME 本身就是一次性目录
    projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
    mkdirSync(projectDir, { recursive: true });
    transcript = join(projectDir, `${SESSION_ID}.jsonl`);
    controlLog = join(root, 'control.log');
    const started = await spawnServer({
      AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: join(root, 'data'),
      CCM_FAKE_CLAUDE_MODE: 'turn',
      CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
      CCM_FAKE_CLAUDE_MCP_STATUS: JSON.stringify(MCP_STATUS),
      CCM_FAKE_CLAUDE_CONTROL_LOG: controlLog,
      IDLE_TIMEOUT_MS: '120000',
    });
    proc = started.proc;
    client = createClient(started.port);
    await client.waitForConnect();
  });

  test.after(async () => {
    client?.disconnect();
    if (proc) { await killServer(proc); proc = null; }
    if (root) rmSync(root, { recursive: true, force: true });            // safe-rm: mkdtemp 一次性目录
    if (projectDir) rmSync(projectDir, { recursive: true, force: true }); // safe-rm: 目录名由本用例一次性 cwd 编码而来
  });

  test('终端一接手：status 回 live:false，重连 / 启停回 no_instance，CLI 收不到处置请求', async () => {
    const seedUser = randomUUID(), seedAssistant = randomUUID();
    writeFileSync(transcript, line('user', '终端里先说的', null, seedUser) + line('assistant', '终端里的回答', seedUser, seedAssistant));
    const sent = await client.emitAck('user:message', { text: 'web 第一条', cwd, clientMessageId: 'mcp-mirror-1' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    // 正对照：web 自己在驾驶时现查得到
    assert.equal((await client.emitAck('mcp:status', {})).live, true);

    await new Promise(r => setTimeout(r, TICK_MS * 2 + 500)); // 基线建牢之前追加会被当成基线本身
    const extUser = randomUUID();
    appendFileSync(transcript, line('user', '终端后来又说的', seedAssistant, extUser) + line('assistant', '终端的新回答', extUser, randomUUID()));
    await client.waitForEvent('mirror_state', e => e.payload?.readonly === true, TICK_MS * 4);

    assert.deepEqual(await client.emitAck('mcp:status', {}), { ok: true, live: false });
    assert.deepEqual(await client.emitAck('mcp:reconnect', { name: 'postgres' }), { ok: false, error: 'no_instance' });
    assert.deepEqual(await client.emitAck('mcp:toggle', { name: 'github', enabled: false }), { ok: false, error: 'no_instance' });
    const requests = existsSync(controlLog) ? readFileSync(controlLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    assert.deepEqual(requests.filter(r => r.subtype === 'mcp_reconnect' || r.subtype === 'mcp_toggle'), []);
  });
});
