import { t } from '../i18n.js';
import { formatClockHm } from '../logic/message-time.js';

// 验收 O60 后一半：进程异常退出的提示，切走再切回就不见了，看起来像什么都没发生。
// 提示只在 error 事件到达那一刻写进消息流。切回时若走清屏全量重载（重开的是新实例，磁盘上多了在途那一轮），
// 历史按 transcript 重画，transcript 里没有这句话。这里按会话记住它，历史重画完补一条；用户在这个会话里
// 接着发了消息就算翻篇，不再补。只记在本页内存里：刷新页面、换设备都看不到（服务端不留这份状态）。
export function createCrashNotices({ addBar = () => null, hasNotice = () => false } = {}) {
  const bySession = new Map();
  const byInstance = new Map(); // 「会话已中断」面用：进程可能在 init 之前就退出，那时还没有会话 id
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
    noteInstance(instanceId, message) {
      if (instanceId) byInstance.set(instanceId, message);
    },
    // 刚切过来 / 重连时 sync:since 回放缓冲还开着，进程退出的 error 排在队里没派发，而切视图会把队列丢掉——
    // 在那之前从队列里收下最后一条（#329 review P2）。只有这个实例自己记过才跳过：会话级记录可能是上一个进程的
    // （重开后没再发消息就不会清），拿它当「已有原因」会把这一次的挡掉。
    adoptQueued({ instanceId = null, sessionId = null, queued = [] } = {}) {
      if (!instanceId || byInstance.has(instanceId)) return;
      const crash = queued.findLast(e => e?.type === 'error' && e.payload?.processExited);
      if (!crash) return;
      this.record(sessionId, crash.payload.message, null);
      this.noteInstance(instanceId, crash.payload.message);
    },
    // 「会话已中断」面当场写原因用（验收 O121）：error 先于摘实例的广播到达，出面那一刻这里已经有了。
    // 只认按实例记的：会话级记录可能是上一个进程的（重开后没再发消息就不清），实例被别的设备正常关掉时拿它来
    // 解释，就成了把一次关闭说成崩溃（#329 review P2）。
    reasonFor(instanceId) {
      return (instanceId && byInstance.get(instanceId)) || null;
    },
  };
}
