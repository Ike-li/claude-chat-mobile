// 审批弹窗控制器（app/public/js/app/approval-questions.js#createApprovalController）的行为域单测。
//
// 这个模块是 2026-08-02 从 app.js 顶层整体搬出来的 419 行状态机，搬出来时没带测试。
// 本文件只覆盖「跨卡片/跨会话的残留状态」这一域——那是整体搬迁最容易漏的一类：
// 原来散在顶层的量各自被四段逐字复制的清理序列照顾，收敛成一个 clearAll() 之后，
// 漏进那个动词的量就再也没人清了。

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppContext } from '../../app/public/js/app/context.js';
import { createInteractionQueueState, createApprovalController } from '../../app/public/js/app/approval-questions.js';

// ── 最小 DOM 替身 ────────────────────────────────────────────────────────────
// 只做控制器真正碰到的那几件事：class 增删查、文本、点击回调、子节点。
// 不引 jsdom：这里要断言的是控制器自己的状态流转，不是浏览器语义。
function fakeEl(id = '') {
  const classes = new Set();
  const el = {
    id,
    children: [],
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    disabled: false,
    onclick: null,
    attrs: new Map(),
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: c => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
    },
    getAttribute: k => el.attrs.get(k) ?? null,
    setAttribute: (k, v) => el.attrs.set(k, v),
    querySelectorAll: () => [],
    appendChild: child => { el.children.push(child); return child; },
    after: sibling => { el.children.push(sibling); return sibling; },
    remove: () => {},
    focus: () => {},
    addEventListener: () => {},
  };
  return el;
}

function mount() {
  const dom = new Map();
  const byId = id => {
    if (!dom.has(id)) dom.set(id, fakeEl(id));
    return dom.get(id);
  };
  const emitted = [];
  const context = createAppContext({});
  const queues = createInteractionQueueState(context);
  const approvals = createApprovalController(context, {
    queues,
    $: byId,
    el: () => fakeEl(),
    render: t => t,
    socket: { connected: true, emit: (name, payload) => emitted.push({ name, payload }) },
    permModal: byId('permModal'),
    questionModal: byId('questionModal'),
  });
  return { approvals, byId, emitted, warnHidden: () => byId('permIntegrityWarn').classList.contains('hidden') };
}

// 服务端算的指纹；随便给个对不上的值就能让前端预检判"不符"，不需要 mock crypto。
const BAD_FP = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const permRequest = (requestId, extra = {}) => ({
  requestId, name: 'Bash', cwd: '/w', input: { command: 'ls' }, ...extra,
});

test('指纹不符时挂警示条（本文件其余用例的前提，先把它钉住）', async () => {
  const { approvals, warnHidden } = mount();

  approvals.enqueuePermission(permRequest('perm_1', { fp: BAD_FP }));
  await approvals.verifyPermIntegrity(permRequest('perm_1', { fp: BAD_FP }));

  assert.equal(warnHidden(), false, '指纹对不上却没有警示条');
});

// ★ 本文件的正题。requestId 在 toolUseID 缺失时回落成 `perm_${++this.permSeq}`（app/src/agent/agent.js），
// 而 permSeq 是 AgentSession 的实例字段、构造期归零——dispose+resume / 切会话 / /clear 都会造出
// 新实例，重新从 perm_1 发号。前端这个 Set 却活在页面生命周期里：clearAll() 若不清它，
// 一次真实的指纹不符之后，后面同号的【正常】审批卡会被误挂"内容可能被篡改"。
test('clearAll 之后，复用同一 requestId 的新审批卡不带上一轮的指纹警示', async () => {
  const { approvals, warnHidden } = mount();

  approvals.enqueuePermission(permRequest('perm_1', { fp: BAD_FP }));
  await approvals.verifyPermIntegrity(permRequest('perm_1', { fp: BAD_FP }));
  assert.equal(warnHidden(), false);

  approvals.clearAll();                                   // epoch 重置 / result / error / 切会话
  approvals.enqueuePermission(permRequest('perm_1'));     // 新 AgentSession 重新从 perm_1 发号

  assert.equal(warnHidden(), true, 'clearAll 漏清 permIntegrityMismatched，正常卡片被误标篡改');
});

// 正常作答与服务端广播两条路径本来就逐条 delete，这里防它们被顺手改掉。
test('作答与 resolvePermission 各自清掉自己那条指纹记录', async () => {
  for (const settle of ['answer', 'resolve']) {
    const { approvals, byId, warnHidden } = mount();
    approvals.enqueuePermission(permRequest('perm_1', { fp: BAD_FP }));
    await approvals.verifyPermIntegrity(permRequest('perm_1', { fp: BAD_FP }));
    assert.equal(warnHidden(), false);

    if (settle === 'answer') byId('permAllow').onclick();
    else approvals.resolvePermission('perm_1');
    approvals.enqueuePermission(permRequest('perm_1'));

    assert.equal(warnHidden(), true, `${settle} 之后同号新卡片仍带着旧的指纹警示`);
  }
});
