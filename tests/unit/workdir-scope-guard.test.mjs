// tests/unit/workdir-scope-guard.test.mjs —— WorkdirScopeGuard 范围判定单测（docs/design.md，承接 AD-12/FR-23）
// isInScope(candidate, scopeDirs)：web 侧目录可达性（会话发起/文件浏览/附件输入）的唯一裁决点。
// 与 §5.5 canonicalize 刻意相反——此处必须 resolve 符号链接（范围是权限边界，不 resolve 则一个指向
// 范围外的 symlink 即逃逸）；用真实临时目录 + 真实 symlink 测试（同 tests/unit/workdirs.test.mjs 的 tmpdir 惯例），
// 不 mock fs——symlink 解析行为本身就是被测对象，mock 掉就测不出真问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isInScope } from '../../src/files/workdir-scope-guard.js';

test.describe('isInScope', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccm-scope-'));
  test.after(() => rmSync(base, { recursive: true, force: true }));

  // 目录布局：
  //   base/scope-a/           ← 授权目录
  //   base/scope-a/sub/file.txt
  //   base/scope-ab/          ← 与 scope-a 仅一字之差，测边界前缀不误判
  //   base/outside/secret.txt ← 范围外
  //   base/scope-a/link-out   → 指向 base/outside（symlink 逃逸）
  //   base/scope-a/link-in    → 指向 base/scope-a/sub（symlink 但仍在范围内）
  const scopeA = join(base, 'scope-a');
  const scopeAB = join(base, 'scope-ab');
  const outside = join(base, 'outside');
  mkdirSync(join(scopeA, 'sub'), { recursive: true });
  mkdirSync(scopeAB, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(scopeA, 'sub', 'file.txt'), 'hi');
  writeFileSync(join(outside, 'secret.txt'), 'shh');
  writeFileSync(join(scopeAB, 'other.txt'), 'x');
  symlinkSync(outside, join(scopeA, 'link-out'));
  symlinkSync(join(scopeA, 'sub'), join(scopeA, 'link-in'));

  const scopeDirs = [realpathSync(scopeA)]; // 授权目录本身即已 realpath 归一（同 resolveWorkdirs 现状）

  test('候选路径 == 授权目录本身 → true', () => {
    assert.equal(isInScope(scopeA, scopeDirs), true);
  });

  test('授权目录内的子路径 → true', () => {
    assert.equal(isInScope(join(scopeA, 'sub', 'file.txt'), scopeDirs), true);
  });

  test('完全在范围外的路径 → false', () => {
    assert.equal(isInScope(join(outside, 'secret.txt'), scopeDirs), false);
  });

  test('边界前缀不误判：scope-ab 不是 scope-a 的子路径（防 /a/b 误匹配 /a/bc）', () => {
    assert.equal(isInScope(join(scopeAB, 'other.txt'), scopeDirs), false);
  });

  test('../ 逃逸：字面路径含 .. 跳出授权目录 → false', () => {
    assert.equal(isInScope(join(scopeA, '..', 'outside', 'secret.txt'), scopeDirs), false);
  });

  test('symlink 指向范围外 → false（即便字面路径在授权目录内）', () => {
    assert.equal(isInScope(join(scopeA, 'link-out'), scopeDirs), false);
    assert.equal(isInScope(join(scopeA, 'link-out', 'secret.txt'), scopeDirs), false);
  });

  test('symlink 指向范围内（仍落在授权目录下）→ true', () => {
    assert.equal(isInScope(join(scopeA, 'link-in'), scopeDirs), true);
    assert.equal(isInScope(join(scopeA, 'link-in', 'file.txt'), scopeDirs), true);
  });

  test('嵌套授权目录：候选落在其中一个即 true', () => {
    const nestedScopeDirs = [realpathSync(scopeA), realpathSync(scopeAB)];
    assert.equal(isInScope(join(scopeAB, 'other.txt'), nestedScopeDirs), true);
  });

  test('空集合 → 全拒', () => {
    assert.equal(isInScope(scopeA, []), false);
  });

  test('不存在的路径 → false（fail-closed，无法确认范围）', () => {
    assert.equal(isInScope(join(scopeA, 'does-not-exist.txt'), scopeDirs), false);
  });

  test('非字符串 / 空字符串候选 → false', () => {
    assert.equal(isInScope('', scopeDirs), false);
    assert.equal(isInScope(null, scopeDirs), false);
    assert.equal(isInScope(undefined, scopeDirs), false);
  });

  test('非数组 scopeDirs → false', () => {
    assert.equal(isInScope(scopeA, null), false);
    assert.equal(isInScope(scopeA, undefined), false);
  });
});
