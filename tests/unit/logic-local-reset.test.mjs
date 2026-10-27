// tests/unit/logic-local-reset.test.mjs —— 设置页底部两档（#302）的判定：「重新加载」清哪些键、放过哪个 SW；
// 「重置本机数据」的确认框把后果说清（要重新输令牌或扫码、可能要重新审批、丢几条消息）。
// 失败方向：「重新加载」多清一个键就是丢数据——令牌、离线 outbox、拒收暂存、已读表、偏好都不可再生，所以是白名单。
import test from 'node:test';
import assert from 'node:assert/strict';
import { RELOAD_CLEARABLE_KEYS, isPushServiceWorker, localResetConfirm } from '../../app/public/js/logic.js';
import { setLang } from '../../app/public/js/i18n.js';

test.beforeEach(() => setLang('zh'));

test('「重新加载」只清可再生的键：斜杠命令缓存、展开目录、current_session；不可再生的一个都不在里面', () => {
  assert.deepEqual([...RELOAD_CLEARABLE_KEYS].sort(), ['ccm_expanded_dirs', 'current_session', 'slash_commands', 'slash_commands_terminal']);
  for (const keep of ['auth_token', 'device_token', 'ccm-outbox-v1', 'ccm-outbox-dead-letters-v1', 'ccm-unread-v1', 'ccm_lang', 'ccm_theme', 'ccm_push_preview', 'ccm_push_opt_out']) {
    assert.ok(!RELOAD_CLEARABLE_KEYS.includes(keep), keep);
  }
});

test('推送 SW 只认站点根的 /sw.js，按 pathname 判（带查询串也算），别的路径都不是', () => {
  assert.equal(isPushServiceWorker('https://host/sw.js'), true);
  assert.equal(isPushServiceWorker('https://host/sw.js?v=2'), true);
  assert.equal(isPushServiceWorker('https://host/js/sw.js'), false, 'v1 时代的旧路径是要清掉的遗留');
  assert.equal(isPushServiceWorker(''), false);
});

test('重置确认框：令牌路径要说重新输令牌或扫码；Access 路径要说会自动连上；都说可能要重新审批', () => {
  const token = localResetConfirm({ pending: 0, deadLetters: 0, accessPath: false });
  assert.equal(token.tone, 'danger');
  assert.match(token.body, /重新输入访问令牌或扫码/);
  assert.match(token.body, /重新审批/);
  assert.doesNotMatch(token.body, /丢失/, '没有要丢的消息就不该吓人');
  const access = localResetConfirm({ pending: 0, deadLetters: 0, accessPath: true });
  assert.match(access.body, /自动重新连上/);
  assert.doesNotMatch(access.body, /令牌/);
});

test('重置确认框：点名会丢几条待发送 / 未确认送达、几条被拒收暂存的消息', () => {
  const { body } = localResetConfirm({ pending: 3, deadLetters: 2, accessPath: false });
  assert.match(body, /3 条待发送或未确认送达的消息会丢失/);
  assert.match(body, /2 条被拒收暂存的消息会丢失/);
  assert.match(body, /服务端的已读位点和设备信任表不受影响/);
});

test('英文界面：确认框整段有译文', () => {
  setLang('en');
  for (const accessPath of [false, true]) {
    const c = localResetConfirm({ pending: 1, deadLetters: 1, accessPath });
    assert.doesNotMatch(`${c.title}${c.body}${c.okText}`, /[一-鿿]/, c.body);
  }
});
