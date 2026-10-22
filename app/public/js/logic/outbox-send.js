// logic/outbox-send.js —— 在线/离线发送 ack · 耐久 outbox · busy 态种子与广播绑定
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t } from '../i18n.js';
import { formatCliDuration, pickTurnDoneVerb } from './bg-tasks.js';

// 在线 user:message 的 socket ack 决策（纯函数）。成功只清 in-flight；失败须清乐观 busy +
// 可见文案，并可恢复草稿（输入已被 send() 清空）。旧实现把 ack 当 clearSendInFlight 忽略 payload。
//
// dropBubble = 在线乐观气泡的去留。send() 那一刻气泡就上屏了，负 ack 必须决定命运：
// 留 ⟺ ok || requeue；撤 ⟺ 确定没发出去（文字已回填输入框），否则会留一颗永远转圈的气泡。
// 与 restoreDraft 分开：一个管消息流、一个管输入框，当前同值只是巧合。
export function presentOnlineSendAck(ack) {
  if (ack && ack.ok === true) {
    return {
      ok: true,
      clearBusy: false,
      restoreDraft: false,
      retryable: false,
      permanent: false,
      stale: false,
      requeue: false,
      dropBubble: false, // 留：等 user_message 按 clientMessageId 认领转正
      message: '',
    };
  }
  const error = (ack && typeof ack.error === 'string' && ack.error.trim())
    ? ack.error.trim()
    : t('发送失败');
  // 续接会丢掉最新那段对话（SESSION-04）：服务端没收下这条，等用户在面板上选「分叉」还是「仍然发送」。
  // 不进 outbox——自动重发要么一直撞同一道闸，要么就是替用户做了决定。话先回填输入框，面板的两个选项都作用于
  // 输入框里的话（app/resume-divergence.js），取消就留在那儿。ack 里的 permanent 是给不认 reason 的旧前端的，这里先于它判。
  if (ack?.reason === 'resume_divergent' && ack.divergence && typeof ack.divergence === 'object') {
    return {
      ok: false,
      clearBusy: true,
      restoreDraft: true,
      retryable: false,
      permanent: false,
      stale: false,
      requeue: false,
      dropBubble: true,
      message: '',
      divergence: ack.divergence,
    };
  }
  // 在途轮拒收（排队已移除）：被拒的是【这条新消息】，不是正在跑的那轮——
  // clearBusy 必须 false，否则会把在跑那轮的状态行/停止钮一起清掉；也不 requeue，
  // 自动重发等于把排队搬到客户端。文字回填输入框（send 已清空它）。
  if (ack?.busy === true) {
    return {
      ok: false,
      busy: true,
      clearBusy: false,
      restoreDraft: true,
      retryable: false,
      permanent: false,
      stale: false,
      requeue: false,
      dropBubble: true, // 撤：服务端没收下这条，文字已回填输入框
      message: error,
    };
  }
  const permanent = Boolean(ack?.permanent);
  // stale 认两种形态：标志位与裸协议串。服务端当前两者同发（app.js 的两处 ack 都是
  // `{ ok:false, error:'stale_instance', stale:true }`），但离线路径 presentOfflineResendAck
  // 早就同时认，且它的注释写着「判据与在线路径 presentOnlineSendAck 逐字对齐」——
  // 而这里此前只把裸串用于【文案】（下面那个 if），决策仍只看 ack.stale。
  // 于是只要哪天服务端少发一个（比如重构时觉得 stale:true 冗余），在线路径就会把死信
  // 当可重试塞进 outbox，表现为「每次重连重发一遍、永不退场」，而离线路径正常。
  // 两端表现不一致的缺陷最难查，这里把判据补齐，让那句「逐字对齐」真的成立
  // （2026-09-05 由跨路径一致性断言发现，见 tests/invariants/logic-outbox-ack.test.mjs）。
  const stale = Boolean(ack?.stale) || error === 'stale_instance';
  const retryable = Boolean(ack?.retryable) || (!permanent && !stale);
  let message = error;
  if (error === 'stale_instance' || stale) {
    message = t('目标会话已关闭，请刷新后重发');
  } else if (!message.startsWith(t('发送')) && !message.includes(t('失败'))) {
    message = `${t('发送失败：')}${message}`;
  }
  // retryable 且非 permanent/stale → 入 outbox 自动重试（与离线路径对齐）；此时不回填草稿，避免与队列双份
  const requeue = retryable && !permanent && !stale;
  return {
    ok: false,
    clearBusy: true,
    restoreDraft: !requeue,
    retryable,
    permanent,
    stale,
    requeue,
    dropBubble: !requeue, // 进 outbox 的留给重发认领；permanent/stale 确定没发出去 → 撤
    message,
  };
}

// 在线发送 transport 层（socket.timeout err 或 ack）决策——与 presentOfflineResendAck 对齐。
// err 非空 = 超时/断连；无 err 时委托 presentOnlineSendAck。
export function presentOnlineSendTransport(err, ack) {
  if (err) {
    return {
      ok: false,
      clearBusy: true,
      restoreDraft: false,
      retryable: true,
      permanent: false,
      stale: false,
      requeue: true,
      dropBubble: false, // 留：进 outbox 自动重发，气泡上继续显示进度
      message: t('未确认送达，已排队重试'),
    };
  }
  return presentOnlineSendAck(ack);
}

// ---- 发送时序常量 ----
// 服务端从收到 user:message 到 pendingTurns++ 的耗时上界。主导项是 agent.js#send 里那次 setModel
// control_request：它打给一个刚 spawn、还没起来的 CLI，上限 interruptTimeoutMs=10s。这段窗口里
// instance-manager 的 stateOf() 恒返回 'idle'（判据就是 pendingTurns > 0），轮次「还没开始」。
//
// 这个数字是【多个】客户端判据的共同约束源——凡是要区分「轮次还没开跑」与「轮次已结束/没送达」
// 的地方，窗口都必须比它长。2026-08-26 之前传输超时与 busy 看门狗各写各的 5000，双双踩中：
// 前者把没送达判错（白刷「正在重发」横幅），后者把没结束判错（运行条中途消失）。
// 同一个根因被发现了两次，第二次靠独立审查才挖出来——所以现在它们同住一个模块并有序关系断言
// 钉住（tests/unit/logic-composer-primary.test.mjs 的「发送时序常量」describe）。
export const SERVER_PRE_TURN_UPPER_BOUND_MS = 10000;

// UI 兜底：到点解锁发送按钮，防 ack 真丢时按钮永久卡死。只管本端交互手感，不参与「是否送达」
// 的判定，所以可以（也应该）远短于下面那个——按钮早点能按，比让用户干等安全。
export const SEND_ACK_FALLBACK_MS = 5000;

// 传输判据：超时即认定「这条没送达」→ 进 outbox 自动重发。必须覆盖 SERVER_PRE_TURN_UPPER_BOUND_MS
// 之外，还要留出 resume 的时间——注意 RESUME 路径并非有界：openResumeInstance 是
// Promise.all([两次无超时的 transcript 尾读, Promise.race([ensureCliDefaults, 1200ms])])，
// 即 max(尾读IO, ≤1200ms)，只有 FRESH 分支才真的 ≤1200ms。
// 上界一侧受 engine.io 被动判死窗约束（默认 pingInterval 25s + pingTimeout 20s = 45s，本仓未覆盖
// 该默认）。真断线不必等满：socket.io 的 onclose→_clearAcks 会立刻用 Error 回调非 buffered 的 ack，
// 30s 只在 half-open 才真的付出。
// 已知不足：附件上传的传输时间也算在这个窗口里（计时从 emit 起算，早于连接检查），20MB 附件在
// 移动上行下可能超 30s → 仍会误判重发。要根治得把附件走 HTTP 分离出去，不在本轮范围。
export const SEND_ACK_TRANSPORT_MS = 30000;

// 离线重发窗：重发打的是同一个 user:message handler，同一段慢路径要再走一遍，故与上面同值
// （不变量断言钉住相等）。
export const OFFLINE_RESEND_ACK_MS = SEND_ACK_TRANSPORT_MS;

// ---- 发送 outbox（在线/离线统一耐久队列的纯决策）----
// 条目可序列化字段不含 bubbleEl；app.js 用 clientMessageId 回挂 DOM。
export const OUTBOX_MAX_ITEMS = 20;
export const OUTBOX_STORAGE_KEY = 'ccm-outbox-v1';

function serializeOutboxItem(item) {
  if (!item || typeof item !== 'object') return null;
  const clientMessageId = typeof item.clientMessageId === 'string' ? item.clientMessageId : '';
  if (!clientMessageId) return null;
  return {
    text: item.text == null ? '' : String(item.text),
    model: item.model == null ? null : item.model,
    attachments: Array.isArray(item.attachments) ? item.attachments : undefined,
    clientMessageId,
    instanceId: item.instanceId == null ? null : item.instanceId,
    cwd: item.cwd == null ? null : item.cwd,
    // 入队时那个实例跑的会话（MSG-02）：服务端据它核对重放命中的实例还是不是那段对话。instanceId 活得比
    // server 进程久，单凭它认不出「同号的另一个会话」。入队时会话还没开出来（新会话页）就不落键。
    ...(typeof item.sessionId === 'string' && item.sessionId ? { sessionId: item.sessionId } : {}),
    // 「在新 worktree 里开」的意图必须活过入队与 localStorage 往返：服务端在懒开实例时据它
    // `git worktree add`，丢了就是一条没有意图的消息——实例开在父仓，而用户以为改动隔离了。
    // 本函数是白名单，新字段不显式登记就被静默丢掉（这一条就是那么漏过一次的）。
    // 只在真勾选时落字段：没勾的消息不该平白多两个键，服务端判的是 `=== true`。
    ...(item.useWorktree === true ? { useWorktree: true } : {}),
    ...(typeof item.sourceBranch === 'string' && item.sourceBranch ? { sourceBranch: item.sourceBranch } : {}),
    // 入队时在哪一个新会话页上（见 outboxComposeKey）：重载页面之后两页的条目还要分得开
    ...(typeof item.composeId === 'string' && item.composeId ? { composeId: item.composeId } : {}),
  };
}

// 有界入队：超 maxItems 丢最旧。返回 { queue, dropped }。
export function planOutboxEnqueue(queue, item, { maxItems = OUTBOX_MAX_ITEMS } = {}) {
  const base = Array.isArray(queue) ? queue.slice() : [];
  const row = serializeOutboxItem(item);
  if (!row) return { queue: base, dropped: [] };
  // 同 clientMessageId 去重：后写覆盖前（重试路径可能重复 push）
  const without = base.filter(x => x?.clientMessageId !== row.clientMessageId);
  without.push({ ...row, ...(item.bubbleEl ? { bubbleEl: item.bubbleEl } : {}) });
  if (without.length <= maxItems) return { queue: without, dropped: [] };
  const overflow = without.length - maxItems;
  return { queue: without.slice(overflow), dropped: without.slice(0, overflow) };
}

export function parseDurableOutbox(raw) {
  if (raw == null || raw === '') return [];
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const row of data) {
    const s = serializeOutboxItem(row);
    if (s) out.push(s);
  }
  return out;
}

export function dumpDurableOutbox(queue) {
  const items = (Array.isArray(queue) ? queue : [])
    .map(serializeOutboxItem)
    .filter(Boolean);
  return JSON.stringify(items);
}

// 离线队列单条重发 ack 决策（FE-NEW-001）。与在线不同：不恢复草稿（气泡已在消息流）、
// permanent 必停重试；timeout/err 与非 permanent 负 ack 一律 requeue。
// outcome: 'ok' | 'permanent' | 'requeue' | 'blocked'
// blocked = 撞上在途轮（排队已移除）：队列首条发出去就开跑，其后各条必被拒。继续 requeue 会空转成
// 客户端排队，故落终态由用户手动重发。与 permanent 的区别：blocked 稍后重发能成功，不是死信。
export function presentOfflineResendAck(err, ack) {
  if (!err && ack && ack.ok === true) {
    // instanceId 要透传：同一批离线消息里「在新 worktree 里开」的意图只该兑现一次，
    // 后续各条得改投第一条开出来的那个实例（见 planOutboxWorktreeReuse）。
    return {
      outcome: 'ok', permanent: false, requeue: false, clearBusyIfViewing: false, message: '',
      instanceId: (ack && typeof ack.instanceId === 'string' && ack.instanceId) ? ack.instanceId : null,
    };
  }
  if (!err && ack && ack.ok === false && ack.busy === true) {
    const error = (typeof ack.error === 'string' && ack.error.trim()) ? ack.error.trim() : t('当前任务运行中，完成后可发送');
    return { outcome: 'blocked', permanent: false, requeue: false, clearBusyIfViewing: false, message: error };
  }
  // 续接会丢掉最新那段对话（SESSION-04）：要人拍板，后台重放不能替他选。落 blocked；点「重发」再撞上时，
  // 调用方据 divergence 把这条挪回输入框、弹出与在线路径同一块面板（app.js markOutboxBlocked）。
  if (!err && ack && ack.ok === false && ack.reason === 'resume_divergent') {
    return {
      outcome: 'blocked', permanent: false, requeue: false, clearBusyIfViewing: true,
      message: t('这次续接会丢掉最近一段对话，点「重发」后选择怎么续'),
      ...(ack.divergence && typeof ack.divergence === 'object' ? { divergence: ack.divergence } : {}),
    };
  }
  // stale（目标实例已关闭）也是死信：服务端 fail-closed 的负 ack 只带 {stale:true}、【不带】permanent，
  // 落到下面的兜底 requeue 就成了「每次重连重发一遍、永不退场」。判据与在线路径 presentOnlineSendAck
  // 逐字对齐（error==='stale_instance' || ack.stale），并把裸协议串换成人话——用户看到的是提示不是错误码。
  if (!err && ack && ack.ok === false && (ack.stale === true || ack.error === 'stale_instance')) {
    return {
      outcome: 'permanent', permanent: true, stale: true, requeue: false, clearBusyIfViewing: true,
      message: t('目标会话已关闭，请刷新后重发'),
    };
  }
  if (!err && ack && ack.ok === false && ack.permanent) {
    const error = (typeof ack.error === 'string' && ack.error.trim()) ? ack.error.trim() : t('发送失败');
    return { outcome: 'permanent', permanent: true, requeue: false, clearBusyIfViewing: true, message: error };
  }
  // 超时 / 可重试失败 / 畸形 ack
  return {
    outcome: 'requeue',
    permanent: false,
    requeue: true,
    clearBusyIfViewing: false,
    message: err ? t('未确认送达') : ((ack && typeof ack.error === 'string' && ack.error.trim()) || t('发送失败')),
  };
}

// 队列项是否发往当前视图——outbox 的唯一归属判据。此前 planOutboxDrainNotice /
// shouldBusyAfterOfflineBatch / app.js 的 targetsViewing 各写一份「逐字一致」的表达式，
// 任一处改动都会静默分叉（2026-08-05 outbox 三修的教训：两个函数注释都写「与对方对齐」，
// 而那一维从没对齐过）。合成一个函数后，"一致" 由语言保证，不再靠注释纪律。
//
// 两条判据分工：
// ① instanceId 非空 → 条目与视图两侧的会话都已知时按会话认，否则严格比实例号。同一工作区可并存多个会话，
//    cwd 相同也不得改判。按会话认是跟着服务端走：离线重放带着入队时的 sessionId，服务端按它改投（MSG-02，
//    instance-routing.js 的 resolveInstanceTarget）。规则 5 置换、切 effort 只换实例号不换会话——同一批的
//    第 1 条触发置换，新号的 instances 广播先于它的 ack 到达，于是它和后面各条都拿着旧号去对新视图，按实例号比
//    全成了「别的会话」；/clear 反过来，实例号没变、会话换了，服务端不投给它。viewingSessionId 取 instances
//    快照里当前查看实例此刻跑的会话（与 viewingInstanceId 同一份快照）；查不到时回落实例号。
// ② instanceId 为空（入队时实例还没开：新会话首发、或在线 ack 超时把首发消息推进 outbox）→
//    按 cwd 判。cwd 任一侧缺失/空串就判不属于，与服务端 shouldRejectOutboxLazyOpen 的 fail-closed
//    对齐（它同样拒 cwd.trim() === ''），不在 UI 上谎称它属于眼下这个会话。
//
//    ⚠️ 这是启发式，不是与服务端逐字等价的判据。服务端 fromOutbox 无 instanceId 时路由到
//    currentSessionForCwd(cwd)——那是该目录的【当前会话指针】，而不是「客户端正在看的实例」。
//    该指针会被 session:new / 空首页 compose 清掉，同一工作区也可能同时有多个会话。所以在
//    「一个工作区开了两个会话」或「离线期间 session:new 清过指针」时，这里判 true 而服务端可能
//    投给另一个会话。可达性窄（要 ≥2 个同目录会话，或离线 session:new），代价仅是文案归属标错，
//    故接受启发式而不引入 instances 列表依赖把纯函数复杂化。
export function outboxItemTargetsViewing(item, { viewingInstanceId = null, viewingCwd = null, viewingSessionId = null } = {}) {
  if (!item || typeof item !== 'object') return false;
  if (item.instanceId != null) {
    const itemSid = typeof item.sessionId === 'string' ? item.sessionId : '';
    const viewSid = typeof viewingSessionId === 'string' ? viewingSessionId : '';
    if (itemSid && viewSid) return itemSid === viewSid;
    return item.instanceId === viewingInstanceId;
  }
  const itemCwd = typeof item.cwd === 'string' ? item.cwd.trim() : '';
  const viewCwd = typeof viewingCwd === 'string' ? viewingCwd.trim() : '';
  return itemCwd !== '' && viewCwd !== '' && itemCwd === viewCwd;
}

// 离线条目的目标实例（O66）：先按会话认——规则 5 置换、切 effort 之后同一会话换了实例号；条目没带会话才按实例号。
// 认不出返回 null（实例已被关掉，或广播还没到）。
export function findOutboxTargetInstance(target, instances) {
  const list = Array.isArray(instances) ? instances : [];
  const sid = typeof target?.sessionId === 'string' ? target.sessionId : '';
  if (sid) {
    const bySession = list.find(i => i?.sessionId === sid);
    if (bySession) return bySession;
  }
  return target?.instanceId != null ? (list.find(i => i?.instanceId === target.instanceId) || null) : null;
}

const outboxTargetKey = target => (typeof target?.sessionId === 'string' && target.sessionId
  ? `s:${target.sessionId}` : `i:${target?.instanceId ?? ''}`);

// 离线重放撞上在途轮的条目排队，本轮结束按序自动续发（O66：终端里忙时打的话也是排队、回合结束再发）。
// entries 按入队顺序：{ target: {instanceId, sessionId}, sawRunning, inFlight }。返回该续发的那一条或 null：
//   · 同一目标只看队首——一轮一条，第 3 条要等第 2 条那一轮；
//   · 队首在发（inFlight）整个目标都等着；
//   · 目标实例认不出就不发：实例被关掉了，不替用户把会话重新开起来（手动「重发」仍在）；
//   · sawRunning：上一条发出之后还没看到这一会话开跑，就不算「本轮结束」——迟到的旧广播不能把下一条提前放出去。
export function pickAfterTurnResend(entries, instances) {
  const seen = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    const key = outboxTargetKey(e?.target);
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.inFlight || !e.sawRunning) continue;
    const inst = findOutboxTargetInstance(e.target, instances);
    if (inst && inst.turnRunning !== true) return e;
  }
  return null;
}

export function sameOutboxTarget(a, b) {
  return outboxTargetKey(a) === outboxTargetKey(b);
}

// 离线消息的失败提示（「未发送 · 可重发」/「已停止重试」）该挂在哪儿。判据是两条独立的问题，
// 只答一条就会把提示放错地方——而放错地方的两种形态都无声：
//
//   · 'indicator'  气泡上的 pending-indicator 还连在活 DOM 里 → 直接复用（原样式、原位置）。
//   · 'bar'        indicator 不在活 DOM（会话切换会把整个气泡搬进 sessionDomCache，
//                  querySelector 仍能从脱离的子树里找到它，所以「找得到」不等于「看得见」），
//                  但这条消息确实属于【当前正在看的】会话 → 新开一条独立提示条。
//                  addBar 写的是当前消息面，只有归属对得上时它才是正确落点。
//   · 'stale'      不属于当前会话 → 仍写回那个已脱离的 indicator：用户切回该会话时缓存被重新
//                  挂上，提示就在那条消息旁边。**绝不能改成 addBar**——那等于拿 A 会话的发送
//                  失败去污染 B 会话的界面（操作在哪一层发起、回执就得在哪一层）。
//   · 'none'       indicator 压根不存在（气泡从未建过，或缓存已被逐出）且又不属于当前会话：
//                  没有任何正确的落点，放弃。宁可不提示，也不在别的会话里凭空多出一条红字。
export function outboxNoticePlacement({
  indicatorExists = false, indicatorConnected = false, targetsViewing = false,
} = {}) {
  if (indicatorExists && indicatorConnected) return 'indicator';
  if (targetsViewing) return 'bar';
  return indicatorExists ? 'stale' : 'none';
}

// 永久拒收、眼前又没有落点的条目进了死信暂存（app.js 的 outboxDeadLetters），回到它的会话才交还。
// 眼前没有会话时（server 重启后的提示页、首页）不说一句，用户只看得到服务端那行「请刷新后重发」，
// 会以为原文没了、只能凭记忆重打（验收 O126）。这时没有 B 会话可污染，可以说；正在看别的会话时
// 仍守 outboxNoticePlacement 的判据，不说。stale 的原因不带「请刷新后重发」：原文在暂存里，刷新找不回它。
// 条目没带会话号（升级前入队）就回不去：只剩的实例号在 server 重启后不复用（MSG-02），暂存永远认不出它——
// 不许诺交还，原文直接写进提示，看得见、复制得到（PR #310 review）。
export function outboxParkedNotice({ viewingInstanceId = null, stale = false, message = '', sessionId = null, text = '' } = {}) {
  if (viewingInstanceId) return null;
  const reason = stale ? t('目标会话已关闭') : (message || t('发送失败'));
  const head = `⚠️ ${t('离线时发的一条消息没有发出：')}${reason}`;
  return sessionId ? `${head}${t('。原文已保存，回到该会话时会放回输入框')}` : `${head}${t('。原文：')}${text}`;
}

// 清屏时一颗离线条目的未确认气泡要不要保住（app.js 的 clearView）。上面 'bar' 那一档在同一会话的清屏重载里会落空：
// 规则 5 置换、磁盘 ahead 都会清屏再拉历史，负 ack 常常先于历史到达，气泡已被摘下，提示条只能插进清空的 #messages，
// 历史随后接在它下面，把它压到顶上。保住气泡，提示就挂在它自己的气泡上，等历史落地再随气泡排到末尾。
//
// 只在同一会话的重载里保、只保发往这个会话的。切到别的会话时旧界面的节点归旧会话的 DOM 缓存，带过来就是串会话；
// 调用方没说清屏前是哪个会话（prevSessionId 缺省）就不保——丢一颗气泡是本来的样子，串会话不是。
// outboxSessionId 是条目入队时记下的会话；没有会话（新会话页、懒开还没拿到 id）一律不保。
export function shouldCarryOutboxBubbleOnClear({ outboxSessionId = null, prevSessionId = null, sessionId = null } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  return prevSessionId === sessionId && outboxSessionId === sessionId;
}

// 全量重载时，一颗被保住的未确认气泡能不能按文字让历史认领（app.js 的 settleCarriedPendingBubbles）。
// 认领会把气泡的 clientMessageId 交给历史里那颗，之后同一个 id 的 user_message 回显被当成「已在屏幕上」、不再渲染。
// 历史没有 clientMessageId，只能按文字从后往前认；同文的旧消息（「继续」这类短句）认错了，就是把 id 交给了别人。
//
// 在线发送的乐观气泡（outboxOutcome 为空，没交给 outbox）照旧认领（P0-DUP-OPT）。交给 outbox 的只在有证据说它进了
// transcript 时认领，outboxOutcome 是它最近一次投递的结论（入队时为 'queued'），maybeSent 是有过一次结局不明的投递
// （超时、服务端让重试）：
//   · 'ok'：服务端收下了。
//   · 'permanent' 且 maybeSent：放弃重试了，但先前那次可能已写进 transcript、只是回执没到——server 重启丢了去重表，
//     再重放就回 stale。不会再拿这个 id 重发，认错的代价只是收掉一颗失败气泡；不认，已送达的历史旁边就多一颗「没发出去」。
// 其余一律不认：排队中、在途（还没有结论）、撞闸等「重发」、等重连重试的，之后都还会拿同一个 id 再发，id 一旦交给旧消息，
// 送达那次的回显就被吞掉；'permanent' 而没有结局不明的投递，是服务端明确没收下，历史里同文的只能是别的消息。
export function canTextClaimPendingBubble({ outboxOutcome = null, maybeSent = false } = {}) {
  if (outboxOutcome == null || outboxOutcome === 'ok') return true;
  if (outboxOutcome === 'permanent') return maybeSent;
  return false;
}

// 离线批处理后是否应 busy：仅当「仍有目标为当前 viewing 的重入队项」或「本批有 viewing 相关 ok 且
// 指望 result 清 busy」时保持 busy。FE-NEW-001：永久失败且无剩余 viewing 队列 → 必须 clear。
// remainingItems = 本批结束后仍在 offlineQueue 的项；viewingInstanceId 可为 null。
export function shouldBusyAfterOfflineBatch({ viewingInstanceId, viewingCwd = null, viewingSessionId = null, remainingItems = [], hadViewingOk = false } = {}) {
  // 首页（无 viewing 实例）恒不 busy：那里没有会话承载运行条，且 instances 广播里的 busy 看门狗
  // 被 `newViewing && newViewing === displayedInstanceId` 包着（app.js），newViewing 为 null 时整段
  // 跳过 ⇒ 此处一旦置上就没人清得掉，主按钮卡成「停止」直到下次 clearView。下面 hadViewingOk 那条
  // 早有同款 `viewingInstanceId != null` 前提，这里补齐 viewingPending 那一半（按 cwd 归属后才够得着）。
  if (viewingInstanceId == null) return false;
  const viewingPending = remainingItems.some(it => outboxItemTargetsViewing(it, { viewingInstanceId, viewingCwd, viewingSessionId }));
  if (viewingPending) return true;
  // 本批对当前 viewing 成功发出 → 短暂 busy 等 result（与在线一致）；非 viewing 成功不抬 busy
  if (hadViewingOk && viewingInstanceId != null) return true;
  return false;
}

// 重发横幅文案：addBar 无条件贴当前会话消息流（app.js 的 addBar 不带归属过滤），而队列项的目标
// 是【入队时刻】那个实例——两者不是一回事。不标注就会读成「这条排队消息在本会话发了」，
// 叠上服务端 sysTo 的「目标会话已关闭」（同样贴当前视图）尤其像串会话。
// 归属判据走 outboxItemTargetsViewing（与 shouldBusyAfterOfflineBatch / app.js 的 targetsViewing 同一份）。
export function planOutboxDrainNotice({ items = [], viewingInstanceId = null, viewingCwd = null, viewingSessionId = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  // 冷启动/刷新后 connect 即 drain（app.js 的 socket.on('connect')），而横幅在第一个 await 之前同步
  // 贴出 ⇒ 必早于本次连接的首帧 instances 广播，此刻两个视图变量都还是初值 null。归属判不出来时
  // 不标注：说「发往其它会话」和说「本会话」一样是编的。foreign 归 0 自然走下面不带标注的中性文案。
  const hasViewContext = viewingInstanceId != null || viewingCwd != null;
  const foreign = hasViewContext
    ? list.filter(it => !outboxItemTargetsViewing(it, { viewingInstanceId, viewingCwd, viewingSessionId })).length
    : 0;
  let text;
  if (foreign === 0) {
    text = `${t('正在重发离线发送队列中的')} ${total} ${t('条消息...')}`;
  } else if (foreign === total) {
    text = `${t('正在重发')} ${total} ${t('条离线消息（发往其它会话）...')}`;
  } else {
    text = `${t('正在重发离线发送队列中的')} ${total} ${t('条消息...')}${t('（其中 ')}${foreign}${t(' 条发往其它会话）')}`;
  }
  return { total, foreign, text };
}

// 通知预览安全截断（FE-NEW-002）：JSON.stringify(undefined) 是 undefined，.slice 会抛。
export function safeJsonPreview(value, maxLen = 80) {
  let s;
  try {
    if (value === undefined) s = 'null';
    else s = JSON.stringify(value);
    if (s === undefined) s = 'null'; // stringify 对 undefined 顶层返回 undefined
  } catch {
    s = '[unserializable]';
  }
  s = String(s);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// 切入已在跑的 live 实例时是否 seed busy（FE-NEW-004）。state 来自 instances[].state。
export function shouldSeedBusyFromInstanceState(state) {
  return state === 'busy' || state === 'permission';
}

// reload 清屏后运行态重种：state 优先取 ack 时刻 instances 广播的最新值（切回瞬间 turn
// 恰结束时入场 entry.state 是过期快照，直接用会 stale-busy）；广播查不到才回退入场快照。
export function shouldReseedBusyAfterReload({ instances = [], instanceId, entryState } = {}) {
  const live = instances.find(x => x?.instanceId === instanceId);
  // 权威快照在册就整份交给 resolveRunStateFromSnapshot（与播种/对账/自检同一份判据）；
  // 查不到才回退到入场快照那个只有 state 的老形状。
  if (live) return resolveRunStateFromSnapshot(live).busy;
  return shouldSeedBusyFromInstanceState(entryState);
}

// instances 广播（视图未变）→ 运行条单向对齐：只置 true、绝不置 false。
// bgActive===true 排除：纯后台任务期无 result 事件可释放，单向置 true 会卡死运行条
//（该期 UI 归 task_progress 横幅）；undefined（旧服务端/视觉 mock）视为无后台任务。
export function shouldBindBusyFromBroadcast({ state, bgActive } = {}) {
  if (bgActive === true) return false;
  return shouldSeedBusyFromInstanceState(state);
}

// 看门狗：上面单向对齐的代价——终止事件（result/error/interrupted）若被实例路由过滤丢弃或丢包，
// 本地 liveLine 会永久卡在 busy=true 空转（见 ccm 现场：会话已结束、spinner 仍在跑）。这里补另一半：
// 服务端 stateOf() 已把后台任务折进 'busy'（instance-manager.js），故此处只看 state 而非 bgActive——
// 真后台任务期 state 仍是 'busy'，不会被误清。
//
// 宽限期必须覆盖 SERVER_PRE_TURN_UPPER_BOUND_MS（见其声明处）：那段窗口里服务端 stateOf() 恒为
// 'idle'（pendingTurns 还是 0），而 broadcastInstances 在 server 有近三十个调用点——任何一个实例的
// 状态变动都会广播，撞进这段窗口就把本端正在跑的乐观 busy 判成「轮次已结束」，运行条和停止按钮
// 中途消失（2026-08-26 二轮审查发现；此前取 5000，短于 setModel 的 10s 上限）。
// 取值与传输窗同源：两者守的是同一段窗口。代价是终止事件真丢包时 spinner 多转到这个时长才被清掉
// ——但那只是多转几秒，而误清的后果是用户看不到停止按钮、中止不了正在跑的轮次，后者更糟。
export const BUSY_BROADCAST_CLEAR_GRACE_MS = SEND_ACK_TRANSPORT_MS;
export function shouldForceClearBusyFromBroadcast({ state, localBusy = false, turnStartTs = null, now = 0, graceMs = BUSY_BROADCAST_CLEAR_GRACE_MS } = {}) {
  if (!localBusy || shouldSeedBusyFromInstanceState(state)) return false;
  if (!turnStartTs) return true;
  return (now - turnStartTs) >= graceMs;
}

// ★ instances 快照 → 运行条与发送闸「应该是什么」。三个字段（state / bgActive / turnRunning）的
// 组合只在这里解释一次，四个消费点全部调它：bindView 入场播种、instances 广播对齐、回放终止事件
// 对账、startLiveTicker 每秒自检。
//
// 【为什么必须收敛成一处】这四处原本各写一遍判据，于是「改了一处忘了另一处」成了默认结局：
// 2026-09-12 PR #38 的六轮 review 一共抓出 9 条问题，其中 5 条正是这个形态——补了回放对账忘了
// ticker、修了 bgActive 又漏了 turnRunning 并存、统一终止事件时顺手改掉了 error 的发送闸语义。
// 判据写一遍之后，这类漏改从「需要每处都记得改」变成「改不动」。
//
// 两条规则，缺任一条都被 review 抓过：
//   · turnRunning === true → 运行条一定亮。前台轮真的在跑，哪怕同时挂着后台任务
//     （bgActive 与 turnRunning 可以并存）。少了它，「后台任务 + 前台轮」会被下一条误判成没有前台活动。
//   · 否则退回 shouldBindBusyFromBroadcast——它排除 bgActive===true：纯后台任务期不由运行条表达，
//     那一段归 task_progress 横幅（该期没有 result 可释放，点亮了就没人清）。
//
// 发送闸只认在途轮，与运行条**故意不同**：纯后台任务期 state 是 busy 而 turnRunning 为 false，
// 此时锁发送会让移动端彻底发不出消息（见 logic/composer.js 的 resolveComposerPrimaryMode）。
//
// live 为空（instances 里查不到该实例）→ 返回 null 表示【没有权威意见】，由调用方各自决定保守做法：
// 播种侧不播、清除侧不清。新会话首发的乐观 busy 期实例尚未进广播，那不是「已经结束」。
export function resolveRunStateFromSnapshot(live) {
  if (!live || typeof live !== 'object') return null;
  return {
    busy: live.turnRunning === true
      || shouldBindBusyFromBroadcast({ state: live.state, bgActive: live.bgActive }),
    turnRunning: live.turnRunning === true,
  };
}

// 上面那份权威意见 + 本地 busy + 宽限窗 → 该不该把本地运行条收掉。
// 广播看门狗与 ticker 每秒自检共用：两者问的是同一个问题（权威说不忙了，本地还亮着，该收了吗），
// 此前各写一份，ticker 那份漏了 bgActive 折算（review 第六轮 P2）。
// 宽限窗的理由见 BUSY_BROADCAST_CLEAR_GRACE_MS：那段窗口里服务端还没把在途轮记上账。
export function shouldClearBusyBySnapshot({ live, localBusy = false, turnStartTs = null, now = 0, graceMs = BUSY_BROADCAST_CLEAR_GRACE_MS } = {}) {
  const authoritative = resolveRunStateFromSnapshot(live);
  if (!authoritative) return false; // 查不到实例 = 没有权威意见 → 不清
  // 宽限窗那半截逻辑仍交给 shouldForceClearBusyFromBroadcast，不在这里重写一遍：
  // 把权威意见折算成它认识的粗粒度 state 即可（busy ? 'busy' : 'idle'）。
  return shouldForceClearBusyFromBroadcast({
    state: authoritative.busy ? 'busy' : 'idle',
    localBusy, turnStartTs, now, graceMs,
  });
}

// 轮次 result → 聊天流条/通知/触感/挂起工具收尾。
// CLI 对用户主动中止只呈现 interrupt，不把 SDK 伴随的 is_error + ede_diagnostic 当红色错误。
// 后端 agent.js 在 interrupt() 成功后给紧随的 result 打 interrupted=true；此处优先于 isError。
// opts.rand 注入过去式动词随机源（默认 Math.random），仅供测试确定化；成功轮收尾行用它。
export function presentTurnResult(payload = {}, opts = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const durationMs = typeof p.durationMs === 'number' ? p.durationMs : 0;
  // costUsd 是 CLI 的累计费用（resume 的会话里还带着之前的），不是这一轮花的：三种收尾行都不挂，累计成本在状态栏
  // （验收 O57：网关 503、一个 token 没用的失败轮显示「$0.38」，读起来像这条失败的消息花了这么多钱）
  const secs = (durationMs / 1000).toFixed(1);
  const errorText = Array.isArray(p.errors) ? p.errors.filter(Boolean).join('; ') : '';

  if (p.interrupted) {
    return {
      kind: 'aborted',
      statusBar: { text: `${t('已中止')} · ${secs}s`, cls: 'text-ink-faint' },
      errorBar: null,
      notify: { title: t('⏹ 任务已中止'), body: `${t('用时')} ${secs}s` },
      failToolsMessage: t('已中止'),
      haptic: 'warning',
    };
  }
  if (p.isError) {
    return {
      kind: 'error',
      statusBar: { text: `${t('出错')} · ${secs}s`, cls: 'text-ink-faint' },
      errorBar: errorText ? { text: `${t('出错：')}${errorText}`, cls: 'text-danger' } : null,
      notify: { title: t('⚠️ 任务出错'), body: errorText.slice(0, 80) || `${t('用时')} ${secs}s` },
      failToolsMessage: errorText || t('工具执行已因本轮错误停止'),
      haptic: 'error',
    };
  }
  // 成功轮收尾对齐 CLI turn_duration 行：✻ <过去式动词> for <时长>。
  // 累计 cost 不再挂后缀（状态栏 #cliStatus 随时可看），保终端等价的收敛观感。
  return {
    kind: 'success',
    statusBar: { text: `✻ ${pickTurnDoneVerb(opts.rand)} for ${formatCliDuration(durationMs)}`, cls: 'text-ink-faint' },
    errorBar: null,
    notify: { title: t('✅ 任务完成'), body: `${t('用时')} ${secs}s` },
    failToolsMessage: null,
    haptic: 'success',
  };
}

// 同一批离线消息里，「在新 worktree 里开」的意图只该兑现一次。
//
// 【缺陷形态】离线时在空首页勾上 worktree 连打几条，每条都以 {useWorktree:true, instanceId:null}
// 入队（离线入队路径不 reset 勾选，viewingInstanceId 也还是 null）。重连后逐条重放，而服务端的
// worktreeCreateInFlight 只合并**并发**、合并不了**先后**——第一条 ack 回来时它已经清了，第二条
// 于是又 `git worktree add` 一棵。结果：同一个任务被劈进互不相干的分支、会话与上下文，
// 而用户只是在离线时多打了几行字。这个分叉在 UI 上没有任何提示。
//
// 【为什么修在这里而不是服务端】服务端看到的两条请求长得一模一样（同 cwd、同意图、都没有
// instanceId），要区分只能靠「最近建过就复用」的时间窗，而那会把**用户连续手动开两棵树**也粘在
// 一起——一个真实用例被当成 bug 修掉。批次归属只有客户端知道，判据就该落在客户端。
//
// 返回要真正投递出去的那一份：第一条照原样发（它负责建树），后续各条改投第一条开出来的实例，
// 并摘掉 worktree 意图（带着它只会让服务端对一个已经在跑的会话重复判断）。
export function planOutboxWorktreeReuse(item, openedInstanceId) {
  if (!item || item.useWorktree !== true) return item;
  if (!openedInstanceId) return item; // 本批第一条：由它去建树
  return { ...item, useWorktree: false, sourceBranch: null, instanceId: openedInstanceId };
}

// 上面这组锚点按「哪一个新会话页」分组：同一页连打的几条并成一个会话，但用户有意新开的另一页要各开各的
// （2026-10-10 第四轮 review P2）。两页的条目 instanceId 都是 null、cwd 也一样，只有入队时记下的页标识分得开。
// 升级前入队的条目没有它，归同一组——行为与从前相同。
export const outboxComposeKey = item => (typeof item?.composeId === 'string' ? item.composeId : '');

// 同一件事的「无文件夹」版（2026-09-24）：离线时在「无文件夹」的新会话页上连打几条，每条都以
// {instanceId:null, cwd:<scratch 根>} 入队；服务端的 scratch 分配器只合并并发、合并不了先后，
// 逐条重放就会一条建一个 scratch 目录、开一个会话。第一条照原样发（由它懒开），后续各条改投它开出来的实例。
// scratchRoot 未知（旧服务端）时不动任何条目。
export function planOutboxScratchReuse(item, openedInstanceId, scratchRoot) {
  if (!item || !scratchRoot || item.instanceId || item.cwd !== scratchRoot) return item;
  if (!openedInstanceId) return item;
  return { ...item, instanceId: openedInstanceId };
}
export function nextOutboxScratchAnchor(item, decision, current, scratchRoot) {
  if (current) return current;
  if (!item || !scratchRoot || item.instanceId || item.cwd !== scratchRoot) return current ?? null;
  if (!decision || decision.outcome !== 'ok') return current ?? null;
  return decision.instanceId || null;
}

// 这一条重放成功后，本批的「worktree 已开」锚点该变成什么。
// 只认【原始意图是 useWorktree 且此前还没锚】的那一条 —— 后续条目已被改投，不该覆盖锚点；
// 普通条目（没勾 worktree）更不该把无关会话的实例写进来。
export function nextOutboxWorktreeAnchor(item, decision, current) {
  if (current) return current;
  if (!item || item.useWorktree !== true) return current ?? null;
  if (!decision || decision.outcome !== 'ok') return current ?? null;
  return decision.instanceId || null;
}

// 普通工作区新会话页的同一件事（O66 review）：离线连发的条目都是 {instanceId:null}。第一条懒开实例；后面各条
// 服务端经 viewing 投给它、撞上它那一轮被拒收。拿着 {instanceId:null} 去排队，本轮结束时 findOutboxTargetInstance
// 认不出目标，永远不续发。所以记下第一条开出来的实例，被拒收的条目按它登记（planOutboxBlockedTarget）。
// 只管登记与之后的「重发」：首次投递照旧不带实例号，路由仍由服务端决定。worktree / 无文件夹各有自己的锚，不在这里。
export function nextOutboxLazyOpenAnchor(item, decision, current, scratchRoot) {
  if (current) return current;
  if (!item || item.instanceId != null || item.useWorktree === true) return null;
  if (scratchRoot && item.cwd === scratchRoot) return null;
  if (!decision || decision.outcome !== 'ok') return null;
  return decision.instanceId || null;
}
export function planOutboxBlockedTarget(item, openedInstanceId) {
  if (!item || item.instanceId != null || !openedInstanceId) return item;
  return { ...item, instanceId: openedInstanceId };
}
