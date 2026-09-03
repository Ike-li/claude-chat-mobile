import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInstanceManager } from '../../app/src/server/instance-manager.js';

test('instance manager owns IDs, per-instance preferences, lookup, and teardown', () => {
  const manager = createInstanceManager();
  const disposed = [];
  const first = {
    instanceId: manager.nextId(),
    sessionId: 's1',
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    pendingTurns: 0,
    hasBgTasks: () => false,
    dispose: () => disposed.push('s1'),
  };
  manager.agents.set(first.instanceId, first);
  manager.permissionModes.set(first.instanceId, 'plan');
  manager.efforts.set(first.instanceId, 'high');

  assert.equal(first.instanceId, 'inst_1');
  assert.equal(manager.nextId(), 'inst_2');
  assert.equal(manager.forSession('s1'), first);
  assert.equal(manager.permissionModeOf(first.instanceId), 'plan');
  assert.equal(manager.effortOf(first.instanceId), 'high');
  assert.equal(manager.stateOf(first.instanceId), 'idle');

  manager.done.add(first.instanceId);
  assert.equal(manager.stateOf(first.instanceId), 'done');
  first.pendingTurns = 1;
  assert.equal(manager.stateOf(first.instanceId), 'busy');

  assert.equal(manager.remove(first.instanceId), first);
  assert.deepEqual(disposed, ['s1']);
  assert.equal(manager.agents.has(first.instanceId), false);
  assert.equal(manager.permissionModes.has(first.instanceId), false);
  assert.equal(manager.efforts.has(first.instanceId), false);
  assert.equal(manager.done.has(first.instanceId), false);
});

// 空闲回收 checkIdle 置 terminating 后、onExit 删 Map 前有竞态窗：session:switch 若仍命中
// 这份「正在死」的实例，会 bind 到即将消失的 instanceId → 历史分块渲染中途被 reselect 打断 → 空屏。
test('forSession skips terminating and disposed agents so switch can open a fresh resume', () => {
  const manager = createInstanceManager();
  const dying = {
    instanceId: manager.nextId(),
    sessionId: 's-dying',
    terminating: true,
    disposed: false,
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    pendingTurns: 0,
    hasBgTasks: () => false,
    dispose() {},
  };
  manager.agents.set(dying.instanceId, dying);
  assert.equal(manager.forSession('s-dying'), null);

  dying.terminating = false;
  dying.disposed = true;
  assert.equal(manager.forSession('s-dying'), null);

  dying.disposed = false;
  assert.equal(manager.forSession('s-dying'), dying);
});

test('instance state priority is permission, busy, aborted, error, done, idle', () => {
  const manager = createInstanceManager();
  const id = manager.nextId();
  const agent = {
    instanceId: id,
    sessionId: 's',
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    pendingTurns: 0,
    hasBgTasks: () => false,
    dispose() {},
  };
  manager.agents.set(id, agent);
  manager.done.add(id);
  manager.errors.add(id);
  manager.aborted.add(id);
  assert.equal(manager.stateOf(id), 'aborted');
  agent.pendingTurns = 1;
  assert.equal(manager.stateOf(id), 'busy');
  agent.pendingPermissions.set('p', {});
  assert.equal(manager.stateOf(id), 'permission');
});

test('captureUnreadSnapshot freezes the live counter into the entry snapshot and zeroes the counter', () => {
  const manager = createInstanceManager();
  const id = manager.nextId();
  manager.unreadCounts.set(id, 5);

  manager.captureUnreadSnapshot(id);

  assert.equal(manager.unreadCounts.has(id), false);
  assert.equal(manager.unreadSnapshotOnEntry.get(id), 5);
});

test('captureUnreadSnapshot preserves unacked snapshot when live counter is 0 (reconnect jitter)', () => {
  const manager = createInstanceManager();
  const id = manager.nextId();
  manager.unreadCounts.set(id, 3);
  manager.captureUnreadSnapshot(id);
  assert.equal(manager.unreadSnapshotOnEntry.get(id), 3);

  // 断线重连：期间没攒新未读、用户也未 ack → 不得把已冻快照冲成 0（胶囊仍要展示）
  manager.captureUnreadSnapshot(id);
  assert.equal(manager.unreadSnapshotOnEntry.get(id), 3);
});

test('captureUnreadSnapshot folds new live counts into an existing unacked snapshot (additive)', () => {
  const manager = createInstanceManager();
  const id = manager.nextId();
  manager.unreadCounts.set(id, 3);
  manager.captureUnreadSnapshot(id);
  // 第一次冻结后、ack 前又离开期间攒了 2 条
  manager.unreadCounts.set(id, 2);
  manager.captureUnreadSnapshot(id);
  assert.equal(manager.unreadSnapshotOnEntry.get(id), 5);
  assert.equal(manager.unreadCounts.has(id), false);
});

test('captureUnreadSnapshot ignores a null id (no current viewing instance)', () => {
  const manager = createInstanceManager();
  manager.captureUnreadSnapshot(null); // 不应抛错、不应写入任何 key
  assert.equal(manager.unreadSnapshotOnEntry.size, 0);
});

test('remove() clears unreadCounts, unreadSnapshotOnEntry and lastCountedTopLevelMessageId alongside the existing latch sets', () => {
  const manager = createInstanceManager();
  const agent = {
    instanceId: manager.nextId(),
    sessionId: 's-unread',
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    pendingTurns: 0,
    hasBgTasks: () => false,
    dispose() {},
  };
  manager.agents.set(agent.instanceId, agent);
  manager.unreadCounts.set(agent.instanceId, 4);
  manager.unreadSnapshotOnEntry.set(agent.instanceId, 2);
  manager.lastCountedTopLevelMessageId.set(agent.instanceId, 'm9');

  manager.remove(agent.instanceId);

  assert.equal(manager.unreadCounts.has(agent.instanceId), false);
  assert.equal(manager.unreadSnapshotOnEntry.has(agent.instanceId), false);
  assert.equal(manager.lastCountedTopLevelMessageId.has(agent.instanceId), false);
});
