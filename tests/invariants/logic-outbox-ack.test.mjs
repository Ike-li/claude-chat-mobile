// tests/invariants/logic-outbox-ack.test.mjs —— 发送 ack 的客户端行为契约（在线 / transport / 离线重发三条路径）
// 守护：MSG-01 / REL-01 的【前端半边】——服务端保证同一 clientMessageId 至多驱动一次 agent（见 tests/invariants/server/message-ack.test.mjs），
//       前端保证收到各种 ack 后做对事：要不要重试、要不要回填草稿、气泡留还是撤、在跑那轮的状态行动不动
// 覆盖：presentOnlineSendAck 三分支 · presentOnlineSendTransport 的超时分支 · presentOfflineResendAck 五分支 · 两条路径的 stale 判据一致性
// 槽位：S1（纯函数，数据进数据出）
//
// 为什么用整对象 deepEqual 而不是逐个 assert：
//   这些返回值每一个布尔位都对应一件用户看得见的事（源码注释逐条写了后果）：
//     clearBusy    错了 → 把正在跑那轮的状态行 / 停止钮一起清掉
//     dropBubble   错了 → 留一颗永远转圈的气泡，或把已发出的消息从屏幕上抹掉
//     restoreDraft 错了 → 用户刚打的字没了，或与队列里那份形成双份
//     permanent    错了 → 该重试的不重试（消息丢）／不该重试的每次重连都重发一遍
//   2026-09-05 变异实测：这几个字段的 `false → true` 有 5 个存活——现有测试只挑着断言了其中几个。
//   整对象比较让「新增字段」和「翻转字段」都必须被显式确认，逐个 assert 做不到这一点。
//   message 单独拿出来比：它过 i18n，绑死文案会让翻译改动误伤这份契约。
//
// 不测什么 + 为什么：
//  ① 队列容量与去重（planOutboxEnqueue / parseDurableOutbox）—— 另一组函数，与 ack 语义无关。
//  ② outboxItemTargetsViewing 的 cwd 启发式 —— 源码注释已声明它【不】与服务端逐字等价
//     （同目录多会话时会判错，代价只是文案归属），为一个自认的启发式写等价性断言是自欺。
//  ③ 具体文案 —— 过 i18n，归 i18n 门禁。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  presentOnlineSendAck,
  presentOnlineSendTransport,
  presentOfflineResendAck,
} from '../../app/public/js/logic/outbox-send.js';

// 分离 message 后做整对象比较：布尔契约全覆盖，文案不绑死。
function flags(result) {
  const { message: _msg, ...rest } = result;
  return rest;
}

test.describe('presentOnlineSendAck：在线发送的三条分支', () => {
  test('成功 ack → 什么都不做，气泡留着等 user_message 认领转正', () => {
    assert.deepEqual(flags(presentOnlineSendAck({ ok: true })), {
      ok: true,
      clearBusy: false,
      restoreDraft: false,
      retryable: false,
      permanent: false,
      stale: false,
      requeue: false,
      dropBubble: false,
    });
  });

  test('busy 拒收 → 撤气泡、回填草稿，但【不得】清掉在跑那轮的忙碌态', () => {
    // 被拒的是这条新消息，不是正在跑的那轮。clearBusy 一旦为 true，
    // 用户会看到状态行和停止钮凭空消失，而后台那轮还在跑。
    // requeue 也必须 false：自动重发等于把排队搬到客户端，而服务端已经明确移除了排队。
    assert.deepEqual(flags(presentOnlineSendAck({ ok: false, busy: true, error: '当前任务运行中' })), {
      ok: false,
      busy: true,
      clearBusy: false,
      restoreDraft: true,
      retryable: false,
      permanent: false,
      stale: false,
      requeue: false,
      dropBubble: true,
    });
  });

  test('永久失败（校验不过）→ 不重试、不入队、撤气泡、把字还给用户', () => {
    // permanent 翻成 false 会让这条内容非法的消息进 outbox 无限重发；
    // 反过来 requeue 翻成 true 也一样。两者一起钉。
    assert.deepEqual(flags(presentOnlineSendAck({ ok: false, permanent: true, error: '消息为空或格式无效' })), {
      ok: false,
      clearBusy: true,
      restoreDraft: true,
      retryable: false,
      permanent: true,
      stale: false,
      requeue: false,
      dropBubble: true,
    });
  });

  test('可重试失败 → 进 outbox 自动重发，此时【不】回填草稿（否则与队列里那份成双份）', () => {
    assert.deepEqual(flags(presentOnlineSendAck({ ok: false, error: '网络抖动' })), {
      ok: false,
      clearBusy: true,
      restoreDraft: false,
      retryable: true,
      permanent: false,
      stale: false,
      requeue: true,
      dropBubble: false,   // 留：进 outbox 的气泡由重发认领
    });
  });

  test('stale（目标会话已关闭）是死信，不得进 outbox', () => {
    // 服务端 fail-closed 的负 ack 只带 {stale:true}、不带 permanent。
    // 若把它当可重试，就成了「每次重连重发一遍、永不退场」。
    const byFlag = flags(presentOnlineSendAck({ ok: false, stale: true }));
    assert.equal(byFlag.stale, true);
    assert.equal(byFlag.requeue, false, 'stale 必须退场，不能反复重发');
    assert.equal(byFlag.retryable, false);
    assert.equal(byFlag.dropBubble, true, '确定没发出去 → 撤气泡');
  });
});

test.describe('presentOnlineSendTransport：ack 根本没回来（超时 / 断连）', () => {
  test('有 err → 当作「可能已送达」：入队重试，但气泡留着显示进度', () => {
    // 这一档与「服务端明确拒收」的分别在 dropBubble：超时说明不知道有没有发出去，
    // 撤掉气泡会让一条可能已经在跑的消息从屏幕上消失。
    assert.deepEqual(flags(presentOnlineSendTransport(new Error('timeout'), null)), {
      ok: false,
      clearBusy: true,
      restoreDraft: false,
      retryable: true,
      permanent: false,
      stale: false,
      requeue: true,
      dropBubble: false,
    });
  });

  test('无 err → 原样委托给 presentOnlineSendAck，不另立一套语义', () => {
    for (const ack of [{ ok: true }, { ok: false, busy: true }, { ok: false, permanent: true }]) {
      assert.deepEqual(flags(presentOnlineSendTransport(null, ack)), flags(presentOnlineSendAck(ack)),
        `transport 层不得对 ${JSON.stringify(ack)} 做出与在线路径不同的判断`);
    }
  });
});

test.describe('presentOfflineResendAck：离线队列排空时的五条分支', () => {
  const flagsOf = (err, ack) => flags(presentOfflineResendAck(err, ack));

  test('成功 → 出队，不动忙碌态', () => {
    assert.deepEqual(flagsOf(null, { ok: true }),
      { outcome: 'ok', permanent: false, requeue: false, clearBusyIfViewing: false });
  });

  test('busy → 留在队里等下次，不算失败也不清忙碌态', () => {
    assert.deepEqual(flagsOf(null, { ok: false, busy: true }),
      { outcome: 'blocked', permanent: false, requeue: false, clearBusyIfViewing: false });
  });

  test('stale → 死信出队并清忙碌态（服务端不带 permanent，靠这里识别）', () => {
    const expected = { outcome: 'permanent', permanent: true, requeue: false, clearBusyIfViewing: true };
    assert.deepEqual(flagsOf(null, { ok: false, stale: true }), expected, '认 stale 标志位');
    assert.deepEqual(flagsOf(null, { ok: false, error: 'stale_instance' }), expected, '也认裸协议串');
  });

  test('permanent → 死信出队', () => {
    assert.deepEqual(flagsOf(null, { ok: false, permanent: true, error: '消息过长' }),
      { outcome: 'permanent', permanent: true, requeue: false, clearBusyIfViewing: true });
  });

  test('超时 / 畸形 ack → 兜底重排队，不当成功也不当死信', () => {
    const expected = { outcome: 'requeue', permanent: false, requeue: true, clearBusyIfViewing: false };
    assert.deepEqual(flagsOf(new Error('timeout'), null), expected, '超时');
    assert.deepEqual(flagsOf(null, { ok: false }), expected, '只说失败没说原因');
    assert.deepEqual(flagsOf(null, null), expected, '畸形 ack 不得被当成成功');
    assert.deepEqual(flagsOf(null, undefined), expected);
  });
});

test.describe('两条路径的死信判据必须同向（源码注释声称「逐字对齐」）', () => {
  // 2026-08-05 outbox 三修的教训就在这条线上：两个函数的注释都写着「与对方对齐」，
  // 而那一维从没对齐过。注释保证不了一致，断言才能。
  const cases = [
    ['stale 标志位', { ok: false, stale: true }],
    ['裸 stale_instance 串', { ok: false, error: 'stale_instance' }],
    ['permanent', { ok: false, permanent: true }],
    ['可重试', { ok: false, error: '网络抖动' }],
    ['成功', { ok: true }],
  ];

  for (const [label, ack] of cases) {
    test(`${label}：在线与离线两条路径对「要不要再发一次」给出同一个答案`, () => {
      const online = presentOnlineSendAck(ack);
      const offline = presentOfflineResendAck(null, ack);
      // 在线路径的 requeue 与离线路径的 requeue 是同一个问题的两种问法：
      // 「这条消息还要不要再送一次」。任一侧改了判据而另一侧没跟上，就会出现
      // 「在线时放弃了、离线时还在重发」这种两端表现不一致的分裂。
      const onlineWantsRetry = online.requeue === true;
      const offlineWantsRetry = offline.requeue === true || offline.outcome === 'blocked';
      assert.equal(onlineWantsRetry, offlineWantsRetry,
        `在线 requeue=${online.requeue}，离线 outcome=${offline.outcome} —— 两条路径分叉了`);
    });
  }

  test('⚠ 两处的 permanent 字段【不同义】，不要拿它做跨路径比较', () => {
    // 首版断言 `online.permanent === offline.permanent` 时红了，查下来是断言写错而非代码分叉：
    //   在线路径的 permanent = 严格透传服务端说法（Boolean(ack.permanent)）
    //   离线路径的 permanent = 处置结论「这是死信、要出队」
    // 服务端的 stale 负 ack 【不带】permanent，于是同一个 ack 在两边分别是 false 与 true，
    // 而两者都对。把这条钉下来，免得下次有人看到差异又去"修"其中一边。
    const ack = { ok: false, stale: true };
    assert.equal(presentOnlineSendAck(ack).permanent, false, '在线：服务端没说 permanent，就不能替它说');
    assert.equal(presentOfflineResendAck(null, ack).permanent, true, '离线：stale 的处置结论就是死信');
    // 真正必须一致的是行为维度，已由上面那组用例覆盖。
  });
});
