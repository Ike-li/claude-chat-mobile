// tests/unit/frontend-sheets.test.mjs —— sheets.js 的开合原语（焦点管理 + Tab 陷阱 + 滚动锁 + 把手手势）单测。
//
// 之前零覆盖，只靠 E2E 走过 happy path。真正容易出错的是嵌套场景：appConfirm 会在已开着的
// 业务 sheet（如 #workspaceModal，见 git-changes.js createWorkspacePanel）之上再开一层
// （如 file-browser.js 的「放弃未保存的修改？」）。DOM 用最小桩（同 frontend-env-config.test.mjs 的做法）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSheetController } from '../../app/public/js/app/sheets.js';
import { acquireSheetScrollLock } from '../../app/public/js/app/sheet-scroll-lock.js';

// openSheet 用 requestAnimationFrame 延后移焦；Node 没有这个全局，桩成同步执行即可
// （本测试只关心 Tab 陷阱与焦点栈，不关心移焦的确切时序）。
const realRAF = globalThis.requestAnimationFrame;
test.before(() => { globalThis.requestAnimationFrame = (fn) => fn(); });
test.after(() => { globalThis.requestAnimationFrame = realRAF; });

function focusableNode() {
  const n = {
    disabled: false,
    offsetParent: {},
    focus(opts) { n._doc.activeElement = n; n._focusOpts = opts; },
  };
  return n;
}

function mkClassList() {
  return {
    _s: new Set(),
    add(...c) { c.forEach(x => this._s.add(x)); },
    remove(...c) { c.forEach(x => this._s.delete(x)); },
    contains(c) { return this._s.has(c); },
    toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
  };
}

// 极简 sheet 元素：classList + querySelectorAll（忽略选择器字符串，直接返回注入的可聚焦子项）。
// contains 只认注入的可聚焦子项——够判断「焦点在不在这层 sheet 里」。
// #399：openSheet 走 focusInto(el)，需要 hasAttribute / setAttribute / focus。
function sheetNode(focusables = []) {
  const node = {
    _attrs: {},
    _focusables: focusables,
    classList: mkClassList(),
    offsetHeight: 0,
    style: {},
    getAttribute(k) { return this._attrs[k] ?? null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    hasAttribute(k) { return k in this._attrs; },
    focus(opts) { if (this._doc) this._doc.activeElement = this; this._focusOpts = opts; },
    querySelectorAll() { return this._focusables; },
    querySelector() { return null; }, // 默认无 .sheet-handle
    contains(n) { return n === this || this._focusables.includes(n); },
  };
  return node;
}

function fakeDoc() {
  const listeners = { keydown: [] };
  const htmlClasses = mkClassList();
  const bodyClasses = mkClassList();
  const doc = {
    activeElement: null,
    documentElement: { classList: htmlClasses, dataset: {} },
    body: { classList: bodyClasses },
    addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); },
    _dispatch(ev, evt) { (listeners[ev] || []).slice().forEach(fn => fn(evt)); },
    _count(ev) { return (listeners[ev] || []).length; },
  };
  return doc;
}

function harness() {
  const doc = fakeDoc();
  const ctx = { state: {} };
  const controller = createSheetController(ctx, { $: () => null, doc });
  return { doc, controller };
}

test('openSheet/closeSheet：Tab 陷阱在打开期间生效、关闭后摘除并还焦', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, controller } = harness();
  const trigger = focusableNode(); trigger._doc = doc;
  doc.activeElement = trigger;

  const f1 = focusableNode(); f1._doc = doc;
  const f2 = focusableNode(); f2._doc = doc;
  const sheet = sheetNode([f1, f2]);
  sheet._doc = doc;

  controller.openSheet(sheet);
  assert.equal(doc._count('keydown'), 1, '打开后应注册 1 个 Tab 陷阱监听器');
  assert.ok(sheet.classList.contains('sheet-open'));
  // #399：初始焦点在容器本身，不在第一个子控件
  assert.equal(doc.activeElement, sheet, 'focusInto 应把焦点放到 sheet 容器');
  assert.equal(sheet.getAttribute('tabindex'), '-1');

  // Tab 到最后一个可聚焦元素时应 wrap 回第一个
  doc.activeElement = f2;
  const evt = { key: 'Tab', shiftKey: false, preventDefault() { this._prevented = true; } };
  doc._dispatch('keydown', evt);
  assert.equal(evt._prevented, true);
  assert.equal(doc.activeElement, f1);

  controller.closeSheet(sheet);
  assert.equal(doc._count('keydown'), 0, '关闭后监听器必须摘除，否则残留监听器累积泄漏');
  // 还焦在滑出动画结束后才发生（closeSheet 里的 300ms）。标题写了「并还焦」就必须真断言它，
  // 否则去掉 closeSheet 那行 focusPrev.focus() 这条用例照样绿。
  assert.notEqual(doc.activeElement, trigger, '300ms 未到时不该已经还焦');
  t.mock.timers.tick(300);
  assert.equal(doc.activeElement, trigger, '关闭动画结束后焦点必须还给打开前聚焦的那个元素');
});

test('openSheet：背景滚动锁随栈增减（ccm-sheet-open）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, controller } = harness();
  const a = sheetNode([]); a._doc = doc;
  const b = sheetNode([]); b._doc = doc;

  controller.openSheet(a);
  assert.ok(doc.documentElement.classList.contains('ccm-sheet-open'));
  assert.ok(doc.body.classList.contains('ccm-sheet-open'));
  assert.equal(doc.documentElement.dataset.ccmSheetLocks, '1');

  controller.openSheet(b);
  assert.equal(doc.documentElement.dataset.ccmSheetLocks, '1', '嵌套开层不重复加锁计数（以栈空为准）');
  assert.ok(doc.body.classList.contains('ccm-sheet-open'));

  controller.closeSheet(b);
  assert.ok(doc.body.classList.contains('ccm-sheet-open'), '外层还开着时应保持锁');

  controller.closeSheet(a);
  assert.equal(doc.body.classList.contains('ccm-sheet-open'), false, '最后一层关闭后解锁');
  assert.equal(doc.documentElement.classList.contains('ccm-sheet-open'), false);
});

test('滚动锁：关一个本来没开着的 sheet 不得扣掉别处（设置面板）持有的锁', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, controller } = harness();
  acquireSheetScrollLock(doc); // 设置面板开着
  const a = sheetNode([]); a._doc = doc;
  controller.closeSheet(a);    // 例：审批在别处答掉后 dropActivePerm 又关一次
  assert.equal(doc.documentElement.dataset.ccmSheetLocks, '1', '没开过的 sheet 关闭时扣掉了别人的锁');
  assert.ok(doc.body.classList.contains('ccm-sheet-open'), '设置面板还开着，背景却解锁了');

  controller.openSheet(a);
  controller.closeSheet(a);
  controller.closeSheet(a);    // 拖关动画期间又点遮罩：同一层关两次
  assert.equal(doc.documentElement.dataset.ccmSheetLocks, '1', '同一层关两次扣了两份锁');
});

test('滚动锁：开着的 sheet 再 open 一次不重复入栈，关一次就解锁', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, controller } = harness();
  const a = sheetNode([]); a._doc = doc;
  controller.openSheet(a);
  controller.openSheet(a);
  assert.equal(doc._count('keydown'), 1, '重复 open 叠了第二个 Tab 陷阱');
  controller.closeSheet(a);
  assert.equal(doc.body.classList.contains('ccm-sheet-open'), false, '重复 open 后关闭仍锁着背景滚动');
});

test('嵌套 sheet：appConfirm 在已开着的业务 sheet 之上打开——内层关闭不得摘掉外层的 Tab 陷阱', () => {
  const { doc, controller } = harness();

  const outerF1 = focusableNode(); outerF1._doc = doc;
  const outerF2 = focusableNode(); outerF2._doc = doc;
  const outer = sheetNode([outerF1, outerF2]); // 例如 #workspaceModal
  outer._doc = doc;

  const innerF1 = focusableNode(); innerF1._doc = doc;
  const inner = sheetNode([innerF1]); // 例如 appConfirm 的 confirmModal
  inner._doc = doc;

  controller.openSheet(outer);
  assert.equal(doc._count('keydown'), 1);

  // 嵌套：外层还开着的时候再开一层（file-browser.js confirmDiscardEdit 走的正是这条路）
  controller.openSheet(inner);
  assert.equal(doc._count('keydown'), 2, '嵌套打开后两层的监听器都应该在——不能互相顶替');

  controller.closeSheet(inner);
  assert.equal(doc._count('keydown'), 1, 'bug: 内层关闭不应该把外层的 Tab 陷阱一并摘掉');

  // 外层的 Tab 陷阱必须仍然真实生效，不是「数量对但功能已经失效」
  doc.activeElement = outerF2;
  const evt = { key: 'Tab', shiftKey: false, preventDefault() { this._prevented = true; } };
  doc._dispatch('keydown', evt);
  assert.equal(evt._prevented, true, '外层的 Tab 陷阱关闭内层后应仍然生效');
  assert.equal(doc.activeElement, outerF1, 'Tab 应 wrap 回外层第一个可聚焦元素');

  controller.closeSheet(outer);
  assert.equal(doc._count('keydown'), 0);
});

// 接力：收起一层、紧接着开另一层（抽屉会话行「⋯」菜单里点「删除」：先收菜单、再开确认）。
// 收起那层要等 300ms 动画才还焦；还焦目标是它打开前的触发按钮——此刻已经压在确认框后面了。
function relayHarness() {
  const { doc, controller } = harness();
  const node = () => { const n = focusableNode(); n._doc = doc; return n; };
  const trigger = node(), item = node(), ok = node();
  const menu = sheetNode([item]); menu._doc = doc;
  const confirm = sheetNode([ok]); confirm._doc = doc;
  doc.activeElement = trigger;
  controller.openSheet(menu); // 焦点进菜单容器（#399 focusInto）
  assert.equal(doc.activeElement, menu, '打开后焦点应在 sheet 容器上');
  controller.closeSheet(menu);
  controller.openSheet(confirm);
  assert.equal(doc.activeElement, confirm, '接力打开后焦点应在新 sheet 容器上');
  return { doc, controller, trigger, confirm, ok, menu };
}

test('接力：前一层到点还焦时，不得把焦点从刚打开的下一层里拽走', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, confirm } = relayHarness();
  t.mock.timers.tick(300); // 菜单的收起动画到点
  assert.equal(doc.activeElement, confirm, '焦点被还到确认框背后的触发按钮：之后 Tab / 回车都落在模态层后面');
});

test('接力：下一层关闭后，焦点回到最初的触发按钮，而不是前一层里已经藏起来的项', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, controller, trigger, confirm } = relayHarness();
  t.mock.timers.tick(300);
  controller.closeSheet(confirm);
  t.mock.timers.tick(300);
  assert.equal(doc.activeElement, trigger, '焦点还给了已收起菜单里的项：真实 DOM 里它 display:none，焦点直接丢到 body');
});

// appConfirm 的接线要真跑到，就必须把 confirmModal / confirmOk / confirmCancel 这几个节点造出来：
// 少了 confirmModal，函数第一行 `if (!confirmModal || confirmResolve) return Promise.resolve(false)`
// 就返回了，按钮 onclick → settleConfirm → 兑现 Promise → closeSheet 延时还焦这整条链一步都走不到。
function confirmHarness() {
  const doc = fakeDoc();
  const okBtn = focusableNode(); okBtn._doc = doc;
  const cancelBtn = focusableNode(); cancelBtn._doc = doc;
  const altBtn = focusableNode(); altBtn._doc = doc; altBtn.classList = mkClassList();
  // confirmModal 本身要能被 openSheet/closeSheet 当 sheet 用，另需 style 与遮罩点击的 addEventListener。
  // #399：确认弹窗无 .sheet-handle（假把手已去掉）
  const modal = sheetNode([okBtn, cancelBtn]);
  modal._doc = doc;
  modal.style = {};
  modal.addEventListener = (ev, fn) => { (modal._on ||= {})[ev] = fn; };
  const nodes = {
    confirmModal: modal,
    confirmSheet: { style: {} },
    confirmTitle: { className: '', textContent: '' },
    confirmBody: { textContent: '', classList: mkClassList() },
    confirmOk: okBtn, confirmCancel: cancelBtn, confirmAlt: altBtn,
  };
  const controller = createSheetController({ state: {} }, { $: (id) => nodes[id] ?? null, doc });
  return { doc, controller, nodes };
}

test('appConfirm：点确定兑现 true，并在关闭动画结束后把焦点还给调用前的元素', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, controller, nodes } = confirmHarness();
  const trigger = focusableNode(); trigger._doc = doc;
  doc.activeElement = trigger;

  const p = controller.appConfirm({ title: '删除？', body: '不可恢复' });
  assert.ok(nodes.confirmModal.classList.contains('sheet-open'), 'appConfirm 应真的把 confirmModal 打开');
  assert.equal(nodes.confirmTitle.textContent, '删除？');
  assert.equal(doc.activeElement, nodes.confirmModal, '打开后焦点应在 sheet 容器（focusInto），不在首个按钮');

  nodes.confirmOk.onclick();
  assert.equal(await p, true, '点确定必须兑现 true');
  assert.equal(nodes.confirmModal.classList.contains('sheet-open'), false);

  // 还焦刻意延后到滑出动画结束（closeSheet 里的 300ms）——不推进定时器就还没发生，
  // 这两条断言合起来钉的是「延时还焦」而不只是「最终焦点对了」。
  assert.notEqual(doc.activeElement, trigger, '300ms 未到时不该已经还焦');
  t.mock.timers.tick(300);
  assert.equal(doc.activeElement, trigger, '关闭动画结束后焦点必须还给调用前的元素');
});

test('appConfirm：点取消兑现 false', { timeout: 2000 }, async () => {
  const { controller, nodes } = confirmHarness();
  const p = controller.appConfirm({ title: 'x' });
  nodes.confirmCancel.onclick();
  assert.equal(await p, false);
});

test('appConfirm：已开着时重入直接兑现 false，不排队不叠加', { timeout: 2000 }, async () => {
  const { controller, nodes } = confirmHarness();
  const first = controller.appConfirm({ title: 'first' });
  assert.equal(await controller.appConfirm({ title: 'second' }), false, '重入应立即兑现 false');
  assert.equal(nodes.confirmTitle.textContent, 'first', '重入不得覆盖已开着那一层的内容');
  nodes.confirmCancel.onclick();
  await first;
});

test('appConfirm：缺 confirmModal 时直接兑现 false（不挂起、不抛异常）', async () => {
  const { controller } = harness(); // $ 恒返回 null
  assert.equal(await controller.appConfirm({ title: 'x' }), false);
});

test('把手下拉：有 .sheet-handle 时超过阈值调用关闭；setGestureDismiss 可覆盖', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, controller } = harness();
  const handle = {
    _listeners: {},
    addEventListener(ev, fn) { this._listeners[ev] = fn; },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  const card = { style: {}, addEventListener() {}, removeEventListener() {} };
  const sheet = sheetNode([]);
  sheet._doc = doc;
  sheet.firstElementChild = card;
  sheet.querySelector = (sel) => (sel === '.sheet-handle' ? handle : null);
  sheet.style = {};

  let customCalls = 0;
  controller.setGestureDismiss(sheet, () => { customCalls += 1; controller.closeSheet(sheet); });

  controller.openSheet(sheet);
  assert.equal(typeof handle._listeners.pointerdown, 'function', '打开后应给把手绑 pointerdown');

  handle._listeners.pointerdown({
    pointerType: 'touch', button: 0, pointerId: 1, clientY: 100,
    target: handle, preventDefault() {},
  });
  handle._listeners.pointermove({
    pointerId: 1, clientY: 220, preventDefault() { this._pd = true; },
  });
  handle._listeners.pointerup({ pointerId: 1 });
  // 位移 120 >= 96 → close；finish 在 transitionend / 280ms
  t.mock.timers.tick(280);
  assert.equal(customCalls, 1, '应走 setGestureDismiss 而不是裸 closeSheet 旁路');
  assert.equal(sheet.classList.contains('sheet-open'), false);
});

test('无 .sheet-handle 时不绑定手势（阻断弹窗）', () => {
  const { doc, controller } = harness();
  const sheet = sheetNode([]);
  sheet._doc = doc;
  sheet.querySelector = () => null;
  controller.openSheet(sheet);
  // 只要不抛、且 _test.getDrag 仍为 null 即可
  assert.equal(controller._test.getDrag(), null);
});
