// tests/unit/logic-questions.test.mjs —— 多题提问整组作答的纯逻辑（logic/questions.js）
// 测什么：哪些题算一组 · 草稿在复查页显示成什么 · 整组回程 payload 的形状，以及「没答完」怎么判
// 不测什么：服务端怎么校验整组提交（agent-questions.test.mjs 的 resolveQuestionGroup）· 标签栏、切题、
//         复查页的 DOM 接线（E2E P0-08j / P0-08k）
// 槽位：S1（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { questionGroupKey, isGroupedQuestion, questionDraftLabel, buildQuestionGroupAnswers, askQuestionResultView } from '../../app/public/js/logic/questions.js';

const q = (questionIndex, extra = {}) => ({
  requestId: `toolu_1#${questionIndex}`,
  questionIndex,
  questionCount: 3,
  options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
  ...extra,
});

test('questionGroupKey：取最后一个 # 之前的部分，与服务端拆 requestId 的方式一致', () => {
  assert.equal(questionGroupKey('toolu_1#2'), 'toolu_1');
  assert.equal(questionGroupKey('a#b#0'), 'a#b');
});

test('isGroupedQuestion：只有服务端标了 questionCount > 1 才按一组处理；缺字段（旧 server）退回逐题即交', () => {
  assert.equal(isGroupedQuestion(q(0)), true);
  assert.equal(isGroupedQuestion(q(0, { questionCount: 1 })), false);
  assert.equal(isGroupedQuestion({ requestId: 'toolu_1#0', options: [] }), false);
});

test('questionDraftLabel：单选、多选、其他三种草稿各自显示成用户选的内容；空草稿显示为空（＝没答）', () => {
  assert.equal(questionDraftLabel(q(0), { optionIndex: 1 }), 'B');
  assert.equal(questionDraftLabel(q(0), { optionIndexes: [0, 2] }), 'A、C');
  assert.equal(questionDraftLabel(q(0), { freeText: '  自己写的  ' }), '自己写的');
  assert.equal(questionDraftLabel(q(0), undefined), '');
  assert.equal(questionDraftLabel(q(0), { optionIndexes: [] }), '');
  assert.equal(questionDraftLabel(q(0), { freeText: '   ' }), '');
});

test('buildQuestionGroupAnswers：全答完 → 每题一项、按 questionIndex 标号，missing / undelivered 为空', () => {
  const questions = [q(0), q(1, { multiSelect: true }), q(2)];
  const drafts = new Map([
    [0, { optionIndex: 2 }],
    [1, { optionIndexes: [2, 0] }],
    [2, { freeText: ' 其他答案 ' }],
  ]);
  assert.deepEqual(buildQuestionGroupAnswers(questions, drafts), {
    answers: [
      { index: 0, optionIndex: 2 },
      { index: 1, optionIndexes: [0, 2] },
      { index: 2, freeText: '其他答案' },
    ],
    missing: [],
    undelivered: [],
  });
});

// 各题分开送达，后几题可能还在路上：用户没见过的题不能替他跳过，收齐之前不放行提交（PR #413 review）
test('buildQuestionGroupAnswers：openIndexes 里还没送到的题列进 undelivered，不写进 answers', () => {
  const drafts = new Map([[0, { optionIndex: 0 }]]);
  assert.deepEqual(buildQuestionGroupAnswers([q(0)], drafts, [0, 1, 2]), {
    answers: [{ index: 0, optionIndex: 0 }],
    missing: [],
    undelivered: [1, 2],
  });
});

// #455 起允许留题不答直接提交（机主 2026-10-29 改判，对齐 CLI）。服务端要求整组覆盖每一道未答题，
// 所以没答的题要显式写成 { skipped: true }，不能只是不发——不发会被整组拒收，这一轮挂到 TTL。
test('buildQuestionGroupAnswers：看过但没答的题（含勾了又全取消的多选、只填空白的其他）列进 missing，并按 skipped 提交', () => {
  const questions = [q(0), q(1, { multiSelect: true }), q(2)];
  const drafts = new Map([[1, { optionIndexes: [] }], [2, { freeText: '  ' }]]);
  const none = buildQuestionGroupAnswers(questions, drafts);
  assert.deepEqual(none.missing, [0, 1, 2]);
  assert.deepEqual(none.answers, [{ index: 0, skipped: true }, { index: 1, skipped: true }, { index: 2, skipped: true }]);
  drafts.set(0, { optionIndex: 0 });
  const some = buildQuestionGroupAnswers(questions, drafts);
  assert.deepEqual(some.missing, [1, 2]);
  assert.deepEqual(some.answers, [{ index: 0, optionIndex: 0 }, { index: 1, skipped: true }, { index: 2, skipped: true }]);
});

// AskUserQuestion 结果卡的状态：#455 起答案走 allow，tool_result 是 CLI 自己的非错误文案；旧 transcript 里是
// deny 通道写的错误文案，回放时不能把答过的卡显成红色 ❌。取消 / 中止仍是 deny（已取消，和审批拒绝同一个图标）。
test('askQuestionResultView：新格式按 CLI 文案判已回答 / 没回答，旧 deny 格式按已回答 / 已取消 / 没回答回放', () => {
  assert.deepEqual(askQuestionResultView({ ok: true, text: 'Your questions have been answered: "Q"="A". You can now continue with these answers in mind.' }),
    { kind: 'answered', text: 'Your questions have been answered: "Q"="A". You can now continue with these answers in mind.' });
  assert.equal(askQuestionResultView({ ok: true, text: 'The user answered: …' }).kind, 'answered');
  assert.equal(askQuestionResultView({ ok: true, text: 'The user did not answer the questions.' }).kind, 'unanswered');
  // 旧 transcript：SDK / CLI 可能给错误文案加了 Error: 前缀，判定与展示都要剥掉
  assert.deepEqual(askQuestionResultView({ ok: false, text: 'Error: 用户选择了：「A」、「B」' }), { kind: 'answered', text: '用户选择了：「A」、「B」' });
  assert.equal(askQuestionResultView({ ok: false, text: '用户选择了：「A」' }).kind, 'answered');
  assert.deepEqual(askQuestionResultView({ ok: false, text: '提问已过期，操作未作答' }), { kind: 'unanswered', text: '提问已过期，操作未作答' });
  assert.equal(askQuestionResultView({ ok: false, text: 'Error: 问题已取消' }).kind, 'denied');
  // 其余错误照旧是错误：真出错的不能被洗成已回答
  assert.deepEqual(askQuestionResultView({ ok: false, text: 'Error: tool crashed' }), { kind: 'error', text: 'Error: tool crashed' });
});
