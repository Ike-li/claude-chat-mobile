// tests/invariants/workdir-scope-guard.test.mjs —— 工作区范围裁决点单测
// 守护：SCOPE-01
// 测什么：① isInScope 在 realpath 之后判定候选路径是否落在授权工作区内，拦截越界、../ 穿越、symlink 逃逸与前缀碰撞
//         ② 白名单**写入侧**（validateEnvChanges 的 WORKDIRS 档）拒绝相对路径与非数组——
//            范围门再严，也挡不住一条把父目录整棵树写进白名单的配置
//         ③ resolveManagedWorktree 的派生放行面：只认「白名单目录下 .claude/worktrees/ 的直接子目录」，
//            深度固定为 1、不递归、symlink 真实落点必须仍在该目录子树内
// 不测什么 + 为什么：不测文件权限或内容敏感度——用户即 root，防线在范围门不在内容审查
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isInScope } from '../../app/src/files/workdir-scope-guard.js';
import { validateEnvChanges } from '../../app/src/ops/env-schema.js';
import { resolveManagedWorktree, ensureWhitelisted } from '../../app/src/sessions/workdirs.js';

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

// ── 派生放行面（2026-09-11 worktree 会话可见性）────────────────────────────
//
// 在此之前，routeCwd 只认 `dirs.includes(cwd)` 精确匹配，CLI 托管的 worktree
// （`EnterWorktree` / `--worktree` / agent isolation 的默认落点 `<repo>/.claude/worktrees/<name>`）
// 的会话即便列得出来也打不开——cwd 会被换成父仓，再拿父仓 cwd 去 resume 一个
// transcript 不在那个 project 目录下的会话。
//
// 派生放行把这一种形态放进来，**边界必须是 SCOPE-01 原本就成立的那条**：
// 放行集恒为白名单目录的子树，所以「候选路径 realpath 后落在授权工作区内」没有被放松。
// 真正新增的自由度只有一个——深度固定为 1 的那一层目录名。下面每条都在钉这个自由度不外溢。
test.describe('SCOPE-01: 托管 worktree 的派生放行', () => {
  // ★ base 必须先 realpath 再往下构造。macOS 的 /var -> /private/var 会让「候选未解析、dirs 已解析」
  //   成为默认形态，而在那个形态下**所有**候选都因前缀不匹配返回 null——symlink 逃逸那条期望的
  //   恰好也是 null，于是它永远绿。第一版就是这么写的：注入「删掉 realpath」后红的是正对照，
  //   symlink 那条纹丝不动。未解析形态另有一条用例专门覆盖（见末尾）。
  const rawBase = mkdtempSync(join(tmpdir(), 'ccm-inv-wt-'));
  const base = realpathSync(rawBase);
  test.after(() => rmSync(base, { recursive: true, force: true }));

  // base/repo-a/.claude/worktrees/feature-x      ← 托管 worktree（唯一该放行的形态）
  // base/repo-a/.claude/worktrees/nested/deep    ← 再深一层
  // base/repo-a/sub                              ← 普通子目录
  // base/repo-a-sibling                          ← 仓库外平级兄弟 worktree（产品判据：不放行）
  // base/repo-b                                  ← 第二个白名单目录
  // base/outside                                 ← 范围外
  // base/repo-a/.claude/worktrees/escape -> base/outside   ← symlink 逃逸
  const repoA = join(base, 'repo-a');
  const repoB = join(base, 'repo-b');
  const outside = join(base, 'outside');
  const sibling = join(base, 'repo-a-sibling');
  const wtRoot = join(repoA, '.claude', 'worktrees');

  mkdirSync(join(wtRoot, 'feature-x'), { recursive: true });
  mkdirSync(join(wtRoot, 'nested', 'deep'), { recursive: true });
  mkdirSync(join(repoA, 'sub'), { recursive: true });
  mkdirSync(join(repoB, '.claude', 'worktrees', 'other'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  if (process.platform !== 'win32') symlinkSync(outside, join(wtRoot, 'escape'));

  // dirs 恒为已 realpath 的白名单（workdirs.js normalizeWorkdirEntries 的出参契约）
  const realA = realpathSync(repoA);
  const realB = realpathSync(repoB);
  const dirs = [realA, realB];

  test('托管 worktree 放行并归属到父仓——正对照：这道判据不是恒拒', () => {
    assert.equal(
      resolveManagedWorktree(join(wtRoot, 'feature-x'), dirs)?.parent ?? null, realA,
      '.claude/worktrees/ 的直接子目录必须放行，否则 worktree 会话仍然打不开',
    );
    assert.equal(
      resolveManagedWorktree(join(repoB, '.claude', 'worktrees', 'other'), dirs)?.parent ?? null, realB,
      '多工作区下必须归属到自己的父仓，不能恒取首项',
    );
  });

  test('再深一层不放行——否则 worktree 里再套一层就能无限派生出授权路径', () => {
    assert.equal(resolveManagedWorktree(join(wtRoot, 'nested', 'deep'), dirs), null);
  });

  test('worktrees 容器自身不是 worktree，不放行', () => {
    assert.equal(resolveManagedWorktree(wtRoot, dirs), null);
    assert.equal(resolveManagedWorktree(join(repoA, '.claude'), dirs), null);
  });

  test('白名单目录自身走精确匹配那条路，派生判据不认领', () => {
    assert.equal(
      resolveManagedWorktree(repoA, dirs), null,
      '父仓自身返回非 null 会让调用方把普通工作区误当 worktree 归属',
    );
  });

  test('普通子目录不放行——派生只认 .claude/worktrees 这一条固定路径', () => {
    assert.equal(resolveManagedWorktree(join(repoA, 'sub'), dirs), null);
  });

  test('仓库外的平级兄弟 worktree 不放行——那类须显式写进 WORKDIRS', () => {
    assert.equal(
      resolveManagedWorktree(sibling, dirs), null,
      '放行它等于让放行集跳出白名单子树，SCOPE-01 的前提当场不成立',
    );
  });

  test('symlink 指向范围外拒绝（字面在 worktrees 下、真实落点在外）', { skip: process.platform === 'win32' }, () => {
    assert.equal(
      resolveManagedWorktree(join(wtRoot, 'escape'), dirs), null,
      '拿未解析路径比前缀 = macOS 上静默永远放行，这条是那个坑的负片',
    );
  });

  test('不存在的路径 fail-closed——无法确认真实落点', () => {
    assert.equal(resolveManagedWorktree(join(wtRoot, 'never-created'), dirs), null);
  });

  test('非法入参拒绝', () => {
    assert.equal(resolveManagedWorktree('', dirs), null);
    assert.equal(resolveManagedWorktree(null, dirs), null);
    assert.equal(resolveManagedWorktree(123, dirs), null);
    assert.equal(resolveManagedWorktree(join(wtRoot, 'feature-x'), []), null);
    assert.equal(resolveManagedWorktree(join(wtRoot, 'feature-x'), null), null);
  });

  // routeCwd 与 ensureWhitelisted 在 8 个 handler 里是成对出现的（`ensureWhitelisted(routeCwd(x), dirs)`）。
  // 只让 routeCwd 认派生形态，放行会被紧随其后的 ensureWhitelisted 原样撤销——归位到 dirs[0]，
  // 症状与完全没改一模一样。两道闸必须认同一套合法集，这两条各钉一侧。
  test('ensureWhitelisted 不把托管 worktree 当热移除目录归位', () => {
    assert.equal(
      ensureWhitelisted(join(wtRoot, 'feature-x'), dirs), realpathSync(join(wtRoot, 'feature-x')),
      '归位到 dirs[0] 会让 routeCwd 刚放行的 worktree cwd 当场作废',
    );
  });

  test('ensureWhitelisted 对真正的越界路径仍归位到首项（正对照：没把闸拆了）', () => {
    assert.equal(ensureWhitelisted(join(base, 'outside'), dirs), realA);
    assert.equal(ensureWhitelisted(join(wtRoot, 'nested', 'deep'), dirs), realA);
    assert.equal(ensureWhitelisted('/definitely/not/here', dirs), realA);
  });

  // realpath 在这条判据里是双向的：上面那条挡 symlink 逃逸，这条证明它同时是功能——
  // 候选来自前端/注册表时未必解析过（macOS 上 /var 与 /private/var 是同一个目录的两种写法），
  // 不解析就比前缀会把合法的 worktree 判成越界，症状是「会话列得出来、点开被弹回父仓」。
  test('候选未解析也能放行——realpath 不只是防逃逸，也是功能', { skip: rawBase === base }, () => {
    assert.equal(
      resolveManagedWorktree(join(rawBase, 'repo-a', '.claude', 'worktrees', 'feature-x'), dirs)?.parent ?? null,
      realA,
    );
  });
});
