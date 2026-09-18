// 文件轴 Rewind 的计划：给定「要丢弃的那一轮」，算出对话轴该从哪里分叉。
//
// 判定部分（planRewind / describeRewindBlocker / rewindLockDecision / rewindOutcomeVerdict）
// 是纯函数；末尾的 readSessionEntries 是喂给它的那一勺 IO——放在同一文件是因为它只服务于本模块，
// 且读的就是 planRewind 需要的那个形态（原始 jsonl 条目，非 history.js 展平后的气泡结构）。
//
// 【为什么是 fork 而不是原地截断】(2026-09-10 定，对齐 Claude Desktop 1.49585.0 的实际做法)
// SDK 提供两条路：
//   ① 原地截断：resume 时带 resumeSessionAt + resumeDropsTurn，原会话被改写。
//      CLI 会校验「丢弃区间是否只含目标轮」，不满足就确定性拒绝（不可重试）。
//   ② fork：forkSession(sessionId, {upToMessageId}) 离线复制 transcript 到新会话，原会话不动。
//
// 本仓选 ②。判据是【失败后果是否可逆】：①的丢弃是永久的，一旦「丢弃区间是否干净」这个判断
// 出错——而「我没见过的条目形态」本身无法穷举——用户的对话就没了；②里原会话一个字节没动，
// 判错了最多是新会话少了点东西，用户随时能回原会话。
//
// 实测佐证：Desktop 在同一个问题上做了同样的权衡，且它比本仓更有条件承受①的风险
// （它有 cliSessionId / sessionId 两层身份，fork 对用户不可见），却仍然选了 fork：
//   H.resume = cliSessionId; H.resumeSessionAt = pendingRewindTo; H.forkSession = true;
// 并且【全程不传 resumeDropsTurn】——因为不改写原会话，那道校验就不必要。
//
// 代价：会话 id 会变（本仓的会话身份就是 CLI 的 sessionId，没有 Desktop 那层映射）。
// 用户看到的是「回退后进入一个新会话」，与既有的 session:fork 同款，不是新概念。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_PROJECTS_DIR } from '../shared/claude-home.js';
import { getProjectDir, isSafeSessionId, splitAttachmentBlock } from './history.js';

// forkSession / resumeSessionAt 真正认得的 entry 类型。逆向 SDK 的 transcript 读取器
// （Desktop 1.52386.6 内嵌的那份）得到的白名单原文：
//   (t==="user"||t==="assistant"||t==="progress"||t==="system"||t==="attachment")
//   && typeof e.uuid==="string"
// 【为什么不能只判「有 uuid」】每次 fork 都会在 transcript 末尾追加一条
//   {type:"custom-title", uuid: randomUUID(), customTitle:"… (fork)"}
// ——带 uuid，却不在上面这张表里。只判 uuid 就会把它当成合法锚点，而 forkSession 的
// findIndex 在过滤后的数组里找不到它，抛 `Message … not found`。症状是
// 「在一个已分叉的会话里再分叉」确定性失败（PR #88 review P1）。
const FORKABLE_ENTRY_TYPES = new Set(['user', 'assistant', 'progress', 'system', 'attachment']);

/** 一条 entry 是否可作为 forkSession/resumeSessionAt 的锚点：类型在白名单内且带 uuid。 */
function isChainEntry(e) {
  return !!(e && typeof e.uuid === 'string' && e.uuid && FORKABLE_ENTRY_TYPES.has(e.type));
}

/**
 * 取回那一轮用户说的原话，供回退后回填输入框（edit-and-retry）。
 *
 * 【为什么要做】回退的语义是「回到我说这句话之前」，下一步多半就是把这句改一改重说。
 * Claude Desktop 的 rewindSession 同样返回 prefill，SDK 的 d.ts 也点名了这个用途。
 *
 * 四种真实形态（30 个会话实测）各自的处置：
 *   · content 是字符串        → 原样
 *   · [{type:'text'}]         → 拼接（最常见）
 *   · [{type:'image'},{text}] → 只取文字；image 块的 base64 拼进去会灌爆输入框
 *   · [{type:'tool_result'}]  → 空串。它也是 type:'user'，但不是人打的字
 *
 * 末尾再剥一次 CCM 自己追加的「[附件]」清单——那是发送时拼上去的，不是用户输入的内容。
 */
export function extractPromptText(entry) {
  const content = entry?.message?.content;
  let raw = '';
  if (typeof content === 'string') raw = content;
  else if (Array.isArray(content)) {
    raw = content
      .filter(b => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('');
  }
  if (!raw) return '';
  return splitAttachmentBlock(raw).text.trimEnd();
}

/**
 * 算出「回退到 promptUuid 那一轮之前」需要的分叉锚点。
 *
 * @param {Array<object>} entries  transcript 全量条目（原始 jsonl 行解析后的对象，按落盘顺序）
 * @param {string} promptUuid      要回退那一轮的人类 prompt 自身 uuid（= rewindFiles 的参数）
 * @returns {{ok: true, keepUuid: string} | {ok: false, reason: string}}
 *
 * `keepUuid` 交给 forkSession 的 upToMessageId（inclusive slice），即「新会话保留到这条为止」。
 *
 * 失败方向一律【拒绝】：算不出就不做。这里的拒绝很便宜——用户还在原会话里，什么都没变。
 */
export function planRewind(entries, promptUuid) {
  if (!Array.isArray(entries) || !promptUuid) return { ok: false, reason: 'bad-input' };

  const at = entries.findIndex(e => e && e.uuid === promptUuid);
  if (at < 0) return { ok: false, reason: 'prompt-not-found' };

  // K = 目标轮之前最后一条 chain entry。取「最后一条」而不是「最后一条 assistant」：
  // 被中断（Esc）且完成过工具的轮次尾部是 tool_result，它同样是保留轮自己的内容，
  // 锚在更早的 assistant 上会把它一起丢掉。
  let keepUuid = null;
  for (let i = at - 1; i >= 0; i--) {
    if (isChainEntry(entries[i])) { keepUuid = entries[i].uuid; break; }
  }
  // 目标轮就是会话第一轮：其前面没有可保留的锚点，分叉退化成「复制一个空会话」，不做。
  // 与 Desktop 同款判断（它的措辞是 "has assistant-less history before it; declining rather than clearing"）。
  if (!keepUuid) return { ok: false, reason: 'first-turn' };

  return { ok: true, keepUuid };
}

/**
 * 这条 entry 是不是「人开的新一轮」。tool_result 也是 type:'user'，得排掉它。
 *
 * 【判据是「不是 tool_result」而不是「有 text 块」】SDKUserMessage 契约允许 image / document
 * 内容，纯图片的那一轮里一个 text 块都没有。按「有 text 块」判会把它当成同轮延续跨过去，
 * 于是保留方向多吞一整轮——用户选的是 A，分出来的却含 A 之后那一轮（PR #88 review P2）。
 * 与 extractPromptText 的取舍不同是有意的：那个函数要的是「拿得出文字来回填输入框」，
 * 这里要的是「这一轮从哪结束」，两个问题的答案本来就不一样。
 */
function isHumanPrompt(e) {
  if (!e || e.type !== 'user') return false;
  const c = e?.message?.content;
  if (typeof c === 'string') return true;
  if (!Array.isArray(c)) return false;
  return c.some(b => b && typeof b === 'object' && b.type !== 'tool_result');
}

/**
 * 算出分叉的 upToMessageId。planRewind 的一般化：多回答一个「保留 anchor 所在轮」的方向。
 *
 * @param {Array<object>} entries      transcript 全量条目（原始 jsonl 行，按落盘顺序）
 * @param {string} anchorUuid          用户点的那条气泡自己的 uuid
 * @param {{keepAnchorTurn: boolean}} opts
 *        keepAnchorTurn=true  长按 assistant 气泡「从这里分叉」→ 保留 anchor 所在轮
 *        keepAnchorTurn=false 长按 user 气泡「丢弃这条及之后」→ 丢弃 anchor 所在轮（= planRewind）
 * @returns {{ok: true, keepUuid: string} | {ok: false, reason: string}}
 *
 * 【为什么不能让前端拿「最后一条 assistant 气泡」当锚】SDK 的通用规则是
 * "fork at the KEPT turn's last chain entry, whatever it is"，而 forkSession 的切片是
 * 纯 inclusive slice、零修正——锚点给早了它照切，保留轮尾部的 tool_result 被丢进弃置区间，
 * 对应的 tool_use 就悬空了。工具卡在前端 DOM 里没有 uuid（history.js 只给文本类挂），
 * 所以那个锚点【结构上】就看不见轮次的尾巴，只能由服务端对着 transcript 算。
 */
export function planFork(entries, anchorUuid, { keepAnchorTurn } = {}) {
  if (!Array.isArray(entries) || !anchorUuid) return { ok: false, reason: 'bad-input' };
  const at = entries.findIndex(e => e && e.uuid === anchorUuid);
  if (at < 0) return { ok: false, reason: 'anchor-not-found' };

  // 丢弃方向与 planRewind 是同一个问题，直接委派——两条路径对同一个问题必须同一个答案。
  if (!keepAnchorTurn) return planRewind(entries, anchorUuid);

  // 保留方向：从 anchor 往后走到下一条人类 prompt 之前，取沿途最后一条 chain entry。
  let keepUuid = null;
  for (let i = at; i < entries.length; i++) {
    if (i > at && isHumanPrompt(entries[i])) break;
    if (isChainEntry(entries[i])) keepUuid = entries[i].uuid;
  }
  return keepUuid ? { ok: true, keepUuid } : { ok: false, reason: 'anchor-not-found' };
}

/**
 * 把 planRewind 的失败原因翻成给用户看的话。
 * 分档说明「是什么挡住的」而不是笼统报错——用户据此知道能不能改用分叉。
 */
export function describeRewindBlocker(plan) {
  if (!plan || plan.ok) return null;
  switch (plan.reason) {
    case 'first-turn':
      return '这是会话的第一轮，前面没有可回退到的位置。';
    case 'prompt-not-found':
    case 'bad-input':
    default:
      return '这一轮无法回退：无法确定回退位置。';
  }
}

// ── 以下是本模块唯一的 IO ──

/**
 * 读回某个会话 transcript 的【全量原始条目】，按落盘顺序。
 *
 * 【为什么不复用 getSessionHistory】那个函数产出的是给前端渲染用的展平结构
 * （`{role, content, timestamp, uuid}`，噪音已滤、工具卡已重建），而 planRewind 要判的恰恰是
 * 被它滤掉的那些行——task notification 正是「会导致 CLI 拒绝截断」的主角。用展平结构去判，
 * 挡路的条目已经不在数组里了，G10 会一路放行。
 *
 * 【为什么读全量而不是尾窗】目标轮可能在会话很早的位置，尾窗读不到它就会误判成 prompt-not-found。
 * transcript 通常几百 KB，一次读可接受；真成为瓶颈再谈增量。
 *
 * 失败一律返回空数组（不抛）：调用方拿空数组走 planRewind，必然得到 prompt-not-found ⇒ 拒绝。
 * 失败方向仍是拒绝，与 §5.2 的整体口径一致。
 */
export async function readSessionEntries(cwd, sessionId, { baseDir = CLAUDE_PROJECTS_DIR } = {}) {
  if (!isSafeSessionId(sessionId)) return []; // SS-003：非法 id 不拼进 join
  try {
    const file = join(baseDir, getProjectDir(cwd), `${sessionId}.jsonl`);
    const raw = await readFile(file, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      // 坏行跳过而不是整份失败：transcript 正被写入时尾行可能是半行，
      // 整份读失败会让回退在会话活跃时完全不可用——而那正是最想回退的时刻。
      try { out.push(JSON.parse(line)); } catch { /* 半行/截断尾行 */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * G3 的并发锁判定（纯函数，锁本体由调用方持有）。
 *
 * 【为什么锁不能挂在实例对象上】confirm 的第 3 步要 dispose 当前实例再用截断选项重新 resume，
 * 实例对象会被【置换】。锁挂在 inst 上的话，解锁时 inst 已不是加锁时那个对象——锁既失效又泄漏。
 * 所以键取 sessionId：它跨越实例置换仍然稳定。
 *
 * TTL 自愈：回退中途进程崩掉会留下一把永远解不开的锁，把该会话的回退功能钉死。
 * 30s 宽于任何正常回退（实测 dryRun+真跑合计 < 1s），窄于用户的重试耐心。
 */
export function rewindLockDecision({ existing = null, now = Date.now(), ttlMs = 30_000 } = {}) {
  if (!existing) return 'acquire';
  if (!(now - existing.startedAt < ttlMs)) return 'acquire-stale'; // 含 NaN/负数：一律视为可夺取
  return 'reject';
}

/**
 * G6：回滚后核对，不信 `canRewind`。
 *
 * 【为什么必须自己核】SDK 契约原文：非软链接的 per-file 失败（例如备份文件丢失）
 * 【既不计入 skippedLinks 也不抛错】，只有「所有有差异的文件全部恢复失败」时才 canRewind:false。
 * 于是「部分文件没恢复」这一档会返回成功——用户看到绿色的「回退成功」，而代码只回退了一半。
 *
 * 【探针为什么是「再 dryRun 一次」而不是查文件存在性】CCM 手里没有快照内容，无法独立判断
 * 某个文件的内容对不对；而「文件不存在」也可能是【正确结果】——回退到该文件尚未被创建的那一刻，
 * 本就该删掉它，按存在性判会把正确的删除报成失败。
 * 但 CLI 自己知道：若真的恢复到位，再跑一次 dryRun 应当「无事可做」（filesChanged 为空）。
 * 拿它当探针，判据借的是 CLI 自己的比对能力，不需要 CCM 复制一份。
 *
 * @param {object} recheck  回滚后再跑一次 `rewindFiles(P, {dryRun:true})` 的返回
 * @returns {{ok: boolean, unrestored: string[]}}
 */
export function rewindOutcomeVerdict(recheck) {
  const stillChanged = Array.isArray(recheck?.filesChanged) ? recheck.filesChanged : [];
  // recheck 本身失败（抛错→调用方传 null）时保守判失败：宁可让用户去 git 面板核一眼，
  // 也不要在没核过的情况下报「已全部恢复」。
  if (!recheck) return { ok: false, unrestored: [] };
  return { ok: stillChanged.length === 0, unrestored: stillChanged };
}

/**
 * 回退并发锁的持有者（工厂 + 注入，状态不落 server 组装根的顶层作用域）。
 *
 * 键是 sessionId 而非实例 id —— 见 rewindLockDecision 的说明：confirm 中途会置换实例。
 */
export function createRewindLocks({ ttlMs = 30_000, now = () => Date.now() } = {}) {
  const locks = new Map();
  return {
    tryAcquire(sessionId) {
      const decision = rewindLockDecision({ existing: locks.get(sessionId), now: now(), ttlMs });
      if (decision === 'reject') return false;
      locks.set(sessionId, { startedAt: now() });
      return true;
    },
    release(sessionId) { locks.delete(sessionId); },
    held(sessionId) { return locks.has(sessionId); },
  };
}
