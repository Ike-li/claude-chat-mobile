// logic/bg-tasks.js —— 后台任务列表/详情/停止态 · spinner 与 live 等待 · CLI 时长与重试行
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t } from '../i18n.js';

// 后台任务停止按钮态：有非空 taskId 且横幅可见才可点（对齐 SDK stopTask(taskId)）。
// 合成任务 id：SDK 侧不存在这个 id，任何「停止」都必然静默失败，展示上也不该露出内部命名空间。
// 两类来源：
//   __notask_*  —— agent.js 在 SDK 未给 task_id 时的占位；
//   localcmd:*  —— 本地 slash 命令期间从磁盘 subagents/ 观察出来的子代理（agent.js
//                  LOCAL_CMD_TASK_PREFIX），它们是 CLI fork 上下文里的进程。
// 【为什么抽出来】这是个「协议字段」性质的判断，消费者有停止策略、行标题回落、meta shortId 三处。
// 2026-08-05 第一轮只改了停止策略一处，另两处继续泄漏 `#localcmd:a`（真机截图可见）——
// 合成键必须扫全部消费者，不能靠单个 helper 自觉。
// 前缀字面量前后端各写一份：边界规则禁止 public/js 引用 src/，改一处必须改另一处。
export function isSyntheticTaskId(taskId) {
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  return id.startsWith('__notask_') || id.startsWith('localcmd:');
}

export function taskStopUiState({ taskId, bannerVisible = true } = {}) {
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  // 合成键（agent.js 在 SDK 未给 task_id 时用 `__notask_${taskType}` 占位）不是真实 taskId：
  // 它在 SDK 侧根本不存在，q.stopTask('__notask_local_agent') 必然静默失败，而 UI 仍会打一条
  // 「已请求停止…」，任务行挂到 BG_TASK_ORPHAN_TTL_MS(3min) 才消失。同文件的行标签渲染早就知道要排除
  // 这个前缀（task-status.js 里 `!taskId.startsWith('__notask_')` 才显示 #shortId），停止按钮漏了。
  const synthetic = isSyntheticTaskId(id);
  return { canStop: Boolean(id) && !synthetic && bannerVisible !== false, taskId: synthetic ? null : (id || null) };
}

// 后台任务列表是否折叠：默认单任务展开（不挡内容）、多任务收起（避免堆满屏挡聊天内容）；
// 用户手动展开/收起后一律遵从用户选择，直至横幅整体撤下重置。
// 用户表态对单任务同样生效——折叠热区是整条横幅头行，任何任务数下点了都必须有反应，否则是死点击。
export function bgTaskListCollapsed({ count = 0, userExpanded = null } = {}) {
  if (count <= 0) return false; // 无任务：列表整体不存在，值不生效但保持确定性
  if (userExpanded === true) return false;
  if (userExpanded === false) return true;
  return count > 1;
}

// 后台任务详情面板：进度历史条目格式化。
// description = 工具态即时更新（如 "Running tests..."），summary = AI ~30s 进度摘要。
// 两者择一显示（summary 优先，因更语义化；description 兜底）。
export function formatProgressHistoryEntry({ ts, description, lastToolName, summary } = {}) {
  const time = typeof ts === 'number' ? formatProgressTimestamp(ts) : '';
  const text = (typeof summary === 'string' && summary.trim())
    || (typeof description === 'string' && description.trim())
    || '';
  const prefix = lastToolName ? `${lastToolName} · ` : '';
  return { time, text: prefix + text, hasSummary: Boolean(summary?.trim()) };
}

// 进度时间戳：5 分钟内显示相对时间（如 "30s前"、"2m前"），超过显示 HH:MM:SS。
export function formatProgressTimestamp(ts) {
  const diff = Date.now() - ts;
  if (diff < 0) return '0s';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 300000) return `${Math.floor(diff / 60000)}m`;
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// 后台任务详情面板状态：当前 taskId 与 activeDetailId 匹配时展开。
export function taskDetailState({ taskId, activeDetailId } = {}) {
  if (!taskId || !activeDetailId) return { visible: false };
  return { visible: taskId === activeDetailId };
}

// CLI 式 spinner 动词表：逐字提取自本机 claude CLI bundle（2.1.211）的本地词表，保终端等价性。
export const SPINNER_VERBS = Object.freeze(['Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking', 'Beaming', "Beboppin'", 'Befuddling', 'Billowing', 'Blanching', 'Bloviating', 'Boogieing', 'Boondoggling', 'Booping', 'Bootstrapping', 'Brewing', 'Bunning', 'Burrowing', 'Calculating', 'Canoodling', 'Caramelizing', 'Cascading', 'Catapulting', 'Cerebrating', 'Channeling', 'Channelling', 'Choreographing', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Combobulating', 'Composing', 'Computing', 'Concocting', 'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Crystallizing', 'Cultivating', 'Deciphering', 'Deliberating', 'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing', 'Doodling', 'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing', 'Enchanting', 'Envisioning', 'Fermenting', 'Fiddle-faddling', 'Finagling', 'Flambéing', 'Flibbertigibbeting', 'Flowing', 'Flummoxing', 'Fluttering', 'Forging', 'Forming', 'Frolicking', 'Frosting', 'Gallivanting', 'Galloping', 'Garnishing', 'Generating', 'Gesticulating', 'Germinating', 'Gitifying', 'Grooving', 'Gusting', 'Harmonizing', 'Hashing', 'Hatching', 'Herding', 'Honking', 'Hullaballooing', 'Hyperspacing', 'Ideating', 'Imagining', 'Improvising', 'Incubating', 'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning', 'Kneading', 'Leavening', 'Levitating', 'Lollygagging', 'Manifesting', 'Marinating', 'Meandering', 'Metamorphosing', 'Misting', 'Moonwalking', 'Moseying', 'Mulling', 'Mustering', 'Musing', 'Nebulizing', 'Nesting', 'Newspapering', 'Noodling', 'Nucleating', 'Orbiting', 'Orchestrating', 'Osmosing', 'Perambulating', 'Percolating', 'Perusing', 'Philosophising', 'Photosynthesizing', 'Pollinating', 'Pondering', 'Pontificating', 'Pouncing', 'Precipitating', 'Prestidigitating', 'Processing', 'Proofing', 'Propagating', 'Puttering', 'Puzzling', 'Quantumizing', 'Razzle-dazzling', 'Razzmatazzing', 'Recombobulating', 'Reticulating', 'Roosting', 'Ruminating', 'Sautéing', 'Scampering', 'Schlepping', 'Scurrying', 'Seasoning', 'Shenaniganing', 'Shimmying', 'Simmering', 'Skedaddling', 'Sketching', 'Slithering', 'Smooshing', 'Sock-hopping', 'Spelunking', 'Spinning', 'Sprouting', 'Stewing', 'Sublimating', 'Swirling', 'Swooping', 'Symbioting', 'Synthesizing', 'Tempering', 'Thinking', 'Thundering', 'Tinkering', 'Tomfoolering', 'Topsy-turvying', 'Transfiguring', 'Transmuting', 'Twisting', 'Undulating', 'Unfurling', 'Unravelling', 'Vibing', 'Waddling', 'Wandering', 'Warping', 'Whatchamacalliting', 'Whirlpooling', 'Whirring', 'Whisking', 'Wibbling', 'Working', 'Wrangling', 'Zesting', 'Zigzagging']);

export function pickSpinnerVerb(rand = Math.random) {
  return SPINNER_VERBS[Math.floor(rand() * SPINNER_VERBS.length)] || 'Working';
}

// 回合收尾行过去式动词表（8 词，逐字取自 CLI 2.1.211 bundle 的 turn_duration 词表 $6s，兜底 "Worked"）。
// 与活 spinner 的 SPINNER_VERBS 是两套独立词表——CLI 亦如此：spinner 用现在分词、收尾行用过去式。
export const TURN_DONE_VERBS = Object.freeze(['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked']);

export function pickTurnDoneVerb(rand = Math.random) {
  return TURN_DONE_VERBS[Math.floor(rand() * TURN_DONE_VERBS.length)] || 'Worked';
}

// 回合收尾行时长格式：移植 CLI Hs（turn_duration 分支，不含 hideTrailingZeros/mostSignificantOnly）。
// <60s → "8s"（整秒下取整）；更长 "2m 49s" / "1h 2m 3s" / "1d 2h 3m"（秒四舍五入，逢 60 逐位进位；天级不带秒）。
// 负数/非有限值 → "0s"（turn 时长恒为整数 ms≥0，防御性归零；亚毫秒不可达故不还原 CLI 的 "0.0s" 分支）。
export function formatCliDuration(ms) {
  const e = Number(ms);
  if (!Number.isFinite(e) || e <= 0) return '0s';
  if (e < 60000) return `${Math.floor(e / 1000)}s`;
  let d = Math.floor(e / 86400000);
  let h = Math.floor((e % 86400000) / 3600000);
  let m = Math.floor((e % 3600000) / 60000);
  let s = Math.round((e % 60000) / 1000);
  if (s === 60) { s = 0; m++; }
  if (m === 60) { m = 0; h++; }
  if (h === 24) { h = 0; d++; }
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// 距上次 agent:event 的安静期提示阈值（秒）。纯前端文案层心理预期管理，
// 与服务端 agent.js idleTimeoutMs（默认 10 分钟）完全独立，不共享常量、不改服务端判定。
export const LIVE_STALE_HINT_SEC = 20; // ≥20s 无事件 → 追加「仍在等待响应」
export const LIVE_STALE_WARN_SEC = 60; // ≥60s 无事件 → 追加更明确的慢响应提示（两级互斥，不叠加）

// 三阶段等待判定：sendInFlight 优先（发送 ack 前）→ 已见 content delta → responding，否则 waiting。
// waiting/responding 当前共用 formatCliSpinnerLine；安静太久自然衔接到 stale 提示，不另发明文案。
export function resolveLiveWaitPhase({ sendInFlight = false, sawContentDelta = false } = {}) {
  if (sendInFlight) return 'sending';
  return sawContentDelta ? 'responding' : 'waiting';
}

// CLI 式动态状态行组装：✻ Stewing… (55s · ↓ 3.3k tokens · thought for 1s)
// thinking = null | { state: 'active'|'done', ms }；outTokens 空/0 省段。
// sinceLastEventSec：null=不适用（断线等）不追加；≥hint/warn 追加安静期提示。
// 对齐 CLI 不挂工具后缀段——正在执行的命令由消息流里的工具卡显示，此行只保动词+秒表+tokens+thinking。
export function formatCliSpinnerLine({
  verb = '',
  elapsedSec = 0,
  outTokens = null,
  thinking = null,
  effort = null,
  glyph = '✻',
  sinceLastEventSec = null,
} = {}) {
  const v = String(verb || '').trim() || 'Working';
  // 秒表行 token 带 1 位小数；≥1000.0k 抬 m（对齐 statuslineFmtTok 边界）
  const fmtTok = n => {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
    if (n >= 1e3) {
      const k = n / 1e3;
      if (k >= 1000) return `${(k / 1000).toFixed(1)}m`;
      return `${k.toFixed(1)}k`;
    }
    return String(n);
  };
  const segs = [`${Math.max(0, Math.floor(Number(elapsedSec) || 0))}s`];
  if (Number.isFinite(outTokens) && outTokens > 0) segs.push(`↓ ${fmtTok(outTokens)} tokens`);
  if (thinking?.state === 'active') {
    segs.push(effort ? `thinking with ${effort} effort` : 'thinking…');
  } else if (thinking?.state === 'done') {
    segs.push(`thought for ${Math.max(1, Math.round((thinking.ms || 0) / 1000))}s`);
  }
  if (Number.isFinite(sinceLastEventSec)) {
    if (sinceLastEventSec >= LIVE_STALE_WARN_SEC) segs.push(t('响应较慢，可能是深度思考或网络问题'));
    else if (sinceLastEventSec >= LIVE_STALE_HINT_SEC) segs.push(t('仍在等待响应'));
  }
  return `${glyph} ${v}… (${segs.join(' · ')})`;
}

// CLI 式 API 重试行：✻ API 错误 503 · 4s 后重试 · 第 2/10 次
// 整行顶替 spinner——CLI 亦如此（retryStatus ? 重试行 : spinner 行 的二选一，而非往括号里加段；
// CLI spinner 括号只有 suffix/elapsed/tokens/thinking 四个槽，没有错误位）。
// errorStatus 为 null 是真实高频形态（连接超时无 HTTP 响应，见 sdk.d.ts SDKAPIRetryMessage 注释），
// 走「等待 API 响应 … 检查网络」分支，对齐 CLI 的 stalled 文案，绝不显示 undefined。
// 边界：SDK 的 api_retry payload 只给状态码 + 错误枚举，没有上游报文原文；原文只能等重试耗尽后的
// 终态 error 事件（agent.js 从 assistant.error 的 message.content 透传）。此行不伪造原文。
export function formatCliRetryLine({
  attempt = null,
  maxRetries = null,
  remainingSec = null,
  errorStatus = null,
  glyph = '✻',
} = {}) {
  const status = Number(errorStatus);
  const hasStatus = Number.isFinite(status) && status > 0;
  const head = hasStatus ? `${t('API 错误')} ${status}` : t('等待 API 响应');
  const segs = [];
  // null/undefined 表示「没有倒计时数据」→ 省略段；0 是真实状态（马上重试）→ 照显
  const rs = remainingSec === null || remainingSec === undefined || remainingSec === '' ? NaN : Number(remainingSec);
  if (Number.isFinite(rs)) segs.push(t('Ns 后重试').replace('N', String(Math.max(0, Math.floor(rs)))));
  const a = Number(attempt);
  const m = Number(maxRetries);
  const hasAttempt = Number.isFinite(a) && a > 0;
  const hasMax = Number.isFinite(m) && m > 0;
  if (hasAttempt && hasMax) segs.push(t('第 A/B 次').replace('A', String(a)).replace('B', String(m)));
  else if (hasAttempt) segs.push(t('第 N 次').replace('N', String(a)));
  if (!hasStatus) segs.push(t('检查网络'));
  return segs.length ? `${glyph} ${head} · ${segs.join(' · ')}` : `${glyph} ${head}`;
}

// thinking 秒数 burst 累计：delta 间隔 ≤ gapMs 计入时长，超 gap 视为新 burst 不补空档；首帧只记 lastTs。
export function advanceThinkingClock({ ms = 0, lastTs = 0 } = {}, nowTs, gapMs = 2000) {
  const now = Number(nowTs) || 0;
  const prev = Number(lastTs) || 0;
  const delta = prev > 0 ? now - prev : 0;
  return { ms: (Number(ms) || 0) + (delta > 0 && delta <= gapMs ? delta : 0), lastTs: now };
}
