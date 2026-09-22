// tests/unit/frontend-sheets.test.mjs —— sheets.js 的开合原语（焦点管理 + Tab 陷阱）单测。
//
// 之前零覆盖，只靠 E2E 走过 happy path。真正容易出错的是嵌套场景：appConfirm 会在已开着的
// 业务 sheet（如 #workspaceModal，见 git-changes.js createWorkspacePanel）之上再开一层
// （如 file-browser.js 的「放弃未保存的修改？」）。DOM 用最小桩（同 frontend-env-config.test.mjs 的做法）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSheetController } from '../../app/public/js/app/sheets.js';

// openSheet 用 requestAnimationFrame 延后移焦；Node 没有这个全局，桩成同步执行即可
// （本测试只关心 Tab 陷阱与焦点栈，不关心移焦的确切时序）。
const realRAF = globalThis.requestAnimationFrame;
test.before(() => { globalThis.requestAnimationFrame = (fn) => fn(); });
test.after(() => { globalThis.requestAnimationFrame = realRAF; });

function focusableNode() {
  const n = {
    disabled: false,
    offsetParent: {},
    focus() { n._doc.activeElement = n; },
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
function sheetNode(focusables = []) {
  return {
    _attrs: {},
    _focusables: focusables,
    classList: mkClassList(),
    offsetHeight: 0,
    getAttribute(k) { return this._attrs[k] ?? null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    querySelectorAll() { return this._focusables; },
  };
}

function fakeDoc() {
  const listeners = { keydown: [] };
  const doc = {
    activeElement: null,
    body: { classList: { _s: new Set(), add(...c) { c.forEach(x => this._s.add(x)); }, remove(...c) { c.forEach(x => this._s.delete(x)); }, toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } } },
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

  controller.openSheet(sheet);
  assert.equal(doc._count('keydown'), 1, '打开后应注册 1 个 Tab 陷阱监听器');
  assert.ok(sheet.classList.contains('sheet-open'));

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

test('嵌套 sheet：appConfirm 在已开着的业务 sheet 之上打开——内层关闭不得摘掉外层的 Tab 陷阱', () => {
  const { doc, controller } = harness();

  const outerF1 = focusableNode(); outerF1._doc = doc;
  const outerF2 = focusableNode(); outerF2._doc = doc;
  const outer = sheetNode([outerF1, outerF2]); // 例如 #workspaceModal

  const innerF1 = focusableNode(); innerF1._doc = doc;
  const inner = sheetNode([innerF1]); // 例如 appConfirm 的 confirmModal

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

// appConfirm 的接线要真跑到，就必须把 confirmModal / confirmOk / confirmCancel 这几个节点造出来：
// 少了 confirmModal，函数第一行 `if (!confirmModal || confirmResolve) return Promise.resolve(false)`
// 就返回了，按钮 onclick → settleConfirm → 兑现 Promise → closeSheet 延时还焦这整条链一步都走不到。
function confirmHarness() {
  const doc = fakeDoc();
  const okBtn = focusableNode(); okBtn._doc = doc;
  const cancelBtn = focusableNode(); cancelBtn._doc = doc;
  const altBtn = focusableNode(); altBtn._doc = doc; altBtn.classList = mkClassList();
  // confirmModal 本身要能被 openSheet/closeSheet 当 sheet 用，另需 style 与遮罩点击的 addEventListener。
  const modal = sheetNode([okBtn, cancelBtn]);
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
  assert.notEqual(doc.activeElement, trigger, '打开后焦点应已移进 sheet（openSheet 的移焦）');

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
