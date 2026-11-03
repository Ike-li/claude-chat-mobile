// tests/integration/session-rename.test.mjs —— 网页端给会话改名（#458）
//
// 测什么：
//   ① session:rename 的校验口径与 deletePermanent 一致：越界 cwd、非法 id、不存在的会话、空标题都拒绝；
//   ② 改名走 SDK renameSession：transcript 尾多一条清洗过的 custom-title，session:list 立刻显示新名字，审计留痕；
//   ③ 没有本产品的活实例、transcript 又刚被写过 → 仍然改，但回执带 terminalMayOverwrite（终端可能还开着它）；
//   ④ 活会话防回退：CLI 退出收尾把内存里的旧标题写回来之后，服务端补写一次，最后一条是用户的新名字。
// 不测什么：真 CLI 收尾写哪几行——上游行为，假 CLI 用 CCM_FAKE_CLAUDE_EXIT_TITLE 模拟「退出前回写旧标题」
// 这个形态（见 tests/fixtures/fake-claude.mjs 头注）；真机验证列在 PR 的待实测里。
// 槽位：集成（真 app/server.js 子进程 + 可驱动假 CLI，零 token）。只在容器 / CI 跑，
// 那里的 HOME 是一次性目录；transcript 落点用一次性 cwd 编码，撞不上别的会话。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from './_spawn-server.mjs';
import { encodeProjectDir } from '../../app/src/shared/project-dir.js';

const TOKEN = 'session-rename-token';
const LIVE_ID = '55555555-6666-4777-8888-999999999999';
const QUIET_ID = '11111111-2222-4333-8444-555555555555';
const FRESH_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

let root, cwd, projectDir, exitMarker, server, sock;
const events = [];

function transcriptOf(sessionId) {
  return join(projectDir, `${sessionId}.jsonl`);
}

function writeTranscript(sessionId, entries, { quiet }) {
  const file = transcriptOf(sessionId);
  writeFileSync(file, entries.map(e => JSON.stringify({ sessionId, ...e })).join('\n') + '\n');
  if (quiet) {
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(file, old, old);
  }
  return file;
}

function customTitles(sessionId) {
  return readFileSync(transcriptOf(sessionId), 'utf-8').trim().split('\n')
    .map(line => JSON.parse(line))
    .filter(e => e.type === 'custom-title')
    .map(e => e.customTitle);
}

function emitAck(event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), 15000);
    sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
  });
}

test.describe('网页端改名', () => {
  test.before(async () => {
    root = mkdtempSync(join(tmpdir(), 'ccm-session-rename-'));
    const ws = join(root, 'ws');
    mkdirSync(ws);
    cwd = realpathSync(ws);
    projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
    mkdirSync(projectDir, { recursive: true });
    exitMarker = join(root, 'fake-cli-exit-written');
    server = await spawnServer({
      AUTH_TOKEN: TOKEN, WORK_DIRS: cwd, CCM_DATA_DIR: join(root, 'data'),
      SESSION_DELETE_QUIET_MS: '60000', // 「终端可能在用」沿用删除的静默期判据
      CCM_FAKE_CLAUDE_MODE: 'turn',
      CCM_FAKE_CLAUDE_SESSION_ID: LIVE_ID,
      CCM_FAKE_CLAUDE_EXIT_APPEND: transcriptOf(LIVE_ID),
      CCM_FAKE_CLAUDE_EXIT_TITLE: '旧名字',
      CCM_FAKE_CLAUDE_EXIT_MARKER: exitMarker,
    });
    sock = ioClient(`http://127.0.0.1:${server.port}`, {
      auth: { token: TOKEN, deviceToken: 'session-rename-device' },
      transports: ['websocket'], reconnection: false, timeout: 4000,
      extraHeaders: { Host: 'localhost' },
    });
    sock.on('agent:event', e => events.push(e));
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
    });
  });

  test.after(async () => {
    try { sock?.close(); } catch { /* 已关闭 */ }
    await killServer(server?.proc);
    if (root) rmSync(root, { recursive: true, force: true });            // safe-rm: mkdtemp 一次性目录
    if (projectDir) rmSync(projectDir, { recursive: true, force: true }); // safe-rm: 目录名由本用例一次性 cwd 编码而来
  });

  test('越界 cwd、非法 id、不存在的会话、空标题都拒绝，且不写盘', async () => {
    writeTranscript(QUIET_ID, [{ type: 'user', message: { role: 'user', content: '原始问题' } }], { quiet: true });
    const before = readFileSync(transcriptOf(QUIET_ID), 'utf-8');

    const outside = await emitAck('session:rename', { sessionId: QUIET_ID, cwd: '/definitely/not/connected', title: '新' });
    assert.equal(outside.ok, false);
    assert.equal(outside.error, '这个目录不在已连接的文件夹里');

    for (const sessionId of ['../../etc/passwd', 42, null]) {
      const res = await emitAck('session:rename', { sessionId, cwd, title: '新' });
      assert.equal(res.ok, false, `非法 id ${JSON.stringify(sessionId)} 应拒绝`);
      assert.equal(res.error, '会话不存在');
    }
    const missing = await emitAck('session:rename', { sessionId: '99999999-9999-4999-8999-999999999999', cwd, title: '新' });
    assert.deepEqual(missing, { ok: false, error: '会话不存在' });

    for (const title of ['', '   ', '\n\t', null, 7]) {
      const res = await emitAck('session:rename', { sessionId: QUIET_ID, cwd, title });
      assert.equal(res.ok, false, `标题 ${JSON.stringify(title)} 应拒绝`);
      assert.equal(res.error, '标题不能为空');
    }
    assert.equal(readFileSync(transcriptOf(QUIET_ID), 'utf-8'), before, '被拒的请求不得往 transcript 写任何东西');
  });

  test('改名：追加清洗过的 custom-title，列表立刻显示新名字，审计留痕', async () => {
    writeTranscript(QUIET_ID, [
      { type: 'user', message: { role: 'user', content: '原始问题' } },
      { type: 'ai-title', aiTitle: 'AI 起的名字' },
    ], { quiet: true });

    const res = await emitAck('session:rename', { sessionId: QUIET_ID, cwd, title: '  修登录页\n第二步  ' });
    assert.deepEqual(res, { ok: true, title: '修登录页 第二步' }, '静默的会话不该带终端提示');
    assert.deepEqual(customTitles(QUIET_ID), ['修登录页 第二步']);

    const list = await emitAck('session:list', { cwd });
    assert.equal(list.sessions.find(s => s.id === QUIET_ID)?.title, '修登录页 第二步');

    const audit = await emitAck('audit:get', { limit: 20 });
    const rec = audit.records.find(r => r.action === 'session_rename' && r.target === QUIET_ID);
    assert.equal(rec?.outcome, 'success');
  });

  test('没有本产品的活实例、transcript 刚被写过：照样改名，回执提示终端可能会盖回去', async () => {
    writeTranscript(FRESH_ID, [{ type: 'user', message: { role: 'user', content: '终端里的会话' } }], { quiet: false });
    const res = await emitAck('session:rename', { sessionId: FRESH_ID, cwd, title: '新名字' });
    assert.deepEqual(res, { ok: true, title: '新名字', terminalMayOverwrite: true });
    assert.deepEqual(customTitles(FRESH_ID), ['新名字']);
  });

  test('活会话：CLI 退出时把旧名写回来之后，服务端补写，最后一条是用户的新名字', async () => {
    const sent = await emitAck('user:message', { text: '随便说一句', cwd, clientMessageId: 'rn-1' });
    assert.equal(sent.ok, true, `首发应被接受，实际 ${JSON.stringify(sent)}`);
    await waitForCondition(() => events.some(e => e.type === 'result' && e.instanceId === sent.instanceId),
      { timeoutMs: 10000, label: '回合收尾（result）' });
    // 假 CLI 不落 transcript：补一份「之前在终端里 /rename 过」的会话，这正是 CLI 内存里带着旧标题的形态。
    writeTranscript(LIVE_ID, [
      { type: 'user', message: { role: 'user', content: '随便说一句' } },
      { type: 'custom-title', customTitle: '旧名字' },
    ], { quiet: false });

    const res = await emitAck('session:rename', { sessionId: LIVE_ID, cwd, title: '新名字' });
    assert.deepEqual(res, { ok: true, title: '新名字' }, '本产品自己在驱动的会话不该提示终端会盖回去');
    await waitForCondition(() => events.some(e => e.type === 'instances'
      && e.payload?.instances?.some(i => i.sessionId === LIVE_ID && i.title === '新名字')),
    { timeoutMs: 5000, label: '实例广播带上新名字（运行中那一行、别的设备）' });

    const closed = await emitAck('session:close', { instanceId: sent.instanceId });
    assert.equal(closed.ok, true, `关闭应成功，实际 ${JSON.stringify(closed)}`);
    // 正对照：先确认假 CLI 真的把旧名写回来过，否则「最后是新名字」和「根本没回写」分不开。
    await waitForCondition(() => existsSync(exitMarker), { timeoutMs: 5000, label: '假 CLI 的收尾写入' });
    await waitForCondition(() => customTitles(LIVE_ID).at(-1) === '新名字', {
      timeoutMs: 5000,
      label: `退出补写（当前 custom-title 序列：${JSON.stringify(customTitles(LIVE_ID))}）`,
    });
    assert.deepEqual(customTitles(LIVE_ID), ['旧名字', '新名字', '旧名字', '新名字']);
  });
});
