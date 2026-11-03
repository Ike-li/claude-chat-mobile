// AskUserQuestion 回给 CLI 的答案（#455）：作答走 canUseTool 的 allow 通道，updatedInput = 原始 input + answers。
// 格式依据官方文档「Handle approvals and user input」与 CLI 2.1.312 的宿主回填校验：
//   · answers 的键是题目原文、值是字符串；没答的题不出现（模型只看到答了的）
//   · 原始字段必须原样回传，改了（含入口归一化、滤掉空 label 后的 questions）CLI 整份拒收
//   · annotations[题目].unanswered 模型看不到、只落 transcript；只能发给声明了 ask_user_question_unanswered_v1
//     的 CLI，否则旧 CLI 在严格宿主下整份拒收——是否带由调用方按能力判

// 一道题的作答 → 单选 label / 多选 label 数组 / Other 原文；不合法（空 Other、空或全非法多选、越界下标）返回 null，
// 调用方据此不作答。Other 优先：同时传了 optionIndex 也用自由文本，对齐「用户最终写的内容」。
export function questionAnswerValue(q, { optionIndex, optionIndexes, freeText } = {}) {
  const free = typeof freeText === 'string' ? freeText.trim() : '';
  if (free) return free;
  const qopts = q?.options || [];
  const labelAt = idx => {
    const opt = qopts[idx];
    return typeof opt === 'string' ? opt : (opt?.label ?? String(idx));
  };
  if (Array.isArray(optionIndexes)) {
    const seen = new Set();
    const labels = [];
    for (const idx of optionIndexes) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= qopts.length || seen.has(idx)) continue;
      seen.add(idx);
      labels.push(labelAt(idx));
    }
    return labels.length ? labels : null;
  }
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= qopts.length) return null; // S6：越界不作答
  return labelAt(optionIndex);
}

// 多选按 CLI 自己的规则拼：", " 分隔，label 里含 ", " 或 " 时加 JSON 引号——拼法一致，CLI 才认得出这些是选项
export function formatCliAnswer(value) {
  if (!Array.isArray(value)) return value;
  return value.map(l => (l.includes(', ') || l.includes('"') ? JSON.stringify(l) : l)).join(', ');
}

// 给人看的答案（留痕条、交互日志）：多选用顿号，与前端 questionDraftLabel 同一口径
export function questionAnswerDisplay(value) {
  return Array.isArray(value) ? value.join('、') : String(value ?? '');
}

// entries[i]：{ value } 已答 / { unanswered: 'skipped'|'dismissed' } 没答（标注只在 annotate 时带）/ null 没答也不标。
// questions 只用来取题目原文作键，与 input.questions 逐题对应（入口归一化不改题序与题目原文）。
export function buildQuestionUpdatedInput(input, questions, entries, { annotate = false } = {}) {
  const answers = {};
  const annotations = {};
  questions.forEach((q, i) => {
    const e = entries[i];
    if (e && 'value' in e) answers[q.question] = formatCliAnswer(e.value);
    else if (annotate && e?.unanswered) annotations[q.question] = { unanswered: e.unanswered };
  });
  return { ...input, answers, ...(Object.keys(annotations).length ? { annotations } : {}) };
}
