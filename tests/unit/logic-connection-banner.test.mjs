// tests/unit/logic-connection-banner.test.mjs —— 连接状态横幅的纯判定层单测。
// 跑法：npm run test:unit。判定层零 DOM/零 socket，只吃 {phase, elapsedMs, suppressed, wasVisible}。
// 覆盖：三相位 × 阈值边界（799/800、999/1000、4999/5000、1599/1600）、鉴权门抑制、
//       「已重新连接」只在此前真显示过时才给、detail 时长复用 formatUptime 的中英文案。
// 不覆盖 DOM 显隐与定时器（归 tests/unit/frontend-connection-banner.test.mjs 与 P0 E2E）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveConnectionBanner,
  CONN_BANNER_CONNECTING_DELAY_MS,
  CONN_BANNER_DISCONNECT_DELAY_MS,
  CONN_BANNER_RETRY_DELAY_MS,
  CONN_BANNER_RECONNECTED_LINGER_MS,
} from '../../app/public/js/logic.js';
import { setLang } from '../../app/public/js/i18n.js';

// ---- 阈值常量：接线层与测试共用同一份，别在两处各写一个魔数 ----

test('阈值常量：四个延迟按设计取值，且 retry 严格晚于两个显示阈值', () => {
  assert.equal(CONN_BANNER_CONNECTING_DELAY_MS, 800);
  assert.equal(CONN_BANNER_DISCONNECT_DELAY_MS, 1000);
  assert.equal(CONN_BANNER_RETRY_DELAY_MS, 5000);
  assert.equal(CONN_BANNER_RECONNECTED_LINGER_MS, 1600);
  // ★ 重试按钮必须晚于横幅本身出现，否则会出现「按钮先于横幅可见」的不可能态
  assert.ok(CONN_BANNER_RETRY_DELAY_MS > CONN_BANNER_CONNECTING_DELAY_MS);
  assert.ok(CONN_BANNER_RETRY_DELAY_MS > CONN_BANNER_DISCONNECT_DELAY_MS);
});

// ---- suppressed：鉴权门/Access 重登门打开时恒不显示 ----

test('suppressed 为真：三个相位一律 null（全屏令牌页与顶部重连横幅不能并存）', () => {
  for (const phase of ['connecting', 'offline', 'online']) {
    assert.equal(
      resolveConnectionBanner({ phase, elapsedMs: 99999, suppressed: true, wasVisible: true }),
      null,
      `期望 null：phase=${phase}`,
    );
  }
});

// ---- connecting：首次连接 ----

test('connecting：799ms 不显示，800ms 才显示（局域网秒连不闪）', () => {
  assert.equal(resolveConnectionBanner({ phase: 'connecting', elapsedMs: 799 }), null);
  const shown = resolveConnectionBanner({ phase: 'connecting', elapsedMs: 800 });
  assert.equal(shown.tone, 'info');
  assert.equal(shown.label, '连接中…');
  assert.equal(shown.spinner, true);
  assert.equal(shown.retry, false);
  assert.equal(shown.detail, ''); // 首连不报「已断开 N 秒」——从没连上过，无「断开」可言
});

test('connecting：4999ms 无重试按钮，5000ms 才给（首连也可能是服务没起来）', () => {
  assert.equal(resolveConnectionBanner({ phase: 'connecting', elapsedMs: 4999 }).retry, false);
  assert.equal(resolveConnectionBanner({ phase: 'connecting', elapsedMs: 5000 }).retry, true);
});

// ---- offline：断线重连 ----

test('offline：999ms 不显示，1000ms 才显示（挡住手机切后台回来的瞬时断开）', () => {
  assert.equal(resolveConnectionBanner({ phase: 'offline', elapsedMs: 999 }), null);
  const shown = resolveConnectionBanner({ phase: 'offline', elapsedMs: 1000 });
  assert.equal(shown.tone, 'warn');
  assert.equal(shown.label, '连接断开，自动重连中…');
  assert.equal(shown.spinner, true);
  assert.equal(shown.retry, false);
});

test('offline：detail 走 formatUptime，读作「已断开 8 秒」', () => {
  assert.equal(resolveConnectionBanner({ phase: 'offline', elapsedMs: 8000 }).detail, '已断开 8 秒');
  assert.equal(resolveConnectionBanner({ phase: 'offline', elapsedMs: 120000 }).detail, '已断开 2 分钟');
});

test('offline：4999ms 无重试按钮，5000ms 才给', () => {
  assert.equal(resolveConnectionBanner({ phase: 'offline', elapsedMs: 4999 }).retry, false);
  assert.equal(resolveConnectionBanner({ phase: 'offline', elapsedMs: 5000 }).retry, true);
});

// ---- online：重连成功后的绿条 ----

test('online + wasVisible：1599ms 内显示「已重新连接」，1600ms 后收起', () => {
  const shown = resolveConnectionBanner({ phase: 'online', elapsedMs: 1599, wasVisible: true });
  assert.equal(shown.tone, 'success');
  assert.equal(shown.label, '已重新连接');
  assert.equal(shown.spinner, false); // ★ 已经连上了，不该还转圈
  assert.equal(shown.retry, false);
  assert.equal(shown.detail, '');
  assert.equal(resolveConnectionBanner({ phase: 'online', elapsedMs: 1600, wasVisible: true }), null);
});

test('online + wasVisible=false：恒 null（秒连不该闪一下绿条）', () => {
  assert.equal(resolveConnectionBanner({ phase: 'online', elapsedMs: 0, wasVisible: false }), null);
  assert.equal(resolveConnectionBanner({ phase: 'online', elapsedMs: 500, wasVisible: false }), null);
});

// ---- 防御性输入 ----

test('缺参/非法 phase/非法 elapsedMs：一律 null，不抛', () => {
  assert.equal(resolveConnectionBanner(), null);
  assert.equal(resolveConnectionBanner({}), null);
  assert.equal(resolveConnectionBanner({ phase: 'bogus', elapsedMs: 99999 }), null);
  for (const bad of [undefined, null, NaN, Infinity, -1, '1000', {}]) {
    assert.equal(
      resolveConnectionBanner({ phase: 'offline', elapsedMs: bad }),
      null,
      `期望 null：elapsedMs=${JSON.stringify(bad)}`,
    );
  }
});

// ---- i18n：label 是中文原文（key），接线层才 t()；detail 已翻译 ----

test('en：label 仍返回中文原文交给接线层 t()，detail 因复用 formatUptime 已是英文单位', () => {
  setLang('en');
  try {
    const off = resolveConnectionBanner({ phase: 'offline', elapsedMs: 8000 });
    assert.equal(off.label, '连接断开，自动重连中…'); // ★ 判定层不翻译 label，保持 key 语义
    assert.equal(off.detail, 'Offline for 8 s');      // formatUptime 的 t('秒') → 's'
  } finally {
    setLang('zh');
  }
});

test.after(() => setLang('zh'));
