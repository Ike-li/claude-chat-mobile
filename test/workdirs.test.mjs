// test/workdirs.test.mjs —— workdirs.js 纯逻辑 + I/O 薄壳单测（零网络、tmpdir 注入）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import {
  DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT,
  normalizeWorkdirEntries, loadWorkdirsFile, resolveWorkdirs,
} from '../workdirs.js';

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
