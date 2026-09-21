// tests/integration/rewind-guards.test.mjs —— Rewind 的拒绝档在【真 server】上的行为（零 token）
//
// 与 rewind.test.mjs 的分工：那份用真 agent turn 验成功支（文件真还原、真分叉），慢且烧 token；
// 这份只验拒绝档，不需要任何 turn——所以它默认就跑，不挂 RUN_CLAUDE_INTEGRATION。
//
// 【怎么做到零 token 还能走到 handler 深处】两件事：
//  ① CLAUDE_BIN 指向 tests/fixtures/fake-claude.sh。它的既定语义是「永不产出、实例恒 busy」
//     （见该文件头注：8 个 S2 文件与 21 个集成测试都建在这个前提上），发一条消息即可让
//     inst.isBusy() 为真——这正是 G1 要拦的状态，不必真跑一轮。
//  ② 会话文件手工造。planRewind 读的是 transcript 原始 jsonl，形态取自真实样本
//     （同轮共享 promptId、assistant 行无 promptId），所以可以精确摆出「第一轮」「不存在的 uuid」
//     这些边界，而真 turn 反而难以稳定复现它们。
//
// 【隔离】workDir 走 mkdtemp；会话文件必须落在真实 ~/.claude/projects/<编码 cwd>/——
// getProjectDir 认的是真实 HOME，无法注入。目录名由一次性 workDir 编码而来，天然不会撞到
// 用户自己的项目；after 钩子按文件精确删，再用 rmdir 收尾（只删空目录，非空即留）。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, rmdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from './_spawn-server.mjs';
import { getProjectDir } from '../../app/src/sessions/history.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'ccm-rewind-guards-token';
const SESSION_ID = 'rewind-guards-fixture';

let serverProc, port, workDir, dataDir, projDir, socket;

// 两轮对话的最小 transcript。形态照真实样本：人类 prompt 带 promptId + promptSource，
// 同轮后续条目共享 promptId，assistant 行【没有】promptId 字段。
const FIXTURE_ENTRIES = [
  { type: 'user', uuid: 'u-1', promptId: 'p-1', promptSource: 'sdk', message: { role: 'user', content: '第一轮' } },
  { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } },
  { type: 'user', uuid: 'u-2', promptId: 'p-2', promptSource: 'sdk', message: { role: 'user', content: '第二轮：改个文件' } },
  { type: 'assistant', uuid: 'a-2', message: { role: 'assistant', content: [{ type: 'text', text: '改好了' }] } },
];

function emit(evt, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${evt} ack 超时`)), 20_000);
    socket.emit(evt, payload, (res) => { clearTimeout(timer); resolve(res); });
  });
}

test.describe('Rewind 拒绝档（真 server，零 token）', () => {
  test.before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'ccm-rwguard-work-'));
    dataDir = mkdtempSync(join(tmpdir(), 'ccm-rwguard-data-'));
    projDir = join(homedir(), '.claude', 'projects', getProjectDir(workDir));
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${SESSION_ID}.jsonl`),
      FIXTURE_ENTRIES.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const started = await spawnServer({
      AUTH_TOKEN: TOKEN, WORK_DIRS: workDir, CCM_DATA_DIR: dataDir,
      CLAUDE_BIN: join(HERE, '..', 'fixtures', 'fake-claude.sh'),
    });
    serverProc = started.proc; port = started.port;
    socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: TOKEN }, transports: ['websocket'], reconnection: false,
    });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('connect 超时')), 10_000);
    });
  });

  test.after(async () => {
    socket?.disconnect();
    if (serverProc) await killServer(serverProc);
    for (const d of [workDir, dataDir]) if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 已清理 */ } }
    if (projDir) {
      // safe-path: 文件名是本文件写死的夹具常量，目录由一次性 workDir 编码而来；单文件删除，不递归。
      try { const f = join(projDir, `${SESSION_ID}.jsonl`); if (existsSync(f)) rmSync(f, { force: true }); } catch { /* 尽力 */ }
      // rmdir 收尾：只删空目录，非空直接失败——挡住"顺手递归删掉别人东西"。
      try { rmdirSync(join(projDir, 'memory')); } catch { /* 不存在或非空 */ }
      try { rmdirSync(projDir); } catch { /* 非空说明有别的会话，留着 */ }
    }
  });

  // 【2026-09-21 反转（PR #102 review）】原断言是「第一轮 → ok:false + reason:first-turn」。
  // planRewind 判的是【对话轴】：首轮之前没有可保留的锚点，分叉会退化成复制一个空会话。
  // 但「只恢复代码」根本不 fork，那一轮的文件快照照样能还原——在 preview 里整体拒绝，等于让
  // 单轮会话完全用不了 Restore code，而终端能。现在放行并单独回 canForkConversation:false，
  // 由前端只禁掉需要 fork 的那两个模式。其余 reason（见下一条 prompt-not-found）仍照旧拒绝。
  test('会话第一轮 → 放行但标明不能分叉对话（对话轴受限，文件轴不受影响）', async () => {
    const res = await emit('session:rewind:preview', { cwd: workDir, sessionId: SESSION_ID, promptUuid: 'u-1' });
    assert.equal(res.ok, true, '整体拒绝会让单轮会话用不了「只恢复代码」，而终端能');
    assert.equal(res.canForkConversation, false, '首轮之前没有可保留的锚点，分叉仍然不可用');
    assert.equal(res.keepUuid, null, '没有锚点就不该编一个出来');
  });

  test('不存在的 uuid → prompt-not-found 拒绝', async () => {
    const res = await emit('session:rewind:preview', { cwd: workDir, sessionId: SESSION_ID, promptUuid: 'no-such-uuid' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'prompt-not-found');
  });

  test('缺锚点 / 会话不存在 → 参数校验挡在最前', async () => {
    assert.equal((await emit('session:rewind:preview', { cwd: workDir, sessionId: SESSION_ID })).ok, false);
    assert.equal((await emit('session:rewind:preview', { cwd: workDir, sessionId: 'nope', promptUuid: 'u-2' })).ok, false);
  });

  test('G1：本实例正在跑回合时拒绝，且 confirm 与 preview 一致', async () => {
    // fake-claude 永不产出 result，所以这条消息发出去之后实例恒 busy——正是 G1 要拦的状态。
    // 【为什么放在最后一个用例】它会把实例永久钉在 busy 上，之后任何走 G1 的请求都会被拒，
    // 前面那些拒绝档就再也测不到自己那一档了。
    // 【必须先切到夹具会话】user:message 不带 sessionId 时，server 懒创建的是一个【新】会话的
    // 实例，夹具会话的实例根本没忙，G1 自然不触发（第一版就是这么写的，轮询 40 次全落空）。
    const sw = await emit('session:switch', { cwd: workDir, sessionId: SESSION_ID });
    assert.equal(sw.ok, true, `切到夹具会话失败：${sw.error}`);
    socket.emit('user:message', { text: '让实例进入在途轮' });
    // 等实例真的忙起来：轮询 preview 直到它改口说"正在执行中"，避免固定 sleep（那是缺陷窗口的负片）。
    // 【探针必须用 u-1】它是会话第一轮，未 busy 时 planRewind 立刻返回 first-turn——快、且不碰
    // rewindFiles。换成 u-2 的话，未 busy 那几次会一路走到 rewindFiles，而 fake-claude 永不响应，
    // 探针自己先挂满 20s 超时（第一版就是这么写的，两条用例一起超时）。
    let res = null;
    for (let i = 0; i < 40; i++) {
      res = await emit('session:rewind:preview', { cwd: workDir, sessionId: SESSION_ID, promptUuid: 'u-1' });
      if (res.ok === false && /正在执行中/.test(res.error || '')) break;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.equal(res.ok, false, '实例在跑回合时回退必发写锁抢占——模型随时可能正在写同一批文件');
    assert.match(res.error, /正在执行中/, `实际拒绝理由：${res.error}`);

    const confirmRes = await emit('session:rewind:confirm', { cwd: workDir, sessionId: SESSION_ID, promptUuid: 'u-1' });
    assert.equal(confirmRes.ok, false, 'confirm 与 preview 必须同档拒绝——只挡预览等于没挡');
    assert.match(confirmRes.error, /正在执行中/);
  });
});
