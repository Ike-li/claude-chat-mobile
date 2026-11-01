// tests/unit/logic-history-prefetch.test.mjs —— 点开非活会话时预取的历史还能不能直接用。
//
// 预取在点击时发出，和 session:switch 并行；sync:since 的 ack 要等视图绑过来才发、才回。两次读之间
// 磁盘可能被终端写过（变长）或被 rewind 截过（变短），所以只有 sync:since 报的 diskLen 和预取到的条数
// 正好相等才复用，其余一律照常重新拉。这是 shouldReloadOnEnter 'keep' 判据（diskLen ≤ seenDiskLen）
// 收紧成相等：预取这份还没画过，短了也不能当最新。
// 截顶的窗口（diskLen 到了 HISTORY_MAX_MESSAGES）光比条数核对不了：两次读都是最近 2000 条，终端写过也还是 2000 条，
// 而镜像引擎切入时把当时的磁盘整份当基线、不推（mirror-engine.js），漏掉的那几条要等终端再写一条、满窗滑动整窗替换才补上。
// 所以截顶时改比削顶前的总条数：sync:since 报 diskTotal，预取的回执带 total，两者同出 history.js 的同一份缓存。
// 没截顶时 total 就等于条数，两条判据是同一条。
import assert from 'node:assert/strict';
import test from 'node:test';

import { HISTORY_WINDOW_MAX, prefetchCheckable, prefetchedHistoryFits } from '../../app/public/js/logic.js';
import { HISTORY_MAX_MESSAGES } from '../../app/src/sessions/history.js';

const msgs = n => Array.from({ length: n }, (_, i) => ({ role: 'user', text: `m${i}` }));

test.describe('prefetchedHistoryFits：预取的历史和 sync:since 报的磁盘条数对得上才复用', () => {
  test('条数与 diskLen 相等 → 复用', () => {
    assert.equal(prefetchedHistoryFits({ diskLen: 1999, err: null, res: { messages: msgs(1999), total: 1999 } }), true);
  });
  test('截顶的窗口：总条数也对得上 → 复用', () => {
    assert.equal(prefetchedHistoryFits({ diskLen: 2000, diskTotal: 2100, err: null, res: { messages: msgs(2000), total: 2100 } }), true);
  });
  // 磁盘 2100 条、两次都只读回最近 2000 条：中间终端写过，窗口往后滑了，条数照样相等，总条数变了
  test('截顶的窗口：条数相等、总条数对不上 → 不复用', () => {
    assert.equal(prefetchedHistoryFits({ diskLen: 2000, diskTotal: 2101, err: null, res: { messages: msgs(2000), total: 2100 } }), false);
  });
  // 前端改动拉下来就生效，后端要重启才换：旧 server 的 sync:since 不报 diskTotal
  test('截顶的窗口、server 没报 diskTotal：条数相等也不复用', () => {
    assert.equal(prefetchedHistoryFits({ diskLen: 2000, err: null, res: { messages: msgs(2000), total: 2100 } }), false);
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

test.describe('prefetchCheckable：sync:since 报的 diskLen 能不能拿来核对预取', () => {
  // 不能核对就不等预取落地、当场重新拉：等它落地再判掉，最长的那些会话要多等一份历史的下行
  test('没到截顶线 → 能核对；到了截顶线或没报 → 不能', () => {
    assert.equal(prefetchCheckable(0), true);
    assert.equal(prefetchCheckable(HISTORY_WINDOW_MAX - 1), true);
    assert.equal(prefetchCheckable(HISTORY_WINDOW_MAX), false);
    assert.equal(prefetchCheckable(null), false);
    assert.equal(prefetchCheckable(undefined), false);
  });
  test('到了截顶线、报了 diskTotal → 能核对；diskLen 没报时 diskTotal 也不算数', () => {
    assert.equal(prefetchCheckable(HISTORY_WINDOW_MAX, 2100), true);
    assert.equal(prefetchCheckable(HISTORY_WINDOW_MAX, null), false);
    assert.equal(prefetchCheckable(null, 2100), false);
  });
  // 前后端互不 import，截顶线在前端另写了一份；后端改了上限这里先红
  test('前端的截顶线与后端 HISTORY_MAX_MESSAGES 同值', () => {
    assert.equal(HISTORY_WINDOW_MAX, HISTORY_MAX_MESSAGES);
  });
});
