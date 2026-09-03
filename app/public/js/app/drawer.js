// 左抽屉（会话侧栏）的开合与移动端边缘滑动手势。三个拖拽游标是本模块私有状态。
//
// 桌面宽度（≥1024px）下抽屉常驻，开合是 no-op——判断留在本模块内，调用方不必各自记得。
export function createDrawerController(context, {
  $: byId,
  haptic = () => {},
  onOpened = () => {},
  onClosed = () => {},
  doc = document,
  win = window,
  desktopMinWidth = 1024,
} = {}) {
  const leftSidebar = byId('leftSidebar'), sidebarScrim = byId('sidebarScrim'), sidebarClose = byId('sidebarClose');

  let dragStartX = 0, dragStartY = 0, dragActive = false;

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

  const controller = { openLeftSidebar, closeLeftSidebar };
  context.state.drawer = controller;
  return controller;
}
