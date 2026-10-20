// tests/unit/frontend-crash-notices.test.mjs —— 进程异常退出提示的会话级记忆（验收 O60 后一半）。
// 跑法：npm run test:unit。接线（error 事件记下、历史重画完补回、user_message 清掉）由 E2E P0-DESTROY-CRASH 覆盖；
// 这里钉住控制器自己的约定：补回带时间与原文、屏上已有就不重复、接着聊过就不再补、会话之间互不串。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCrashNotices } from '../../app/public/js/app/crash-notices.js';
import { setLang } from '../../app/public/js/i18n.js';

setLang('zh');

// 桩消息流：bar 只需 text / className / dataset；clearScreen 模拟切回时的清屏全量重载
function harness() {
  let screen = [];
  const notices = createCrashNotices({
    addBar: (text, className) => { const bar = { text, className, dataset: {} }; screen.push(bar); return bar; },
    hasNotice: () => screen.some(bar => bar.dataset.crashNotice === '1'),
  });
  return {
    notices,
    screen: () => screen,
    clearScreen: () => { screen = []; },
    liveBar: text => { const bar = { text, className: 'text-danger', dataset: {} }; screen.push(bar); return bar; },
  };
}

const at = new Date(2026, 9, 19, 2, 51).getTime();
const MESSAGE = '进程异常：Claude Code process terminated by signal SIGKILL';

test('重载清屏后补回：带当时的时刻与原文，红色，且标记为崩溃提示', () => {
  const h = harness();
  h.notices.record('s1', MESSAGE, h.liveBar(`⚠️ ${MESSAGE}`), at);
  h.clearScreen();
  h.notices.restore('s1');
  assert.equal(h.screen().length, 1);
  const [bar] = h.screen();
  assert.equal(bar.text, `⚠️ 这个会话上次异常退出（02:51）：${MESSAGE}`);
  assert.equal(bar.className, 'text-danger');
  assert.equal(bar.dataset.crashNotice, '1');
});

test('屏上已有（DOM 缓存原样恢复了当场那条）→ 不重复补', () => {
  const h = harness();
  const live = h.liveBar(`⚠️ ${MESSAGE}`);
  h.notices.record('s1', MESSAGE, live, at);
  assert.equal(live.dataset.crashNotice, '1', '当场那条也要打上标记，否则缓存恢复后会再补一条');
  h.notices.restore('s1');
  assert.equal(h.screen().length, 1);
});

test('在这个会话里接着发过消息（clear）→ 不再补', () => {
  const h = harness();
  h.notices.record('s1', MESSAGE, h.liveBar(`⚠️ ${MESSAGE}`), at);
  h.notices.clear('s1');
  h.clearScreen();
  h.notices.restore('s1');
  assert.equal(h.screen().length, 0);
});

test('会话之间互不串：别的会话没崩过就不补，清一个不影响另一个', () => {
  const h = harness();
  h.notices.record('s1', MESSAGE, h.liveBar(`⚠️ ${MESSAGE}`), at);
  h.notices.record('s2', MESSAGE, h.liveBar(`⚠️ ${MESSAGE}`), at);
  h.notices.clear('s1');
  h.clearScreen();
  h.notices.restore('s3');
  assert.equal(h.screen().length, 0, '没崩过的会话不补');
  h.notices.restore('s2');
  assert.equal(h.screen().length, 1, 's1 被清不影响 s2');
});
