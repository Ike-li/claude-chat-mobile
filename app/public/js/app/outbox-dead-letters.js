// outbox-dead-letters.js —— 永久拒收、此刻又没地方交还原文的离线条目（PR #232 review）
//
// 重载页面后恢复出来的 outbox 条目没有气泡（bubbleEl 只在内存里）。它若发往不在眼前的会话、又被服务端
// 永久拒收，提示没有落点（outboxNoticeHost 为 null），outbox 已清、不会再发，用户打的字就没了。
// 这里把它落盘暂存，等用户回到它的会话、视图落定后再交还（app.js 的 deliverOutboxDeadLetters）。
// 交还之前别的会话看不见它——把 A 的失败打到 B 上是另一种错（同 outboxNoticePlacement 的判据）。
//
// targetsViewing(item, viewing) 由调用方注入（logic/outbox-send.js 的 outboxItemTargetsViewing），
// 与离线重放判「是不是眼前这个会话」用同一条判据。

const STORAGE_KEY = 'ccm-outbox-dead-letters-v1';

export function createOutboxDeadLetters({ storage, targetsViewing, max = 50 } = {}) {
  let items = read();

  function read() {
    try {
      const data = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(data) ? data.filter(d => d && typeof d === 'object' && typeof d.text === 'string') : [];
    } catch { return []; }
  }
  function write() {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* 隐私模式 / 配额：退回内存 */ }
  }

  return {
    // unreturnable：判了 stale 又没有会话号（isUnreturnableDeadLetter），等不到它自己的会话，由调用方判了传进来、随条目落盘
    park(item, message, { unreturnable = false } = {}) {
      items.push({
        instanceId: item?.instanceId ?? null,
        sessionId: typeof item?.sessionId === 'string' && item.sessionId ? item.sessionId : null,
        cwd: item?.cwd ?? null,
        text: item?.text == null ? '' : String(item.text),
        attachments: Array.isArray(item?.attachments) ? item.attachments : undefined,
        message: String(message || ''),
        unreturnable: unreturnable === true || undefined,
        at: Date.now(),
      });
      if (items.length > max) items = items.slice(-max);
      write();
    },
    // 取走发往眼前这个会话的那些（取走即删），按暂存顺序。交还不了的（升级前入队）等不到它自己的会话，
    // 落到哪个会话就在哪个会话交出来，否则它就悄悄没了（验收 O135）
    takeFor(viewing) {
      const mine = items.filter(d => d.unreturnable === true || targetsViewing(d, viewing));
      if (!mine.length) return [];
      items = items.filter(d => !mine.includes(d));
      write();
      return mine;
    },
    count: () => items.length,
  };
}
