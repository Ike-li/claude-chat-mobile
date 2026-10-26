// logic/questions.js —— 多题提问（AskUserQuestion 一次问多道）整组作答的纯逻辑。
// 对齐 CLI：多题时各题答案先在本地攒成草稿、可来回切题改，最后整组一次提交；单题仍是点了即交。
// 草稿形状与 user:answer 的三选一同构：{ optionIndex } | { optionIndexes } | { freeText }。
import { t } from '../i18n.js';

// requestId 形如 `${toolUseID}#${i}`，同一 toolUseID 的各题是一组；与服务端一样按最后一个 # 拆。
export function questionGroupKey(requestId) {
  const s = String(requestId ?? '');
  const hash = s.lastIndexOf('#');
  return hash > 0 ? s.slice(0, hash) : s;
}

// questionCount 由服务端随每道题下发；缺字段（旧 server）按单题处理，走逐题即交的老路径。
export function isGroupedQuestion(q) {
  return Number.isInteger(q?.questionCount) && q.questionCount > 1;
}

function optionText(opt) {
  if (opt == null) return '';
  return typeof opt === 'string' ? opt : (opt.label || '');
}

// 草稿显示成什么；空串＝这题还没答（含勾了又全取消的多选、只填空白的「其他」）。
export function questionDraftLabel(q, draft) {
  if (!draft) return '';
  if (typeof draft.freeText === 'string') return draft.freeText.trim();
  const opts = q?.options || [];
  if (Array.isArray(draft.optionIndexes)) return draft.optionIndexes.map(i => optionText(opts[i])).filter(Boolean).join(t('、'));
  if (Number.isInteger(draft.optionIndex)) return optionText(opts[draft.optionIndex]);
  return '';
}

// 整组提交的回程 answers（每项带 questionIndex），以及还没答的题；missing 非空时不该提交。
export function buildQuestionGroupAnswers(questions, drafts) {
  const answers = [];
  const missing = [];
  for (const q of questions) {
    const draft = drafts.get(q.questionIndex);
    if (!questionDraftLabel(q, draft)) {
      missing.push(q.questionIndex);
    } else if (typeof draft.freeText === 'string') {
      answers.push({ index: q.questionIndex, freeText: draft.freeText.trim() });
    } else if (Array.isArray(draft.optionIndexes)) {
      answers.push({ index: q.questionIndex, optionIndexes: [...draft.optionIndexes].sort((a, b) => a - b) });
    } else {
      answers.push({ index: q.questionIndex, optionIndex: draft.optionIndex });
    }
  }
  return { answers, missing };
}
