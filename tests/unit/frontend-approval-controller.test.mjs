// 审批弹窗控制器（app/public/js/app/approval-questions.js#createApprovalController）的行为域单测。
//
// 这个模块是 2026-08-02 从 app.js 顶层整体搬出来的 419 行状态机，搬出来时没带测试。
// 本文件只覆盖「跨卡片/跨会话的残留状态」这一域——那是整体搬迁最容易漏的一类：
// 原来散在顶层的量各自被四段逐字复制的清理序列照顾，收敛成一个 clearAll() 之后，
// 漏进那个动词的量就再也没人清了。
// 多题组卡的两条也属这一域：别的设备先答掉组里一题、切会话收卡后再重建（E2E 造不出旧页面逐题作答那一档）。

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
    // 控制器重绘列表前写 innerHTML = '' 清空；替身照做，否则 children 会叠着上一次的选项
    set innerHTML(v) { if (v === '') el.children.length = 0; },
    get innerHTML() { return ''; },
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

// 验收 O28：完整性核验是异步的，结果可能晚于防误触结束才出来——那时「允许」已经解禁，
// 得在出结果那一刻重新禁用，而不是只在防误触结束时算一次。
test('防误触结束后才核验出指纹不符，「允许」也随即禁用，「拒绝」不受影响', async () => {
  const { approvals, byId } = mount();
  approvals.enqueuePermission(permRequest('perm_1', { fp: BAD_FP }));
  assert.equal(byId('permAllow').disabled, true, '前提：刚弹出时处在防误触期');
  approvals.cancelPermArming(); // 与防误触计时器到点走同一处状态转移
  assert.equal(byId('permAllow').disabled, false, '前提：防误触结束、核验还没出结果时「允许」可点');

  await approvals.verifyPermIntegrity(permRequest('perm_1', { fp: BAD_FP }));
  assert.equal(byId('permAllow').disabled, true, '核验出不符后「允许」仍可点');
  assert.equal(byId('permDeny').disabled, false, '「拒绝」不该因完整性不符被禁用');
});

// ── 多题组卡（对齐 CLI：一次问多道时合成一张卡，答案攒成草稿、最后整组提交）──────────────
const groupQ = (i, count = 3) => ({
  requestId: `toolu_g#${i}`, text: `Q${i + 1}`, options: ['A', 'B'], questionIndex: i, questionCount: count,
});
// 点当前题的第 n 个选项（选项外包一层 wrap，按钮是 wrap 的第一个子节点）
const pickOption = (byId, n) => byId('questionOptions').children[n].children[0].onclick();
const lastAnswer = emitted => emitted.filter(e => e.name === 'user:answer').at(-1)?.payload;

// 别的设备上没刷新的旧页面仍走逐题即交：服务端已收下那一题，整组提交再带上它会被整组拒收
// （agent.js resolveQuestionGroup 要求恰好覆盖未答题），而本机早已乐观关卡——这一轮就悬到 TTL。
test('多题组卡：别的设备先答掉组里一题，那题从组卡移除，本机整组提交只交剩下的题', () => {
  const { approvals, byId, emitted } = mount();
  [0, 1, 2].forEach(i => approvals.enqueueQuestion(groupQ(i)));
  approvals.resolveQuestion('toolu_g#0');
  assert.equal(approvals.hasPending(), true, '组里还有没答的题，卡不能关');

  pickOption(byId, 1); // 第 2 题 → B，自动跳第 3 题
  pickOption(byId, 0); // 第 3 题 → A，跳到复查页
  byId('questionGroupSubmit').onclick();

  assert.deepEqual(lastAnswer(emitted), {
    requestId: 'toolu_g',
    answers: [{ index: 1, optionIndex: 1 }, { index: 2, optionIndex: 0 }],
    instanceId: null,
  });
  assert.equal(approvals.hasPending(), false);
});

test('多题组卡：切会话收卡（clearAll）再切回来，快照重建的组卡接着用之前的草稿', () => {
  const { approvals, byId, emitted } = mount();
  [0, 1].forEach(i => approvals.enqueueQuestion(groupQ(i, 2)));
  pickOption(byId, 1); // 第 1 题 → B
  approvals.clearAll();

  [0, 1].forEach(i => approvals.enqueueQuestion(groupQ(i, 2))); // 切回来时 pending 快照补发
  byId('questionTabs').children[1].onclick(); // 直接切到第 2 题
  pickOption(byId, 0);
  byId('questionGroupSubmit').onclick();

  assert.deepEqual(lastAnswer(emitted)?.answers, [{ index: 0, optionIndex: 1 }, { index: 1, optionIndex: 0 }],
    '第 1 题的草稿在收卡后丢了，用户切个会话回来就得从头答');
});

// PR #413 review（Codex P2）：各题的 question 事件分开送达。后几题还在路上时只答了已到的就能提交——服务端因没覆盖
// 全部未答题整组拒收，本机却已关卡、把整组标成已答，后到的题和重连快照都被吞掉，这一轮挂到 TTL。
test('多题组卡：后几题还没送到时不放行提交，收齐答完才交整组', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion(groupQ(0));
  pickOption(byId, 0); // 唯一已到的题答完 → 复查页
  assert.equal(byId('questionGroupSubmit').disabled, true, '还有两题没送到，提交不该可点');
  byId('questionGroupSubmit').onclick();
  assert.equal(lastAnswer(emitted), undefined, '不完整的整组被发了出去');
  assert.equal(approvals.hasPending(), true);

  approvals.enqueueQuestion(groupQ(1));
  approvals.enqueueQuestion(groupQ(2));
  byId('questionTabs').children[1].onclick();
  pickOption(byId, 1); // 第 2 题，自动跳第 3 题
  pickOption(byId, 0); // 第 3 题，跳复查页
  byId('questionGroupSubmit').onclick();
  assert.deepEqual(lastAnswer(emitted)?.answers.map(a => a.index), [0, 1, 2]);
});
