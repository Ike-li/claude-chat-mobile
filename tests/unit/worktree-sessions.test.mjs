// tests/unit/worktree-sessions.test.mjs —— worktree 会话发现（runner 注入 + tmpdir 夹具，零 git/零网络）
// 用户决策 2026-07-18：只列【有 worktree 的分支】=活着的 linked worktree，发现主轴 git worktree list。
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir } from '../../src/sessions/history.js';
import { parseWorktreeList, listRepoWorktrees, discoverWorktreeSessions } from '../../src/sessions/worktree-sessions.js';

// 构造 `git worktree list --porcelain` 输出：段间空行分隔，段尾再补空行（git 真实形态）。
function porcelain(entries) {
  return entries.map(e => {
    const lines = [`worktree ${e.path}`];
    if (e.bare) { lines.push('bare'); return lines.join('\n'); }
    lines.push(`HEAD ${e.head || '0'.repeat(40)}`);
    if (e.detached) lines.push('detached');
    else if (e.branch) lines.push(`branch refs/heads/${e.branch}`);
    return lines.join('\n');
  }).join('\n\n') + '\n\n';
}

test('parseWorktreeList: 解析主树 + linked worktree 的 path/branch', () => {
  const got = parseWorktreeList(porcelain([
    { path: '/repo', branch: 'dev' },
    { path: '/repo/.claude/worktrees/feat', branch: 'feat' },
  ]));
  assert.equal(got.length, 2);
  assert.deepEqual({ path: got[0].path, branch: got[0].branch }, { path: '/repo', branch: 'dev' });
  assert.deepEqual({ path: got[1].path, branch: got[1].branch }, { path: '/repo/.claude/worktrees/feat', branch: 'feat' });
});

test('parseWorktreeList: detached HEAD → branch=null, detached=true', () => {
  const got = parseWorktreeList(porcelain([{ path: '/repo', detached: true }]));
  assert.equal(got[0].branch, null);
  assert.equal(got[0].detached, true);
});

test('parseWorktreeList: bare 主仓 → bare=true（无 HEAD/branch）', () => {
  const got = parseWorktreeList([
    'worktree /repo.git', 'bare', '',
    'worktree /repo/wt', 'HEAD abc', 'branch refs/heads/x', '',
  ].join('\n'));
  assert.equal(got.length, 2);
  assert.equal(got[0].bare, true);
  assert.equal(got[1].branch, 'x');
});

test('parseWorktreeList: 空输入 → []', () => {
  assert.deepEqual(parseWorktreeList(''), []);
  assert.deepEqual(parseWorktreeList(null), []);
});

test('listRepoWorktrees: 排除主树，只返回 linked worktree', async () => {
  const runner = async () => porcelain([
    { path: '/repo', branch: 'dev' },                              // 主树（首项，= repo）
    { path: '/repo/.claude/worktrees/feat', branch: 'feat' },
    { path: '/elsewhere/hotfix', branch: 'hotfix' },
  ]);
  const got = await listRepoWorktrees('/repo', { runner });
  assert.equal(got.length, 2);
  assert.deepEqual(got.map(w => w.branch), ['feat', 'hotfix']);
});

test('listRepoWorktrees: git 失败（非 repo）→ []', async () => {
  const runner = async () => { throw new Error('not a git repository'); };
  assert.deepEqual(await listRepoWorktrees('/nope', { runner }), []);
});

test('discoverWorktreeSessions: 按 branch 分组，附会话与 worktreeExists', async () => {
  const PROJ = join(tmpdir(), `ccm-wt-proj-${process.pid}`);   // ~/.claude/projects 替身
  const REPO = join(tmpdir(), `ccm-wt-repo-${process.pid}`);   // 真实 repo
  const wtPath = join(REPO, '.claude', 'worktrees', 'feat');   // 建真实目录 → worktreeExists=true
  mkdirSync(wtPath, { recursive: true });
  // 在该 worktree 的 project 目录写一个会话夹具
  const projDir = join(PROJ, getProjectDir(wtPath));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'sess-feat.jsonl'),
    JSON.stringify({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: '在 worktree 里干活' } }) + '\n');

  const runner = async () => porcelain([
    { path: REPO, branch: 'dev' },        // 主树
    { path: wtPath, branch: 'feat' },     // linked worktree
  ]);
  const groups = await discoverWorktreeSessions(REPO, { baseDir: PROJ, runner });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].branch, 'feat');
  assert.equal(groups[0].worktreePath, wtPath);
  assert.equal(groups[0].worktreeExists, true);
  assert.equal(groups[0].sessions.length, 1);
  assert.equal(groups[0].sessions[0].id, 'sess-feat');
  assert.equal(groups[0].sessions[0].title, '在 worktree 里干活');
});
