// tests/unit/history-list-worktree.test.mjs —— 会话列表把托管 worktree 的会话并进父仓
//
// 背景：CLI 的 EnterWorktree / --worktree / agent isolation 把 worktree 建在
// `<workdir>/.claude/worktrees/<name>`，而 transcript 按 **worktree 自己的路径**落进一个独立的
// project 目录。listSessionsPage 原本只扫父仓那一个目录，于是这类会话在手机上完全不可见——
// 盘上活得好好的，抽屉里一条都没有。
//
// 产品判据是「worktree 是临时模式，干完合并回来」，所以不给它新增工作区条目，
// 只把会话并进父仓列表；每条带自己的 cwd（父仓只是展示归属，打开时要用真实 cwd 才找得到 transcript）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, listSessionsPage, listSessionsByIds, sessionFileExists, sessionExistsInWorkspace } from '../../app/src/sessions/history.js';

const ROOT = mkdtempSync(join(tmpdir(), 'ccm-hist-wt-'));
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

// 每个用例一套独立的 (projects 根, 工作区根)，避免 listSessionsPage 的 4s TTL 缓存串场
let seq = 0;
function fixture() {
  const id = `c${seq++}`;
  const baseDir = join(ROOT, id, 'projects');   // 假的 ~/.claude/projects
  const repo = join(ROOT, id, 'repo');          // 工作区根
  mkdirSync(baseDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  return { baseDir, repo };
}

// 往 <baseDir>/<encode(cwd)>/<id>.jsonl 写一条有真实消息时间的会话
function writeSession(baseDir, cwd, id, { text = 'hi', at }) {
  const dir = join(baseDir, getProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const ts = new Date(at).toISOString();
  const lines = [
    { type: 'user', timestamp: ts, message: { role: 'user', content: text } },
    { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: 'ok' } },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// 造一个真实存在的托管 worktree 目录（枚举侧靠 readdir，目录必须真的在）
function makeWorktree(repo, name) {
  const p = join(repo, '.claude', 'worktrees', name);
  mkdirSync(p, { recursive: true });
  return p;
}

const T0 = Date.parse('2026-09-11T00:00:00Z');

test('托管 worktree 的会话并进父仓列表，并带上自己的 cwd', async () => {
  const { baseDir, repo } = fixture();
  const wt = makeWorktree(repo, 'feature-x');
  writeSession(baseDir, repo, 'main-1', { text: '父仓会话', at: T0 });
  writeSession(baseDir, wt, 'wt-1', { text: 'worktree 会话', at: T0 + 1000 });

  const { sessions } = await listSessionsPage(repo, { baseDir, limit: 10 });
  const ids = sessions.map(s => s.id);
  assert.deepEqual(ids, ['wt-1', 'main-1'], '合并后按活动时间降序，worktree 会话更新故排前');

  const wtRow = sessions.find(s => s.id === 'wt-1');
  assert.equal(wtRow.cwd, wt, '不带真实 cwd 的话，前端点开会拿父仓 cwd 去找一个不在那儿的 transcript');
  assert.equal(wtRow.worktree, 'feature-x', '行上要能看出这条在哪个 worktree 干活，否则合并前无从判断');

  const mainRow = sessions.find(s => s.id === 'main-1');
  assert.equal(mainRow.worktree, undefined, '父仓会话不该被标成 worktree');
});

test('没有 .claude/worktrees 时结果与从前逐字相同（向后兼容）', async () => {
  const { baseDir, repo } = fixture();
  writeSession(baseDir, repo, 'only-1', { text: '普通会话', at: T0 });

  const { sessions, total, hasMore } = await listSessionsPage(repo, { baseDir, limit: 10 });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'only-1');
  assert.equal(sessions[0].cwd, undefined, '父仓会话不该平白多出 cwd 字段');
  assert.equal(total, 1);
  assert.equal(hasMore, false);
});

// ★ 这一条是「合并后截断」与「各自截断」的分水岭。各自截断的写法在
//   「父仓条数 < limit」时给出完全相同的结果，只有塞满父仓才会分叉。
test('limit 在合并之后生效：父仓塞满时，更新的 worktree 会话仍须挤进来', async () => {
  const { baseDir, repo } = fixture();
  const wt = makeWorktree(repo, 'late');
  for (let i = 0; i < 6; i++) writeSession(baseDir, repo, `main-${i}`, { at: T0 + i * 1000 });
  writeSession(baseDir, wt, 'wt-newest', { at: T0 + 99000 });

  const { sessions, total } = await listSessionsPage(repo, { baseDir, limit: 3 });
  assert.equal(sessions.length, 3);
  assert.equal(sessions[0].id, 'wt-newest', '最近的一条在 worktree 里，各自截断会把它排在父仓那一页之后');
  assert.equal(total, 7, 'total 是两处之和，否则「还有更早会话」的判断会漏掉 worktree 那边');
});

test('多个 worktree 各自归属，互不串目录', async () => {
  const { baseDir, repo } = fixture();
  const a = makeWorktree(repo, 'wt-a');
  const b = makeWorktree(repo, 'wt-b');
  writeSession(baseDir, a, 'sess-a', { at: T0 + 1000 });
  writeSession(baseDir, b, 'sess-b', { at: T0 + 2000 });

  const { sessions } = await listSessionsPage(repo, { baseDir, limit: 10 });
  assert.equal(sessions.find(s => s.id === 'sess-a').worktree, 'wt-a');
  assert.equal(sessions.find(s => s.id === 'sess-b').worktree, 'wt-b');
  assert.equal(sessions.find(s => s.id === 'sess-a').cwd, a);
  assert.equal(sessions.find(s => s.id === 'sess-b').cwd, b);
});

test('worktree 目录在、但没有任何会话 → 不影响父仓列表', async () => {
  const { baseDir, repo } = fixture();
  makeWorktree(repo, 'empty-one');
  writeSession(baseDir, repo, 'main-only', { at: T0 });

  const { sessions, total } = await listSessionsPage(repo, { baseDir, limit: 10 });
  assert.deepEqual(sessions.map(s => s.id), ['main-only']);
  assert.equal(total, 1);
});

test('worktrees 下的普通文件被忽略，不当成 worktree 去扫', async () => {
  const { baseDir, repo } = fixture();
  mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'worktrees', 'README.md'), 'not a worktree');
  writeSession(baseDir, repo, 'main-only', { at: T0 });

  const { sessions } = await listSessionsPage(repo, { baseDir, limit: 10 });
  assert.deepEqual(sessions.map(s => s.id), ['main-only']);
});

// listSessionsByIds 是「手动标未读」的补齐通道：被 limit 挤出时间窗的标记行靠它拉回来。
// 长按确认框对用户的承诺是「这一行会一直显示未读，直到你再次打开它」——按父仓 cwd 单点查，
// worktree 那几条会静默查空，标记还在 read-state 里而行再也找不回来，只能靠标题搜索。
test('listSessionsByIds 跨 worktree 补齐，并带回真实 cwd', async () => {
  const { baseDir, repo } = fixture();
  const wt = makeWorktree(repo, 'pinned-wt');
  writeSession(baseDir, repo, 'main-1', { text: '父仓', at: T0 });
  writeSession(baseDir, wt, 'wt-1', { text: 'worktree 里的', at: T0 + 1000 });

  const rows = await listSessionsByIds(repo, ['main-1', 'wt-1'], { baseDir });
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(rows.length, 2, 'worktree 那条查空 = 用户标了未读却再也看不到这一行');
  assert.equal(byId['wt-1'].cwd, wt);
  assert.equal(byId['wt-1'].worktree, 'pinned-wt');
  assert.equal(byId['main-1'].cwd, undefined, '父仓行不该平白多出 cwd');
});

// 「该工作区最后查看的会话」指针现在存在父仓名下（工作区轴归父仓），值却可能是 worktree 里的
// 会话。按父仓单点查会恒判不存在 → 侧栏永远不高亮当前会话。
// sessionFileExists **不放宽**：它是 session:switch 的归属校验兼路径穿越防线，那里拿到的 cwd
// 已经是 routeCwd 解析过的真实 cwd，放宽只会削弱纵深防御。两个函数各司其职，不要合并。
test('sessionExistsInWorkspace 跨 worktree 认，sessionFileExists 保持严格单点', async () => {
  const { baseDir, repo } = fixture();
  const wt = makeWorktree(repo, 'cur');
  writeSession(baseDir, wt, 'wt-cur', { at: T0 });

  assert.equal(await sessionExistsInWorkspace(repo, 'wt-cur', { baseDir }), true);
  assert.equal(
    await sessionFileExists(repo, 'wt-cur', { baseDir }), false,
    'session:switch 的归属校验必须仍按传入 cwd 精确判，放宽等于削弱路径穿越防线',
  );
  assert.equal(await sessionFileExists(wt, 'wt-cur', { baseDir }), true, '拿真实 cwd 查必须命中');
  assert.equal(await sessionExistsInWorkspace(repo, 'nope', { baseDir }), false);
  assert.equal(await sessionExistsInWorkspace(repo, '../escape', { baseDir }), false, '非法 id 一律拒');
});

test('listSessionsByIds: 两处都没有的 id 照旧丢弃，不返回幽灵行', async () => {
  const { baseDir, repo } = fixture();
  makeWorktree(repo, 'wt');
  writeSession(baseDir, repo, 'real-1', { at: T0 });

  const rows = await listSessionsByIds(repo, ['real-1', 'ghost-1'], { baseDir });
  assert.deepEqual(rows.map(r => r.id), ['real-1']);
});

// ★ 会话中途 EnterWorktree 的形态：CLI 不换 session id，只把 cwd 指向 worktree，于是**同一个
// session id 在两个 project 目录各有一个 .jsonl**（切换前的留在父仓，之后的写进 worktree）。
// 合并时不按 id 去重，抽屉里就会出现两行一模一样的标题，点哪一行得到的历史还不一样。
// 留 worktree 那条：它是这个会话现在所在的位置，也是后续内容落盘的地方。
test('同一 session id 在父仓与 worktree 都有 transcript（中途 EnterWorktree）→ 只出一行，取 worktree 那条', async () => {
  const { baseDir, repo } = fixture();
  const wt = makeWorktree(repo, 'switched');
  writeSession(baseDir, repo, 'same-sid', { text: '切换前', at: T0 });
  writeSession(baseDir, wt, 'same-sid', { text: '切换后', at: T0 + 5000 });

  const { sessions } = await listSessionsPage(repo, { baseDir, limit: 10 });
  assert.equal(sessions.length, 1, '同一个会话出现两行，点哪行拿到的历史还不一样');
  assert.equal(sessions[0].cwd, wt, '要留 worktree 那条：会话现在在那儿，后续内容也往那儿写');
  assert.equal(sessions[0].worktree, 'switched');
});

test('标题搜索同样覆盖 worktree 会话——搜不到等于那条会话不存在', async () => {
  const { baseDir, repo } = fixture();
  const wt = makeWorktree(repo, 'searchable');
  writeSession(baseDir, repo, 'main-1', { text: '无关内容', at: T0 });
  writeSession(baseDir, wt, 'wt-1', { text: '独特关键词', at: T0 + 1000 });

  const { sessions } = await listSessionsPage(repo, { baseDir, limit: 10, query: '独特关键词' });
  assert.deepEqual(sessions.map(s => s.id), ['wt-1']);
  assert.equal(sessions[0].cwd, wt);
});
