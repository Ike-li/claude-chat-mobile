// tests/unit/git-worktree.test.mjs —— 会话 worktree 的建 / 查 / 清扫前检查
//
// 这一层跑的是**真 git**（docs/testing.md §2：git 工作区属于"mock 掉等于没测"的清单）。
// 夹具是 mkdtemp 出来的一次性仓库，每个用例一个，互不干扰。
//
// 产品判据（2026-09-11 定）：
// · 落点固定 <repo>/.claude/worktrees/<name>——那是 routeCwd 的派生放行集，建在别处等于建了也打不开
// · 删之前必须证明干净；脏的一律保留并说清剩了什么，**不提供强制删**
//   （Desktop 敢做定时 reaper 是因为它有 PR 合并状态可查，本仓没有，判"已合并"会判错）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  sanitizeWorktreeName,
  generateWorktreeName,
  worktreeNameFromMessage,
  listBranches,
  createSessionWorktree,
  inspectWorktreeCleanliness,
} from '../../app/src/files/git-worktree.js';

const ROOTS = [];
test.after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function makeRepo({ branches = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-wt-git-'));
  ROOTS.push(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-m', 'init');
  for (const b of branches) git('branch', b);
  return dir;
}

// ── 纯函数：名字 ────────────────────────────────────────────────────────────
// CLI 的 EnterWorktree 对 name 的约束是「每个 / 分段只允许字母数字点下划线连字符，总长 ≤64」。
// 我们自己建的名字必须落在同一集合里，否则 agent 之后想用 EnterWorktree 的 `path` 重进都进不去。
test('sanitizeWorktreeName: 非法字符收敛到 CLI 的字符集，且不产出空串', () => {
  assert.equal(sanitizeWorktreeName('feature/x'), 'feature-x', '斜杠会被当成目录分段，必须压平');
  assert.equal(sanitizeWorktreeName('修一个 bug'), 'bug', '中文与空格不在 CLI 允许集内');
  assert.equal(sanitizeWorktreeName('a..b__c--d'), 'a..b__c--d', '点/下划线/连字符是允许字符，不该被误杀');
  assert.equal(sanitizeWorktreeName('../../etc/passwd'), 'etc-passwd', '路径穿越必须压成单段');
  assert.equal(sanitizeWorktreeName('x'.repeat(200)).length, 64, '超长截到 64');
  assert.equal(sanitizeWorktreeName(''), null, '空 → null，交给调用方回落生成名');
  assert.equal(sanitizeWorktreeName('...'), null, '只剩分隔符 → null，不能产出一个 "." 这种危险名');
  assert.equal(sanitizeWorktreeName(null), null);
});

test('generateWorktreeName: 可读 + 唯一，落在 CLI 字符集内', () => {
  const a = generateWorktreeName(new Date('2026-09-11T08:30:00Z'), () => 'ab12');
  assert.equal(a, 'ccm-20260911-0830-ab12');
  assert.equal(sanitizeWorktreeName(a), a, '生成的名字必须自身就合法（否则建完 EnterWorktree 重进不去）');
  // 正对照：两次生成不同（随机段真的参与了）
  const b = generateWorktreeName(new Date('2026-09-11T08:30:00Z'), () => 'cd34');
  assert.notEqual(a, b);
});

// ── 纯函数：从第一条消息取名 ────────────────────────────────────────────────
// 对照 Claude Desktop 的 generateWorktreeName(branchHint)：名字跟任务内容相关，
// 在 `git worktree list` 和分支名里一眼认得出这棵树在干什么，时间戳做不到这件事。
test('worktreeNameFromMessage: 英文消息取可读 slug + 随机后缀', () => {
  const n = worktreeNameFromMessage('fix the login redirect bug', { rand: () => 'a3f2' });
  assert.equal(n, 'fix-the-login-a3f2');
  assert.equal(sanitizeWorktreeName(n), n, '生成的名字必须自身合法，否则 EnterWorktree 拿 path 重进不去');
});

// ★ 这一档最容易写错：用户是中文用户，消息大概率整句中文，而 CLI 的名字字符集**不含中文**。
//   不回落的话 slug 会塌成空串，再拼上随机后缀就成了一个 `-a3f2` 这种以连字符开头的名字。
test('worktreeNameFromMessage: 全中文回落时间戳名，不产出空 slug', () => {
  const n = worktreeNameFromMessage('修一个登录跳转的问题', { now: new Date('2026-09-11T08:30:00Z'), rand: () => 'b7c1' });
  assert.equal(n, 'ccm-20260911-0830-b7c1');
  assert.equal(sanitizeWorktreeName(n), n);
});

test('worktreeNameFromMessage: 中英混合只取得出来的那部分', () => {
  const n = worktreeNameFromMessage('修一下 login redirect 的问题', { rand: () => 'c2d9' });
  assert.equal(n, 'login-redirect-c2d9');
});

test('worktreeNameFromMessage: 超长消息截断，总长不超 CLI 上限', () => {
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const n = worktreeNameFromMessage(long, { rand: () => 'eeee' });
  assert.ok(n.length <= 64, `总长 ${n.length} 超了 CLI 的 64 上限`);
  assert.equal(sanitizeWorktreeName(n), n);
});

test('worktreeNameFromMessage: 空/非字符串/纯符号一律回落，不抛', () => {
  for (const bad of ['', '   ', null, undefined, 42, '!!! ???']) {
    const n = worktreeNameFromMessage(bad, { now: new Date('2026-09-11T08:30:00Z'), rand: () => 'f0f0' });
    assert.equal(n, 'ccm-20260911-0830-f0f0', `输入 ${JSON.stringify(bad)} 应回落`);
  }
});

// 随机后缀是防撞的唯一手段：同一条消息发两次（换个分支重开）不能生成同名，
// 否则第二次 createSessionWorktree 直接 exists 失败，用户看到的是"开不出新会话"。
test('worktreeNameFromMessage: 同一条消息两次生成不同名', () => {
  const a = worktreeNameFromMessage('fix login', { rand: () => '1111' });
  const b = worktreeNameFromMessage('fix login', { rand: () => '2222' });
  assert.notEqual(a, b);
  assert.ok(a.startsWith('fix-login-') && b.startsWith('fix-login-'));
});

// ── 真 git：列分支 ──────────────────────────────────────────────────────────
test('listBranches: 列出本地分支并标出当前分支', async () => {
  const repo = makeRepo({ branches: ['dev', 'feature/x'] });
  const r = await listBranches(repo);
  assert.equal(r.ok, true);
  assert.deepEqual([...r.branches].sort(), ['dev', 'feature/x', 'main']);
  assert.equal(r.current, 'main', '当前分支要标出来——UI 的源分支 chip 缺省显示它');
});

test('listBranches: 非 git 目录不抛，返回 ok:false 带 code', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'ccm-wt-plain-'));
  ROOTS.push(plain);
  const r = await listBranches(plain);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_git', '非 git 工作区要能被 UI 区分出来，不能和"命令失败"混为一谈');
});

// ── 真 git：建 worktree ─────────────────────────────────────────────────────
test('createSessionWorktree: 建在 .claude/worktrees/<name> 并切出新分支', async () => {
  const repo = makeRepo({ branches: ['dev'] });
  const r = await createSessionWorktree(repo, { name: 'feature-x', sourceBranch: 'dev' });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.path, join(repo, '.claude', 'worktrees', 'feature-x'),
    '落点必须是这个——它在仓库子树里（直接按子目录授权），也是抽屉按「托管 worktree」列会话、树删后推父仓的那条固定路径');
  assert.equal(existsSync(join(r.path, 'README.md')), true, 'worktree 里要有内容，不是空目录');
  assert.equal(r.branch, 'feature-x');

  // 新分支确实从 dev 切出来（而不是当前分支）
  const head = execFileSync('git', ['-C', r.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const devHead = execFileSync('git', ['-C', repo, 'rev-parse', 'dev'], { encoding: 'utf8' }).trim();
  assert.equal(head, devHead, '没从指定源分支切 = 用户选的分支被忽略了，而 UI 上还显示着它');
});

test('createSessionWorktree: 名字重复时不覆盖既有 worktree，报错退出', async () => {
  const repo = makeRepo();
  const first = await createSessionWorktree(repo, { name: 'dup', sourceBranch: 'main' });
  assert.equal(first.ok, true, first.error);
  const second = await createSessionWorktree(repo, { name: 'dup', sourceBranch: 'main' });
  assert.equal(second.ok, false, '静默复用别人的 worktree 会让两个会话写同一棵树');
  assert.equal(second.code, 'exists');
});

test('createSessionWorktree: 源分支不存在 → 明确报错，不回落到当前分支', async () => {
  const repo = makeRepo();
  const r = await createSessionWorktree(repo, { name: 'wt', sourceBranch: 'no-such-branch' });
  assert.equal(r.ok, false, '回落到当前分支 = 用户以为从 A 切、实际从 B 切，改完合并才发现');
  assert.equal(r.code, 'bad_source');
  assert.equal(existsSync(join(repo, '.claude', 'worktrees', 'wt')), false, '失败不得留下半个目录');
});

// sourceBranch 客户端可控，拼进 argv 时两处都没有 `--` 分隔选项区与位置参数——同域
// git-workspace.js 的 diff 路径一律带 `--`，这里是唯一没带的。git 本身不允许 ref 名以 `-`
// 开头，所以能通过这里的值不可能被当成选项，但补上 `--` 让这条防线从「依赖 git 行为」
// 变成「显式声明」，代价一行。这条测试锁住当前已经安全的行为，防加固时改出回归。
test('createSessionWorktree: 形似命令行选项的源分支名被安全拒绝（不被当成 git 选项解析）', async () => {
  const repo = makeRepo();
  for (const weird of ['-q', '--help', '-', '--all', '--upload-pack=x']) {
    const r = await createSessionWorktree(repo, { name: 'wt-opt', sourceBranch: weird });
    assert.equal(r.ok, false, `sourceBranch=${JSON.stringify(weird)} 应被拒`);
    assert.equal(r.code, 'bad_source', `不该被当成 git 选项吃掉，而是走「源分支不存在」`);
  }
});

test('createSessionWorktree: 非法名被拒，不落盘', async () => {
  const repo = makeRepo();
  for (const bad of ['..', '.', '', '   ']) {
    const r = await createSessionWorktree(repo, { name: bad, sourceBranch: 'main' });
    assert.equal(r.ok, false, `name=${JSON.stringify(bad)} 应被拒`);
    assert.equal(r.code, 'bad_name');
  }
});

// ── 真 git：干净检查（删之前唯一的依据）────────────────────────────────────
test('inspectWorktreeCleanliness: 干净的 worktree 报 clean', async () => {
  const repo = makeRepo();
  const { path } = await createSessionWorktree(repo, { name: 'clean-one', sourceBranch: 'main' });
  const r = await inspectWorktreeCleanliness(path);
  assert.equal(r.ok, true);
  assert.equal(r.clean, true);
  assert.deepEqual(r.entries, []);
});

test('inspectWorktreeCleanliness: 未提交改动必须报脏，并说清剩了什么', async () => {
  const repo = makeRepo();
  const { path } = await createSessionWorktree(repo, { name: 'dirty-one', sourceBranch: 'main' });
  writeFileSync(join(path, 'README.md'), '# changed\n');
  writeFileSync(join(path, 'new-file.txt'), 'untracked\n');

  const r = await inspectWorktreeCleanliness(path);
  assert.equal(r.clean, false, '报干净会让下一步把用户唯一的一份改动删掉');
  assert.equal(r.entries.length, 2, '改动过的与未跟踪的都要算进去');
  assert.ok(r.entries.some(e => e.includes('README.md')), `实际: ${JSON.stringify(r.entries)}`);
  assert.ok(r.entries.some(e => e.includes('new-file.txt')), '未跟踪文件也是"用户的东西"，不能漏报');
});

test('inspectWorktreeCleanliness: 未推送的本地提交也算不干净', async () => {
  const repo = makeRepo();
  const { path } = await createSessionWorktree(repo, { name: 'committed-one', sourceBranch: 'main' });
  writeFileSync(join(path, 'work.txt'), 'done\n');
  const git = (...args) => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' });
  git('add', '.');
  git('commit', '-m', 'work');

  const r = await inspectWorktreeCleanliness(path);
  assert.equal(r.clean, false,
    '工作树干净但有未合并回去的提交——删掉 worktree 会连分支上的提交一起变成不可达');
  assert.ok(r.unmergedCommits >= 1, `应报出未合并提交数，实际 ${r.unmergedCommits}`);
});

test('inspectWorktreeCleanliness: 路径不存在 → fail-closed（不得报 clean）', async () => {
  const repo = makeRepo();
  const r = await inspectWorktreeCleanliness(join(repo, '.claude', 'worktrees', 'never-made'));
  assert.equal(r.ok, false);
  assert.notEqual(r.clean, true, '查不到状态时报 clean，等于给删除放行——这里必须 fail-closed');
});

test('inspectWorktreeCleanliness: 目录在但不是 worktree → 同样不得报 clean', async () => {
  const repo = makeRepo();
  const fake = join(repo, '.claude', 'worktrees', 'not-a-worktree');
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, 'something.txt'), 'x');
  const r = await inspectWorktreeCleanliness(fake);
  assert.notEqual(r.clean, true);
});
