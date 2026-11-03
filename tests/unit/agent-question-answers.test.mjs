// tests/unit/agent-question-answers.test.mjs —— AskUserQuestion 回给 CLI 的答案格式（#455）
//
// 作答走 canUseTool 的 allow 通道：updatedInput = 原始 input + answers（+ 有能力时的 annotations）。
// 格式规则来自官方文档「Handle approvals and user input」与 CLI 2.1.312 的宿主回填校验：
//   · answers 的键是题目原文，值是字符串；多选按 CLI 的规则用 ", " 拼，label 里含 ", " 或 " 时加 JSON 引号——
//     这样 CLI 认得出是选项，回给模型的是「answered」那一档文案
//   · 原始字段（questions 等）必须原样回传，改了 CLI 整份拒收
//   · annotations 只能发给声明了 ask_user_question_unanswered_v1 的 CLI，否则旧 CLI 在严格宿主下整份拒收
import test from 'node:test';
import assert from 'node:assert/strict';
import { questionAnswerValue, formatCliAnswer, buildQuestionUpdatedInput } from '../../app/src/agent/question-answers.js';

const pick = { options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };

test('questionAnswerValue：单选取 label、多选取 label 数组（按下标去重保序）、Other 取去空白的原文', () => {
  assert.equal(questionAnswerValue(pick, { optionIndex: 1 }), 'B');
  assert.deepEqual(questionAnswerValue(pick, { optionIndexes: [2, 0, 2] }), ['C', 'A']);
  assert.equal(questionAnswerValue(pick, { freeText: '  自己写的  ' }), '自己写的');
  assert.equal(questionAnswerValue(pick, { optionIndex: 0, freeText: '以写的为准' }), '以写的为准');
});

test('questionAnswerValue：不合法的作答返回 null（越界、空多选、空白 Other），调用方据此不收', () => {
  assert.equal(questionAnswerValue(pick, { optionIndex: 9 }), null);
  assert.equal(questionAnswerValue(pick, { optionIndex: -1 }), null);
  assert.equal(questionAnswerValue(pick, { optionIndexes: [] }), null);
  assert.equal(questionAnswerValue(pick, { optionIndexes: [7] }), null);
  assert.equal(questionAnswerValue(pick, { freeText: '   ' }), null);
  assert.equal(questionAnswerValue(pick, {}), null);
});

test('formatCliAnswer：多选用 ", " 拼；label 含 ", " 或双引号时加 JSON 引号，CLI 才认得出是选项', () => {
  assert.equal(formatCliAnswer('B'), 'B');
  assert.equal(formatCliAnswer(['A', 'C']), 'A, C');
  assert.equal(formatCliAnswer(['Red, green', 'Blue']), '"Red, green", Blue');
  assert.equal(formatCliAnswer(['say "hi"', 'x']), '"say \\"hi\\"", x');
  // 只有逗号没有空格不算分隔符，不加引号
  assert.equal(formatCliAnswer(['a,b', 'c']), 'a,b, c');
});

test('buildQuestionUpdatedInput：原始 input 原样保留，answers 按题目原文作键，没答的题不出现', () => {
  const input = { questions: [{ question: 'Q1', options: [{ label: 'A' }] }, { question: 'Q2', options: [{ label: 'B' }] }], extra: 1 };
  const out = buildQuestionUpdatedInput(input, input.questions, [{ value: 'A' }, { unanswered: 'skipped' }]);
  assert.deepEqual(out, { ...input, answers: { Q1: 'A' } });
  assert.equal(out.questions, input.questions, 'questions 必须是原来那个对象，不是归一化后的副本');
});

test('buildQuestionUpdatedInput：annotate 为真才带 annotations，且只标没答的题', () => {
  const input = { questions: [{ question: 'Q1' }, { question: 'Q2' }, { question: 'Q3' }] };
  const entries = [{ value: ['A', 'B'] }, { unanswered: 'skipped' }, { unanswered: 'dismissed' }];
  assert.deepEqual(buildQuestionUpdatedInput(input, input.questions, entries, { annotate: true }), {
    ...input,
    answers: { Q1: 'A, B' },
    annotations: { Q2: { unanswered: 'skipped' }, Q3: { unanswered: 'dismissed' } },
  });
  assert.equal('annotations' in buildQuestionUpdatedInput(input, input.questions, entries), false,
    'CLI 没声明 ask_user_question_unanswered_v1 时连 annotations 键都不能有：旧 CLI 在严格宿主下会整份拒收');
  assert.equal('annotations' in buildQuestionUpdatedInput(input, input.questions, [{ value: 'x' }, { value: 'y' }, { value: 'z' }], { annotate: true }), false,
    '都答了就没有要标的，不带空 annotations');
});

test('buildQuestionUpdatedInput：一题都没答 → answers 是空对象（CLI 回给模型「The user did not answer the questions.」）', () => {
  const input = { questions: [{ question: 'Q1' }] };
  assert.deepEqual(buildQuestionUpdatedInput(input, input.questions, [null]), { ...input, answers: {} });
});
