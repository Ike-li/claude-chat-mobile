// 顶栏「⋯」的下拉（2026-11-07）：新会话 / 首页 / 会话日志平时收着，把顶栏让给工作区胶囊。
// 只管开合。三项的点击处理还在各自原处（btnNew / btnHome 在 app.js，btnConsole 在 console-modal.js）。
//
// 没有遮罩：点外面只是收起，这一下照常落到下面的控件上。
export function createHeaderMenu({ $: byId, haptic = () => {}, doc = document } = {}) {
  const trigger = byId('btnMore');
  const menu = byId('headerMenu');
  const isOpen = () => !menu.classList.contains('hidden');
  const header = trigger.closest('header');
  const setOpen = open => {
    menu.classList.toggle('hidden', !open);
    header.classList.toggle('header-menu-open', open);
    trigger.setAttribute('aria-expanded', String(open));
  };
  const closeAndRefocus = () => {
    setOpen(false);
    trigger.focus({ preventScroll: true });
  };

  trigger.addEventListener('click', () => {
    haptic('tap');
    setOpen(!isOpen());
  });
  // 捕获阶段：赶在项自己的处理之前把焦点挪回 ⋯。openSheet 记的是打开那一刻的焦点，留在项上的话，
  // 关掉日志 sheet 时要还给一个已经藏起来的按钮，焦点就丢到 body 了。
  menu.addEventListener('click', closeAndRefocus, true);
  doc.addEventListener('pointerdown', ev => {
    if (isOpen() && !menu.contains(ev.target) && !trigger.contains(ev.target)) setOpen(false);
  }, true);
  doc.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && isOpen()) closeAndRefocus();
  });
}
