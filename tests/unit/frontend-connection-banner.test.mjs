// tests/unit/frontend-connection-banner.test.mjs —— 连接状态横幅接线层（DOM + 定时器）单测。
// 跑法：npm run test:unit。判定表本身归 tests/unit/logic-connection-banner.test.mjs，这里只测接线：
// 相位切换、tick 驱动的延迟出现、定时器生命周期（稳定连接必须停表）、鉴权门抑制、重试按钮、
// 页面 hidden 跳 tick、onToggle 只在显隐真变化时触发。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppContext } from '../../public/js/app/context.js';
import { createConnectionBannerController } from '../../public/js/app/connection-banner.js';
import { setLang } from '../../public/js/i18n.js';

// 桩 DOM：只用 className / textContent 字符串赋值（对齐项目既有 connDot.className 整串覆盖风格），
// 桩就不必实现 classList，保持与 frontend-app-modules.test.mjs 的 RTT monitor 用例同款极简。
function makeHarness({ visibilityState = 'visible' } = {}) {
  const dom = {
    connBanner: { className: '' },
    connBannerText: { textContent: '' },
    connBannerDetail: { className: '', textContent: '' },
    connBannerSpinner: { className: '' },
    connBannerRetry: { className: '', onclick: null },
  };
  let now = 0;
  const timers = { tick: null, cleared: 0 };
  const context = createAppContext({
    dom,
    dependencies: {
      performance: { now: () => now },
      document: { visibilityState },
      setInterval: (fn) => { timers.tick = fn; return 'timer-1'; },
      clearInterval: (id) => { if (id === 'timer-1') { timers.tick = null; timers.cleared += 1; } },
    },
  });
  return {
    dom,
    context,
    timers,
    advance(ms) { now += ms; timers.tick?.(); },   // 走一次 tick（模拟 500ms 心跳到点）
    jump(ms) { now += ms; },                        // 只推进时钟，不 tick
    visible: () => !/\bhidden\b/.test(dom.connBanner.className),
    setVisibility(v) { context.dependencies.document.visibilityState = v; },
  };
}

test('首连：800ms 前不显示，跨过阈值的那次 tick 才显示「连接中…」', () => {
  const h = makeHarness();
  const banner = createConnectionBannerController(h.context);
  banner.markConnecting();
  assert.equal(h.visible(), false);

  h.advance(500);
  assert.equal(h.visible(), false, '500ms 仍在延迟窗内，局域网秒连不该闪');

  h.advance(500); // 累计 1000ms
  assert.equal(h.visible(), true);
  assert.equal(h.dom.connBannerText.textContent, '连接中…');
  assert.doesNotMatch(h.dom.connBannerSpinner.className, /\bhidden\b/);
  assert.match(h.dom.connBannerRetry.className, /\bhidden\b/, '首连 1s 时还不该有重试按钮');
});

test('断线：1000ms 前不显示；显示后 detail 报「已断开 N 秒」，5000ms 才露重试按钮', () => {
  const h = makeHarness();
  const banner = createConnectionBannerController(h.context);
  banner.markConnected();       // 先连上（否则 phase 是 connecting）
  banner.markDisconnected();
  assert.equal(h.visible(), false);

  h.advance(999);
  assert.equal(h.visible(), false, '999ms 仍在延迟窗内，切后台回来的瞬时断开不该闪');

  h.advance(1);  // 1000ms
  assert.equal(h.visible(), true);
  assert.equal(h.dom.connBannerText.textContent, '连接断开，自动重连中…');
  assert.equal(h.dom.connBannerDetail.textContent, '已断开 1 秒');
  assert.match(h.dom.connBannerRetry.className, /\bhidden\b/);

  h.advance(4000); // 5000ms
  assert.doesNotMatch(h.dom.connBannerRetry.className, /\bhidden\b/, '断开满 5s 该给手动重试');
  assert.equal(h.dom.connBannerDetail.textContent, '已断开 5 秒');
});

test('重连成功：显示过才给绿条「已重新连接」，1600ms 后收起并停表', () => {
  const h = makeHarness();
  const banner = createConnectionBannerController(h.context);
  banner.markConnected();
  banner.markDisconnected();
  h.advance(1500);
  assert.equal(h.visible(), true);

  banner.markConnected();
  assert.equal(h.visible(), true);
  assert.equal(h.dom.connBannerText.textContent, '已重新连接');
  assert.match(h.dom.connBannerSpinner.className, /\bhidden\b/, '已经连上了不该还转圈');

  h.advance(1599);
  assert.equal(h.visible(), true);
  h.advance(1); // 1600ms
  assert.equal(h.visible(), false);
  assert.equal(h.timers.tick, null, '★ 稳定连接后必须彻底停表，不能让 500ms interval 在移动端长跑');
});

test('慢首连：显示过「连接中…」后连上，不能说「已重新连接」——从没连上过何来重新', () => {
  const h = makeHarness();
  const banner = createConnectionBannerController(h.context);
  banner.markConnecting();
  h.advance(1500);                                   // 弱网/隧道下 >800ms 的首次握手是常见情形
  assert.equal(h.dom.connBannerText.textContent, '连接中…');

  banner.markConnected();
  assert.equal(h.visible(), false, '★ 首连成功直接收起横幅，绿条只属于「断了又回来」');
  assert.equal(h.timers.tick, null);
});

test('秒连：横幅从未显示过 → 连上不闪绿条，且不留定时器', () => {
  const h = makeHarness();
  const banner = createConnectionBannerController(h.context);
  banner.markConnecting();
  h.advance(200);        // 200ms 就连上了
  banner.markConnected();

  assert.equal(h.visible(), false);
  assert.equal(h.timers.tick, null, '连上且无横幅可显示 → 不该还挂着定时器');
});

test('鉴权门打开：断开再久也不显示（全屏令牌页与顶部重连横幅不能并存）', () => {
  const h = makeHarness();
  let gateOpen = true;
  const banner = createConnectionBannerController(h.context, { isSuppressed: () => gateOpen });
  banner.markConnected();
  banner.markDisconnected();
  h.advance(30000);
  assert.equal(h.visible(), false);

  gateOpen = false;       // 用户输对令牌、门收起后，横幅才该接管
  h.advance(500);
  assert.equal(h.visible(), true);
});

test('页面切后台：tick 跳过不更新，回前台恢复', () => {
  const h = makeHarness();
  const banner = createConnectionBannerController(h.context);
  banner.markConnected();
  banner.markDisconnected();

  h.setVisibility('hidden');
  h.advance(5000);
  assert.equal(h.visible(), false, 'hidden 期间不该做无谓的 DOM 更新');

  h.setVisibility('visible');
  h.advance(0);
  assert.equal(h.visible(), true);
});

test('绿条停留期间切后台：仍要走到停表判定，不能把定时器落在后台长跑', () => {
  const h = makeHarness();
  const banner = createConnectionBannerController(h.context);
  banner.markConnected();
  banner.markDisconnected();
  h.advance(1500);
  banner.markConnected();          // 绿条亮起，停留窗口 1600ms
  assert.equal(h.visible(), true);

  h.setVisibility('hidden');       // 用户立刻锁屏
  h.advance(1600);
  assert.equal(h.timers.tick, null, '★ hidden 的早退不能把 online 相位的停表也一起跳过');
  assert.equal(h.visible(), false, '收起动作本身要落地，回前台不该看到过期的绿条');
});

test('文案不变时不重写 DOM：role=status 是 aria-atomic，每 tick 重写会把读屏刷爆', () => {
  const h = makeHarness();
  const banner = createConnectionBannerController(h.context);
  banner.markConnected();
  banner.markDisconnected();
  h.advance(1000);

  // 用可计数的属性访问器代替裸字符串，直接数写入次数
  let textWrites = 0;
  let raw = h.dom.connBannerText.textContent;
  Object.defineProperty(h.dom.connBannerText, 'textContent', {
    get: () => raw,
    set: (v) => { textWrites += 1; raw = v; },
  });

  h.advance(500);
  h.advance(500);
  h.advance(500);
  assert.equal(textWrites, 0, '★ 主文案在断线期间恒定，三次 tick 不该产生任何一次写入');
});

test('重试按钮：点击调 onRetry', () => {
  const h = makeHarness();
  let retries = 0;
  const banner = createConnectionBannerController(h.context, { onRetry: () => { retries += 1; } });
  banner.markConnected();
  banner.markDisconnected();
  h.advance(5000);

  assert.equal(typeof h.dom.connBannerRetry.onclick, 'function');
  h.dom.connBannerRetry.onclick();
  assert.equal(retries, 1);
});

test('onToggle：只在显隐真的翻转时触发（供 app.js 补 scrollBottom，别每 tick 都滚）', () => {
  const h = makeHarness();
  const toggles = [];
  const banner = createConnectionBannerController(h.context, { onToggle: v => toggles.push(v) });
  banner.markConnected();
  banner.markDisconnected();

  h.advance(1000);
  assert.deepEqual(toggles, [true]);
  h.advance(500);
  h.advance(500);
  assert.deepEqual(toggles, [true], '持续可见期间不该反复触发');

  banner.markConnected();
  h.advance(1600);
  assert.deepEqual(toggles, [true, false]);
});

test('stop()：清掉定时器，供页面卸载/重建时收尾', () => {
  const h = makeHarness();
  const banner = createConnectionBannerController(h.context);
  banner.markConnecting();
  assert.notEqual(h.timers.tick, null);
  banner.stop();
  assert.equal(h.timers.tick, null);
});

test('en：文案走 t()，detail 单位随之英文', () => {
  setLang('en');
  try {
    const h = makeHarness();
    const banner = createConnectionBannerController(h.context);
    banner.markConnected();
    banner.markDisconnected();
    h.advance(8000);
    assert.equal(h.dom.connBannerText.textContent, 'Disconnected, reconnecting…');
    assert.equal(h.dom.connBannerDetail.textContent, 'Offline for 8 s');
    assert.equal(h.dom.connBannerRetry.textContent, 'Retry now');
  } finally {
    setLang('zh');
  }
});

test.after(() => setLang('zh'));
