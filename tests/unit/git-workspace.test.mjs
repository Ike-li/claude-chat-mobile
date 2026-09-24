// tests/unit/git-workspace.test.mjs —— 工作区 git status/diff 只读能力（零 token）
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parsePorcelainZ,
  classifyGitEntries,
  assertSafeRelPath,
  listGitChanges,
  readGitDiff,
  MAX_GIT_ENTRIES,
  MAX_GIT_DIFF_BYTES,
  riskyUncommittedPaths,
  overlapRiskyFiles,
  rewindDirtyOverlap,
} from '../../app/src/files/git-workspace.js';

describe('parsePorcelainZ：解析 git status --porcelain=v1 -z', () => {
  test('空输出 → 空数组', () => {
    assert.deepEqual(parsePorcelainZ(''), []);
    assert.deepEqual(parsePorcelainZ(null), []);
  });

  test('单路径：未暂存修改 / 已暂存 / 未跟踪', () => {
    const raw = [' M a.js', 'M  b.js', '?? c.js'].join('\0') + '\0';
    assert.deepEqual(parsePorcelainZ(raw), [
      { xy: ' M', path: 'a.js' },
      { xy: 'M ', path: 'b.js' },
      { xy: '??', path: 'c.js' },
    ]);
  });

  test('MM 同时改 index 与 worktree', () => {
    assert.deepEqual(parsePorcelainZ('MM both.js\0'), [{ xy: 'MM', path: 'both.js' }]);
  });

  test('rename：双路径，path 取新路径，保留 oldPath', () => {
    // porcelain -z 的字段顺序是 XY + space + PATH\0ORIG_PATH\0 —— 新路径在前，与非 -z 格式
    // 的 `XY ORIG -> PATH` 恰好相反（git 的历史怪异之处）。下面这串是 `git mv old.js new.js`
    // 后 `git status --porcelain=v1 -z` 的逐字节实测输出，不是构造值。
    assert.deepEqual(parsePorcelainZ('R  new.js\0old.js\0'), [
      { xy: 'R ', path: 'new.js', oldPath: 'old.js' },
    ]);
  });

  test('路径可含空格', () => {
    assert.deepEqual(parsePorcelainZ(' M my file.js\0'), [{ xy: ' M', path: 'my file.js' }]);
  });
});

describe('classifyGitEntries：三分 staged / unstaged / untracked', () => {
  test('按 X/Y 分桶；MM 双计；?? 仅 untracked', () => {
    const entries = [
      { xy: 'M ', path: 'staged.js' },
      { xy: ' M', path: 'work.js' },
      { xy: 'MM', path: 'both.js' },
      { xy: '??', path: 'new.js' },
      { xy: 'A ', path: 'added.js' },
      { xy: ' D', path: 'del.js' },
    ];
    const c = classifyGitEntries(entries);
    assert.deepEqual(c.staged.map(e => e.path).sort(), ['added.js', 'both.js', 'staged.js']);
    assert.deepEqual(c.unstaged.map(e => e.path).sort(), ['both.js', 'del.js', 'work.js']);
    assert.deepEqual(c.untracked.map(e => e.path), ['new.js']);
  });

  test('空列表', () => {
    assert.deepEqual(classifyGitEntries([]), { staged: [], unstaged: [], untracked: [], conflicted: [] });
  });

  test('冲突码（UU/AA/UD/DD）单独归入 conflicted，不落入 staged/unstaged', () => {
    const entries = [
      { xy: 'UU', path: 'uu.js' },
      { xy: 'AA', path: 'aa.js' },
      { xy: 'UD', path: 'ud.js' },
      { xy: 'DD', path: 'dd.js' },
    ];
    const c = classifyGitEntries(entries);
    assert.deepEqual(c.conflicted.map(e => e.path).sort(), ['aa.js', 'dd.js', 'ud.js', 'uu.js']);
    assert.deepEqual(c.staged, []);
    assert.deepEqual(c.unstaged, []);
  });
});

describe('assertSafeRelPath：拒绝绝对路径与 .. 逃逸', () => {
  const cwd = '/Users/you/repo';

  test('合法相对路径 → resolved 绝对路径', () => {
    assert.equal(assertSafeRelPath(cwd, 'src/a.js'), '/Users/you/repo/src/a.js');
    assert.equal(assertSafeRelPath(cwd, './src/a.js'), '/Users/you/repo/src/a.js');
  });

  test('绝对路径 / 盘符 / .. → null', () => {
    assert.equal(assertSafeRelPath(cwd, '/etc/passwd'), null);
    assert.equal(assertSafeRelPath(cwd, '../outside'), null);
    assert.equal(assertSafeRelPath(cwd, 'a/../../outside'), null);
    assert.equal(assertSafeRelPath(cwd, ''), null);
    assert.equal(assertSafeRelPath(cwd, null), null);
    assert.equal(assertSafeRelPath(cwd, ':(top)etc/passwd'), null, 'git pathspec magic');
    assert.equal(assertSafeRelPath(cwd, 'src/*.js'), null, 'glob magic');
  });
});

describe('listGitChanges：注入 execFile', () => {
  test('成功：分支 + 三分列表', async () => {
    const calls = [];
    const execFile = (cmd, args, opts, cb) => {
      calls.push({ cmd, args: [...args], opts });
      // args = ['-C', cwd, ...gitArgs]
      const gitArgs = args.slice(2);
      if (gitArgs[0] === 'symbolic-ref') return cb(null, 'main\n');
      if (gitArgs[0] === 'status') return cb(null, ' M a.js\0M  b.js\0?? c.js\0');
      return cb(new Error('unexpected'));
    };
    const r = await listGitChanges('/repo', { execFile });
    assert.equal(r.ok, true);
    assert.equal(r.branch, 'main');
    assert.equal(r.staged.length, 1);
    assert.equal(r.staged[0].path, 'b.js');
    assert.equal(r.unstaged[0].path, 'a.js');
    assert.equal(r.untracked[0].path, 'c.js');
    assert.equal(r.truncated, false);
    assert.ok(calls.every(c => c.cmd === 'git'));
    assert.ok(calls.some(c => c.args.includes('status') && c.args.includes('--porcelain=v1') && c.args.includes('-z')));
  });

  test('非 git 仓 → ok:false code not_git', async () => {
    const execFile = (_c, _a, _o, cb) => cb(new Error('not a git repository'));
    const r = await listGitChanges('/not-git', { execFile });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_git');
  });

  test('条目超 maxEntries → truncated', async () => {
    const many = Array.from({ length: 5 }, (_, i) => `?? f${i}.js`).join('\0') + '\0';
    const execFile = (_c, args, _o, cb) => {
      const gitArgs = args.slice(2);
      if (gitArgs[0] === 'symbolic-ref') return cb(null, 'dev\n');
      if (gitArgs[0] === 'status') return cb(null, many);
      return cb(new Error('x'));
    };
    const r = await listGitChanges('/repo', { execFile, maxEntries: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    const total = r.staged.length + r.unstaged.length + r.untracked.length;
    assert.ok(total <= 3);
  });

  test('缺 cwd → not_git/错误', async () => {
    const r = await listGitChanges('', { execFile: () => {} });
    assert.equal(r.ok, false);
  });
});

describe('readGitDiff：注入 execFile', () => {
  test('unstaged：git diff -- path', async () => {
    let seen;
    const execFile = (cmd, args, opts, cb) => {
      seen = { cmd, args: [...args], opts };
      cb(null, 'diff --git a/a.js b/a.js\n-old\n+new\n');
    };
    const r = await readGitDiff('/repo', 'a.js', 'unstaged', { execFile });
    assert.equal(r.ok, true);
    assert.equal(r.side, 'unstaged');
    assert.equal(r.path, 'a.js');
    assert.match(r.patch, /\+new/);
    assert.equal(r.empty, false);
    const gitArgs = seen.args.slice(2);
    assert.deepEqual(gitArgs, ['diff', '--', 'a.js']);
  });

  test('staged：git diff --cached -- path', async () => {
    let seen;
    const execFile = (_c, args, _o, cb) => {
      seen = args.slice(2);
      cb(null, 'diff --git a/b.js b/b.js\n+added\n');
    };
    const r = await readGitDiff('/repo', 'b.js', 'staged', { execFile });
    assert.equal(r.ok, true);
    assert.deepEqual(seen, ['diff', '--cached', '--', 'b.js']);
  });

  test('重命名（无内容变化）误判整体新增：复核 name-status 命中后带双路径 + -M 重新 diff', async () => {
    const execFile = (_c, args, _o, cb) => {
      const gitArgs = args.slice(2);
      if (gitArgs.includes('--name-status')) {
        return cb(null, 'R100\0old.js\0new.js\0');
      }
      if (gitArgs.includes('-M')) {
        return cb(null, 'diff --git a/old.js b/new.js\nsimilarity index 100%\nrename from old.js\nrename to new.js\n');
      }
      // 首次单路径 diff：误判成整体新增
      return cb(null, 'diff --git a/new.js b/new.js\nnew file mode 100644\nindex 0000000..1\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1 @@\n+hello\n');
    };
    const r = await readGitDiff('/repo', 'new.js', 'staged', { execFile });
    assert.equal(r.ok, true);
    assert.match(r.patch, /rename from old\.js/);
    assert.doesNotMatch(r.patch, /new file mode/);
  });

  test('复核：以 R/C 开头的普通文件名不得被当成状态码，吃掉其后的真 rename 记录', async () => {
    const execFile = (_c, args, _o, cb) => {
      const gitArgs = args.slice(2);
      if (gitArgs.includes('--name-status')) {
        // 实测格式：非-rename 条目占两段（`M\0path\0`），rename 占三段（`R100\0old\0new\0`）。
        // README.md 首字母是 R —— 遍历若不按条目长度推进，就会把这个【路径段】当成下一个
        // 状态码，连吃两段，真正的 rename 记录整条被跳过（README/CHANGELOG 类文件名极常见）。
        return cb(null, 'M\0README.md\0R100\0src/old.js\0src/new.js\0');
      }
      if (gitArgs.includes('-M')) {
        return cb(null, 'diff --git a/src/old.js b/src/new.js\nsimilarity index 100%\nrename from src/old.js\nrename to src/new.js\n');
      }
      return cb(null, 'diff --git a/src/new.js b/src/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.js\n');
    };
    const r = await readGitDiff('/repo', 'src/new.js', 'staged', { execFile });
    assert.equal(r.ok, true);
    assert.match(r.patch, /rename from src\/old\.js/);
    assert.doesNotMatch(r.patch, /new file mode/);
  });

  test('越界 path → bad_path，不 spawn', async () => {
    let spawned = false;
    const r = await readGitDiff('/repo', '../etc/passwd', 'unstaged', {
      execFile: () => { spawned = true; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'bad_path');
    assert.equal(spawned, false);
  });

  test('空 diff → empty:true', async () => {
    const execFile = (_c, _a, _o, cb) => cb(null, '');
    const r = await readGitDiff('/repo', 'a.js', 'unstaged', { execFile });
    assert.equal(r.ok, true);
    assert.equal(r.empty, true);
    assert.equal(r.patch, '');
  });

  test('二进制标记', async () => {
    const execFile = (_c, _a, _o, cb) => cb(null, 'Binary files a/x.png and b/x.png differ\n');
    const r = await readGitDiff('/repo', 'x.png', 'unstaged', { execFile });
    assert.equal(r.ok, true);
    assert.equal(r.binary, true);
  });

  test('超 maxBytes → truncated 截断', async () => {
    const big = 'diff --git\n' + 'x'.repeat(1000);
    const execFile = (_c, _a, _o, cb) => cb(null, big);
    const r = await readGitDiff('/repo', 'a.js', 'unstaged', { execFile, maxBytes: 50 });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.ok(r.patch.length <= 50);
  });

  test('非法 side → 错误', async () => {
    const r = await readGitDiff('/repo', 'a.js', 'nope', { execFile: () => {} });
    assert.equal(r.ok, false);
  });
});

describe('常量硬顶', () => {
  test('MAX_GIT_ENTRIES / MAX_GIT_DIFF_BYTES 合理', () => {
    assert.equal(MAX_GIT_ENTRIES, 500);
    assert.equal(MAX_GIT_DIFF_BYTES, 256 * 1024);
  });
});

// —— Rewind 的 G5：哪些未提交改动会被回退覆盖且【找不回来】 ——
// 判据不是「工作区 dirty 就警告」：开发中 dirty 是常态，天天弹等于训练用户忽略它。
// 只有「内容仅存在于工作区、git 对象库里没有」的那部分才真有风险。
test.describe('riskyUncommittedPaths（G5）', () => {
  const changes = (o) => ({ ok: true, staged: [], unstaged: [], untracked: [], conflicted: [], ...o });

  test('unstaged 改动算风险——回退覆盖后 git 里只有旧版本', () => {
    const r = riskyUncommittedPaths(changes({ unstaged: [{ path: 'src/a.js', xy: ' M' }] }));
    assert.deepEqual(r, ['src/a.js']);
  });

  test('untracked 文件算风险——git 里完全没有，覆盖/删除即永久丢失', () => {
    const r = riskyUncommittedPaths(changes({ untracked: [{ path: 'notes.md', xy: '??' }] }));
    assert.deepEqual(r, ['notes.md']);
  });

  test('冲突中的文件算风险——工作区内容是手工合并的中间结果', () => {
    const r = riskyUncommittedPaths(changes({ conflicted: [{ path: 'm.js', xy: 'UU' }] }));
    assert.deepEqual(r, ['m.js']);
  });

  test('【纯 staged 不算风险】——内容已进 index，覆盖后能从 git 取回', () => {
    const r = riskyUncommittedPaths(changes({ staged: [{ path: 'src/b.js', xy: 'M ' }] }));
    assert.deepEqual(r, [],
      '把 staged 也算进去 = 每次 git add 之后回退都弹警告，而那部分其实取得回来——'
      + '警告一旦变成常态就没人看了');
  });

  test('MM（staged 后又改）算风险：unstaged 那半没进 index', () => {
    // classifyGitEntries 会把 MM 同时放进 staged 与 unstaged，这里必须命中
    const r = riskyUncommittedPaths(changes({
      staged: [{ path: 'src/c.js', xy: 'MM' }],
      unstaged: [{ path: 'src/c.js', xy: 'MM' }],
    }));
    assert.deepEqual(r, ['src/c.js'], '同一路径只报一次，且不能因为它也在 staged 里就被漏掉');
  });

  test('非 git 仓库 / 读失败 → 空数组（静默放行，不拿失败当风险）', () => {
    assert.deepEqual(riskyUncommittedPaths({ ok: false, code: 'not_git' }), []);
    assert.deepEqual(riskyUncommittedPaths(null), []);
  });
});

test.describe('overlapRiskyFiles（G5 的交集判定）', () => {
  test('只报「回退会碰 且 改动没进 git」的那些', () => {
    const hit = overlapRiskyFiles(
      ['/repo/src/a.js', '/repo/src/untouched.js'],
      ['src/a.js', 'src/elsewhere.js'],
      '/repo',
    );
    assert.deepEqual(hit, ['src/a.js'],
      'elsewhere.js 脏但回退不碰它、untouched.js 会被回退但没脏——两者都不该报');
  });

  test('仓库根是 cwd 的祖先时也对得上（porcelain 路径恒相对仓库根）', () => {
    // 实测：git status --porcelain 在任何子目录下跑，输出的都是相对【仓库根】的路径
    const hit = overlapRiskyFiles(['/repo/sub/deep/f.txt'], ['sub/deep/f.txt'], '/repo');
    assert.deepEqual(hit, ['sub/deep/f.txt']);
  });

  test('同名不同层不误报', () => {
    const hit = overlapRiskyFiles(['/repo/x/b/c.txt'], ['b/c.txt'], '/repo');
    assert.deepEqual(hit, [],
      '按后缀匹配会把 /repo/x/b/c.txt 误判成 b/c.txt——必须以仓库根为基准拼绝对路径再比');
  });

  test('缺参数 → 空数组', () => {
    assert.deepEqual(overlapRiskyFiles(null, ['a'], '/repo'), []);
    assert.deepEqual(overlapRiskyFiles(['/repo/a'], [], '/repo'), []);
    assert.deepEqual(overlapRiskyFiles(['/repo/a'], ['a'], null), []);
  });
});

// ── 真 git：工作区是 monorepo 的一个子目录（2026-09-22 review P2）──────────────────────────
// `git status --porcelain` 的路径【恒相对仓库根】（git 文档：porcelain 不认 status.relativePaths），
// 且不带 pathspec 时列的是整仓改动。旧实现原样透传，于是工作区设成 `<仓库>/packages/foo` 时：
//   · 面板把范围外兄弟目录（packages/bar）的文件名也列了出来；
//   · 列表里的路径是 `packages/foo/src/a.js`，拿去 `git -C <foo> diff -- packages/foo/src/a.js`
//     被当成相对 cwd 的 pathspec，指到 foo/packages/foo/…，diff 一律为空。
// 路径门（status / diff 的 pathspec）属于「被测时必须是真的」那一类（docs/testing.md §2），这里起真 git。
describe('真 git：工作区是 monorepo 子目录', () => {
  // 隔离用户自己的 git 配置（全局 hooks、status.showUntrackedFiles 之类会改输出）；本文件独占进程，改 env 不外溢
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const roots = [];
  after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); }); // safe-rm: 下面 mkdtemp 出来的一次性仓库

  function makeMonorepo() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-git-mono-')));
    roots.push(root);
    const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
    git('init', '-q');
    const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
    put('README.md', 'root\n');
    put('packages/foo/src/a.js', 'a1\n');
    put('packages/foo/src/old.js', 'same content\n');
    put('packages/bar/b.js', 'b1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    // 工作区内：改一个、新建一个、暂存一个纯改名；工作区外：改仓库根与兄弟包
    put('packages/foo/src/a.js', 'a2\n');
    put('packages/foo/new.txt', 'n\n');
    git('mv', 'packages/foo/src/old.js', 'packages/foo/src/renamed.js');
    put('README.md', 'root changed\n');
    put('packages/bar/b.js', 'b2\n');
    return { root, foo: join(root, 'packages', 'foo') };
  }

  // 工作区目录本身整个未跟踪（仓库里刚新建的包）：普通模式下 status 只给一条折叠的 `?? packages/fresh/`，
  // 换算成相对工作区是空串，被丢掉后面板显示「没有改动」——修这个子目录问题之前至少还列出一条（2026-09-23 #151 review）。
  test('工作区目录整个未跟踪 → 列出其中的文件，而不是报告没有改动', async () => {
    const { root } = makeMonorepo();
    mkdirSync(join(root, 'packages', 'fresh', 'sub'), { recursive: true });
    writeFileSync(join(root, 'packages', 'fresh', 'a.txt'), 'a\n');
    writeFileSync(join(root, 'packages', 'fresh', 'sub', 'b.txt'), 'b\n');
    const r = await listGitChanges(join(root, 'packages', 'fresh'));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.untracked.map(e => e.path).sort(), ['a.txt', 'sub/b.txt']);
  });

  test('只列工作区子树里的改动，路径相对工作区——兄弟包与仓库根的文件名不外露', async () => {
    const { foo } = makeMonorepo();
    const r = await listGitChanges(foo);
    assert.equal(r.ok, true, JSON.stringify(r));
    const all = [...r.staged, ...r.unstaged, ...r.untracked, ...r.conflicted].map(e => e.path);
    assert.deepEqual(r.unstaged.map(e => e.path), ['src/a.js']);
    assert.deepEqual(r.untracked.map(e => e.path), ['new.txt']);
    assert.deepEqual(r.staged.map(e => e.path), ['src/renamed.js']);
    assert.equal(r.staged[0].oldPath, 'src/old.js', '改名两端都在工作区里：两端都相对工作区');
    assert.ok(!all.some(p => p.includes('bar') || p === 'README.md'),
      `工作区外的改动不该出现在这个工作区的面板里，实际 ${JSON.stringify(all)}`);
  });

  test('列表里的路径原样拿去取 diff，得到的是那个文件的真实改动（不是空）', async () => {
    const { foo } = makeMonorepo();
    const listed = (await listGitChanges(foo)).unstaged[0].path;
    const d = await readGitDiff(foo, listed, 'unstaged');
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.empty, false, `面板点开 ${listed} 看到的是空 diff——列表路径与 diff 的 pathspec 基准对不上`);
    assert.match(d.patch, /\+a2/);
  });

  test('子目录里的纯改名：diff 复核出改名，而不是显示成整份新增', async () => {
    const { foo } = makeMonorepo();
    const d = await readGitDiff(foo, 'src/renamed.js', 'staged');
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.match(d.patch, /rename from/, `应复核成改名，实际：\n${d.patch}`);
    assert.doesNotMatch(d.patch, /new file mode/);
  });

  test('工作区就是仓库根时行为不变：整仓改动、路径相对仓库根', async () => {
    const { root } = makeMonorepo();
    const r = await listGitChanges(root);
    assert.equal(r.ok, true);
    assert.deepEqual(r.unstaged.map(e => e.path).sort(), ['README.md', 'packages/bar/b.js', 'packages/foo/src/a.js']);
    assert.deepEqual(r.untracked.map(e => e.path), ['packages/foo/new.txt']);
  });

  // Rewind 的 G5 要的是另一种视角：回退会写回会话碰过的所有文件，不限于工作区子树。所以它对仓库根取改动，
  // 不能跟着面板一起收窄——否则会话改过兄弟包里的文件时，那里没提交的活被回退冲掉也不再预警。
  test('G5：工作区是子目录时，仍看得到回退会碰到的兄弟包里未提交的改动', async () => {
    const { root, foo } = makeMonorepo();
    const hit = await rewindDirtyOverlap(foo, [join(root, 'packages', 'bar', 'b.js'), join(root, 'packages', 'foo', 'src', 'a.js')]);
    assert.deepEqual(hit.sort(), ['packages/bar/b.js', 'packages/foo/src/a.js']);
  });

  test('G5：不是 git 仓库 → 空数组（静默放行）', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-git-plain-')));
    roots.push(plain);
    assert.deepEqual(await rewindDirtyOverlap(plain, [join(plain, 'x.txt')]), []);
  });
});
