// tests/unit/agent-questions.test.mjs —— AskUserQuestion（F2）行为域单测。
// 从 agent-permissions.test.mjs 分出：按行为域拆分是硬门禁（见 source-layout.test.mjs），
// 提问这一域已自成一块——下发/作答下标对齐、TTL 过期、abort、multiSelect、快照重建。

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession, awaitTtlSettled } from '../helpers/agent-unit.mjs';

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
    // 清理
    s.resolveQuestion('q1#0', 0);
    s.resolveQuestion('q1#1', 0);
    s.dispose();
  });

  // 下发前 .filter(o => o.label) 过滤掉空 label 项，而 resolveQuestion 回读的是【原始未过滤】数组：
  // 只要模型给的选项里有一项不带 label（normalizeQuestionOption 产出 ''），后续所有项下标整体前移，
  // 两侧下标空间就此错位 —— 手机上点「取消」，模型收到的是「删除全部」。
  test('handleQuestion：空 label 项被过滤后，作答下标仍须与下发列表对齐', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: '删掉全部记录吗', options: [{ value: 'NO_LABEL' }, '删除全部', '取消'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    const q = events.find(e => e.type === 'question');
    assert.deepEqual(q.payload.options.map(o => o.label), ['删除全部', '取消'], '空 label 项不下发');

    s.resolveQuestion('q1#0', 1); // 用户点下发列表的下标 1 =「取消」
    const r = await promise;
    const answered = JSON.stringify(r);
    assert.match(answered, /取消/, '模型必须收到「取消」');
    assert.doesNotMatch(answered, /删除全部/, '绝不能把「取消」答成「删除全部」');
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

  test('resolveQuestion：全部答完 → removeEventListener + 单题+整组 request_resolved + denyKinds(answered)', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    let removed = false;
    const origRemove = ac.signal.removeEventListener;
    ac.signal.removeEventListener = (type, fn) => { removed = true; origRemove.call(ac.signal, type, fn); };

    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A', 'B'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', 0);
    assert.equal(s.pendingQuestions.size, 0);
    assert.equal(removed, true);
    assert.equal(s.denyKinds.get('q1'), 'answered');
    const rrs = events.filter(e => e.type === 'request_resolved' && e.payload.kind === 'question');
    // 单题 answered + 整组终态（outcome 含「答案」）
    assert.ok(rrs.some(e => e.payload.requestId === 'q1#0' && e.payload.outcome === 'answered'));
    const final = rrs.find(e => e.payload.requestId === 'q1');
    assert.ok(final);
    assert.ok(final.payload.outcome.includes('「'));
    s.dispose();
  });

  test('abort signal 触发 → 逐个 request_resolved(aborted) + denyKinds(cancelled)', () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    s.handleQuestion(
      { questions: [{ question: 'Q1', options: ['A'] }, { question: 'Q2', options: ['B'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    ac.abort();
    assert.equal(s.pendingQuestions.size, 0);
    assert.equal(s.denyKinds.get('q1'), 'cancelled');
    const aborted = events.filter(e => e.type === 'request_resolved' && e.payload.outcome === 'aborted');
    assert.equal(aborted.length, 2);
    s.dispose();
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
  test('resolveQuestion：freeText（Other）作答 → answered，文案含自由文本', async () => {
    const { s, events } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Which lib?', options: ['dayjs', 'luxon'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', null, { freeText: '  date-fns  ' });
    assert.equal(s.pendingQuestions.size, 0);
    assert.equal(s.denyKinds.get('q1'), 'answered');
    const result = await promise;
    assert.equal(result.behavior, 'deny');
    assert.match(result.message, /date-fns/);
    assert.ok(!result.message.includes('dayjs') || result.message.includes('date-fns'));
    const rr = events.find(e =>
      e.type === 'request_resolved' && e.payload.kind === 'question' && e.payload.requestId === 'q1'
    );
    assert.ok(rr);
    assert.ok(rr.payload.outcome.includes('date-fns'));
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
    assert.match(result.message, /custom answer/);
    assert.ok(!result.message.includes('「A」') || result.message.includes('custom'));
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

  // AG-001：提问 TTL 镜像 BE-003——无人作答时到期 timer fail-closed，防 canUseTool 永挂 + isBusy 锁死
  test('提问到期无人作答 → 到期 timer 自动 fail-closed deny + emit expired（AG-001）', { timeout: 3000 }, async () => {
    const { s, events } = makeSession({ approvalTtlMs: 30 });
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Pick?', options: ['A', 'B'] }] },
      { signal: ac.signal, toolUseID: 'q1' },
    );
    assert.equal(s.pendingQuestions.size, 1);
    const result = await awaitTtlSettled(promise); // 见 helper 注释：expiryTimer 是 unref 的
    assert.equal(result.behavior, 'deny');
    assert.equal(result.interrupt, false);
    assert.equal(s.pendingQuestions.size, 0);
    const rr = events.find(e => e.type === 'request_resolved' && e.payload.requestId === 'q1' && e.payload.outcome === 'expired');
    assert.ok(rr, '整组 outcome=expired');
    assert.equal(s.denyKinds.get('q1'), 'denied');
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

  test('resolveQuestion：multiSelect optionIndexes 多选合并', async () => {
    const { s } = makeSession();
    const ac = new AbortController();
    const promise = s.handleQuestion(
      { questions: [{ question: 'Pick many', multiSelect: true, options: ['A', 'B', 'C'] }] },
      { signal: ac.signal, toolUseID: 'q1' }
    );
    s.resolveQuestion('q1#0', null, { optionIndexes: [0, 2] });
    const result = await promise;
    // 多选合并进同一对书名号：用户选择了：「A、C」
    assert.match(result.message, /「A、C」/);
    assert.ok(!result.message.includes('B'));
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
});
