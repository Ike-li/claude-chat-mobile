// tests/invariants/worktree-ownership.test.mjs —— linked worktree 随所属仓库授权，但归属必须双向回验
// 守护：SCOPE-04（worktree 的 .git 指针 + 仓库侧 .git/worktrees/<名>/gitdir 回链，两侧都成立才认；判定不执行 git）
// 测什么：用真 git（git init + git worktree add）造出平级 / 托管 / 伪造 / 被篡改的各种 worktree，
//   看 resolveAuthorizedCwd 与 listLinkedWorktrees 认不认、认成谁的。
// 不测什么 + 为什么：① server 各闸门有没有用上这个判据——属接线，S2（tests/invariants/server/）
//   ② CLI 真的会不会把会话搬进这些目录——S5。
// 槽位：S1（一次性目录上的真 git / 真 symlink）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveAuthorizedCwd, listLinkedWorktrees } from '../../app/src/sessions/folder-access.js';

const ROOTS = [];
test.after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

// base 必须先 realpath：macOS 的 /var 与 /private/var 是同一目录，判据返回 realpath 后的值，
// 拿未解析的 base 拼期望值会让「返回值对不对」这一类断言恒红或恒绿。
function makeFixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-wt-own-')));
  ROOTS.push(base);
  const code = join(base, 'code');
  const repo = join(code, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  const sibling = join(code, 'repo-feat');                        // 仓库外的平级 worktree
  git(repo, 'worktree', 'add', '-b', 'feat', sibling);
  const managed = join(repo, '.claude', 'worktrees', 'a', 'b');    // 托管 worktree，名字带 / 分段
  git(repo, 'worktree', 'add', '-b', 'managed', managed);
  return { base, code, repo, sibling, managed, git };
}

// 仓库侧的管理目录名不一定等于 worktree 目录名（本机实测：.git/worktrees/agent → claude-chat-mobile-third-party），
// 所以按 gitdir 内容反查，不按名字猜。
function metaDirOf(repo, worktree) {
  const root = join(repo, '.git', 'worktrees');
  for (const name of readdirSync(root)) {
    const back = readFileSync(join(root, name, 'gitdir'), 'utf8').trim();
    if (realpathSync(dirname(back)) === worktree) return join(root, name);
  }
  throw new Error(`fixture: 找不到 ${worktree} 的管理目录`);
}

test('仓库外的平级 worktree：仓库已连接即授权，归到仓库名下', () => {
  const { repo, sibling } = makeFixture();
  const auth = resolveAuthorizedCwd(sibling, { connected: [repo] });
  assert.ok(auth, '仓库已连接、worktree 两侧指针都成立却不放行 = 真机 1c401b5d 那种会话照样进不了抽屉');
  assert.equal(auth.kind, 'worktree');
  assert.equal(auth.path, sibling);
  assert.equal(auth.projectKey, repo, 'worktree 会话要归到所属仓库的项目下，而不是自成一个项目');
  assert.equal(auth.repo, repo);
  assert.equal(auth.scopeRoot, sibling, '文件面板的范围是这棵 worktree 本身，不是整个仓库');
});

test('平级 worktree 里的子目录同样授权，范围仍是 worktree 根', () => {
  const { repo, sibling } = makeFixture();
  const sub = join(sibling, 'app', 'src');
  mkdirSync(sub, { recursive: true });
  const auth = resolveAuthorizedCwd(sub, { connected: [repo] });
  assert.equal(auth?.kind, 'worktree');
  assert.equal(auth.projectKey, repo);
  assert.equal(auth.scopeRoot, sibling);
});

test('托管 worktree（名字带 / 分段）落在仓库子树里：按子目录授权，项目仍归仓库', () => {
  const { repo, managed } = makeFixture();
  const auth = resolveAuthorizedCwd(managed, { connected: [repo] });
  assert.equal(auth?.kind, 'connected');
  assert.equal(auth.root, repo);
  assert.equal(auth.projectKey, repo, '托管 worktree 的会话也要挂在仓库名下，不能因为能按子目录授权就自成项目');
  assert.equal(auth.worktreeRoot, managed, '已经在 worktree 里——懒建 worktree 靠它避免「worktree 里再套一棵」');
  assert.equal(auth.repo, repo, '网关隔离靠它找到 CLI 会误读 settings.local.json 的那个主仓');
});

test('仓库没连接：它的 worktree 也不授权', () => {
  const { base, sibling } = makeFixture();
  const other = join(base, 'other');
  mkdirSync(other);
  assert.equal(resolveAuthorizedCwd(sibling, { connected: [other] }), null);
});

test('伪造：别的目录里写一个指向已连接仓库管理目录的 .git 文件，不放行', () => {
  const { code, repo, sibling } = makeFixture();
  const forged = join(code, 'forged');
  mkdirSync(forged);
  // 指向的是真实存在的管理目录（平级 worktree 那个）——只看 worktree 侧指针就会被骗过去。
  writeFileSync(join(forged, '.git'), `gitdir: ${metaDirOf(repo, sibling)}\n`);
  assert.equal(resolveAuthorizedCwd(forged, { connected: [repo] }), null,
    '只信 worktree 侧的 .git 文件 = 模型在任何可写目录里写一行就能冒充已授权仓库的 worktree');
});

test('伪造：指向不存在的管理目录，不放行', () => {
  const { code, repo } = makeFixture();
  const forged = join(code, 'forged-missing');
  mkdirSync(forged);
  writeFileSync(join(forged, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'nope')}\n`);
  assert.equal(resolveAuthorizedCwd(forged, { connected: [repo] }), null);
});

test('.git 是 symlink：不放行（哪怕指向的是真 worktree 的 .git）', () => {
  const { code, repo, sibling } = makeFixture();
  const linked = join(code, 'linked');
  mkdirSync(linked);
  symlinkSync(join(sibling, '.git'), join(linked, '.git'));
  assert.equal(resolveAuthorizedCwd(linked, { connected: [repo] }), null);
});

test('仓库侧回链被改到别处：不放行', () => {
  const { repo, sibling } = makeFixture();
  writeFileSync(join(metaDirOf(repo, sibling), 'gitdir'), join(repo, 'elsewhere', '.git') + '\n');
  assert.equal(resolveAuthorizedCwd(sibling, { connected: [repo] }), null);
});

// 只认标准布局 `<仓库>/.git/worktrees/<名>`：`--separate-git-dir` 的仓库，管理目录在
// `<别处>/r.git/worktrees/<名>`，从它推不出工作区在哪。变异实测：把两级目录名的判断从 `||` 改成 `&&`，
// 会把 `<别处>` 当成仓库——而之前没有任何用例红。
test('--separate-git-dir 的仓库：不按 worktree 认（推不出真正的仓库根，fail-closed）', () => {
  const { base, git } = makeFixture();
  const gitdirs = join(base, 'gitdirs');
  const r2 = join(base, 'code', 'r2');
  mkdirSync(gitdirs);
  execFileSync('git', ['init', '-b', 'main', '--separate-git-dir', join(gitdirs, 'r2.git'), r2], { stdio: 'pipe' });
  git(r2, 'config', 'user.email', 'test@example.invalid');
  git(r2, 'config', 'user.name', 'test');
  git(r2, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(r2, 'README.md'), '# r2\n');
  git(r2, 'add', '.');
  git(r2, 'commit', '-m', 'init');
  const wt2 = join(base, 'code', 'r2-feat');
  git(r2, 'worktree', 'add', '-b', 'feat', wt2);
  assert.equal(resolveAuthorizedCwd(wt2, { connected: [base + '/gitdirs'] }), null,
    '把管理目录的上两级当成仓库，就会凭一个毫不相干的连接根放行这棵 worktree');
});

test('普通的兄弟目录（没有 .git）：不放行', () => {
  const { code, repo } = makeFixture();
  const plain = join(code, 'repo-plain');
  mkdirSync(plain);
  assert.equal(resolveAuthorizedCwd(plain, { connected: [repo] }), null);
});

test('父目录整个连接时：平级 worktree 按子目录授权，但项目仍归仓库', () => {
  const { code, repo, sibling } = makeFixture();
  const auth = resolveAuthorizedCwd(sibling, { connected: [code] });
  assert.equal(auth?.kind, 'connected');
  assert.equal(auth.root, code);
  assert.equal(auth.projectKey, repo);
});

test('worktree 自己被显式连接：显式优先，自成项目（兼容把平级 worktree 写进 WORKDIRS 的存量配置）', () => {
  const { repo, sibling } = makeFixture();
  const auth = resolveAuthorizedCwd(sibling, { connected: [repo, sibling] });
  assert.equal(auth?.kind, 'connected');
  assert.equal(auth.root, sibling);
  assert.equal(auth.projectKey, sibling);
  assert.equal(auth.worktreeRoot, sibling, '显式连接不改变「它物理上是一棵 worktree」这个事实');
  assert.equal(auth.repo, repo);
});

test('listLinkedWorktrees：从仓库侧列出双向校验通过的 worktree，被篡改的不列', () => {
  const { repo, sibling, managed, code, git } = makeFixture();
  const tampered = join(code, 'repo-tampered');
  git(repo, 'worktree', 'add', '-b', 'tampered', tampered);
  writeFileSync(join(metaDirOf(repo, tampered), 'gitdir'), join(code, 'nowhere', '.git') + '\n');
  // 回链指向一个真实存在、但不是 worktree 的目录：不经双向回验就会被当成一棵 worktree 列出来
  const decoyWt = join(code, 'repo-decoy');
  git(repo, 'worktree', 'add', '-b', 'decoy', decoyWt);
  const decoy = join(code, 'decoy');
  mkdirSync(decoy);
  writeFileSync(join(metaDirOf(repo, decoyWt), 'gitdir'), join(decoy, '.git') + '\n');
  // 回链指向一个 .git 是 symlink 的目录：realpath 两侧会解析到同一个文件，只有「.git 必须是普通文件」挡得住
  const aliasWt = join(code, 'repo-alias');
  git(repo, 'worktree', 'add', '-b', 'alias', aliasWt);
  const alias = join(code, 'alias');
  mkdirSync(alias);
  symlinkSync(join(sibling, '.git'), join(alias, '.git'));
  writeFileSync(join(metaDirOf(repo, aliasWt), 'gitdir'), join(alias, '.git') + '\n');
  const listed = listLinkedWorktrees(repo).map(w => w.path).sort();
  assert.deepEqual(listed, [managed, sibling].sort());
});

test('判定不执行 git：folder-access.js 不 import child_process', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../app/src/sessions/folder-access.js'), 'utf8');
  assert.doesNotMatch(src, /from\s+['"](node:)?child_process['"]|(import|require)\(\s*['"](node:)?child_process['"]/,
    '.git/config 模型可写（core.fsmonitor 等能让 git 执行任意命令），授权判据里跑 git 等于把判定交给被判定的对象');
});
