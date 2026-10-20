import { t } from '../i18n.js';
import { formatClockHm } from '../logic/message-time.js';

// 验收 O60 后一半：进程异常退出的提示，切走再切回就不见了，看起来像什么都没发生。
// 提示只在 error 事件到达那一刻写进消息流。切回时若走清屏全量重载（重开的是新实例，磁盘上多了在途那一轮），
// 历史按 transcript 重画，transcript 里没有这句话。这里按会话记住它，历史重画完补一条；用户在这个会话里
// 接着发了消息就算翻篇，不再补。只记在本页内存里：刷新页面、换设备都看不到（服务端不留这份状态）。
export function createCrashNotices({ addBar = () => null, hasNotice = () => false } = {}) {
  const bySession = new Map();
  // 标记让「DOM 缓存原样恢复、当场那条还在」时不重复补
  const mark = bar => { if (bar) bar.dataset.crashNotice = '1'; };

  return {
    record(sessionId, message, bar, at = Date.now()) {
      mark(bar);
      if (sessionId) bySession.set(sessionId, { message, at });
    },
    restore(sessionId) {
      const notice = sessionId ? bySession.get(sessionId) : null;
      if (!notice || hasNotice()) return;
      mark(addBar(`⚠️ ${t('这个会话上次异常退出')}（${formatClockHm(notice.at)}）：${notice.message}`, 'text-danger'));
    },
    clear(sessionId) {
      bySession.delete(sessionId);
    },
  };
}
