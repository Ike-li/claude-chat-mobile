// resume-anchor.js —— 预测 CLI `--resume` 会从哪条链接上，判「最新那段对话会不会被丢出模型上下文」。
//
// 【为什么要预测】transcript 是一棵树。两个活进程写同一个会话时（电脑上开着的终端 + 手机这边的 SDK 进程），
// 各自挂在自己内存里的叶子下面写，树就分了叉。CLI resume 只接其中一支，另一支整段不进模型上下文，
// 而回显（history.js 的选叶保护）照样把它画出来——用户看得见，模型却不知道。产品自己的 resume
// （懒开、切会话、规则 5 置换、切 effort、空闲回收后续聊）走的是同一个加载器。
//
// 【CLI 的选叶规则】2.1.281 / 2.1.283 / 2.1.284 / 2.1.301 实测一致（2026-10-15/16，零 token：真 SDK 进程 +
// 真交互式终端；2.1.284 加载器静态核对）：
//   Kn = 物理上最后一条带 leafUuid 的 last-prompt 行的 leafUuid
//   In = 物理上最后一条非 sidechain 的 user / assistant / system / attachment 行
//   有 Kn、且 Kn 既不是 In 也不是 In 的祖先 → 锚 Kn；否则锚 In。
// last-prompt 由每个 CLI 进程重贴成「它自己最后写的那行」：2.1.284 在退出、resume 后、写入过阈值时贴，
// 2.1.301 起每轮结束也贴。所以谁最后重贴谁说了算——开着的旧终端只要在旧叶子下写过一行（离开摘要、
// Remote Control 断开提示、本地命令），之后它一退出，所有 resume 都接回终端那一支。
// 证据与对照表见 docs/architecture.md「续接锚点」。规则不是公开契约；CLI 改了它，这里要跟着改。
//
// 判定部分是纯函数；末尾的 readResumeEntries 是喂给它的那一勺 IO（同 rewind-plan.js 的做法）。

import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { CLAUDE_PROJECTS_DIR } from '../shared/claude-home.js';
import { openRegularFile } from '../shared/regular-file.js';
import { getProjectDir, isSafeSessionId } from './history.js';

const MESSAGE_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);

function isMessage(e) {
  return Boolean(e && typeof e === 'object' && typeof e.uuid === 'string' && e.uuid && MESSAGE_TYPES.has(e.type));
}

// 压缩边界那一行 parentUuid 为 null，接续写在 logicalParentUuid 上（CLI 写入时 `parentUuid: isBoundary ? null : …,
// logicalParentUuid: isBoundary ? prev : undefined`）。不跟着它走，压缩后、下一条消息之前的会话会被误判成丢了全部历史。
function parentOf(e) {
  return e.parentUuid || e.logicalParentUuid || null;
}

function indexMessages(entries) {
  const byUuid = new Map();
  for (const e of entries) {
    if (isMessage(e) && !byUuid.has(e.uuid)) byUuid.set(e.uuid, e);
  }
  return byUuid;
}

// uuid 自己 + 它的全部祖先。坏数据里父链可能成环，seen 兜住。
function lineage(byUuid, uuid) {
  const out = new Set();
  let cur = byUuid.get(uuid);
  while (cur && !out.has(cur.uuid)) {
    out.add(cur.uuid);
    const p = parentOf(cur);
    cur = p ? byUuid.get(p) : null;
  }
  return out;
}

// 从 uuid 往上走到 stop 集合（另一支的祖先链）为止，沿途的对话消息条数。
function countUntil(byUuid, uuid, stop) {
  let n = 0;
  const seen = new Set();
  for (let cur = byUuid.get(uuid); cur && !stop.has(cur.uuid) && !seen.has(cur.uuid);) {
    seen.add(cur.uuid);
    if (isConversationMessage(cur)) n++;
    const p = parentOf(cur);
    cur = p ? byUuid.get(p) : null;
  }
  return n;
}

// 终端本地命令与 `!` bash 模式的回显：落盘是 type:user，除 caveat 那行外都【不带】isMeta
// （2.1.284 真交互式终端 /export 实测三行：caveat isMeta:true，<command-name> 与 <local-command-stdout> 都没有）。
// 它们不是对话，挂在旧叶子下也不该被当成「最新那段对话」。
const COMMAND_ECHO_RE = /^<(command-name|command-message|command-args|local-command-[a-z]+|bash-(input|stdout|stderr))>/;

// 「对话消息」= 用户/模型真说的话（含工具往返）。meta、sidechain、teamName（SDK 选叶本就跳过它，口径同 #208）、
// 命令回显都不算。
function isConversationMessage(e) {
  if (!isMessage(e) || e.isSidechain || e.isMeta || e.teamName) return false;
  if (e.type === 'assistant') return true;
  if (e.type !== 'user') return false;
  const content = e.message?.content;
  if (typeof content === 'string') return !COMMAND_ECHO_RE.test(content.trim());
  return true;
}

/**
 * CLI 这次 resume 会锚在哪一条上（按上面的基础规则）。
 * @returns {{anchorUuid: string|null, via: 'last-prompt'|'last-message'|null, explicit: boolean}}
 *   explicit = 最后那条 last-prompt 带 explicit:true——/rewind 等用户刻意选分支时 CLI 才这么写，进程退出时的
 *   自动重贴从不带。加载器对它有没有特殊待遇没有实测过，所以它不改变这里给的锚，只交给调用方当「别替用户改主意」的信号。
 */
export function predictResumeAnchor(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byUuid = indexMessages(list);
  let lastMsg = null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (isMessage(list[i]) && !list[i].isSidechain) { lastMsg = list[i]; break; }
  }
  if (!lastMsg) return { anchorUuid: null, via: null, explicit: false };
  let lastPrompt = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e && e.type === 'last-prompt' && typeof e.leafUuid === 'string' && e.leafUuid) { lastPrompt = e; break; }
  }
  // 指向文件里没有的 uuid（如 2.1.301 的全零哨兵）就当没有 Kn
  const kn = lastPrompt && byUuid.has(lastPrompt.leafUuid) ? lastPrompt : null;
  const explicit = kn?.explicit === true;
  if (kn && !lineage(byUuid, lastMsg.uuid).has(kn.leafUuid)) {
    return { anchorUuid: kn.leafUuid, via: 'last-prompt', explicit };
  }
  return { anchorUuid: lastMsg.uuid, via: 'last-message', explicit };
}

/**
 * 物理上最新的那条对话消息若不在 CLI 会接上的链上，返回会被丢掉的那段的描述；否则 null。
 * 最后那次重贴是 explicit 的（用户自己 /rewind 选的分支）不报。
 * @returns {null | {newestUuid, newestEntrypoint, newestAt, droppedCount, anchorOnlyCount, anchorEntrypoint, anchorAt}}
 *   droppedCount = 从最新那条往上数到与锚点链交汇为止的对话消息条数，即模型会看不到的那几条。
 *   anchorOnlyCount = 反过来从锚点往上数到与最新那条的祖先链交汇为止的对话消息条数，即「从最新那条分叉」会少掉的
 *   另一支。终端只在旧叶子下写过 system 行时是 0；终端真打过一轮（分叉）时两支各有对方没有的，两个数都 > 0。
 */
export function resumeDivergence(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const { anchorUuid, explicit } = predictResumeAnchor(list);
  if (!anchorUuid || explicit) return null;
  let newest = null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (isConversationMessage(list[i])) { newest = list[i]; break; }
  }
  if (!newest) return null;
  const byUuid = indexMessages(list);
  const chain = lineage(byUuid, anchorUuid);
  if (chain.has(newest.uuid)) return null;

  const droppedCount = countUntil(byUuid, newest.uuid, chain);
  const anchorOnlyCount = countUntil(byUuid, anchorUuid, lineage(byUuid, newest.uuid));
  // 会接上的那一轮：锚点往上最近的一条对话消息（锚常是 system 行或命令回显，它们说明不了是谁的那一轮）
  let anchorLeaf = null;
  const walked = new Set();
  for (let cur = byUuid.get(anchorUuid); cur && !walked.has(cur.uuid);) {
    walked.add(cur.uuid);
    if (isConversationMessage(cur)) { anchorLeaf = cur; break; }
    const p = parentOf(cur);
    cur = p ? byUuid.get(p) : null;
  }
  return {
    newestUuid: newest.uuid,
    newestEntrypoint: typeof newest.entrypoint === 'string' ? newest.entrypoint : null,
    newestAt: typeof newest.timestamp === 'string' ? newest.timestamp : null,
    droppedCount,
    anchorOnlyCount,
    anchorEntrypoint: typeof anchorLeaf?.entrypoint === 'string' ? anchorLeaf.entrypoint : null,
    anchorAt: typeof anchorLeaf?.timestamp === 'string' ? anchorLeaf.timestamp : null,
  };
}

// ── 发送闸（SESSION-04）──
// 实例 resume 时若算出了分叉结论，发送前先拒收、把结论交给前端出面板，由用户选「从最新那条分叉」或「仍然发送」。
// 确认要指明确认的是哪一段（最新那条的 uuid）：期间又续接了一次、结论换了的话，旧的确认不作数。
export const RESUME_DIVERGENT = 'resume_divergent';

const SIDE_LABEL = { 'sdk-ts': '手机', cli: '终端', 'claude-desktop': '桌面端' };
const sideOf = entrypoint => SIDE_LABEL[entrypoint] || '别处';

/**
 * @param {object|null} divergence  实例上的分叉结论（resumeDivergence 的返回）
 * @param {unknown} ackDivergence   客户端带来的确认：用户在面板上选「仍然发送」时那段的 newestUuid
 * @returns {{action:'send', clear:boolean} | {action:'reject', ack:object}}
 */
export function gateResumeDivergence(divergence, ackDivergence) {
  if (!divergence) return { action: 'send', clear: false };
  if (typeof ackDivergence === 'string' && ackDivergence && ackDivergence === divergence.newestUuid) {
    return { action: 'send', clear: true };
  }
  return {
    action: 'reject',
    ack: {
      ok: false,
      reason: RESUME_DIVERGENT,
      // 不认 reason 的旧前端（缓存的旧 PWA）只能靠它停手：没有它，retryable 的缺省推断会把这条塞进 outbox
      // 反复重发，每次都撞同一道闸。新前端先认 reason，不走 permanent 那一支。
      permanent: true,
      error: `续接会丢掉一段对话：模型会从${sideOf(divergence.anchorEntrypoint)}那一轮接上，${sideOf(divergence.newestEntrypoint)}上最近 ${divergence.droppedCount} 条消息不在它的上下文里。刷新页面后重发，可以选择怎么续。`,
      divergence: { ...divergence },
    },
  };
}

// ── 以下是本模块唯一的 IO ──

// 判定只用到这几个字段。用户消息正文只留开头——够认命令回显（COMMAND_ECHO_RE 锚在开头），
// 又不把整段对话常驻内存：resume 每次切会话都要读，会话可以长到数十 MB。
const ECHO_PREFIX_CHARS = 64;
function slimEntry(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.type === 'last-prompt') {
    return typeof e.leafUuid === 'string' && e.leafUuid ? { type: 'last-prompt', leafUuid: e.leafUuid, explicit: e.explicit === true } : null;
  }
  if (!isMessage(e)) return null;
  const out = { type: e.type, uuid: e.uuid, parentUuid: typeof e.parentUuid === 'string' ? e.parentUuid : null };
  if (typeof e.logicalParentUuid === 'string' && e.logicalParentUuid) out.logicalParentUuid = e.logicalParentUuid;
  if (e.isSidechain) out.isSidechain = true;
  if (e.isMeta) out.isMeta = true;
  if (e.teamName) out.teamName = e.teamName;
  if (typeof e.entrypoint === 'string') out.entrypoint = e.entrypoint;
  if (typeof e.timestamp === 'string') out.timestamp = e.timestamp;
  if (e.type === 'user') {
    const content = e.message?.content;
    out.message = { content: typeof content === 'string' ? content.trimStart().slice(0, ECHO_PREFIX_CHARS) : [] };
  }
  return out;
}

/**
 * 读某个会话 transcript 里判定要用的条目（按落盘顺序、精简过）。逐行流式读，不一次性 buffer。
 * 失败一律返回空数组（不抛）：调用方拿空数组判出「没有可报的」，等于改动前的行为（fail-open）——
 * 这道闸挡的是静默丢上下文，读不动时多拦一次反而会把用户堵在一个说不清的面板前。
 * 不是普通文件（FIFO 等）同属读失败，见 shared/regular-file.js。
 */
export async function readResumeEntries(cwd, sessionId, { baseDir = CLAUDE_PROJECTS_DIR } = {}) {
  if (!isSafeSessionId(sessionId)) return []; // SS-003：非法 id 不拼进 join
  let input = null;
  try {
    input = (await openRegularFile(join(baseDir, getProjectDir(cwd), `${sessionId}.jsonl`))).fh.createReadStream({ encoding: 'utf-8' });
    const rl = createInterface({ input, crlfDelay: Infinity });
    const out = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; } // 写到一半的尾行
      const slim = slimEntry(e);
      if (slim) out.push(slim);
    }
    return out;
  } catch {
    return [];
  } finally {
    input?.destroy();
  }
}
