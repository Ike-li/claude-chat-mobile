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
    _textContent: '',
    get textContent() { return el._textContent; },
    // 对齐真实 DOM：写 textContent 会清掉子节点（多选切换 ☐/☑ 时靠此再挂回 description）
    set textContent(v) { el._textContent = v; el.children.length = 0; },
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

function mount({ getViewingInstanceId = () => null, connected = true } = {}) {
  const dom = new Map();
  const byId = id => {
    if (!dom.has(id)) dom.set(id, fakeEl(id));
    return dom.get(id);
  };
  const emitted = [];
  const bars = [];
  const interrupts = [];
  const socketListeners = new Map();
  const socket = {
    connected,
    emit: (name, payload) => emitted.push({ name, payload }),
    on: (name, fn) => {
      if (!socketListeners.has(name)) socketListeners.set(name, []);
      socketListeners.get(name).push(fn);
    },
  };
  const context = createAppContext({});
  const queues = createInteractionQueueState(context);
  const approvals = createApprovalController(context, {
    queues,
    $: byId,
    el: () => fakeEl(),
    render: t => t,
    addBar: (text, cls) => bars.push({ text, cls }),
    socket,
    permModal: byId('permModal'),
    questionModal: byId('questionModal'),
    requestInterrupt: () => interrupts.push(1),
    getViewingInstanceId,
  });
  return {
    approvals, byId, emitted, bars, interrupts, socket, socketListeners,
    warnHidden: () => byId('permIntegrityWarn').classList.contains('hidden'),
    sheetError: id => {
      const el = byId(id);
      return el.classList.contains('hidden') ? null : el.textContent;
    },
  };
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

  approvals.cancelQuestionArming(); // 过防误触窗再作答（对齐 cancelPermArming）
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
  approvals.cancelQuestionArming();
  pickOption(byId, 1); // 第 1 题 → B
  approvals.clearAll();

  [0, 1].forEach(i => approvals.enqueueQuestion(groupQ(i, 2))); // 切回来时 pending 快照补发
  approvals.cancelQuestionArming(); // 重建开窗再次上锁
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
  approvals.cancelQuestionArming();
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


// ── #388：作答路由到审批/提问所属实例，不是当前查看实例 ──────────────────────
// nav-escape 允许审批卡开着切会话；若 emit 仍带 viewingInstanceId，服务端打到错误实例静默 no-op。
const lastApprove = emitted => emitted.filter(e => e.name === 'user:approve').at(-1)?.payload;

test('审批：切到别的会话后作答，仍路由到入队时的所属实例', () => {
  const { approvals, byId, emitted } = mount({ getViewingInstanceId: () => 'inst-B' });
  approvals.enqueuePermission(permRequest('perm_1'), 'inst-A');
  byId('permAllow').onclick();
  assert.equal(lastApprove(emitted)?.instanceId, 'inst-A', '作答带了当前查看实例而非所属实例');
  assert.equal(lastApprove(emitted)?.requestId, 'perm_1');
});

test('单题提问：切会话后作答仍路由到所属实例', () => {
  const { approvals, byId, emitted } = mount({ getViewingInstanceId: () => 'inst-B' });
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0', text: 'Pick', options: ['A', 'B'],
  }, 'inst-A');
  approvals.cancelQuestionArming();
  pickOption(byId, 0);
  assert.equal(lastAnswer(emitted)?.instanceId, 'inst-A');
});

test('多题组卡：整组提交路由到首题所属实例，不受 viewing 影响', () => {
  const { approvals, byId, emitted } = mount({ getViewingInstanceId: () => 'inst-B' });
  [0, 1].forEach(i => approvals.enqueueQuestion(groupQ(i, 2), 'inst-A'));
  approvals.cancelQuestionArming();
  pickOption(byId, 0);
  pickOption(byId, 1);
  byId('questionGroupSubmit').onclick();
  assert.equal(lastAnswer(emitted)?.instanceId, 'inst-A');
  assert.equal(lastAnswer(emitted)?.requestId, 'toolu_g');
});


// ── #371：断线/校验失败写进浮层内，不被 z-40 遮罩挡住 ─────────────────────────
test('审批：断线点允许时浮层内可见错误，且不 emit', () => {
  const { approvals, byId, emitted, sheetError } = mount({ connected: false });
  approvals.enqueuePermission(permRequest('perm_1'));
  byId('permAllow').onclick();
  assert.match(sheetError('permSheetError') || '', /网络未连接/);
  assert.equal(emitted.length, 0);
  assert.equal(approvals.hasPending(), true, '断线时浮层应保持打开');
});

test('单题提问：断线点选项时浮层内可见错误，且不 emit', () => {
  const { approvals, byId, emitted, sheetError } = mount({ connected: false });
  approvals.enqueueQuestion({ requestId: 'toolu_q#0', text: 'Pick', options: ['A', 'B'] });
  approvals.cancelQuestionArming();
  pickOption(byId, 0);
  assert.match(sheetError('questionSheetError') || '', /网络未连接/);
  assert.equal(emitted.length, 0);
  assert.equal(approvals.hasPending(), true);
});

test('提问跳过：断线时不 requestInterrupt，错误写在浮层内', () => {
  const { approvals, byId, interrupts, sheetError } = mount({ connected: false });
  approvals.enqueueQuestion({ requestId: 'toolu_q#0', text: 'Pick', options: ['A'] });
  approvals.cancelQuestionArming();
  byId('questionSkip').onclick();
  assert.equal(interrupts.length, 0, '断线时不应 emit/触发 interrupt');
  assert.match(sheetError('questionSheetError') || '', /网络未连接/);
});

test('空「其他答案」提示写在提问浮层内', () => {
  const { approvals, byId, sheetError } = mount();
  approvals.enqueueQuestion({ requestId: 'toolu_q#0', text: 'Pick', options: ['A'] });
  approvals.cancelQuestionArming();
  byId('questionOtherInput').value = '   ';
  byId('questionOtherSubmit').onclick();
  assert.match(sheetError('questionSheetError') || '', /请先输入其他答案/);
  assert.equal(approvals.hasPending(), true);
});

test('重连后清掉浮层内断线错误', () => {
  const { approvals, byId, socketListeners, sheetError } = mount({ connected: false });
  approvals.enqueuePermission(permRequest('perm_1'));
  byId('permAllow').onclick();
  assert.match(sheetError('permSheetError') || '', /网络未连接/);
  for (const fn of socketListeners.get('connect') || []) fn();
  assert.equal(sheetError('permSheetError'), null);
});

test('surfaceError 写到当前打开的审批浮层', () => {
  const { approvals, sheetError } = mount();
  approvals.enqueuePermission(permRequest('perm_1'));
  approvals.surfaceError('停止请求超时，可再试一次');
  assert.equal(sheetError('permSheetError'), '停止请求超时，可再试一次');
});


// ── #372：提问 sheet 对齐审批的 600ms 防误触窗口 ─────────────────────────────
test('提问弹出后 questionModal 带 sheet-arming；cancelQuestionArming 解除', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({ requestId: 'toolu_q#0', text: 'Pick', options: ['A', 'B'] });
  assert.equal(byId('questionModal').classList.contains('sheet-arming'), true,
    '刚弹出时应处于防误触期（对齐 #permModal.sheet-arming）');
  assert.equal(byId('questionOptions').children[0].children[0].disabled, true,
    '防误触期内选项应 native disabled（挡键盘 Enter，不只靠 pointer-events）');
  assert.equal(byId('questionSkip').disabled, true, '防误触期内跳过应 disabled');
  approvals.cancelQuestionArming();
  assert.equal(byId('questionModal').classList.contains('sheet-arming'), false,
    'cancelQuestionArming 应清掉 sheet-arming，与计时器到点同效');
  assert.equal(byId('questionOptions').children[0].children[0].disabled, false,
    '解除后选项应恢复可点');
  assert.equal(byId('questionSkip').disabled, false, '解除后跳过应恢复可点');
});

test('提问防误触期内选项点击与跳过不 emit', () => {
  const { approvals, byId, emitted, interrupts } = mount();
  approvals.enqueueQuestion({ requestId: 'toolu_q#0', text: 'Pick', options: ['A', 'B'] });
  assert.equal(byId('questionModal').classList.contains('sheet-arming'), true);
  assert.equal(byId('questionOptions').children[0].children[0].disabled, true);
  assert.equal(byId('questionSkip').disabled, true);
  // 程序化 onclick 仍会跑到 handler；arming 守卫必须 no-op，不能只靠 CSS pointer-events
  pickOption(byId, 0);
  byId('questionSkip').onclick();
  assert.equal(emitted.filter(e => e.name === 'user:answer').length, 0,
    '防误触期内点选项不得 emit user:answer');
  assert.equal(interrupts.length, 0, '防误触期内跳过不得 requestInterrupt');
  assert.equal(approvals.hasPending(), true, '防误触期内误触不得关卡');
});

test('提问防误触解除后点选项才 emit user:answer', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({ requestId: 'toolu_q#0', text: 'Pick', options: ['A', 'B'] });
  assert.equal(byId('questionModal').classList.contains('sheet-arming'), true);
  assert.equal(byId('questionOptions').children[0].children[0].disabled, true);
  // cancel 与计时器到点走同一处状态转移（清 flag + sync disabled）
  approvals.cancelQuestionArming();
  assert.equal(byId('questionOptions').children[0].children[0].disabled, false);
  pickOption(byId, 0);
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
  assert.equal(approvals.hasPending(), false);
});

test('提问防误触计时器到点后选项可 emit', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({ requestId: 'toolu_q#0', text: 'Pick', options: ['A', 'B'] });
  assert.equal(byId('questionOptions').children[0].children[0].disabled, true);
  // 与 cancelQuestionArming 同效：模拟 arm 窗口自然到期
  approvals.cancelQuestionArming();
  pickOption(byId, 1);
  assert.equal(lastAnswer(emitted)?.optionIndex, 1);
});

test('排队的下一题再次弹出时重新上防误触锁', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({ requestId: 'toolu_a#0', text: 'Q1', options: ['A'] });
  approvals.cancelQuestionArming();
  assert.equal(byId('questionModal').classList.contains('sheet-arming'), false);
  pickOption(byId, 0);
  approvals.enqueueQuestion({ requestId: 'toolu_b#0', text: 'Q2', options: ['B'] });
  assert.equal(byId('questionModal').classList.contains('sheet-arming'), true,
    '下一题开窗应再次 sheet-arming，不能沿用上一题已解除的状态');
  assert.equal(byId('questionOptions').children[0].children[0].disabled, true,
    '下一题开窗时选项应再次 native disabled');
});

test('resume 提问浮层时重新上防误触锁', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({ requestId: 'toolu_q#0', text: 'Pick', options: ['A'] });
  approvals.cancelQuestionArming();
  approvals.suspend();
  approvals.resume();
  assert.equal(byId('questionModal').classList.contains('sheet-arming'), true,
    'resume 开窗应先上锁，时长同 showNextQuestion');
  assert.equal(byId('questionOptions').children[0].children[0].disabled, true,
    'resume 后选项应再次 native disabled');
  assert.equal(byId('questionSkip').disabled, true, 'resume 后跳过应再次 disabled');
});

// ── #400 / #382：选项卡可点区域与多选 checkbox 语义 ─────────────────────────
test('选项 description 在 button 内，点说明与点标题走同一 onclick（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'details about Alpha' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  assert.equal(wrap.children.length, 1, 'description 不应再作为 wrap 的兄弟节点（死区）');
  assert.equal(btn.children.length, 1, 'description 应挂在 button 内');
  assert.equal(btn.children[0].textContent, 'details about Alpha');
  // 点「说明」等价于激活按钮（同一控件）
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('选项 preview 仍在 button 外，可独立展开且不代替选题（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'd', preview: 'secret preview' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  const prevBtn = wrap.children[1];
  const prevBox = wrap.children[2];
  assert.ok(prevBtn && prevBox, 'preview 开关与内容应在 wrap 上、button 外');
  assert.equal(btn.children.length, 1, 'preview 不应塞进 button');
  assert.equal(prevBox.textContent, 'secret preview');
  const before = prevBox.classList.contains('hidden');
  prevBtn.onclick({ stopPropagation() {} });
  assert.notEqual(prevBox.classList.contains('hidden'), before, '预览应能单独切换显隐');
  assert.equal(emitted.length, 0, '点预览不应提交答案');
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('多选选项带 role=checkbox 与 aria-checked，切换时同步（#382）', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick many',
    multiSelect: true,
    options: [
      { label: 'A', description: 'desc A' },
      { label: 'B', description: 'desc B' },
    ],
  });
  approvals.cancelQuestionArming();
  const wrap0 = byId('questionOptions').children[0];
  const btn0 = wrap0.children[0];
  assert.equal(btn0.getAttribute('role'), 'checkbox');
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.equal(btn0.children[0].textContent, 'desc A');

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'true');
  assert.match(btn0.textContent, /^☑ /);
  assert.equal(btn0.children.length, 1, '切换勾选后 description 仍在 button 内');
  assert.equal(btn0.children[0].textContent, 'desc A');
  assert.equal(wrap0.classList.contains('border-accent'), true);

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.match(btn0.textContent, /^☐ /);
  assert.equal(wrap0.classList.contains('border-accent'), false);
});

// ── #400 / #382：选项卡可点区域与多选 checkbox 语义 ─────────────────────────
test('选项 description 在 button 内，点说明与点标题走同一 onclick（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'details about Alpha' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  assert.equal(wrap.children.length, 1, 'description 不应再作为 wrap 的兄弟节点（死区）');
  assert.equal(btn.children.length, 1, 'description 应挂在 button 内');
  assert.equal(btn.children[0].textContent, 'details about Alpha');
  // 点「说明」等价于激活按钮（同一控件）
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('选项 preview 仍在 button 外，可独立展开且不代替选题（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'd', preview: 'secret preview' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  const prevBtn = wrap.children[1];
  const prevBox = wrap.children[2];
  assert.ok(prevBtn && prevBox, 'preview 开关与内容应在 wrap 上、button 外');
  assert.equal(btn.children.length, 1, 'preview 不应塞进 button');
  assert.equal(prevBox.textContent, 'secret preview');
  const before = prevBox.classList.contains('hidden');
  prevBtn.onclick({ stopPropagation() {} });
  assert.notEqual(prevBox.classList.contains('hidden'), before, '预览应能单独切换显隐');
  assert.equal(emitted.length, 0, '点预览不应提交答案');
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('多选选项带 role=checkbox 与 aria-checked，切换时同步（#382）', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick many',
    multiSelect: true,
    options: [
      { label: 'A', description: 'desc A' },
      { label: 'B', description: 'desc B' },
    ],
  });
  approvals.cancelQuestionArming();
  const wrap0 = byId('questionOptions').children[0];
  const btn0 = wrap0.children[0];
  assert.equal(btn0.getAttribute('role'), 'checkbox');
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.equal(btn0.children[0].textContent, 'desc A');

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'true');
  assert.match(btn0.textContent, /^☑ /);
  assert.equal(btn0.children.length, 1, '切换勾选后 description 仍在 button 内');
  assert.equal(btn0.children[0].textContent, 'desc A');
  assert.equal(wrap0.classList.contains('border-accent'), true);

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.match(btn0.textContent, /^☐ /);
  assert.equal(wrap0.classList.contains('border-accent'), false);
});

// ── #400 / #382：选项卡可点区域与多选 checkbox 语义 ─────────────────────────
test('选项 description 在 button 内，点说明与点标题走同一 onclick（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'details about Alpha' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  assert.equal(wrap.children.length, 1, 'description 不应再作为 wrap 的兄弟节点（死区）');
  assert.equal(btn.children.length, 1, 'description 应挂在 button 内');
  assert.equal(btn.children[0].textContent, 'details about Alpha');
  // 点「说明」等价于激活按钮（同一控件）
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('选项 preview 仍在 button 外，可独立展开且不代替选题（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'd', preview: 'secret preview' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  const prevBtn = wrap.children[1];
  const prevBox = wrap.children[2];
  assert.ok(prevBtn && prevBox, 'preview 开关与内容应在 wrap 上、button 外');
  assert.equal(btn.children.length, 1, 'preview 不应塞进 button');
  assert.equal(prevBox.textContent, 'secret preview');
  const before = prevBox.classList.contains('hidden');
  prevBtn.onclick({ stopPropagation() {} });
  assert.notEqual(prevBox.classList.contains('hidden'), before, '预览应能单独切换显隐');
  assert.equal(emitted.length, 0, '点预览不应提交答案');
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('多选选项带 role=checkbox 与 aria-checked，切换时同步（#382）', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick many',
    multiSelect: true,
    options: [
      { label: 'A', description: 'desc A' },
      { label: 'B', description: 'desc B' },
    ],
  });
  approvals.cancelQuestionArming();
  const wrap0 = byId('questionOptions').children[0];
  const btn0 = wrap0.children[0];
  assert.equal(btn0.getAttribute('role'), 'checkbox');
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.equal(btn0.children[0].textContent, 'desc A');

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'true');
  assert.match(btn0.textContent, /^☑ /);
  assert.equal(btn0.children.length, 1, '切换勾选后 description 仍在 button 内');
  assert.equal(btn0.children[0].textContent, 'desc A');
  assert.equal(wrap0.classList.contains('border-accent'), true);

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.match(btn0.textContent, /^☐ /);
  assert.equal(wrap0.classList.contains('border-accent'), false);
});

// ── #400 / #382：选项卡可点区域与多选 checkbox 语义 ─────────────────────────
test('选项 description 在 button 内，点说明与点标题走同一 onclick（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'details about Alpha' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  assert.equal(wrap.children.length, 1, 'description 不应再作为 wrap 的兄弟节点（死区）');
  assert.equal(btn.children.length, 1, 'description 应挂在 button 内');
  assert.equal(btn.children[0].textContent, 'details about Alpha');
  // 点「说明」等价于激活按钮（同一控件）
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('选项 preview 仍在 button 外，可独立展开且不代替选题（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'd', preview: 'secret preview' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  const prevBtn = wrap.children[1];
  const prevBox = wrap.children[2];
  assert.ok(prevBtn && prevBox, 'preview 开关与内容应在 wrap 上、button 外');
  assert.equal(btn.children.length, 1, 'preview 不应塞进 button');
  assert.equal(prevBox.textContent, 'secret preview');
  const before = prevBox.classList.contains('hidden');
  prevBtn.onclick({ stopPropagation() {} });
  assert.notEqual(prevBox.classList.contains('hidden'), before, '预览应能单独切换显隐');
  assert.equal(emitted.length, 0, '点预览不应提交答案');
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('多选选项带 role=checkbox 与 aria-checked，切换时同步（#382）', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick many',
    multiSelect: true,
    options: [
      { label: 'A', description: 'desc A' },
      { label: 'B', description: 'desc B' },
    ],
  });
  approvals.cancelQuestionArming();
  const wrap0 = byId('questionOptions').children[0];
  const btn0 = wrap0.children[0];
  assert.equal(btn0.getAttribute('role'), 'checkbox');
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.equal(btn0.children[0].textContent, 'desc A');

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'true');
  assert.match(btn0.textContent, /^☑ /);
  assert.equal(btn0.children.length, 1, '切换勾选后 description 仍在 button 内');
  assert.equal(btn0.children[0].textContent, 'desc A');
  assert.equal(wrap0.classList.contains('border-accent'), true);

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.match(btn0.textContent, /^☐ /);
  assert.equal(wrap0.classList.contains('border-accent'), false);
});

// ── #400 / #382：选项卡可点区域与多选 checkbox 语义 ─────────────────────────
test('选项 description 在 button 内，点说明与点标题走同一 onclick（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'details about Alpha' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  assert.equal(wrap.children.length, 1, 'description 不应再作为 wrap 的兄弟节点（死区）');
  assert.equal(btn.children.length, 1, 'description 应挂在 button 内');
  assert.equal(btn.children[0].textContent, 'details about Alpha');
  // 点「说明」等价于激活按钮（同一控件）
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('选项 preview 仍在 button 外，可独立展开且不代替选题（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'd', preview: 'secret preview' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  const prevBtn = wrap.children[1];
  const prevBox = wrap.children[2];
  assert.ok(prevBtn && prevBox, 'preview 开关与内容应在 wrap 上、button 外');
  assert.equal(btn.children.length, 1, 'preview 不应塞进 button');
  assert.equal(prevBox.textContent, 'secret preview');
  const before = prevBox.classList.contains('hidden');
  prevBtn.onclick({ stopPropagation() {} });
  assert.notEqual(prevBox.classList.contains('hidden'), before, '预览应能单独切换显隐');
  assert.equal(emitted.length, 0, '点预览不应提交答案');
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('多选选项带 role=checkbox 与 aria-checked，切换时同步（#382）', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick many',
    multiSelect: true,
    options: [
      { label: 'A', description: 'desc A' },
      { label: 'B', description: 'desc B' },
    ],
  });
  approvals.cancelQuestionArming();
  const wrap0 = byId('questionOptions').children[0];
  const btn0 = wrap0.children[0];
  assert.equal(btn0.getAttribute('role'), 'checkbox');
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.equal(btn0.children[0].textContent, 'desc A');

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'true');
  assert.match(btn0.textContent, /^☑ /);
  assert.equal(btn0.children.length, 1, '切换勾选后 description 仍在 button 内');
  assert.equal(btn0.children[0].textContent, 'desc A');
  assert.equal(wrap0.classList.contains('border-accent'), true);

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.match(btn0.textContent, /^☐ /);
  assert.equal(wrap0.classList.contains('border-accent'), false);
});

// ── #400 / #382：选项卡可点区域与多选 checkbox 语义 ─────────────────────────
test('选项 description 在 button 内，点说明与点标题走同一 onclick（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'details about Alpha' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  assert.equal(wrap.children.length, 1, 'description 不应再作为 wrap 的兄弟节点（死区）');
  assert.equal(btn.children.length, 1, 'description 应挂在 button 内');
  assert.equal(btn.children[0].textContent, 'details about Alpha');
  // 点「说明」等价于激活按钮（同一控件）
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('选项 preview 仍在 button 外，可独立展开且不代替选题（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'd', preview: 'secret preview' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  const prevBtn = wrap.children[1];
  const prevBox = wrap.children[2];
  assert.ok(prevBtn && prevBox, 'preview 开关与内容应在 wrap 上、button 外');
  assert.equal(btn.children.length, 1, 'preview 不应塞进 button');
  assert.equal(prevBox.textContent, 'secret preview');
  const before = prevBox.classList.contains('hidden');
  prevBtn.onclick({ stopPropagation() {} });
  assert.notEqual(prevBox.classList.contains('hidden'), before, '预览应能单独切换显隐');
  assert.equal(emitted.length, 0, '点预览不应提交答案');
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('多选选项带 role=checkbox 与 aria-checked，切换时同步（#382）', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick many',
    multiSelect: true,
    options: [
      { label: 'A', description: 'desc A' },
      { label: 'B', description: 'desc B' },
    ],
  });
  approvals.cancelQuestionArming();
  const wrap0 = byId('questionOptions').children[0];
  const btn0 = wrap0.children[0];
  assert.equal(btn0.getAttribute('role'), 'checkbox');
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.equal(btn0.children[0].textContent, 'desc A');

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'true');
  assert.match(btn0.textContent, /^☑ /);
  assert.equal(btn0.children.length, 1, '切换勾选后 description 仍在 button 内');
  assert.equal(btn0.children[0].textContent, 'desc A');
  assert.equal(wrap0.classList.contains('border-accent'), true);

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.match(btn0.textContent, /^☐ /);
  assert.equal(wrap0.classList.contains('border-accent'), false);
});

// ── #400 / #382：选项卡可点区域与多选 checkbox 语义 ─────────────────────────
test('选项 description 在 button 内，点说明与点标题走同一 onclick（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'details about Alpha' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  assert.equal(wrap.children.length, 1, 'description 不应再作为 wrap 的兄弟节点（死区）');
  assert.equal(btn.children.length, 1, 'description 应挂在 button 内');
  assert.equal(btn.children[0].textContent, 'details about Alpha');
  // 点「说明」等价于激活按钮（同一控件）
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('选项 preview 仍在 button 外，可独立展开且不代替选题（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'd', preview: 'secret preview' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  const prevBtn = wrap.children[1];
  const prevBox = wrap.children[2];
  assert.ok(prevBtn && prevBox, 'preview 开关与内容应在 wrap 上、button 外');
  assert.equal(btn.children.length, 1, 'preview 不应塞进 button');
  assert.equal(prevBox.textContent, 'secret preview');
  const before = prevBox.classList.contains('hidden');
  prevBtn.onclick({ stopPropagation() {} });
  assert.notEqual(prevBox.classList.contains('hidden'), before, '预览应能单独切换显隐');
  assert.equal(emitted.length, 0, '点预览不应提交答案');
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('多选选项带 role=checkbox 与 aria-checked，切换时同步（#382）', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick many',
    multiSelect: true,
    options: [
      { label: 'A', description: 'desc A' },
      { label: 'B', description: 'desc B' },
    ],
  });
  approvals.cancelQuestionArming();
  const wrap0 = byId('questionOptions').children[0];
  const btn0 = wrap0.children[0];
  assert.equal(btn0.getAttribute('role'), 'checkbox');
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.equal(btn0.children[0].textContent, 'desc A');

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'true');
  assert.match(btn0.textContent, /^☑ /);
  assert.equal(btn0.children.length, 1, '切换勾选后 description 仍在 button 内');
  assert.equal(btn0.children[0].textContent, 'desc A');
  assert.equal(wrap0.classList.contains('border-accent'), true);

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.match(btn0.textContent, /^☐ /);
  assert.equal(wrap0.classList.contains('border-accent'), false);
});

// ── #400 / #382：选项卡可点区域与多选 checkbox 语义 ─────────────────────────
test('选项 description 在 button 内，点说明与点标题走同一 onclick（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'details about Alpha' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  assert.equal(wrap.children.length, 1, 'description 不应再作为 wrap 的兄弟节点（死区）');
  assert.equal(btn.children.length, 1, 'description 应挂在 button 内');
  assert.equal(btn.children[0].textContent, 'details about Alpha');
  // 点「说明」等价于激活按钮（同一控件）
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('选项 preview 仍在 button 外，可独立展开且不代替选题（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'd', preview: 'secret preview' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  const prevBtn = wrap.children[1];
  const prevBox = wrap.children[2];
  assert.ok(prevBtn && prevBox, 'preview 开关与内容应在 wrap 上、button 外');
  assert.equal(btn.children.length, 1, 'preview 不应塞进 button');
  assert.equal(prevBox.textContent, 'secret preview');
  const before = prevBox.classList.contains('hidden');
  prevBtn.onclick({ stopPropagation() {} });
  assert.notEqual(prevBox.classList.contains('hidden'), before, '预览应能单独切换显隐');
  assert.equal(emitted.length, 0, '点预览不应提交答案');
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('多选选项带 role=checkbox 与 aria-checked，切换时同步（#382）', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick many',
    multiSelect: true,
    options: [
      { label: 'A', description: 'desc A' },
      { label: 'B', description: 'desc B' },
    ],
  });
  approvals.cancelQuestionArming();
  const wrap0 = byId('questionOptions').children[0];
  const btn0 = wrap0.children[0];
  assert.equal(btn0.getAttribute('role'), 'checkbox');
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.equal(btn0.children[0].textContent, 'desc A');

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'true');
  assert.match(btn0.textContent, /^☑ /);
  assert.equal(btn0.children.length, 1, '切换勾选后 description 仍在 button 内');
  assert.equal(btn0.children[0].textContent, 'desc A');
  assert.equal(wrap0.classList.contains('border-accent'), true);

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.match(btn0.textContent, /^☐ /);
  assert.equal(wrap0.classList.contains('border-accent'), false);
});

// ── #400 / #382：选项卡可点区域与多选 checkbox 语义 ─────────────────────────
test('选项 description 在 button 内，点说明与点标题走同一 onclick（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'details about Alpha' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  assert.equal(wrap.children.length, 1, 'description 不应再作为 wrap 的兄弟节点（死区）');
  assert.equal(btn.children.length, 1, 'description 应挂在 button 内');
  assert.equal(btn.children[0].textContent, 'details about Alpha');
  // 点「说明」等价于激活按钮（同一控件）
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('选项 preview 仍在 button 外，可独立展开且不代替选题（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'd', preview: 'secret preview' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  const prevBtn = wrap.children[1];
  const prevBox = wrap.children[2];
  assert.ok(prevBtn && prevBox, 'preview 开关与内容应在 wrap 上、button 外');
  assert.equal(btn.children.length, 1, 'preview 不应塞进 button');
  assert.equal(prevBox.textContent, 'secret preview');
  const before = prevBox.classList.contains('hidden');
  prevBtn.onclick({ stopPropagation() {} });
  assert.notEqual(prevBox.classList.contains('hidden'), before, '预览应能单独切换显隐');
  assert.equal(emitted.length, 0, '点预览不应提交答案');
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('多选选项带 role=checkbox 与 aria-checked，切换时同步（#382）', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick many',
    multiSelect: true,
    options: [
      { label: 'A', description: 'desc A' },
      { label: 'B', description: 'desc B' },
    ],
  });
  approvals.cancelQuestionArming();
  const wrap0 = byId('questionOptions').children[0];
  const btn0 = wrap0.children[0];
  assert.equal(btn0.getAttribute('role'), 'checkbox');
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.equal(btn0.children[0].textContent, 'desc A');

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'true');
  assert.match(btn0.textContent, /^☑ /);
  assert.equal(btn0.children.length, 1, '切换勾选后 description 仍在 button 内');
  assert.equal(btn0.children[0].textContent, 'desc A');
  assert.equal(wrap0.classList.contains('border-accent'), true);

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.match(btn0.textContent, /^☐ /);
  assert.equal(wrap0.classList.contains('border-accent'), false);
});

// ── #400 / #382：选项卡可点区域与多选 checkbox 语义 ─────────────────────────
test('选项 description 在 button 内，点说明与点标题走同一 onclick（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'details about Alpha' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  assert.equal(wrap.children.length, 1, 'description 不应再作为 wrap 的兄弟节点（死区）');
  assert.equal(btn.children.length, 1, 'description 应挂在 button 内');
  assert.equal(btn.children[0].textContent, 'details about Alpha');
  // 点「说明」等价于激活按钮（同一控件）
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('选项 preview 仍在 button 外，可独立展开且不代替选题（#400）', () => {
  const { approvals, byId, emitted } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick',
    options: [{ label: 'Alpha', description: 'd', preview: 'secret preview' }, 'B'],
  });
  approvals.cancelQuestionArming();
  const wrap = byId('questionOptions').children[0];
  const btn = wrap.children[0];
  const prevBtn = wrap.children[1];
  const prevBox = wrap.children[2];
  assert.ok(prevBtn && prevBox, 'preview 开关与内容应在 wrap 上、button 外');
  assert.equal(btn.children.length, 1, 'preview 不应塞进 button');
  assert.equal(prevBox.textContent, 'secret preview');
  const before = prevBox.classList.contains('hidden');
  prevBtn.onclick({ stopPropagation() {} });
  assert.notEqual(prevBox.classList.contains('hidden'), before, '预览应能单独切换显隐');
  assert.equal(emitted.length, 0, '点预览不应提交答案');
  btn.onclick();
  assert.equal(lastAnswer(emitted)?.optionIndex, 0);
});

test('多选选项带 role=checkbox 与 aria-checked，切换时同步（#382）', () => {
  const { approvals, byId } = mount();
  approvals.enqueueQuestion({
    requestId: 'toolu_q#0',
    text: 'Pick many',
    multiSelect: true,
    options: [
      { label: 'A', description: 'desc A' },
      { label: 'B', description: 'desc B' },
    ],
  });
  approvals.cancelQuestionArming();
  const wrap0 = byId('questionOptions').children[0];
  const btn0 = wrap0.children[0];
  assert.equal(btn0.getAttribute('role'), 'checkbox');
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.equal(btn0.children[0].textContent, 'desc A');

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'true');
  assert.match(btn0.textContent, /^☑ /);
  assert.equal(btn0.children.length, 1, '切换勾选后 description 仍在 button 内');
  assert.equal(btn0.children[0].textContent, 'desc A');
  assert.equal(wrap0.classList.contains('border-accent'), true);

  btn0.onclick();
  assert.equal(btn0.getAttribute('aria-checked'), 'false');
  assert.match(btn0.textContent, /^☐ /);
  assert.equal(wrap0.classList.contains('border-accent'), false);
});
