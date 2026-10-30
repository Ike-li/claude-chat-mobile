// tests/unit/agent-questions.test.mjs —— AskUserQuestion（F2）行为域单测。
// 从 agent-permissions.test.mjs 分出：按行为域拆分是硬门禁（见 source-layout.test.mjs），
// 提问这一域已自成一块——下发/作答下标对齐、TTL 过期、abort、multiSelect、快照重建。
//
// #455：作答、跳过、不回答、过期都走 canUseTool 的 allow 通道（updatedInput = 原始 input + answers），
// tool_result 与终端里答的同形、不是错误；只有取消 / 中止 / 退出仍是 deny + interrupt（等价终端 Esc）。
// 答案的格式细节在 agent-question-answers.test.mjs。

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession, awaitTtlSettled } from '../helpers/agent-unit.mjs';

const UNANSWERED_CAP = 'ask_user_question_unanswered_v1';

// ---- AskUserQuestion ----
test.describe('AskUserQuestion', () => {
  test('handleQuestion：空 questions → allow', () => {
    const { s } = makeSession();
    const result = s.handleQuestion({ questions: [] }, { signal: new AbortController().signal, toolUseID: 'q1' });
    assert.deepEqual(result, { behavior: 'allow', updatedInput: { questions: [] } });
    s.dispose();
  });

  test('handleQuestion：正常 → emit question 事件 × N、pendingQuestions 写入', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Pick one', options: ['A', 'B'] }, { question: 'Why?', options: ['reason1'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    assert.ok(promise instanceof Promise);
    assert.equal(s.pendingQuestions.size, 1);
    const qs = events.filter(e => e.type === 'question');
    assert.equal(qs.length, 2);
    assert.equal(qs[0].payload.requestId, 'q1#0');
    assert.equal(qs[1].payload.requestId, 'q1#1');
    // 前端靠这两个字段在第一题到达时就认出「这是一组」：单题单选是点了即交，判错就是误提交
    assert.deepEqual(qs.map(q => [q.payload.questionIndex, q.payload.questionCount]), [[0, 2], [1, 2]]);
    // 各题分开送达：前端靠它知道还有哪几题没到，收齐前不放行整组提交（PR #413 review）
    assert.deepEqual(qs.map(q => q.payload.openQuestionIndexes), [[0, 1], [0, 1]]);
    // 清理
    s.resolveQuestion('q1#0', 0);
    s.resolveQuestion('q1#1', 0);
    s.dispose();
  });

  // 下发前 .filter(o => o.label) 过滤掉空 label 项：作答下标必须按过滤后的列表回读，而回给 CLI 的 questions
  // 必须是过滤前的原始 input——前者错了「取消」会答成「删除全部」，后者错了 CLI 判「改了原始字段」整份拒收。
  test('handleQuestion：空 label 项被过滤后，作答下标与下发列表对齐，回给 CLI 的仍是原始 questions', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const input = { questions: [{ question: '删掉全部记录吗', options: [{ value: 'NO_LABEL' }, '删除全部', '取消'] }] };
    const original = structuredClone(input);
    const promise = s.handleQuestion(input, { signal: ac.signal, toolUseID: 'q1' });
    const q = events.find(e => e.type === 'question');
    assert.deepEqual(q.payload.options.map(o => o.label), ['删除全部', '取消'], '空 label 项不下发');

    s.resolveQuestion('q1#0', 1); // 用户点下发列表的下标 1 =「取消」
    const r = await promise;
    assert.equal(r.behavior, 'allow');
    assert.deepEqual(r.updatedInput.answers, { 删掉全部记录吗: '取消' }, '绝不能把「取消」答成「删除全部」');
    assert.deepStrictEqual(r.updatedInput.questions, original.questions, '回传的 questions 被归一化过：CLI 会整份拒收');
    s.dispose();
  });

  test('resolveQuestion：部分答题不整组 resolve，但单题立即 request_resolved(answered)', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A', 'B'] }, { question: 'Q2', options: ['X'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', 1); // 选 B
    assert.equal(s.pendingQuestions.size, 1); // 整组还在
    // 单题落定必须立刻广播，否则切会话/sync 会靠缓冲里的 question 重弹已答项
    const partial = events.filter(e => e.type === 'request_resolved' && e.payload.kind === 'question');
    assert.equal(partial.length, 1);
    assert.equal(partial[0].payload.requestId, 'q1#0');
    assert.equal(partial[0].payload.outcome, 'answered');
    // 整组 toolUseID 级终态尚未发出
    assert.equal(partial.filter(e => e.payload.requestId === 'q1').length, 0);
    s.dispose();
  });

  test('resolveQuestion：全部答完 → allow + removeEventListener + 单题与整组 request_resolved(answered)，不留 denyKind', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    let removed = false;
    const origRemove = ac.signal.removeEventListener;
    ac.signal.removeEventListener = (type, fn) => { removed = true; origRemove.call(ac.signal, type, fn); };

    const promise = s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A', 'B'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', 0);
    assert.equal(s.pendingQuestions.size, 0);
    assert.equal(removed, true);
    const r = await promise;
    assert.equal(r.behavior, 'allow');
    assert.deepEqual(r.updatedInput.answers, { Q1: 'A' });
    // tool_result 本身就是成功的：不再靠 denyKind 把错误伪装成已回答（回放时那张表早没了，答过的卡显 ❌）
    assert.equal(s.denyKinds.has('q1'), false);
    const rrs = events.filter(e => e.type === 'request_resolved' && e.payload.kind === 'question');
    assert.ok(rrs.some(e => e.payload.requestId === 'q1#0' && e.payload.outcome === 'answered'));
    assert.equal(rrs.find(e => e.payload.requestId === 'q1')?.payload.outcome, 'answered');
    s.dispose();
  });

  test('abort signal 触发 → deny + interrupt（等价终端 Esc）+ 逐个 request_resolved(aborted) + denyKinds(cancelled)', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A'] }, { question: 'Q2', options: ['B'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    ac.abort();
    assert.equal(s.pendingQuestions.size, 0);
    assert.equal(s.denyKinds.get('q1'), 'cancelled');
    const aborted = events.filter(e => e.type === 'request_resolved' && e.payload.outcome === 'aborted');
    assert.equal(aborted.length, 2);
    const r = await promise;
    assert.equal(r.behavior, 'deny');
    assert.equal(r.interrupt, true, '中止本轮要真的停下这一轮，不能改成 allow 让模型接着跑');
    s.dispose();
  });

  test('dispose：挂起的提问 deny + interrupt，与中止同一条路', async () => {
    const { s } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion({ questions: [{ question: 'Q1', options: ['A'] }] }, { signal: ac.signal, toolUseID: 'q1' });
    s.dispose();
    const r = await promise;
    assert.equal(r.behavior, 'deny');
    assert.equal(r.interrupt, true);
  });

  test('resolveQuestion：越界 optionIndex 不作答', () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', 99); // 越界
    assert.equal(s.pendingQuestions.size, 1); // 还在
    s.dispose();
  });

  // 对齐 CLI：AskUserQuestion 自动提供 Other，用户可自由文本作答（不在模型给的 options 下标里）
  test('resolveQuestion：freeText（Other）作答 → answers 是去空白的原文', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Which lib?', options: ['dayjs', 'luxon'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', null, { freeText: '  date-fns  ' });
    assert.equal(s.pendingQuestions.size, 0);
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(result.updatedInput.answers, { 'Which lib?': 'date-fns' });
    const rr = events.find(e =>
      e.type === 'request_resolved' && e.payload.kind === 'question' && e.payload.requestId === 'q1'
    );
    assert.equal(rr?.payload.outcome, 'answered');
    s.dispose();
  });

  test('resolveQuestion：freeText 空白 → 不作答（防空 Other）', () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', null, { freeText: '   ' });
    assert.equal(s.pendingQuestions.size, 1);
    s.dispose();
  });

  test('resolveQuestion：freeText 优先于 optionIndex（同时传时用自由文本）', async () => {
    const { s } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A', 'B'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', 0, { freeText: 'custom answer' });
    const result = await promise;
    assert.deepEqual(result.updatedInput.answers, { Q1: 'custom answer' });
    s.dispose();
  });

  // 对齐 CLI：透传 header / multiSelect / option.description|preview，不再只剩 label 字符串
  test('handleQuestion：emit 保留 header/multiSelect/option 详情', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{
        question: 'Which features?',
        header: 'Features',
        multiSelect: true,
        options: [
          { label: 'A', description: 'Alpha', preview: '```a```' },
          { label: 'B', description: 'Beta' },
        ],
      }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    const q = events.find(e => e.type === 'question');
    assert.equal(q.payload.header, 'Features');
    assert.equal(q.payload.multiSelect, true);
    assert.deepEqual(q.payload.options[0], { label: 'A', description: 'Alpha', preview: '```a```' });
    assert.deepEqual(q.payload.options[1], { label: 'B', description: 'Beta' });
    s.resolveQuestion('q1#0', null, { optionIndexes: [0] });
    s.dispose();
  });

  // AG-001：提问 TTL 镜像 BE-003——无人作答时到期 timer 结算，防 canUseTool 永挂 + isBusy 锁死。
  // #455：对提问来说「用户没答」就是如实的结果，回 allow + 空 answers（模型看到 The user did not answer the questions.），
  // 本轮继续；不再伪装成一条错误。不带 unanswered 标注：skipped / replied_in_chat / dismissed 三个取值都不准确。
  test('提问到期无人作答 → allow + 空 answers + emit expired，不带标注（AG-001）', { timeout: 3000 }, async () => {
    const { s, events } = makeSession({ approvalTtlMs: 30 });
    s.cliCapabilities = new Set([UNANSWERED_CAP]);
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Pick?', options: ['A', 'B'] }] },
      { signal: ac.signal, toolUseID: 'q1' },
    );
    assert.equal(s.pendingQuestions.size, 1);
    const result = await awaitTtlSettled(promise); // 见 helper 注释：expiryTimer 是 unref 的
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(result.updatedInput.answers, {});
    assert.equal('annotations' in result.updatedInput, false);
    assert.equal(s.pendingQuestions.size, 0);
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 'q1' && e.payload.outcome === 'expired');
    assert.ok(rr, '整组 outcome=expired');
    assert.equal(s.denyKinds.has('q1'), false);
    s.dispose();
  });

  test('handleQuestion：permission/question payload 带 createdAt/expiresAt（AG-001 契约）', () => {
    const { s, events } = makeSession({ approvalTtlMs: 5000 });
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q', options: ['A'] }] },
      { signal: ac.signal, toolUseID: 'q1' },
    );
    const q = events.find(e => e.type === 'question');
    assert.ok(typeof q.payload.createdAt === 'number');
    assert.equal(q.payload.expiresAt, q.payload.createdAt + 5000);
    s.resolveQuestion('q1#0', 0);
    s.dispose();
  });

  test('resolveQuestion：multiSelect optionIndexes 多选按 CLI 规则用 ", " 拼', async () => {
    const { s } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Pick many', multiSelect: true, options: ['A', 'B', 'C, D'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', null, { optionIndexes: [0, 2] });
    const result = await promise;
    assert.deepEqual(result.updatedInput.answers, { 'Pick many': 'A, "C, D"' });
    s.dispose();
  });

  test('resolveQuestion：optionIndexes 空/非法 → 不作答', () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q', multiSelect: true, options: ['A', 'B'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', null, { optionIndexes: [] });
    assert.equal(s.pendingQuestions.size, 1);
    s.resolveQuestion('q1#0', null, { optionIndexes: [99] });
    assert.equal(s.pendingQuestions.size, 1);
    s.dispose();
  });

  test('pendingRequestsSnapshot：未答问题保留 rich options/header/multiSelect', () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{
        question: 'Q',
        header: 'H',
        multiSelect: true,
        options: [{ label: 'A', description: 'desc' }],
      }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    const snap = s.pendingRequestsSnapshot();
    assert.equal(snap.questions.length, 1);
    assert.equal(snap.questions[0].header, 'H');
    assert.equal(snap.questions[0].multiSelect, true);
    assert.deepEqual(snap.questions[0].options[0], { label: 'A', description: 'desc' });
    // AG-NEW-001：真实 handleQuestion 写入的 TTL 须出现在快照
    assert.equal(typeof snap.questions[0].createdAt, 'number');
    assert.equal(typeof snap.questions[0].expiresAt, 'number');
    assert.ok(snap.questions[0].expiresAt >= snap.questions[0].createdAt);
    s.dispose();
  });

  // 多题整组提交（对齐 CLI：答案在手机上攒着、可来回改，最后一次交出）
  const threeQuestions = {
    questions: [
      { question: 'Q1', options: ['A', 'B'] },
      { question: 'Q2', multiSelect: true, options: ['X', 'Y', 'Z'] },
      { question: 'Q3', options: ['P'] },
    ],
  };

  test('resolveQuestionGroup：整组合法 → 一次交给 CLI，answers 按题目原文作键，逐题与整组 request_resolved 都发', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const input = structuredClone(threeQuestions);
    const promise = s.handleQuestion(input, { signal: ac.signal, toolUseID: 'q1' });
    s.resolveQuestionGroup('q1', [
      { index: 2, freeText: ' 自定义 ' },
      { index: 0, optionIndex: 1 },
      { index: 1, optionIndexes: [0, 2] },
    ]);
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(result.updatedInput.answers, { Q1: 'B', Q2: 'X, Z', Q3: '自定义' });
    assert.deepStrictEqual(result.updatedInput.questions, threeQuestions.questions);
    assert.equal(s.pendingQuestions.size, 0);
    const rrs = events.filter(e => e.type === 'request_resolved' && e.payload.kind === 'question').map(e => e.payload.requestId);
    // 逐题那三条是回放去重与其它设备关卡的依据，整组那条是终态
    assert.deepEqual([...rrs].sort(), ['q1', 'q1#0', 'q1#1', 'q1#2']);
    s.dispose();
  });

  test('resolveQuestionGroup：任一项不合法 → 整组不收，一题都不写入', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(threeQuestions, { signal: ac.signal, toolUseID: 'q1' });
    s.resolveQuestionGroup('q1', [
      { index: 0, optionIndex: 0 },
      { index: 1, optionIndexes: [99] },
      { index: 2, freeText: 'ok' },
    ]);
    assert.equal(s.pendingQuestions.size, 1);
    assert.equal(events.filter(e => e.type === 'request_resolved').length, 0, '不合法的整组不得广播任何一题已答');
    // 半组写入的后果：快照只补发未答项，已写入的题在重连后消失、再也改不回来
    assert.deepEqual(s.pendingRequestsSnapshot().questions.map(q => q.requestId), ['q1#0', 'q1#1', 'q1#2']);
    s.dispose();
  });

  // 允许留题不答之后，「没答」也要显式写成 { skipped: true }：整组仍须覆盖每一道未答题，
  // 否则半组写入的坑又回来了（只收到一半，剩下的题快照里不再补发、也没人能再答）。
  test('resolveQuestionGroup：必须覆盖每一道仍未作答的题，没答的要显式 skipped（缺题、重题都不收）', () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(threeQuestions, { signal: ac.signal, toolUseID: 'q1' });
    s.resolveQuestionGroup('q1', [{ index: 0, optionIndex: 0 }, { index: 1, optionIndexes: [1] }]);
    assert.equal(s.pendingQuestions.get('q1').remaining, 3, '缺一题不收');
    // 三题都覆盖了、只是第 1 题交了两个不同答案：哪个算数说不清，整组不收
    s.resolveQuestionGroup('q1', [{ index: 0, optionIndex: 0 }, { index: 0, optionIndex: 1 }, { index: 1, optionIndexes: [1] }, { index: 2, optionIndex: 0 }]);
    assert.equal(s.pendingQuestions.get('q1').remaining, 3, '同一题交两次不收');
    s.dispose();
  });

  test('resolveQuestionGroup：留题不答（skipped）→ 本轮继续，answers 里没有那题，逐题 outcome=skipped', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(structuredClone(threeQuestions), { signal: ac.signal, toolUseID: 'q1' });
    s.resolveQuestionGroup('q1', [{ index: 0, optionIndex: 0 }, { index: 1, skipped: true }, { index: 2, optionIndex: 0 }]);
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(result.updatedInput.answers, { Q1: 'A', Q3: 'P' });
    assert.equal('annotations' in result.updatedInput, false, 'CLI 没声明能力：不带 annotations，旧 CLI 在严格宿主下会整份拒收');
    const outcomes = Object.fromEntries(events.filter(e => e.type === 'request_resolved').map(e => [e.payload.requestId, e.payload.outcome]));
    assert.deepEqual(outcomes, { 'q1#0': 'answered', 'q1#1': 'skipped', 'q1#2': 'answered', q1: 'answered' });
    s.dispose();
  });

  test('resolveQuestionGroup：CLI 声明了 unanswered 能力 → 没答的题标 unanswered: skipped', async () => {
    const { s } = makeSession();
    s.cliCapabilities = new Set([UNANSWERED_CAP]);
    const ac = new AbortController();
    const promise = s.handleQuestion(structuredClone(threeQuestions), { signal: ac.signal, toolUseID: 'q1' });
    s.resolveQuestionGroup('q1', [{ index: 0, skipped: true }, { index: 1, optionIndexes: [1] }, { index: 2, skipped: true }]);
    const result = await promise;
    assert.deepEqual(result.updatedInput.answers, { Q2: 'Y' });
    assert.deepEqual(result.updatedInput.annotations, { Q1: { unanswered: 'skipped' }, Q3: { unanswered: 'skipped' } });
    s.dispose();
  });

  // PR #413 review（Codex P2）：没刷新的旧页面逐题答掉第 1 题、那条广播还在路上时，本机整组提交仍带着第 1 题。
  // 整组拒收的话，本机已乐观关卡、把整组标成已答，剩下的题连重连快照都被吞掉，这一轮挂到 TTL。
  test('resolveQuestionGroup：别处已抢先答掉的题，整组里那一条忽略（先到先得、不改写），其余照收', async () => {
    for (const items of [
      [{ index: 0, optionIndex: 1 }, { index: 1, optionIndexes: [1] }, { index: 2, optionIndex: 0 }], // 广播还没到，本机仍带着第 1 题
      [{ index: 1, optionIndexes: [1] }, { index: 2, optionIndex: 0 }], // 广播已到，第 1 题已从组卡移除
    ]) {
      const { s } = makeSession();
      const ac = new AbortController();
      const promise = s.handleQuestion(threeQuestions, { signal: ac.signal, toolUseID: 'q1' });
      s.resolveQuestion('q1#0', 0); // 旧页面逐题答了「A」
      s.resolveQuestionGroup('q1', items);
      // 先同步判：被拒收时 promise 要到 TTL 才结算，直接 await 会把测试挂住而不是变红
      assert.equal(s.pendingQuestions.size, 0, `提交了 ${items.length} 项却被整组拒收，这一轮会挂到 TTL`);
      const result = await promise;
      assert.deepEqual(result.updatedInput.answers, { Q1: 'A', Q2: 'Y', Q3: 'P' }, `提交了 ${items.length} 项`);
      s.dispose();
    }
  });

  test('resolveQuestionGroup：过期后整组提交不作答（与逐题作答对称），按过期结算', async () => {
    const { s, events } = makeSession({ approvalTtlMs: 60_000 });
    const ac = new AbortController();
    const promise = s.handleQuestion(threeQuestions, { signal: ac.signal, toolUseID: 'q1' });
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000; // 到期 timer 还没轮到，提交先到
    try {
      s.resolveQuestionGroup('q1', [{ index: 0, optionIndex: 0 }, { index: 1, optionIndexes: [0] }, { index: 2, optionIndex: 0 }]);
    } finally {
      Date.now = realNow;
    }
    const result = await promise;
    assert.deepEqual(result.updatedInput.answers, {}, '过期之后交来的答案不算数');
    assert.ok(events.some(e => e.type === 'request_resolved' && e.payload.requestId === 'q1' && e.payload.outcome === 'expired'));
    s.dispose();
  });

  // 「不回答」：关掉整张卡、本轮继续（模型看到 The user did not answer the questions.），和「中止本轮」是两回事
  test('dismissQuestion：allow + 空 answers，本轮继续；逐题与整组 outcome=dismissed', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(structuredClone(threeQuestions), { signal: ac.signal, toolUseID: 'q1' });
    s.dismissQuestion('q1');
    assert.equal(s.pendingQuestions.size, 0);
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(result.updatedInput.answers, {});
    assert.equal('annotations' in result.updatedInput, false);
    assert.deepStrictEqual(result.updatedInput.questions, threeQuestions.questions);
    const outcomes = Object.fromEntries(events.filter(e => e.type === 'request_resolved').map(e => [e.payload.requestId, e.payload.outcome]));
    assert.deepEqual(outcomes, { 'q1#0': 'dismissed', 'q1#1': 'dismissed', 'q1#2': 'dismissed', q1: 'dismissed' });
    s.dispose();
  });

  test('dismissQuestion：已经答了的题照样交上去；有能力时只给没答的标 dismissed', async () => {
    const { s } = makeSession();
    s.cliCapabilities = new Set([UNANSWERED_CAP]);
    const ac = new AbortController();
    const promise = s.handleQuestion(structuredClone(threeQuestions), { signal: ac.signal, toolUseID: 'q1' });
    s.resolveQuestion('q1#0', 1); // 旧页面逐题答了第 1 题
    s.dismissQuestion('q1');
    const result = await promise;
    assert.deepEqual(result.updatedInput.answers, { Q1: 'B' });
    assert.deepEqual(result.updatedInput.annotations, { Q2: { unanswered: 'dismissed' }, Q3: { unanswered: 'dismissed' } });
    s.dispose();
  });

  test('dismissQuestion：不认识的 toolUseID、已结算的提问 → 什么都不做', () => {
    const { s, events } = makeSession();
    s.dismissQuestion('nope');
    assert.equal(events.length, 0);
    const ac = new AbortController();
    s.handleQuestion({ questions: [{ question: 'Q1', options: ['A'] }] }, { signal: ac.signal, toolUseID: 'q1' });
    s.resolveQuestion('q1#0', 0);
    const before = events.length;
    s.dismissQuestion('q1');
    assert.equal(events.length, before);
    s.dispose();
  });

  test('pendingRequestsSnapshot：多题只补发未答项，但 questionIndex / questionCount 仍按整组算', () => {
    const { s } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A'] }, { question: 'Q2', options: ['B'] }, { question: 'Q3', options: ['C'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', 0);
    const snap = s.pendingRequestsSnapshot();
    assert.deepEqual(
      snap.questions.map(q => [q.requestId, q.questionIndex, q.questionCount]),
      [['q1#1', 1, 3], ['q1#2', 2, 3]],
      '切会话重建的卡片要能认出自己属于三题一组，否则会退回逐题即交'
    );
    // 已答的第 1 题不补发，也不能算进「还没到」，否则重建的组卡永远等不齐、提交永远禁用
    assert.deepEqual(snap.questions.map(q => q.openQuestionIndexes), [[1, 2], [1, 2]]);
    s.dispose();
  });
});
