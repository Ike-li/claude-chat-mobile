// tests/invariants/workdir-scope-guard.test.mjs —— 工作区范围裁决点单测
// 守护：SCOPE-01
// 测什么：① isInScope 在 realpath 之后判定候选路径是否落在授权工作区内，拦截越界、../ 穿越、symlink 逃逸与前缀碰撞
//         ② 白名单**写入侧**（validateEnvChanges 的 WORKDIRS 档）拒绝相对路径与非数组——
//            范围门再严，也挡不住一条把父目录整棵树写进白名单的配置
//         ⑥ resolveGoneWorktreeParent：worktree 目录被删、实例 cwd 悬空时推出父仓——**不 realpath**
//            （目标已不存在），安全性改由「返回值恒取自 dirs」保证
// 不测什么 + 为什么：① 不测文件权限或内容敏感度——用户即 root，防线在范围门不在内容审查
//   ② 原来的 ③④⑤（resolveManagedWorktree / ensureWhitelisted / resolveDrivingCwd / instanceAuthorizedDirs）
//      2026-09-24 随「已连接的文件夹」退役：cwd 授权统一由 sessions/folder-access.js 的 resolveAuthorizedCwd 判，
//      用例在 folder-access.test.mjs（SCOPE-05：子目录可达、禁区、scratch、热移除保护）与
//      worktree-ownership.test.mjs（SCOPE-04：worktree 双向回验）。其中「再深一层 / 普通子目录 / 平级兄弟不放行」
//      三条按新语义翻转，各自换上了新反例（symlink 逃逸、禁区、伪造与单侧指针、没有 .git 的兄弟目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { isInScope } from '../../app/src/files/workdir-scope-guard.js';
import { validateEnvChanges } from '../../app/src/ops/env-schema.js';
import { resolveGoneWorktreeParent } from '../../app/src/sessions/workdirs.js';

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

  // WORK_DIRS_FILE 决定授权工作区从【哪个文件】读。能从面板 / CLI 设它，就能把工作区换成任意一个已存在
  // 文件里写的东西——这一组过宽根校验只看 WORKDIRS 的值，对它形同虚设；那份文件的内容还是热加载的
  // （2026-09-22 review P2）。该键已被 WORKDIRS 取代，只保留「清空」这一个写法。
  test('WORK_DIRS_FILE 只能清空、不能设置——指向任意已存在的文件就绕过了这一组过宽根校验', () => {
    const deps = { ...homeDeps(), fileExists: () => true };
    const r = validateEnvChanges({ WORK_DIRS_FILE: '/tmp/some/workdirs.json' }, deps);
    assert.equal(r.ok, false, '设成一个已存在的文件也得拒：mustExist 只证明文件在，不证明里面写的工作区合规');
    assert.match(r.results.find(x => x.key === 'WORK_DIRS_FILE').message, /清空|WORKDIRS|工作区列表/);
    // 清空在写入协议里是 null（前端把清空的输入框转成 null 再发，同上面「null 表示删除该配置项」那条）
    assert.equal(validateEnvChanges({ WORK_DIRS_FILE: null }, deps).ok, true, '清空要放行：那是从旧部署迁出的一步');
  });

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

  // ★ 只去尾随斜杠是不够的（2026-09-17 由 PR #80 的 review 抓到，实测确认可绕过）。
  // 下游 resolveWorkdirs 会 realpathSync 每一项，于是 `/home/tester/.` 这种**等价但非规范**的
  // 写法通过写入侧校验之后，会被还原成家目录本身放进白名单——闸形同虚设。
  // 判据必须先归一再比：词法归一（resolve）吃掉 . / .. / 重复斜杠，realpath 吃掉 symlink。
  test('等价的非规范路径不得绕过——下游会 realpath 还原成家目录', () => {
    for (const bad of [
      '/home/tester/.',            // 尾随 .
      '/home/tester/./',           // 尾随 ./
      '/tmp/../home/tester',       // 经 .. 绕回来
      '/home/tester/../tester',    // 出去再回来
      '/home//tester',             // 重复斜杠
    ]) {
      const r = validateEnvChanges({ WORKDIRS: [bad] }, homeDeps());
      assert.equal(r.ok, false, `${bad} 归一之后就是家目录，应被拒`);
    }
    // 根的等价写法同样要拦
    for (const bad of ['/.', '/./', '//', '/tmp/..']) {
      const r = validateEnvChanges({ WORKDIRS: [bad] }, homeDeps());
      assert.equal(r.ok, false, `${bad} 归一之后就是根，应被拒`);
    }
  });

  test('归一之后落在家目录下的子目录仍照常放行（归一不等于一律拒）', () => {
    for (const ok of ['/home/tester/./code', '/home/tester/code/../code', '/home/tester//code']) {
      const r = validateEnvChanges({ WORKDIRS: [ok] }, homeDeps());
      assert.equal(r.ok, true, `${ok} 归一之后是 /home/tester/code，应放行`);
    }
  });

  // symlink 是词法归一吃不掉的那一档：resolve() 只看字符串，realpath 才看得到落点。
  // 而 resolveWorkdirs 用的正是 realpathSync —— 两侧判据不同源就还是能绕。
  test('指向家目录的 symlink 被拒（词法归一吃不掉，必须 realpath）', { skip: process.platform === 'win32' }, () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'ccm-inv-homelink-'));
    try {
      const fakeHome = realpathSync(mkdtempSync(join(tmpBase, 'home-')));
      const link = join(tmpBase, 'looks-like-a-project');
      symlinkSync(fakeHome, link);
      const r = validateEnvChanges({ WORKDIRS: [link] }, { ...envDeps(), home: fakeHome });
      assert.equal(r.ok, false, 'symlink 的真实落点是家目录，下游 realpath 之后就是家目录本身');
    } finally {
      rmSync(tmpBase, { recursive: true, force: true }); // safe-rm: 本用例 mkdtemp 出来的一次性目录
    }
  });

  // 反向：指向普通目录的 symlink 不该被误伤。realpath 一旦引入，很容易把「解析失败」
  // 或「解析到别处」一律判成危险。
  test('指向普通目录的 symlink 照常放行（realpath 不是用来一律拒的）', { skip: process.platform === 'win32' }, () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'ccm-inv-projlink-'));
    try {
      const fakeHome = realpathSync(mkdtempSync(join(tmpBase, 'home-')));
      const project = realpathSync(mkdtempSync(join(tmpBase, 'proj-')));
      const link = join(tmpBase, 'project-link');
      symlinkSync(project, link);
      const r = validateEnvChanges({ WORKDIRS: [link] }, { ...envDeps(), home: fakeHome });
      assert.equal(r.ok, true, '落点是普通目录，应放行');
    } finally {
      rmSync(tmpBase, { recursive: true, force: true }); // safe-rm: 本用例 mkdtemp 出来的一次性目录
    }
  });

  // 还不存在的目录：realpath 会抛。那时退回词法归一的结果继续判，而不是放行或一律拒——
  // 用户完全可能先把工作区配好再去建目录。
  test('尚不存在的路径按词法归一判，不因 realpath 抛错而放行', () => {
    assert.equal(validateEnvChanges({ WORKDIRS: ['/home/tester/no-such-dir-yet'] }, homeDeps()).ok, true);
    assert.equal(validateEnvChanges({ WORKDIRS: ['/home/tester/no-such/../..'] }, homeDeps()).ok, false,
      '归一之后是 /home，realpath 抛了也得拦住');
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
test.describe('SCOPE-01: worktree 目录已删时的父仓推导', () => {
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
  // 授权判据，两者给的都是 realpath 后的串），万一不成立也只是判不出、退回今天的行为，
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

  test('resolveGoneWorktreeParent：路径还在时让位——活着的 worktree 由授权判据认', () => {
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
