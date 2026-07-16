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

// BE-016：当前查看实例被移除后，重选查看目标并【原子同步】viewingCwd——落到剩余实例取其 cwd，
// 落到空视图(null)保留刚移除实例的 cwd（否则裸 viewingCwd 停在更早旧值，新会话选目录/statusline 跳回旧工作区）。
test.describe('reselectViewingTarget（BE-016：移除当前查看实例后原子重选 ID+cwd）', () => {
  const cwdOf = id => ({ a: '/repo/a', b: '/repo/b' }[id]);

  test('有剩余实例 → 选插入序第一个剩余，cwd 同步为该实例', () => {
    assert.deepEqual(
      reselectViewingTarget(['b'], '/repo/a', cwdOf, '/fallback'),
      { viewingInstanceId: 'b', viewingCwd: '/repo/b' }
    );
  });

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

  test('多个剩余 → 取插入序第一个（对齐 agents.keys().next().value）', () => {
    assert.deepEqual(
      reselectViewingTarget(['b', 'a'], '/repo/x', cwdOf, '/fallback'),
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
