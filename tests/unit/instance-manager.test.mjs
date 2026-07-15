import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInstanceManager } from '../../src/server/instance-manager.js';

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
