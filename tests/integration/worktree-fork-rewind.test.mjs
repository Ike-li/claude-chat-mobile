// tests/integration/worktree-fork-rewind.test.mjs —— 托管 worktree 会话的分叉与 /rewind：真 server 按哪根 cwd 轴找 transcript
//
// 测什么：
//  ① 契约：session:fork 与 session:rewind:candidates 只在传入 cwd 编码出来的那一个 project 目录里找 transcript。
//     托管 worktree 会话的 transcript 在驾驶轴（worktree）下：送驾驶轴分得出新会话、列得出候选；送工作区轴（父仓）
//     回「会话不存在」。前端该送哪根轴由 E2E 守（worktree-history-axis.spec.ts 的 P0-WT-FORK / P0-WT-REWIND），
//     那边打的是零 import app/src 的平行 mock，它对两根轴的判法以这里为准。
//  ② worktree 目录已删：分叉与 /rewind 三步都说清是哪一棵没了，不把那条悬空路径记成越界——scope_violation 在服务面板
//     「安全日志」里是一行红色「越界访问被拒」，而用户只是点了「分叉」。
// 不测什么 + 为什么：
//  ① planFork / listRewindCandidates 的判据 —— S1（tests/unit/rewind-plan.test.mjs）
//  ② rewind preview / confirm 的成功支 —— 要 CLI 真落文件快照，fake-claude 给不了，归 rewind.test.mjs（真 turn）
//  ③ 分叉出来的会话能不能接着聊 —— 要真模型，归 S5
// 槽位：S2（真 app/server.js 子进程 + 一次性工作目录 / CCM_DATA_DIR；CLAUDE_BIN 走 stub，无真 turn）
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from './_spawn-server.mjs';
import { encodeProjectDir } from '../../app/src/shared/project-dir.js';

const TOKEN = 'int-worktree-fork-token';
const SID = randomUUID();
const U1 = randomUUID();
const A1 = randomUUID();
// 四个 handler 都先按 payload.cwd 找会话；多带的字段各取所需（fork 要 uuid，preview/confirm 要 promptUuid）
const EVENTS = ['session:fork', 'session:rewind:candidates', 'session:rewind:preview', 'session:rewind:confirm'];

let server, root, repo, wt, projectDir, sock;

const emitAck = (event, payload) => new Promise((resolve, reject) => {
  // fork 的成功支要 forkSession 写盘 + spawn 新实例，比一般 ack 慢得多
  const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时：${JSON.stringify(payload)}`)), 15000);
  sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
});

test.before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-int-wt-fork-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  // 真 git worktree：工作区轴要从仓库一侧双向回验才归到父仓（SCOPE-04）。手写一个目录会被当成独立项目，
  // 两根轴在夹具里就重合了，「送了父仓」与「送了 worktree」测出来没有区别。
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-m', 'init');
  git('worktree', 'add', '-b', 'wt-fork', join(repo, '.claude', 'worktrees', 'wt-fork'));
  wt = realpathSync(join(repo, '.claude', 'worktrees', 'wt-fork'));

  // transcript 落在驾驶轴编码出来的 project 目录里（CLI 就是这么落的）。一次性 cwd ⇒ 这个目录也是一次性的；
  // 本文件只在容器 / CI 跑（执行位守卫），那里的 HOME 本身就是一次性目录。
  projectDir = join(homedir(), '.claude', 'projects', encodeProjectDir(wt));
  mkdirSync(projectDir, { recursive: true });
  const row = fields => JSON.stringify({ isSidechain: false, userType: 'external', cwd: wt, sessionId: SID, timestamp: new Date().toISOString(), ...fields });
  writeFileSync(join(projectDir, `${SID}.jsonl`), [
    row({ type: 'user', uuid: U1, parentUuid: null, message: { role: 'user', content: '在 worktree 里问的' } }),
    row({ type: 'assistant', uuid: A1, parentUuid: U1, message: { role: 'assistant', content: [{ type: 'text', text: '在 worktree 里答的' }] } }),
  ].join('\n') + '\n');

  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: repo, CCM_DATA_DIR: dataDir });
  sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'int-worktree-fork-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' }, // 本机直连：bypass 设备门，本文件只测 cwd 轴
  });
  await new Promise((resolve, reject) => {
    sock.on('connect', resolve);
    sock.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
  });
});

test.after(async () => {
  try { sock?.close(); } catch { /* 已关闭 */ }
  if (server) await killServer(server.proc);
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  if (projectDir) rmSync(projectDir, { recursive: true, force: true }); // safe-rm: 目录名由本文件 mkdtemp 下的 worktree 路径编码而来
});

test('分叉：送驾驶轴（worktree）分出新会话、新 transcript 落在同一棵 worktree；送工作区轴（父仓）回「会话不存在」', async () => {
  const viaWorkspace = await emitAck('session:fork', { cwd: repo, sessionId: SID, uuid: A1, keepAnchorTurn: true });
  assert.deepEqual(viaWorkspace, { ok: false, error: '会话不存在' },
    '父仓的 project 目录里没有这份 transcript——这一侧要是能成，前端送哪根轴就无所谓，E2E mock 的判法也就错了');

  const viaDriving = await emitAck('session:fork', { cwd: wt, sessionId: SID, uuid: A1, keepAnchorTurn: true });
  assert.equal(viaDriving?.ok, true, `送驾驶轴必须分得出来，否则前端改了也没用：${JSON.stringify(viaDriving)}`);
  assert.ok(viaDriving.sessionId && viaDriving.sessionId !== SID, `ack 要带新会话的 id：${JSON.stringify(viaDriving)}`);
  assert.ok(existsSync(join(projectDir, `${viaDriving.sessionId}.jsonl`)),
    '新会话的 transcript 要和原会话落在同一棵 worktree 的 project 目录——之后的 resume、历史都按驾驶轴找它');
});

test('/rewind 第一步：送驾驶轴列得出候选，送工作区轴回「会话不存在」', async () => {
  const viaWorkspace = await emitAck('session:rewind:candidates', { cwd: repo, sessionId: SID });
  assert.deepEqual(viaWorkspace, { ok: false, error: '会话不存在' }, '同上一条：父仓那边没有这份 transcript');

  const viaDriving = await emitAck('session:rewind:candidates', { cwd: wt, sessionId: SID });
  assert.equal(viaDriving?.ok, true, `送驾驶轴必须列得出来：${JSON.stringify(viaDriving)}`);
  assert.deepEqual(viaDriving.items.map(i => i.promptUuid), [U1], '候选就是这个会话里那一轮人类 prompt');
});

test('worktree 目录已删：分叉与 /rewind 三步都说清是哪一棵没了，不记成越界', async () => {
  // 从没建过与建了又删在这里是同一形态：判据只看「托管 worktree 形态的路径还在不在」（resolveGoneWorktreeParent）
  const gone = join(repo, '.claude', 'worktrees', 'gone-tree');
  // 正对照：真越界的路径确实会记一条 scope_violation。没有这一格，下面「没记」和「audit:get 看不见」无法区分。
  const outside = join(root, 'not-connected');
  mkdirSync(outside);
  const denied = await emitAck('session:fork', { cwd: outside, sessionId: SID, uuid: A1, keepAnchorTurn: true });
  assert.equal(denied?.ok, false);
  let { records } = await emitAck('audit:get', { limit: 200 });
  assert.ok(records.some(r => r.action === 'scope_violation' && r.target === outside),
    `仪器失明：真越界也没在 audit:get 里看到记录：${JSON.stringify(records)}`);

  for (const event of EVENTS) {
    const ack = await emitAck(event, { cwd: gone, sessionId: SID, uuid: A1, keepAnchorTurn: true, promptUuid: U1, mode: 'conversation' });
    assert.equal(ack?.ok, false, `${event}：那棵树已经没了，分叉 / 回退都无处落地`);
    assert.match(ack.error, /已被删除/, `${event}：得说是 worktree 没了，而不是「不在已连接的文件夹里」：${ack.error}`);
    assert.match(ack.error, /gone-tree/, `${event}：得说出是哪一棵，否则多 worktree 的会话无从对应：${ack.error}`);
  }
  ({ records } = await emitAck('audit:get', { limit: 200 }));
  assert.deepEqual(records.filter(r => r.action === 'scope_violation' && r.target === gone), [],
    '树被删不是越界：记下来就是服务面板里一条红色「越界访问被拒」');
});

// 正对照：同样的路径形态、目录真在时必须走回原来那条归属校验——否则上面那条用「凡是 worktree 路径都报已删」
// 也能过，而那会让所有活着的 worktree 会话的分叉与回退集体失效。
test('worktree 目录还在：照旧走归属校验，不误报已删', async () => {
  for (const event of EVENTS) {
    const ack = await emitAck(event, { cwd: wt, sessionId: randomUUID(), uuid: A1, keepAnchorTurn: true, promptUuid: U1, mode: 'conversation' });
    assert.deepEqual(ack, { ok: false, error: '会话不存在' }, `${event}：会话 id 是新造的，该被归属校验拒掉，而不是报已删`);
  }
});
