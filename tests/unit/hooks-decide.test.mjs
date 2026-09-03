// hook 事件 → 动作的决策层（纯函数，推送/刷新/白名单/节流全在这层可测）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideHookEventActions,
  HOOK_PUSH_MAX_AGE_MS,
} from '../../app/src/ops/cli-hooks-bridge.js';
import { notificationForCliHook, throttleNotify } from '../../app/src/ops/notifications.js';

const CWD = '/Users/you/code/demo';
const OTHER = '/Users/you/code/other';
const SID = 'sess-1';
const NOW = 1_785_000_000_000;

function ev(over = {}) {
  return {
    schemaVersion: 1, source: 'claude-cli-hook',
    hookEventName: 'Stop', sessionId: SID, cwd: CWD, capturedAt: NOW - 1000,
    ...over,
  };
}

const base = {
  workDirs: [CWD], now: NOW, viewingSessionId: null, viewingCwd: null,
  hasForegroundClient: false, throttleState: new Map(),
};

test('命中当前查看会话 → 触发一次 catchUp（多条事件不重复置位）', () => {
  const r = decideHookEventActions([ev(), ev({ capturedAt: NOW - 500 })], {
    ...base, viewingSessionId: SID, viewingCwd: CWD,
  });
  assert.equal(r.catchUp, true);
  assert.deepEqual(r.invalidateCwds, [CWD]);
});

test('非当前查看会话 → 不 catchUp，但仍失效该 cwd 的列表缓存', () => {
  const r = decideHookEventActions([ev()], { ...base, viewingSessionId: 'other-sess', viewingCwd: CWD });
  assert.equal(r.catchUp, false);
  assert.deepEqual(r.invalidateCwds, [CWD]);
});

test('cwd 不在工作区白名单 → 整条丢弃并计数（机器上其他项目的会话不干扰）', () => {
  const r = decideHookEventActions([ev({ cwd: OTHER })], { ...base, viewingSessionId: SID, viewingCwd: OTHER });
  assert.equal(r.ignored, 1);
  assert.equal(r.catchUp, false);
  assert.deepEqual(r.pushes, []);
  assert.deepEqual(r.invalidateCwds, []);
});

test('verify 事件 → 只出 ack，不推送不刷新（安装回环验证专用）', () => {
  const r = decideHookEventActions([ev({ sessionId: 'ccm-verify-abc', cwd: OTHER })], base);
  assert.deepEqual(r.acks, ['ccm-verify-abc']);
  assert.equal(r.catchUp, false);
  assert.deepEqual(r.pushes, []);
  assert.equal(r.ignored, 0, 'verify 事件不受工作区白名单约束（安装时可能在任意目录跑）');
});

test('Stop：前台有客户端在看 → 不推完成通知；无前台 → 推', () => {
  const withClient = decideHookEventActions([ev()], { ...base, hasForegroundClient: true });
  assert.deepEqual(withClient.pushes, []);
  const noClient = decideHookEventActions([ev()], base);
  assert.equal(noClient.pushes.length, 1);
  assert.equal(noClient.pushes[0].hookEventName, 'Stop');
  assert.equal(noClient.pushes[0].sessionId, SID);
});

test('Notification：前台在看也照推（可能锁屏/在别的会话，"需要你"不能吞）', () => {
  const r = decideHookEventActions([ev({ hookEventName: 'Notification' })], { ...base, hasForegroundClient: true });
  assert.equal(r.pushes.length, 1);
  assert.equal(r.pushes[0].hookEventName, 'Notification');
});

test('过旧事件仍刷新但不补推通知（睡醒后不炸一串旧通知）', () => {
  const r = decideHookEventActions([ev({ capturedAt: NOW - HOOK_PUSH_MAX_AGE_MS - 1 })], {
    ...base, viewingSessionId: SID, viewingCwd: CWD,
  });
  assert.equal(r.catchUp, true);
  assert.deepEqual(r.pushes, []);
});

test('同会话连发按 category 节流，且状态经 nextThrottleState 外置回传', () => {
  const first = decideHookEventActions([ev()], base);
  assert.equal(first.pushes.length, 1);
  const second = decideHookEventActions([ev({ capturedAt: NOW - 100 })], {
    ...base, throttleState: first.nextThrottleState,
  });
  assert.deepEqual(second.pushes, [], '最小间隔内的第二条被抑制');
});

// ★红线：hook 类别绝不能复用 approval/input——那两类会被 throttleNotify 置 pending:true，
// 而 hook 世界没有 request_resolved 之类的"已处理"事件来清除，复用会让该会话后续推送被永久吞掉。
test('hook 节流类别是 pending:false 的一次性类别，不会永久吞掉后续推送', () => {
  const r = decideHookEventActions([ev({ hookEventName: 'Notification' })], base);
  const category = r.pushes[0].category;
  assert.ok(category === 'hook-attention' || category === 'hook-finished');
  const entry = r.nextThrottleState.get(SID)[category];
  assert.equal(entry.pending, false, 'pending:true 会导致后续推送永久被抑制');
  // 过了最小间隔即可再推（对照：pending:true 时无论多久都推不出去）
  const later = throttleNotify(SID, category, NOW + 60_001, r.nextThrottleState);
  assert.equal(later.throttled, false);
});

test('notificationForCliHook：Stop/Notification 文案 + 有 live 实例才带深链', () => {
  const stop = notificationForCliHook('Stop', { cwd: CWD, sessionId: SID, instanceId: 'inst_1' });
  assert.match(stop.title, /终端/);
  assert.match(stop.title, /demo$/, '带工作区名，便于多工作区区分');
  assert.deepEqual(stop.data, { instanceId: 'inst_1', sessionId: SID, cwd: CWD });

  const attention = notificationForCliHook('Notification', { cwd: CWD, sessionId: SID });
  assert.match(attention.title, /需要你/);
  assert.equal('data' in attention, false, '无 live 实例 → 无深链（点开落首页，如实降级）');

  assert.equal(notificationForCliHook('PreToolUse', { cwd: CWD, sessionId: SID }), null);
});
