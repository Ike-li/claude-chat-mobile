// tests/invariants/folder-access.test.mjs —— 已连接文件夹的授权判据：子目录可达、禁区、scratch
// 守护：SCOPE-05（已连接文件夹的子目录经 realpath 后即合法 cwd；嵌套归最长根；禁区子树永不合法；scratch 只认 mkdtemp 单段目录）
// 测什么：resolveAuthorizedCwd 在一次性目录上的真 fs / 真 symlink 行为——放行什么、拒绝什么、返回的规范路径与归属。
// 不测什么 + 为什么：① worktree 的双向回验在 worktree-ownership.test.mjs（SCOPE-04）
//   ② 「显式越界要拒绝而不是回落」是 server 各 handler 的接线，属 S2（tests/invariants/server/）
// 槽位：S1（一次性目录上的真 fs）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveAuthorizedCwd, SCRATCH_DIR_RE, isWithin } from '../../app/src/sessions/folder-access.js';

const ROOTS = [];
test.after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

// raw = 未 realpath 的 mkdtemp 路径（macOS 上是 /var/…），base = realpath 后的（/private/var/…）。
function fixture() {
  const raw = mkdtempSync(join(tmpdir(), 'ccm-folder-access-'));
  ROOTS.push(raw);
  const base = realpathSync(raw);
  const a = join(base, 'scope-a');
  mkdirSync(join(a, 'x', 'y'), { recursive: true });
  mkdirSync(join(base, 'scope-ab'), { recursive: true });
  mkdirSync(join(base, 'outside'), { recursive: true });
  return { raw, base, a };
}

test('连接文件夹本身：放行，项目就是它自己', () => {
  const { a } = fixture();
  const auth = resolveAuthorizedCwd(a, { connected: [a] });
  assert.deepEqual({ kind: auth?.kind, path: auth?.path, root: auth?.root, projectKey: auth?.projectKey, scopeRoot: auth?.scopeRoot },
    { kind: 'connected', path: a, root: a, projectKey: a, scopeRoot: a });
});

test('子目录直接可达（官方语义）：放行，项目是子目录本身，范围是连接根', () => {
  const { a } = fixture();
  const sub = join(a, 'x', 'y');
  const auth = resolveAuthorizedCwd(sub, { connected: [a] });
  assert.equal(auth?.kind, 'connected', '子目录不放行 = 连接了 ~/code 也开不了 ~/code/foo 的会话');
  assert.equal(auth.root, a);
  assert.equal(auth.projectKey, sub, '子文件夹里的会话在抽屉里自成一个项目');
  assert.equal(auth.scopeRoot, a);
});

test('嵌套连接时归最长的那个根', () => {
  const { a } = fixture();
  const inner = join(a, 'x');
  assert.equal(resolveAuthorizedCwd(join(inner, 'y'), { connected: [a, inner] })?.root, inner);
  assert.equal(resolveAuthorizedCwd(join(inner, 'y'), { connected: [inner, a] })?.root, inner, '与配置顺序无关');
});

test('前缀碰撞：/scope-ab 不在 /scope-a 之下', () => {
  const { base, a } = fixture();
  assert.equal(resolveAuthorizedCwd(join(base, 'scope-ab'), { connected: [a] }), null,
    '按字符串前缀判（少了分隔符边界）会把邻居目录当成子目录');
});

test('symlink 逃逸：连接文件夹里一个指向外面的链接不放行', () => {
  const { base, a } = fixture();
  const link = join(a, 'escape');
  symlinkSync(join(base, 'outside'), link);
  assert.equal(resolveAuthorizedCwd(link, { connected: [a] }), null, '按词法判就会被一个 symlink 带出连接范围');
});

test('symlink 指回连接范围内：放行，返回的是真实路径', () => {
  const { a } = fixture();
  const link = join(a, 'alias');
  symlinkSync(join(a, 'x'), link);
  assert.equal(resolveAuthorizedCwd(link, { connected: [a] })?.path, join(a, 'x'));
});

test('未解析的候选路径（/var vs /private/var）照样认，返回 realpath 后的值', () => {
  const { raw, a } = fixture();
  const auth = resolveAuthorizedCwd(join(raw, 'scope-a', 'x'), { connected: [a] });
  assert.equal(auth?.path, join(a, 'x'), '存未解析的路径会让 getProjectDir 算出另一个 project 目录、静默查空');
});

test('禁区：连接范围内的禁区子树不是合法 cwd', () => {
  const { a } = fixture();
  const data = join(a, 'data');
  mkdirSync(join(data, 'inner'), { recursive: true });
  const ctx = { connected: [a], forbidden: [data] };
  assert.equal(resolveAuthorizedCwd(data, ctx), null);
  assert.equal(resolveAuthorizedCwd(join(data, 'inner'), ctx), null);
  assert.ok(resolveAuthorizedCwd(join(a, 'x'), ctx), '禁区只挡它自己的子树，不连坐兄弟目录');
});

test('不存在的路径、普通文件：拒绝', () => {
  const { a } = fixture();
  writeFileSync(join(a, 'file.txt'), 'x');
  assert.equal(resolveAuthorizedCwd(join(a, 'missing'), { connected: [a] }), null);
  assert.equal(resolveAuthorizedCwd(join(a, 'file.txt'), { connected: [a] }), null);
});

test('非法入参：拒绝', () => {
  const { a } = fixture();
  for (const bad of [undefined, null, '', 42, {}]) assert.equal(resolveAuthorizedCwd(bad, { connected: [a] }), null);
});

test('连接之外：拒绝', () => {
  const { base, a } = fixture();
  assert.equal(resolveAuthorizedCwd(join(base, 'outside'), { connected: [a] }), null);
  assert.equal(resolveAuthorizedCwd(base, { connected: [a] }), null, '父目录不因为有个子目录被连接就被放行');
});

test('extraRoots：已被热移除的工作区，对它上面已开的会话仍放行', () => {
  const { base, a } = fixture();
  const removed = join(base, 'outside');
  assert.equal(resolveAuthorizedCwd(removed, { connected: [a] }), null);
  assert.equal(resolveAuthorizedCwd(removed, { connected: [a], extraRoots: [removed] })?.root, removed);
});

test('scratch：根本身是启动键，mkdtemp 形态的单段目录及其子目录放行，其它都不认', () => {
  const { base, a } = fixture();
  const root = join(base, 'scratch-workspaces');
  mkdirSync(root);
  const ctx = { connected: [a], scratchRoot: root };
  const dir = mkdtempSync(join(root, 'scratch-2026-09-24-'));
  mkdirSync(join(dir, 'sub'));
  mkdirSync(join(root, 'not-a-scratch'));
  mkdirSync(join(root, 'scratch-2026-09-24-toolong7'));

  assert.equal(SCRATCH_DIR_RE.test(dir.slice(root.length + 1)), true, '判据要认 mkdtemp 实际产出的名字');
  assert.equal(resolveAuthorizedCwd(root, ctx)?.kind, 'scratch-root');
  const auth = resolveAuthorizedCwd(dir, ctx);
  assert.equal(auth?.kind, 'scratch');
  assert.equal(auth.projectKey, root, '所有无文件夹会话归到同一个「无文件夹」项目');
  assert.equal(auth.scopeRoot, dir, '文件范围是这一个 scratch，不是整个 scratch 根');
  assert.equal(resolveAuthorizedCwd(join(dir, 'sub'), ctx)?.scopeRoot, dir);
  assert.equal(resolveAuthorizedCwd(join(root, 'not-a-scratch'), ctx), null);
  assert.equal(resolveAuthorizedCwd(join(root, 'scratch-2026-09-24-toolong7'), ctx), null);
});

test('scratch 形态的 symlink 指到外面：按真实路径判，不放行', () => {
  const { base, a } = fixture();
  const root = join(base, 'scratch-workspaces');
  mkdirSync(root);
  symlinkSync(join(base, 'outside'), join(root, 'scratch-2026-09-24-AbC123'));
  assert.equal(resolveAuthorizedCwd(join(root, 'scratch-2026-09-24-AbC123'), { connected: [a], scratchRoot: root }), null);
});

// 生产上 scratch 根永远是配着的：配了它，连接文件夹里的路径必须照常放行（变异实测：把
// `scratchRoot && isWithin(...)` 改成 `||` 之后，所有连接路径都掉进 scratch 分支被拒，而之前没有任何用例红）。
test('配着 scratch 根时，连接文件夹里的路径照常放行', () => {
  const { base, a } = fixture();
  const root = join(base, 'scratch-workspaces');
  mkdirSync(root);
  const auth = resolveAuthorizedCwd(join(a, 'x'), { connected: [a], scratchRoot: root });
  assert.equal(auth?.kind, 'connected');
  assert.equal(auth.path, join(a, 'x'));
});

test('isWithin：带分隔符边界，非法入参一律 false', () => {
  assert.equal(isWithin('/a/b', '/a'), true);
  assert.equal(isWithin('/a', '/a'), true);
  assert.equal(isWithin('/ab', '/a'), false);
  assert.equal(isWithin('/a/b', '/'), true, '根目录的子路径');
  for (const [c, p] of [['', '/a'], ['/a', ''], [null, '/a'], ['/a', undefined], [42, '/']]) {
    assert.equal(isWithin(c, p), false, `isWithin(${JSON.stringify(c)}, ${JSON.stringify(p)}) 应为 false`);
  }
});

test('scratch 根没传或不存在：scratch 形态的路径一律不认', () => {
  const { base, a } = fixture();
  const root = join(base, 'scratch-workspaces');
  mkdirSync(root);
  const dir = mkdtempSync(join(root, 'scratch-2026-09-24-'));
  assert.equal(resolveAuthorizedCwd(dir, { connected: [a] }), null);
  assert.equal(resolveAuthorizedCwd(dir, { connected: [a], scratchRoot: join(base, 'nope') }), null);
});
