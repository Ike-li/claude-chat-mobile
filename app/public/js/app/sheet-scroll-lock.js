// 底部 sheet / 设置面板共用的背景滚动锁。两套控制器（settings.js / sheets.js）各自开合，
// 用引用计数合成：任一还开着就保持 html/body 的 ccm-sheet-open，最后一层关掉才摘掉。
const CLASS = 'ccm-sheet-open';
const KEY = 'ccmSheetLocks';

export function acquireSheetScrollLock(doc) {
  if (!doc?.documentElement || !doc.body) return;
  const root = doc.documentElement;
  const n = (Number(root.dataset?.[KEY]) || 0) + 1;
  if (root.dataset) root.dataset[KEY] = String(n);
  root.classList?.add?.(CLASS);
  doc.body.classList?.add?.(CLASS);
}

export function releaseSheetScrollLock(doc) {
  if (!doc?.documentElement || !doc.body) return;
  const root = doc.documentElement;
  const n = Math.max(0, (Number(root.dataset?.[KEY]) || 0) - 1);
  if (n === 0) {
    if (root.dataset) delete root.dataset[KEY];
    root.classList?.remove?.(CLASS);
    doc.body.classList?.remove?.(CLASS);
  } else if (root.dataset) {
    root.dataset[KEY] = String(n);
  }
}
