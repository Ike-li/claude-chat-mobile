// 左抽屉（会话侧栏）的开合、移动端边缘滑动手势，以及抽屉内操作的失败回执。
// 三个拖拽游标与提示条是本模块私有状态。
//
// 桌面宽度（≥1024px）下抽屉常驻，开合是 no-op——判断留在本模块内，调用方不必各自记得。
//
// 【失败回执为什么归这里】它要回答的问题是「用户此刻在看哪一层」，而抽屉的可见性判据
// （移动端的 -translate-x-full / 桌面端的常驻）本来就只有本模块知道。放在调用方就得把这套
// 判据复制一份出去，且状态会落回 app.js 顶层作用域（CLAUDE.md 明令禁止）。
import { focusInto, restoreFocus, setInertReason } from './focus-layers.js';

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
  let focusBefore = null;

  // 桌面档侧栏常驻，不带 -translate-x-full 也是可见的——判据不能只看移动端那个 class。
  const drawerVisible = () => win.innerWidth >= desktopMinWidth || !leftSidebar.classList.contains('-translate-x-full');
  // 收起的抽屉只是移出屏幕，里面的会话行照样能被 Tab 到、回车触发（验收 O77）。桌面档常驻，不 inert；
  // 窗口宽度跨过 desktopMinWidth 时可见性会变，所以 resize 也要重算。
  const syncInert = () => setInertReason(leftSidebar, 'closed', !drawerVisible());
  syncInert();
  win.addEventListener?.('resize', syncInert);

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
    if (!drawerVisible()) focusBefore = doc.activeElement;
    leftSidebar.classList.remove('-translate-x-full');
    sidebarScrim.classList.remove('hidden');
    syncInert();
    focusInto(leftSidebar);
    onOpened();
  }
  function closeLeftSidebar() {
    if (win.innerWidth >= desktopMinWidth) return; // No-op on desktop
    // 先记下焦点在不在抽屉里：一 inert，浏览器就把里面的焦点丢回 body，事后再问就晚了
    const hadFocus = leftSidebar.contains(doc.activeElement);
    leftSidebar.classList.add('-translate-x-full');
    sidebarScrim.classList.add('hidden');
    syncInert();
    // 只在焦点原本在抽屉里时还回去：选完会话后别处已经把焦点放进输入框的，不抢
    if (hadFocus) restoreFocus(focusBefore, doc);
    focusBefore = null;
    clearNotice(); // 这条回执说的是刚才那次操作，抽屉一关它的上下文就结束了
    onClosed();
  }

  if (sidebarClose) sidebarClose.onclick = closeLeftSidebar;
  if (sidebarScrim) sidebarScrim.onclick = closeLeftSidebar;

  // 手势要让位的两种场合（#359）：
  // ① sheet 开着：侧栏会开在 sheet 下面——看不见，焦点却被拿走。判据是两套 sheet 控制器共用的背景滚动锁
  //    body.ccm-sheet-open；审批 / 提问挂着时 body.nav-escape 把侧栏抬到 sheet 之上（挂着审批也能切会话），照常可开。
  // ② 起点在横向可滚的容器里（代码块、diff、表格）：横滑是在滚它。只认 overflow-x 可滚的——截断标题
  //    （overflow:hidden）同样 scrollWidth > clientWidth，却滚不动。
  const sheetCovers = () => doc.body.classList.contains('ccm-sheet-open') && !doc.body.classList.contains('nav-escape');
  function inHorizontalScroller(node) {
    for (let n = node; n && n !== doc.body; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth && /^(auto|scroll)$/.test(win.getComputedStyle(n).overflowX)) return true;
    }
    return false;
  }

  // 移动端：边缘滑动呼出侧边栏，向左滑动收起侧边栏
  doc.addEventListener('touchstart', e => {
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
    dragActive = !sheetCovers() && !inHorizontalScroller(e.target);
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
