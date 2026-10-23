// app/local-reset.js —— 设置页底部两档：「重新加载」与「重置本机数据」（#302）
//
// 「重新加载」不丢数据：清 Cache Storage、注销 /sw.js 以外的 SW、只删 RELOAD_CLEARABLE_KEYS 里可再生的键。
//   有消息正在重发或排着等本轮结束时拒绝（isSending 由 app.js 注入）。
// 「重置本机数据」先进重置态（app.js 据 isResetting() 挡住 pagehide 回写 outbox、已读位点和日志），
//   beforeReset 断开连接、关掉自动重连，再趁凭据还在复用现有退订流程退订推送，
//   然后清 Cache、注销全部 SW、清空两份 Storage，紧接着 reload。清空与 reload 之间不留 await，
//   免得异步回调把刚清掉的键又写回来。
// 浏览器对象全部从 win 取，单测用假的（tests/unit/local-reset.test.mjs）。

import { RELOAD_CLEARABLE_KEYS, isPushServiceWorker } from '../logic/local-reset.js';

export function createLocalReset({
  win = window,
  isSending = () => false,
  beforeReset = () => {},
  unsubscribePush = async () => true,
  unsubscribeTimeoutMs = 5000,
} = {}) {
  let resetting = false;

  async function clearCaches() {
    try {
      const names = await win.caches?.keys?.() ?? [];
      await Promise.all(names.map(n => win.caches.delete(n)));
    } catch { /* 清不掉就算了：reload 照样拿新的 */ }
  }

  async function unregisterWorkers(keep) {
    try {
      const registrations = await win.navigator?.serviceWorker?.getRegistrations?.() ?? [];
      await Promise.all(registrations
        .filter(r => !keep((r.active || r.waiting || r.installing)?.scriptURL || ''))
        .map(r => r.unregister()));
    } catch { /* 同上 */ }
  }

  async function reloadApp() {
    if (isSending()) return { ok: false, reason: 'sending' };
    await clearCaches();
    await unregisterWorkers(isPushServiceWorker);
    for (const key of RELOAD_CLEARABLE_KEYS) {
      try { win.localStorage.removeItem(key); } catch { /* 隐私模式 */ }
    }
    win.location.reload();
    return { ok: true };
  }

  async function resetLocalData() {
    resetting = true;
    beforeReset();
    let timer;
    await Promise.race([
      Promise.resolve().then(unsubscribePush).catch(() => false),
      new Promise(resolve => { timer = setTimeout(resolve, unsubscribeTimeoutMs); }),
    ]);
    clearTimeout(timer);
    await clearCaches();
    await unregisterWorkers(() => false);
    try { win.localStorage.clear(); } catch { /* 隐私模式 */ }
    try { win.sessionStorage.clear(); } catch { /* 同上 */ }
    win.location.reload();
  }

  return { reloadApp, resetLocalData, isResetting: () => resetting };
}
