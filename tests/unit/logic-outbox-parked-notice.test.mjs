// 验收 O126：离线重放被永久拒收、原文进了死信暂存时，眼前该不该说一句、说什么。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnreturnableDeadLetter, outboxParkedNotice, presentOfflineResendAck } from '../../app/public/js/logic.js';

test('眼前没有会话（server 重启后的提示页、首页）：说清楚没发出去、原文还在、去哪儿拿', () => {
  const text = outboxParkedNotice({ viewingInstanceId: null, stale: true, message: '目标会话已关闭，请刷新后重发', sessionId: 's1' });
  assert.match(text, /没有发出/);
  assert.match(text, /目标会话已关闭/);
  assert.match(text, /原文已保存，回到该会话时会放回输入框/);
  assert.doesNotMatch(text, /刷新/, '原文在死信暂存里，刷新找不回它；「请刷新后重发」会让人以为要凭记忆重打');
});

test('正在看别的会话：不提示（A 的失败不写进 B 的界面，回到 A 时再交还）', () => {
  assert.equal(outboxParkedNotice({ viewingInstanceId: 'inst_b', stale: true, message: 'x' }), null);
});

test('非 stale 的永久拒收照原因说', () => {
  const text = outboxParkedNotice({ viewingInstanceId: null, stale: false, message: '这个目录不在已连接的文件夹里', sessionId: 's1' });
  assert.match(text, /这个目录不在已连接的文件夹里/);
  assert.match(text, /原文已保存/);
});

test('条目没带会话号（升级前入队）：回不去那个会话，不许诺交还，直接把原文写出来（PR #310 review）', () => {
  // 只剩入队时的实例号，server 重启后发号不复用（MSG-02），死信暂存永远认不出它；提示要是还说「回到该会话时会放回」就是空头承诺
  const text = outboxParkedNotice({ viewingInstanceId: null, stale: true, message: 'x', sessionId: null, text: '没有会话号的那条' });
  assert.match(text, /原文：没有会话号的那条/);
  assert.doesNotMatch(text, /回到该会话时会放回输入框/);
});

test('带会话号的照常许诺交还，不把原文铺在提示里（回去之后它会进输入框，两份会重复）', () => {
  const text = outboxParkedNotice({ viewingInstanceId: null, stale: true, message: 'x', sessionId: 's1', text: '有会话号的那条' });
  assert.match(text, /回到该会话时会放回输入框/);
  assert.doesNotMatch(text, /有会话号的那条/);
});

test('离线重放的 stale 决策带上 stale 标记，提示才分得清是哪种拒收', () => {
  assert.equal(presentOfflineResendAck(null, { ok: false, error: 'stale_instance', stale: true }).stale, true);
  assert.notEqual(presentOfflineResendAck(null, { ok: false, error: 'x', permanent: true }).stale, true);
});

test('死信算不算「回不去」：判了 stale、没有会话号、只剩实例号才算（验收 O135 / PR #339 review）', () => {
  assert.equal(isUnreturnableDeadLetter({ stale: true, instanceId: 'inst_9', sessionId: null }), true);
  assert.equal(isUnreturnableDeadLetter({ stale: false, instanceId: 'inst_1', sessionId: null }), false, '实例还活着，非 stale 的拒收之后还能回去');
  assert.equal(isUnreturnableDeadLetter({ stale: true, instanceId: 'inst_9', sessionId: 's1' }), false, '有会话号，回到该会话时交还');
  assert.equal(isUnreturnableDeadLetter({ stale: true, instanceId: null, sessionId: null }), false, '新会话页发的，按目录交还');
});
