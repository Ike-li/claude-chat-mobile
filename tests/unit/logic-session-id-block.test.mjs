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
  const view = sessionIdBlockView('9f3c1a20-1111-2222-3333-444455556666');
  assert.equal(view.showRow, true);
  assert.equal(view.hint, null);
});

test('sessionIdBlockView: 无 session id 时收起复制行，改出就地说明（不留白）', () => {
  const view = sessionIdBlockView(null);
  assert.equal(view.showRow, false);
  assert.ok(view.hint, '空态必须给出说明，不能是 null——留白正是本次要修的形态');
  assert.match(view.hint, /第一条消息/);
});

test('sessionIdBlockView: 空串/空白/非字符串一律当缺席（不能拿它当 id 显示）', () => {
  for (const bad of ['', '   ', undefined, 0, false, {}, []]) {
    const view = sessionIdBlockView(bad);
    assert.equal(view.showRow, false, `${JSON.stringify(bad)} 不该被当成有效 id`);
    assert.ok(view.hint);
  }
});

// 空态文案不得断言「用户还没发消息」：新会话已发出首条、SDK init 尚未回 session_id 的短窗里
// 那句话是假的。只说机制才在三种空态（空首页 / 未发送 / 分配在途）下同时为真。
test('sessionIdBlockView: 空态文案只描述机制，不断言用户尚未发送', () => {
  const { hint } = sessionIdBlockView(null);
  assert.doesNotMatch(hint, /还没有发|尚未发送|你还没/);
});
