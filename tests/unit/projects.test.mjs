// tests/unit/projects.test.mjs —— 抽屉的「项目」清单：已连接的文件夹 + 其下有会话的子文件夹 + 无文件夹
//
// 官方桌面端的侧栏按项目分组：连上 ~/code 之后在 ~/code/app 里开的会话归「app」这个项目，而不是
// 堆进 ~/code 的一长串里。这里测的是服务端怎么从 ~/.claude/projects 反查出这些子项目：
// project 目录名是有损编码（非字母数字一律变 '-'），不能反解成路径，只能读 transcript 里记的 cwd，
// 再交给授权判据决定它归哪个项目（worktree 归仓库、已删的、禁区里的一律不列）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir } from '../../app/src/sessions/history.js';
import { resolveAuthorizedCwd } from '../../app/src/sessions/folder-access.js';
import { discoverSubProjects, composeProjects, createProjectIndex } from '../../app/src/sessions/projects.js';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-projects-')));
test.after(() => rmSync(ROOT, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录

let seq = 0;
function fixture() {
  const base = join(ROOT, `f${seq++}`);
  const baseDir = join(base, 'projects');
  const code = join(base, 'code');
  mkdirSync(baseDir, { recursive: true });
  mkdirSync(code, { recursive: true });
  return { baseDir, code };
}

// transcript 的真实形态：每条记录都带 cwd。cwds 给多个时依次写（模拟会话中途换过 cwd）。
function writeTranscript(baseDir, dirCwd, cwds, id = 's1') {
  const dir = join(baseDir, getProjectDir(dirCwd));
  mkdirSync(dir, { recursive: true });
  const lines = cwds.map(c => JSON.stringify({ type: 'user', timestamp: '2026-09-24T00:00:00Z', ...(c ? { cwd: c } : {}), message: { role: 'user', content: 'hi' } }));
  writeFileSync(join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
}
const mk = p => { mkdirSync(p, { recursive: true }); return p; };
const discover = (baseDir, ctx) => discoverSubProjects({
  connected: ctx.connected, baseDir, authorize: c => resolveAuthorizedCwd(c, ctx),
});

test('已连接文件夹下有会话的子文件夹各成一个项目，归属它所在的那个连接根', async () => {
  const { baseDir, code } = fixture();
  const deep = mk(join(code, 'app', 'pkg'));
  writeTranscript(baseDir, deep, [deep]);
  writeTranscript(baseDir, code, [code]); // 连接根自己的会话：它本来就是项目，不重复列
  assert.deepEqual(await discover(baseDir, { connected: [code] }), [{ key: deep, root: code }]);
});

test('子文件夹已被删掉：不列（点开也打不开的项目只是一行死链）', async () => {
  const { baseDir, code } = fixture();
  writeTranscript(baseDir, join(code, 'gone'), [join(code, 'gone')]);
  assert.deepEqual(await discover(baseDir, { connected: [code] }), []);
});

test('编码碰撞：/x/b-c 的会话不会被当成 /x/b 下的子文件夹 c', async () => {
  // `<code>/b-c` 与 `<code>/b/c` 编码成同一个目录名。按名字反解会得到后者（而且它真的存在），
  // 于是把一个根本不在连接范围里的项目的会话挂到 b 下面。
  const { baseDir, code } = fixture();
  const b = mk(join(code, 'b'));
  mk(join(b, 'c'));
  const outside = mk(join(code, 'b-c'));
  writeTranscript(baseDir, outside, [outside]);
  assert.deepEqual(await discover(baseDir, { connected: [b] }), []);
});

test('嵌套的连接根：子文件夹归最深的那个根', async () => {
  const { baseDir, code } = fixture();
  const app = mk(join(code, 'app'));
  const sub = mk(join(app, 'sub'));
  writeTranscript(baseDir, sub, [sub]);
  assert.deepEqual(await discover(baseDir, { connected: [code, app] }), [{ key: sub, root: app }]);
});

test('worktree 的会话让它所属的仓库成为项目，而不是 worktree 自己', async () => {
  const { baseDir, code } = fixture();
  const repo = mk(join(code, 'app'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init');
  const sibling = join(code, 'app-feat');
  git('worktree', 'add', '-b', 'feat', sibling);
  const managed = join(repo, '.claude', 'worktrees', 'x');
  git('worktree', 'add', '-b', 'x', managed);
  writeTranscript(baseDir, sibling, [sibling]);
  writeTranscript(baseDir, managed, [managed], 's2');
  // 仓库自己一条会话都没有，照样要成为项目——不然这两棵 worktree 的会话无处可挂
  assert.deepEqual(await discover(baseDir, { connected: [code] }), [{ key: repo, root: code }]);
});

test('已连接仓库自己的托管 worktree：会话归仓库这个连接根，不另成子项目', async () => {
  const { baseDir, code } = fixture();
  const git = (...a) => execFileSync('git', ['-C', code, ...a], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init');
  const managed = join(code, '.claude', 'worktrees', 'x');
  git('worktree', 'add', '-b', 'x', managed);
  writeTranscript(baseDir, managed, [managed]);
  // 列成子项目的话，同一批会话在抽屉里出现两次（仓库列表里并了一次，这里又一次）
  assert.deepEqual(await discover(baseDir, { connected: [code] }), []);
});

test('worktree 落在另一个连接根里：项目挂在仓库所在的根下，不是 worktree 所在的根', async () => {
  const { baseDir, code } = fixture();
  const repo = mk(join(code, 'app'));
  const stuff = mk(join(code, 'stuff'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init');
  const wt = join(stuff, 'wt');
  git('worktree', 'add', '-b', 'wt', wt);
  writeTranscript(baseDir, wt, [wt]);
  // 挂到 stuff 下的话标签会算成「stuff › ../app」
  assert.deepEqual(await discover(baseDir, { connected: [code, stuff] }), [{ key: repo, root: code }]);
});

test('禁区里的子文件夹不列（CCM 数据目录就在 CCM 仓库里）', async () => {
  const { baseDir, code } = fixture();
  const data = mk(join(code, 'data'));
  const inside = mk(join(data, 'x'));
  writeTranscript(baseDir, inside, [inside]);
  assert.deepEqual(await discover(baseDir, { connected: [code], forbidden: [data] }), []);
});

test('transcript 里没有 cwd：查无证据，不列', async () => {
  const { baseDir, code } = fixture();
  const sub = mk(join(code, 'sub'));
  writeTranscript(baseDir, sub, [null]);
  assert.deepEqual(await discover(baseDir, { connected: [code] }), []);
});

test('查不到 cwd 的目录不记进缓存：下一次扫描 transcript 写好了就认得出', async () => {
  // 扫描可能恰好撞上 CLI 刚建目录、第一条记录还没写完；把「没查到」记下来，这个子项目就永远不出现
  const { baseDir, code } = fixture();
  const sub = mk(join(code, 'sub'));
  writeTranscript(baseDir, sub, [null]);
  const cwdCache = new Map();
  const ctx = { connected: [code] };
  const run = () => discoverSubProjects({ connected: [code], baseDir, authorize: c => resolveAuthorizedCwd(c, ctx), cwdCache });
  assert.deepEqual(await run(), []);
  writeTranscript(baseDir, sub, [sub]);
  assert.deepEqual(await run(), [{ key: sub, root: code }]);
});

test('子文件夹的会话删光了（project 目录还在、里面没有 transcript）：不再列，缓存里记着也不列', async () => {
  const { baseDir, code } = fixture();
  const sub = mk(join(code, 'sub'));
  writeTranscript(baseDir, sub, [sub]);
  const cwdCache = new Map();
  const ctx = { connected: [code] };
  const run = () => discoverSubProjects({ connected: [code], baseDir, authorize: c => resolveAuthorizedCwd(c, ctx), cwdCache });
  assert.deepEqual(await run(), [{ key: sub, root: code }]);
  rmSync(join(baseDir, getProjectDir(sub), 's1.jsonl')); // safe-path: 本用例自己写的单个夹具文件
  assert.deepEqual(await run(), [], 'SDK 删会话只删 jsonl，留下空目录；照缓存列出来就是一个点进去什么都没有的项目');
});

test('会话中途换过 cwd：认「编码后等于目录名」的那个，不认第一个', async () => {
  // 被 EnterWorktree 搬过来的 transcript，开头记的是原来的 cwd（真机 1c401b5d）
  const { baseDir, code } = fixture();
  const sub = mk(join(code, 'sub'));
  writeTranscript(baseDir, sub, [code, code, sub]);
  assert.deepEqual(await discover(baseDir, { connected: [code] }), [{ key: sub, root: code }]);
});

test('路径长到目录名被截断加 hash 的子文件夹照样认得出', async () => {
  const { baseDir, code } = fixture();
  const long = mk(join(code, 'a'.repeat(90), 'b'.repeat(90), 'c'.repeat(60)));
  assert.notEqual(getProjectDir(long), long.replace(/[^a-zA-Z0-9]/g, '-'), '前提：目录名确实被截断了');
  writeTranscript(baseDir, long, [long]);
  assert.deepEqual(await discover(baseDir, { connected: [code] }), [{ key: long, root: code }]);
});

test('composeProjects：连接根按配置顺序，各自的子项目紧随其后，无文件夹垫底', () => {
  const projects = composeProjects({
    connected: ['/c/one', '/c/two'],
    subProjects: [
      { key: '/c/two/z', root: '/c/two' },
      { key: '/c/one/b/deep', root: '/c/one' },
      { key: '/c/one/a', root: '/c/one' },
      { key: '/c/one/a', root: '/c/one' },      // 活实例与扫盘各报一次
      { key: '/c/gone/x', root: '/c/gone' },    // 所属根已被移出清单
    ],
    scratchRoot: '/s',
  });
  assert.deepEqual(projects, [
    { key: '/c/one', root: '/c/one', label: 'one', kind: 'connected' },
    { key: '/c/one/a', root: '/c/one', label: 'one › a', kind: 'subfolder' },
    { key: '/c/one/b/deep', root: '/c/one', label: 'one › b/deep', kind: 'subfolder' },
    { key: '/c/two', root: '/c/two', label: 'two', kind: 'connected' },
    { key: '/c/two/z', root: '/c/two', label: 'two › z', kind: 'subfolder' },
    { key: '/s', root: '/s', label: null, kind: 'scratch' },
  ]);
});

test('composeProjects：连接根互相嵌套时，子项目挂在它记的那个根下，不按路径前缀挂到外层', () => {
  const projects = composeProjects({ connected: ['/c', '/c/app'], subProjects: [{ key: '/c/app/sub', root: '/c/app' }] });
  assert.deepEqual(projects.map(p => [p.key, p.label]), [['/c', 'c'], ['/c/app', 'app'], ['/c/app/sub', 'app › sub']]);
});

test('createProjectIndex：并发刷新合并成一次在途 + 一次补跑，结果不变不通知', async () => {
  let calls = 0;
  let release;
  let result = [{ key: '/c/a', root: '/c' }];
  const changes = [];
  const index = createProjectIndex({
    discover: () => { calls += 1; return new Promise(r => { release = () => r(result); }); },
    onChange: list => changes.push(list),
  });
  assert.equal(index.get(), null, '还没扫过：调用方要知道「没有数据」而不是「没有子项目」');
  const p1 = index.refresh();
  const p2 = index.refresh();
  const p3 = index.refresh();
  assert.equal(calls, 1, '在途时不另起一次扫描');
  release();
  await p1; await p2; await p3;
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 2, '在途期间来过刷新请求：补跑一次，不丢掉那期间出现的新项目');
  release();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(index.get(), result);
  assert.equal(changes.length, 1, '两次扫出同样的结果只通知一次（每次都广播就是每分钟一次无谓的全量推送）');

  result = [];
  const p4 = index.refresh();
  release();
  await p4;
  assert.deepEqual(index.get(), []);
  assert.equal(changes.length, 2);
});

test('createProjectIndex：扫描抛错时保留上一次的结果', async () => {
  let fail = false;
  const index = createProjectIndex({
    discover: async () => { if (fail) throw new Error('EACCES'); return [{ key: '/c/a', root: '/c' }]; },
    onChange: () => {},
  });
  await index.refresh();
  fail = true;
  await index.refresh();
  assert.deepEqual(index.get(), [{ key: '/c/a', root: '/c' }], '一次读盘失败就把子项目清空，抽屉会整片闪没');
});

test('createProjectIndex.start：先扫一次，之后按周期补扫；没人在看时跳过；stop 之后不再扫', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let watching = false;
  const index = createProjectIndex({ discover: async () => { calls += 1; return []; }, onChange: () => {} });
  index.start(60_000, () => watching);
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 1, '启动即扫：终端里早先开在子目录的会话，第一次打开抽屉就该在');
  t.mock.timers.tick(60_000);
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 1, '没有已批准的连接时不扫——没人看的清单不值得每分钟读一遍磁盘');
  watching = true;
  t.mock.timers.tick(60_000);
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 2);
  index.stop();
  t.mock.timers.tick(120_000);
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 2, 'stop 之后定时器还在跑，关闭期间会继续读盘');
});
