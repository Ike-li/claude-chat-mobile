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

// #329 review P2：新开的进程还没吐 init 就退出，实例没有会话 id——「会话已中断」面要的原因按实例也得查得到
test('reasonFor：按实例记的原因在没有会话 id 时也查得到；实例之间互不串', () => {
  const h = harness();
  h.notices.noteInstance('inst-1', MESSAGE);
  assert.equal(h.notices.reasonFor({ instanceId: 'inst-1', sessionId: null }), MESSAGE);
  assert.equal(h.notices.reasonFor({ instanceId: 'inst-2', sessionId: null }), null);
  h.notices.record('s2', '会话级原因', null, at);
  assert.equal(h.notices.reasonFor({ instanceId: 'inst-2', sessionId: 's2' }), '会话级原因', '没有实例级记录时回落会话级');
});

// #329 review P2：回放缓冲里排着的崩溃 error 要在切视图丢队列之前收下来。会话级的旧原因（上一个进程的、没再发消息
// 所以没清）不能挡住它——只有这个实例自己已经记过才跳过。
test('adoptQueued：收下队列里最后一条进程退出的 error；会话级旧原因不挡，实例自己记过才跳过', () => {
  const h = harness();
  h.notices.record('s1', '上一个进程：SIGKILL', null, at);
  const queued = [
    { type: 'text_delta', payload: {} },
    { type: 'error', payload: { message: '没退出的错误' } },
    { type: 'error', payload: { message: '这一次：SIGTERM', processExited: true } },
  ];
  h.notices.adoptQueued({ instanceId: 'inst-2', sessionId: 's1', queued });
  assert.equal(h.notices.reasonFor({ instanceId: 'inst-2', sessionId: 's1' }), '这一次：SIGTERM');
  h.clearScreen();
  h.notices.restore('s1');
  assert.match(h.screen()[0].text, /这一次：SIGTERM/, '重载历史补回的也该是这一次的原因');

  h.notices.noteInstance('inst-3', '已记过');
  h.notices.adoptQueued({ instanceId: 'inst-3', sessionId: 's1', queued });
  assert.equal(h.notices.reasonFor({ instanceId: 'inst-3', sessionId: 's1' }), '已记过');
});
