// tests/integration/session-writes-lost.test.mjs —— 磁盘写丢的提示要真的到手机上
//
// 【缺陷形态】session_writes_lost 只在 CLI 退出时发一次（真 CLI 2.1.318：读到 stdin EOF 后、进程退出前）。
// 这时实例已经在收尾：关标签是先 dispose 再 abort，事件即便发出去，带的 instanceId 前端也会丢。
// 而「恢复可能缺内容」要在接着用这个会话时才有用，所以 server 按会话暂存，下次发消息成功后补发。
//
// 测什么：关掉会话、重新打开、发一条消息 ⇒ 新实例上收到一条 warning notice；再发一条不重复。
// 不测什么 + 为什么：真 CLI 什么时候判定写丢是上游行为，假 CLI 只模拟「EOF 后发这一帧」。
//   补发时机为什么在发送之后、不在创建实例时，看 app.js 发送路径上那段注释。
// 槽位：集成（真 app/server.js 子进程 + 可驱动假 CLI，零 token）。只在容器 / CI 跑。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from './_spawn-server.mjs';
import { encodeProjectDir } from '../../app/src/shared/project-dir.js';

const TOKEN = 'session-writes-lost-token';
const SESSION_ID = '55555555-6666-4777-8888-999999999999';

test('CLI 退出时报的写丢：实例关掉后，下次在这个会话发消息时提示一次', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-writes-lost-'));
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cwd = realpathSync(ws);
  const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${SESSION_ID}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({
    type: 'user', uuid: 'u-1', parentUuid: null, sessionId: SESSION_ID, cwd,
    timestamp: new Date().toISOString(), message: { role: 'user', content: '第一轮' },
  })}\n`);

  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: root,
    CCM_FAKE_CLAUDE_MODE: 'turn',
    CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
    CCM_FAKE_CLAUDE_EXIT_WRITES_LOST: 'ENOSPC',
  });
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'writes-lost-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  sock.on('agent:event', e => events.push(e));
  const call = (event, payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack 超时`)), 15000);
    sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
  });
  const results = () => events.filter(e => e.type === 'result').length;
  const notices = () => events.filter(e => e.type === 'system' && e.payload?.kind === 'notice' && e.payload.message.includes('磁盘已满'));

  try {
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('connect_error', reject);
    });
    const first = await call('user:message', { text: '第一轮', cwd, clientMessageId: 'wl-1' });
    assert.equal(first.ok, true, `前提：发得出去，实际 ${JSON.stringify(first)}`);
    await waitForCondition(() => results() >= 1, { timeoutMs: 10_000, label: '第一轮收尾' });

    const closed = await call('session:close', { instanceId: first.instanceId });
    assert.equal(closed.ok, true);
    const reopened = await call('session:switch', { sessionId: SESSION_ID, cwd }); // resume 前等旧 CLI 退完
    assert.equal(reopened.ok, true, `前提：能重新打开，实际 ${JSON.stringify(reopened)}`);
    assert.notEqual(reopened.instanceId, first.instanceId, '前提：换了新实例');
    assert.equal(notices().length, 0, '打开时不发：进了环形缓冲会让无 DOM 缓存的入场走 reload，提示被整批丢掉');

    const second = await call('user:message', { text: '第二轮', cwd, instanceId: reopened.instanceId, clientMessageId: 'wl-2' });
    assert.equal(second.ok, true, `前提：发得出去，实际 ${JSON.stringify(second)}`);
    await waitForCondition(() => notices().length > 0, { timeoutMs: 5_000, label: '写丢提示' });
    const [notice] = notices();
    assert.equal(notice.instanceId, reopened.instanceId, '要落在用户正看着的新实例上，旧实例的事件前端直接丢');
    assert.equal(notice.payload.level, 'warning');
    assert.ok(notice.payload.message.includes('恢复这个会话时可能缺内容'), notice.payload.message);

    await waitForCondition(() => results() >= 2, { timeoutMs: 10_000, label: '第二轮收尾' });
    const third = await call('user:message', { text: '第三轮', cwd, instanceId: reopened.instanceId, clientMessageId: 'wl-3' });
    assert.equal(third.ok, true);
    await waitForCondition(() => results() >= 3, { timeoutMs: 10_000, label: '第三轮收尾' });
    assert.equal(notices().length, 1, '只提示一次，否则每发一条都弹');
  } finally {
    sock.close();
    await killServer(server.proc);
    rmSync(transcript, { force: true });
    rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});
