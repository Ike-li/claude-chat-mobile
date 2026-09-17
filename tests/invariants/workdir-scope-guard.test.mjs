// tests/invariants/workdir-scope-guard.test.mjs —— 工作区范围裁决点单测
// 守护：SCOPE-01
// 测什么：① isInScope 在 realpath 之后判定候选路径是否落在授权工作区内，拦截越界、../ 穿越、symlink 逃逸与前缀碰撞
//         ② 白名单**写入侧**（validateEnvChanges 的 WORKDIRS 档）拒绝相对路径与非数组——
//            范围门再严，也挡不住一条把父目录整棵树写进白名单的配置
//         ③ resolveManagedWorktree 的派生放行面：只认「白名单目录下 .claude/worktrees/ 的直接子目录」，
//            深度固定为 1、不递归、symlink 真实落点必须仍在该目录子树内
//         ④ resolveDrivingCwd：会话中途换 cwd（EnterWorktree）的采信判据——合法集同 ③，
//            但失败方向是 fail-closed 返回 null，不像 routeCwd 那样回退
//         ⑤ instanceAuthorizedDirs：工作区被热移除后，其上已开实例保留自己那一个授权根（仅拒新开）
//         ⑥ resolveGoneWorktreeParent：worktree 目录被删、实例 cwd 悬空时推出父仓——合法形态集同 ③，
//            但**不 realpath**（目标已不存在），安全性改由「返回值恒取自 dirs」保证
// 不测什么 + 为什么：不测文件权限或内容敏感度——用户即 root，防线在范围门不在内容审查
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { isInScope } from '../../app/src/files/workdir-scope-guard.js';
import { validateEnvChanges } from '../../app/src/ops/env-schema.js';
import { resolveManagedWorktree, ensureWhitelisted, resolveDrivingCwd, instanceAuthorizedDirs, resolveGoneWorktreeParent } from '../../app/src/sessions/workdirs.js';

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

  // ── 过宽根（M2，2026-09-17 安全审查）────────────────────────────────────
  //
  // 【两道闸不同源就等于没有闸】装机向导硬拒家目录（setup.js 的 normalizeSetupWorkDir →
  // work_dir_is_home，README 也明写「不要把整个 Home 目录加入工作区」），而写入侧此前**只查
  // 是不是绝对路径**。于是装机时被硬拒的东西，运行时从一台已批准设备改一行就能写进去——
  // 而 WORKDIRS 是全表唯一的 reload:'hot'，**保存即生效、不需要重启**。
  //
  // 后果不是「多授权了一个目录」：FILE_EDIT 缺省是开的（TOGGLE_OFF：空=开），范围内的已存在
  // 文件可经文件编辑器直写、不过 Agent 审批链。把 $HOME 写进去，等于把 ~/.ssh、~/.aws、
  // 浏览器 profile 一并挂到远程入口上。
  //
  // 【与 SCOPE-03 的分工】那条管「启动时一个都解析不出 → 拒绝启动、绝不回落家目录」，
  // 管的是**回落**；这里管**显式写入**。两条路不同，家目录暴露的后果相同，都要堵。
  const homeDeps = (home = '/home/tester') => ({ ...envDeps(), home });

  test('家目录本身被拒——装机向导拒的东西，运行时不能从面板绕进来', () => {
    for (const home of ['/home/tester', '/Users/tester']) {
      const r = validateEnvChanges({ WORKDIRS: [home] }, homeDeps(home));
      assert.equal(r.ok, false, `${home} 是家目录，应被拒绝`);
      assert.match(r.results.find(x => x.key === 'WORKDIRS').message, /家目录/);
    }
  });

  test('家目录以 {path} 形态写入同样被拒——换个包装不该换判据', () => {
    const r = validateEnvChanges({ WORKDIRS: [{ path: '/home/tester', sessionLimit: 2 }] }, homeDeps());
    assert.equal(r.ok, false);
  });

  test('尾随斜杠不绕过——/home/tester/ 与 /home/tester 是同一个目录', () => {
    const r = validateEnvChanges({ WORKDIRS: ['/home/tester/'] }, homeDeps());
    assert.equal(r.ok, false, '规范化必须在比较之前做，否则加个斜杠就能绕过整道闸');
  });

  test('根与家目录之父被拒——它们比家目录还宽', () => {
    for (const bad of ['/', '/Users', '/home']) {
      const r = validateEnvChanges({ WORKDIRS: [bad] }, homeDeps());
      assert.equal(r.ok, false, `${bad} 过宽，应被拒绝`);
    }
  });

  // 反向：这道闸必须**只**拦过宽根。拦过头会让正常安装存不了配置，而那个症状
  // （「面板一保存就报错」）比漏拦更容易被当成 bug 绕过去——用户会去把这道闸删掉。
  test('家目录下的子目录照常放行（这道闸不是恒拒）', () => {
    for (const ok of ['/home/tester/code', '/home/tester/code/proj', '/tmp/x', '/opt/work']) {
      const r = validateEnvChanges({ WORKDIRS: [ok] }, homeDeps());
      assert.equal(r.ok, true, `${ok} 是正常工作区，不该被拦`);
    }
  });

  // 前缀碰撞：/home/tester2 与家目录 /home/tester 只差一个字符，按字符串前缀判会误伤。
  test('前缀相近但不同的目录不被误伤（/home/tester2 vs 家目录 /home/tester）', () => {
    const r = validateEnvChanges({ WORKDIRS: ['/home/tester2'] }, homeDeps());
    assert.equal(r.ok, true, '按路径段比较，不是按字符串前缀');
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

  // ④ 会话中途换 cwd（EnterWorktree / ExitWorktree）的采信判据。
  //
  // 【为什么不能复用 routeCwd】合法集同源，但**失败方向相反**：routeCwd 面对的是「前端传错了 cwd」，
  // 回退 viewingCwd 是纠正；这里面对的是「CLI 报了一个新 cwd」，没有任何安全回退可言——
  // 回退到别的目录等于把实例的驾驶轴指到一个 SDK 并不在那儿跑的地方。拒绝 = 保持原样。
  //
  // 【为什么必须校验】new_cwd 源自 EnterWorktree 的 path 参数，是会话内可被引导的值，
  // 与前端传来的路径同属用户可控面，SCOPE-01 原样适用。
  test('resolveDrivingCwd 采信白名单目录本身与其下的托管 worktree', () => {
    assert.equal(resolveDrivingCwd(realA, dirs), realA);
    assert.equal(resolveDrivingCwd(join(wtRoot, 'feature-x'), dirs), realpathSync(join(wtRoot, 'feature-x')));
    assert.equal(
      resolveDrivingCwd(join(repoB, '.claude', 'worktrees', 'other'), dirs),
      realpathSync(join(repoB, '.claude', 'worktrees', 'other')),
    );
  });

  test('resolveDrivingCwd 对越界路径 fail-closed 返回 null——不回退、不归位', () => {
    assert.equal(resolveDrivingCwd(outside, dirs), null, '越界目录被采信 = 实例驾驶轴被引到授权范围外');
    assert.equal(resolveDrivingCwd(sibling, dirs), null, '仓库外平级兄弟 worktree 须显式写进 WORKDIRS');
    assert.equal(resolveDrivingCwd(join(wtRoot, 'nested', 'deep'), dirs), null);
    assert.equal(resolveDrivingCwd('/definitely/not/here', dirs), null);
    assert.notEqual(resolveDrivingCwd(outside, dirs), realA, 'fail-closed 不是"归位到 dirs[0]"——那会静默换掉驾驶目标');
  });

  test('resolveDrivingCwd 挡 symlink 逃逸', { skip: process.platform === 'win32' }, () => {
    assert.equal(resolveDrivingCwd(join(wtRoot, 'escape'), dirs), null);
  });

  // ⑤ 热移除保护。产品判据是「工作区被移出 WORKDIRS 后，该目录上的已开会话继续运行、仅拒新开」
  // （CLAUDE.md 工作区热加载那段）。只拿新 workDirs 校验的话，这类实例中途 EnterWorktree 会被拒，
  // instance.cwd 停在旧值 —— 复发「历史消息加载失败」，而且是静默的。
  //
  // 【为什么这不是给范围门开口子】放行集只多出「该实例创建时所属的那个工作区」，而它的 CLI
  // 本来就在那个目录里跑着、早已能读写那里 —— 不新增任何能力。别的目录一律照旧拒。
  test('instanceAuthorizedDirs：白名单里有原授权根时原样返回', () => {
    assert.deepEqual(instanceAuthorizedDirs(dirs, realA), dirs);
    assert.deepEqual(instanceAuthorizedDirs(dirs, null), dirs);
  });

  test('instanceAuthorizedDirs：原授权根被热移除后仍保留给该实例', () => {
    const afterRemoval = [realB]; // realA 被移出 WORKDIRS，但它上面还有 live 实例
    assert.deepEqual(instanceAuthorizedDirs(afterRemoval, realA), [realB, realA]);
    assert.equal(
      resolveDrivingCwd(join(wtRoot, 'feature-x'), instanceAuthorizedDirs(afterRemoval, realA)),
      realpathSync(join(wtRoot, 'feature-x')),
      '热移除后该实例的 worktree 切换被拒 = instance.cwd 停在旧值，静默复发历史加载失败',
    );
  });

  test('instanceAuthorizedDirs：保留的只有它自己那一个根，别的仍越界', () => {
    const relaxed = instanceAuthorizedDirs([realB], realA);
    assert.equal(resolveDrivingCwd(outside, relaxed), null);
    assert.equal(resolveDrivingCwd(sibling, relaxed), null);
    assert.equal(resolveDrivingCwd(join(wtRoot, 'nested', 'deep'), relaxed), null);
  });

  test('resolveDrivingCwd 非法入参拒绝', () => {
    assert.equal(resolveDrivingCwd('', dirs), null);
    assert.equal(resolveDrivingCwd(null, dirs), null);
    assert.equal(resolveDrivingCwd(realA, []), null);
    assert.equal(resolveDrivingCwd(realA, null), null);
  });

  // ⑥ worktree 目录被删掉之后的归属推导（2026-09-13 真机形态，会话 5a8793ca）。
  //
  // 【为什么①~⑤全都答不了这个问题】它们一律先 realpath 再判，面对一条指向已删目录的 cwd
  // 只能 fail-closed 返回 null。那个 null 在四个消费点各自回落成不同的坏结果：文件面板报
  // 「路径不在授权范围内」、git 报 fatal、statusline 的 git 段整个消失、workspaceCwdOf 回落成
  // 悬空路径自身（于是该实例连父仓的归属都没了，抽屉里那个工作区下再也看不到它）。
  //
  // 【这个状态怎么来的】ExitWorktree 只认本会话 EnterWorktree 建的树，对 CCM 自己
  // `git worktree add` 建的那批直接 no-op（CLI 原文：there is no active EnterWorktree session
  // to exit）。模型于是改用 Bash `git worktree remove` —— 目录没了，而 Bash 的 cd 改不了会话 cwd
  // （CLI 每条命令后都打 `Shell cwd was reset to <会话 cwd>`），CwdChanged 一次都不会触发。
  //
  // 【为什么不 realpath，以及为什么这不违反 SCOPE-01】目标已经不存在，realpath 必然抛错——
  // 这条判据存在的前提就是它解析不了。安全性不靠 realpath 兜：**返回值恒取自 dirs**（已 realpath
  // 的白名单本身），候选路径一个字节都不进返回值，没有 symlink 逃逸面。代价是前缀比较要求 cwd
  // 与 dirs 同规范；生产路径上这一条成立（instance.cwd 恒来自 createSessionWorktree 或
  // resolveDrivingCwd，两者给的都是 realpath 后的串），万一不成立也只是判不出、退回今天的行为，
  // 失败方向是「不自愈」而不是「错放行」。
  test('resolveGoneWorktreeParent：worktree 目录已删时推出父仓', () => {
    assert.equal(
      resolveGoneWorktreeParent(join(wtRoot, 'was-removed'), dirs), realA,
      '推不出父仓 = 四个消费点各自回落，用户看到三条互不相干的技术错误而不是一句「worktree 已删除」',
    );
    assert.equal(
      resolveGoneWorktreeParent(join(realB, '.claude', 'worktrees', 'gone'), dirs), realB,
      '多工作区下必须归属到自己的父仓，不能恒取首项',
    );
  });

  test('resolveGoneWorktreeParent：路径还在时让位——不抢 resolveManagedWorktree 的活', () => {
    assert.equal(
      resolveGoneWorktreeParent(join(wtRoot, 'feature-x'), dirs), null,
      '对活着的 worktree 也回落父仓 = 文件面板永远看不到 worktree 里的改动，等于把这个功能废掉',
    );
    assert.equal(resolveGoneWorktreeParent(realA, dirs), null, '白名单目录自身不是 worktree');
  });

  test('resolveGoneWorktreeParent：合法形态集与③同一套，不因为“反正不存在”放宽', () => {
    assert.equal(
      resolveGoneWorktreeParent(join(base, 'nope', '.claude', 'worktrees', 'x'), dirs), null,
      '父段不在白名单里仍须拒——否则任何人构造一条不存在的路径都能问出一个白名单目录',
    );
    assert.equal(
      resolveGoneWorktreeParent(join(wtRoot, 'nested', 'deep-gone'), dirs), null,
      '深度固定为 1，和③同一条理由：允许再深一层就能无限派生',
    );
    assert.equal(resolveGoneWorktreeParent(wtRoot, dirs), null, 'worktrees 容器自身不是一棵 worktree');
    assert.equal(
      resolveGoneWorktreeParent(`${wtRoot}${sep}`, dirs), null,
      '带尾分隔符时 rest 为空——放行等于把整个 worktrees 容器当成一棵树',
    );
    assert.equal(resolveGoneWorktreeParent(join(base, 'repo-a-sibling-gone'), dirs), null, '仓库外平级兄弟不认');
    assert.equal(resolveGoneWorktreeParent('/definitely/not/here', dirs), null);
  });

  test('resolveGoneWorktreeParent：返回值恒是白名单成员（这条判据的全部安全性所在）', () => {
    for (const candidate of [join(wtRoot, 'a'), join(realB, '.claude', 'worktrees', 'b')]) {
      const got = resolveGoneWorktreeParent(candidate, dirs);
      assert.ok(dirs.includes(got), `返回了白名单外的路径 ${got} —— 候选串渗进返回值就等于开了越界口子`);
    }
  });

  test('resolveGoneWorktreeParent 非法入参拒绝', () => {
    assert.equal(resolveGoneWorktreeParent('', dirs), null);
    assert.equal(resolveGoneWorktreeParent(null, dirs), null);
    assert.equal(resolveGoneWorktreeParent(123, dirs), null);
    assert.equal(resolveGoneWorktreeParent(join(wtRoot, 'gone'), []), null);
    assert.equal(resolveGoneWorktreeParent(join(wtRoot, 'gone'), null), null);
  });
});
