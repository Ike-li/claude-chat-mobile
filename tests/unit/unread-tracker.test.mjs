// tests/unit/unread-tracker.test.mjs —— 未读消息计数判断纯函数单测
// 承接"未读角标"需求：与 instance-latches.js#deriveLatches 同样的拆分理由——"是否计未读"要同时满足
// 两个独立判断（有没有人在看 / 这条事件是不是一条新的顶层消息），混在 onEvent 大回调里写容易漏分支。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isInstanceBeingWatched, resolveUnreadDelta, unreadOnEntryForSync } from '../../app/src/server/unread-tracker.js';

test.describe('isInstanceBeingWatched', () => {
  test('非当前查看实例：无论房间是否有人都判定为未在看', () => {
    assert.equal(isInstanceBeingWatched('inst-2', 'inst-1', true), false);
    assert.equal(isInstanceBeingWatched('inst-2', 'inst-1', false), false);
  });

  test('是当前查看实例但无前台连接（同会话锁屏/断线场景）：判定为未在看', () => {
    assert.equal(isInstanceBeingWatched('inst-1', 'inst-1', false), false);
  });

  test('是当前查看实例且有【前台可见】连接：判定为在看', () => {
    assert.equal(isInstanceBeingWatched('inst-1', 'inst-1', true), true);
  });

  // 判据从「房间连接数 > 0」改为「有没有前台可见的连接」（hasForegroundApprovedClient）。
  // PWA 切后台后 socket 往往还连着（要等 OS 冻结页面才真断），旧判据把这段窗口当成「有人在看」→
  // 一条未读都不计；而推送侧早已按 socket.data.hidden 判前台，两边不一致就会出现最难解释的组合：
  // 手机收到「✅ 任务完成」推送，点回去却是 0 未读、没有「以下为新消息」分割线。
  test('连着但全在后台（socket 未断）：必须计未读，与推送判据一致', () => {
    assert.equal(isInstanceBeingWatched('inst-1', 'inst-1', false), false);
  });

  test('viewingInstanceId 为 null（空首页）：不判定为在看任何实例', () => {
    assert.equal(isInstanceBeingWatched(null, null, true), false);
    assert.equal(isInstanceBeingWatched('inst-1', null, true), false);
  });
});

test.describe('unreadOnEntryForSync', () => {
  // sync:since 原先只回 snapshot。PWA 切后台 socket 未断时 captureUnreadSnapshot 不会跑
  // （connect/setViewing/switch 都没发生），活计数攒在 unreadCounts 里，ack 仍带 0 → 胶囊不出现。
  test('当前查看实例：胶囊数字 = 未 ack 快照 + 离开期间活计数', () => {
    assert.equal(unreadOnEntryForSync({ instanceId: 'inst-1', viewingInstanceId: 'inst-1', snapshot: 0, live: 3 }), 3);
    assert.equal(unreadOnEntryForSync({ instanceId: 'inst-1', viewingInstanceId: 'inst-1', snapshot: 2, live: 3 }), 5);
  });

  test('不是当前查看实例：即使有活计数也回 0（避免把后台会话的快照误报到当前 sync）', () => {
    assert.equal(unreadOnEntryForSync({ instanceId: 'inst-2', viewingInstanceId: 'inst-1', snapshot: 4, live: 7 }), 0);
  });

  test('缺省/脏入参不崩，当 0', () => {
    assert.equal(unreadOnEntryForSync(), 0);
    assert.equal(unreadOnEntryForSync({ instanceId: 'inst-1', viewingInstanceId: 'inst-1' }), 0);
    assert.equal(unreadOnEntryForSync({ instanceId: null, viewingInstanceId: null, snapshot: 2, live: 2 }), 0);
  });

  test('app.js sync:since 必须把 live 交给 unreadOnEntryForSync（只回快照会让 PWA 后台路径胶囊恒 0）', () => {
    const src = readFileSync(new URL('../../app/src/server/app.js', import.meta.url), 'utf8');
    assert.match(src, /unreadOnEntryForSync/);
    assert.match(src, /live:\s*unreadCounts\.get/);
  });
});

test.describe('resolveUnreadDelta', () => {
  test('user_message：每次都算一条新顶层消息，不消费/不产生 lastCountedMessageId', () => {
    assert.deepEqual(
      resolveUnreadDelta({ eventType: 'user_message', payload: {}, lastCountedMessageId: 'm1' }),
      { counts: true, lastCountedMessageId: 'm1' },
    );
  });

  test('text_delta 主链首次出现：算一条，且返回新的 lastCountedMessageId 供调用方写回', () => {
    assert.deepEqual(
      resolveUnreadDelta({ eventType: 'text_delta', payload: { messageId: 'm2' }, lastCountedMessageId: 'm1' }),
      { counts: true, lastCountedMessageId: 'm2' },
    );
  });

  test('text_delta 同一 messageId 重复到达（同一顶层消息的后续增量）：不重复计数', () => {
    assert.deepEqual(
      resolveUnreadDelta({ eventType: 'text_delta', payload: { messageId: 'm2' }, lastCountedMessageId: 'm2' }),
      { counts: false, lastCountedMessageId: 'm2' },
    );
  });

  test('text_delta 带 parentToolUseId（子agent/侧链文本）：不算顶层消息', () => {
    assert.deepEqual(
      resolveUnreadDelta({ eventType: 'text_delta', payload: { messageId: 'm3', parentToolUseId: 'tool-1' }, lastCountedMessageId: 'm2' }),
      { counts: false, lastCountedMessageId: 'm2' },
    );
  });

  test('text_delta 缺 messageId：不计数、不改动去重游标', () => {
    assert.deepEqual(
      resolveUnreadDelta({ eventType: 'text_delta', payload: {}, lastCountedMessageId: 'm2' }),
      { counts: false, lastCountedMessageId: 'm2' },
    );
  });

  test('其它事件类型（tool_use/thinking_delta 等）：一律不计数', () => {
    assert.deepEqual(
      resolveUnreadDelta({ eventType: 'tool_use', payload: {}, lastCountedMessageId: 'm2' }),
      { counts: false, lastCountedMessageId: 'm2' },
    );
    assert.deepEqual(
      resolveUnreadDelta({ eventType: 'thinking_delta', payload: { messageId: 'm4' }, lastCountedMessageId: 'm2' }),
      { counts: false, lastCountedMessageId: 'm2' },
    );
  });
});
