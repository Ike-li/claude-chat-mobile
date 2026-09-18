// logic/message-time.js —— 消息流时间戳：判定层 + 格式化层
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { getLang, t } from '../i18n.js';

// 时间戳归一。0 与负数一并视为无效——epoch 0 是 1970，在本项目语境里只可能是脏数据。
export function normalizeMessageTs(raw) {
  if (raw == null) return null;
  const ms = raw instanceof Date ? raw.getTime()
    : typeof raw === 'number' ? raw
      : typeof raw === 'string' ? Date.parse(raw)
        : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// 本地日历日相等。刻意不用 (a-b)<86400000：DST 切换日只有 23 或 25 小时，跨月/跨年也算不对。
export function isSameLocalDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear()
    && x.getMonth() === y.getMonth()
    && x.getDate() === y.getDate();
}

// 同批连续消息的默认「静默窗」：窗内不重复插时间行。
export const MESSAGE_TIME_GAP_MS = 5 * 60 * 1000;

// 要不要在这条消息之前插时间行、插哪种。返回 null = 不插。
//
// 【判定顺序即语义，不可调换】
//  2 先于 5：会话首条无条件给日期头，否则 fork 出来的、首条恰为 assistant 的会话整段没有日期归属。
//  3 先于 4：时钟回拨时宁可不插，也不能画出「今天」后面跟「昨天」这种自相矛盾的序列。
//  4 先于 5：跨天的日期行【不受 role 抑制】——否则「Claude 跨午夜回复 → 次日整段对话」全都归不到日子上。
//  5 先于 6：同轮抑制只掐 time 行。Claude 一个回合动辄十几分钟，若 role 无关则几乎每轮一行，
//           「稀疏」当场退化成「每条都显」。语义收敛为「你什么时候回来的」，只由用户发言触发。
//
// prevTs 取【上一条任意主链气泡的创建时刻】（不是上一条 user 的）。注意 assistant 气泡在本轮首个
// text_delta 到达时就建好了，所以它的时刻是回合【开头】而非结束——长回合下会比预期更常插行，
// 这是已知偏差（回写气泡时间戳需要额外状态，不划算）。
export function resolveMessageTimeMarker({ ts, prevTs = null, role, gapMs = MESSAGE_TIME_GAP_MS } = {}) {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (prevTs == null) return { kind: 'day', ts };
  if (ts < prevTs) return null;
  if (!isSameLocalDay(ts, prevTs)) return { kind: 'day', ts };
  if (role !== 'user') return null;
  return ts - prevTs >= gapMs ? { kind: 'time', ts } : null;
}

// ---- 消息流时间戳：格式化层 ----
// 刻意不用 Intl.DateTimeFormat / toLocaleDateString——输出随浏览器 ICU 版本漂移，断言会脆。
// 同款手搓先例见 serviceStatusBasicRows。英文月份是普通常量数组、不进 EN_DICT：
// i18n 门禁只扫「词典有、代码没有」的孤儿 key，把 12 个月份塞进词典反而全是孤儿。
const MONTH_ABBR_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = n => String(n).padStart(2, '0');

export function formatClockHm(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 「今天/昨天/更早」。昨天用 setDate(getDate()-1) 求，不用 now-86400000——
// 后者在 DST 切换日会错一天，也处理不了月初/年初回退。
export function formatCalendarDayLabel(ts, now) {
  if (isSameLocalDay(ts, now)) return t('今天');
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (isSameLocalDay(ts, y.getTime())) return t('昨天');

  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  if (getLang() === 'en') {
    const md = `${MONTH_ABBR_EN[d.getMonth()]} ${d.getDate()}`;
    return sameYear ? md : `${md}, ${d.getFullYear()}`;
  }
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return sameYear ? md : `${d.getFullYear()}年${md}`;
}

// marker → 可直接 textContent 的文案。day 行走微信形态单行「今天 09:00」。
// 若将来要「日期行只写日期、时间另起一行」，只改这里的模板串，判定层零改动。
export function formatMessageTimeMarker(marker, { now = Date.now() } = {}) {
  if (!marker?.kind) return '';
  const hm = formatClockHm(marker.ts);
  return marker.kind === 'day' ? `${formatCalendarDayLabel(marker.ts, now)} ${hm}` : hm;
}
