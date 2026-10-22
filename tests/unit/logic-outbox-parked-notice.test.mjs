// 验收 O126：离线重放被永久拒收、原文进了死信暂存时，眼前该不该说一句、说什么。
import test from 'node:test';
import assert from 'node:assert/strict';
import { outboxParkedNotice, presentOfflineResendAck } from '../../app/public/js/logic.js';

test('眼前没有会话（server 重启后的提示页、首页）：说清楚没发出去、原文还在、去哪儿拿', () => {
  const text = outboxParkedNotice({ viewingInstanceId: null, stale: true, message: '目标会话已关闭，请刷新后重发' });
  assert.match(text, /没有发出/);
  assert.match(text, /目标会话已关闭/);
  assert.match(text, /原文已保存，回到该会话时会放回输入框/);
  assert.doesNotMatch(text, /刷新/, '原文在死信暂存里，刷新找不回它；「请刷新后重发」会让人以为要凭记忆重打');
});

test('正在看别的会话：不提示（A 的失败不写进 B 的界面，回到 A 时再交还）', () => {
  assert.equal(outboxParkedNotice({ viewingInstanceId: 'inst_b', stale: true, message: 'x' }), null);
});

test('非 stale 的永久拒收照原因说', () => {
  const text = outboxParkedNotice({ viewingInstanceId: null, stale: false, message: '这个目录不在已连接的文件夹里' });
  assert.match(text, /这个目录不在已连接的文件夹里/);
  assert.match(text, /原文已保存/);
});

test('离线重放的 stale 决策带上 stale 标记，提示才分得清是哪种拒收', () => {
  assert.equal(presentOfflineResendAck(null, { ok: false, error: 'stale_instance', stale: true }).stale, true);
  assert.notEqual(presentOfflineResendAck(null, { ok: false, error: 'x', permanent: true }).stale, true);
});
