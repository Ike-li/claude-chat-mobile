// tests/unit/logic-questions.test.mjs —— 多题提问整组作答的纯逻辑（logic/questions.js）
// 测什么：哪些题算一组 · 草稿在复查页显示成什么 · 整组回程 payload 的形状，以及「没答完」怎么判
// 不测什么：服务端怎么校验整组提交（agent-questions.test.mjs 的 resolveQuestionGroup）· 标签栏、切题、
//         复查页的 DOM 接线（E2E P0-08j / P0-08k）
// 槽位：S1（纯函数）
import test from 'node:test';
import assert from 'node:assert/strict';
import { questionGroupKey, isGroupedQuestion, questionDraftLabel, buildQuestionGroupAnswers } from '../../app/public/js/logic/questions.js';

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

test('buildQuestionGroupAnswers：全答完 → 每题一项、按 questionIndex 标号，missing 为空', () => {
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
  });
});

// 各题分开送达，后几题可能还在路上：没到的题也算没答，否则只答了已到的就能提交，被服务端整组拒收（PR #413 review）
test('buildQuestionGroupAnswers：openIndexes 里还没送到的题也列进 missing', () => {
  const drafts = new Map([[0, { optionIndex: 0 }]]);
  assert.deepEqual(buildQuestionGroupAnswers([q(0)], drafts, [0, 1, 2]), {
    answers: [{ index: 0, optionIndex: 0 }],
    missing: [1, 2],
  });
});

test('buildQuestionGroupAnswers：没答的题（含勾了又全取消的多选、只填空白的其他）列进 missing', () => {
  const questions = [q(0), q(1, { multiSelect: true }), q(2)];
  const drafts = new Map([[1, { optionIndexes: [] }], [2, { freeText: '  ' }]]);
  assert.deepEqual(buildQuestionGroupAnswers(questions, drafts).missing, [0, 1, 2]);
  drafts.set(0, { optionIndex: 0 });
  assert.deepEqual(buildQuestionGroupAnswers(questions, drafts).missing, [1, 2]);
});
