// public/js/app/notice-dismissals.js —— 服务告警的「忽略」（#301）：本机记住哪条告警忽略到了哪个指纹。
//
// 指纹 = 告警 id + 路径集合 + 发生时刻（判定在 logic/service-diag.js 的 serviceNoticeFingerprint），不按文案——
// 切换语言不能让忽略失效；集合变了（A 回来了、B 丢了）或同类告警又发生了一次，指纹对不上，告警自然重新出现。
// 只存本机 localStorage：这是「我这台手机不想再看见」的偏好，不是服务端状态。读写失败（隐私模式、容量满）
// 静默降级为「忽略不落盘」，本次页面里照样生效。
import { serviceNoticeFingerprint } from '../logic/service-diag.js';

const STORAGE_KEY = 'ccm-dismissed-notices-v1';

export function createNoticeDismissals({ storage } = {}) {
  const store = storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null);
  let dismissed = {};
  try {
    const parsed = JSON.parse(store?.getItem(STORAGE_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) dismissed = parsed;
  } catch { /* 坏数据 = 什么都没忽略 */ }

  function dismiss(row) {
    if (!row?.id) return;
    dismissed = { ...dismissed, [row.id]: serviceNoticeFingerprint(row) };
    try { store?.setItem(STORAGE_KEY, JSON.stringify(dismissed)); } catch { /* 写失败 = 只在本页生效 */ }
  }

  return { dismissed: () => dismissed, dismiss };
}
