// 左抽屉（会话侧栏）的开合、移动端边缘滑动手势，以及抽屉内操作的失败回执。
// 三个拖拽游标与提示条是本模块私有状态。
//
// 桌面宽度（≥1024px）下抽屉常驻，开合是 no-op——判断留在本模块内，调用方不必各自记得。
//
// 【失败回执为什么归这里】它要回答的问题是「用户此刻在看哪一层」，而抽屉的可见性判据
// （移动端的 -translate-x-full / 桌面端的常驻）本来就只有本模块知道。放在调用方就得把这套
// 判据复制一份出去，且状态会落回 app.js 顶层作用域（CLAUDE.md 明令禁止）。
export function createDrawerController(context, {
  $: byId,
  haptic = () => {},
  onOpened = () => {},
  onClosed = () => {},
  fallbackNotice = () => {},
  doc = document,
  win = window,
  desktopMinWidth = 1024,
} = {}) {
  const leftSidebar = byId('leftSidebar'), sidebarScrim = byId('sidebarScrim'), sidebarClose = byId('sidebarClose');
  const drawerNotice = byId('drawerNotice');

  let dragStartX = 0, dragStartY = 0, dragActive = false;

  // 桌面档侧栏常驻，不带 -translate-x-full 也是可见的——判据不能只看移动端那个 class。
  const drawerVisible = () => win.innerWidth >= desktopMinWidth || !leftSidebar.classList.contains('-translate-x-full');

  function clearNotice() {
    if (!drawerNotice) return;
    drawerNotice.textContent = '';
    drawerNotice.classList.add('hidden');
  }

  // 回执去【用户此刻正在看的那一层】，不是固定去抽屉。后者在慢 ACK 这条路径上会复现原 bug：
  // 确认删除 → ACK 未到 → 用户关抽屉 → ACK 到达，提示写进已隐藏的抽屉 → 谁都读不到。
  function showNotice(text) {
    if (!text) { clearNotice(); return; }
    if (!drawerNotice || !drawerVisible()) { fallbackNotice(text); return; }
    drawerNotice.textContent = text;
    drawerNotice.classList.remove('hidden');
  }

  function openLeftSidebar() {
    if (win.innerWidth >= desktopMinWidth) return; // No-op on desktop
    haptic('tap');
    leftSidebar.classList.remove('-translate-x-full');
    sidebarScrim.classList.remove('hidden');
    onOpened();
  }
  function closeLeftSidebar() {
    if (win.innerWidth >= desktopMinWidth) return; // No-op on desktop
    leftSidebar.classList.add('-translate-x-full');
    sidebarScrim.classList.add('hidden');
    clearNotice(); // 这条回执说的是刚才那次操作，抽屉一关它的上下文就结束了
    onClosed();
  }

  if (sidebarClose) sidebarClose.onclick = closeLeftSidebar;
  if (sidebarScrim) sidebarScrim.onclick = closeLeftSidebar;

  // 移动端：边缘滑动呼出侧边栏，向左滑动收起侧边栏
  doc.addEventListener('touchstart', e => {
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
    dragActive = true;
  }, { passive: true });

  doc.addEventListener('touchmove', e => {
    if (!dragActive) return;
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const diffX = currentX - dragStartX;
    const diffY = currentY - dragStartY;

    if (Math.abs(diffX) > Math.abs(diffY) * 1.5) {
      // 从左边缘起（clientX < 45px）向右滑动呼出——注意 dragStartX 可以合法为 0（触摸恰好从屏幕最左
      // 像素开始，正是本手势要覆盖的场景），故"是否在拖拽中"须用独立的 dragActive 判断，不能复用
      // dragStartX 本身的 falsy 性（0 会被误判成"未在拖拽"）。
      if (leftSidebar.classList.contains('-translate-x-full') && dragStartX < 45 && diffX > 65) {
        openLeftSidebar();
        dragActive = false; // 防止重复触发
      }
      // 向左滑动收起
      else if (!leftSidebar.classList.contains('-translate-x-full') && diffX < -65) {
        closeLeftSidebar();
        dragActive = false; // 防止重复触发
      }
    }
  }, { passive: true });

  const controller = { openLeftSidebar, closeLeftSidebar, showNotice };
  context.state.drawer = controller;
  return controller;
}
