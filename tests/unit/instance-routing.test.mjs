// tests/unit/instance-routing.test.mjs —— 实例路由目标解析纯函数单测
// BE-001：显式但已关闭的 instanceId 必须 fail-closed，不静默回退到当前查看实例（否则消息/中断误投别的会话）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveInstanceTarget,
  reselectViewingTarget,
  shouldClaimViewingAfterSwap,
  shouldClaimViewingAfterLazyOpen,
  canDeleteSessionGuard,
  externalDirtyBusyNack,
} from '../../src/server/instance-routing.js';

test.describe('resolveInstanceTarget（BE-001：区分缺省回退 / 命中 / 显式 stale）', () => {
  const live = new Set(['inst_a', 'inst_b']);
  const isLive = id => live.has(id);
  const viewing = 'inst_b';

  test('缺省 undefined → 回退 viewingInstanceId，非 stale（向后兼容缺参旧调用）', () => {
    assert.deepEqual(resolveInstanceTarget(undefined, viewing, isLive), { id: 'inst_b', stale: false });
  });

  test('缺省 null → 同样回退 viewingInstanceId', () => {
    assert.deepEqual(resolveInstanceTarget(null, viewing, isLive), { id: 'inst_b', stale: false });
  });

  test('显式命中 live → 该实例本身', () => {
    assert.deepEqual(resolveInstanceTarget('inst_a', viewing, isLive), { id: 'inst_a', stale: false });
  });

  test('显式但已不在 live（已关闭）→ stale=true、id=null（fail-closed，绝不回退 viewing）', () => {
    assert.deepEqual(resolveInstanceTarget('inst_gone', viewing, isLive), { id: null, stale: true });
  });

  test('缺省且无 viewing（首发/无 open tab）→ id=null 但非 stale（调用方应懒开而非拒绝）', () => {
    assert.deepEqual(resolveInstanceTarget(undefined, null, isLive), { id: null, stale: false });
  });

  test('显式 stale 即便 viewing 为 null 仍判 stale（不因无 viewing 就退化成懒开）', () => {
    assert.deepEqual(resolveInstanceTarget('inst_gone', null, isLive), { id: null, stale: true });
  });

  test('空字符串 instanceId 视为「显式但未知」→ stale（客户端不应发空 id；真缺省用 null/undefined）', () => {
    assert.deepEqual(resolveInstanceTarget('', viewing, isLive), { id: null, stale: true });
  });
});

// BE-016 + resumeFailed UX：当前查看实例被移除后原子重选 ID+cwd。
// 默认禁止静默跨工作区（resume 失败 / 进程退出不得把视图弹到 mimo 等其它 live tab）；
// 仅 allowCrossWorkspace=true（用户主动关 tab）才可落到其它 cwd 的剩余实例。
// 一律优先同 cwd 剩余实例；无同 cwd 且不允许跨区 → null + removedCwd。
test.describe('reselectViewingTarget（BE-016：移除当前查看实例后原子重选 ID+cwd）', () => {
  const cwdOf = id => ({ a: '/repo/a', b: '/repo/b', a2: '/repo/a' }[id]);

  test('无剩余实例 → viewingInstanceId=null，viewingCwd 保留刚移除实例的 cwd（不回退旧值）', () => {
    assert.deepEqual(
      reselectViewingTarget([], '/repo/a', cwdOf, '/fallback'),
      { viewingInstanceId: null, viewingCwd: '/repo/a' }
    );
  });

  test('无剩余且 removedCwd 为空 → 回退 fallbackCwd', () => {
    assert.deepEqual(
      reselectViewingTarget([], null, cwdOf, '/fallback'),
      { viewingInstanceId: null, viewingCwd: '/fallback' }
    );
  });

  test('默认：剩余仅异 cwd → 不跨工作区，停在 removedCwd 空表面（修 resume 失败闪回 mimo）', () => {
    assert.deepEqual(
      reselectViewingTarget(['b'], '/repo/a', cwdOf, '/fallback'),
      { viewingInstanceId: null, viewingCwd: '/repo/a' }
    );
  });

  test('默认：剩余含同 cwd → 优先同 cwd（即使它不是插入序第一个）', () => {
    assert.deepEqual(
      reselectViewingTarget(['b', 'a2'], '/repo/a', cwdOf, '/fallback'),
      { viewingInstanceId: 'a2', viewingCwd: '/repo/a' }
    );
  });

  test('allowCrossWorkspace：无同 cwd 时取插入序第一个剩余并同步其 cwd（用户主动关 tab）', () => {
    assert.deepEqual(
      reselectViewingTarget(['b'], '/repo/a', cwdOf, '/fallback', { allowCrossWorkspace: true }),
      { viewingInstanceId: 'b', viewingCwd: '/repo/b' }
    );
  });

  test('allowCrossWorkspace：仍优先同 cwd，不因跨区开关改选异 cwd 的首位', () => {
    assert.deepEqual(
      reselectViewingTarget(['b', 'a2'], '/repo/a', cwdOf, '/fallback', { allowCrossWorkspace: true }),
      { viewingInstanceId: 'a2', viewingCwd: '/repo/a' }
    );
  });

  test('allowCrossWorkspace + 多个异 cwd → 取插入序第一个', () => {
    assert.deepEqual(
      reselectViewingTarget(['b', 'a'], '/repo/x', cwdOf, '/fallback', { allowCrossWorkspace: true }),
      { viewingInstanceId: 'b', viewingCwd: '/repo/b' }
    );
  });
});

// SS-NEW-001 / SRV-NEW-002：silent dispose 后用死指针判定是否 claim；用户切走不抢。
test.describe('shouldClaimViewingAfterSwap（置换后接管 viewing）', () => {
  test('viewing 仍是被 dispose 的 id（死指针）→ claim', () => {
    assert.equal(shouldClaimViewingAfterSwap({ disposedId: 'old', viewingNow: 'old' }), true);
  });
  test('用户已切到其他 live → 不 claim', () => {
    assert.equal(shouldClaimViewingAfterSwap({ disposedId: 'old', viewingNow: 'other' }), false);
  });
  test('用户已回空首页 null → 不 claim', () => {
    assert.equal(shouldClaimViewingAfterSwap({ disposedId: 'old', viewingNow: null }), false);
  });
  test('viewing 已是新实例（幂等）→ 不 claim（已在目标上）', () => {
    // 严格：只有死指针才 claim；已是 opened 由调用方直接跳过或 viewingNow===disposed 才 true
    assert.equal(shouldClaimViewingAfterSwap({ disposedId: 'old', viewingNow: 'new' }), false);
  });
  test('disposedId 缺失 → 不 claim', () => {
    assert.equal(shouldClaimViewingAfterSwap({ disposedId: null, viewingNow: null }), false);
    assert.equal(shouldClaimViewingAfterSwap({}), false);
  });
});

// SRV-NEW-001：懒开 await 后仅当用户未切走才写 viewing。
test.describe('shouldClaimViewingAfterLazyOpen（懒开后接管 viewing）', () => {
  test('空首页：开始/结束皆 null → claim', () => {
    assert.equal(shouldClaimViewingAfterLazyOpen({ viewingAtStart: null, viewingNow: null }), true);
  });
  test('开始/结束同一 live id → claim（罕见：有 viewing 仍懒开时保持）', () => {
    assert.equal(shouldClaimViewingAfterLazyOpen({ viewingAtStart: 'a', viewingNow: 'a' }), true);
  });
  test('await 期间用户切到 B → 不 claim', () => {
    assert.equal(shouldClaimViewingAfterLazyOpen({ viewingAtStart: null, viewingNow: 'b' }), false);
  });
  test('await 期间用户从 A 切到 B → 不 claim', () => {
    assert.equal(shouldClaimViewingAfterLazyOpen({ viewingAtStart: 'a', viewingNow: 'b' }), false);
  });
  test('await 期间用户从 A 回首页 → 不 claim', () => {
    assert.equal(shouldClaimViewingAfterLazyOpen({ viewingAtStart: 'a', viewingNow: null }), false);
  });
});

// SRV-NEW-004：删除前守卫 live + resumeInFlight
test.describe('canDeleteSessionGuard（SRV-NEW-004）', () => {
  test('空闲 → ok', () => {
    assert.deepEqual(canDeleteSessionGuard({}), { ok: true, reason: null, error: null });
  });
  test('live 驱动 → 拒', () => {
    const r = canDeleteSessionGuard({ liveInstance: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'live');
    assert.match(r.error, /驱动/);
  });
  test('resumeInFlight → 拒', () => {
    const r = canDeleteSessionGuard({ resumeInFlight: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'opening');
    assert.match(r.error, /打开/);
  });
  test('live 优先于 opening', () => {
    assert.equal(canDeleteSessionGuard({ liveInstance: true, resumeInFlight: true }).reason, 'live');
  });
});

// SRV-003：externalDirty 需置换但 isBusy 时的负 ACK——文案须说明「吸收终端写入 + 仍忙原因」，
// 并带可观测 detail（日志用）。旧文案「会话正在处理」在 UI 已「完成」时极误导。
test.describe('externalDirtyBusyNack（SRV-003：置换被 isBusy 挡住）', () => {
  test('pendingTurns>0 → reason=turn，文案含吸收终端写入 + 上一轮', () => {
    const r = externalDirtyBusyNack({ pendingTurns: 1 });
    assert.equal(r.retryable, true);
    assert.equal(r.reason, 'turn');
    assert.match(r.error, /吸收终端写入/);
    assert.match(r.error, /上一轮|仍在处理/);
    assert.match(r.detail, /pendingTurns=1/);
  });

  test('仅后台任务 → reason=bg_tasks', () => {
    const r = externalDirtyBusyNack({ bgTaskCount: 2 });
    assert.equal(r.reason, 'bg_tasks');
    assert.match(r.error, /后台任务/);
    assert.match(r.detail, /bgTasks=2/);
  });

  test('挂起审批/提问优先于 bgTasks', () => {
    const r = externalDirtyBusyNack({ bgTaskCount: 1, pendingPermissionCount: 1 });
    assert.equal(r.reason, 'permission');
    assert.match(r.error, /审批|提问/);
  });

  test('turn 优先于 permission / bgTasks', () => {
    const r = externalDirtyBusyNack({
      pendingTurns: 1,
      bgTaskCount: 3,
      pendingQuestionCount: 1,
    });
    assert.equal(r.reason, 'turn');
    assert.match(r.detail, /pendingTurns=1/);
    assert.match(r.detail, /bgTasks=3/);
    assert.match(r.detail, /questions=1/);
  });

  test('全 0 仍给可重试兜底文案（isBusy 真但计数未透传）', () => {
    const r = externalDirtyBusyNack({});
    assert.equal(r.retryable, true);
    assert.equal(r.reason, 'busy');
    assert.match(r.error, /吸收终端写入|仍忙|稍后/);
  });
});
