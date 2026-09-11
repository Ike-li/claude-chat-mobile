// tests/invariants/workdir-scope-guard.test.mjs —— 工作区范围裁决点单测
// 守护：SCOPE-01
// 测什么：① isInScope 在 realpath 之后判定候选路径是否落在授权工作区内，拦截越界、../ 穿越、symlink 逃逸与前缀碰撞
//         ② 白名单**写入侧**（validateEnvChanges 的 WORKDIRS 档）拒绝相对路径与非数组——
//            范围门再严，也挡不住一条把父目录整棵树写进白名单的配置
// 不测什么 + 为什么：不测文件权限或内容敏感度——用户即 root，防线在范围门不在内容审查
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isInScope } from '../../app/src/files/workdir-scope-guard.js';
import { validateEnvChanges } from '../../app/src/ops/env-schema.js';

test.describe('SCOPE-01: workdir-scope-guard', () => {
  const base = mkdtempSync(join(tmpdir(), 'ccm-inv-scope-'));
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

// ── 写入侧（2026-09-10 打开手机端编辑面时补）────────────────────────────────
//
// WORKDIRS 是 claude 的文件作用域边界，不是展示用的列表：写进去的每一项都会成为
// isInScope 的锚点。范围门守的是「候选路径有没有越界」，管不到「锚点本身是不是被写歪了」。
//
// 这一档此前**没有任何测试**，而 env-schema.js:408 的注释明写它是修过的坑：
// 实测 ['..'] 能通过校验，realpath 相对 cwd 解析后把仓库父目录整棵树放进白名单。
// 手机端编辑器打开之前必须先把这道钉住——UI 可达之后，写歪的成本从「手改配置文件」
// 降到「点两下」。
const envDeps = () => ({ current: {}, shellEnv: {} });

test.describe('SCOPE-01: WORKDIRS 写入侧', () => {
  test('相对路径被拒——realpath 会相对 cwd 解析，把父目录整棵树放进白名单', () => {
    for (const bad of [['..'], ['../..'], ['relative/path'], ['.']]) {
      const r = validateEnvChanges({ WORKDIRS: bad }, envDeps());
      assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒绝`);
    }
  });

  test('绝对路径放行（正对照：这道闸不是恒拒）', () => {
    const r = validateEnvChanges({ WORKDIRS: ['/tmp/a', { path: '/tmp/b', sessionLimit: 2 }] }, envDeps());
    assert.equal(r.ok, true, '合法的绝对路径列表必须能存');
  });

  // ★ 这一条正是当初把 list 标成 readonly 的理由：塞一个字符串进去，
  //   下游 normalizeWorkdirEntries 的 Array.isArray 判否 → 静默回落旧白名单，
  //   用户看到「保存成功」而配置根本没变。写入侧必须当场拒绝。
  test('非数组被拒——静默回落比报错更糟（用户看到「保存成功」而配置没变）', () => {
    // 注意 null 不在此列：它在 validateEnvChanges 的协议里表示**删除该配置项**
    // （env-schema.js「删除不做类型校验」那一行），不是一个写歪的值。
    for (const bad of ['/tmp/a', '/tmp/a,/tmp/b', 42, { path: '/tmp/a' }, true]) {
      const r = validateEnvChanges({ WORKDIRS: bad }, envDeps());
      assert.equal(r.ok, false, `${JSON.stringify(bad)} 不是数组，应被拒绝`);
    }
  });

  // 把 null 的语义单独钉住：它与「写了个非法值」是两件事，合并进上一条会让那条测试
  // 在协议变化时给出误导性的红。
  test('null 表示删除该配置项，按协议放行（不是一个写歪的值）', () => {
    assert.equal(validateEnvChanges({ WORKDIRS: null }, envDeps()).ok, true);
  });

  test('条目里混入空串/空对象被拒，不静默跳过', () => {
    for (const bad of [['/tmp/a', ''], ['/tmp/a', {}], ['/tmp/a', null]]) {
      const r = validateEnvChanges({ WORKDIRS: bad }, envDeps());
      assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒绝`);
    }
  });

  test('sessionLimit 非法被拒——normalizeWorkdirEntries 只 warn-skip 并回退默认值，写入侧要严', () => {
    for (const n of [0, -1, 1.5, 'x']) {
      const r = validateEnvChanges({ WORKDIRS: [{ path: '/tmp/a', sessionLimit: n }] }, envDeps());
      assert.equal(r.ok, false, `sessionLimit=${JSON.stringify(n)} 应被拒绝`);
    }
  });
});
