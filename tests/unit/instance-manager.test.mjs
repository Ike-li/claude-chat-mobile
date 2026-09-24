// tests/unit/instance-manager.test.mjs —— 多实例注册表：ID、每实例偏好、状态优先级
// 覆盖：forSession 跳过正在终止/已 dispose 的实例（bind 到即将消失的实例会让历史渲染中途空屏）
//       · 实例状态优先级 permission > busy > aborted > idle
//       · anyTurnRunning 只认 pendingTurns，后台任务不算——它与 stateOf 是两个判据，
//         /health.busy 用的是前者（OPS-04），混用会把「有后台任务但空闲」报成忙
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createInstanceManager } from '../../app/src/server/instance-manager.js';

const APP_JS = join(dirname(fileURLToPath(import.meta.url)), '../../app/src/server/app.js');

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

// /health.busy 与 instances.turnRunning 同口径：只认在途轮。stateOf 把 hasBgTasks 折进 'busy'
// （抽屉/角标该亮），但发送按钮和 /health 不得被后台任务锁死——composer 注释写过这条。
test('anyTurnRunning 只认 pendingTurns，后台任务不算（与 stateOf busy 正确地不同）', () => {
  const manager = createInstanceManager();
  const id = manager.nextId();
  const agent = {
    instanceId: id,
    sessionId: 's-bg',
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    pendingTurns: 0,
    hasBgTasks: () => true,
    dispose() {},
  };
  manager.agents.set(id, agent);

  assert.equal(manager.stateOf(id), 'busy', '抽屉/instances.state 把后台任务算运行中');
  assert.equal(manager.anyTurnRunning(), false, '/health.busy 被后台任务点亮 = 把「可发送」说成「有在途轮」');

  agent.pendingTurns = 1;
  assert.equal(manager.anyTurnRunning(), true);
  agent.pendingTurns = 0;
  agent.hasBgTasks = () => false;
  assert.equal(manager.anyTurnRunning(), false);
  assert.equal(manager.stateOf(id), 'idle');
});

test('/health.busy 必须走 anyTurnRunning，不得自行用 stateOf', () => {
  const src = readFileSync(APP_JS, 'utf8');
  assert.match(src, /busy:\s*instanceManager\.anyTurnRunning\(\)/,
    '抽出函数却不接线，等于没钉住 /health 这条消费方');
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

// 彻底删除要等「已关、没退完」的 CLI（app.js deletePermanent）：它们退出前还会往 transcript 追加
// 收尾元数据，删在前面文件就被写回来。session:close 把实例同步移出表；空闲回收则让实例带着
// terminating 留在表里直到退出——两种都得等。
function exitableAgent(manager, sessionId, extra = {}) {
  let exit;
  const agent = {
    instanceId: manager.nextId(),
    sessionId,
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    pendingTurns: 0,
    hasBgTasks: () => false,
    dispose() {},
    exitPromise: new Promise(resolve => { exit = resolve; }),
    ...extra,
  };
  manager.agents.set(agent.instanceId, agent);
  // 与生产同序：consume 走完先经 onExit 清表（app.js），再结算 exitPromise。已移出表的，清表是空操作。
  return { agent, exit: () => { manager.clearTables(agent.instanceId); exit(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('waitForSessionExits 等本会话里已移除、正在回收的实例退完；活实例与别的会话不算', async () => {
  const manager = createInstanceManager();
  const watch = sessionId => {
    const box = { result: null };
    manager.waitForSessionExits(sessionId, 10_000).then(r => { box.result = r; });
    return box;
  };

  // 两种「没退完」各自单独验：放在同一次等待里，其中一种就能撑住「还在等」，另一种漏了看不出来。
  const closed = exitableAgent(manager, 's-closed');
  manager.remove(closed.agent.instanceId);
  let box = watch('s-closed');
  await flush();
  assert.equal(box.result, null, 'session:close 移出了表，但 CLI 还在收尾写盘，删除得等');
  closed.exit();
  await flush();
  assert.equal(box.result, true);

  const reclaiming = exitableAgent(manager, 's-reclaiming', { terminating: true });
  box = watch('s-reclaiming');
  await flush();
  assert.equal(box.result, null, '空闲回收中的实例 CLI 还没退，删除得等');
  reclaiming.exit();
  await flush();
  assert.equal(box.result, true);

  // 不算的两种：活实例由删除保护①拒绝（等它只会白等到上限）；别的会话没退完不牵连。
  exitableAgent(manager, 's-live');
  const other = exitableAgent(manager, 's-other');
  manager.remove(other.agent.instanceId);
  assert.equal(
    await manager.waitForSessionExits('s-live', 10_000), true,
    '活实例和别的会话都不该等：前者由保护①拒绝，后者与本会话无关，等它们只会白等到上限',
  );
});

// 等待是异步的：这期间另一台设备可能又打开、又关掉了这个会话。只等调用那一刻收集到的，
// 新关掉的那个 CLI 就漏了——等完它已不是活实例，保护①放行，删除又落在它的收尾写入前面。
test('waitForSessionExits 等待期间新关掉的实例也要等到', async () => {
  const manager = createInstanceManager();
  const first = exitableAgent(manager, 's1');
  manager.remove(first.agent.instanceId);

  let result = null;
  manager.waitForSessionExits('s1', 10_000).then(r => { result = r; });
  const second = exitableAgent(manager, 's1');
  manager.remove(second.agent.instanceId);
  first.exit();
  await flush();
  assert.equal(result, null, '等待期间又关掉的那个 CLI 还在收尾写盘，不能放行');
  second.exit();
  await flush();
  assert.equal(result, true);
});

// 每轮重新收集时，dispose 过却没走 onExit 清表的实例会一直留在表里，它那个早已结算的退出确认
// 每轮都被收回来。重复等它就是在已结算的 promise 上空转，事件循环再也轮不到别的事——整个 server 卡死。
// 用会数调用次数的 thenable 代替 promise：空转时它很快就抛，用例红，而不是把测试进程一起卡死。
test('waitForSessionExits 不在已结算的退出确认上空转', async () => {
  const manager = createInstanceManager();
  let thenCalls = 0;
  const alreadyExited = {
    then(resolve) {
      thenCalls++;
      if (thenCalls > 20) throw new Error('同一个已结算的退出确认被反复等——在空转');
      resolve();
    },
  };
  exitableAgent(manager, 's1', { disposed: true, exitPromise: alreadyExited });
  assert.equal(await manager.waitForSessionExits('s1', 10_000), true);
});

test('waitForSessionExits 有上限：等不到按时放行并返回 false，不让会话永远卡在关闭中', async t => {
  // Date 也要冻住：实现按 Date.now() 算剩余时长，真时钟在两次读之间跨过毫秒边界时定时器只剩 9999ms
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = createInstanceManager();
  const hung = exitableAgent(manager, 's1');
  manager.remove(hung.agent.instanceId);

  let result = null;
  manager.waitForSessionExits('s1', 10_000).then(r => { result = r; });
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(result, null, '上限之前要一直等');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(result, false, '到上限必须结算，并如实说明没等到');
});
