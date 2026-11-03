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

// 整组提交的回程 answers（每项带 questionIndex）。#455 起允许留题不答（对齐 CLI）：看过但没答的题列进 missing、
// 并以 { index, skipped: true } 写进 answers——服务端要整组覆盖每一道未答题，不发那一项会被整组拒收。
// openIndexes 是服务端说仍未作答的各题：各题分开送达，还没送到的列进 undelivered；用户没见过的题不能替他跳过，
// undelivered 非空时不该提交。
export function buildQuestionGroupAnswers(questions, drafts, openIndexes = []) {
  const answers = [];
  const missing = [];
  const undelivered = [];
  const byIndex = new Map(questions.map(q => [q.questionIndex, q]));
  const indexes = [...new Set([...openIndexes, ...byIndex.keys()])].sort((a, b) => a - b);
  for (const i of indexes) {
    const q = byIndex.get(i);
    const draft = drafts.get(i);
    if (!q) {
      undelivered.push(i);
    } else if (!questionDraftLabel(q, draft)) {
      missing.push(i);
      answers.push({ index: i, skipped: true });
    } else if (typeof draft.freeText === 'string') {
      answers.push({ index: q.questionIndex, freeText: draft.freeText.trim() });
    } else if (Array.isArray(draft.optionIndexes)) {
      answers.push({ index: q.questionIndex, optionIndexes: [...draft.optionIndexes].sort((a, b) => a - b) });
    } else {
      answers.push({ index: q.questionIndex, optionIndex: draft.optionIndex });
    }
  }
  return { answers, missing, undelivered };
}

// AskUserQuestion 结果卡的状态与正文（直播、历史回放、终端镜像同一个判法）。#455 起答案走 allow 通道，tool_result
// 是 CLI 自己的非错误文案；旧 transcript 里是 deny 通道写进错误文案的中文，回放时不能把答过的卡显成红色 ❌。
// 取消 / 中止仍走 deny（「问题已取消」），与审批拒绝同显「已取消」。其余错误照旧是错误。
const LEGACY_ERROR_PREFIX = /^Error:\s*/i;
export function askQuestionResultView({ ok, text } = {}) {
  const raw = String(text ?? '');
  if (ok !== false) {
    return { kind: raw.startsWith('The user did not answer') ? 'unanswered' : 'answered', text: raw };
  }
  const body = raw.replace(LEGACY_ERROR_PREFIX, '');
  if (body.startsWith('用户选择了：')) return { kind: 'answered', text: body };
  if (body.startsWith('提问已过期')) return { kind: 'unanswered', text: body };
  if (body.startsWith('问题已取消')) return { kind: 'denied', text: body };
  return { kind: 'error', text: raw };
}
