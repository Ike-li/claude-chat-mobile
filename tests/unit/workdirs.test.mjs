// tests/unit/workdirs.test.mjs —— workdirs.js 纯逻辑 + I/O 薄壳单测（零网络、tmpdir 注入）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT,
  normalizeWorkdirEntries, loadWorkdirsFile, resolveWorkdirs, ensureWhitelisted, isWhitelisted,
  findProjectDirCollisions, resolveWorkdirsFilePath, pickWorkdirSource, resolveWorkdirSource,
} from '../../src/sessions/workdirs.js';

// ── normalizeWorkdirEntries（纯函数）──────────────────────────────────────
test.describe('normalizeWorkdirEntries', () => {
  test('全字符串 → 默认 sessionLimit', () => {
    const { entries, warnings } = normalizeWorkdirEntries(['/a', '/b']);
    assert.deepEqual(entries, [
      { path: '/a', sessionLimit: DEFAULT_SESSION_LIMIT },
      { path: '/b', sessionLimit: DEFAULT_SESSION_LIMIT },
    ]);
    assert.equal(warnings.length, 0);
  });

  test('混合 string / {path, sessionLimit}', () => {
    const { entries } = normalizeWorkdirEntries(['/a', { path: '/b', sessionLimit: 20 }]);
    assert.deepEqual(entries, [
      { path: '/a', sessionLimit: DEFAULT_SESSION_LIMIT },
      { path: '/b', sessionLimit: 20 },
    ]);
  });

  test('非法 sessionLimit（0/-1/1.5/字符串）→ 回默认 + warning', () => {
    for (const bad of [0, -1, 1.5, '6', null]) {
      const { entries, warnings } = normalizeWorkdirEntries([{ path: '/a', sessionLimit: bad }]);
      assert.equal(entries[0].sessionLimit, DEFAULT_SESSION_LIMIT, `sessionLimit=${bad} 应回默认`);
      assert.ok(warnings.length >= 1, `sessionLimit=${bad} 应有 warning`);
    }
  });

  test('sessionLimit 超上限 → 夹到 MAX + warning', () => {
    const { entries, warnings } = normalizeWorkdirEntries([{ path: '/a', sessionLimit: 9999 }]);
    assert.equal(entries[0].sessionLimit, MAX_SESSION_LIMIT);
    assert.ok(warnings.length >= 1);
  });

  test('非法条目（number/null/{}/无 path）→ skip + warning', () => {
    const { entries, warnings } = normalizeWorkdirEntries([42, null, {}, { sessionLimit: 5 }, '/ok']);
    assert.deepEqual(entries, [{ path: '/ok', sessionLimit: DEFAULT_SESSION_LIMIT }]);
    assert.ok(warnings.length >= 4);
  });

  test('空字符串 / 纯空白 path → skip', () => {
    const { entries } = normalizeWorkdirEntries(['', '   ', { path: '  ' }, '/ok']);
    assert.deepEqual(entries.map(e => e.path), ['/ok']);
  });

  test('path 去空白', () => {
    const { entries } = normalizeWorkdirEntries(['  /a  ', { path: ' /b ' }]);
    assert.deepEqual(entries.map(e => e.path), ['/a', '/b']);
  });

  test('非数组输入 → entries=[] + warning', () => {
    for (const bad of [null, undefined, {}, 'x', 42]) {
      const { entries, warnings } = normalizeWorkdirEntries(bad);
      assert.deepEqual(entries, []);
      assert.ok(warnings.length >= 1);
    }
  });

  test('重复 path → 首见优先（保留首个 sessionLimit）', () => {
    const { entries } = normalizeWorkdirEntries([
      { path: '/a', sessionLimit: 10 },
      { path: '/a', sessionLimit: 20 },
      '/b',
    ]);
    assert.deepEqual(entries, [
      { path: '/a', sessionLimit: 10 },
      { path: '/b', sessionLimit: DEFAULT_SESSION_LIMIT },
    ]);
  });
});

// ── loadWorkdirsFile（I/O 薄壳）────────────────────────────────────────────
test.describe('loadWorkdirsFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-wd-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));

  test('文件不存在 → null', () => {
    assert.equal(loadWorkdirsFile(join(dir, 'nope.json')), null);
  });

  test('坏 JSON → null', () => {
    const f = join(dir, 'bad.json');
    writeFileSync(f, '{not json');
    assert.equal(loadWorkdirsFile(f), null);
  });

  test('合法 JSON 数组 → entries', () => {
    const f = join(dir, 'good.json');
    writeFileSync(f, JSON.stringify(['/a', { path: '/b', sessionLimit: 3 }]));
    const res = loadWorkdirsFile(f);
    assert.equal(res.entries.length, 2);
    assert.equal(res.entries[1].sessionLimit, 3);
  });
});

// ── resolveWorkdirs（realpath + isDirectory 校验）───────────────────────────
test.describe('resolveWorkdirs', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccm-wd-res-'));
  test.after(() => rmSync(base, { recursive: true, force: true }));

  test('存在的目录 → dirs + limits Map（realpath 归一）', () => {
    const real = join(base, 'proj');
    mkdirSync(real);
    const { dirs, limits, warnings } = resolveWorkdirs([{ path: real, sessionLimit: 8 }]);
    assert.deepEqual(dirs, [realpathSync(real)]);
    assert.equal(limits.get(realpathSync(real)), 8);
    assert.equal(warnings.length, 0);
  });

  test('不存在的目录 → warn-skip', () => {
    const { dirs, warnings } = resolveWorkdirs([{ path: join(base, 'ghost'), sessionLimit: 6 }]);
    assert.deepEqual(dirs, []);
    assert.ok(warnings.length >= 1);
  });

  test('文件（非目录）→ skip', () => {
    const f = join(base, 'afile');
    writeFileSync(f, 'x');
    const { dirs } = resolveWorkdirs([{ path: f, sessionLimit: 6 }]);
    assert.deepEqual(dirs, []);
  });

  test('realpath 后重复 → 二次去重', () => {
    const real = join(base, 'proj2');
    mkdirSync(real);
    // 同一目录两条（一条带尾斜杠段），realpath 后应归一为一条
    const { dirs } = resolveWorkdirs([{ path: real, sessionLimit: 6 }, { path: join(real, '.'), sessionLimit: 9 }]);
    assert.equal(dirs.length, 1);
  });
});

// ── ensureWhitelisted（纯函数）───────────────────────────────────────────
// 背景：routeCwd 类回退逻辑可能落到「仍有 live 实例挂着、因此未被 reloadWorkdirs 归位」的已移除目录
// （该目录不在当前 workDirs 里）。新开会话前必须再夯一次白名单，否则「热移除目录仅拒新开」的不变量
// 会被绕过——同 session:new(#8) 的归位逻辑，抽成共享纯函数防各 handler 各自为政再漂移。
test.describe('ensureWhitelisted', () => {
  test('cwd 在白名单内 → 原样放行', () => {
    assert.equal(ensureWhitelisted('/a', ['/a', '/b']), '/a');
  });

  test('cwd 不在白名单内（已被热移除）→ 归位到白名单首位', () => {
    assert.equal(ensureWhitelisted('/removed', ['/a', '/b']), '/a');
  });
});

// ── isWhitelisted（纯函数：越界检测，不做归位；供 routeCwd 记审计信号 FR-23）────
test.describe('isWhitelisted', () => {
  test('白名单内 → true', () => {
    assert.equal(isWhitelisted('/a', ['/a', '/b']), true);
  });
  test('显式越界（不在白名单）→ false', () => {
    assert.equal(isWhitelisted('/evil', ['/a', '/b']), false);
  });
  test('空串 / 非字符串 → false（无 cwd 回退场景，非越界尝试）', () => {
    assert.equal(isWhitelisted('', ['/a']), false);
    assert.equal(isWhitelisted(undefined, ['/a']), false);
    assert.equal(isWhitelisted(null, ['/a']), false);
  });
});

test.describe('findProjectDirCollisions（SS-004）', () => {
  test('无碰撞 → []', () => {
    assert.deepEqual(findProjectDirCollisions(['/Users/a/proj', '/Users/a/other']), []);
  });
  test('/tmp/foo 与 /tmp-foo 编码相同 → 一组碰撞', () => {
    // 注意：测试用字面路径，不要求目录真实存在（纯编码函数）
    const c = findProjectDirCollisions(['/tmp/foo', '/tmp-foo', '/unique/path']);
    assert.equal(c.length, 1);
    assert.equal(c[0].encoded, '-tmp-foo');
    assert.deepEqual(c[0].paths.sort(), ['/tmp-foo', '/tmp/foo'].sort());
  });
});

// 工作区 cwd 合法性：只认 workdirs 白名单本身。git linked worktree 若要用，须显式写入 workdirs.json
// 成为独立条目——不再有「父仓下自动挂载 worktree 路径」的隐式放行。
test.describe('isWhitelisted / ensureWhitelisted（显式 workdir 白名单，无 worktree 隐式放行）', () => {
  const dirs = ['/repo/a', '/repo/b', '/repo/a-wt-promo'];
  test('白名单目录本身 → true', () => {
    assert.equal(isWhitelisted('/repo/a', dirs), true);
    assert.equal(isWhitelisted('/repo/a-wt-promo', dirs), true);
  });
  test('形似 worktree 但未列入白名单 → false（须手动加进 workdirs.json）', () => {
    assert.equal(isWhitelisted('/repo/a/.worktrees/promo', dirs), false);
    assert.equal(isWhitelisted('/repo/a/.claude/worktrees/feat', dirs), false);
  });
  test('ensureWhitelisted：在册路径原样保留；越界夯到 dirs[0]', () => {
    assert.equal(ensureWhitelisted('/repo/a-wt-promo', dirs), '/repo/a-wt-promo');
    assert.equal(ensureWhitelisted('/elsewhere', dirs), '/repo/a');
    assert.equal(ensureWhitelisted('/repo/a/.worktrees/promo', dirs), '/repo/a');
  });
});

// resolveWorkdirsFilePath：WORK_DIRS_FILE 是否已是绝对路径的判断。原 `startsWith('/')` 写法
// 在服务端跑在 Windows 上时会把 `C:\...` 误判成相对路径、错误拼进安装目录——改用双规范
// path.isAbsolute（POSIX + win32 都判一遍），与运行该判断的宿主 OS 无关，两种写法都能识别。
test.describe('resolveWorkdirsFilePath', () => {
  test('POSIX 绝对路径原样返回', () => {
    assert.equal(resolveWorkdirsFilePath('/etc/ccm/workdirs.json', '/app'), '/etc/ccm/workdirs.json');
  });
  test('Windows 绝对路径（带盘符）原样返回，不被误判成相对路径', () => {
    assert.equal(resolveWorkdirsFilePath('C:\\ccm\\workdirs.json', '/app'), 'C:\\ccm\\workdirs.json');
  });
  test('Windows UNC 路径原样返回', () => {
    assert.equal(resolveWorkdirsFilePath('\\\\server\\share\\workdirs.json', '/app'), '\\\\server\\share\\workdirs.json');
  });
  test('相对路径与 baseDir 拼接', () => {
    assert.equal(resolveWorkdirsFilePath('workdirs.json', '/app'), join('/app', 'workdirs.json'));
  });
});

// pickWorkdirSource：工作区列表来源的优先级。
// CLAUDE.md 的通用规则是「环境变量始终压过文件」，但此前 app.js 的 readWorkdirSource 把配置文件
// 里的内联 WORKDIRS 无条件排在最前——于是显式 `export WORK_DIRS=...` 收窄不了白名单。
// 2026-09-01 真机实测的后果：smoke 起的隔离实例继承了机主 ccm.config.json 里的 7 个真实工作区，
// 而它明明传了 WORK_DIRS=<临时目录>。
test.describe('pickWorkdirSource：env 压过配置文件（CLAUDE.md 通用规则）', () => {
  const inline = ['/from/config/a', '/from/config/b'];

  test('显式 WORK_DIRS 存在 → 用它，不理会内联 WORKDIRS', () => {
    const r = pickWorkdirSource({ envList: ['/from/env'], envFile: '', inline });
    assert.equal(r.kind, 'env-list');
    assert.deepEqual(r.value, ['/from/env']);
  });

  test('显式 WORK_DIRS_FILE 存在（无 WORK_DIRS）→ 用它，不理会内联 WORKDIRS', () => {
    const r = pickWorkdirSource({ envList: [], envFile: '/etc/ccm/workdirs.json', inline });
    assert.equal(r.kind, 'env-file');
    assert.equal(r.value, '/etc/ccm/workdirs.json');
  });

  test('WORK_DIRS 优先于 WORK_DIRS_FILE（两者都设时）', () => {
    const r = pickWorkdirSource({ envList: ['/from/env'], envFile: '/etc/ccm/workdirs.json', inline });
    assert.equal(r.kind, 'env-list');
  });

  test('两个 env 都没设 → 回落配置文件内联 WORKDIRS（生产路径，行为不变）', () => {
    const r = pickWorkdirSource({ envList: [], envFile: '', inline });
    assert.equal(r.kind, 'inline');
    assert.deepEqual(r.value, inline);
  });

  test('全都没有 → none + 空数组（调用方回落到只有 WORK_DIR）', () => {
    const r = pickWorkdirSource({ envList: [], envFile: '', inline: null });
    assert.equal(r.kind, 'none');
    assert.deepEqual(r.value, []);
  });

  test('空数组的 envList 不算「设了」，不得盖掉内联值', () => {
    // `WORK_DIRS=` 或 `WORK_DIRS=,,` 解析出来是空数组——那是「没设」，不是「设成空」。
    // 若把它当成设了，一个手滑的空变量就会把整份白名单清空。
    assert.equal(pickWorkdirSource({ envList: [], envFile: '', inline }).kind, 'inline');
  });

  test('缺省参数不崩', () => {
    assert.equal(pickWorkdirSource({}).kind, 'none');
    assert.equal(pickWorkdirSource().kind, 'none');
  });
});

// resolveWorkdirSource：把 pick 的选择兑现成 doctor D3 / 启动自检要用的 { result, from }。
// 2026-09-02 实测：server 已改 env 优先，CLI doctor 仍 `if (Array.isArray(inline)) return WORKDIRS`，
// `WORK_DIRS=/tmp/isolated node scripts/doctor.js` 扫的是机主真实工作区。
test.describe('resolveWorkdirSource：doctor 与 server 同一选择', () => {
  test('显式 WORK_DIRS 压过内联 WORKDIRS', () => {
    const r = resolveWorkdirSource({
      envList: ['/from/env'],
      envFile: '',
      inline: ['/from/config/a', '/from/config/b'],
    });
    assert.equal(r.from, 'WORK_DIRS');
    assert.deepEqual(r.result.entries.map(e => e.path), ['/from/env']);
  });

  test('两个 env 都没设 → 回落内联 WORKDIRS', () => {
    const r = resolveWorkdirSource({ envList: [], envFile: '', inline: ['/from/config'] });
    assert.equal(r.from, 'WORKDIRS');
    assert.deepEqual(r.result.entries.map(e => e.path), ['/from/config']);
  });

  test('getting-started / schema 不得再说内联 WORKDIRS 压过 WORK_DIRS env', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const zh = readFileSync(join(root, 'docs/getting-started.md'), 'utf8');
    const en = readFileSync(join(root, 'docs/getting-started.en.md'), 'utf8');
    const schema = readFileSync(join(root, 'src/ops/env-schema.js'), 'utf8');
    assert.doesNotMatch(zh, /优先级低于 `WORKDIRS`/);
    assert.doesNotMatch(en, /rank below `WORKDIRS`/);
    assert.doesNotMatch(schema, /优先级高于 WORK_DIRS_FILE 与 WORK_DIRS/);
  });
});
