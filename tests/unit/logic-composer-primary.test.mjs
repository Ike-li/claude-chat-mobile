// 发送钮双态 + 流内 live 状态文案：纯逻辑单测（零 DOM/零 token）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveComposerPrimaryMode,
  formatLiveActivityText,
  presentOnlineSendAck,
  presentOfflineResendAck,
  shouldBusyAfterOfflineBatch,
  safeJsonPreview,
  shouldSeedBusyFromInstanceState,
  shouldReseedBusyAfterReload,
  shouldBindBusyFromBroadcast,
  queuedBubbleState,
  resolveCancelRefill,
  shouldClearInterruptPendingOnSystem,
  INTERRUPT_PENDING_TIMEOUT_MS,
} from '../../public/js/logic.js';

test('resolveComposerPrimaryMode: 空闲空输入 → 禁用发送', () => {
  const out = resolveComposerPrimaryMode({});
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, false);
  assert.equal(out.ariaLabel, '发送');
});

test('resolveComposerPrimaryMode: 空闲有内容 → 启用发送', () => {
  const out = resolveComposerPrimaryMode({ hasContent: true });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, true);
  assert.equal(out.title, '');
  assert.equal(out.ariaLabel, '发送');
});

test('resolveComposerPrimaryMode: 忙碌空输入 → 停止启用', () => {
  const out = resolveComposerPrimaryMode({ busy: true, hasContent: false });
  assert.equal(out.mode, 'stop');
  assert.equal(out.enabled, true);
  assert.equal(out.title, '停止');
  assert.equal(out.ariaLabel, '停止');
});

test('resolveComposerPrimaryMode: 忙碌有内容 → 仍发送（FE-004 排队）', () => {
  const out = resolveComposerPrimaryMode({ busy: true, hasContent: true });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, true);
});

test('resolveComposerPrimaryMode: 忙碌空 + interruptPending → 停止禁用', () => {
  const out = resolveComposerPrimaryMode({
    busy: true,
    hasContent: false,
    interruptPending: true,
  });
  assert.equal(out.mode, 'stop');
  assert.equal(out.enabled, false);
  assert.match(out.title, /停止/);
  assert.equal(out.ariaLabel, '正在停止');
});

// 限流重试中点停止：SDK 可能回「无可中断任务」或迟迟不回 interrupted——前端须清 interruptPending，
// 否则停止钮永久 disabled + live 行卡「正在停止…」（真机复现：限流重试 8/10 时点停止卡死）。
test('shouldClearInterruptPendingOnSystem: interrupted 清位', () => {
  assert.equal(shouldClearInterruptPendingOnSystem({ kind: 'interrupted', message: '已中断' }), true);
});

test('shouldClearInterruptPendingOnSystem: 无可中断任务 清位（失败回执）', () => {
  assert.equal(shouldClearInterruptPendingOnSystem({ message: '当前没有可中断的任务' }), true);
});

test('shouldClearInterruptPendingOnSystem: 其它 system 不清位', () => {
  assert.equal(shouldClearInterruptPendingOnSystem({ message: '正在压缩会话上下文…' }), false);
  assert.equal(shouldClearInterruptPendingOnSystem({ kind: 'queue_dropped' }), false);
  assert.equal(shouldClearInterruptPendingOnSystem({}), false);
});

test('INTERRUPT_PENDING_TIMEOUT_MS 是合理的安全超时（防永久卡死）', () => {
  assert.equal(typeof INTERRUPT_PENDING_TIMEOUT_MS, 'number');
  assert.ok(INTERRUPT_PENDING_TIMEOUT_MS >= 5_000);
  assert.ok(INTERRUPT_PENDING_TIMEOUT_MS <= 30_000);
});

test('resolveComposerPrimaryMode: 忙碌有内容 + queueFull → 禁用发送 + 排队 title', () => {
  const out = resolveComposerPrimaryMode({
    busy: true,
    hasContent: true,
    queueFull: true,
  });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, false);
  assert.match(out.title, /排队/);
});

test('resolveComposerPrimaryMode: 忙碌空 + queueFull → 仍可停止', () => {
  const out = resolveComposerPrimaryMode({
    busy: true,
    hasContent: false,
    queueFull: true,
  });
  assert.equal(out.mode, 'stop');
  assert.equal(out.enabled, true);
});

test('resolveComposerPrimaryMode: 审批/提问打开 → 禁用发送（不走 morph 停止）', () => {
  const out = resolveComposerPrimaryMode({
    busy: true,
    hasContent: false,
    blockedByUserRequest: true,
  });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, false);
  assert.match(out.title, /审批|选择/);
});

test('resolveComposerPrimaryMode: 输入禁用 → 禁用', () => {
  const out = resolveComposerPrimaryMode({
    busy: true,
    hasContent: false,
    blockedByDisabledInput: true,
  });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, false);
  assert.match(out.title, /授权|只读/);
});

// CLI 镜像只读：发送钮位换成短文案「续接」（完整名放 aria/title，避免挤掉齿轮）。
// mirrorReadonly 优先于 busy / blockedByDisabledInput（镜像时 input 仍会 disabled）。
test('resolveComposerPrimaryMode: mirrorReadonly → 续接启用', () => {
  const out = resolveComposerPrimaryMode({
    mirrorReadonly: true,
    busy: true,
    blockedByDisabledInput: true,
    hasContent: true,
  });
  assert.equal(out.mode, 'resume');
  assert.equal(out.enabled, true);
  assert.equal(out.label, '续接');
  assert.equal(out.ariaLabel, '续接 CLI 会话');
  assert.match(out.title, /续接|终端/);
});

test('resolveComposerPrimaryMode: mirrorReadonly + armed → 取消续接', () => {
  const out = resolveComposerPrimaryMode({
    mirrorReadonly: true,
    mirrorArmed: true,
    blockedByDisabledInput: true,
  });
  assert.equal(out.mode, 'cancel-resume');
  assert.equal(out.enabled, true);
  assert.equal(out.label, '取消');
  assert.equal(out.ariaLabel, '取消续接');
});

test('resolveComposerPrimaryMode: sendInFlight 挡双击发送', () => {
  const out = resolveComposerPrimaryMode({
    hasContent: true,
    blockedBySendInFlight: true,
  });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, false);
  assert.match(out.title, /稍候/);
});

// 对齐 CLI：spinner 行不挂工具后缀（'tool'/'thinking' 分支已退役），未知 kind 一律回落 default。
test('formatLiveActivityText: default / stopping / 未知 kind 回落 default', () => {
  assert.equal(formatLiveActivityText('default'), 'Claude 正在执行任务...');
  assert.equal(formatLiveActivityText(), 'Claude 正在执行任务...');
  assert.equal(formatLiveActivityText('stopping'), '正在停止…');
  assert.equal(formatLiveActivityText('thinking'), 'Claude 正在执行任务...');
  assert.equal(formatLiveActivityText('tool', { name: 'Bash', command: 'ls -la' }), 'Claude 正在执行任务...');
});

// 在线 user:message 的 socket ack 决策：成功只清 in-flight；失败须清 busy + 可见文案（可重试/永久）。
// 旧实现把 ack 回调当 clearSendInFlight 忽略 payload → 负 ack 时像「发送失败但无反馈」。
test('presentOnlineSendAck: ok → 仅确认成功，不清 busy', () => {
  const out = presentOnlineSendAck({ ok: true, instanceId: 'i1' });
  assert.equal(out.ok, true);
  assert.equal(out.clearBusy, false);
  assert.equal(out.restoreDraft, false);
  assert.equal(out.message, '');
});

test('presentOnlineSendAck: 可重试失败 → 清 busy + 文案 + 恢复草稿', () => {
  const out = presentOnlineSendAck({ ok: false, error: '前面还有消息在排队，请稍后重试', retryable: true });
  assert.equal(out.ok, false);
  assert.equal(out.clearBusy, true);
  assert.equal(out.restoreDraft, true);
  assert.equal(out.retryable, true);
  assert.match(out.message, /排队|重试/);
});

test('presentOnlineSendAck: 永久失败 / stale → 清 busy + 恢复草稿', () => {
  const permanent = presentOnlineSendAck({ ok: false, error: '消息过长', permanent: true });
  assert.equal(permanent.ok, false);
  assert.equal(permanent.clearBusy, true);
  assert.equal(permanent.restoreDraft, true);
  assert.equal(permanent.permanent, true);
  assert.match(permanent.message, /过长|失败/);

  const stale = presentOnlineSendAck({ ok: false, error: 'stale_instance', stale: true });
  assert.equal(stale.ok, false);
  assert.equal(stale.clearBusy, true);
  assert.equal(stale.stale, true);
  assert.ok(stale.message.length > 0);
});

test('presentOnlineSendAck: 缺省/畸形 ack 当失败', () => {
  assert.equal(presentOnlineSendAck(null).ok, false);
  assert.equal(presentOnlineSendAck(undefined).ok, false);
  assert.equal(presentOnlineSendAck({}).ok, false);
  assert.equal(presentOnlineSendAck({ ok: false }).clearBusy, true);
});

// FE-NEW-001 / FE-NEW-006：离线重发 ack 与批后 busy
test('presentOfflineResendAck: ok → 不 requeue', () => {
  const out = presentOfflineResendAck(null, { ok: true });
  assert.equal(out.outcome, 'ok');
  assert.equal(out.requeue, false);
  assert.equal(out.clearBusyIfViewing, false);
});

test('presentOfflineResendAck: permanent → 停重试并提示清 viewing busy', () => {
  const out = presentOfflineResendAck(null, { ok: false, permanent: true, error: '消息过长' });
  assert.equal(out.outcome, 'permanent');
  assert.equal(out.requeue, false);
  assert.equal(out.clearBusyIfViewing, true);
  assert.match(out.message, /过长/);
});

test('presentOfflineResendAck: timeout / retryable → requeue', () => {
  assert.equal(presentOfflineResendAck(new Error('timeout'), undefined).outcome, 'requeue');
  assert.equal(presentOfflineResendAck(null, { ok: false, retryable: true }).requeue, true);
  assert.equal(presentOfflineResendAck(null, null).requeue, true);
});

test('shouldBusyAfterOfflineBatch: 无 viewing 剩余且无 viewing ok → 不 busy', () => {
  assert.equal(shouldBusyAfterOfflineBatch({
    viewingInstanceId: 'v',
    remainingItems: [{ instanceId: 'other' }],
    hadViewingOk: false,
  }), false);
});

test('shouldBusyAfterOfflineBatch: viewing 仍有 requeue → busy', () => {
  assert.equal(shouldBusyAfterOfflineBatch({
    viewingInstanceId: 'v',
    remainingItems: [{ instanceId: 'v' }],
    hadViewingOk: false,
  }), true);
});

test('shouldBusyAfterOfflineBatch: 本批 viewing ok → busy 等 result', () => {
  assert.equal(shouldBusyAfterOfflineBatch({
    viewingInstanceId: 'v',
    remainingItems: [],
    hadViewingOk: true,
  }), true);
});

test('safeJsonPreview: undefined/null/circular 不抛', () => {
  assert.equal(safeJsonPreview(undefined), 'null');
  assert.equal(safeJsonPreview(null), 'null');
  assert.equal(safeJsonPreview({ a: 1 }, 80), '{"a":1}');
  const o = {}; o.self = o;
  assert.equal(safeJsonPreview(o), '[unserializable]');
  assert.equal(safeJsonPreview('x'.repeat(100), 10).length, 10);
});

test('shouldSeedBusyFromInstanceState: busy/permission only', () => {
  assert.equal(shouldSeedBusyFromInstanceState('busy'), true);
  assert.equal(shouldSeedBusyFromInstanceState('permission'), true);
  assert.equal(shouldSeedBusyFromInstanceState('idle'), false);
  assert.equal(shouldSeedBusyFromInstanceState('done'), false);
  assert.equal(shouldSeedBusyFromInstanceState(undefined), false);
});

test('shouldReseedBusyAfterReload: 广播优先，回退入场快照', () => {
  // 主场景：广播里该实例 state='busy'
  assert.equal(shouldReseedBusyAfterReload({
    instances: [{ instanceId: 'a', state: 'busy' }],
    instanceId: 'a',
    entryState: 'idle',
  }), true);
  // 过期入场快照：广播 state='idle' 但 entryState='busy' → 信最新广播，防 stale-busy 卡死
  assert.equal(shouldReseedBusyAfterReload({
    instances: [{ instanceId: 'a', state: 'idle' }],
    instanceId: 'a',
    entryState: 'busy',
  }), false);
  // 广播缺该实例、entryState='busy' → 回退入场快照
  assert.equal(shouldReseedBusyAfterReload({
    instances: [{ instanceId: 'b', state: 'busy' }],
    instanceId: 'a',
    entryState: 'busy',
  }), true);
  // 广播缺该实例、entryState undefined
  assert.equal(shouldReseedBusyAfterReload({
    instances: [],
    instanceId: 'a',
    entryState: undefined,
  }), false);
  // 广播 state='permission'
  assert.equal(shouldReseedBusyAfterReload({
    instances: [{ instanceId: 'a', state: 'permission' }],
    instanceId: 'a',
  }), true);
});

test('shouldBindBusyFromBroadcast: 单向绑定，bgActive 门控', () => {
  // {state:'busy', bgActive:false} → true
  assert.equal(shouldBindBusyFromBroadcast({ state: 'busy', bgActive: false }), true);
  // {state:'busy'}（bgActive undefined，旧服务端/mock 兼容）→ true
  assert.equal(shouldBindBusyFromBroadcast({ state: 'busy' }), true);
  // {state:'busy', bgActive:true} → false（纯后台任务期不驱动运行条，防单向无释放卡死）
  assert.equal(shouldBindBusyFromBroadcast({ state: 'busy', bgActive: true }), false);
  // {state:'permission', bgActive:false} → true
  assert.equal(shouldBindBusyFromBroadcast({ state: 'permission', bgActive: false }), true);
  // {state:'idle'} / {} → false
  assert.equal(shouldBindBusyFromBroadcast({ state: 'idle' }), false);
  assert.equal(shouldBindBusyFromBroadcast({}), false);
});

// ---- 排队可见性 + 撤回回填（对齐 CLI Queued/ESC）----
test.describe('queuedBubbleState', () => {
  test('queued=true → 显示排队标记与文案', () => {
    const st = queuedBubbleState({ queued: true });
    assert.equal(st.show, true);
    assert.ok(st.label.includes('排队中'));
  });
  test('queued 缺省/false → 不显示', () => {
    assert.equal(queuedBubbleState({}).show, false);
    assert.equal(queuedBubbleState({ queued: false }).show, false);
    assert.equal(queuedBubbleState().show, false);
  });
});

test.describe('resolveCancelRefill', () => {
  test('输入框为空 → 直接回填撤回文本', () => {
    assert.deepEqual(
      resolveCancelRefill({ inputText: '', cancelledText: 'hello' }),
      { mode: 'fill', value: 'hello' },
    );
    assert.deepEqual(
      resolveCancelRefill({ inputText: '   ', cancelledText: 'hello' }),
      { mode: 'fill', value: 'hello' },
    );
  });
  test('输入框已有未发内容 → 撤回文本置于其上（空行分隔），零丢失', () => {
    assert.deepEqual(
      resolveCancelRefill({ inputText: 'draft', cancelledText: 'hello' }),
      { mode: 'prepend', value: 'hello\n\ndraft' },
    );
  });
  test('畸形入参 → 不抛、按空串兜底', () => {
    assert.deepEqual(resolveCancelRefill(), { mode: 'fill', value: '' });
    assert.deepEqual(resolveCancelRefill({ inputText: null, cancelledText: null }), { mode: 'fill', value: '' });
  });
});
