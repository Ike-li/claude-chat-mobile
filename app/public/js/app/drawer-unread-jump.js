// public/js/app/drawer-unread-jump.js —— 目录头「N 未读」角标 → 依次跳到该目录的下一条未读行。
//
// 为什么角标必须能点（2026-09-08 真机报告）：抽屉列表按 lastUsedAt 降序排，而未读判据是逐条独立的
// `lastUsedAt > seenAt`——两条轴毫无关联，一条未读完全可能排在第 30 行。角标准确报出「这里有 4 条
// 未读」，却答不了「在哪」，屏幕上就是「顶栏说有 4 条、首屏一条都看不见」。数字有了，路径没有。
//
// 循环而不是只跳第一条：4 条未读散在 50 行里，只跳第一条等于只解决了 1/4。
//
// 游标存在本模块的 Map 里，不挂在 DOM 上：目录子树会被 rebuildDirSections 整段替换（实例集变化的
// 局部重建、read:sync 回来重画未读标记都会触发），挂在节点上的 dataset 活不过一次重建，而用户感知
// 不到重建发生过——下一次点击会莫名其妙地跳回第一条。
export function createDrawerUnreadJump({
  getSection,            // cwd → { dirRow, subtree } | undefined（app.js 的 dirSectionNodes.get）
  isExpanded = () => true,
  expandDir = () => {},  // 折叠态先展开；行渲染完由 flushPendingJump 接上跳转
  flashMs = 2000,
  scroll = node => node.scrollIntoView({ block: 'center', behavior: 'smooth' }),
  setTimer = setTimeout,
} = {}) {
  const cursorByDir = new Map();
  let pendingDir = null;

  // 只认真正画出「未读」chip 的行——判定不在本模块重做一遍。DOM 即真相源：chip 由 applyUnreadMark
  // 按 unread.isUnread 画，这里再算一次时间判据就等于把同一条规则实现两遍，迟早漂移。
  function unreadRows(cwd) {
    const section = getSection(cwd);
    if (!section || !section.subtree || !section.subtree.isConnected) return [];
    return [...section.subtree.querySelectorAll('[data-testid="session-row"]')]
      .filter(row => row.querySelector('[data-testid="unread-mark"]'));
  }

  // 返回「这次真的跳了吗」：调用方据此决定要不要退化成只展开目录。
  function jump(cwd) {
    const rows = unreadRows(cwd);
    if (!rows.length) return false;
    const raw = cursorByDir.get(cwd);
    const idx = Number.isFinite(raw) && raw >= 0 ? raw % rows.length : 0;
    cursorByDir.set(cwd, (idx + 1) % rows.length);
    const target = rows[idx];
    scroll(target);
    target.classList.remove('drawer-row-flash');
    void target.offsetWidth; // 强制重排：连点两次落在同一行时，不重排动画不会重播
    target.classList.add('drawer-row-flash');
    setTimer(() => target.classList.remove('drawer-row-flash'), flashMs);
    return true;
  }

  // 角标点击入口。折叠态下行还没渲染（子树是空的），先展开并记下意图——populateSubtree 要等一趟
  // session:list ack 才有行，同步跳只会跳空。
  function request(cwd) {
    if (!isExpanded(cwd)) {
      pendingDir = cwd;
      expandDir(cwd);
      return false;
    }
    return jump(cwd);
  }

  // renderRows 末尾调：这一趟渲染的目录正是刚才点过角标的，就把跳转补上。
  // 只认一次——请求消费掉就清空，否则后续每 12 秒一次的 background revalidate 都会重跳一遍。
  function flushPendingJump(cwd) {
    if (pendingDir !== cwd) return false;
    pendingDir = null;
    return jump(cwd);
  }

  // 目录折叠时清游标：下次点开从第一条未读重新数起，而不是接着上次的下标（那时用户已经离开过这个
  // 列表，"上次数到哪"对他不再有意义）。不传 cwd = 全清（面板整体重建）。
  function resetCursor(cwd) {
    if (cwd === undefined) cursorByDir.clear();
    else cursorByDir.delete(cwd);
    if (cwd === undefined || pendingDir === cwd) pendingDir = null;
  }

  return { request, jump, flushPendingJump, resetCursor };
}
