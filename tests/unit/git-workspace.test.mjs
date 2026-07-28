// tests/unit/git-workspace.test.mjs —— 工作区 git status/diff 只读能力（零 token）
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  parsePorcelainZ,
  classifyGitEntries,
  assertSafeRelPath,
  listGitChanges,
  readGitDiff,
  MAX_GIT_ENTRIES,
  MAX_GIT_DIFF_BYTES,
} from '../../src/files/git-workspace.js';

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
    // porcelain -z：XY + space + ORIG\0PATH\0
    assert.deepEqual(parsePorcelainZ('R  old.js\0new.js\0'), [
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
