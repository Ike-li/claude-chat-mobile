// logic/connection.js —— RTT/连接横幅 · sync ack · 回放缓冲 · 滚动与未读锚点 · DOM 缓存计划
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t } from '../i18n.js';
import { formatUptime } from './format.js';

// 长会话切入分块渲染的推进数学：给定已处理条数/总数/块大小，算出这一块的结束位置与是否处理完。
// chunkSize<=0 防呆到至少推进 1 条，避免调用方传入非法值时死循环。
export function nextHistoryRenderChunk({ processed, total, chunkSize }) {
  const end = Math.min(processed + Math.max(1, chunkSize | 0), total);
  return { end, done: end >= total };
}

// 全量重载时，未确认乐观气泡该由哪条历史消息认领（否则 null）。
// clearView 保住的气泡 + 已入 transcript 的同一条会撞成两颗。
// 判据与 handle.user_message 的 matchedBubble 对齐；历史没有 clientMessageId，按内容从后往前认。
export function findHistoryClaimForPending({ text = '', attNames = '', messages = [] } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const wantText = String(text ?? '');
  const wantAtt = String(attNames ?? '');
  if (!wantText && !wantAtt) return null; // 既无文本又无附件：无从认领，宁可不认也不能瞎认
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // kind 非空 = tool_use / tool_result 等展开项，它们 role 也可能是 'user'，但不是用户气泡
    if (!m || m.role !== 'user' || m.kind) continue;
    if (typeof m.content !== 'string') continue;
    if (wantText) {
      if (m.content !== wantText) continue;
    } else {
      // 纯附件消息：历史侧正文为空（附件块已被 splitAttachmentBlock 剥成 attachments），只能按名字集合认
      if (m.content.trim()) continue;
      if (historyAttachmentNames(m) !== wantAtt) continue;
    }
    return { index: i, uuid: m.uuid ?? null };
  }
  return null;
}

// 与 buildPendingUserBubble 写进 data-att-names 的指纹算法必须逐字一致（排序后 \0 连接）。
function historyAttachmentNames(m) {
  return Array.isArray(m?.attachments)
    ? m.attachments.map(a => a?.name).filter(Boolean).sort().join('\0')
    : '';
}

// 移动端切前台/网络恢复/bfcache 恢复时的重连决策。要害：`socket.connected` 在「半开连接」下会撒谎——
// 切后台冻结 JS、TCP 未必断、engine.io 心跳计时被冻结尚未发现 server 失联，回前台瞬间它仍是 true。
// 故 connected 时不能直接判健康（否则白等 socket.io 心跳超时 ~45s 才被动重连 = 用户感受的「卡住」），
// 返回 'probe'：发一条带 timeout 的 sync:since 同时探活+补发；未连返回 'connect'：直接重连（connect handler 会 sync）。
export function foregroundReconnectAction(connected) {
  return connected ? 'probe' : 'connect';
}

// 握手被拒时给人看的话。吃 socket.io connect_error 的 { message, data }，返回 { kind, text }。
//
// 存在理由：服务端拒绝握手时只能给出机器可读的标识符（'unauthorized' / 'rate_limited'），
// 接线层此前把它原样拼进「连接失败：{message}」——屏幕上就是「连接失败：rate_limited」，
// 既看不懂也不知道要等多久，于是用户反复点重连，而每一次都只是撞在刚上的那把锁上。
//
// kind 与文案分开：'unauthorized' 归令牌门处理（它要弹输入框，不是显示一句话），
// 其余两类才由调用方拿 text 去刷状态行。
export function describeHandshakeError(err) {
  const message = String(err?.message ?? '');
  if (message === 'unauthorized') return { kind: 'unauthorized', text: t('需要访问令牌') };
  if (message !== 'rate_limited') {
    // 网络抖动之类：保留原始信息，它是排查时唯一的线索（对用户没意义，但比空白强）。
    return { kind: 'other', text: `${t('连接失败：')}${message || t('未知错误')}` };
  }
  // 秒数来自服务端的 retryAfterSeconds（authRejection 保证 ≥1）。旧服务端不带 data，此时只说结论。
  const secs = Number(err?.data?.retryAfterSeconds);
  if (!Number.isFinite(secs) || secs < 1) {
    return { kind: 'rate_limited', text: t('登录尝试过多，请稍后再试') };
  }
  // 分钟向上取整：15 分钟长锁说「900 秒」没人读得懂；而 61 秒说成「1 分钟」会让人早退回来又撞锁。
  return secs < 60
    ? { kind: 'rate_limited', text: t('登录尝试过多，请 {n} 秒后再试').replace('{n}', String(secs)) }
    : { kind: 'rate_limited', text: t('登录尝试过多，请 {n} 分钟后再试').replace('{n}', String(Math.ceil(secs / 60))) };
}

// ── 连接状态顶部横幅（页面级可见反馈）────────────────────────────────────────
// 存在理由：连通性的人话写给横幅。判定抽成纯函数，接线层
// （app/connection-banner.js）只负责按返回值刷 DOM。
//
// 四个阈值都是「延迟出现」而非「立即出现」：局域网秒连、手机切后台回来的瞬时断开都不该闪横幅。
// retry 严格晚于两个显示阈值，否则会出现「按钮先于横幅可见」的不可能态（单测钉住这条不变量）。
export const CONN_BANNER_CONNECTING_DELAY_MS = 800;    // 首连：超过才显示「连接中…」
export const CONN_BANNER_DISCONNECT_DELAY_MS = 1000;   // 断线：超过才显示「连接断开…」
export const CONN_BANNER_RETRY_DELAY_MS = 5000;        // 超过才露「立即重试」（短抖动靠自动重连）
export const CONN_BANNER_RECONNECTED_LINGER_MS = 1600; // 「已重新连接」绿条停留时长

// phase：'connecting'（从未连上过）| 'offline'（连上过又断了）| 'online'
// elapsedMs：当前 phase 已持续时长；suppressed：鉴权门/Access 重登门打开中（全屏页与横幅不能并存）
// wasVisible：进入 online 那一刻横幅是否可见——决定要不要给「已重新连接」，秒连不该闪绿条
// 返回 null（不显示）或 { tone, label, detail, spinner, retry }；label 是中文原文（key），接线层才 t()
export function resolveConnectionBanner({ phase, elapsedMs, suppressed = false, wasVisible = false } = {}) {
  if (suppressed) return null;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (phase === 'connecting') {
    if (elapsedMs < CONN_BANNER_CONNECTING_DELAY_MS) return null;
    // 首连不报「已断开 N 秒」：从没连上过，无「断开」可言
    return { tone: 'info', label: '连接中…', detail: '', spinner: true, retry: elapsedMs >= CONN_BANNER_RETRY_DELAY_MS };
  }
  if (phase === 'offline') {
    if (elapsedMs < CONN_BANNER_DISCONNECT_DELAY_MS) return null;
    return {
      tone: 'warn',
      label: '连接断开，自动重连中…',
      detail: `${t('已断开')} ${formatUptime(elapsedMs)}`,
      spinner: true,
      retry: elapsedMs >= CONN_BANNER_RETRY_DELAY_MS,
    };
  }
  if (phase === 'online') {
    if (!wasVisible || elapsedMs >= CONN_BANNER_RECONNECTED_LINGER_MS) return null;
    // 已经连上了，不该还转圈
    return { tone: 'success', label: '已重新连接', detail: '', spinner: false, retry: false };
  }
  return null;
}

// sync:since 的 ack 回调决策（probe 与普通 connect 路径共用）：
//   err（ack 超时/断线，probe 与 connect 补传两路都会有）→ 'reconnect'：判定半开死连接，强制 disconnect+connect 触发干净重连；
//   res.found===false（实例已 dispose/重启/effort 换 id 没了）→ 'reload'：清屏重载历史（connect 路径不先 clearView，
//     无法靠 replayed 自辨「实例没了」与「实例还在只是无新事件」，靠 found 区分）；
//   其余（有回放 / 无新事件 / 实例还在）→ 'none'：交给正常 agent:event 经 epoch/seq 去重增量渲染。
// connect 补传路径现同样带 timeout（F3/2026-08-06）：裸 ack 断线时被 _clearAcks() 丢弃，pending 快照
// 对账会永久缺失；err → 'reconnect' 干净重连是有意行为，不是误判。
export function syncAckAction(err, res, { seenDiskLen = 0, hasSessionId = true } = {}) {
  if (err) return 'reconnect';
  // 无 sessionId（CLI 未吐 init）：'reload' 会清屏后拿 session:history 换回「会话不存在」→ 白屏。
  // 同 shouldReloadOnEnter 的首条闸；息屏回前台 / 断网重连不经 bindView，只走这条路径，故两处都要有。
  if (!hasSessionId) return 'none';
  if (res && res.found === false) return 'reload';
  if (res && res.gap) return 'reload'; // 缓冲超窗、中间有缺口 → 清屏全量重载历史，否则残缺需手刷
  // 同会话重连/probe：活缓冲可能有回放，但 CLI 外部写盘只增 diskLen——必须比 seenDiskLen（G1）
  const diskLen = res && Number.isFinite(res.diskLen) ? res.diskLen : 0;
  if (diskLen > seenDiskLen) return 'reload';
  return 'none';
}

// 切视图入场（bindView 的 sync:since ack 回调）该拿什么当渲染真相：活缓冲/DOM 缓存 vs 磁盘 history 全量重载。
// 与 syncAckAction 分工不同——那是「重连/probe」路径（connect 后补发），这是「切视图入场」路径（bindView 独立决策）。
// 要害盲区①：CLI 在终端外部 `--resume` 写盘的消息【不经过】web 这个 SDK 实例的活缓冲，只落磁盘 transcript。
// 若 web 离开期间被外部写过，切回时 replayed=0（活缓冲无那些消息）却 hasCache=true（有旧 DOM 缓存）——
// 旧逻辑信缓存不拉盘 → 永远看不到外部写入。故此处比对 server 报的磁盘 history 条数 diskLen 与前端上次为该
// 会话渲染到的 seenDiskLen：磁盘更长 = 被外部写过 = 当作一种 gap，清屏全量重载磁盘（唯一真相源、清屏天然无重复）。
// 要害盲区②（PWA 下拉刷新 / 整页 reload）：sessionDomCache 是内存态，硬刷新后 hasCache=false；server 实例仍在，
// sync:since(0) 回放环形缓冲（BUFFER_CAP=2000 事件，见 src/agent/agent.js）。旧逻辑见 replayed>0 就 keep →
// 永远不拉 session:history，只剩缓冲里能拼出的最近几轮（流式 text_delta 仍可填满 cap；且 gap 要求 lastSeq>0，
// 硬刷新 lastSeq=0 永远判不出缺口）。故「无 DOM 缓存」必须优先走磁盘全量——有缓冲回放过时用 reload
// （先清再装，避免缓冲片段叠历史）。
//   gap → 'reload'（缓冲超窗，同 syncAckAction）；
//   !hasCache && replayed>0 → 'reload'（冷入场：缓冲片段 ≠ 全量历史，清屏拉盘）；
//   !hasCache → 'load'（聊天区空、拉磁盘首次填充，不必再清）；
//   hasCache && replayed>0 → 'keep'（切 tab 秒恢复：DOM 缓存已是全量渲染真相 + 活缓冲增量，不重载以免丢实时 thinking）；
//   hasCache && diskLen>seenDiskLen → 'reload'（外部写入盲区：缓存已过期，清屏全量重载）；
//   否则 → 'keep'（缓存仍是最新，保留 DOM 秒恢复）。
// ⚠️ 已知边界（code-review 发现4，有意不修）：seenDiskLen 只由 loadHistory/onHistoryAppend 维护，
//   web 自己 live 流跑出来的轮次【不】更新它。于是"发一轮(磁盘增长)→切走→切回同实例(无外部活动、replayed=0、
//   缓存命中)"会 diskLen>seenDiskLen → 多余 reload（闪屏+滚动跳，但内容正确）。这是【安全侧】：现状 under-count
//   → 多 reload(安全)；若改成让 live 轮 bump seenDiskLen，一旦 over-count 就变 under-reload = 漏外部写入 =
//   数据丢失(正是 #1 盲区)。宁可闪一下、不可漏消息，故保留。
// ⚠️ 冷入场 reload 的代价：环形缓冲里尚未落盘的实时 thinking/在跑工具卡会被 clearView 清掉；硬刷新本就是
//   用户主动重入，可接受——后续 live 事件与 pending 快照仍会接上。
export function shouldReloadOnEnter({ replayed, gap, hasCache, diskLen = 0, seenDiskLen = 0, hasSessionId = true } = {}) {
  // 实例还没拿到 sessionId（CLI 未吐 system/init）：session:history 无从查起——server 端 handler 的
  // sessionFileExists 守卫会直接回「会话不存在」，清屏换来的必定是白屏。此时服务端环形缓冲里的回放
  // 是唯一能看到的内容（它就是 CLI 经 stdout 实时吐出来的那份），宁可残缺也不能清空。
  // 真机 2026-07-30 bc29ccc2：web 发起 /code-review max，CLI 因第三方网关故障 31 分钟没吐 init，
  // 期间整页刷新 → 走 !hasCache && replayed>0 → 'reload' → 清屏后拿不回任何东西 → 白屏。
  // 判据用「有没有 sessionId」而非 diskLen：后者在 replayed>0 时 server 根本不读（恒 null，见
  // src/server/app.js 的 sync:since），拿 null 当 0 会把整页刷新一律变成 keep，毁掉冷入场拉盘的修复。
  if (!hasSessionId) return 'keep';
  if (gap) return 'reload';
  // 冷入场（整页刷新/无 DOM 缓存）优先于「有缓冲就 keep」——缓冲只保最近事件，不是全量历史。
  if (!hasCache) return (replayed > 0) ? 'reload' : 'load';
  // 磁盘 ahead 优先于 replayed>0 keep：外部 CLI 写盘不进活缓冲，切回/同会话有回放时仍可能漏显（G1/G2）。
  if (diskLen > seenDiskLen) return 'reload';
  if (replayed > 0) return 'keep';
  return 'keep';
}

// 修「切回会话停在旧位置 + 内容一条条冒出来像重播」：shouldReloadOnEnter 的 'keep' / syncAckAction 的
// 'none' 分支恢复的是【离开时缓存的旧内容】，之后离开期间产生的新内容才作为 sync:since 补发事件逐条
// 到达，各自走非强制 scrollBottom（未必够到"距底部<120px"的阈值）——视觉上就是先停在旧底部、再被动
// 跟着新内容一点点往下挪。'load'/'reload' 分支已由 loadHistory 完成时的 scrollBottom(true) 兜底，
// 无需重复触发；只有 keep/none 且确有真实回放内容时才需要这一次额外的强制落底。
export function shouldForceScrollAfterReplay({ action, replayed } = {}) {
  if (action !== 'keep' && action !== 'none') return false;
  return Number.isFinite(replayed) && replayed > 0;
}

// 回放缓冲决策（修「切会话/重连时离开期间积压的消息像打字机一样逐条蹦出」）：
// 根因——src/server/app.js 的 'sync:since' handler 是先把该实例环形缓冲里离开期间攒的事件逐条经
// agent:event 信封（带 replay:true 标记）逐个推给客户端发完，才调用 done()/ack（for 循环在 ack 之前，
// 顺序不可颠倒，是既有设计）。旧客户端逻辑对 replay 事件走的是和实时消息完全相同的增量渲染路径
// （text_delta/tool_use/tool_result 等逐条 handler、各自触发一次 scrollBottom），于是"离开期间攒的一长串
// 消息"会在 ack 到达前就已逐条吐到屏幕上——replay:true 目前只用来静音提示音，不做任何批量合并。
// 修法：客户端必须在请求续传（sync:since）之前就架起缓冲区（app.js + app/event-dispatch.js 的
// createReplayBuffer：begin/offer/resolve），把命中该 instanceId 的事件先原样入队不渲染（含期间可能
// 穿插的非 replay 实时事件，保序），ack 到达后才知道"这次到底缓冲了多少条"，本函数据此二选一：
//   'reload' —— 丢弃缓冲队列，改走 session:history 的既有批量渲染路径（loadHistory/renderHistoryBubbles
//                已经是分块解析 + 一次性 fragment 插入 + 单次 scrollBottom(true) 落底，无需改动）；
//   'flush'  —— 按到达顺序把缓冲事件正常派发（走原有 handler 增量渲染），但抑制每条各自触发的滚动，
//                全部派发完只做一次强制落底。
// 优先级（新增独立层，不揉进 shouldReloadOnEnter/syncAckAction 改坏原有语义）：
//   1) priorAction 已经是 'reload'（shouldReloadOnEnter 切视图 / syncAckAction 重连两条入口共用口径）
//      或 'load'（shouldReloadOnEnter 冷入场分支）→ 直接 'reload'，这层不再重复判断——磁盘全量重载
//      已经在路上，缓冲队列本就该被丢弃、无需再单独处理。
//   2) busy（该实例当前正有实时轮次在跑，调用方按 shouldSeedBusyFromInstanceState 的口径传入）→ 恒
//      'flush'。进行中的流式内容只活在服务端环形缓冲、尚未落盘，reload 走磁盘 session:history 会把这段
//      丢掉；哪怕缓冲堆积再多事件，也只能老实 flush（抑制中间滚动，但内容一条不能少）。
//   3) 其余（priorAction 是 'keep'/'none'，即 shouldReloadOnEnter/syncAckAction 已判定"不用重载"）：
//      bufferedCount 达到阈值 → 'reload'（补上"但攒太多也该重载"这一判断，是解决"逐条吐消息"问题的
//      主力路径——积压很多时直接走批量渲染，而不是让几十上百个 DOM mutation 挤在一起抖动）；
//      未达阈值 → 'flush'（少量补发，正常增量 + 抑制中间滚动 + 收尾强制落底一次，视觉上与"瞬间到达"
//      无区别，不必为了几条消息就清屏重载）。
//
// REPLAY_BUFFER_RELOAD_THRESHOLD=100 的理由：text_delta 按小段流式拆分，一次几十字的单轮回复就可能
// 有几十个 text_delta 事件（长回复、开思考模式时 thinking_delta，或夹杂 tool_use/tool_result，事件数
// 还会再往上加），但单轮再长也很少突破百级；真正"离开期间攒了好几轮回复"（本次要修的场景）每轮至少
// 贡献 user_message + N×text_delta + result 等几十个事件，2-3 轮就能轻松过百。取 100 使两头都不误判：
// 定低了会让正常的单轮长回复也被判成"积压"走清屏重载——不算错但多余地闪一下，flush 明明能不闪就搞定；
// 定高了会让真堆积多轮的场景仍在走逐条 flush——几十上百次独立 DOM mutation 挤在一起，观感依然是抖动/
// 蹦出，正是本次要修的问题本身。
export const REPLAY_BUFFER_RELOAD_THRESHOLD = 100;

export function resolveReplayBufferAction({ bufferedCount = 0, priorAction, busy = false, hasSessionId = true, threshold = REPLAY_BUFFER_RELOAD_THRESHOLD } = {}) {
  if (priorAction === 'reload' || priorAction === 'load') return 'reload';
  // 无 sessionId：同 shouldReloadOnEnter 的首条闸——一层已判 'keep'，这层不能因为「积压超阈值」
  // 就把它升级回 reload，那同样是清屏换一个拿不到的磁盘。busy 分支只覆盖「轮次进行中」，
  // 轮次结束后再刷新 busy=false，只剩这条闸兜着。
  if (!hasSessionId) return 'flush';
  if (busy) return 'flush';
  return bufferedCount >= threshold ? 'reload' : 'flush';
}

// stick-to-bottom 判定（聊天 messagesEl / 客户端日志 consoleLogArea 共用）：
// force 总是落底；否则仅当「距底 < threshold」时跟随。上翻读历史时新内容不得拽回。
// 默认 120 与 app.js 历史 scrollBottom 阈值对齐。
export function shouldStickScrollToBottom({
  scrollHeight, scrollTop, clientHeight,
  force = false,
  threshold = 120,
} = {}) {
  if (force) return true;
  const dist = Number(scrollHeight) - Number(scrollTop) - Number(clientHeight);
  return Number.isFinite(dist) && dist < threshold;
}

// 未读胶囊"跳到第一条未读"定位：未读消息永远是当前已渲染顶层气泡列表的尾部 N 条（N=服务端
// unreadOnEntry），不需要跨路径消息 ID 贯穿磁盘存储和实时流——渲染完成后对列表做一次位置计算即可。
// 返回 -1 表示无需定位；unreadCount 超过实际渲染条数时 clamp 到 0（滚到已加载内容最顶部），不越界。
export function resolveUnreadAnchorIndex(listLength, unreadCount) {
  if (!Number.isFinite(unreadCount) || unreadCount <= 0 || listLength <= 0) return -1;
  return Math.max(0, listLength - unreadCount);
}

// 未读胶囊第三条自动确认已读路径（与「点击胶囊」「IntersectionObserver 扫到锚点」并存，见 app.js
// showUnreadPillIfAny/ackUnread，三条互不替代）：用户手动滚动到贴近底部，视为「已经看到最新消息」。
// 核心难点——切入积压了很多未读的会话时，回放缓冲（P0-REPLAY-BUFFER）落底会程序性调一次
// scrollBottom(true) 把视图直接推到最新消息处；这次滚动不代表用户已经看到胶囊、意识到自己错过了
// 什么，若不排除会让胶囊在用户还没反应过来时就被这次程序性落底误判成"已读"清掉。
// withinProgrammaticWindow 由调用方（app.js messagesEl 的 scroll 监听）根据 scrollBottom() 内部维护的
// "程序性滚动窗口"时间戳算出并传入布尔值，这里只消费结果，不关心具体时长/定时器实现。贴底判断直接
// 复用 shouldStickScrollToBottom（不重新发明一遍阈值逻辑），用它的默认 threshold。
export function shouldAckUnreadOnScroll({
  pillVisible = false,
  withinProgrammaticWindow = false,
  scrollHeight, scrollTop, clientHeight,
} = {}) {
  if (!pillVisible) return false;
  if (withinProgrammaticWindow) return false;
  return shouldStickScrollToBottom({ scrollHeight, scrollTop, clientHeight });
}

// 同 sessionId 的 DOM 缓存恢复策略：已完成的对话/工具卡片按会话不可变，与当前 instanceId 无关。
// instance 会因 effort/model 切档被 dispose+open 换新（新 epoch/seq 空间），但历史 DOM 仍可秒恢复；
// 仅当「缓存归属实例 === 当前实例」时才复用 lastSeq/epoch 做增量续传，否则 seq 从 0 跟新实例，
// 避免旧实例的 seq 基线对新缓冲错位（错位会漏事件或把新事件当重复丢掉）。
//   restore=false           → 无节点可恢复，走 loading + history
//   restore + reuseSeqBaseline → 贴回 DOM，并用 cached.lastSeq/epoch 增量 sync
//   restore + !reuseSeqBaseline → 贴回 DOM，resumeFromSeq=0（新实例全量增量从空缓冲起）
export function sessionDomCachePlan({ cached, currentInstanceId } = {}) {
  if (!cached?.nodes?.length) {
    return { restore: false, resumeFromSeq: 0, reuseSeqBaseline: false, epoch: null, lastSeq: 0 };
  }
  const sameInstance = cached.instanceId === currentInstanceId;
  if (sameInstance) {
    const lastSeq = Number(cached.lastSeq) || 0;
    return {
      restore: true,
      resumeFromSeq: lastSeq,
      reuseSeqBaseline: true,
      epoch: cached.epoch ?? null,
      lastSeq,
    };
  }
  return { restore: true, resumeFromSeq: 0, reuseSeqBaseline: false, epoch: null, lastSeq: 0 };
}

// 软键盘弹起时，底部输入区(footer)该用多大的 padding-bottom 给键盘让位。
//   iOS Safari：键盘只缩 visualViewport、layout viewport(innerHeight)不动 → 需手动补 (innerHeight-viewportHeight)
//     把输入框顶到键盘上方；
//   Android(viewport meta interactive-widget=resizes-content)：layout viewport 随键盘一起缩，
//     innerHeight≈viewportHeight → inset≈0、本就不需补。
// 要害(E17 附件回流空白 bug)：inputFocused=false（键盘应已收起）时**一律回落 baseBottom**。否则点附件按钮
//   唤起系统文件/相册选择器时，输入框失焦、innerHeight/viewportHeight 在抢/还焦点期间瞬时错配
//   （innerHeight 已恢复全屏、viewportHeight 还停在键盘弹起的小值），会算出一个大 inset 被写死进 padding，
//   留出半屏空白且无人复位。按焦点门控后，键盘收起即回落静息值，空白自愈。
// inset 为负/NaN/0 同样回落 baseBottom，绝不写负 padding。
export function keyboardInsetPadding({ innerHeight, viewportHeight, viewportOffsetTop = 0, inputFocused, baseBottom = 0 }) {
  if (!inputFocused) return baseBottom;
  const inset = innerHeight - viewportHeight - viewportOffsetTop;
  if (!(inset > 0)) return baseBottom;
  return baseBottom + inset;
}

// 本次会话分隔线判定：合并按 ts 升序=恢复段(上次会话)在前、本次在后；在恢复段末尾→本次开头的
// 交界处（前条 restored、当前非 restored）画一次「—— 本次会话 ——」。全本次或全恢复都不画。
export function isRestoredBoundary(prevEntry, entry) {
  return !!prevEntry?.restored && !entry?.restored;
}

// 长按历史气泡「从这里分叉」该发哪条消息的 uuid 给 forkSession（upToMessageId）：
// assistant 气泡 = 分叉点就是它自己；user 气泡故意不用自身 uuid，而是取它前面最近一条 assistant 的
// uuid——语义是「从这里开始重新问」（新会话里下一步就是重新打字），而非把这条提问原样复制进新会话末尾。
// DOM 侧负责找 precedingAssistantUuid（沿 previousElementSibling 回溯），本函数只做决策、不碰 DOM。
export function resolveForkAnchorUuid({ role, ownUuid = null, precedingAssistantUuid = null } = {}) {
  if (role === 'assistant') return ownUuid || null;
  return precedingAssistantUuid || null;
}

// 页面是否从「本地/局域网/隧道内」打开——决定 unauthorized 时有没有 token 门可弹。
// 100.64.0.0/10 是 Tailscale 用的 CGNAT 段（正则精确到 /10，不放整个 100/8：100/8 其余部分是可路由公网）。
// `.ts.net` 是同一件事的域名那半：MagicDNS 开着时手机上输入的是 `<主机名>.<tailnet>.ts.net`，
// 走域名分支，此前判成公网。
//
// 这个后缀确实两义——tailnet 内访问是私网，Funnel 暴露出去是公网——但两义在这里不构成取舍，
// 因为本判定只在 CF Access 确实配着时才参与决策（见下面 authFailurePath：flag !== '1' 时所有
// hostname 一律进 token 门）。于是两边分别是：
//   · tailnet 内 + CF Access 也配着（公网走 CF、私网走 Tailscale 的双路部署）：判成公网会送去
//     Access 重登，而这条路不经过 Cloudflare、/health 拿不到 302，重登框也不弹——屏幕停在
//     「需要重新登录」，界面上没有任何可点的东西。这是本条要修的死路。
//   · Funnel：正常部署下 CF Access 是空的，本判定压根不参与，改与不改行为一致。
// 所以判成 LAN 没有反向代价，不是在两个坏结果里挑一个。
export function isLanOrLocalHostname(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')
    || h.endsWith('.ts.net')
    || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h);
}

// unauthorized 后走哪扇门：token-gate（弹令牌输入框）还是 access-relogin（公网无 token 可输，提示 Access 重登）。
// data-cf-access 注入契约是 '1' | '0'（src/server/http.js 对 index.html 的替换）——"0" 是非空字符串，
// 真值判断恒 true，曾把「CF 未启用」分支彻底堵死（非 CF 拓扑 token 失效后无门可弹的死路）。
// 唯一合法的「已启用」是 === '1'；dataset 缺失（替换没匹配上）同样落 token 门，失败方向必须有门可弹。
export function authFailurePath({ lanOrLocal, cfAccessFlag } = {}) {
  return (lanOrLocal || cfAccessFlag !== '1') ? 'token-gate' : 'access-relogin';
}
