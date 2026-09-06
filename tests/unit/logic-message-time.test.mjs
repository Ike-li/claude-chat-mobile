// tests/v2/logic-message-time.test.mjs —— 消息流里时间分隔行的插入判定
// 守护：时间标记的「稀疏」语义——只在用户回来发言时插一行，不是每条都显
// 覆盖：resolveMessageTimeMarker 的六条判据（坏时间戳 / 首条 / 时间倒流 / 跨天 / 角色过滤 / 间隔阈值）
// 槽位：S1（纯函数）
//
// 为什么补这一份：2026-09-05 变异检查发现 `ts <= 0` 的变异体存活。翻成 `ts < 0` 后
// 时间戳 0 会一路走到 `{ kind: 'day', ts: 0 }`，在消息流顶上渲染出一条 1970-01-01 的日期分隔行。
// 0 不是假想输入——它是「字段缺失被归一成 0」的常见落点。
//
// 不测什么 + 为什么：
//  ① formatMessageTimeMarker / formatCalendarDayLabel 的文案 —— 过 i18n 且依赖「今天/昨天」的
//     相对时钟，属另一组用例；本文件只管「插不插这一行」，不管「这行写什么」。
//  ② isSameLocalDay 的时区行为 —— 它是本文件的依赖而非被测对象，跨天用例用本地时间构造，
//     与它同源（都走本地时区），不去伪造 UTC 边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMessageTimeMarker, MESSAGE_TIME_GAP_MS } from '../../app/public/js/logic/message-time.js';

// 本地时间构造：与 isSameLocalDay 的判据同源。
const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi, 0, 0).getTime();

test.describe('resolveMessageTimeMarker', () => {
  test('坏时间戳一律不插行——0 尤其不能变成 1970-01-01 那条', () => {
    // `ts <= 0` 翻成 `<` 时，0 会当成合法时刻走完全程。字段缺失被归一成 0 是常见形态，
    // 结果是消息流顶上凭空出现一条 1970 年的日期分隔。
    for (const ts of [0, -1, NaN, Infinity, undefined, null, '123']) {
      assert.equal(resolveMessageTimeMarker({ ts, role: 'user' }), null,
        `ts=${String(ts)} 不是可用时刻，不得插分隔行`);
    }
  });

  test('首条消息（没有上一条）→ 插日期行', () => {
    const ts = at(2026, 0, 15, 10, 0);
    assert.deepEqual(resolveMessageTimeMarker({ ts, prevTs: null, role: 'user' }), { kind: 'day', ts });
    assert.deepEqual(resolveMessageTimeMarker({ ts, role: 'assistant' }), { kind: 'day', ts },
      '首条的日期行与角色无关——它标的是这段对话从哪天开始');
  });

  test('时间倒流（回放乱序）→ 不插行，不把历史往前推', () => {
    assert.equal(resolveMessageTimeMarker({
      ts: at(2026, 0, 15, 9, 0), prevTs: at(2026, 0, 15, 10, 0), role: 'user',
    }), null);
  });

  test('跨天 → 插日期行，与角色和间隔都无关', () => {
    const ts = at(2026, 0, 16, 0, 1);
    const prevTs = at(2026, 0, 15, 23, 59);   // 只隔 2 分钟，但过了午夜
    assert.deepEqual(resolveMessageTimeMarker({ ts, prevTs, role: 'user' }), { kind: 'day', ts });
    assert.deepEqual(resolveMessageTimeMarker({ ts, prevTs, role: 'assistant' }), { kind: 'day', ts },
      '跨天是硬事实，assistant 气泡也要标');
  });

  test('同一天里只有用户发言才触发时间行——语义是「你什么时候回来的」', () => {
    const prevTs = at(2026, 0, 15, 10, 0);
    const ts = prevTs + MESSAGE_TIME_GAP_MS * 2;   // 间隔足够大
    assert.deepEqual(resolveMessageTimeMarker({ ts, prevTs, role: 'user' }), { kind: 'time', ts });
    for (const role of ['assistant', 'system', undefined]) {
      assert.equal(resolveMessageTimeMarker({ ts, prevTs, role }), null,
        `${String(role)} 气泡不触发时间行，否则长回合里「稀疏」会当场退化成「每条都显」`);
    }
  });

  test('间隔阈值取 >=：恰好等于 gapMs 要插，差一毫秒不插', () => {
    const prevTs = at(2026, 0, 15, 10, 0);
    assert.deepEqual(
      resolveMessageTimeMarker({ ts: prevTs + MESSAGE_TIME_GAP_MS, prevTs, role: 'user' }),
      { kind: 'time', ts: prevTs + MESSAGE_TIME_GAP_MS },
    );
    assert.equal(
      resolveMessageTimeMarker({ ts: prevTs + MESSAGE_TIME_GAP_MS - 1, prevTs, role: 'user' }),
      null,
    );
  });

  test('gapMs 可注入，调用方能收紧或放宽阈值', () => {
    const prevTs = at(2026, 0, 15, 10, 0);
    const ts = prevTs + 1000;
    assert.equal(resolveMessageTimeMarker({ ts, prevTs, role: 'user' }), null, '默认阈值下 1 秒不够');
    assert.deepEqual(resolveMessageTimeMarker({ ts, prevTs, role: 'user', gapMs: 500 }), { kind: 'time', ts });
  });
});
