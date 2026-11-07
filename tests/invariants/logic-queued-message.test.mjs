// tests/invariants/logic-queued-message.test.mjs —— 排队消息的前端判定：入口什么时候给、话怎么不丢
// 守护：MSG-03（任何一道闸不过都不得丢：用户看得到、取得回；server 重启后由发送方的本地副本交还）
// 测什么：① 入口可用性，尤其是后端不支持时恒不给（前端热更新先于后端重启）② 卡片三态的文案和按钮
//   ③ 排队请求的 ack 判定，四种结局都不丢话 ④ 取回时不覆盖输入框 ⑤ 本地副本对账：server 重启交还、已发出才删
// 不测什么 + 为什么：① 按钮和卡片的真实渲染属 S3，见 tests/e2e/specs/queued-message.spec.ts ② server 侧的状态机
//   在 tests/invariants/message-queue.test.mjs ③ localStorage 配额属 S3 也造不稳，读写降级走控制器
// 槽位：S1（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isQueueAvailable, mergeTakenIntoComposer, presentQueueSubmitAck, reconcileQueuedCopies, resolveQueuedCard,
} from '../../app/public/js/logic/queued-message.js';

const SID = 's-1';
const entry = (over = {}) => ({
  sessionId: SID, instanceId: 'i-1', cwd: '/w', clientMessageId: 'c1', state: 'waiting', reason: null,
  preview: '接下来跑测试', textLength: 6, attachments: [], acceptedAt: 1, heldAt: null, ...over,
});
const available = over => isQueueAvailable({ connected: true, supported: true, sessionId: SID, entries: [], submitting: false, ...over });

// ── 入口 ──

test('入口：连着、后端支持、有 sessionId、没占位 → 给', () => {
  assert.equal(available(), true);
});

test('入口：后端没发过 queuedMessages → 不给。前端热更新先于后端重启时走这条，行为与没有这个功能完全相同', () => {
  assert.equal(available({ supported: false }), false);
});

test('入口：断线、FRESH 首轮还没 sessionId、请求在途 → 不给', () => {
  assert.equal(available({ connected: false }), false);
  assert.equal(available({ sessionId: null }), false);
  assert.equal(available({ submitting: true }), false, '双击不该发两条');
});

test('入口：这个会话已有一条，未发送的也算 → 不给；别的会话的不影响', () => {
  assert.equal(available({ entries: [entry()] }), false);
  assert.equal(available({ entries: [entry({ state: 'held', reason: 'stopped' })] }), false);
  assert.equal(available({ entries: [entry({ sessionId: 's-other' })] }), true);
});

// ── 卡片 ──

test('卡片：这个会话没有条目 → null', () => {
  assert.equal(resolveQueuedCard([], SID), null);
  assert.equal(resolveQueuedCard([entry({ sessionId: 's-other' })], SID), null);
  assert.equal(resolveQueuedCard([entry()], null), null);
});

test('卡片：排队中给撤回，带一行预览', () => {
  const card = resolveQueuedCard([entry()], SID);
  assert.equal(card.state, 'waiting');
  assert.match(card.status, /排队中/);
  assert.match(card.status, /本轮结束后自动发送/);
  assert.equal(card.preview, '接下来跑测试');
  assert.equal(card.actionLabel, '撤回');
  assert.equal(card.clientMessageId, 'c1');
});

test('卡片：正在发送没有按钮', () => {
  const card = resolveQueuedCard([entry({ state: 'sending' })], SID);
  assert.match(card.status, /正在发送/);
  assert.equal(card.actionLabel, null);
});

test('卡片：未发送给取回，说清原因', () => {
  for (const [reason, text] of [
    ['stopped', '本轮已停止'], ['interrupted', '本轮被中断'], ['turn_error', '本轮出错'], ['quota_wall', '额度墙'],
    ['approval_expired', '审批过期'], ['incomplete', '没有正常结束'], ['instance_exit', '进程退出'], ['closed', '会话关闭'],
    ['session_changed', '会话已经换了'], ['other_driver', '终端或桌面端'], ['unverified', '无法确认'],
    ['diverged', '续接会丢掉一段对话'], ['location', '找不到这个会话的记录'], ['attachment_failed', '附件保存失败'], ['send_failed', '发送失败'],
  ]) {
    const card = resolveQueuedCard([entry({ state: 'held', reason })], SID);
    assert.match(card.status, /未发送/, reason);
    assert.match(card.status, new RegExp(text), reason);
    assert.equal(card.actionLabel, '取回', reason);
  }
});

test('卡片：上游以后新增的 reason 也要说得出话，不能露出英文枚举', () => {
  const card = resolveQueuedCard([entry({ state: 'held', reason: 'something_new' })], SID);
  assert.match(card.status, /未发送/);
  assert.doesNotMatch(card.status, /something_new/);
});

test('卡片：纯附件消息没有预览文字时，预览写附件名', () => {
  const card = resolveQueuedCard([entry({ preview: '', attachments: [{ name: 'a.png', mimeType: 'image/png' }, { name: 'b.png', mimeType: 'image/png' }] })], SID);
  assert.match(card.preview, /a\.png/);
  assert.match(card.preview, /b\.png/);
});

// ── 排队请求的 ack ──

test('ack：收下', () => {
  assert.equal(presentQueueSubmitAck(null, { ok: true, queued: true, instanceId: 'i', sessionId: SID }).outcome, 'queued');
  assert.equal(presentQueueSubmitAck(null, { ok: true, deduped: true, queued: true }).outcome, 'queued', '首发 ack 丢了、重发命中去重');
});

test('ack：回合恰好结束，按普通发送走了', () => {
  assert.equal(presentQueueSubmitAck(null, { ok: true, instanceId: 'i' }).outcome, 'sent');
});

test('ack：传输超时 → 结果不明，话回输入框，不进 outbox（否则一条消息同时活在两边）', () => {
  const d = presentQueueSubmitAck(new Error('timeout'), undefined);
  assert.equal(d.outcome, 'unknown');
  assert.equal(d.restore, true);
  assert.ok(d.message);
  assert.equal(d.requeue, undefined);
});

test('ack：占位被拒 → 话回输入框，说清原因', () => {
  const d = presentQueueSubmitAck(null, { ok: false, busy: true, retryable: false, queueFull: true, error: '已有一条排队消息，先处理它' });
  assert.equal(d.outcome, 'rejected');
  assert.equal(d.restore, true);
  assert.equal(d.message, '已有一条排队消息，先处理它');
});

test('ack：stale、permanent → 话回输入框', () => {
  for (const ack of [{ ok: false, error: 'stale_instance', stale: true }, { ok: false, error: '会话不存在', permanent: true }]) {
    const d = presentQueueSubmitAck(null, ack);
    assert.equal(d.outcome, 'rejected');
    assert.equal(d.restore, true);
    assert.ok(d.message);
  }
});

test('ack：续接分叉 → 话回输入框，交给现有面板', () => {
  const divergence = { newestUuid: 'a-2' };
  const d = presentQueueSubmitAck(null, { ok: false, reason: 'resume_divergent', permanent: true, error: '…', divergence });
  assert.equal(d.outcome, 'rejected');
  assert.equal(d.restore, true);
  assert.deepEqual(d.divergence, divergence);
});

// ── 取回 ──

test('取回：输入框空着直接放入，有字用空行拼在后面，不覆盖', () => {
  assert.equal(mergeTakenIntoComposer({ current: '', taken: '排队的话' }), '排队的话');
  assert.equal(mergeTakenIntoComposer({ current: '   ', taken: '排队的话' }), '排队的话');
  assert.equal(mergeTakenIntoComposer({ current: '新打的', taken: '排队的话' }), '新打的\n\n排队的话');
  assert.equal(mergeTakenIntoComposer({ current: '新打的', taken: '' }), '新打的', '纯附件消息');
});

// ── 本地副本 ──

const copy = (over = {}) => ({ clientMessageId: 'c1', sessionId: SID, text: '话', startedAt: 100, acked: true, ...over });

test('MSG-03：ack 超时但快照确认过收下 → 按排上算，不放回输入框，否则同一句话既在 server 又在输入框', () => {
  const d = presentQueueSubmitAck(new Error('timeout'), undefined, { confirmed: true });
  assert.equal(d.outcome, 'queued');
  assert.ok(!d.restore, '放回输入框的话，再按一次发送就发了两遍');
});

test('副本：快照里还在 → 留着', () => {
  const r = reconcileQueuedCopies({ copies: [copy()], entries: [entry()], startedAt: 100, submitting: [] });
  assert.equal(r.keep.length, 1);
  assert.equal(r.lost.length, 0);
});

test('副本：快照里没了、server 没重启 → 已发出或被别的设备取走，删掉，不交还', () => {
  const r = reconcileQueuedCopies({ copies: [copy()], entries: [], startedAt: 100, submitting: [] });
  assert.equal(r.keep.length, 0);
  assert.equal(r.lost.length, 0);
});

test('MSG-03：server 重启了、快照里没有这条 → 交还给用户', () => {
  const r = reconcileQueuedCopies({ copies: [copy()], entries: [], startedAt: 200, submitting: [] });
  assert.equal(r.keep.length, 0);
  assert.deepEqual(r.lost.map(c => c.clientMessageId), ['c1']);
});

test('副本：快照里出现过就算 server 收下了：页面重载丢了 ack，之后消息发出去不能再当成丢失', () => {
  const first = reconcileQueuedCopies({ copies: [copy({ acked: false })], entries: [entry()], startedAt: 100, submitting: [] });
  assert.equal(first.keep[0].acked, true);
  const second = reconcileQueuedCopies({ copies: first.keep, entries: [], startedAt: 100, submitting: [] });
  assert.equal(second.lost.length, 0, '否则发出去的话又回到输入框');
});

test('副本：重启之后快照里还有同一条（不可能发生也不能误删）→ 留着', () => {
  const r = reconcileQueuedCopies({ copies: [copy()], entries: [entry()], startedAt: 200, submitting: [] });
  assert.equal(r.keep.length, 1);
});

test('副本：请求还在途 → 不判，ack 回来之前快照里当然没有', () => {
  const r = reconcileQueuedCopies({ copies: [copy({ acked: false })], entries: [], startedAt: 100, submitting: ['c1'] });
  assert.equal(r.keep.length, 1);
  assert.equal(r.lost.length, 0);
});

test('MSG-03：页面重载时请求没有 ack、快照里也没有 → 交还，这时输入框已经清了', () => {
  const r = reconcileQueuedCopies({ copies: [copy({ acked: false })], entries: [], startedAt: 100, submitting: [] });
  assert.equal(r.keep.length, 0);
  assert.equal(r.lost.length, 1);
});

test('副本：广播没带 startedAt（判不了有没有重启）→ 全留着，不猜', () => {
  const r = reconcileQueuedCopies({ copies: [copy()], entries: [], startedAt: null, submitting: [] });
  assert.equal(r.keep.length, 1);
  assert.equal(r.lost.length, 0);
});
