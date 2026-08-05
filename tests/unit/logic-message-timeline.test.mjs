// tests/unit/logic-message-timeline.test.mjs —— 消息流时间戳的判定层与格式化层纯单测。
// 跑法：npm run test:unit。判定层零 i18n、纯算术；格式化层吃 i18n.js 的模块级 currentLang。
// 覆盖：ts 归一 / 本地日历日 / marker 判定七条规则（首条·跨天·阈值·同轮抑制·时钟回拨）/ 中英文案。
// 不覆盖 DOM 插入（归 tests/unit/frontend-message-timeline.test.mjs 与 P0 E2E）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMessageTs, isSameLocalDay, resolveMessageTimeMarker, MESSAGE_TIME_GAP_MS,
  formatClockHm, formatCalendarDayLabel, formatMessageTimeMarker,
} from '../../public/js/logic.js';
import { setLang } from '../../public/js/i18n.js';

// 用本地时间构造，避免 UTC 换算把「本地日历日」判定测偏（判定层全程走 getFullYear/getMonth/getDate）。
const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();

test('normalizeMessageTs：epoch 数字原样返回，ISO 串转 epoch ms', () => {
  const ms = at(2026, 8, 4, 14, 20);
  assert.equal(normalizeMessageTs(ms), ms);
  assert.equal(normalizeMessageTs(new Date(ms).toISOString()), ms);
  assert.equal(normalizeMessageTs(new Date(ms)), ms);
});

test('normalizeMessageTs：undefined/null/空串/非法串/NaN/0/负数 一律 null', () => {
  for (const bad of [undefined, null, '', '   ', 'not-a-date', NaN, Infinity, 0, -1, {}, []]) {
    assert.equal(normalizeMessageTs(bad), null, `期望 null：${JSON.stringify(bad)}`);
  }
});

test('isSameLocalDay：同一本地日历日 → true', () => {
  assert.equal(isSameLocalDay(at(2026, 8, 4, 0, 1), at(2026, 8, 4, 23, 59)), true);
});

test('isSameLocalDay：相隔 2 分钟但跨本地午夜 → false', () => {
  assert.equal(isSameLocalDay(at(2026, 8, 3, 23, 59), at(2026, 8, 4, 0, 1)), false);
});

// ---- resolveMessageTimeMarker：七条规则，顺序即语义 ----

test('resolveMessageTimeMarker：会话首条（prevTs null）→ day，assistant 也给', () => {
  const ts = at(2026, 8, 4, 9, 0);
  assert.deepEqual(resolveMessageTimeMarker({ ts, prevTs: null, role: 'user' }), { kind: 'day', ts });
  // 首条恰好是 assistant（fork 出来的会话）也要给日期头，否则整段历史没有日期归属
  assert.deepEqual(resolveMessageTimeMarker({ ts, prevTs: null, role: 'assistant' }), { kind: 'day', ts });
});

test('resolveMessageTimeMarker：ts 非法 → null', () => {
  assert.equal(resolveMessageTimeMarker({ ts: null, prevTs: at(2026, 8, 4, 9, 0), role: 'user' }), null);
  assert.equal(resolveMessageTimeMarker({ ts: NaN, prevTs: null, role: 'user' }), null);
});

test('resolveMessageTimeMarker：user 同日间隔 3 分钟 → null', () => {
  assert.equal(resolveMessageTimeMarker({
    ts: at(2026, 8, 4, 9, 3), prevTs: at(2026, 8, 4, 9, 0), role: 'user',
  }), null);
});

test('resolveMessageTimeMarker：user 同日恰好 5 分钟 → time（闭区间）', () => {
  const ts = at(2026, 8, 4, 9, 5);
  assert.deepEqual(resolveMessageTimeMarker({
    ts, prevTs: at(2026, 8, 4, 9, 0), role: 'user',
  }), { kind: 'time', ts });
});

// ★ 同轮抑制：Claude 回合动辄十几分钟，若 role 无关则几乎每轮一行，稀疏方案当场退化成「每条都显」
test('resolveMessageTimeMarker：assistant 同日超 20 分钟 → null（同轮抑制）', () => {
  assert.equal(resolveMessageTimeMarker({
    ts: at(2026, 8, 4, 9, 20), prevTs: at(2026, 8, 4, 9, 0), role: 'assistant',
  }), null);
});

// ★ 例外：跨天的日期行不受 role 抑制，否则「Claude 跨午夜回复 → 次日整段对话」会丢失日期归属
test('resolveMessageTimeMarker：assistant 跨本地日历日 → day（跨天不受 role 抑制）', () => {
  const ts = at(2026, 8, 4, 0, 2);
  assert.deepEqual(resolveMessageTimeMarker({
    ts, prevTs: at(2026, 8, 3, 9, 1), role: 'assistant',
  }), { kind: 'day', ts });
});

test('resolveMessageTimeMarker：跨天仅隔 2 分钟 → day（跨天优先于阈值）', () => {
  const ts = at(2026, 8, 4, 0, 1);
  assert.deepEqual(resolveMessageTimeMarker({
    ts, prevTs: at(2026, 8, 3, 23, 59), role: 'user',
  }), { kind: 'day', ts });
});

// 时钟回拨/乱序：绝不能画出「今天」后面跟「昨天」
test('resolveMessageTimeMarker：ts 早于 prevTs（时钟回拨）→ null，即使跨天也不出 day', () => {
  assert.equal(resolveMessageTimeMarker({
    ts: at(2026, 8, 3, 23, 0), prevTs: at(2026, 8, 4, 9, 0), role: 'user',
  }), null);
});

test('resolveMessageTimeMarker：gapMs 可注入，自定义阈值生效', () => {
  const args = { ts: at(2026, 8, 4, 9, 2), prevTs: at(2026, 8, 4, 9, 0), role: 'user' };
  assert.equal(resolveMessageTimeMarker(args), null);                       // 默认 5min → 不插
  assert.equal(resolveMessageTimeMarker({ ...args, gapMs: 60_000 })?.kind, 'time'); // 1min → 插
  assert.equal(MESSAGE_TIME_GAP_MS, 5 * 60 * 1000);
});

// ---- 格式化层：吃 i18n.js 的模块级 currentLang ----
// 不用 Intl.DateTimeFormat / toLocaleDateString：输出随浏览器 ICU 版本漂移，断言会脆。
// 同款手搓先例见 serviceStatusBasicRows（logic.js）。

test('formatClockHm：个位数补零', () => {
  assert.equal(formatClockHm(at(2026, 8, 4, 9, 5)), '09:05');
  assert.equal(formatClockHm(at(2026, 8, 4, 14, 20)), '14:20');
  assert.equal(formatClockHm(at(2026, 8, 4, 0, 0)), '00:00');
});

test('formatMessageTimeMarker：kind time 只出 HH:mm，不带日期', () => {
  const ts = at(2026, 8, 4, 14, 20);
  assert.equal(formatMessageTimeMarker({ kind: 'time', ts }, { now: ts }), '14:20');
});

test('formatMessageTimeMarker：今天 → "今天 14:20"', () => {
  const ts = at(2026, 8, 4, 14, 20);
  assert.equal(formatMessageTimeMarker({ kind: 'day', ts }, { now: at(2026, 8, 4, 18, 0) }), '今天 14:20');
});

// 本地日历日判定而非 24h 差：跨午夜 1 分钟就该是「昨天」
test('formatCalendarDayLabel：跨午夜 1 分钟仍判「昨天」', () => {
  assert.equal(formatCalendarDayLabel(at(2026, 8, 3, 23, 59), at(2026, 8, 4, 0, 0)), '昨天');
});

test('formatCalendarDayLabel：月初与年初的「昨天」跨月跨年正确', () => {
  assert.equal(formatCalendarDayLabel(at(2026, 7, 31, 10, 0), at(2026, 8, 1, 10, 0)), '昨天');
  assert.equal(formatCalendarDayLabel(at(2025, 12, 31, 10, 0), at(2026, 1, 1, 10, 0)), '昨天');
});

// ★ 这条是「昨天」必须用 setDate(getDate()-1) 而非 now-86400000 的唯一实证。
// 上面几条在无 DST 的时区（如 Asia/Shanghai）两种实现结果相同，抓不到这个差异——实测确认过。
// 2026-03-08 是美东夏令时前跳日，本地只有 23 小时：从 3/9 00:30 往回减 24h 会落到 3/7 23:30，
// 退过了头，3/8 的消息于是被误判成「更早」而非「昨天」。
test('formatCalendarDayLabel：DST 前跳日的「昨天」不退过头（America/New_York）', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const ts = new Date(2026, 2, 8, 12, 0).getTime();
    const now = new Date(2026, 2, 9, 0, 30).getTime();
    assert.equal(formatCalendarDayLabel(ts, now), '昨天');
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test('formatMessageTimeMarker：同年更早 → "M月D日 HH:mm"；跨年带年份', () => {
  assert.equal(
    formatMessageTimeMarker({ kind: 'day', ts: at(2026, 8, 2, 9, 0) }, { now: at(2026, 8, 4, 18, 0) }),
    '8月2日 09:00');
  assert.equal(
    formatMessageTimeMarker({ kind: 'day', ts: at(2025, 12, 31, 9, 0) }, { now: at(2026, 8, 4, 18, 0) }),
    '2025年12月31日 09:00');
});

test('formatMessageTimeMarker：null marker → 空串（调用方不必先判空）', () => {
  assert.equal(formatMessageTimeMarker(null, { now: Date.now() }), '');
});

test('formatMessageTimeMarker：英文界面 → Today / Yesterday / Aug 2 / Dec 31, 2025', () => {
  setLang('en');
  const now = at(2026, 8, 4, 18, 0);
  assert.equal(formatMessageTimeMarker({ kind: 'day', ts: at(2026, 8, 4, 14, 20) }, { now }), 'Today 14:20');
  assert.equal(formatMessageTimeMarker({ kind: 'day', ts: at(2026, 8, 3, 9, 0) }, { now }), 'Yesterday 09:00');
  assert.equal(formatMessageTimeMarker({ kind: 'day', ts: at(2026, 8, 2, 9, 0) }, { now }), 'Aug 2 09:00');
  assert.equal(formatMessageTimeMarker({ kind: 'day', ts: at(2025, 12, 31, 9, 0) }, { now }), 'Dec 31, 2025 09:00');
  assert.equal(formatMessageTimeMarker({ kind: 'time', ts: at(2026, 8, 4, 14, 20) }, { now }), '14:20');
});

// currentLang 是 i18n.js 的模块级状态，同文件内不复位会污染后续用例
test.after(() => setLang('zh'));
