// tests/unit/logic-history-prefetch.test.mjs —— 点开非活会话时预取的历史还能不能直接用。
//
// 预取在点击时发出，和 session:switch 并行；sync:since 的 ack 要等视图绑过来才发、才回。两次读之间
// 磁盘可能被终端写过（变长）或被 rewind 截过（变短），所以只有 sync:since 报的 diskLen 和预取到的条数
// 正好相等才复用，其余一律照常重新拉。这是 shouldReloadOnEnter 'keep' 判据（diskLen ≤ seenDiskLen）
// 收紧成相等：预取这份还没画过，短了也不能当最新。
import assert from 'node:assert/strict';
import test from 'node:test';

import { prefetchedHistoryFits } from '../../app/public/js/logic.js';

const msgs = n => Array.from({ length: n }, (_, i) => ({ role: 'user', text: `m${i}` }));

test.describe('prefetchedHistoryFits：预取的历史和 sync:since 报的磁盘条数对得上才复用', () => {
  test('条数与 diskLen 相等 → 复用', () => {
    assert.equal(prefetchedHistoryFits({ diskLen: 2000, err: null, res: { messages: msgs(2000), total: 2100 } }), true);
  });
  test('预取之后磁盘变长（终端写过）→ 不复用', () => {
    assert.equal(prefetchedHistoryFits({ diskLen: 2001, err: null, res: { messages: msgs(2000) } }), false);
  });
  test('预取之后磁盘变短（rewind 截过）→ 不复用', () => {
    assert.equal(prefetchedHistoryFits({ diskLen: 1990, err: null, res: { messages: msgs(2000) } }), false);
  });
  // replayed>0 时真 server 不读盘，diskLen 恒为 null：看不出磁盘有没有变，只能重新拉
  test('diskLen 为空（server 没读盘）→ 不复用', () => {
    assert.equal(prefetchedHistoryFits({ diskLen: null, err: null, res: { messages: msgs(3) } }), false);
    assert.equal(prefetchedHistoryFits({ diskLen: undefined, err: null, res: { messages: [] } }), false);
  });
  test('预取超时或读盘失败 → 不复用（失败横幅以重新拉的那次为准）', () => {
    assert.equal(prefetchedHistoryFits({ diskLen: 0, err: new Error('operation has timed out'), res: undefined }), false);
    assert.equal(prefetchedHistoryFits({ diskLen: 0, err: null, res: { messages: [], error: '会话不存在' } }), false);
  });
  test('空会话：两边都是 0 → 复用', () => {
    assert.equal(prefetchedHistoryFits({ diskLen: 0, err: null, res: { messages: [] } }), true);
  });
});
