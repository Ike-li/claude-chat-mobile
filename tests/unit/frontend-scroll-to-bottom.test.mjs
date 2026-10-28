// app/public/js/app/scroll-to-bottom.js 的定位：「回到最新」钮必须落在消息列里，而不是视口左沿。
// 桌面常驻侧栏（300px）开着时，视口左沿 + 0.75rem 正好是侧栏会话列表的位置，按钮会挡住那几行。
// 槽位：S1（最小 DOM 替身）。显隐 / 新消息计数的判定在 logic-ui-state.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScrollToBottomController } from '../../app/public/js/app/scroll-to-bottom.js';

function fakeEl(rect = {}) {
  const classes = new Set(['hidden']);
  return {
    style: {},
    attrs: {},
    textContent: '',
    classList: {
      contains: c => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, ...rect }),
  };
}

function mount({ messagesLeft, observe = () => {} }) {
  const realWindow = globalThis.window;
  const realRO = globalThis.ResizeObserver;
  globalThis.window = { innerHeight: 800, addEventListener() {} };
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe(el, opts) { observe(el, opts); } };
  try {
    const buttonEl = fakeEl();
    const messagesEl = fakeEl({ left: messagesLeft });
    const composerFooterEl = fakeEl({ top: 700 });
    composerFooterEl.classList.toggle('hidden', false);
    createScrollToBottomController({ buttonEl, messagesEl, composerFooterEl });
    return { buttonEl };
  } finally {
    globalThis.window = realWindow;
    globalThis.ResizeObserver = realRO;
  }
}

test('桌面常驻侧栏开着：按钮横向贴消息列左沿，不浮在侧栏上', () => {
  const { buttonEl } = mount({ messagesLeft: 300 });
  assert.equal(buttonEl.style.left, '312px', '按钮落在了侧栏（0–300px）里');
});

test('手机 / 侧栏收起：消息列从 0 起，按钮距左沿 12px（与 CSS 回落值相同）', () => {
  const { buttonEl } = mount({ messagesLeft: 0 });
  assert.equal(buttonEl.style.left, '12px');
});

test('ResizeObserver 观察 footer 的 border-box（iOS 键盘改的是 paddingBottom）', () => {
  const calls = [];
  mount({ messagesLeft: 0, observe: (el, opts) => calls.push(opts) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.box, 'border-box', 'content-box 观察看不到 paddingBottom 变化，按钮会停在键盘后面');
});
