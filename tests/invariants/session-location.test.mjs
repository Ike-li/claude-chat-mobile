// 守护：SESSION-03（外部迁移后定位 transcript）· SCOPE-01（候选仍受授权约束）
// 测什么：一次性目录上的真实文件定位、撞名归属与多候选拒绝。
// 不测什么 + 为什么：Socket 接线归 S2，Desktop 真迁移归手工联动验证。
// 槽位：S1（真 fs，无 CLI）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as location from '../../app/src/sessions/session-location.js';
import { createSessionRecovery } from '../../app/src/server/session-recovery.js';
import { createMirrorEngine } from '../../app/src/server/mirror-engine.js';
import { getProjectDir } from '../../app/src/sessions/history.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-location-')));
test.after(() => rmSync(root, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录
let seq = 0;
function fixture() {
  const repo = join(root, `repo-${seq++}`);
  const old = join(repo, '.claude/worktrees/old');
  const next = join(repo, '.claude/worktrees/next');
  const baseDir = join(root, `projects-${seq}`);
  for (const dir of [repo, old, next, baseDir]) mkdirSync(dir, { recursive: true });
  const authorize = cwd => cwd === repo || cwd.startsWith(repo + '/') ? { path: cwd, projectKey: repo } : null;
  const write = (cwd, id = 'session-473', owner = cwd) => {
    const dir = join(baseDir, getProjectDir(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: owner, message: { role: 'user', content: 'moved history' } }) + '\n');
  };
  return { cwd: old, projectCwd: repo, id: 'session-473', old, next, repo, baseDir, authorize, write };
}
test('旧 worktree → 兄弟 worktree，不能从旧树往下找', async () => {
  const f = fixture(); f.write(f.next);
  assert.deepEqual(await location.resolveSessionLocation(f), { status: 'found', cwd: f.next, relocated: true });
});
test('退出 worktree 后从主仓恢复', async () => {
  const f = fixture(); f.write(f.repo);
  assert.equal((await location.resolveSessionLocation(f)).cwd, f.repo);
  assert.equal((await location.resolveSessionLocation({ ...f, projectCwd: undefined })).cwd, f.repo, '没有显式项目锚点时使用授权判据给出的归属');
});
test('多个有效候选拒绝猜测；明确选定的有效目录仍可打开', async () => {
  const f = fixture(); f.write(f.repo); f.write(f.next);
  assert.equal((await location.resolveSessionLocation(f)).status, 'ambiguous');
  assert.deepEqual(await location.resolveSessionLocation({ ...f, cwd: f.next }), { status: 'found', cwd: f.next, relocated: false });
});
test('无归属证据、编码撞名和未授权候选均不自动认领', async () => {
  const f = fixture(); f.write(f.next, f.id, null);
  assert.equal((await location.resolveSessionLocation(f)).status, 'not_found');
  // 真实撞名：两条不同 cwd 确实编码到同一个 project 目录。
  const foreignOwner = f.next.replace('/.claude/', '/_claude/');
  assert.notEqual(foreignOwner, f.next);
  assert.equal(getProjectDir(foreignOwner), getProjectDir(f.next));
  f.write(f.next, f.id, foreignOwner);
  assert.equal((await location.resolveSessionLocation(f)).status, 'not_found');
  f.write(f.next);
  assert.equal((await location.resolveSessionLocation({ ...f, authorize: c => c === f.next ? null : f.authorize(c) })).status, 'not_found');
  assert.equal((await location.resolveSessionLocation({ ...f, authorize: c => c === f.next ? { path: c, projectKey: c } : f.authorize(c) })).status, 'not_found', '已显式连接、独立归组的 worktree 不是原项目的迁移候选');
});

test('多候选与迁移竞态分别给出可操作提示', () => {
  assert.match(location.locationError({ status: 'ambiguous' }), /多份记录/);
  assert.match(location.locationError({ status: 'stale' }), /变化/);
  assert.match(location.locationError({ status: 'scope' }), /不在已连接/);
  assert.equal(location.locationError({ status: 'not_found' }), '会话不存在');
});

test('scratch 项目根只是枚举入口，不能被认作会话驾驶目录', async () => {
  const f = fixture();
  const scratch = join(f.repo, 'scratch-2026-10-30-ABC123');
  mkdirSync(scratch);
  f.write(f.repo); f.write(scratch);
  const authorize = cwd => cwd === f.repo
    ? { kind: 'scratch-root', path: cwd, projectKey: f.repo }
    : { ...f.authorize(cwd), kind: 'scratch', scopeRoot: cwd };
  const result = await location.resolveSessionLocation({ ...f, authorize });
  assert.deepEqual(result, { status: 'found', cwd: scratch, relocated: true });
  assert.equal((await location.resolveSessionLocation({ ...f, authorize, cwd: f.repo })).status, 'scope');
});
test('非法 ID 与越界起点不能启动兜底', async () => {
  const f = fixture(); f.write(f.next);
  assert.equal((await location.resolveSessionLocation({ ...f, id: '../escape' })).status, 'invalid_id');
  assert.equal((await location.resolveSessionLocation({ ...f, cwd: '/not-connected' })).status, 'scope');
});

test('定位 await 期间实例切换目录或会话，不提交旧结果', async () => {
  for (const change of ['sessionId', 'cwd', 'transcriptCwd', 'instance']) {
    const f = fixture(); f.write(f.next);
    const a = { instanceId: 'race', sessionId: f.id, cwd: f.old };
    const agents = new Map([[a.instanceId, a]]);
    const recovery = createSessionRecovery({ agents, authorize: f.authorize, workspaceOf: () => f.repo, baseDir: f.baseDir });
    const pending = recovery.recover(a);
    if (change === 'instance') agents.set(a.instanceId, { ...a });
    else a[change] = change === 'sessionId' ? 'another-session' : f.repo;
    assert.equal((await pending).status, 'stale', change);
    assert.equal(a.externalDirty, undefined);
  }
});

test('外部状态只用主链观察；新鲜快照优先，过期快照不能补 effort', async () => {
  const f = fixture(); f.write(f.next);
  const file = join(f.baseDir, getProjectDir(f.next), `${f.id}.jsonl`);
  const entries = [
    { type: 'assistant', cwd: f.next, entrypoint: 'claude-desktop', message: { role: 'assistant', model: 'external-model' } },
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'user', isMeta: true, entrypoint: 'sdk-ts' },
    { type: 'assistant', isSidechain: true, entrypoint: 'sdk-ts', message: { model: 'child-model' } },
    { type: 'assistant', parent_tool_use_id: 'child', entrypoint: 'sdk-ts', message: { model: 'child-model' } },
    { type: 'progress', entrypoint: 'sdk-ts' },
  ];
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  let snapshot = { state: 'fresh', snapshot: { model: { id: 'wire-model[1m]' }, effort: 'auto' } };
  const recovery = createSessionRecovery({ agents: new Map(), authorize: f.authorize, workspaceOf: () => f.repo, baseDir: f.baseDir,
    readSnapshot: (id, cwd) => { assert.equal(id, f.id); assert.equal(cwd, f.next); return snapshot; },
  });
  assert.deepEqual(await recovery.observed(f.id, f.next), { model: 'wire-model[1m]', permissionMode: 'plan', effort: 'auto' });
  snapshot = { state: 'stale', snapshot: { model: { id: 'stale' }, effort: 'max' } };
  assert.deepEqual(await recovery.observed(f.id, f.next), { model: 'external-model', permissionMode: 'plan', effort: null });
  writeFileSync(file, JSON.stringify({ type: 'assistant', entrypoint: 'sdk-ts', message: { model: 'web-model' } }) + '\n');
  assert.equal(await recovery.observed(f.id, f.next), null, '己方 SDK 记录不是外部驾驶信号');
});

test('有效实例不能把另一个项目的显式请求重定向到自己的记录', async () => {
  const f = fixture(); f.write(f.next);
  const other = join(root, `other-${seq++}`); mkdirSync(other);
  const authorize = c => c === other ? { path: other, projectKey: other } : f.authorize(c);
  const a = { instanceId: 'scoped', sessionId: f.id, cwd: f.old, projectCwd: f.repo };
  const agents = new Map([[a.instanceId, a]]);
  const recovery = createSessionRecovery({ agents, authorize, workspaceOf: c => c === other ? other : f.repo, baseDir: f.baseDir });
  assert.equal((await recovery.recover(a, other)).status, 'not_found');
  assert.equal(a.transcriptCwd, undefined);
});

test('别处的同 ID 副本只读定位，不能改写活实例的记录位置', async () => {
  const f = fixture(); f.write(f.old); f.write(f.repo); // 主仓残留同 ID 副本：精确命中不查归属
  const a = { instanceId: 'ghost', sessionId: f.id, cwd: f.old, projectCwd: f.repo };
  const recovery = createSessionRecovery({ agents: new Map([[a.instanceId, a]]), authorize: f.authorize, workspaceOf: () => f.repo, baseDir: f.baseDir });
  assert.equal((await recovery.recover(a, f.repo)).cwd, f.repo, '明确请求的位置照常可读');
  assert.equal(a.transcriptCwd, undefined);
  assert.equal(a.externalDirty, undefined);

  const g = fixture(); g.write(g.old); g.write(g.next); // 已迁到 next，旧目录又出现同 ID 文件
  const b = { instanceId: 'moved', sessionId: g.id, cwd: g.old, transcriptCwd: g.next, projectCwd: g.repo, externalDirty: true };
  const moved = createSessionRecovery({ agents: new Map([[b.instanceId, b]]), authorize: g.authorize, workspaceOf: () => g.repo, baseDir: g.baseDir });
  assert.equal((await moved.recover(b, g.old)).cwd, g.next, '实例自己的记录还在，就不被旧目录的副本拨回');
  assert.equal(b.transcriptCwd, g.next);
});

test('读取观察值期间文件再次迁移，不提交已经消失的位置', async () => {
  const f = fixture(); f.write(f.next);
  writeFileSync(join(f.baseDir, getProjectDir(f.next), `${f.id}.jsonl`), JSON.stringify({ type: 'user', cwd: f.next, entrypoint: 'claude-desktop', message: { role: 'user', content: 'moving again' } }) + '\n');
  mkdirSync(join(f.baseDir, getProjectDir(f.repo)), { recursive: true });
  const a = { instanceId: 'moving-again', sessionId: f.id, cwd: f.old };
  const agents = new Map([[a.instanceId, a]]);
  let moved = false;
  const recovery = createSessionRecovery({ agents, authorize: f.authorize, workspaceOf: () => f.repo, baseDir: f.baseDir,
    readSnapshot: () => {
      if (!moved) { moved = true; renameSync(join(f.baseDir, getProjectDir(f.next), `${f.id}.jsonl`), join(f.baseDir, getProjectDir(f.repo), `${f.id}.jsonl`)); }
      return null;
    },
  });
  assert.equal((await recovery.recover(a)).status, 'stale');
  assert.equal(a.transcriptCwd, undefined);
});

test('镜像与历史并发恢复同一实例，共用定位且不互相制造 stale', async () => {
  const f = fixture(); f.write(f.next);
  const a = { instanceId: 'concurrent', sessionId: f.id, cwd: f.old };
  const agents = new Map([[a.instanceId, a]]);
  let broadcasts = 0;
  const recovery = createSessionRecovery({ agents, authorize: f.authorize, workspaceOf: () => f.repo, baseDir: f.baseDir, onChange: () => broadcasts++ });
  const results = await Promise.all([recovery.recover(a), recovery.recover(a)]);
  assert.ok(results.every(r => r.status === 'found'));
  assert.equal(broadcasts, 1);
});

test('存活实例外部搬家：保持 SDK cwd，镜像恢复前标脏并推送新历史', async () => {
  const f = fixture(); f.write(f.next);
  const a = { instanceId: 'live', sessionId: f.id, cwd: f.old, authorizedRoot: f.repo };
  const agents = new Map([[a.instanceId, a]]);
  const recovery = createSessionRecovery({ agents, authorize: f.authorize, workspaceOf: () => f.repo, baseDir: f.baseDir });
  const events = [];
  const registry = join(f.baseDir, 'registry'); mkdirSync(registry);
  const engine = createMirrorEngine({ agents, io: { to: () => ({ emit: (name, value) => events.push(value) }) }, instanceState: () => 'idle',
    getViewingInstanceId: () => a.instanceId, viewingCwdOf: () => f.repo, serviceStartedAt: Date.now(),
    scheduleStatusRefresh: () => {}, readCliSnapshotForSession: () => ({ state: 'missing' }),
    transcriptBaseDir: f.baseDir, sessionRegistryDir: registry,
    recoverLocation: instance => recovery.recover(instance),
  });
  engine.stop(); test.after(() => engine.stop());
  await engine.catchUpTick();
  assert.equal(a.cwd, f.old, '读盘恢复不得改活 SDK 的工具/审批目录');
  assert.equal(a.transcriptCwd, f.next, '镜像应使用实际记录位置');
  assert.equal(a.externalDirty, true, '重新定基线前必须标记旧 SDK 内存已过期');
  assert.ok(events.some(e => e.type === 'history_append' && e.payload.replace && e.payload.messages.some(m => m.content?.includes('moved history'))), '位置恢复后须全量刷新，不能只更新基线吞掉历史');
});
