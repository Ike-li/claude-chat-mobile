// tests/unit/frontend-focus-layers.test.mjs —— 键盘焦点分层的 inert 原因叠加与全屏门判定
// 钉住：同一元素因多个原因 inert 时，撤掉一个原因不连带撤掉另一个；全屏门开着时 body 下其余子节点
//       inert、最上面那层（列表里最后一个开着的）不 inert；门全关后只撤自己挂的那份。
// 槽位：S1（最小 DOM 替身，零 IO）
//
// 不测什么 + 为什么：Tab 键真实落点、inert 对焦点与指针的效果、MutationObserver 的触发时机——
// 那是浏览器行为，在 tests/e2e/specs/keyboard-focus-layers.spec.ts（S3，真 Chromium）里测。

import assert from 'node:assert/strict';
import test from 'node:test';

import { createGateFocusController, setInertReason } from '../../app/public/js/app/focus-layers.js';

function fakeEl(id, { hidden = false } = {}) {
  const classes = new Set(hidden ? ['hidden'] : []);
  const attrs = new Map();
  return {
    id,
    inert: false,
    dataset: {},
    isConnected: true,
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    contains(other) { return other === this; },
    closest() { return null; },
    hasAttribute: (k) => attrs.has(k),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    focus() {},
  };
}

test.describe('setInertReason：inert 按原因叠加', () => {
  test('两个原因叠着时撤掉一个，元素仍然 inert；全撤才恢复', () => {
    const el = fakeEl('settingsSheet');
    setInertReason(el, 'closed', true);
    setInertReason(el, 'gate', true);
    setInertReason(el, 'gate', false);
    assert.equal(el.inert, true, '令牌门一关就把「收起」那份也摘掉的话，收起的面板会重新能被 Tab 到');
    setInertReason(el, 'closed', false);
    assert.equal(el.inert, false);
    assert.equal(el.dataset.inertBy, undefined, '没有原因了就不留空属性');
  });

  test('同一原因重复挂 / 重复撤是幂等的', () => {
    const el = fakeEl('x');
    setInertReason(el, 'closed', true);
    setInertReason(el, 'closed', true);
    setInertReason(el, 'closed', false);
    assert.equal(el.inert, false, '挂两次撤一次就该恢复：原因是集合不是计数');
  });
});

test.describe('createGateFocusController：全屏门开着时其余 body 子节点 inert', () => {
  function harness() {
    const authGate = fakeEl('authGate', { hidden: true });
    const accessHelp = fakeEl('accessHelp', { hidden: true });
    const header = fakeEl('header');
    const settingsSheet = fakeEl('settingsSheet');
    const body = fakeEl('body');
    body.children = [authGate, header, settingsSheet, accessHelp];
    const doc = { body, activeElement: body };
    const ctl = createGateFocusController({ gates: [authGate, accessHelp], doc, Observer: null });
    return { ctl, authGate, accessHelp, header, settingsSheet };
  }

  test('门开着：其余节点 inert，门本身不 inert', () => {
    const h = harness();
    h.authGate.classList.remove('hidden');
    h.ctl.sync();
    assert.equal(h.authGate.inert, false);
    assert.equal(h.header.inert, true, '令牌门背后的顶栏仍能被 Tab 到、回车触发（验收 O74）');
    assert.equal(h.accessHelp.inert, true);
  });

  test('两层都开着：列表里靠后的那层在上面，它不 inert、下面那层 inert', () => {
    const h = harness();
    h.authGate.classList.remove('hidden');
    h.accessHelp.classList.remove('hidden');
    h.ctl.sync();
    assert.equal(h.accessHelp.inert, false);
    assert.equal(h.authGate.inert, true, '被访问帮助盖住的令牌门也不该被 Tab 到');
  });

  test('门全关后只撤自己挂的那份：收起着的面板仍然 inert', () => {
    const h = harness();
    setInertReason(h.settingsSheet, 'closed', true);
    h.authGate.classList.remove('hidden');
    h.ctl.sync();
    h.authGate.classList.add('hidden');
    h.ctl.sync();
    assert.equal(h.header.inert, false);
    assert.equal(h.settingsSheet.inert, true);
  });

  // #393：sessionBlockedSurface 是中层 overlay（不是 z-50 gate）；开着时它盖住的背景 inert，关后还焦点。
  test('sessionBlockedSurface 开着时它盖住的背景 inert，关掉后恢复', () => {
    const surface = fakeEl('sessionBlockedSurface', { hidden: true });
    const header = fakeEl('header');
    const composer = fakeEl('composer');
    const body = fakeEl('body');
    body.children = [surface, header, composer];
    let focused = body;
    surface.focus = () => { focused = surface; };
    header.focus = () => { focused = header; };
    const doc = { body, get activeElement() { return focused; } };
    const ctl = createGateFocusController({
      gates: [], overlays: [surface], overlayCovers: () => [header, composer], doc, Observer: null,
    });
    focused = header;
    surface.classList.remove('hidden');
    ctl.sync();
    assert.equal(surface.inert, false);
    assert.equal(header.inert, true, '落地页开着时顶栏不该还能被 Tab 到');
    assert.equal(composer.inert, true);
    assert.equal(focused, surface, '焦点应移入落地页');
    surface.classList.add('hidden');
    focused = body; // 落地页 display:none，焦点随之掉到 body
    ctl.sync();
    assert.equal(header.inert, false);
    assert.equal(composer.inert, false);
    assert.equal(focused, header, '关掉后焦点应还给打开前的元素');
  });

  // #429：落地页 z-20 只盖住主栏。比它高的层都是 body 子节点——排除法（「除了谁全部 inert」）会把它们
  // 一起变成看得见、点不动：设备授权卡 z-30、手机抽屉 z-40、抽屉里弹的会话菜单 z-50。
  test('sessionBlockedSurface 只 inert overlayCovers 点名的元素，更高层照常可交互', () => {
    const surface = fakeEl('sessionBlockedSurface', { hidden: true });
    const header = fakeEl('header');
    const leftSidebar = fakeEl('leftSidebar');
    const sidebarScrim = fakeEl('sidebarScrim');
    const deviceRequests = fakeEl('deviceRequests');
    const sessionMenuModal = fakeEl('sessionMenuModal');
    const body = fakeEl('body');
    body.children = [header, sidebarScrim, leftSidebar, surface, sessionMenuModal, deviceRequests];
    const doc = { body, activeElement: body };
    const ctl = createGateFocusController({
      gates: [], overlays: [surface], overlayCovers: () => [header], doc, Observer: null,
    });
    surface.classList.remove('hidden');
    ctl.sync();
    assert.equal(surface.inert, false);
    assert.equal(header.inert, true, '被盖住的顶栏仍须 inert');
    assert.equal(leftSidebar.inert, false, '手机抽屉在落地页之上，inert 了就翻不了会话列表');
    assert.equal(sidebarScrim.inert, false);
    assert.equal(deviceRequests.inert, false, '设备授权卡（z-30）在落地页之上，被 inert 后批准/拒绝点不动');
    assert.equal(sessionMenuModal.inert, false, '抽屉里弹的菜单在落地页之上，被 inert 后看得见点不动');
  });

  // 桌面常驻侧栏（relative z-10）在落地页之下：同一个元素该不该 inert 取决于打开那一刻的布局，
  // overlayCovers 每次打开时求值。
  test('overlayCovers 每次打开时重新求值（桌面常驻侧栏被盖住时一并 inert）', () => {
    const surface = fakeEl('sessionBlockedSurface', { hidden: true });
    const leftSidebar = fakeEl('leftSidebar');
    const body = fakeEl('body');
    body.children = [leftSidebar, surface];
    const doc = { body, activeElement: body };
    let docked = false;
    const ctl = createGateFocusController({
      gates: [], overlays: [surface], overlayCovers: () => (docked ? [leftSidebar] : []), doc, Observer: null,
    });
    surface.classList.remove('hidden');
    ctl.sync();
    assert.equal(leftSidebar.inert, false);
    surface.classList.add('hidden');
    ctl.sync();
    docked = true;
    surface.classList.remove('hidden');
    ctl.sync();
    assert.equal(leftSidebar.inert, true, '桌面常驻侧栏在落地页下面，Tab 到的是看不见的会话行');
    surface.classList.add('hidden');
    ctl.sync();
    assert.equal(leftSidebar.inert, false, '关掉后撤掉自己挂的 overlay 原因');
  });

  // 「选择其他会话」：收起落地页、再打开抽屉移焦。关层这一刻焦点已在抽屉里，不得被拽回打开前的顶栏按钮。
  test('关掉 sessionBlockedSurface 时焦点已移到别处，不还焦', () => {
    const surface = fakeEl('sessionBlockedSurface', { hidden: true });
    const header = fakeEl('header');
    const drawerItem = fakeEl('drawerItem');
    const body = fakeEl('body');
    body.children = [header, surface];
    let focused = header;
    surface.focus = () => { focused = surface; };
    header.focus = () => { focused = header; };
    const doc = { body, get activeElement() { return focused; } };
    const ctl = createGateFocusController({
      gates: [], overlays: [surface], overlayCovers: () => [header], doc, Observer: null,
    });
    surface.classList.remove('hidden');
    ctl.sync();
    assert.equal(focused, surface);
    surface.classList.add('hidden');
    focused = drawerItem; // openLeftSidebar() 已把焦点移进抽屉
    ctl.sync();
    assert.equal(focused, drawerItem, '焦点被从抽屉拽回了顶栏');
  });

  // 中层 overlay 不得按 DOM 序压过 z-50 全屏门：两者同开时门才是顶，侧栏也要跟门一起 inert。
  test('全屏门与 sessionBlockedSurface 同开时以门为顶，侧栏仍 inert', () => {
    const authGate = fakeEl('authGate', { hidden: true });
    const surface = fakeEl('sessionBlockedSurface', { hidden: true });
    const leftSidebar = fakeEl('leftSidebar');
    const header = fakeEl('header');
    const body = fakeEl('body');
    body.children = [authGate, header, leftSidebar, surface];
    const doc = { body, activeElement: body };
    const ctl = createGateFocusController({
      gates: [authGate],
      overlays: [surface],
      overlayCovers: () => [header],
      doc,
      Observer: null,
    });
    surface.classList.remove('hidden');
    authGate.classList.remove('hidden');
    ctl.sync();
    assert.equal(authGate.inert, false, 'z-50 门才是顶层');
    assert.equal(surface.inert, true, '落地页被门盖住，不该还能 Tab');
    assert.equal(leftSidebar.inert, true, '全屏门开着时侧栏一并 inert');
    assert.equal(header.inert, true);
  });
});
