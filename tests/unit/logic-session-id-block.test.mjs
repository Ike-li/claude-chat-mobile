// tests/unit/logic-session-id-block.test.mjs —— 会话设置底部「🆔 会话标识」块的空态判定。
//
// 背景：session id 是懒创建的（见 app.js FE-001 注释）——新会话懒开时 entry.sessionId=null，
// 要等 SDK 首个 init 事件才有。此前那一栏整行 hidden，只剩标题孤零零挂在面板底部，形态上像
// 「渲染坏了」而不是「这里暂时没有」。与 effortUnsupported 同一条既定立场（app.js:3735
// 「整段不再消失——凭空少一栏用户只会以为界面坏了」）：不留白，就地说明。
//
// 文案的失败方向：只描述机制（「发出第一条消息后由 CLI 创建」），不断言用户做没做——
// 「已发送但 init 未回」那个短窗里，说「你还没发」就是在说谎。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionIdBlockView } from '../../public/js/logic.js';

test('sessionIdBlockView: 有 session id 时显示复制行、不出说明', () => {
  const view = sessionIdBlockView({ sessionId: '9f3c1a20-1111-2222-3333-444455556666' });
  assert.equal(view.showRow, true);
  assert.equal(view.hint, null);
});

test('sessionIdBlockView: 无 session id 时收起复制行，改出就地说明（不留白）', () => {
  const view = sessionIdBlockView({ sessionId: null });
  assert.equal(view.showRow, false);
  assert.ok(view.hint, '空态必须给出说明，不能是 null——留白正是本次要修的形态');
  assert.match(view.hint, /第一条消息/);
});

test('sessionIdBlockView: 空串/空白/非字符串一律当缺席（不能拿它当 id 显示）', () => {
  for (const bad of ['', '   ', undefined, 0, false, {}, []]) {
    const view = sessionIdBlockView({ sessionId: bad });
    assert.equal(view.showRow, false, `${JSON.stringify(bad)} 不该被当成有效 id`);
    assert.ok(view.hint);
  }
});

test('sessionIdBlockView: 缺参不崩（与同层判定函数同款容错）', () => {
  const view = sessionIdBlockView();
  assert.equal(view.showRow, false);
  assert.ok(view.hint);
});

// 空态文案不得断言「用户还没发消息」：新会话已发出首条、SDK init 尚未回 session_id 的短窗里
// 那句话是假的。只说机制才在三种空态（空首页 / 未发送 / 分配在途）下同时为真。
test('sessionIdBlockView: 未发送态的文案只描述机制，不断言用户尚未发送', () => {
  const { hint } = sessionIdBlockView({ sessionId: null });
  assert.doesNotMatch(hint, /还没有发|尚未发送|你还没/);
});

// 「分配在途」与「还没发」是两件事，不能同文案。判据是实例的有无：服务端实例是懒开的
// （src/server/app.js:833「session:new 后 viewingInstanceId=null（懒创建无实例）」、2187「无可路由
// 实例则懒开一个」），所以「实例在、id 不在」只可能是消息已发出、正在等 SDK 首个 init。
// 真机 bc29ccc2（P0-NOSID）里这个窗口持续了 31 分钟——那时告诉用户「发出第一条消息后才会分配」
// 是把一个正在等待的状态说成了一个尚未开始的状态。
test('sessionIdBlockView: 有实例却无 id＝消息已发出、id 分配在途，文案须与未发送态不同', () => {
  const assigning = sessionIdBlockView({ sessionId: null, viewingInstanceId: 'inst_1' });
  const notSent = sessionIdBlockView({ sessionId: null, viewingInstanceId: null });
  assert.equal(assigning.showRow, false);
  assert.ok(assigning.hint);
  assert.notEqual(assigning.hint, notSent.hint, '两种空态说同一句话＝把等待中说成尚未开始');
  assert.match(assigning.hint, /创建中|分配中/);
});

// 空首页发出首条到懒开广播回来之间，viewingInstanceId 仍是 null，但用户确实已经发了——
// 这段窗口归「分配在途」，不能说「发出第一条消息后才会分配」。
test('sessionIdBlockView: 首发在途（实例未回但已发送）同样算分配中', () => {
  const view = sessionIdBlockView({ sessionId: null, viewingInstanceId: null, pendingFirstSend: true });
  const assigning = sessionIdBlockView({ sessionId: null, viewingInstanceId: 'inst_1' });
  assert.equal(view.hint, assigning.hint);
});

// 全新会话首轮被中断（app.js:2384 freshInterruptedInstanceId 的设置条件恰是「有实例、无 sid」）：
// 实例还在，但那一轮已经作废，CLI 不会再来分配 ID 了。说「创建中」＝把已停止说成进行中，
// 与本块最初要修的毛病同类（用形态暗示一个不成立的事实）。这档该回到「再发一条才会有」。
test('sessionIdBlockView: 首轮被中断的全新会话不说「创建中」——那轮已经没了', () => {
  const interrupted = sessionIdBlockView({
    sessionId: null, viewingInstanceId: 'inst_1', freshInterrupted: true,
  });
  const notSent = sessionIdBlockView({ sessionId: null, viewingInstanceId: null });
  assert.equal(interrupted.hint, notSent.hint, '中断后没有任何 id 在路上，不能说创建中');
  assert.doesNotMatch(interrupted.hint, /创建中|分配中/);
});

// 有 id 时两个新参数都不该改变结论——id 是唯一决定「显不显复制行」的事实。
test('sessionIdBlockView: 有 id 时忽略实例/首发参数，恒显复制行', () => {
  const view = sessionIdBlockView({ sessionId: 'abc12345-def', viewingInstanceId: null, pendingFirstSend: true });
  assert.equal(view.showRow, true);
  assert.equal(view.hint, null);
});
