// tests/invariants/scratch-workspaces.test.mjs —— 「无文件夹」会话的 scratch 目录：怎么建、什么时候才准删
// 守护：SCRATCH-01（app/src 唯一一处递归删除：父目录恰好是 scratch 根、mkdtemp 形态、非 symlink、根不是家目录/磁盘根、
//        没有别的会话的 transcript、没有活实例——全部成立才删）
// 测什么：sessions/scratch-workspaces.js 在一次性目录上的真 fs 行为。每条拒删用例都断言目录（及里面的文件）还在。
// 不测什么 + 为什么：① 删会话时是否调用它、ack 怎么报在 server 层（tests/invariants/server/no-folder.test.mjs）
//   ② scratch 目录能不能当 cwd 在 folder-access.test.mjs（SCOPE-05）
// 槽位：S1（一次性目录上的真 fs）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

import { createScratchWorkspace, removeScratchWorkspace } from '../../app/src/sessions/scratch-workspaces.js';
import { SCRATCH_DIR_RE } from '../../app/src/sessions/folder-access.js';
import { encodeProjectDir } from '../../app/src/shared/project-dir.js';

const ROOTS = [];
test.after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); }); // safe-rm: mkdtemp 一次性目录

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-scratch-')));
  ROOTS.push(base);
  const home = join(base, 'home');
  const root = join(home, 'Library', 'scratch-workspaces');
  const baseDir = join(base, 'projects'); // 假的 ~/.claude/projects
  mkdirSync(baseDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { base, home, root, baseDir };
}
const opts = (f, extra = {}) => ({ root: f.root, home: f.home, baseDir: f.baseDir, liveCwds: () => [], ...extra });
const withFile = dir => { writeFileSync(join(dir, 'work.txt'), '用户在这个目录里写的东西'); return dir; };
const writeTranscript = (baseDir, cwd, id) => {
  const dir = join(baseDir, encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), '{}\n');
};

test('新建：根不存在时一并建出；目录名是 scratch-YYYY-MM-DD-xxxxxx，直接在根下', () => {
  const f = fixture();
  const dir = createScratchWorkspace(f.root, { now: new Date(2026, 8, 24, 23, 59) });
  assert.equal(dirname(dir), f.root);
  assert.match(basename(dir), SCRATCH_DIR_RE);
  // 一天的两头各取一个：本机只要不在 UTC，按 UTC 取日期必有一头落到隔壁那天
  for (const at of [new Date(2026, 8, 24, 0, 30), new Date(2026, 8, 24, 23, 59)]) {
    assert.ok(basename(createScratchWorkspace(f.root, { now: at })).startsWith('scratch-2026-09-24-'), '日期取本地时间：用户看到的是自己那一天');
  }
  assert.notEqual(createScratchWorkspace(f.root), dir, '每次都是新目录');
});

test('正例：父目录恰好是根、名字对、没有别的会话、没有活实例 → 连同里面的文件一起删掉', () => {
  const f = fixture();
  const dir = withFile(createScratchWorkspace(f.root));
  assert.deepEqual(removeScratchWorkspace(dir, opts(f)), { removed: true, reason: null });
  assert.equal(existsSync(dir), false);
});

test('拒删：scratch 根本身', () => {
  const f = fixture();
  withFile(createScratchWorkspace(f.root));
  assert.equal(removeScratchWorkspace(f.root, opts(f)).removed, false);
  assert.ok(existsSync(f.root));
});

test('拒删：根以外的目录（哪怕名字像）', () => {
  const f = fixture();
  createScratchWorkspace(f.root);
  const elsewhere = withFile(mkdtempSync(join(f.home, 'scratch-2026-09-24-')));
  assert.equal(removeScratchWorkspace(elsewhere, opts(f)).removed, false);
  assert.ok(existsSync(join(elsewhere, 'work.txt')));
});

test('拒删：根下的 symlink（链接目标完好无损）', () => {
  const f = fixture();
  createScratchWorkspace(f.root);
  const target = join(f.home, 'precious');
  const link = join(f.root, 'scratch-2026-09-24-LINKED'); // 名字恰好合形态：只剩「不是 symlink」这一道挡着
  mkdirSync(target, { recursive: true });
  withFile(target);
  symlinkSync(target, link);
  assert.equal(removeScratchWorkspace(link, opts(f)).removed, false);
  assert.ok(existsSync(join(target, 'work.txt')), '跟着 symlink 删 = 删掉用户别处的目录');
  assert.ok(existsSync(link));
});

test('拒删：根下指向另一个 scratch 目录的 symlink（不跟着链接删掉别的目录）', () => {
  const f = fixture();
  const other = withFile(createScratchWorkspace(f.root));
  const link = join(f.root, 'scratch-2026-09-24-LINK02');
  symlinkSync(other, link);
  assert.equal(removeScratchWorkspace(link, opts(f)).removed, false);
  assert.ok(existsSync(join(other, 'work.txt')), '链接的真实路径也在根下、名字也对——只有「不是 symlink」挡得住');
});

test('拒删：名字不是 mkdtemp 形态（手工建的、改过名的）', () => {
  const f = fixture();
  createScratchWorkspace(f.root);
  for (const name of ['my-stuff', 'scratch-2026-09-24', 'scratch-2026-09-24-abc', 'scratch-2026-09-24-abcdef-x']) {
    const d = join(f.root, name);
    mkdirSync(d, { recursive: true });
    withFile(d);
    assert.equal(removeScratchWorkspace(d, opts(f)).removed, false, name);
    assert.ok(existsSync(join(d, 'work.txt')), name);
  }
});

test('拒删：根下名字像 scratch 的普通文件', () => {
  const f = fixture();
  createScratchWorkspace(f.root);
  const file = join(f.root, 'scratch-2026-09-24-FILE01');
  writeFileSync(file, '不是 app 建的目录');
  assert.equal(removeScratchWorkspace(file, opts(f)).removed, false);
  assert.ok(existsSync(file));
});

test('拒删：两层深（scratch 目录里又有一个 scratch 形态的子目录）', () => {
  const f = fixture();
  const outer = createScratchWorkspace(f.root);
  const inner = withFile(createScratchWorkspace(outer));
  assert.equal(removeScratchWorkspace(inner, opts(f)).removed, false);
  assert.ok(existsSync(join(inner, 'work.txt')));
});

test('拒删：目录里还有别的会话的 transcript（/clear 之后同一目录会有多条）', () => {
  const f = fixture();
  const dir = withFile(createScratchWorkspace(f.root));
  writeTranscript(f.baseDir, dir, 'other-session');
  assert.deepEqual(removeScratchWorkspace(dir, opts(f)), { removed: false, reason: 'in_use' });
  assert.ok(existsSync(join(dir, 'work.txt')));
});

test('拒删：有活实例开在里面', () => {
  const f = fixture();
  const dir = withFile(createScratchWorkspace(f.root));
  assert.deepEqual(removeScratchWorkspace(dir, opts(f, { liveCwds: () => [dir] })), { removed: false, reason: 'in_use' });
  assert.ok(existsSync(join(dir, 'work.txt')));
});

// 会话 cwd 可以落在 scratch 目录的子目录里（模型 git init 之后 EnterWorktree 进 .claude/worktrees/x、
// 或 Bash cd 触发 CwdChanged）。那时活实例的 cwd 不等于 scratch 目录本身，它的 transcript 也在另一个
// project 目录里——只比「恰好相等」的话，删同一目录下另一条旧会话会把这棵正在用的子树整个删掉。
test('拒删：活实例开在它的子目录里（例如里面的 worktree）', () => {
  const f = fixture();
  const dir = withFile(createScratchWorkspace(f.root));
  const sub = join(dir, '.claude', 'worktrees', 'w');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'wip.txt'), '还没提交的改动');
  assert.deepEqual(removeScratchWorkspace(dir, opts(f, { liveCwds: () => [sub] })), { removed: false, reason: 'in_use' });
  assert.ok(existsSync(join(sub, 'wip.txt')));
});

test('拒删：子目录里还有会话的 transcript（会话被 CLI 搬进了子目录的 project 目录）', () => {
  const f = fixture();
  const dir = withFile(createScratchWorkspace(f.root));
  const sub = join(dir, 'pkg');
  mkdirSync(sub);
  writeTranscript(f.baseDir, sub, 'moved-session');
  assert.deepEqual(removeScratchWorkspace(dir, opts(f)), { removed: false, reason: 'in_use' });
  assert.ok(existsSync(join(dir, 'work.txt')));
});

test('正对照：别的 scratch 目录有会话、有活实例，不妨碍删这一个', () => {
  const f = fixture();
  const dir = withFile(createScratchWorkspace(f.root));
  const other = createScratchWorkspace(f.root);
  writeTranscript(f.baseDir, other, 'other-dir-session');
  assert.deepEqual(removeScratchWorkspace(dir, opts(f, { liveCwds: () => [other, join(other, 'x')] })), { removed: true, reason: null });
  assert.ok(!existsSync(dir));
  assert.ok(existsSync(other));
});

test('拒删：scratch 根被配成家目录或磁盘根时，一个都不删', () => {
  const f = fixture();
  const inHome = withFile(mkdtempSync(join(f.home, 'scratch-2026-09-24-')));
  assert.equal(removeScratchWorkspace(inHome, opts(f, { root: f.home })).removed, false);
  assert.ok(existsSync(join(inHome, 'work.txt')));
  assert.equal(removeScratchWorkspace(inHome, opts(f, { root: '/' })).removed, false);
});

test('目录已经不在了：不算错，也不删别的', () => {
  const f = fixture();
  createScratchWorkspace(f.root);
  const r = removeScratchWorkspace(join(f.root, 'scratch-2026-09-24-GONE00'), opts(f));
  assert.equal(r.removed, false);
});
