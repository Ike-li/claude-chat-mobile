// tests/acceptance/lib/evidence.mjs —— 证据规则：凭代码、纯函数或文档得出的结论最多算 partial
//
// 验收要证的是「用户看得见的结果」。读代码、调纯函数、对文档只能说明「应该会这样」，
// 说明不了界面上真的这样——首轮验收里 6 条 pass 就是这么来的，机主追问后才降成 partial。
// 这条写成函数而不是写进 skill 的叮嘱里：report.mjs 落盘前对每条结果都过一遍，不靠 agent 记得。

/** 证据种类。前 9 种是外部可观察的（界面、DOM、截图、推送截获端、命令输出、HTTP、socket、日志、磁盘），
 *  后 3 种只能说明「按代码应该如此」。 */
export const EVIDENCE_KINDS = [
  'ui', 'dom', 'screenshot', 'sink', 'cli', 'http', 'socket', 'log', 'fs',
  'code', 'pure-function', 'doc',
];
const WEAK = new Set(['code', 'pure-function', 'doc']);
const STRONG = new Set(EVIDENCE_KINDS.filter(k => !WEAK.has(k)));

/**
 * 判 pass 却拿不出任何外部可观察证据时降为 partial，附理由；其余原样返回。
 * 证据为空、或种类不认识（多半是拼错），一律不算强证据——失败方向是降档，不是放行。
 */
export function capVerdict(verdict) {
  const { status, evidence = [] } = verdict;
  if (status !== 'pass') return verdict;
  const list = Array.isArray(evidence) ? evidence : [];
  if (list.some(k => STRONG.has(k))) return verdict;

  const unknown = list.filter(k => !STRONG.has(k) && !WEAK.has(k));
  const why = list.length === 0
    ? '没有记录任何证据'
    : `证据只有 ${list.join('、')}`;
  const hint = unknown.length ? `（不认识的证据种类：${unknown.join('、')}，可选值见 EVIDENCE_KINDS）` : '';
  return {
    ...verdict,
    status: 'partial',
    reason: `${why}${hint}：凭代码、纯函数或文档的结论最多判 partial，要 pass 须补界面、DOM、截图、截获端、命令输出等外部可观察证据`,
  };
}
