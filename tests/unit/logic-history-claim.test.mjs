// tests/unit/logic-history-claim.test.mjs —— findHistoryClaimForPending 纯逻辑单测。
//
// 保护的行为：全量重载历史时，DOM 里那颗未确认的乐观气泡能否被历史里的同一条消息认领。
// 认不出来 → 屏幕上同一条消息两颗气泡（2026-08-27 真机回归）；认错 → 把别人的消息吃掉。
// 判据必须与 app.js 里 handle.user_message 的 matchedBubble 保持同源，见被测函数注释。
import test from 'node:test';
import assert from 'node:assert/strict';
import { findHistoryClaimForPending } from '../../app/public/js/logic.js';

const userMsg = (content, extra = {}) => ({ role: 'user', content, uuid: `u-${content}`, ...extra });

test.describe('findHistoryClaimForPending', () => {
  test('文本相等 → 认领，返回该条的 uuid', () => {
    const messages = [userMsg('hello'), { role: 'assistant', content: 'hi' }, userMsg('发一条')];
    assert.deepEqual(findHistoryClaimForPending({ text: '发一条', messages }), { index: 2, uuid: 'u-发一条' });
  });

  test('历史里没有这条（服务端尚未落盘）→ null，气泡要原样留着', () => {
    const messages = [userMsg('hello')];
    assert.equal(findHistoryClaimForPending({ text: '刚发的', messages }), null);
  });

  test('同样文本发过多次 → 认最后一条（刚发出的必定在最后）', () => {
    const messages = [userMsg('再来一次'), { role: 'assistant', content: 'ok' }, { ...userMsg('再来一次'), uuid: 'u-latest' }];
    assert.deepEqual(findHistoryClaimForPending({ text: '再来一次', messages }), { index: 2, uuid: 'u-latest' });
  });

  test('tool_result 的 role 也是 user，但带 kind → 不当用户气泡', () => {
    const messages = [{ role: 'user', kind: 'tool_result', content: '命中我就错了', uuid: 'u-tool' }];
    assert.equal(findHistoryClaimForPending({ text: '命中我就错了', messages }), null);
  });

  test('content 非字符串（展开项）→ 跳过，不抛', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'x' }], uuid: 'u-arr' }];
    assert.equal(findHistoryClaimForPending({ text: 'x', messages }), null);
  });

  test('纯附件消息：正文都为空，按附件名集合认领', () => {
    const messages = [{ role: 'user', content: '', uuid: 'u-att', attachments: [{ name: 'b.png' }, { name: 'a.png' }] }];
    // 指纹与 buildPendingUserBubble 的 data-att-names 一致：排序后 \0 连接
    assert.deepEqual(findHistoryClaimForPending({ text: '', attNames: 'a.png\0b.png', messages }), { index: 0, uuid: 'u-att' });
  });

  test('纯附件：名字集合对不上 → null', () => {
    const messages = [{ role: 'user', content: '', uuid: 'u-att', attachments: [{ name: 'a.png' }] }];
    assert.equal(findHistoryClaimForPending({ text: '', attNames: 'other.png', messages }), null);
  });

  test('有文本时按文本认，附件不参与——与 matchedBubble 的优先级一致', () => {
    const messages = [{ role: 'user', content: '带图', uuid: 'u-1', attachments: [{ name: 'x.png' }] }];
    assert.deepEqual(findHistoryClaimForPending({ text: '带图', attNames: '完全不同', messages }), { index: 0, uuid: 'u-1' });
  });

  test('既无文本又无附件 → null（无从认领，宁可不认也不能瞎认）', () => {
    assert.equal(findHistoryClaimForPending({ text: '', attNames: '', messages: [userMsg('')] }), null);
  });

  test('历史为空 / 非数组 → null，不抛', () => {
    assert.equal(findHistoryClaimForPending({ text: 'x', messages: [] }), null);
    assert.equal(findHistoryClaimForPending({ text: 'x', messages: null }), null);
    assert.equal(findHistoryClaimForPending(), null);
  });
});
