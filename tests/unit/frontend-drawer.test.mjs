// tests/unit/frontend-drawer.test.mjs —— 左抽屉（会话侧栏）开合与移动端边缘滑动手势
// 钉住：桌面档 no-op 的【两侧对称】+ 边缘滑动的三个阈值（起点 45 / 位移 65 / 主轴 1.5 倍）
// 覆盖：desktop 双向 no-op · open/close 的 class 与回调 · 关闭按钮与遮罩接线
//       · 边缘右滑呼出（含 dragStartX===0 这个源码点名的坑）· 左滑收起 · 垂直滑动不误触
//       · 单次手势只触发一次 · 控制器挂进 context.state
// 槽位：S1（纯逻辑 + 最小 DOM 替身，零 IO、不需要临时目录）
//
// 【为什么这个文件此前不存在】createDrawerController 是全仓两个「零测试引用」的前端工厂之一
// （另一个是 createSessionDeleteController）。2026-09-05 做源码→测试机械映射时查出来的：
// 按文件名 grep 命中的三处全是别的模块提到「drawer」这个词，没有一处真 import 它。
//
// 不测什么 + 为什么：
//  ① `{ passive: true }` 监听器选项、真实 TouchEvent 的合成语义 —— 那是浏览器行为不是控制器判定，
//     属 S3（真 Chromium）。本层用最小替身只钉控制器自己算的那几个条件。
//  ② 抽屉的动画/视觉表现 —— 断言基于 class 增删（`-translate-x-full` / `hidden`），
//     不做像素比对，与仓库既有前端单测同一路做法。

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppContext } from '../../app/public/js/app/context.js';
import { createDrawerController } from '../../app/public/js/app/drawer.js';

// ── 最小 DOM 替身 ────────────────────────────────────────────────────────────
// 只做控制器真正碰到的事：class 增删查 + onclick 赋值。不引 jsdom。
function fakeEl() {
  const classes = new Set();
  return {
    onclick: null,
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
  };
}

// drawerOpen=false 时按真实初始态种上两个 class（抽屉收起 + 遮罩隐藏）。
function harness({ innerWidth = 400, drawerOpen = false } = {}) {
  const els = { leftSidebar: fakeEl(), sidebarScrim: fakeEl(), sidebarClose: fakeEl() };
  if (!drawerOpen) {
    els.leftSidebar.classList.add('-translate-x-full');
    els.sidebarScrim.classList.add('hidden');
  }

  const handlers = new Map();
  const doc = { addEventListener: (type, fn) => handlers.set(type, fn) };
  const win = { innerWidth };
  const calls = { haptic: [], opened: 0, closed: 0 };
  const context = createAppContext();

  const ctl = createDrawerController(context, {
    $: (id) => els[id],
    haptic: (kind) => calls.haptic.push(kind),
    onOpened: () => { calls.opened += 1; },
    onClosed: () => { calls.closed += 1; },
    doc,
    win,
  });

  const touch = (type, clientX, clientY) => handlers.get(type)({ touches: [{ clientX, clientY }] });
  // 一次完整手势：从 (x0,y0) 起，移到 (x1,y1)。
  const swipe = (x0, y0, x1, y1) => { touch('touchstart', x0, y0); touch('touchmove', x1, y1); };
  const isOpen = () => !els.leftSidebar.classList.contains('-translate-x-full');

  return { ctl, els, calls, context, touch, swipe, isOpen };
}

// ── 桌面档：开合都是 no-op ───────────────────────────────────────────────────
// 判断留在模块内（调用方不必各自记得），所以两侧都要钉：只钉 open 的话，
// close 里那行 `if (win.innerWidth >= desktopMinWidth) return;` 删掉不会红。
test.describe('桌面宽度（≥1024）下开合是 no-op', () => {
  test('openLeftSidebar 不动 class、不触发回调与 haptic', () => {
    const h = harness({ innerWidth: 1280 });
    h.ctl.openLeftSidebar();
    assert.equal(h.isOpen(), false, '桌面档抽屉常驻，open 不该改 class');
    assert.equal(h.calls.opened, 0);
    assert.deepEqual(h.calls.haptic, [], '桌面档不该有触感反馈');
  });

  test('closeLeftSidebar 同样 no-op（抽屉是开的就保持开）', () => {
    const h = harness({ innerWidth: 1280, drawerOpen: true });
    h.ctl.closeLeftSidebar();
    assert.equal(h.isOpen(), true, '桌面档 close 不该收起常驻侧栏');
    assert.equal(h.calls.closed, 0);
  });

  test('阈值是 >=：恰好 1024 算桌面，1023 算移动', () => {
    const desktop = harness({ innerWidth: 1024 });
    desktop.ctl.openLeftSidebar();
    assert.equal(desktop.isOpen(), false, '1024 应落在桌面档');

    const mobile = harness({ innerWidth: 1023 });
    mobile.ctl.openLeftSidebar();
    assert.equal(mobile.isOpen(), true, '1023 应落在移动档');
  });
});

// ── 移动档：开合的 class 与回调 ──────────────────────────────────────────────
test.describe('移动宽度下的开合', () => {
  test('open：抽屉滑出、遮罩显示、触感 tap、onOpened 一次', () => {
    const h = harness();
    h.ctl.openLeftSidebar();
    assert.equal(h.isOpen(), true);
    assert.equal(h.els.sidebarScrim.classList.contains('hidden'), false, '遮罩必须一起显示');
    assert.deepEqual(h.calls.haptic, ['tap']);
    assert.equal(h.calls.opened, 1);
  });

  test('close：抽屉收起、遮罩隐藏、onClosed 一次，且【不】发触感', () => {
    const h = harness({ drawerOpen: true });
    h.ctl.closeLeftSidebar();
    assert.equal(h.isOpen(), false);
    assert.equal(h.els.sidebarScrim.classList.contains('hidden'), true);
    assert.equal(h.calls.closed, 1);
    assert.deepEqual(h.calls.haptic, [], '收起没有触感反馈——与 open 不对称，是有意的');
  });

  test('关闭按钮与遮罩都接到 closeLeftSidebar', () => {
    const h = harness({ drawerOpen: true });
    h.els.sidebarClose.onclick();
    assert.equal(h.isOpen(), false);

    h.ctl.openLeftSidebar();
    h.els.sidebarScrim.onclick();
    assert.equal(h.isOpen(), false, '点遮罩也要能收起');
    assert.equal(h.calls.closed, 2);
  });
});

// ── 边缘滑动手势 ────────────────────────────────────────────────────────────
test.describe('移动端边缘滑动', () => {
  test('从左边缘右滑呼出（起点 <45、位移 >65）', () => {
    const h = harness();
    h.swipe(10, 300, 100, 300);
    assert.equal(h.isOpen(), true);
    assert.equal(h.calls.opened, 1);
  });

  // ★ 源码里专门写了注释的坑：dragStartX 可以【合法为 0】（触摸恰好从屏幕最左像素开始，
  // 正是本手势要覆盖的场景）。所以「是否在拖拽中」必须用独立的 dragActive，不能复用
  // dragStartX 自身的 falsy 性。把 dragActive 换成 `if (!dragStartX) return` 只有这条会红。
  test('★ dragStartX === 0 必须照样能呼出（0 不是「未在拖拽」）', () => {
    const h = harness();
    h.swipe(0, 300, 90, 300);
    assert.equal(h.isOpen(), true, '从最左像素起滑是本手势的目标场景，不得被 0 的 falsy 性吃掉');
  });

  test('起点不在边缘（>=45）不呼出', () => {
    const h = harness();
    h.swipe(45, 300, 200, 300);
    assert.equal(h.isOpen(), false);
  });

  test('位移不够（<=65）不呼出', () => {
    const h = harness();
    h.swipe(10, 300, 75, 300);
    assert.equal(h.isOpen(), false, 'diffX 恰好 65 不触发，阈值是严格大于');
  });

  test('垂直为主的滑动不误触（|diffX| 未超 |diffY| 的 1.5 倍）', () => {
    const h = harness();
    h.swipe(10, 300, 110, 400); // diffX=100, diffY=100 → 100 > 150 不成立
    assert.equal(h.isOpen(), false, '竖向滚动列表时不该把抽屉带出来');
  });

  test('主轴判据满足即可（diffX=100 / diffY=60 → 100 > 90）', () => {
    const h = harness();
    h.swipe(10, 300, 110, 360);
    assert.equal(h.isOpen(), true);
  });

  test('抽屉已开时左滑收起', () => {
    const h = harness({ drawerOpen: true });
    h.swipe(200, 300, 100, 300); // diffX = -100
    assert.equal(h.isOpen(), false);
    assert.equal(h.calls.closed, 1);
  });

  test('抽屉已关时左滑什么都不做', () => {
    const h = harness();
    h.swipe(200, 300, 100, 300);
    assert.equal(h.isOpen(), false);
    assert.equal(h.calls.closed, 0, '已经关着，不该再触发一次 onClosed');
  });

  test('一次手势只触发一次（触发后 dragActive 置 false）', () => {
    const h = harness();
    h.touch('touchstart', 0, 300);
    h.touch('touchmove', 90, 300);
    assert.equal(h.calls.opened, 1);

    h.ctl.closeLeftSidebar();          // 手动收起，制造「还能再开」的状态
    h.touch('touchmove', 200, 300);    // 同一次手势的后续移动
    assert.equal(h.calls.opened, 1, '同一次 touchstart 不得触发第二次呼出');
  });

  test('touchmove 先于任何 touchstart 到达时不炸也不触发', () => {
    const h = harness();
    h.touch('touchmove', 300, 300);
    assert.equal(h.isOpen(), false);
    assert.equal(h.calls.opened, 0);
  });
});

test('控制器挂进 context.state.drawer（调用方通过 context 取用，不走全局）', () => {
  const h = harness();
  assert.equal(h.context.state.drawer, h.ctl);
  assert.equal(typeof h.context.state.drawer.openLeftSidebar, 'function');
  assert.equal(typeof h.context.state.drawer.closeLeftSidebar, 'function');
});
