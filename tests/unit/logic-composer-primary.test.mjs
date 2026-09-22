// tests/unit/logic-composer-primary.test.mjs —— 输入区主按钮与发送 ack 的纯函数
// 一个按钮位承载「发送 / 停止 / 续接」三态，判错的后果是用户按下去发生了他没预期的事。
// 覆盖：resolveComposerPrimaryMode 的空闲/忙碌 × 有无内容矩阵 · 发送按钮隐藏判据 · 权限档位色调
//       · presentOnlineSendAck 的乐观气泡去留 · 离线重发横幅的归属标注（三处共用同一判据）
//       · 发送时序常量之间的序关系不变量（跨前后端的常量失配是同源漏修高发区）
// 发送钮双态 + 流内 live 状态文案：纯逻辑单测（零 DOM/零 token）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveComposerPrimaryMode,
  shouldHideComposerSendButton,
  pillPermTone,
  shouldShowComposerDiscoverHint,
  formatLiveActivityText,
  presentOnlineSendAck,
  presentOnlineSendTransport,
  presentOfflineResendAck,
  shouldBusyAfterOfflineBatch,
  outboxItemTargetsViewing,
  outboxNoticePlacement,
  SERVER_PRE_TURN_UPPER_BOUND_MS,
  SEND_ACK_FALLBACK_MS,
  SEND_ACK_TRANSPORT_MS,
  OFFLINE_RESEND_ACK_MS,
  planOutboxDrainNotice,
  planOutboxEnqueue,
  parseDurableOutbox,
  dumpDurableOutbox,
  OUTBOX_MAX_ITEMS,
  safeJsonPreview,
  shouldSeedBusyFromInstanceState,
  shouldReseedBusyAfterReload,
  shouldBindBusyFromBroadcast,
  shouldForceClearBusyFromBroadcast,
  resolveRunStateFromSnapshot,
  shouldClearBusyBySnapshot,
  BUSY_BROADCAST_CLEAR_GRACE_MS,
  shouldClearInterruptPendingOnSystem,
  systemBarClass,
  INTERRUPT_PENDING_TIMEOUT_MS,
  planOutboxWorktreeReuse,
  nextOutboxWorktreeAnchor,
} from '../../app/public/js/logic.js';
// F2 配对回归用：server 侧忙拒收判定与前端 present* 必须逐维对齐（该模块零依赖、单测环境可直接 import）
import { externalDirtyBusyNack } from '../../app/src/server/instance-routing.js';

test('resolveComposerPrimaryMode: 空闲空输入 → 禁用发送', () => {
  const out = resolveComposerPrimaryMode({});
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, false);
  assert.equal(out.ariaLabel, '发送');
});

test('shouldHideComposerSendButton: 空闲无内容隐藏；有内容/停止/续接显示', () => {
  assert.equal(shouldHideComposerSendButton({ mode: 'send', enabled: false, hasContent: false }), true);
  assert.equal(shouldHideComposerSendButton({ mode: 'send', enabled: true, hasContent: true }), false);
  assert.equal(shouldHideComposerSendButton({ mode: 'send', enabled: false, hasContent: true }), false); // 审批中等禁用态
  assert.equal(shouldHideComposerSendButton({ mode: 'stop', enabled: true, hasContent: false }), false);
  assert.equal(shouldHideComposerSendButton({ mode: 'resume', enabled: true, hasContent: false }), false);
});

test('pillPermTone: 仅 bypass → danger，plan → plan，其余 neutral', () => {
  assert.equal(pillPermTone('bypassPermissions'), 'danger');
  assert.equal(pillPermTone('plan'), 'plan');
  assert.equal(pillPermTone('default'), 'neutral');
  assert.equal(pillPermTone('acceptEdits'), 'neutral');
  assert.equal(pillPermTone('auto'), 'neutral');
});

test('shouldShowComposerDiscoverHint: 聚焦且空且非镜像 → 显示', () => {
  assert.equal(shouldShowComposerDiscoverHint({ focused: true, hasContent: false }), true);
  assert.equal(shouldShowComposerDiscoverHint({ focused: false, hasContent: false }), false);
  assert.equal(shouldShowComposerDiscoverHint({ focused: true, hasContent: true }), false);
  assert.equal(shouldShowComposerDiscoverHint({ focused: true, hasContent: false, mirrorReadonly: true }), false);
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

// 排队已移除：在途轮期间不接受新消息，主按钮恒为停止钮（不管输入框有没有草稿）——
// 否则「想插队 → 先清空输入框才能看到停止钮」这步极反直觉。草稿保留在输入框里。
test('resolveComposerPrimaryMode: 在途轮 + 有内容 → 停止（不再排队发送）', () => {
  const out = resolveComposerPrimaryMode({ busy: true, turnRunning: true, hasContent: true });
  assert.equal(out.mode, 'stop');
  assert.equal(out.enabled, true);
  assert.equal(out.ariaLabel, '停止');
});

// ★决策②「后台任务挂着不锁」：busy 是粗粒度的（stateOf 把 hasBgTasks 也折进 'busy'，
// 且 bindView/loadHistory 用 shouldSeedBusyFromInstanceState 播种时并不排除 bgActive）。
// 发送闸只认在途轮——纯后台任务期主按钮若恒为停止钮，移动端（回车不发送、只能点钮）就彻底发不出消息了。
test('resolveComposerPrimaryMode: 纯后台任务 busy（无在途轮）+ 有内容 → 仍可发送', () => {
  const out = resolveComposerPrimaryMode({ busy: true, turnRunning: false, hasContent: true });
  assert.equal(out.mode, 'send');
  assert.equal(out.enabled, true);
});

// 兜底逃生口：turnRunning 靠广播/ack 驱动，万一漏种而实际在跑，空输入时仍要能停。
// 与上一条并不冲突——有草稿才说明用户想发，那时才让位给发送。
test('resolveComposerPrimaryMode: busy + 空输入 → 停止（turnRunning 漏种时的兜底）', () => {
  const out = resolveComposerPrimaryMode({ busy: true, turnRunning: false, hasContent: false });
  assert.equal(out.mode, 'stop');
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

test('shouldClearInterruptPendingOnSystem: kind=no_interruptible_task 清位（语言无关，D1）', () => {
  assert.equal(shouldClearInterruptPendingOnSystem({ kind: 'no_interruptible_task', message: 'Nothing to interrupt' }), true);
});

// system/notice 承载一批 SDK 自由文本（informational/mirror_error/notification/model_refusal_*/
// compact_error/额度耗尽/子 agent 报错）。级别决定配色——警告类不能和「已中断」这种中性回执同色，
// 否则用户扫不出「这条要处理」。
test('systemBarClass: warning → text-warning，error → text-danger', () => {
  assert.equal(systemBarClass({ kind: 'notice', level: 'warning' }), 'text-warning');
  assert.equal(systemBarClass({ kind: 'notice', level: 'error' }), 'text-danger');
});

test('systemBarClass: info / 未知 level / 无 level 一律中性灰', () => {
  assert.equal(systemBarClass({ kind: 'notice', level: 'info' }), 'text-ink-faint');
  assert.equal(systemBarClass({ kind: 'notice', level: 'brand_new' }), 'text-ink-faint');
  assert.equal(systemBarClass({ kind: 'notice' }), 'text-ink-faint');
});

test('systemBarClass: 非 notice 的既有 system 恒中性灰（不回归）', () => {
  assert.equal(systemBarClass({ kind: 'interrupted', message: '已中断' }), 'text-ink-faint');
  assert.equal(systemBarClass({ kind: 'queue_dropped' }), 'text-ink-faint');
  assert.equal(systemBarClass({ message: '上下文已压缩' }), 'text-ink-faint');
  assert.equal(systemBarClass({}), 'text-ink-faint');
  assert.equal(systemBarClass(), 'text-ink-faint');
  // 防串味：非 notice 即便误带 level 也不变色（level 只在 notice 语义下有效）
  assert.equal(systemBarClass({ kind: 'interrupted', level: 'warning' }), 'text-ink-faint');
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

test('resolveComposerPrimaryMode: 在途轮 + 有内容 + interruptPending → 停止禁用（草稿不影响）', () => {
  const out = resolveComposerPrimaryMode({
    busy: true,
    turnRunning: true,
    hasContent: true,
    interruptPending: true,
  });
  assert.equal(out.mode, 'stop');
  assert.equal(out.enabled, false);
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
// 'sending' 是发送 ack 前的短暂阶段，与 stopping/default 并列。
test('formatLiveActivityText: default / stopping / sending / 未知 kind 回落 default', () => {
  assert.equal(formatLiveActivityText('default'), 'Claude 正在执行任务...');
  assert.equal(formatLiveActivityText(), 'Claude 正在执行任务...');
  assert.equal(formatLiveActivityText('stopping'), '正在停止…');
  assert.equal(formatLiveActivityText('sending'), '正在发送…');
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

test('presentOnlineSendAck: 可重试失败 → 清 busy + 入 outbox（不回填草稿）', () => {
  const out = presentOnlineSendAck({ ok: false, error: '发送失败，请重试', retryable: true });
  assert.equal(out.ok, false);
  assert.equal(out.clearBusy, true);
  assert.equal(out.retryable, true);
  assert.equal(out.requeue, true, '可重试应入 outbox 自动重试');
  assert.equal(out.restoreDraft, false, '入队后不回填，避免与 outbox 双份');
  assert.match(out.message, /重试/);
});

// 排队移除后的核心新分支：在途轮期间服务端拒收。
// · clearBusy 必须为 false —— 被拒的是【新消息】，正在跑的那轮 busy 不能被清掉（否则状态行消失、停止钮变发送钮）
// · requeue 必须为 false —— 自动重发等于把排队搬到客户端，与移除排队的初衷相左
// · restoreDraft 为 true —— send() 已清空输入框，文字要还给用户
test('presentOnlineSendAck: busy 拒收 → 不清 busy、不入 outbox、回填草稿', () => {
  const out = presentOnlineSendAck({
    ok: false,
    error: '当前任务运行中，请等待完成后再发送',
    busy: true,
    retryable: false,
  });
  assert.equal(out.ok, false);
  assert.equal(out.busy, true);
  assert.equal(out.clearBusy, false, '在跑那轮的 busy 不能被新消息的负 ack 清掉');
  assert.equal(out.requeue, false, '不自动重发——那就是客户端排队');
  assert.equal(out.restoreDraft, true, '文字要还回输入框');
  assert.match(out.message, /运行中/);
});

test('presentOnlineSendAck: 永久失败 / stale → 清 busy + 恢复草稿', () => {
  const permanent = presentOnlineSendAck({ ok: false, error: '消息过长', permanent: true });
  assert.equal(permanent.ok, false);
  assert.equal(permanent.clearBusy, true);
  assert.equal(permanent.restoreDraft, true);
  assert.equal(permanent.requeue, false);
  assert.equal(permanent.permanent, true);
  assert.match(permanent.message, /过长|失败/);

  const stale = presentOnlineSendAck({ ok: false, error: 'stale_instance', stale: true });
  assert.equal(stale.ok, false);
  assert.equal(stale.clearBusy, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.requeue, false);
  assert.ok(stale.message.length > 0);
});

test('presentOnlineSendAck: 缺省/畸形 ack 当失败', () => {
  assert.equal(presentOnlineSendAck(null).ok, false);
  assert.equal(presentOnlineSendAck(undefined).ok, false);
  assert.equal(presentOnlineSendAck({}).ok, false);
  assert.equal(presentOnlineSendAck({ ok: false }).clearBusy, true);
});

test('presentOnlineSendTransport: timeout/err → requeue', () => {
  const out = presentOnlineSendTransport(new Error('timeout'), undefined);
  assert.equal(out.ok, false);
  assert.equal(out.requeue, true);
  assert.equal(out.restoreDraft, false);
  assert.match(out.message, /排队|重试|确认/);
});

test('presentOnlineSendTransport: 无 err 委托 presentOnlineSendAck', () => {
  assert.equal(presentOnlineSendTransport(null, { ok: true }).ok, true);
  assert.equal(presentOnlineSendTransport(null, { ok: false, retryable: true }).requeue, true);
});

// 在线乐观气泡的去留（2026-08-27）。气泡在 send() 那一刻就上屏了（修「发出去的消息消失」），
// 于是负 ack 回来时必须决定它的命运。判据只有一条：这条消息还在不在飞。
//  · ok / requeue → 还在飞（outbox 接管重发，并在同一颗气泡上显示进度/重发按钮）→ 留
//  · busy / permanent / stale → 确定没发出去，且文字已回填输入框 → 必须撤，否则屏幕上留一颗永远
//    转圈的气泡，用户以为发出去了——那正是本次要修的「消息被吞」观感的镜像反面，比原 bug 更糟。
//
// 【为什么另立字段而不复用 restoreDraft】当前每个分支上两者恰好同值，但语义是两回事：一个管输入框，
// 一个管消息流。靠巧合相等省一个字段，等于把「将来某分支要回填草稿但保留气泡」变成静默错误。
// 同款教训见 presentOfflineResendAck 与本函数那次「两边注释都写着对齐、那一维从没对齐」。
test.describe('presentOnlineSendAck: 乐观气泡去留（dropBubble）', () => {
  test('成功 → 留，等 user_message 按 clientMessageId 认领转正', () => {
    assert.equal(presentOnlineSendAck({ ok: true, instanceId: 'i1' }).dropBubble, false);
  });

  test('可重试失败 → 留，outbox 接管后仍要在这颗气泡上显示重发进度', () => {
    const out = presentOnlineSendAck({ ok: false, error: '发送失败，请重试', retryable: true });
    assert.equal(out.requeue, true);
    assert.equal(out.dropBubble, false, 'outbox 持有 bubbleEl，撤掉它重发就没有节点可认领了');
  });

  test('busy 拒收 → 撤，消息确定没入队', () => {
    const out = presentOnlineSendAck({
      ok: false, error: '当前任务运行中，请等待完成后再发送', busy: true, retryable: false,
    });
    assert.equal(out.dropBubble, true);
    assert.equal(out.restoreDraft, true, '撤气泡与回填草稿成对：消息流里没了，输入框里要有');
  });

  test('永久失败 / stale → 撤', () => {
    assert.equal(presentOnlineSendAck({ ok: false, error: '消息过长', permanent: true }).dropBubble, true);
    assert.equal(presentOnlineSendAck({ ok: false, error: 'stale_instance', stale: true }).dropBubble, true);
  });

  test('transport 超时 → 留（走 requeue）', () => {
    assert.equal(presentOnlineSendTransport(new Error('timeout'), undefined).dropBubble, false);
  });

  // 不变量：留气泡 ⟺ 消息还在飞。新增分支若违反，说明它要么「既不重发又在屏幕上留转圈气泡」，
  // 要么「重发中却把气泡撤了」——后者会让重发成功时 matchedBubble 找不到节点、凭空多一条气泡。
  test('不变量：dropBubble 恒等于「既不成功也不重发」', () => {
    const acks = [
      { ok: true },
      { ok: false, error: 'x', retryable: true },
      { ok: false, error: 'x', busy: true, retryable: false },
      { ok: false, error: 'x', permanent: true },
      { ok: false, error: 'stale_instance', stale: true },
      {}, null, undefined,
    ];
    for (const ack of acks) {
      const out = presentOnlineSendAck(ack);
      assert.equal(out.dropBubble, !out.ok && !out.requeue, `分支失配: ${JSON.stringify(ack)}`);
    }
  });
});

// 「在新 worktree 里开」的意图跟着第一条消息走（服务端据此懒建）。离线时那条消息进 outbox，
// 而 serializeOutboxItem 是**白名单**——不显式登记就被静默丢掉，重发出去的是一条没有意图的消息，
// 实例于是开在父仓。症状不是报错：用户以为改动隔离在 worktree 里，实际全落在主工作树上，
// 要到 git status 一堆意外改动时才发现。这正是这个功能唯一不能出的错。
test('outbox: worktree 意图必须活过入队与持久化往返', () => {
  const item = {
    clientMessageId: 'wt-1', text: '改点东西', cwd: '/repo',
    useWorktree: true, sourceBranch: 'dev',
  };
  const { queue } = planOutboxEnqueue([], item, { maxItems: 5 });
  assert.equal(queue[0].useWorktree, true, '入队就丢 = 离线发的第一条消息永远开在父仓');
  assert.equal(queue[0].sourceBranch, 'dev');

  const round = parseDurableOutbox(dumpDurableOutbox(queue));
  assert.equal(round[0].useWorktree, true, 'localStorage 往返丢 = 关掉页面再回来意图就没了');
  assert.equal(round[0].sourceBranch, 'dev');

  // 正对照：没勾的消息不该平白多出这两个字段（服务端据 useWorktree===true 判，undefined 即不建）
  const plain = planOutboxEnqueue([], { clientMessageId: 'p-1', text: 'x' }, { maxItems: 5 }).queue[0];
  assert.notEqual(plain.useWorktree, true);
});

test('outbox: enqueue 去重同 clientMessageId + 超 cap 丢最旧', () => {
  let q = [];
  ({ queue: q } = planOutboxEnqueue(q, { clientMessageId: 'a', text: '1' }, { maxItems: 2 }));
  ({ queue: q } = planOutboxEnqueue(q, { clientMessageId: 'b', text: '2' }, { maxItems: 2 }));
  const r = planOutboxEnqueue(q, { clientMessageId: 'c', text: '3' }, { maxItems: 2 });
  assert.equal(r.queue.length, 2);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.queue[0].clientMessageId, 'b');
  assert.equal(r.queue[1].clientMessageId, 'c');
  // 同 id 覆盖不涨长度
  const r2 = planOutboxEnqueue(r.queue, { clientMessageId: 'c', text: '3b' }, { maxItems: 2 });
  assert.equal(r2.queue.length, 2);
  assert.equal(r2.queue.find(x => x.clientMessageId === 'c').text, '3b');
});

test('outbox: durable dump/parse 剥 bubbleEl', () => {
  const raw = dumpDurableOutbox([{ clientMessageId: 'x', text: 'hi', bubbleEl: { fake: true } }]);
  assert.ok(!raw.includes('bubbleEl'));
  const items = parseDurableOutbox(raw);
  assert.equal(items.length, 1);
  assert.equal(items[0].clientMessageId, 'x');
  assert.equal(items[0].text, 'hi');
  assert.equal(items[0].bubbleEl, undefined);
  assert.deepEqual(parseDurableOutbox('not-json'), []);
  assert.ok(OUTBOX_MAX_ITEMS >= 1);
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

// 目标实例已关闭是死信：服务端 fail-closed 回 {stale:true} 却【没有】permanent 字段，
// 旧实现落到兜底 requeue → 每次重连重发一遍、永不退场（现场：一条消息从 18:01 刷到 19:49）。
// 在线路径 presentOnlineSendAck 早已把 stale 排除出 requeue，这里补齐对称性。
test('presentOfflineResendAck: stale → 终态停重试，不再无限 requeue', () => {
  const out = presentOfflineResendAck(null, { ok: false, error: 'stale_instance', stale: true });
  assert.equal(out.outcome, 'permanent');
  assert.equal(out.requeue, false);
  assert.equal(out.permanent, true);
  assert.equal(out.clearBusyIfViewing, true);
  assert.match(out.message, /已关闭/); // 不得把裸 'stale_instance' 透给用户
});

test('presentOfflineResendAck: 仅 error=stale_instance（无 stale 字段）也判死信', () => {
  const out = presentOfflineResendAck(null, { ok: false, error: 'stale_instance' });
  assert.equal(out.outcome, 'permanent');
  assert.equal(out.requeue, false);
  assert.match(out.message, /已关闭/);
});

// 重发横幅无归属过滤 → 队列项发往别的会话，横幅却贴在当前会话消息流里，
// 读起来像「这条排队消息在本会话发了」（现场：在 Official 实例 看到 third-party 的重发提示）。
test.describe('planOutboxDrainNotice（重发横幅归属标注）', () => {
  test('全部目标为当前 viewing → 原文案，不加其它会话标注', () => {
    const out = planOutboxDrainNotice({
      items: [{ instanceId: 'v' }, { instanceId: 'v' }],
      viewingInstanceId: 'v',
    });
    assert.equal(out.total, 2);
    assert.equal(out.foreign, 0);
    assert.doesNotMatch(out.text, /其它会话/);
    assert.match(out.text, /2/);
  });

  test('全部目标为其它会话 → 文案明说发往其它会话', () => {
    const out = planOutboxDrainNotice({
      items: [{ instanceId: 'other' }],
      viewingInstanceId: 'v',
    });
    assert.equal(out.foreign, 1);
    assert.match(out.text, /其它会话/);
  });

  test('混合 → 标出其中几条发往其它会话', () => {
    const out = planOutboxDrainNotice({
      items: [{ instanceId: 'v' }, { instanceId: 'other' }, { instanceId: 'other2' }],
      viewingInstanceId: 'v',
    });
    assert.equal(out.total, 3);
    assert.equal(out.foreign, 2);
    assert.match(out.text, /其它会话/);
  });

  // 这两条的 viewingCwd 是 2026-08-26 补的：原 fixture 写于加 cwd 维度之前，只传 viewingInstanceId:null
  // 就想表达「首页」，但那和「冷启动尚未收到 instances 广播」在数据上无法区分。真实首页两者不同——
  // 回主页/点＋只清 viewingInstanceId，currentCwd 立刻切到该目录（app.js 里目录行 ＋ 的 onclick，
  // 那行 `currentCwd = d` 的注释写明了是为了不让广播落地前的发送投错工作区）；
  // currentCwd 全仓只有三个赋值点（声明处的 null、instances 广播、上面那个 ＋），唯有冷启动前才是 null。
  // 断言实质不变：首页仍要如实标注「发往其它会话」。
  test('viewing 为 null（首页/无 tab）→ 全部算其它会话，不谎称属于当前视图', () => {
    const out = planOutboxDrainNotice({
      items: [{ instanceId: 'a' }],
      viewingInstanceId: null,
      viewingCwd: '/w/a',
    });
    assert.equal(out.foreign, 1);
    assert.match(out.text, /其它会话/);
  });

  test('item.instanceId 为 null（首发未开实例）不得与 viewing=null 配成「属于本视图」', () => {
    const out = planOutboxDrainNotice({
      items: [{ instanceId: null }],
      viewingInstanceId: null,
      viewingCwd: '/w/a',
    });
    assert.equal(out.foreign, 1);
  });

  // 现场（2026-08-26）：新开会话发第一句 → 服务端懒开实例 + setModel 慢于客户端 ack 窗口 →
  // 消息以 instanceId=null 入 outbox；500ms 后 drain 时懒开已完成、viewingInstanceId 已被广播
  // 改成新实例 ID，纯 instanceId 判据把它算成 foreign，横幅谎称「发往其它会话」——它就是本会话。
  test('首发项（instanceId=null）cwd 与当前视图同 → 不算发往其它会话', () => {
    const out = planOutboxDrainNotice({
      items: [{ instanceId: null, cwd: '/w/a' }],
      viewingInstanceId: 'inst-1',
      viewingCwd: '/w/a',
    });
    assert.equal(out.foreign, 0);
    assert.doesNotMatch(out.text, /其它会话/);
  });

  // 反向：离线期间用户切了工作区，队列项重发会落到入队时刻那个 cwd 的会话，不是眼下这个。
  test('首发项 cwd 与当前视图不同 → 仍标注发往其它会话', () => {
    const out = planOutboxDrainNotice({
      items: [{ instanceId: null, cwd: '/w/a' }],
      viewingInstanceId: 'inst-1',
      viewingCwd: '/w/b',
    });
    assert.equal(out.foreign, 1);
    assert.match(out.text, /其它会话/);
  });

  // instanceId 显式指向别的实例时，cwd 相同也不得改判——同一工作区可以同时开多个会话。
  test('instanceId 指向其它实例 → 即便同 cwd 也算其它会话', () => {
    const out = planOutboxDrainNotice({
      items: [{ instanceId: 'other', cwd: '/w/a' }],
      viewingInstanceId: 'inst-1',
      viewingCwd: '/w/a',
    });
    assert.equal(out.foreign, 1);
  });

  // 冷启动/刷新后 connect 立刻 drain（app.js 的 socket.on('connect')），横幅在第一个 await 之前
  // 同步贴出 ⇒ 必早于本次连接的首帧 instances 广播，此刻 viewingInstanceId / currentCwd 都还是初值 null。
  // 归属根本判不出来，既不能说「本会话」也不能说「发往其它会话」——回落成不标注归属的中性文案。
  test('完全无视图上下文（冷启动 connect 即 drain）→ 中性文案，不谎称发往其它会话', () => {
    const out = planOutboxDrainNotice({
      items: [{ instanceId: null, cwd: '/w/a' }, { instanceId: 'x', cwd: '/w/b' }],
      viewingInstanceId: null,
      viewingCwd: null,
    });
    assert.equal(out.total, 2);
    assert.equal(out.foreign, 0);
    assert.doesNotMatch(out.text, /其它会话/);
  });

  // 只要有一侧视图上下文在，就仍按真实归属标注（防上面那条把正常判据也一并关掉）。
  test('有 viewingInstanceId 但无 cwd → 仍照常标注归属', () => {
    const out = planOutboxDrainNotice({
      items: [{ instanceId: 'other' }],
      viewingInstanceId: 'v',
      viewingCwd: null,
    });
    assert.equal(out.foreign, 1);
    assert.match(out.text, /其它会话/);
  });
});

// 归属判据抽成单一函数：此前 planOutboxDrainNotice / shouldBusyAfterOfflineBatch / app.js 的
// targetsViewing 各写一份「逐字一致」的表达式，任一处改动都会静默分叉（2026-08-05 outbox 三修的教训）。
test.describe('outboxItemTargetsViewing（三处共用的归属判据）', () => {
  test('instanceId 相等 → 属于本视图', () => {
    assert.equal(outboxItemTargetsViewing({ instanceId: 'v' }, { viewingInstanceId: 'v' }), true);
  });

  test('instanceId 不等 → 不属于', () => {
    assert.equal(outboxItemTargetsViewing({ instanceId: 'x' }, { viewingInstanceId: 'v' }), false);
  });

  test('两边 instanceId 同为 null 且无 cwd → 不得配成一对', () => {
    assert.equal(outboxItemTargetsViewing({ instanceId: null }, { viewingInstanceId: null }), false);
  });

  test('instanceId 为 null 时按 cwd 归属（首发未开实例路径）', () => {
    assert.equal(
      outboxItemTargetsViewing({ instanceId: null, cwd: '/w/a' }, { viewingInstanceId: 'i', viewingCwd: '/w/a' }),
      true,
    );
    assert.equal(
      outboxItemTargetsViewing({ instanceId: null, cwd: '/w/a' }, { viewingInstanceId: 'i', viewingCwd: '/w/b' }),
      false,
    );
  });

  test('cwd 任一侧缺失 → 目标无从确定，不算本视图（服务端同样 fail-closed 拒懒开）', () => {
    assert.equal(outboxItemTargetsViewing({ instanceId: null }, { viewingCwd: '/w/a' }), false);
    assert.equal(outboxItemTargetsViewing({ instanceId: null, cwd: '/w/a' }, {}), false);
  });

  // 与服务端 shouldRejectOutboxLazyOpen 对齐：空串/空白 cwd 不得当成合法匹配键。
  // 旧实现用 `!= null`，'' 会双空串互配成功，把「目标未定」谎称成「属于本视图」。
  test('cwd 为空串/空白 → 与缺失同属 fail-closed，不算本视图', () => {
    assert.equal(
      outboxItemTargetsViewing({ instanceId: null, cwd: '' }, { viewingInstanceId: null, viewingCwd: '' }),
      false,
    );
    assert.equal(
      outboxItemTargetsViewing({ instanceId: null, cwd: '   ' }, { viewingInstanceId: null, viewingCwd: '   ' }),
      false,
    );
    assert.equal(
      outboxItemTargetsViewing({ instanceId: null, cwd: '' }, { viewingInstanceId: 'i', viewingCwd: '/w/a' }),
      false,
    );
  });

  test('item 为空 → false，不抛', () => {
    assert.equal(outboxItemTargetsViewing(null, { viewingInstanceId: 'v' }), false);
    assert.equal(outboxItemTargetsViewing(undefined, {}), false);
  });
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

// 首发项（instanceId=null）走 cwd 归属后，剩余队列里的它也必须算「本视图仍有在途」——
// 否则批后 setBusy(false) 会把刚开跑那轮的运行条抹掉（要等下一次 instances 广播才补回来）。
test('shouldBusyAfterOfflineBatch: 剩余首发项 cwd 同当前视图 → busy', () => {
  assert.equal(shouldBusyAfterOfflineBatch({
    viewingInstanceId: 'v',
    viewingCwd: '/w/a',
    remainingItems: [{ instanceId: null, cwd: '/w/a' }],
    hadViewingOk: false,
  }), true);
});

test('shouldBusyAfterOfflineBatch: 剩余首发项 cwd 是别的工作区 → 不 busy', () => {
  assert.equal(shouldBusyAfterOfflineBatch({
    viewingInstanceId: 'v',
    viewingCwd: '/w/a',
    remainingItems: [{ instanceId: null, cwd: '/w/b' }],
    hadViewingOk: false,
  }), false);
});

// 空首页（回主页/点＋后 viewingInstanceId=null，但 currentCwd 仍是该工作区）：没有会话承载运行条，
// 且 instances 广播里的 busy 看门狗被 `newViewing && newViewing === displayedInstanceId` 挡在门外
// （app.js，newViewing 为 null 时整段跳过）⇒ 这里一旦置上 busy 就没人清得掉，主按钮永久卡成「停止」。
test('shouldBusyAfterOfflineBatch: 首页无 viewing 实例 → 即便剩余项 cwd 相同也不得 busy', () => {
  assert.equal(shouldBusyAfterOfflineBatch({
    viewingInstanceId: null,
    viewingCwd: '/w/a',
    remainingItems: [{ instanceId: null, cwd: '/w/a' }],
    hadViewingOk: false,
  }), false);
});

// 发送时序常量的序关系不变量。2026-08-26 的教训：SEND_ACK_FALLBACK_MS 与
// BUSY_BROADCAST_CLEAR_GRACE_MS 是同一个约束（服务端 pendingTurns 计入广播前的窗口）的两个消费者，
// 却分居 app.js 与 logic/ 两个文件、各写各的 5000，于是同一个根因要被发现两次（第二次靠独立审查
// 才挖出来）。把它们收进同一个模块并用断言钉住彼此关系——失配就在 test:unit 里当场炸，
// 不必等真机上「运行条中途消失」。
// 离线消息失败提示的落点。两条判据缺一条，放错的两种形态都无声：
//  · 只看「indicator 取不取得到」：querySelector 能从已脱离 DOM 的缓存子树里找到它，
//    于是提示写进一个看不见的节点，用户以为消息发出去了。
//  · 只看「在不在活 DOM」、不在就 addBar：addBar 写的是当前消息面，A 会话的发送失败
//    会打到 B 会话的界面上。
test.describe('outboxNoticePlacement（离线失败提示挂哪儿）', () => {
  test('indicator 在活 DOM → 直接复用，与归属无关', () => {
    assert.equal(outboxNoticePlacement({ indicatorExists: true, indicatorConnected: true, targetsViewing: true }), 'indicator');
    assert.equal(outboxNoticePlacement({ indicatorExists: true, indicatorConnected: true, targetsViewing: false }), 'indicator');
  });

  test('indicator 已脱离 DOM 但属于当前会话 → 新开提示条', () => {
    assert.equal(outboxNoticePlacement({ indicatorExists: true, indicatorConnected: false, targetsViewing: true }), 'bar');
  });

  test('indicator 已脱离 DOM 且不属于当前会话 → 写回缓存里那个，切回去才看得到', () => {
    assert.equal(outboxNoticePlacement({ indicatorExists: true, indicatorConnected: false, targetsViewing: false }), 'stale',
      '这一档绝不能是 bar——那等于把 A 会话的发送失败打到 B 会话界面上');
  });

  test('根本没有 indicator：属于当前会话才给提示条，否则没有正确落点', () => {
    assert.equal(outboxNoticePlacement({ indicatorExists: false, indicatorConnected: false, targetsViewing: true }), 'bar');
    assert.equal(outboxNoticePlacement({ indicatorExists: false, indicatorConnected: false, targetsViewing: false }), 'none',
      '宁可不提示，也不在别的会话里凭空多出一条红字');
  });

  test('缺省参数（什么都不知道）→ none，不猜', () => {
    assert.equal(outboxNoticePlacement(), 'none');
    assert.equal(outboxNoticePlacement({}), 'none');
  });
});

test.describe('发送时序常量：序关系不变量', () => {
  test('UI 兜底必须早于传输判据（按钮先解锁，消息才谈得上「没送达」）', () => {
    assert.ok(SEND_ACK_FALLBACK_MS < SEND_ACK_TRANSPORT_MS);
  });

  test('在线与离线重发用同一个传输窗（重发打的是同一个 handler）', () => {
    assert.equal(SEND_ACK_TRANSPORT_MS, OFFLINE_RESEND_ACK_MS);
  });

  test('传输窗必须覆盖服务端 pre-turn 上界，否则轮次没开跑就被判「未送达」', () => {
    assert.ok(SEND_ACK_TRANSPORT_MS > SERVER_PRE_TURN_UPPER_BOUND_MS);
  });

  // 这条是 2026-08-26 二轮审查发现的漏网之鱼：看门狗守的是同一个窗口，5000 会在 setModel
  // 还没回来时就把乐观 busy 判成「轮次已结束」，运行条与停止按钮中途消失。
  test('busy 看门狗宽限期同样要覆盖 pre-turn 上界', () => {
    assert.ok(BUSY_BROADCAST_CLEAR_GRACE_MS > SERVER_PRE_TURN_UPPER_BOUND_MS);
  });

  test('传输窗必须小于 engine.io 被动判死窗（pingInterval 25s + pingTimeout 20s）', () => {
    assert.ok(SEND_ACK_TRANSPORT_MS < 45000);
  });
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

// 看门狗：终止事件（result/error/interrupted）丢失时，本地 liveLine 会永久卡在 busy=true（见
// shouldBindBusyFromBroadcast 的单向设计——broadcast 只能置 true）。这里补另一半：broadcast 权威态
// 确认不是 busy/permission、且已过宽限期（防止刚发送、服务端 pendingTurns 尚未计入广播的乐观窗口
// 被误清）时，判定强制清空。
test('shouldForceClearBusyFromBroadcast: 本地不忙 → 恒 false（无需清）', () => {
  assert.equal(shouldForceClearBusyFromBroadcast({ state: 'idle', localBusy: false, turnStartTs: 0, now: 999999 }), false);
});

test('shouldForceClearBusyFromBroadcast: state 仍是 busy/permission → false（真的还在跑，不清）', () => {
  assert.equal(shouldForceClearBusyFromBroadcast({ state: 'busy', localBusy: true, turnStartTs: 0, now: 999999 }), false);
  assert.equal(shouldForceClearBusyFromBroadcast({ state: 'permission', localBusy: true, turnStartTs: 0, now: 999999 }), false);
});

test('shouldForceClearBusyFromBroadcast: state 非 busy 但未过宽限期 → false（防误清刚发送的乐观窗口）', () => {
  assert.equal(shouldForceClearBusyFromBroadcast({
    state: 'idle', localBusy: true, turnStartTs: 1000, now: 1000 + BUSY_BROADCAST_CLEAR_GRACE_MS - 1,
  }), false);
});

test('shouldForceClearBusyFromBroadcast: state 非 busy 且已过宽限期（含边界 ==）→ true', () => {
  for (const state of ['idle', 'done', 'error', 'aborted', undefined]) {
    assert.equal(shouldForceClearBusyFromBroadcast({
      state, localBusy: true, turnStartTs: 1000, now: 1000 + BUSY_BROADCAST_CLEAR_GRACE_MS,
    }), true, `state=${state}`);
  }
});

test('shouldForceClearBusyFromBroadcast: 缺 turnStartTs（防御性兜底）→ 只要非 busy/permission 就直接放行清空', () => {
  assert.equal(shouldForceClearBusyFromBroadcast({ state: 'idle', localBusy: true, turnStartTs: null, now: 1 }), true);
  assert.equal(shouldForceClearBusyFromBroadcast({ state: 'idle', localBusy: true, now: 1 }), true);
});

// ---- 离线 outbox 重发撞上在途轮 ----
// 排队移除后，重连重发可能撞上「已经有一轮在跑」（比如队列首条刚发出去就开跑，第 2/3 条紧随其后）。
// 这类消息不能再 requeue 空转（那就是客户端排队），落 blocked 终态由用户手动重发。
test.describe('presentOfflineResendAck: busy 拒收', () => {
  test('busy 负 ack → outcome=blocked，不重新入队', () => {
    const out = presentOfflineResendAck(null, {
      ok: false,
      error: '当前任务运行中，请等待完成后再发送',
      busy: true,
      retryable: false,
    });
    assert.equal(out.outcome, 'blocked');
    assert.match(out.message, /运行中/);
  });
  test('普通可重试失败仍走 requeue（与 blocked 区分）', () => {
    const out = presentOfflineResendAck(null, { ok: false, error: '发送失败', retryable: true });
    assert.equal(out.outcome, 'requeue');
  });

  // 2026-08-06 F2 回归：externalDirty 置换被拒（server 侧 externalDirtyBusyNack）经 app.js 转发后，
  // 两条 present* 路径都必须判成「忙拒收」，不得落兜底 requeue——离线路径的 requeue 意味着每次
  // 重连自动重发一遍、条目永不退场（e32eb70 补 stale 维之后，busy 维的同型缺口）。
  test('externalDirty 忙拒收 ack → 离线 blocked 终态 / 在线不 requeue', () => {
    const nacks = [
      externalDirtyBusyNack({ pendingTurns: 1 }),
      externalDirtyBusyNack({ bgTaskCount: 2 }),
    ];
    for (const nack of nacks) {
      // 逐字段对齐 app/src/server/app.js externalDirty 分支的 ack 转发形状
      const ack = { ok: false, error: nack.error, busy: nack.busy === true, retryable: nack.retryable, reason: nack.reason };
      const off = presentOfflineResendAck(null, ack);
      assert.equal(off.outcome, 'blocked', `${nack.reason}: 离线必须落终态待手动重发`);
      assert.equal(off.requeue, false);
      const on = presentOnlineSendAck(ack);
      assert.equal(on.requeue, false, `${nack.reason}: 在线不得自动重排队（等于把排队搬到客户端）`);
      assert.equal(on.restoreDraft, true, '文字应回填输入框由用户决定何时重发');
      assert.equal(on.clearBusy, false, '不能把在跑那轮的状态行/停止钮一起清掉');
    }
  });
});

// 离线时在空首页勾上「在新 worktree 里开」连打几条，每条都以 {useWorktree:true, instanceId:null}
// 入队（离线入队路径不 reset 勾选，viewingInstanceId 也还是 null）。重连后逐条重放，而服务端的
// worktreeCreateInFlight 只合并**并发**、合并不了**先后**——第一条 ack 回来时它已经清了，第二条
// 于是又 `git worktree add` 一棵。结果是同一个任务被劈进互不相干的分支、会话与上下文，
// 而 UI 上没有任何提示。批次归属只有客户端知道，判据就落在这里。
test.describe('离线重放：worktree 意图每批只兑现一次', () => {
  const first = { clientMessageId: 'm1', text: '第一条', useWorktree: true, sourceBranch: 'main', instanceId: null, cwd: '/repo' };
  const second = { clientMessageId: 'm2', text: '第二条', useWorktree: true, sourceBranch: 'main', instanceId: null, cwd: '/repo' };
  const plain = { clientMessageId: 'm3', text: '普通', instanceId: 'inst_9', cwd: '/repo' };

  test('还没有锚 → 第一条原样发出（由它去建树）', () => {
    assert.deepEqual(planOutboxWorktreeReuse(first, null), first);
  });

  test('已有锚 → 后续条改投那个实例，并摘掉 worktree 意图', () => {
    const out = planOutboxWorktreeReuse(second, 'inst_7');
    assert.equal(out.instanceId, 'inst_7', '不改投就会再建一棵树');
    assert.equal(out.useWorktree, false, '带着意图只会让服务端对一个已在跑的会话重复判断');
    assert.equal(out.sourceBranch, null);
    assert.equal(out.text, '第二条', '其余字段必须原样带过去');
    assert.equal(second.instanceId, null, '不得就地改写队列项');
  });

  test('没勾 worktree 的条目不受影响（哪怕本批已有锚）', () => {
    assert.deepEqual(planOutboxWorktreeReuse(plain, 'inst_7'), plain);
  });

  test('锚点：第一条 worktree 成功后记下它的 instanceId', () => {
    assert.equal(nextOutboxWorktreeAnchor(first, { outcome: 'ok', instanceId: 'inst_7' }, null), 'inst_7');
  });

  test('锚点：失败的那条不设锚（否则后续全被改投到一个不存在的实例）', () => {
    assert.equal(nextOutboxWorktreeAnchor(first, { outcome: 'requeue', instanceId: null }, null), null);
    assert.equal(nextOutboxWorktreeAnchor(first, { outcome: 'blocked' }, null), null);
  });

  test('锚点：已有锚就不再变（后续条目已被改投，不该覆盖）', () => {
    assert.equal(nextOutboxWorktreeAnchor(second, { outcome: 'ok', instanceId: 'inst_8' }, 'inst_7'), 'inst_7');
  });

  test('锚点：普通条目成功不得把无关实例写成锚', () => {
    assert.equal(nextOutboxWorktreeAnchor(plain, { outcome: 'ok', instanceId: 'inst_9' }, null), null);
  });

  test('ack 透传 instanceId —— 不传锚点就永远设不上', () => {
    assert.equal(presentOfflineResendAck(null, { ok: true, instanceId: 'inst_7' }).instanceId, 'inst_7');
    assert.equal(presentOfflineResendAck(null, { ok: true }).instanceId, null);
  });
});

test.describe('resolveRunStateFromSnapshot —— instances 快照的唯一解释处', () => {
  // 这五格覆盖 state/bgActive/turnRunning 的全部有意义组合。四个消费点（bindView 播种 /
  // 广播对齐 / 回放对账 / ticker 自检）都经这里，所以改这张表等于同时改四处。
  const cases = [
    ['前台轮在跑（无后台任务）',     { state: 'busy', bgActive: false, turnRunning: true },  { busy: true,  turnRunning: true }],
    ['前台轮 + 真后台任务并存',      { state: 'busy', bgActive: true,  turnRunning: true },  { busy: true,  turnRunning: true }],
    ['纯后台任务（前台已结束）',     { state: 'busy', bgActive: true,  turnRunning: false }, { busy: false, turnRunning: false }],
    ['待审批',                       { state: 'permission', bgActive: false, turnRunning: false }, { busy: true, turnRunning: false }],
    ['真空闲',                       { state: 'idle', bgActive: false, turnRunning: false }, { busy: false, turnRunning: false }],
  ];
  for (const [label, live, expected] of cases) {
    test(label, () => {
      assert.deepEqual(resolveRunStateFromSnapshot(live), expected);
    });
  }

  test('turnRunning 为真时 bgActive 不得把前台轮抹掉（review 第四轮 P2 的形态）', () => {
    assert.equal(resolveRunStateFromSnapshot({ state: 'busy', bgActive: true, turnRunning: true }).busy, true);
  });

  test('纯后台任务期不由运行条表达——那一段归 task_progress 横幅（review 第三轮 P2 的形态）', () => {
    assert.equal(resolveRunStateFromSnapshot({ state: 'busy', bgActive: true, turnRunning: false }).busy, false);
  });

  test('查不到实例 → null（没有权威意见），不是「已经结束」', () => {
    assert.equal(resolveRunStateFromSnapshot(null), null);
    assert.equal(resolveRunStateFromSnapshot(undefined), null);
  });
});

test.describe('shouldClearBusyBySnapshot —— 广播看门狗与 ticker 自检共用', () => {
  const now = 1_000_000;
  const busyLive = { state: 'busy', bgActive: false, turnRunning: true };
  const idleLive = { state: 'idle', bgActive: false, turnRunning: false };
  const bgOnly = { state: 'busy', bgActive: true, turnRunning: false };

  test('本地不忙 → 不清（没什么可清的）', () => {
    assert.equal(shouldClearBusyBySnapshot({ live: idleLive, localBusy: false, turnStartTs: now - 99_000, now }), false);
  });

  test('权威说还在跑 → 不清', () => {
    assert.equal(shouldClearBusyBySnapshot({ live: busyLive, localBusy: true, turnStartTs: now - 99_000, now }), false);
  });

  test('查不到实例 → 不清（乐观 busy 期实例还没进广播）', () => {
    assert.equal(shouldClearBusyBySnapshot({ live: null, localBusy: true, turnStartTs: now - 99_000, now }), false);
  });

  test('宽限窗内不清，窗外才清——服务端那段窗口里还没把在途轮记上账', () => {
    assert.equal(shouldClearBusyBySnapshot({ live: idleLive, localBusy: true, turnStartTs: now - 1_000, now }), false);
    assert.equal(shouldClearBusyBySnapshot({ live: idleLive, localBusy: true, turnStartTs: now - (BUSY_BROADCAST_CLEAR_GRACE_MS + 1), now }), true);
  });

  test('纯后台任务期【要】清——ticker 此前漏了这一折算（review 第六轮 P2）', () => {
    assert.equal(shouldClearBusyBySnapshot({ live: bgOnly, localBusy: true, turnStartTs: now - 99_000, now }), true);
  });
});
