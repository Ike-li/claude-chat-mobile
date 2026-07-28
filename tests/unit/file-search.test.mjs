// tests/unit/file-search.test.mjs —— @ 文件引用候选源（零 token：git 路径注入 execFile，遍历路径用真 tmpdir）
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  matchFiles,
  searchFiles,
  clearFileSearchCache,
  FILE_SEARCH_LIMIT,
  FILE_SEARCH_MAX_DEPTH,
} from '../../src/files/file-search.js';

describe('matchFiles：纯匹配排序', () => {
  const paths = ['src/app.js', 'src/widgets/app-icon.svg', 'src/app/config.js', 'src/agent/agent.js', 'README.md'];

  test('basename 子串命中排最前，优于「只在路径目录段命中」', () => {
    const r = matchFiles(paths, 'app');
    // src/app.js、src/widgets/app-icon.svg 的 basename 本身含 app（tier 0）；
    // src/app/config.js 的 basename 是 config.js，只在目录段含 app（tier 1）——排在后面。
    assert.deepEqual(r.slice(0, 2).sort(), ['src/app.js', 'src/widgets/app-icon.svg'].sort());
    assert.ok(r.indexOf('src/app.js') < r.indexOf('src/app/config.js'));
  });

  test('大小写不敏感', () => {
    assert.deepEqual(matchFiles(paths, 'APP').sort(), matchFiles(paths, 'app').sort());
  });

  test('子串命中优先于 subsequence 命中', () => {
    // 'agent' 是 agent.js 的子串命中；'agt' 只能靠 subsequence 命中 agent.js/approval-store.js(a-g-e-n-t 不连续也算)
    const r = matchFiles(['src/agent/agent.js', 'src/xyzagxentx.js'], 'agent');
    assert.equal(r[0], 'src/agent/agent.js');
  });

  test('subsequence 兜底：无子串命中时按字符顺序匹配', () => {
    const r = matchFiles(['src/agent/agent.js'], 'agtjs');
    assert.deepEqual(r, ['src/agent/agent.js']);
  });

  test('无命中 → 空数组', () => {
    assert.deepEqual(matchFiles(paths, 'zzz-nope'), []);
  });

  test('空 query：对齐 CLI @ 补全，返回路径字典序前 limit 条（不是空数组）', () => {
    const r = matchFiles(paths, '');
    assert.ok(r.length > 0);
    assert.ok(r.length <= FILE_SEARCH_LIMIT);
    // 字典序
    const sorted = [...r].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(r, sorted);
    // null / 空白 query 同空
    assert.deepEqual(matchFiles(paths, null), matchFiles(paths, ''));
    assert.deepEqual(matchFiles(paths, '   '), matchFiles(paths, ''));
  });

  test('空 paths → 空数组', () => {
    assert.deepEqual(matchFiles([], 'app'), []);
    assert.deepEqual(matchFiles([], ''), []);
  });

  test('limit 截断（默认 FILE_SEARCH_LIMIT）', () => {
    const many = Array.from({ length: 30 }, (_, i) => `file${i}.js`);
    assert.equal(matchFiles(many, 'file').length, FILE_SEARCH_LIMIT);
    assert.equal(matchFiles(many, 'file', { limit: 5 }).length, 5);
  });
});

describe('searchFiles：git ls-files 优先，失败回落真实目录遍历', () => {
  const BASE = join(tmpdir(), `ccm-filesearch-${process.pid}`);
  mkdirSync(BASE, { recursive: true });

  test('git 成功 → 用 git ls-files 的候选列表（不摸真实磁盘目录）', async () => {
    const cwd = join(BASE, 'git-ok');
    mkdirSync(cwd, { recursive: true });
    clearFileSearchCache();
    let seenArgs;
    const execFile = (cmd, args, opts, cb) => {
      seenArgs = args;
      cb(null, 'src/app.js\nsrc/agent/agent.js\nREADME.md\n');
    };
    const r = await searchFiles(cwd, 'app', { execFile });
    assert.deepEqual(r, ['src/app.js']);
    assert.deepEqual(seenArgs, ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard']);
  });

  test('git 失败（非仓库）→ 回落真实目录遍历', async () => {
    const cwd = join(BASE, 'no-git');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'app.js'), '');
    writeFileSync(join(cwd, 'README.md'), '');
    clearFileSearchCache();
    const execFile = (_c, _a, _o, cb) => cb(new Error('not a git repository'));
    const r = await searchFiles(cwd, 'app', { execFile });
    assert.deepEqual(r, ['src/app.js']);
  });

  test('遍历跳过 node_modules/.git/.worktrees/隐藏目录', async () => {
    const cwd = join(BASE, 'skip-dirs');
    mkdirSync(join(cwd, 'node_modules', 'app'), { recursive: true });
    mkdirSync(join(cwd, '.git'), { recursive: true });
    mkdirSync(join(cwd, '.worktrees', 'app'), { recursive: true });
    mkdirSync(join(cwd, '.hidden'), { recursive: true });
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'app', 'x.js'), '');
    writeFileSync(join(cwd, '.git', 'app-config'), '');
    writeFileSync(join(cwd, '.worktrees', 'app', 'x.js'), '');
    writeFileSync(join(cwd, '.hidden', 'app.js'), '');
    writeFileSync(join(cwd, 'src', 'app.js'), '');
    clearFileSearchCache();
    const execFile = (_c, _a, _o, cb) => cb(new Error('not a git repository'));
    const r = await searchFiles(cwd, 'app', { execFile });
    assert.deepEqual(r, ['src/app.js']);
  });

  test(`遍历深度硬顶 ${FILE_SEARCH_MAX_DEPTH} 层`, async () => {
    const cwd = join(BASE, 'deep');
    let dir = cwd;
    for (let i = 0; i < FILE_SEARCH_MAX_DEPTH + 3; i++) {
      dir = join(dir, `d${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `app${i}.js`), '');
    }
    clearFileSearchCache();
    const execFile = (_c, _a, _o, cb) => cb(new Error('not a git repository'));
    const r = await searchFiles(cwd, 'app', { execFile });
    // 深度硬顶意味着深层文件（app{N}.js，N ≥ FILE_SEARCH_MAX_DEPTH）不会被收进候选集
    assert.ok(r.every(p => {
      const depth = p.split('/').length - 1;
      return depth <= FILE_SEARCH_MAX_DEPTH;
    }));
    assert.ok(r.length > 0 && r.length < FILE_SEARCH_MAX_DEPTH + 3);
  });

  test('5s 内缓存候选列表，不重复 spawn git', async () => {
    const cwd = join(BASE, 'cache-check');
    mkdirSync(cwd, { recursive: true });
    clearFileSearchCache();
    let calls = 0;
    const execFile = (_c, _a, _o, cb) => { calls++; cb(null, 'app.js\n'); };
    await searchFiles(cwd, 'app', { execFile });
    await searchFiles(cwd, 'app', { execFile });
    assert.equal(calls, 1);
  });

  test('查询串只做匹配、不拼路径——不存在的候选不会凭空出现', async () => {
    const cwd = join(BASE, 'no-injection');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'app.js'), '');
    clearFileSearchCache();
    const execFile = (_c, _a, _o, cb) => cb(new Error('not a git repository'));
    const r = await searchFiles(cwd, '../../etc/passwd', { execFile });
    assert.deepEqual(r, []);
  });

  test('symlink 目录不递归跟随（isDirectory 的 withFileTypes 不 follow symlink）', async () => {
    const cwd = join(BASE, 'symlink-dir');
    const outside = join(BASE, 'symlink-target');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret-app.js'), '');
    mkdirSync(cwd, { recursive: true });
    try { symlinkSync(outside, join(cwd, 'link'), 'dir'); } catch { return; } // 平台不支持 symlink 时跳过
    clearFileSearchCache();
    const execFile = (_c, _a, _o, cb) => cb(new Error('not a git repository'));
    const r = await searchFiles(cwd, 'secret-app', { execFile });
    assert.deepEqual(r, []);
  });
});
