// tests/unit/instance-routing.test.mjs —— 实例路由目标解析纯函数单测
// BE-001：显式但已关闭的 instanceId 必须 fail-closed，不静默回退到当前查看实例（否则消息/中断误投别的会话）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveInstanceTarget,
  shouldRejectOutboxLazyOpen,
  reselectViewingTarget,
  shouldClaimViewingAfterSwap,
  shouldClaimViewingAfterLazyOpen,
  canDeleteSessionGuard,
  externalDirtyBusyNack,
  resolveEffortBroadcast,
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

  // 离线 outbox 重发：入队时 viewing 是会话 X，重发时服务端 viewing 可能已是 Y。
  // 对交互式首发，缺省回退到服务端 viewing 是对的（那就是用户眼下看的）；对 outbox 重发不是——
  // 它携带的是入队时刻的快照，回退等于把一条旧消息投给一个它从没指向过的会话。
  test('allowViewingFallback=false + 缺省 instanceId → 不回退 viewing，交给调用方按 cwd 路由', () => {
    assert.deepEqual(
      resolveInstanceTarget(null, viewing, isLive, { allowViewingFallback: false }),
      { id: null, stale: false }
    );
    assert.deepEqual(
      resolveInstanceTarget(undefined, viewing, isLive, { allowViewingFallback: false }),
      { id: null, stale: false }
    );
  });

  test('allowViewingFallback=false 不改变显式 id 的判定（命中仍命中、已关闭仍 stale）', () => {
    assert.deepEqual(
      resolveInstanceTarget('inst_a', viewing, isLive, { allowViewingFallback: false }),
      { id: 'inst_a', stale: false }
    );
    assert.deepEqual(
      resolveInstanceTarget('inst_gone', viewing, isLive, { allowViewingFallback: false }),
      { id: null, stale: true }
    );
  });

  test('opts 缺省 / 空对象 → 保持回退（交互式首发路径不受影响）', () => {
    assert.deepEqual(resolveInstanceTarget(null, viewing, isLive, {}), { id: 'inst_b', stale: false });
    assert.deepEqual(resolveInstanceTarget(null, viewing, isLive), { id: 'inst_b', stale: false });
  });
});

// 关掉 viewing 回退后，outbox 重发落到懒开分支，而 routeCwd 缺省仍会回退到服务端 viewingCwd
// （多半是别的工作区）——那等于换个路径把消息投给它从没指向过的会话。这是那道防线的另一半。
test.describe('shouldRejectOutboxLazyOpen（outbox 重发无 live 实例时必须自带 cwd）', () => {
  test('outbox + 无 cwd → 拒（不许靠服务端 viewingCwd 猜目标）', () => {
    assert.equal(shouldRejectOutboxLazyOpen({ fromOutbox: true, cwd: undefined }), true);
    assert.equal(shouldRejectOutboxLazyOpen({ fromOutbox: true, cwd: null }), true);
    assert.equal(shouldRejectOutboxLazyOpen({ fromOutbox: true, cwd: '' }), true);
    assert.equal(shouldRejectOutboxLazyOpen({ fromOutbox: true, cwd: '   ' }), true);
  });

  test('outbox + 带 cwd → 放行（按入队时刻的工作区懒开）', () => {
    assert.equal(shouldRejectOutboxLazyOpen({ fromOutbox: true, cwd: '/repo/a' }), false);
  });

  test('非 outbox（交互式首发）无 cwd 仍放行 —— 不得波及正常新会话路径', () => {
    assert.equal(shouldRejectOutboxLazyOpen({ fromOutbox: false, cwd: undefined }), false);
    assert.equal(shouldRejectOutboxLazyOpen({}), false);
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

  // 2026-08-06 F2：busy 维度对齐（e32eb70 补 stale 之后的同型第二例）。前端两条 present* 判定
  // （presentOnlineSendAck / presentOfflineResendAck）都靠 ack.busy 识别「忙拒收」落 blocked 终态；
  // 四种忙因语义上全是「现在别投、稍后能成」，缺这一维就落兜底 requeue——离线队列每次重连自动
  // 重发一遍、永不退场。
  test('四种忙因的 nack 都必须带 busy:true（present* 判定的识别锚点）', () => {
    assert.equal(externalDirtyBusyNack({ pendingTurns: 1 }).busy, true);
    assert.equal(externalDirtyBusyNack({ pendingPermissionCount: 1 }).busy, true);
    assert.equal(externalDirtyBusyNack({ bgTaskCount: 2 }).busy, true);
    assert.equal(externalDirtyBusyNack({}).busy, true);
  });
});

// R7（2026-08-06）：dedupedResume 按 resumeId 合流，只有首个调用的 extra 生效——并发 setEffort 与
// session:switch 时后到者拿到别人参数构造的实例，旧实现仍按请求值广播 effort_mode，UI 与注册表分叉，
// 且用户下次切回该档会被幂等闸挡掉、永远回不去。判据只认实例真实档位，不一致时诚实报 mismatch。
test.describe('resolveEffortBroadcast（R7 置换后档位广播）', () => {
  test('实例真实档位与请求一致 → 正常广播、无 mismatch', () => {
    assert.deepEqual(resolveEffortBroadcast({ requested: 'xhigh', actual: 'xhigh' }),
      { level: 'xhigh', mismatch: false });
  });

  test('被并发合流成别人的实例 → 广播真实值并标 mismatch，绝不谎报', () => {
    assert.deepEqual(resolveEffortBroadcast({ requested: 'xhigh', actual: 'high' }),
      { level: 'high', mismatch: true });
  });

  test('真实档位为 null（模型默认）也算不一致，须广播 null', () => {
    assert.deepEqual(resolveEffortBroadcast({ requested: 'xhigh', actual: null }),
      { level: null, mismatch: true });
  });

  test('actual 未提供（注册表尚未写入等边角）→ 回落请求值，保持旧行为', () => {
    assert.deepEqual(resolveEffortBroadcast({ requested: 'xhigh' }),
      { level: 'xhigh', mismatch: false });
  });
});
