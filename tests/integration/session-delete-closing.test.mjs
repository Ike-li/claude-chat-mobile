// tests/integration/session-delete-closing.test.mjs —— 关掉会话后紧接着彻底删除：删除要等 CLI 退完
//
// 【缺陷形态】session:close 同步 dispose 实例、立刻回 ack，CLI 子进程却是之后才退的：SDK 先关 stdin，
// CLI 读到 EOF 后往 transcript 追加几行收尾元数据再退（2026-09-23 实测 CLI 2.1.280：EOF 后 70–80ms
// 写 last-prompt / cost-state 等，进程 0.6–2s 才退）。deletePermanent 落在这段窗口里时，文件删掉之后
// 又被 CLI 重新建出来，成了只有元数据的孤儿会话——而 ack 已经报了 ok。
//
// 测什么：close 之后紧跟 deletePermanent 且 ack 报 ok ⇒ CLI 的收尾写入发生过之后，文件仍然不存在。
// 不测什么 + 为什么：
//   ① 真 CLI 写哪几行、隔多久写 —— 上游行为。假 CLI 只模拟「读到 EOF 后、退出前写一行」这个形态
//      （见 tests/fixtures/fake-claude.mjs 头注），真机对照记在引入本文件的 commit 里。
//   ② CLI 迟迟不退时等待的上限 —— 由 tests/unit/instance-manager.test.mjs 用假时钟覆盖；
//      本层要造它得让假 CLI 挂过 SDK 的强杀，白等十几秒。
//   ③ 默认 5 分钟静默期下的结局 —— 本文件把静默期设成 0，只看「删除与 CLI 收尾写入谁先谁后」这一条轴。
// 槽位：集成（真 app/server.js 子进程 + 可驱动假 CLI，零 token）。只在容器 / CI 跑，
// 那里的 HOME 是一次性目录；transcript 落点用一次性 cwd 编码，撞不上别的会话。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from './_spawn-server.mjs';
import { encodeProjectDir } from '../../app/src/shared/project-dir.js';

const TOKEN = 'session-delete-closing-token';
const SESSION_ID = '44444444-5555-4666-8777-888888888888';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(pred, ms, what) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`${ms}ms 内没等到：${what}`);
    await sleep(50);
  }
}

test('关掉会话后紧接着彻底删除：ack 报 ok，CLI 的收尾写入也不得把 transcript 写回来', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccm-delete-closing-'));
  const ws = join(root, 'ws');
  mkdirSync(ws);
  const cwd = realpathSync(ws);
  const projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${SESSION_ID}.jsonl`);
  const exitMarker = join(root, 'fake-cli-exit-written');

  const server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: root,
    SESSION_DELETE_QUIET_MS: '0',
    CCM_FAKE_CLAUDE_MODE: 'turn',                 // 回合会收尾 → 实例空闲，正是用户会去关 tab 的状态
    CCM_FAKE_CLAUDE_SESSION_ID: SESSION_ID,
    CCM_FAKE_CLAUDE_EXIT_APPEND: transcript,
    CCM_FAKE_CLAUDE_EXIT_MARKER: exitMarker,
  });

  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'delete-closing-device' },
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
      const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 15000);
      sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
    });

    const sent = await emitAck('user:message', { text: '随便说一句', cwd, clientMessageId: 'dc-1' });
    assert.equal(sent.ok, true, `首发应被接受，实际 ${JSON.stringify(sent)}`);
    await waitFor(() => events.some(e => e.type === 'result' && e.instanceId === sent.instanceId), 10000, '回合收尾（result）');
    // 假 CLI 不落 transcript：补一份，deletePermanent 才认这个会话存在。
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId: SESSION_ID, message: { role: 'user', content: '随便说一句' } })}\n`);

    const closed = await emitAck('session:close', { instanceId: sent.instanceId });
    assert.equal(closed.ok, true, `关闭应成功，实际 ${JSON.stringify(closed)}`);
    const deleted = await emitAck('session:deletePermanent', { sessionId: SESSION_ID, cwd });
    assert.equal(deleted.ok, true, `静默期为 0、实例已关，删除应成功，实际 ${JSON.stringify(deleted)}`);

    // 正对照：先确认 CLI 的收尾写入真的发生过，再看文件——否则「文件不在」和「根本没写」分不开。
    await waitFor(() => existsSync(exitMarker), 5000, '假 CLI 的收尾写入');
    assert.equal(
      existsSync(transcript), false,
      '删除报了 ok，文件却被正在退出的 CLI 写了回来——会话列表里会冒出一个只有收尾元数据的孤儿',
    );
  } finally {
    try { sock.close(); } catch { /* 已关闭 */ }
    await killServer(server.proc);
    rmSync(root, { recursive: true, force: true });      // safe-rm: mkdtemp 一次性目录
    rmSync(projectDir, { recursive: true, force: true }); // safe-rm: 目录名由本用例一次性 cwd 编码而来
  }
});
