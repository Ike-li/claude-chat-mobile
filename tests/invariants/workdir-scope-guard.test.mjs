// tests/v2/workdir-scope-guard.test.mjs —— 工作区范围裁决点单测
// 守护：SCOPE-01
// 测什么：isInScope 在 realpath 之后判定候选路径是否落在授权工作区内，拦截越界、../ 穿越、symlink 逃逸与前缀碰撞
// 不测什么 + 为什么：不测文件权限或内容敏感度——用户即 root，防线在范围门不在内容审查
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isInScope } from '../../app/src/files/workdir-scope-guard.js';

test.describe('SCOPE-01: workdir-scope-guard', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccm-v2-scope-'));
  test.after(() => rmSync(base, { recursive: true, force: true }));

  // 拓扑构造：
  // base/scope-a/
  // base/scope-a/sub/nested.txt
  // base/scope-ab/ (前缀碰撞)
  // base/outside/secret.txt
  // base/scope-a/link-out -> base/outside
  // base/scope-a/link-in -> base/scope-a/sub
  const scopeA = join(base, 'scope-a');
  const scopeAB = join(base, 'scope-ab');
  const outside = join(base, 'outside');

  mkdirSync(join(scopeA, 'sub'), { recursive: true });
  mkdirSync(scopeAB, { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(scopeA, 'sub', 'nested.txt'), 'in');
  writeFileSync(join(outside, 'secret.txt'), 'out');
  writeFileSync(join(scopeAB, 'collide.txt'), 'collide');

  if (process.platform !== 'win32') {
    symlinkSync(outside, join(scopeA, 'link-out'));
    symlinkSync(join(scopeA, 'sub'), join(scopeA, 'link-in'));
  }

  // macOS /var -> /private/var: 必须 realpathSync
  const realScopeA = realpathSync(scopeA);
  const realScopeAB = realpathSync(scopeAB);
  const scopeDirs = [realScopeA];

  test('授权目录根自身处于范围内', () => {
    assert.equal(isInScope(scopeA, scopeDirs), true);
    assert.equal(isInScope(realScopeA, scopeDirs), true);
  });

  test('授权目录内部的常规子路径处于范围内', () => {
    assert.equal(isInScope(join(scopeA, 'sub', 'nested.txt'), scopeDirs), true);
  });

  test('完全在范围外的路径拒绝', () => {
    assert.equal(isInScope(join(outside, 'secret.txt'), scopeDirs), false);
  });

  test('前缀碰撞不误判：scope-ab 不是 scope-a 的子路径（带 sep 边界判断）', () => {
    assert.equal(isInScope(join(scopeAB, 'collide.txt'), scopeDirs), false);
    assert.equal(isInScope(scopeAB, scopeDirs), false);
  });

  test('../ 相对路径逃逸出授权目录拒绝', () => {
    assert.equal(isInScope(join(scopeA, '..', 'outside', 'secret.txt'), scopeDirs), false);
  });

  test('symlink 指向范围外拒绝（字面在内、真实在外）', { skip: process.platform === 'win32' }, () => {
    assert.equal(isInScope(join(scopeA, 'link-out'), scopeDirs), false);
    assert.equal(isInScope(join(scopeA, 'link-out', 'secret.txt'), scopeDirs), false);
  });

  test('symlink 指向范围内放行（真实落点仍在范围内）', { skip: process.platform === 'win32' }, () => {
    assert.equal(isInScope(join(scopeA, 'link-in'), scopeDirs), true);
    assert.equal(isInScope(join(scopeA, 'link-in', 'nested.txt'), scopeDirs), true);
  });

  test('多工作区支持：候选落在任意一个授权工作区内均放行', () => {
    const multiScopes = [realScopeA, realScopeAB];
    assert.equal(isInScope(join(scopeAB, 'collide.txt'), multiScopes), true);
    assert.equal(isInScope(join(scopeA, 'sub', 'nested.txt'), multiScopes), true);
    assert.equal(isInScope(join(outside, 'secret.txt'), multiScopes), false);
  });

  test('不存在的路径 fail-closed 拒绝（无法确认真实落点）', () => {
    assert.equal(isInScope(join(scopeA, 'non-existent-file.txt'), scopeDirs), false);
  });

  test('非字符串或空白候选路径拒绝', () => {
    assert.equal(isInScope('', scopeDirs), false);
    assert.equal(isInScope('   ', scopeDirs), false);
    assert.equal(isInScope(null, scopeDirs), false);
    assert.equal(isInScope(undefined, scopeDirs), false);
    assert.equal(isInScope(123, scopeDirs), false);
  });

  test('空工作区或非法 scopeDirs 拒绝一切路径', () => {
    assert.equal(isInScope(scopeA, []), false);
    assert.equal(isInScope(scopeA, null), false);
    assert.equal(isInScope(scopeA, undefined), false);
  });
});
