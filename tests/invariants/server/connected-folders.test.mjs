// tests/invariants/server/connected-folders.test.mjs —— 「已连接的文件夹」在真 server 各闸门上的接线
// 守护：SCOPE-05（已连接文件夹的子目录经 realpath 后即合法 cwd，各 handler 不得回落成连接根）
//       SCOPE-04（worktree 身份只决定归属、不授权：仓库外的平级 worktree 要显式连接；伪造的不认）
// 测什么：真 app/server.js 子进程上，routeCwd / ensureAuthorized / 文件范围根这几道成对闸门确实都换成了
//   同一个授权判据：子目录与仓库里的 worktree 的会话列得出、打得开；只连了仓库时，仓库外的平级 worktree
//   列不出、打不开、浏览不了；伪造的 worktree 列不出它的会话。
//   以及「worktree 跟随所属仓库」落到抽屉那一侧：仓库里的 worktree 的会话并进仓库的列表、不自成项目，
//   它上面的实例归仓库这个项目（projectKey）；有会话的子目录自成项目。
// 不测什么 + 为什么：① 判据本身的各种边界（symlink、前缀碰撞、禁区、scratch）在 S1
//   （folder-access.test.mjs / worktree-ownership.test.mjs），这里只证明 socket 路径走了那道判据
//   ② 显式越界改为拒绝（SCOPE-05 后半）在 request-cwd-scope.test.mjs
// 槽位：S2（真 app/server.js 子进程 + 假 CLI + 一次性 CCM_DATA_DIR；transcript 写进容器里一次性 HOME 的 ~/.claude/projects）
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';
import { encodeProjectDir } from '../../../app/src/shared/project-dir.js';

const TOKEN = 'inv-connected-folders-token';
const SID = { root: randomUUID(), sub: randomUUID(), managed: randomUUID(), sibling: randomUUID(), forged: randomUUID() };

let root, repo, sub, managed, sibling, forged, server, sock;
const projectDirs = [];
const events = [];

// 只在容器 / CI 跑（test:invariants:server 不在宿主机白名单），那里的 HOME 本身就是一次性目录。
function writeTranscript(cwd, sessionId, text) {
  const dir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  projectDirs.push(dir);
  const line = JSON.stringify({
    type: 'user', uuid: randomUUID(), parentUuid: null, timestamp: new Date().toISOString(),
    sessionId, cwd, isMeta: false, message: { role: 'user', content: [{ type: 'text', text }] },
  });
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${line}\n`);
}

test.before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-connected-')));
  repo = join(root, 'code', 'repo');
  sub = join(repo, 'app');
  mkdirSync(sub, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  managed = join(repo, '.claude', 'worktrees', 'wt');        // 仓库里的 worktree（CCM 与 CLI EnterWorktree 新建的都在这里）
  git(repo, 'worktree', 'add', '-b', 'managed', managed);
  sibling = join(root, 'code', 'repo-feat');                 // 仓库外的平级 worktree（真机 1c401b5d 的形态），没有显式连接
  git(repo, 'worktree', 'add', '-b', 'feat', sibling);
  // 伪造：别的目录里写一个指向平级 worktree 管理目录的 .git——只看 worktree 侧指针就会被骗
  forged = join(root, 'code', 'forged');
  mkdirSync(forged);
  const meta = readdirSync(join(repo, '.git', 'worktrees'))
    .map(n => join(repo, '.git', 'worktrees', n))
    .find(m => realpathSync(dirname(readFileSync(join(m, 'gitdir'), 'utf8').trim())) === sibling);
  writeFileSync(join(forged, '.git'), `gitdir: ${meta}\n`);

  writeTranscript(repo, SID.root, '连接根里的会话');
  writeTranscript(sub, SID.sub, '子目录里的会话');
  writeTranscript(managed, SID.managed, '仓库里的 worktree 里的会话');
  writeTranscript(sibling, SID.sibling, '平级 worktree 里的会话');
  writeTranscript(forged, SID.forged, '伪造目录里的会话');

  server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIRS: repo, CCM_DATA_DIR: join(root, 'data') });
  sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'inv-connected-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },   // 本机直连：bypass 设备门，本文件只测范围判据
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
  if (server) await killServer(server.proc);
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  for (const d of projectDirs) rmSync(d, { recursive: true, force: true }); // safe-rm: 目录名由本文件一次性 cwd 编码而来
});

const emit = (event, payload) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时——悬挂的 ack 在手机上就是永远转圈`)), 10000);
  sock.emit(event, payload, res => { clearTimeout(timer); resolve(res); });
});
const listedIds = async cwd => ((await emit('session:list', { cwd }))?.sessions ?? []).map(s => s.id);
const latestInstances = () => events.filter(e => e.type === 'instances').pop()?.payload;
const waitFor = async (pred, what, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = pred();
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`等不到：${what}`);
};

test('子目录：列出的是子目录自己的会话，不回落成连接根的', async () => {
  const underSub = await listedIds(sub);
  assert.ok(underSub.includes(SID.sub), `子目录的会话没列出来：${JSON.stringify(underSub)}——routeCwd 仍只认连接根本身`);
  assert.ok(!underSub.includes(SID.root), '列出了连接根的会话 = routeCwd 把子目录回落成了别的目录');
  // 正对照：连接根照常列自己的
  assert.ok((await listedIds(repo)).includes(SID.root));
});

// 照官方桌面端：用户自建的平级 worktree 是普通文件夹，手机要用得显式连接（2026-10-10）。
// 每道闸门各问一次：只拦了列表的话，客户端带着 cwd 直接打开 / 浏览照样进得去。
test('仓库外的平级 worktree（只连了仓库）：列不出、打不开、浏览不了、开不了新会话', async () => {
  const ids = await listedIds(sibling);
  assert.ok(!ids.includes(SID.sibling), `范围外的平级 worktree 列出了会话：${JSON.stringify(ids)}`);
  const sw = await emit('session:switch', { sessionId: SID.sibling, cwd: sibling });
  assert.notEqual(sw?.ok, true, `打开了范围外的会话：${JSON.stringify(sw)}`);
  const br = await emit('browse:list', { cwd: sibling, relPath: '.' });
  assert.notEqual(br?.ok, true, `浏览到了范围外的目录：${JSON.stringify(br)}`);
  const nw = await emit('session:new', { cwd: sibling });
  assert.notEqual(nw?.ok, true, `在范围外的目录开了新会话页：${JSON.stringify(nw)}`);
  // 正对照：同一套闸门对仓库里的 worktree 放行（排除「闸门对所有 worktree 一律拒」也能让上面全绿）
  assert.equal((await emit('browse:list', { cwd: managed, relPath: '.' }))?.ok, true);
});

test('仓库的列表并进仓库里 worktree 的会话（行带自己的 cwd）；平级的、伪造的不并', async () => {
  const { sessions } = await emit('session:list', { cwd: repo });
  const row = sessions.find(s => s.id === SID.managed);
  assert.ok(row, `仓库列表里没有它 worktree 的会话：${JSON.stringify(sessions.map(s => s.id))}`);
  assert.equal(row.cwd, managed, '点开时要用真实 cwd，用仓库 cwd 会查到空目录（「历史消息加载失败」）');
  assert.ok(!sessions.some(s => s.id === SID.sibling), '范围外的平级 worktree 的会话被当成仓库成员并了进来');
  assert.ok(!sessions.some(s => s.id === SID.forged), '伪造目录的会话被当成仓库成员并了进来');
});

test('项目清单：连接根、有会话的子目录；平级 worktree 不自成项目；没在用的「无文件夹」不占一节', async () => {
  const payload = await waitFor(() => (latestInstances()?.projects?.some(p => p.key === sub) ? latestInstances() : null),
    '有会话的子目录出现在 instances 的项目清单里');
  assert.deepEqual(payload.projects.map(p => [p.key, p.kind, p.label]), [
    [repo, 'connected', 'repo'],
    [sub, 'subfolder', 'repo › app'],
  ]);
});

test('刚开在子目录里、transcript 还没落盘的会话：实例活着时它所在的子目录就在项目清单里', async () => {
  // 假 CLI 不写 transcript，扫盘永远认不出这个子目录——在跑的会话所属项目只能靠活实例现算
  const fresh = join(repo, 'fresh');
  mkdirSync(fresh);
  const res = await emit('user:message', { text: '在 fresh 里开', cwd: fresh, clientMessageId: 'connected-fresh-1' });
  assert.equal(res?.ok, true, `前提：子目录里能开，实际 ${JSON.stringify(res)}`);
  const payload = await waitFor(() => (latestInstances()?.instances?.some(i => i.cwd === fresh) ? latestInstances() : null), 'fresh 上的实例出现在广播里');
  assert.ok(payload.projects.some(p => p.key === fresh && p.kind === 'subfolder'),
    `在跑的会话所属子目录不在项目清单里：${JSON.stringify(payload.projects.map(p => p.key))}——前端只能把它画进「不在已连接的文件夹里」`);
});

test('伪造的 worktree：不认，列不出它的会话', async () => {
  const ids = await listedIds(forged);
  assert.ok(!ids.includes(SID.forged), '只信 worktree 侧 .git 文件就会把伪造目录当成已授权仓库的 worktree');
});

test('子目录会话：在子目录里打开（驾驶轴就是子目录）', async () => {
  const res = await emit('session:switch', { sessionId: SID.sub, cwd: sub });
  assert.equal(res?.ok, true, `打不开：${JSON.stringify(res)}——ensureAuthorized 把子目录归位到了连接根`);
  const inst = events.filter(e => e.type === 'instances').pop()?.payload?.instances?.find(i => i.instanceId === res.instanceId);
  assert.equal(inst?.cwd, sub, `实例开在了 ${inst?.cwd}——transcript 在子目录的 project 目录里，开错目录就是历史加载失败`);
  assert.equal(inst?.projectKey, sub, '子目录自成项目：在跑的这一行要挂在它下面');
});

test('仓库里的 worktree 会话：实例驾驶在 worktree 里，归仓库这个项目', async () => {
  const res = await emit('session:switch', { sessionId: SID.managed, cwd: managed });
  assert.equal(res?.ok, true, `打不开：${JSON.stringify(res)}`);
  const inst = await waitFor(() => latestInstances()?.instances?.find(i => i.instanceId === res.instanceId), '实例出现在广播里');
  assert.equal(inst.cwd, managed);
  assert.equal(inst.projectKey, repo, `projectKey=${inst.projectKey}——前端按它分组，归错了这一行就挂到一个不存在的项目下`);
});

// 选择器里挑中的是一个 worktree 目录：它归仓库这个项目，新会话页的 viewingCwd 因而是仓库，前端收到广播后
// currentCwd 也被覆写成仓库。要是广播里没有别的字段说「这一页的会话开在 worktree 里」，首条消息就开进了仓库的
// 主工作树——用户以为隔离了的改动全落在主分支上。
test('新会话页选中仓库里的 worktree：广播带 composeCwd，按它发首条消息开在 worktree 里；回到别的空页后不再带', async () => {
  assert.equal((await emit('session:new', { cwd: managed }))?.ok, true);
  const page = latestInstances();
  assert.equal(page.viewingInstanceId, null);
  assert.equal(page.viewingCwd, repo, '工作区轴仍归仓库（抽屉、顶栏按它）');
  assert.equal(page.composeCwd, managed, `广播里没有新会话页选中的 worktree：${JSON.stringify(page.composeCwd)}`);
  const res = await emit('user:message', { text: '在 worktree 的新会话里', cwd: page.composeCwd, clientMessageId: `compose-wt-${randomUUID()}` });
  assert.equal(res?.ok, true, JSON.stringify(res));
  const inst = await waitFor(() => latestInstances()?.instances?.find(i => i.instanceId === res.instanceId), '实例出现在广播里');
  assert.equal(inst.cwd, managed, `开在了 ${inst.cwd}`);
  assert.equal(latestInstances().composeCwd, undefined, '看着一个会话时不该带新会话页的目标');

  // 从这个会话回到首页：空页属于仓库本身，不能沿用上一个新会话页选的 worktree
  assert.equal((await emit('session:new', { cwd: managed }))?.ok, true);
  assert.equal((await emit('session:home', {}))?.ok, true);
  assert.equal(latestInstances().composeCwd, undefined, 'session:home 之后还带着上一个新会话页的 worktree');
  await emit('session:close', { instanceId: inst.instanceId });
});

// 空页显示的默认档位（L3 CLI settings）要按首条消息真正开在哪取：新会话页选中 worktree 时 viewingCwd 是仓库、
// 实例却按 composeCwd 开在 worktree，两边 settings 不同就显示的是一个、用的是另一个（2026-10-10 review P2）。
test('新会话页选中 worktree：空页显示的默认权限档按 worktree 自己的 settings，不按它所属的仓库', async () => {
  const settings = mode => JSON.stringify({ permissions: { defaultMode: mode } });
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), settings('plan'));
  mkdirSync(join(managed, '.claude'), { recursive: true });
  writeFileSync(join(managed, '.claude', 'settings.json'), settings('acceptEdits'));
  const pageShows = async (cwd, want, what) => {
    assert.equal((await emit('session:new', { cwd }))?.ok, true);
    try {
      await waitFor(() => latestInstances()?.defaultPermissionMode === want, what);
    } catch (err) {
      throw new Error(`${err.message}（广播里实际是 ${latestInstances()?.defaultPermissionMode}）`, { cause: err });
    }
  };
  // 仪器先证明自己看得见：仓库自己的新会话页显示仓库 settings 里的档
  await pageShows(repo, 'plan', '仓库的新会话页显示仓库 settings 里的 plan');
  await pageShows(managed, 'acceptEdits', '选中 worktree 的新会话页显示 worktree settings 里的 acceptEdits');
  assert.equal(latestInstances().composeCwd, managed);
  await emit('session:home', {});
});
