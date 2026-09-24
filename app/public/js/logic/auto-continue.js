// 额度墙「到点自动继续」横幅的纯判定：instances 广播里的 autoContinue 条目 → 这条会话的横幅该说什么、给哪个按钮。
// 状态机在 server（src/server/auto-continue.js），这里只做呈现，不猜也不补状态。
//
// 三个相位各对应 CLI 限额对话框里的一个选项（终端等价）：
//   armed    已布防，到点自动发一句「继续」         → 「取消」          （CLI：esc to cancel）
//   offered  没自动布防（开关关着 / 重置点远于 24h） → 「到点自动继续」  （CLI：Wait here, then continue automatically）
//   stale    到点了但没发（睡过头 / 有别的驾驶员 …）→ 「继续」          （CLI 的 stale 相位同样改为询问）
import { t } from '../i18n.js';

const pad2 = n => String(n).padStart(2, '0');

// 同日只印时分，跨日补月/日——七天窗的重置点常在几天后，只印时分会被读成今天。
// 用看的人的本地时区：手机与主机可以不在一个时区，横幅是给拿着手机的人看的。
export function formatAutoContinueClock(ms, now = Date.now()) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const at = new Date(n);
  const today = new Date(now);
  const hhmm = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const sameDay = at.getFullYear() === today.getFullYear()
    && at.getMonth() === today.getMonth()
    && at.getDate() === today.getDate();
  return sameDay ? hhmm : `${at.getMonth() + 1}/${at.getDate()} ${hhmm}`;
}

// stale 的原因 → 说清「为什么没自动继续」。表里存中文原文、取用点才 t()（模块顶层求值会把语言钉死在 zh）。
const STALE_TEXT = {
  slept: '额度已于 {time} 重置；主机期间休眠，没有自动继续',
  other_driver: '终端或桌面端正开着这个会话，没有自动继续',
  unverified: '读不到这个会话的记录，没有自动继续',
  resume_failed: '会话没能重新打开，没有自动继续',
};
const STALE_FALLBACK = '到点了，但没有自动继续';

export function resolveAutoContinueBanner(entries, sessionId, now = Date.now()) {
  if (!Array.isArray(entries) || !sessionId) return null;
  const e = entries.find(x => x && typeof x === 'object' && x.sessionId === sessionId);
  if (!e) return null;
  const time = formatAutoContinueClock(e.resetsAt, now);
  if (e.phase === 'armed') {
    return { tone: 'info', text: t('额度 {time} 重置，届时自动继续').replace('{time}', time), action: 'cancel', actionLabel: t('取消') };
  }
  if (e.phase === 'offered') {
    if (e.reason === 'horizon') {
      return { tone: 'muted', text: t('额度要到 {time} 才重置（超过 24 小时），不会自动继续').replace('{time}', time), action: 'arm', actionLabel: t('仍要到点继续') };
    }
    return { tone: 'muted', text: t('额度 {time} 重置').replace('{time}', time), action: 'arm', actionLabel: t('到点自动继续') };
  }
  if (e.phase === 'stale') {
    const text = t(STALE_TEXT[e.reason] || STALE_FALLBACK).replace('{time}', time);
    return { tone: 'warn', text, action: 'continueNow', actionLabel: t('继续') };
  }
  return null;
}
