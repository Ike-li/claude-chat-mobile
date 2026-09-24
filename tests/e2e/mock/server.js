import { createVisualMockScenarioRegistry } from './registry.js';
import { createContentScenarios } from './scenarios/content.js';
import { createStatusScenarios } from './scenarios/status.js';
import { createMockTransport } from './transport.js';
import { createHash } from 'node:crypto';
// 审批指纹只此一份规范化实现：app/public/js/canonicalize.js 是 CLAUDE.md 里唯一被指定「前后端共用」
// 的叶子（模块边界闸的原文豁免项），本 mock 是它的第三个消费者。mock 若自己再写一遍规范化，就正好复制了
// 本次要消除的那类分歧——而且前端会拿 verifyIntegrity 校验这个 fp，算错等于在每张审批卡上挂一条假的
// 完整性告警。哈希用 node 同步版而非 fingerprintHex（Web Crypto，异步）：会漂移的是规范化不是 SHA-256，
// 两者逐字节等价已实测。注意这不违反本文件「零 import app/src/」的约束——canonicalize.js 住在 app/public/js。
import { canonicalizeOp } from '../../../app/public/js/canonicalize.js';

const mockFingerprint = (name, input, cwd) =>
  createHash('sha256').update(canonicalizeOp({ tool: name, args: input, cwd })).digest('hex');

// permission_request 与真 server 逐字段对齐（agent.js:1283 live / :2339 快照——那两处本就要求逐字段一致，
// 所以 mock 的 live 与 sync 快照也必须同源）。缺 fp 时前端那句 `if (!p.fp) return;`
// （approval-questions.js:85）会把整条完整性预检【静默跳过】，于是「⚠️ 完整性预检异常」这条警示从未在
// E2E 里被走到过；发错 fp 则等于在每张审批卡上挂一条假告警。两种都不可接受，故只此一处算。
const mockPermFields = (name, input, cwd, at = Date.now()) => ({
  fp: mockFingerprint(name, input, cwd),
  createdAt: at,
  expiresAt: at + 10 * 60_000,
});

const PORT = process.env.PORT || 3100;
const { app, httpServer, io } = createMockTransport();

// Mock Database States
let viewingInstanceId = 'inst_1';
let permissionMode = 'default';
let effortLevel = null;
let activeModel = 'claude-3-5-sonnet';
let pendingFreshPermissionMode;
let pendingFreshEffortLevel;
let pendingFreshCwd;

// 真 server 下发的 `viewingCwd` 是【工作区轴】：托管 worktree 的实例归父仓
// （app/src/server/app.js 的 workspaceCwdOf + broadcastInstances，产品判据是「worktree 是临时模式、
// 不占抽屉条目」）。而 `instances[].cwd` 是【驾驶轴】，逐条如实下发。
//
// mock 此前两处都直接用实例 cwd，于是「工作区轴 ≠ 驾驶轴」这个形态在 E2E 里**根本不可达**：
// 前端拿 currentCwd（=viewingCwd）去拉 worktree 会话的历史本该失败，mock 却让它恒成功。
// 2026-09-13 真机撞到的正是这一格——reloadCurrentFromHistory 用 currentCwd，锁屏回来必然
// 「历史消息加载失败」，而全部 324 条 E2E 全绿。补上这条归组，那一格才照得出来。
const workspaceCwdOf = (cwd) => {
  const m = /^(.*)\/\.claude\/worktrees\/[^/]+$/.exec(cwd || '');
  return m ? m[1] : cwd;
};

function createDefaultInstances() {
  return [{
    instanceId: 'inst_1',
    cwd: '/Users/you/code/claude-chat-mobile',
    sessionId: 'mock-session-visual-test',
    title: 'Visual Sandbox (Main)',
    state: 'idle',
    permissionMode: 'default',
    effort: null,
    model: 'claude-3-5-sonnet',
    // 与真 server 的 instancesPayload 同形。给非零值：全 0 时前端整段隐藏，
    // 那样这个字段有没有传都看不出差别，E2E 也就守不住它。
    sideQuestionCalls: { suggestion: 3, recap: 1 }
  }];
}

const mockInstances = createDefaultInstances();
// 与真 server 对齐：没指定（effort=null）时 server 向 CLI 问来实际生效档，随 instances 与 effort_mode
// 下发（effortEffective / effective）。mock 没有 CLI，固定给一个值。挂在数组的 toJSON 上：85 处
// `instances: mockInstances` 广播经 socket.io 序列化时统一带上，不必逐个改创建点。
const MOCK_EFFORT_EFFECTIVE = 'medium';
const mockEffortEffective = effort => (effort == null ? MOCK_EFFORT_EFFECTIVE : null);
mockInstances.toJSON = function toJSON() {
  return this.map(inst => ({ ...inst, effortEffective: mockEffortEffective(inst.effort) }));
};

// 「已 send 但还没送达 SDK」的窄窗（真 server：send() 返回 true 后消息可能仍在 this.queue）。
// test:queue-drop 把消息收下但不回显、记在这里，等 user:interrupt 时走 queue_dropped 带 clientMessageIds。
let queuedUndeliveredClientMessageIds = [];
// 停过的后台任务 id：再停一次即回 ok:false（对齐真 server「任务已结束 → stopTask 返回 false」）。
const mockStoppedTaskIds = new Set();
// 一次性开关：让紧接着的那一次 session:history 走失败支。由 POST /__arm-history-error 置起。
let historyErrorArmed = false;
let pendingPermission = null;
let pendingQuestion = null;
let questSeq = 0; // 每次 test:question* 递增，避免 TC-5 答过后 TC-5b 同 requestId 被 answeredQuestionIds 吞掉
let syncPendingSnapshot = null; // Bug2：模拟真 server sync:since 的 ack.pending 快照（切入时重建待审批卡片）
let syncPendingSnapshotInstanceId = null;
let mockUnreadOnEntry = 0; // 未读角标：模拟真 server sync:since 的 ack.unreadOnEntry（切入时展示未读胶囊）
let mockUnreadOnEntryInstanceId = null;
let lateClosedSessionEventsInstanceId = null;
// 已被关闭、等着用例经 POST /__emit-late-closed-events 放出迟到事件的实例（见 session:close 处注释）。
let pendingLateClosedSessionEventsInstanceId = null;
let historyOverflowMode = false;
const deletedSessionIds = new Set(); // session:deletePermanent 后从列表剔除
// P3 抽屉局部重建 + SWR 保鲜回归夹具（test:reconnect-drawer-quiet / test:reconnect-drawer-refresh）：
// reconnectDrawerTitleChanged 让 mainCwdSessions() 返回改过名的主工作区会话标题，模拟"断线期间被自主
// 续跑改名"；reconnectSettleMarkerArmed 让下一次 connection handler 在 emitHydration() 之后再追加一条
// system 哨兵消息——E2E 用它确定性地等到"这次重连的 instances 广播已处理完"，不必用禁用的 waitForTimeout。
// session:list 行的时间基准。**必须是每次场景重置时钉死的常量，不能每次请求现算**：
// lastUsedAt 进 shouldRerenderSessionList 的行签名，若每次 session:list 都返回新的 Date.now()，
// 则「两次拉取之间数据没变」这个前提在 mock 下永远不成立——前端的省渲优化（内容没变就不重建
// DOM 子树）在 E2E 里被夹具单方面废掉，P0-11t/w/z 那组「不被连坐重建」的回归只在「恰好只发了
// 一次请求」时才碰巧通过。真实 server 的 lastUsedAt 取自 transcript 落盘时间，不会这样漂。
// 每次 /__reset 刷新，所以跨用例仍是「刚刚活跃过」，不会随 server 长跑越显越旧。
//
// 为什么要 +LEAD 而不是取 Date.now() 本身：R65（2026-08-30 需求合稿）未读的基线是【页面加载时刻】（parseUnreadState 用
// 首次加载的 now），而 /__reset 发生在 gotoMock 的 page.goto 之前。若基准就取 reset 时刻，偏移为
// 0 的「新活动」会话（mock-session-another）会落在基线之前，P0-11u 赖以成立的「基线后有活动＝亮
// 未读」当场失效。留一段前置量把它推到页面加载之后，同时旧会话（-600s 等）仍稳稳在基线之前。
const MOCK_LIST_CLOCK_LEAD_MS = 5_000;
let mockListClockBase = Date.now() + MOCK_LIST_CLOCK_LEAD_MS;
// 跨设备共享的已读位点（真 server 是 data/read-state.json）。baselineTs 必须钉在 reset 时刻、
// 即 mockListClockBase 之前 LEAD 那一段：它会【覆盖】前端本地基线，取得太晚会把偏移 0 的
// mock-session-another 压到基线之前，P0-11u 赖以成立的「基线后有活动＝亮未读」当场失效。
let mockReadState = null;
function resetReadState() {
  mockReadState = { baselineTs: mockListClockBase - MOCK_LIST_CLOCK_LEAD_MS, seen: {}, manual: {} };
}
resetReadState();
function readStateSnapshot() {
  return { baselineTs: mockReadState.baselineTs, seen: { ...mockReadState.seen }, manual: { ...mockReadState.manual } };
}
// session:list 搭车的裁剪版（同真 server 的 readStateForRows）。
function readStateForRows(rows) {
  const seen = {};
  const manual = {};
  for (const row of rows || []) {
    if (!row?.id) continue;
    if (mockReadState.seen[row.id] !== undefined) seen[row.id] = mockReadState.seen[row.id];
    if (mockReadState.manual[row.id] !== undefined) manual[row.id] = mockReadState.manual[row.id];
  }
  return { baselineTs: mockReadState.baselineTs, seen, manual };
}
// pinned（2026-09-08）：手动标「稍后再看」但被分页挤出本页的会话，服务端 session:list 单独补回。
// mock 必须一起实现——否则真 server 把这个字段删掉，E2E 照样全绿（这正是 ack 形状守卫存在的理由）。
// 判据与 read-state.js#manualUnreadIds 同义：manual[id] > seen[id]，缺 seen 算未读、相等算已读。
//
// 池 = 该 cwd 的全部 mock 会话。只有主 cwd 会截断（historyOverflowMode 下只回前 3 条），其余 cwd
// 全量返回，于是它们的 manual 标记必然在页内、pinned 恒空——与真 server 同构，不是偷懒。
function pinnedRowsFor(cwd, rows) {
  const inPage = new Set((rows || []).map(s => s && s.id));
  const pool = cwd === '/Users/you/code/claude-chat-mobile'
    ? mainCwdSessions().filter(s => !deletedSessionIds.has(s.id))
    : [];
  return pool.filter(s => s && s.id && !inPage.has(s.id)
    && (mockReadState.manual[s.id] ?? -Infinity) > (mockReadState.seen[s.id] ?? -Infinity));
}
// 逐 key 取较晚时间戳，与真 server 的 read-state.js#mergeLatest 同语义。
function mergeIntoReadState(field, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return;
  for (const [k, v] of Object.entries(incoming)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (!(k in mockReadState[field]) || v > mockReadState[field][k]) mockReadState[field][k] = v;
  }
}
let reconnectDrawerTitleChanged = false;
let reconnectSettleMarkerArmed = false;
// P0-11y（P1）：终端直跑状态夹具。真 server 由 listTerminalSessionStates 读 CLI 进程注册表
// （~/.claude/sessions/<PID>.json）给 session:list 行标 terminal:'busy'|'alive'；mock 直接给两条
// 无 live 实例的会话打上这两态，验证抽屉文字状态与来源副文本。
let terminalBadgeArmed = false;
// P0-11ag：第三态 terminal:'waiting'（CLI 卡在对话框上等人，含权限审批框）。与 badge 分开一个开关，
// 是因为它要断言的恰恰是「与 busy/alive 都不同形」——共用开关就没法在同一屏里对比三态。
let terminalWaitingArmed = false;
// 2026-09-06：桌面端 Code 模式（entrypoint=claude-desktop）驾驶的会话。与 terminalBadgeArmed 的
// 区别只在 terminalSource——状态轴相同，验的是渲染层是否按来源换措辞。
let desktopBadgeArmed = false;
// 2026-09-07：会话被 `claude agents` 的后台 job 独占。与上面几个 terminal 开关分开，因为它验的是
// 另一条轴——不是「谁在驾驶」，是「点了打不开」：session:list 行带 bgLocked，session:switch 直接拒。
let bgLockedArmed = false;
// 2026-09-13：会话所在的 worktree 目录被删掉了（模型自己 `git worktree remove` 之后的常见落点）。
// 真 server 侧靠 resolveGoneWorktreeParent 的 existsSync 判定，mock 没有文件系统，用开关模拟：
// 列表行带 worktreeGone、instances 里驾驶轴 cwd 仍悬空而 panelCwd 回落父仓、switch 直接拒。
let worktreeGoneArmed = false;
// P0-11z：抽屉保持打开时，第二次 session:list 才出现 terminal=busy；期间不发 instances，
// 验证前端低频 revalidate 能独立刷新 CLI 状态。
let terminalRefreshArmed = false;
let terminalRefreshListCount = 0;
let terminalSummaryOtherArmed = false;
// P0-11ai：terminalBusy 的孪生半边。同样是「返回行都不带 terminal，运行态只来自 cwd 级汇总」，
// 但汇总的是 waiting——它是两个字段里更要紧的那个（等人的终端点开就能去处理，在跑的只是环境感知），
// 却因为 server 的 ack 漏传而一直只能靠页内行回落显示。
let terminalSummaryOtherWaitingArmed = false;
let terminalRaceArmed = false;
let terminalRaceListCount = 0;
let terminalCloseRaceOtherArmed = false;
// P0-NOSID（2026-07-30 真机 bc29ccc2）：CLI 迟迟不吐 system/init 时，实例活着、事件在实时流，但
// server 侧还没有 sessionId，磁盘 transcript 也一条主链消息都没有。此时整页刷新若清屏改走
// session:history，换回来的是「会话不存在」→ 白屏。武装后 inst_1 的 sessionId 变 null（刷新后
// hydration 广播的还是它，故 flag 必须是模块级、不随连接重置），sync:since 照常回放 live 事件。
// 用 HTTP 端点而非 test:* 消息武装：整页刷新前后都得生效，且不需要先有一个能发消息的会话。
let noSessionIdMode = false;
// 握手不发 models 事件：复现真 server「该 cwd 无 models 缓存 → 不推、等 scout」的窗口。见 /__arm-no-models。
let noModelsMode = false;
// 服务状态面板「终端会话推送」段：安装态夹具（test:hooks-installed 拨到已装）
let mockHooksState = 'not-installed';
// statusline 桥默认未装：面板上「未装 · 安装」那条分支才走得到（已装态由 statusline:setup 切换）
let mockStatuslineState = 'not-installed';
// test:qr-access 拨到「受 Access 保护」档：那一档的码不含 token（判据在 public-target.js）
let mockAccessProtected = false;
// test:server-log-missing：拨到「日志文件不存在」档，验前端说清楚而不是给个看起来很干净的空列表
let mockServerLogMissing = false;
// test:auto-continue-*：instances 广播里的 autoContinue（真 server：src/server/auto-continue.js 的 snapshot，
// 按 sessionId 归键的额度墙「到点自动继续」横幅数据）。只由 broadcastAutoContinue 带出——其余十几处内联
// instances 载荷不带这个字段，前端对「缺字段」的约定正是保留上一份，所以不必逐处补。
let mockAutoContinue = [];
// WORKDIRS 的可变状态：env:set 收到数组时更新，后续 env:get 回显——
// 这样 E2E 验的是「提交的真是数组、且 sessionLimit 原样回来了」这条端到端语义，
// 而不只是「点了保存按钮」。收到非数组时**不更新**，正是真 server 校验会拒的那一档。
let mockWorkdirsList = [
  { path: '/Users/you/code/claude-chat-mobile' },
  { path: '/Users/you/code/other', sessionLimit: 3 },
];
// 审批规则样本：三档都有内容，且 deny 里放一条明显危险的——前端把 deny 显示成 allow 时 E2E 要能咬住
let mockPermissionRules = {
  allow: ['Bash(git status:*)', 'Read', 'Glob'],
  deny: ['Bash(rm -rf:*)'],
  ask: ['WebFetch'],
  total: 5,
};
// instances 广播里跨全场景共用的两个字段（canRestart / service）——真 server 在 emit 的那一刻由
// instancesPayload() 现算，所以这里也以**函数**形式交给场景模块，而不是传值。
// 传值会把取值冻在场景 run() 开头解构 context 的那一刻：一条活过自己 test 的异步尾巴（本 mock 里
// 确有此形态，2026-09-11 录到过迟到广播落在下一个用例页面上）就会带着旧值广播出去——譬如
// test:no-restart 刚把 canRestart 拨成 false，迟到的那条仍报 true，而 P0-31g 断言的正是
// 「立即重启」入口不存在。取函数＝取真 server 的时序，不必去赌这个窗口有多窄。
const getMockCanRestart = () => mockCanRestart;
// 真 server 的 instances 广播恒带 service 字段；mock 此前完全没带，导致依赖它的前端段落（如
// 配置面板「终端会话推送」）在 mock 下永远不渲染。这里补齐同形 payload。
const mockServicePayload = () => ({
  startedAt: mockServiceStartedAtOverride ?? MOCK_SERVICE_STARTED_AT,
  deliveryFailure: mockDeliveryFailure,
  rateLimitLockout: mockRateLimitLockout,
  clientError: mockClientError,
  hooksBridge: { state: mockHooksState, off: false },
  statuslineBridge: { state: mockStatuslineState, off: false },
});
let busySilentSwitchMode = false; // test:busy-silent-switch：inst_2 sync 只回放 user_message（触发 reload）、不发 result（模拟静默窗口）
// __reset 代数：每次 resetMockState 自增。user:message 进入时记下，await 醒来发现代数变了就收手。
// 否则上一条用例里还睡着的处理会在重置后醒来改【新】状态：test:slow-echo 的 2s 延迟跨过 __reset，醒来把
// 新 inst_1 的 turnSeq 加一、改写 activeEpoch，下一条用例的 stream-long 当场判定「被新回合取代」而停发——
// P0-04 间歇红的根因（2026-09-23 用 DEBUG=pw:webserver 成对跑 live-status-tail + long-stream-interrupt 实测）。
let mockResetGeneration = 0;
let orphanReplayArmed = false;    // test:busy-orphan-replay：inst_orphan 回放 user_message+text_delta 但【缺】配对 result（模拟终止事件遗失）
let orphanMixedArmed = false;     // test:busy-orphan-mixed：inst_orphan_mixed 回放【旧轮完整 FIFO + 当前轮 delta】，实例仍 busy
let foregroundSyncReplayMode = false;
let foregroundFoundMissingMode = false;
let foregroundFoundMissingHistoryMode = false;
// P0-SCROLL-1：切走 inst_2 再切回时验证「补发内容后强制落底」——第一次 sync:since 回放固定内容
// （建 DOM 缓存），第二次（切回）才追加"离开期间产生的新内容"模拟离开期间后台继续产出。
let switchBackReplayArmed = false;
// P0-REPLAY-BUFFER：回放缓冲——inst_replay_flood/inst_replay_small 同 inst_scroll_replay 的两段式
// 门控，但 sync:since 的"第几次调用"与 session:history 的"第几次调用"是两次独立的 socket 往返
// （ack 回来后客户端才会另发 session:history），必须用各自独立的 armed 标记，不能共用一个——
// 否则 sync:since 那次调用早把标记翻成 true，session:history 的"第一次"就会误读成"第二次"。
let replayFloodSyncArmed = false;   // false=冷入场 ack(0)；true=切回时推 165 条积压事件（超阈值 → reload）
let replayFloodHistoryArmed = false; // false=返回基线 4 条；true=返回 reload 专属标记文案（证明真走了 session:history）
// P0-REPLAY-SLOWACK：切回那次的 ack 晚于前端回放缓冲的 3s 超时才到（弱网）。只推迟 ack，积压照常先推。
let replayFloodSlowAck = false;
// P0-ORDER：复现「loadHistory 在途时镜像追平插队」的 DOM 顺序竞态。武装后，下一次 session:history
// 会先 emit 一条 history_append（模拟 catchUpTick 在 web 拉历史的窗口里检出终端新落定的消息，
// 该事件是 out-of-band、不进 replay buffer、任何时候直接渲染），再返回历史本体。
let historyOrderRaceArmed = false;
// P0-ACK-TIMEOUT：复刻「ACK 永不返回、但连接没断」。武装后，下一次 session:history 会先 emit 一条
// history_append（闸门此刻正扣着它），然后【故意不调用 callback】——前端 socket.timeout(15s) 到点走
// err 分支。这条被扣住的增量是它在客户端的唯一副本（out-of-band、不进 replay buffer，server 的
// catch-up 基线已前移），err 分支若 abort 就永久消失，且 abort 同时撤掉闸门 20s 看门狗，兜底也救不回。
// 【为什么不用断线来更快触发 err】断线会引发重连 + 全量历史加载，那条消息会从别的路径回到页面上，
// 测试就假绿了。要锁的恰恰是「连接未断的纯 ACK 超时」这一格，所以 15s 等待是本用例的固有成本。
let historyAckTimeoutArmed = false;
// P0-SYNC-ACK-TIMEOUT：武装「bindView 的 sync:since ack 永不返回、但连接没断」（F3/2026-08-06）。
// 裸 ack 断线时被 socket.io-client 的 _clearAcks() 静默丢弃，超时窗内则纯粹没人叫——两种情况下
// 回调都不执行，而加载卡收场与历史加载全挂在回调里。一次性：吞掉一次后自动解除，后续 sync 正常。
let syncAckTimeoutArmed = false;
// P0-12f：复现「显式新建之后，一条【在 session:new 之前就在途、之后才到】的 instances 包」。
// 这是 FE-001 那个分支唯一的激发条件，而 mock 原本从不产出这种包——session:new 只发一条
// viewingInstanceId=null 的权威包。于是 app.js 里 `!sessionIdClearedByNav` 那道守卫在整套 E2E 里
// 【不可达】：撤掉它测试照样全绿（2026-09-18 实测过三版用例，重填一次都没触发）。
//
// 武装后 session:new 的回应变成三段：
//   ① 延迟 STALE_INSTANCES_DELAY_MS 再发在途旧包（viewingInstanceId=旧实例、该实例仍带旧 sessionId）
//      —— 延迟是为了把「用户在新会话页打字」这一步留在旧包到达【之前】，那正是缺陷窗口的形状；
//   ② 紧接着发权威包（viewingInstanceId=null），它会让 bindView 拿 prev/new 去做草稿交换；
//   ③ 最后发一条 branch 为 STALE_PROBE_BRANCH 的 status_line 当【送达锚点】——socket.io 同一连接
//      保序，锚点上屏即证明 ①② 都已被前端处理完，用例不必 waitForTimeout（那也是禁止模式）。
let staleInstancesOnNextNew = false;
const STALE_INSTANCES_DELAY_MS = 900;
const STALE_PROBE_BRANCH = 'stale-probe-settled';
// P0-DUP-OPT：复现「在线乐观气泡 + 历史全量重载 = 同一条消息两颗气泡」。
// 武装后同时改三处，凑齐真实 server 上那条链所需的全部条件：
//   ① user:message 收到后立刻换实例并广播 instances（模拟实例被回收后的懒开）→ 前端 bindView；
//   ② sync:since 的 ack 带 diskLen 大于前端已渲染条数 → shouldReloadOnEnter 判 'reload'；
//   ③ session:history 的历史里【已经含有刚发出的那条用户消息】（真 server 一收到就写 transcript）。
// mock 此前从不回 diskLen，于是 'reload' 的 diskLen 分支在整套 E2E 里结构性照不出——这正是
// a417c08 的两条新用例（都只测新会话、无历史）漏掉这个回归的原因。
let dupOptimisticArmed = false;
const DUP_OPTIMISTIC_CMD = 'test:dup-optimistic';
const DUP_OPTIMISTIC_DELAY_MS = 2000;
let replaySmallSyncArmed = false;   // false=冷入场 ack(0)；true=切回时推 21 条积压事件（低于阈值 → flush）
// P0-SYNC-EXT：叠在 replaySmallSyncArmed 上。武装后第二次切回的 ack 按真 server 形状带 diskLen:null +
// diskExternalLen（有回放时外部写入只能靠它报）。「终端写入」在那次 sync:since 时才落到磁盘历史里
// （Written），首次冷切入拿到的仍是 4 条基线——否则首次加载就把它带回来了，测不出切回。
let replaySmallExternalArmed = false;
let replaySmallExternalWritten = false;
// P0-REPLAY-UNREAD-DISMISS：同 replaySmallSyncArmed 两段式门控，但第二次 ack 额外挂 unreadOnEntry——
// 验证回放缓冲程序性落底与未读胶囊自动确认已读的协同（不复用 mockUnreadOnEntry* 单例，见下方
// sync:since handler 内联的 extra.unreadOnEntry，自包含不受测试执行顺序影响）。
let replayUnreadSyncArmed = false;
let pendingDevices = [];
let trustedDevices = createTrustedDevices(); // 函数声明已提升；resetMockState 会重新填一份
// 真 server 的 accessBypassActive：CF Access 已启用且 DEVICE_APPROVAL_SCOPE !== 'all' 时为 true，
// 此时信任表管不到隧道进来的连接。默认 false（＝无 CF Access 的部署），由 /__access-bypass 翻转，
// 让 E2E 能覆盖脚注文案的两档——那句文案说错过一次，正是这段代码存在的理由。
let accessBypassActive = false;
let alwaysAllowedPermissionNamesByInstance = new Map();
let activeEpoch = 'mock-epoch-init';
let deniedDeviceRetryPending = false;
let mockSessionLogsByInstance = new Map();
let mockDiagLogsByInstance = new Map(); // 镜像/排队/停止诊断时间线（test:diag-sample 注入）
// 服务状态面板：确定性 startedAt（mock 进程启动时刻）；deliveryFailure 由 test:service-delivery-failure 注入，
// rateLimitLockout/clientError（判定化告警）由 test:service-incidents 注入
const MOCK_SERVICE_STARTED_AT = Date.now();

// 配置面板夹具。与 app/src/ops/env-schema.js 的 buildEnvView 同形状，但**手写一份**——
// 本 mock 刻意零 import app/src/（改 app/src/ 不该让 E2E 变红）。只放够断言的最小集：
// 一个只读敏感项、一个普通值、一个未设置的空值、一个可写敏感项、一个开关。
const mockLabel = (zh, en) => ({ zh, en });
function buildMockEnvView() {
  return {
    groups: [
      {
        id: 'auth',
        label: mockLabel('鉴权', 'Authentication'),
        items: [{
          key: 'AUTH_TOKEN', kind: 'readonly', label: mockLabel('访问令牌', 'Access token'),
          readonly: true, secret: true, masked: { set: true, length: 64 },
          help: mockLabel('要更换请在电脑上跑 npm run setup。', 'Run npm run setup on the machine to rotate it.'),
        }],
      },
      {
        id: 'runtime',
        label: mockLabel('运行时', 'Runtime'),
        items: [
          { key: 'PORT', kind: 'number', label: mockLabel('监听端口', 'Port'), readonly: false, secret: false, value: '3000', min: 1, max: 65535 },
          { key: 'CLAUDE_BIN', kind: 'path', label: mockLabel('claude 可执行文件', 'claude binary'), readonly: false, secret: false, value: '/Users/you/bin/claude' },
          // list 档：value 恒为空串（真 server 的 projectToEnv 对 list 明确放弃投影），
          // 当前值走 item.list 旁路。第二条带 sessionLimit——前端只编路径，但必须原样带回去。
          {
            key: 'WORKDIRS', kind: 'list', label: mockLabel('工作区列表', 'Workspaces'),
            readonly: false, secret: false, value: '',
            list: mockWorkdirsList,
          },
        ],
      },
      {
        id: 'push',
        label: mockLabel('推送', 'Notifications'),
        items: [
          { key: 'VAPID_PRIVATE_KEY', kind: 'secret', label: mockLabel('VAPID 私钥', 'VAPID private key'), readonly: false, secret: true, masked: { set: true, length: 43 } },
          { key: 'NTFY_TOPIC', kind: 'text', label: mockLabel('ntfy topic', 'ntfy topic'), readonly: false, secret: false, value: '' },
        ],
      },
      {
        id: 'toggles',
        label: mockLabel('功能开关', 'Feature toggles'),
        items: [{
          key: 'DEV_MODE', kind: 'toggle', label: mockLabel('开发者模式', 'Developer mode'),
          readonly: false, secret: false, value: '1', values: { on: '1', off: '' },
        }],
      },
    ],
    readonlyDiagnostics: [{
      key: 'ANTHROPIC_*',
      label: mockLabel('模型网关配置', 'Model gateway config'),
      help: mockLabel('只能从启动 shell export，.env 里的会被剥除。', 'Must come from the launching shell.'),
    }],
  };
}
// P0-DESTROY-6（server 重启误报「会话已中断」修复）：test:server-restart 用它把 service.startedAt
// 拨到另一个值，模拟「重连后是另一个 server 进程」——前端 detectServerRestart 据此把「实例全部
// 消失」判为整机重启而非单实例被摧毁。null = 未拨（正常返回进程级常量）。
let mockServiceStartedAtOverride = null;
let mockDeliveryFailure = null;
let mockRateLimitLockout = null;
let mockClientError = null;
const DEFAULT_MOCK_RESTARTS = {
  units: [{ label: 'com.ccm.tunnel', lastHour: 0, last24h: 1, flapping: false, lastRestartAt: MOCK_SERVICE_STARTED_AT - 7200000 }],
  recent: [{ ts: MOCK_SERVICE_STARTED_AT - 7200000, label: 'com.ccm.tunnel', kind: 'restarted' }],
};
let mockRestarts = DEFAULT_MOCK_RESTARTS;
// canRestart：默认 true（常驻托管，配置面板给「立即重启」按钮）。
// false 那一侧此前**零覆盖**——三处广播全硬编码 true，于是「本进程不是常驻托管，请到电脑上重启」
// 这句从没被渲染过，把它删掉全套 E2E 照样绿。由 test:no-restart 场景翻转。
let mockCanRestart = true;

function resetMockState() {
  mockResetGeneration += 1;
  mockServiceStartedAtOverride = null;
  mockDeliveryFailure = null;
  mockRateLimitLockout = null;
  mockClientError = null;
  mockRestarts = DEFAULT_MOCK_RESTARTS;
  mockCanRestart = true;
  viewingInstanceId = 'inst_1';
  permissionMode = 'default';
  effortLevel = null;
  activeModel = 'claude-3-5-sonnet';
  pendingFreshPermissionMode = undefined;
  pendingFreshEffortLevel = undefined;
  pendingFreshCwd = undefined;
  mockInstances.splice(0, mockInstances.length, ...createDefaultInstances());
  pendingPermission = null;
  pendingQuestion = null;
  trustedDevices = createTrustedDevices();
  accessBypassActive = false;
  queuedUndeliveredClientMessageIds = [];
  mockStoppedTaskIds.clear();
  historyErrorArmed = false;
  syncPendingSnapshot = null;
  syncPendingSnapshotInstanceId = null;
  mockUnreadOnEntry = 0;
  mockUnreadOnEntryInstanceId = null;
  lateClosedSessionEventsInstanceId = null;
  pendingLateClosedSessionEventsInstanceId = null;
  historyOverflowMode = false;
  deletedSessionIds.clear();
  mockListClockBase = Date.now() + MOCK_LIST_CLOCK_LEAD_MS;
  resetReadState(); // 必须排在 mockListClockBase 之后：基线由它推算
  reconnectDrawerTitleChanged = false;
  reconnectSettleMarkerArmed = false;
  terminalBadgeArmed = false;
  terminalWaitingArmed = false;
  desktopBadgeArmed = false;
  bgLockedArmed = false;
  worktreeGoneArmed = false;
  terminalRefreshArmed = false;
  terminalRefreshListCount = 0;
  terminalSummaryOtherArmed = false;
  terminalSummaryOtherWaitingArmed = false;
  terminalRaceArmed = false;
  terminalRaceListCount = 0;
  terminalCloseRaceOtherArmed = false;
  noSessionIdMode = false;
  noModelsMode = false;
  mockHooksState = 'not-installed';
  mockStatuslineState = 'not-installed';
  mockAccessProtected = false;
  mockServerLogMissing = false;
  mockAutoContinue = [];
  mockWorkdirsList = [
    { path: '/Users/you/code/claude-chat-mobile' },
    { path: '/Users/you/code/other', sessionLimit: 3 },
  ];
  mockPermissionRules = {
    allow: ['Bash(git status:*)', 'Read', 'Glob'],
    deny: ['Bash(rm -rf:*)'],
    ask: ['WebFetch'],
    total: 5,
  };
  busySilentSwitchMode = false;
  orphanReplayArmed = false;
  orphanMixedArmed = false;
  foregroundSyncReplayMode = false;
  foregroundFoundMissingMode = false;
  foregroundFoundMissingHistoryMode = false;
  switchBackReplayArmed = false;
  replayFloodSyncArmed = false;
  replayFloodHistoryArmed = false;
  replayFloodSlowAck = false;
  historyOrderRaceArmed = false;
  historyAckTimeoutArmed = false;
  syncAckTimeoutArmed = false;
  // 漏归零过：同进程里 optimistic-bubble-history-dup 跑过之后，它一直 true，sync:since 分支里排在
  // 上面的 DUP-OPT 分支抢先回 diskLen=11，P0-SYNC-ACK-TIMEOUT 的「吞 ack」永远走不到——那条用例
  // 同片时 1.2s 假绿（单跑要真等 15s）。
  dupOptimisticArmed = false;
  staleInstancesOnNextNew = false;
  replaySmallSyncArmed = false;
  replaySmallExternalArmed = false;
  replaySmallExternalWritten = false;
  replayUnreadSyncArmed = false;
  pendingDevices = [];
  alwaysAllowedPermissionNamesByInstance = new Map();
  activeEpoch = 'mock-epoch-init';
  deniedDeviceRetryPending = false;
  mockSessionLogsByInstance = new Map();
  mockDiagLogsByInstance = new Map();
}

function pendingFreshPermissionOrDefault() {
  return pendingFreshPermissionMode === undefined ? 'default' : pendingFreshPermissionMode;
}

function pendingFreshEffortOrDefault() {
  return pendingFreshEffortLevel === undefined ? null : pendingFreshEffortLevel;
}

function consumeFreshPrefs() {
  const prefs = {
    permissionMode: pendingFreshPermissionOrDefault(),
    effort: pendingFreshEffortOrDefault()
  };
  pendingFreshPermissionMode = undefined;
  pendingFreshEffortLevel = undefined;
  return prefs;
}

function addMockSessionLog(instanceId, text, type = 'sys_info') {
  const inst = mockInstances.find(i => i.instanceId === instanceId);
  const entry = {
    ts: Date.now(),
    type,
    text,
    model: inst?.model || activeModel,
    effort: inst?.effort || 'model-default',
    permissionMode: inst?.permissionMode || permissionMode
  };
  const logs = mockSessionLogsByInstance.get(instanceId) || [];
  logs.push(entry);
  if (logs.length > 100) logs.shift();
  mockSessionLogsByInstance.set(instanceId, logs);
  io.emit('agent:event', {
    seq: 0,
    epoch: 'server',
    sessionId: inst?.sessionId || null,
    instanceId,
    cwd: inst?.cwd,
    ts: entry.ts,
    type: 'session_log',
    payload: entry
  });
  return entry;
}

// 镜像/排队/停止诊断时间线（真 server: app/src/agent/diag-log.js）的 mock 同款——同一 seq:0/epoch:'server'
// 旁路广播，供 test:diag-sample 场景注入合成事件，验证 console modal 三态过滤 + formatDiagLogEntry 渲染。
function addMockDiagLog(instanceId, subsystem, event, detail = {}) {
  const inst = mockInstances.find(i => i.instanceId === instanceId);
  const entry = { ts: Date.now(), subsystem, event, detail };
  const logs = mockDiagLogsByInstance.get(instanceId) || [];
  logs.push(entry);
  if (logs.length > 100) logs.shift();
  mockDiagLogsByInstance.set(instanceId, logs);
  io.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: inst?.sessionId || null, instanceId, cwd: inst?.cwd,
    ts: entry.ts, type: 'diag_log', payload: entry
  });
  return entry;
}

function openFreshMockInstance(requestedModel) {
  const freshId = 'inst_fresh';
  const freshPrefs = consumeFreshPrefs();
  const freshModel = requestedModel || activeModel;
  const freshCwd = pendingFreshCwd
    || mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd
    || mockInstances[0]?.cwd
    || '/Users/you/code/claude-chat-mobile';
  pendingFreshCwd = undefined;
  let freshInst = mockInstances.find(i => i.instanceId === freshId);
  if (!freshInst) {
    freshInst = {
      instanceId: freshId,
      cwd: freshCwd,
      sessionId: null,
      title: null,
      state: 'busy',
      permissionMode: freshPrefs.permissionMode,
      effort: freshPrefs.effort,
      model: freshModel
    };
    mockInstances.push(freshInst);
  } else {
    Object.assign(freshInst, {
      state: 'busy',
      cwd: freshCwd,
      permissionMode: freshPrefs.permissionMode,
      effort: freshPrefs.effort,
      model: freshModel
    });
  }
  viewingInstanceId = freshId;
  permissionMode = freshPrefs.permissionMode;
  effortLevel = freshPrefs.effort;
  activeModel = freshModel;
  return freshInst;
}

// 待审设备（真 server 的 device-gate.pendingDevicesPayload 的对位）。同下面 createTrustedDevices：
// **载荷里没有全量 token，只有 shortId**（DEVICE-03），批准/拒绝也按 shortId 寻址。
function createPendingDeviceRequests() {
  return [
    { shortId: 'aabbccdd…1501', ip: '192.168.1.100', userAgent: 'Mozilla/5.0 iPhone', ts: Date.now() - 30000 },
    { shortId: 'eeff0011…0a02', ip: '192.168.1.101', userAgent: 'Mozilla/5.0 iPad', ts: Date.now() - 60000 }
  ];
}

function emitPendingDevices() {
  io.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
    type: 'pending_devices', payload: { devices: pendingDevices }
  });
}

// 已受信任设备（真 server 的 device-gate.trustedDevicesPayload 的对位）。
// **载荷里没有全量 token，只有 shortId** —— DEVICE-03，形状必须与真 server 一致，
// 否则前端在 E2E 里读到的字段和生产不是一回事（本仓踩过：mock 是平行实现，
// 删掉真 server 的字段 E2E 照样全绿）。
// isCurrent 固定钉在第三条：E2E 要能覆盖「当前这台不给吊销按钮」那一支，
// 而 mock 侧没有真实的 deviceToken 可比。
function createTrustedDevices() {
  return [
    // ① 有别名：别名压过一切自动信息
    { shortId: 'a3f21b09…a4b5', kind: 'iPhone', browser: 'Safari 18', model: null, alias: '客厅平板', ua: 'Mozilla/5.0 (iPhone)', ip: '192.168.1.5', approvedAt: Date.now() - 5 * 86400000, isCurrent: false },
    // ② approvedAt=null：本功能上线【之前】批准的条目，前端显示「无批准记录」而不是编个时间
    { shortId: '7e6d1122…3ede', kind: '未知设备', browser: null, model: null, alias: null, ua: null, ip: null, approvedAt: null, isCurrent: false },
    // ③ 当前这台。机型 null 是常态（Chrome 冻结了 UA 的机型位），标题只拼类型与浏览器
    { shortId: 'cd2760a5…ec82', kind: 'Mac', browser: 'Chrome 152', model: null, alias: null, ua: 'Mozilla/5.0 (Macintosh)', ip: '127.0.0.1', approvedAt: Date.now() - 3600000, isCurrent: true },
  ];
}

function emitTrustedDevices() {
  io.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
    type: 'trusted_devices', payload: { accessBypassActive, devices: trustedDevices }
  });
}

app.post('/__reset', (_req, res) => {
  resetMockState();
  res.json({ ok: true });
});

// E2E 专用：翻转 accessBypassActive，覆盖信任列表脚注的两档文案。
app.post('/__access-bypass', (req, res) => {
  accessBypassActive = req.query?.active === '1';
  emitTrustedDevices();
  res.json({ ok: true, accessBypassActive });
});

// 真 server 在该 cwd 无 models 缓存时刻意不推 models（pushModelsForCwd 的 `if (!p) return`——推空会
// 摧毁前端网格），改由 openScoutInstance 起进程去取。首次连接 / 新工作区到 scout 返回之间，前端
// modelsList 就是初值 []（localStorage 里没有 models 缓存）。武装后握手不发 models 事件，复现该窗口。
// 同 noSessionIdMode：flag 必须模块级，整页刷新后仍生效。
app.post('/__arm-no-models', (_req, res) => {
  noModelsMode = true;
  res.json({ ok: true });
});

// 跨设备已读位点：模拟「这个会话已经在另一台设备上读过了」——直接往服务端共享位点写一条 seen。
// 本设备的 localStorage 里没有任何该会话的记录，正是换设备后的真实处境。
// 服务端共享位点的读出面，供 E2E 断言「本机的已读/标记确实上报了」——真 server 那边这是
// read:sync 的 ack，但前端 socket 不挂在 window 上，从测试里发不出去。
app.get('/__read-state', (_req, res) => {
  res.json(readStateSnapshot());
});

// 走 query string：这个 mock server 没装 body parser（其余 __arm-* 端点全是无参的）。
app.post('/__arm-read-elsewhere', (req, res) => {
  const sessionId = req.query?.sessionId;
  if (!sessionId) return res.status(400).json({ ok: false });
  mockReadState.seen[sessionId] = mockListClockBase + 60_000; // 晚于该行 lastUsedAt
  res.json({ ok: true });
});

// 让紧接着的一次 session:history 回失败形态 { messages: [], error }——真 server 在 jsonl 被删/改名/
// 读坏时就是这个形状。无参，一次性消费。
app.post('/__arm-history-error', (_req, res) => {
  historyErrorArmed = true;
  res.json({ ok: true });
});

// P0-11o / P0-13e：发出「关闭的那个实例的迟到事件」。由用例在【确认视图切换已完成之后】显式调用，
// 理由见 session:close 里 pendingLateClosedSessionEventsInstanceId 处的注释（时间驱动会让事件被
// shouldDropAgentEvent 或 replayBuffer 的 'reload' 丢掉，且不重发）。
// 一次性消费；没有待发实例时回 ok:false，让用例在「武装没生效」时当场红，而不是静默空跑。
app.post('/__emit-late-closed-events', (_req, res) => {
  const instanceId = pendingLateClosedSessionEventsInstanceId;
  if (!instanceId) { res.status(409).json({ ok: false, error: 'no pending late-closed events' }); return; }
  pendingLateClosedSessionEventsInstanceId = null;
  emitLateClosedSessionEvents(instanceId);
  res.json({ ok: true, instanceId });
});

// P0-NOSID：把当前查看实例拨成「活着但还没有 sessionId」（CLI 未吐 init）。见 noSessionIdMode 注释。
app.post('/__arm-no-session-id', (_req, res) => {
  noSessionIdMode = true;
  const inst = mockInstances.find(i => i.instanceId === 'inst_1');
  if (inst) { inst.sessionId = null; inst.state = 'busy'; }
  res.json({ ok: true });
});

// P0-17i 的镜像三态改由用例【显式推进】，不再靠 mock 侧的定时器串起来（理由见 scenarios/status.js
// 的 test:mirror）。body: { readonly, stale, withResult }——withResult 时补一条 result 让 waitForIdle 收口。
// 逐条写成字面量、type 不走变量：agent-event-contract 的扫描器是静态的，把 type 收进辅助函数的形参
// 会让它报 dynamic_type。
app.post('/__mirror-state', (req, res) => {
  // 走 query 不走 body：本 mock 没装 express.json()，既有 __ 端点（__access-bypass /
  // __arm-read-elsewhere）也都读 req.query。用 body 会静默拿到 undefined 再落到默认值上——
  // 端点照样回 200，事件却发的是上一态，症状是断言等一个永远不来的状态（本次就踩了一遍）。
  const readonly = req.query?.readonly !== '0';
  const stale = req.query?.stale === '1';
  const withResult = req.query?.withResult === '1';
  io.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId,
    ts: Date.now(), type: 'mirror_state',
    payload: { readonly, stale, cliSeen: true },
  });
  if (withResult) {
    io.emit('agent:event', {
      seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId,
      ts: Date.now(), type: 'result',
      payload: { messageId: 'msg_mirror_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] },
    });
  }
  res.json({ ok: true });
});

// P0-NOSID 后半段：CLI 终于吐了 init——实例还是同一个（viewingInstanceId 不变，前端不会重新 bindView），
// 只是 instances 广播里多了 sessionId。验证前端此时把 composer 同步出来（真机 c1ccd055：内容回来了但
// 输入条再也不出现，因为 setInstances 里只有 pill 两处是无条件同步的，composer 漏了）。
app.post('/__resolve-session-id', (_req, res) => {
  noSessionIdMode = false; // 之后 session:history 恢复常规分支（磁盘此时也已落盘）
  const inst = mockInstances.find(i => i.instanceId === 'inst_1');
  if (inst) inst.sessionId = 'mock-session-visual-test';
  io.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
    type: 'instances', payload: { canRestart: mockCanRestart,
      viewingInstanceId,
      viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd),
      dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
      instances: mockInstances, service: mockServicePayload()
    }
  });
  res.json({ ok: true });
});

// 带 autoContinue 的 instances 广播（真 server 的 instancesPayload 恒带该字段）。
function broadcastAutoContinue() {
  io.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
    type: 'instances', payload: { canRestart: mockCanRestart,
      viewingInstanceId,
      viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd),
      dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
      instances: mockInstances, service: mockServicePayload(),
      autoContinue: mockAutoContinue,
    },
  });
}

// Helper to delay executions to simulate streaming behavior
const delay = ms => new Promise(res => setTimeout(res, ms));

// test:slow-echo 的回显延迟：模拟真实 server 在 emit user_message 之前那段前置慢路径（见 user:message
// handler 里的用法）。取值须显著大于 spec 侧断言用的 timeout，两者拉开倍数余量，否则慢机器上会 flaky。
const SLOW_ECHO_DELAY_MS = 2000;

function emitLateClosedSessionEvents(closedInstanceId) {
  const staleSessionId = 'mock-session-closed-stale';
  const staleEpoch = 'mock-epoch-closed-stale';
  const staleCwd = '/Users/you/code/claude-chat-mobile';
  const ts = Date.now();

  io.emit('agent:event', {
    seq: 1, epoch: staleEpoch, sessionId: staleSessionId, instanceId: closedInstanceId, ts,
    type: 'tool_use', payload: { toolUseId: 't_closed_session_stale', name: 'run_command', inputSummary: 'rm -rf /tmp/closed-session-stale' }
  });
  io.emit('agent:event', {
    seq: 2, epoch: staleEpoch, sessionId: staleSessionId, instanceId: closedInstanceId, ts: ts + 1,
    type: 'text_delta', payload: { messageId: 'msg_closed_session_stale', text: 'STALE CLOSED SESSION TEXT MUST NOT RENDER' }
  });
  io.emit('agent:event', {
    seq: 3, epoch: staleEpoch, sessionId: staleSessionId, instanceId: closedInstanceId, ts: ts + 2,
    type: 'permission_request', payload: {
      requestId: 'req_closed_session_stale',
      name: 'run_command',
      input: 'rm -rf /tmp/closed-session-stale',
      cwd: staleCwd,
      ...mockPermFields('run_command', 'rm -rf /tmp/closed-session-stale', staleCwd)
    }
  });
  io.emit('agent:event', {
    seq: 4, epoch: staleEpoch, sessionId: staleSessionId, instanceId: closedInstanceId, ts: ts + 3,
    type: 'question', payload: {
      requestId: 'req_closed_session_stale_question#0',
      text: 'This closed session question must not appear',
      options: ['main', 'dev', 'release-v1.0']
    }
  });
  io.emit('agent:event', {
    seq: 5, epoch: staleEpoch, sessionId: staleSessionId, instanceId: closedInstanceId, ts: ts + 4,
    type: 'result', payload: { messageId: 'msg_closed_session_stale', durationMs: 250, costUsd: 0, isError: false, models: [activeModel] }
  });

  const current = mockInstances.find(i => i.instanceId === viewingInstanceId);
  if (!current) return;
  io.emit('agent:event', {
    seq: 1, epoch: 'mock-epoch-current-after-closed-stale', sessionId: current.sessionId, instanceId: current.instanceId, ts: Date.now(),
    type: 'system', payload: { message: '[MOCK_INFO] Closed-session stale replay finished for current view.' }
  });
}

function mainCwdSessions() {
  const sessions = [
    {
      id: 'mock-session-visual-test',
      // P3 抽屉局部重建回归：断线期间"自主续跑"改了标题，reconnect 后 session:list 应该带新标题——
      // 见 reconnectDrawerTitleChanged 顶部注释 + test:reconnect-drawer-refresh。
      title: reconnectDrawerTitleChanged ? 'Renamed After Reconnect' : 'Visual Sandbox (Main)',
      model: 'claude-3-5-sonnet',
      lastUsedAt: mockListClockBase - 10000,
      entrypoint: 'sdk-ts',
      ...(desktopBadgeArmed ? { terminal: 'busy', terminalSource: 'claude-desktop' }
        : terminalBadgeArmed ? { terminal: 'busy', terminalSource: 'cli' } : {}),
    },
    {
      id: 'mock-session-archived',
      title: 'Archived Planning Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: mockListClockBase - 600000,
      entrypoint: 'sdk-ts',
      ...(terminalWaitingArmed ? { terminal: 'waiting', terminalSource: 'cli' }
        : desktopBadgeArmed ? { terminal: 'busy', terminalSource: 'claude-desktop' }
          : terminalBadgeArmed ? { terminal: 'busy', terminalSource: 'cli' } : {}),
    },
    {
      // 工作区轴 ≠ 驾驶轴：会话在父仓开、中途 EnterWorktree 进 .claude/worktrees/<name>，
      // transcript 随之迁到新 cwd 的 project 目录。列表项的 cwd 是驾驶轴（真 server 的
      // listSessions 扫盘给的就是 worktree 路径），而 viewingCwd 仍归父仓。
      id: 'mock-session-worktree',
      title: 'Worktree Driving Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: mockListClockBase - 760000,
      cwd: '/Users/you/code/claude-chat-mobile/.claude/worktrees/wt-x',
      worktree: 'wt-x',
      // 那棵树被删掉之后行为整个不同：行上要标已删、点开要拒。真 server 靠 existsSync 判，
      // mock 用开关模拟（判据见 app/src/sessions/history.js 的 listManagedWorktreeDirs）。
      ...(worktreeGoneArmed ? { worktreeGone: true } : {}),
      entrypoint: 'sdk-ts'
    },
    {
      id: 'mock-session-gap',
      title: 'Archived Gap Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: mockListClockBase - 750000,
      ...(bgLockedArmed ? { terminal: 'alive', terminalSource: 'cli', bgLocked: true }
        : desktopBadgeArmed ? { terminal: 'alive', terminalSource: 'claude-desktop' }
          : terminalBadgeArmed || terminalWaitingArmed ? { terminal: 'alive', terminalSource: 'cli' } : {}),
      entrypoint: 'sdk-ts'
    },
    {
      id: 'mock-session-deleted',
      title: 'Deleted Remote Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: mockListClockBase - 900000,
      entrypoint: 'sdk-ts'
    },
    {
      id: 'mock-session-long-history',
      title: 'Long History Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: mockListClockBase - 1200000,
      entrypoint: 'sdk-ts'
    }
  ];
  if (historyOverflowMode) {
    sessions.push({
      id: 'mock-session-older-migration',
      title: 'Older Migration Session',
      model: 'claude-3-5-sonnet',
      lastUsedAt: mockListClockBase - 2400000,
      entrypoint: 'sdk-ts'
    });
  }
  // P0-TS：消息流时间戳专用会话。历史跨前天/昨天/今天三天，覆盖 day 行、time 行、
  // 同轮抑制、工具卡与子 agent 正文不参与——期望值见 message-timestamps.spec.ts。
  sessions.push({
    id: 'mock-session-timeline',
    title: 'Timeline Session',
    model: 'claude-3-5-sonnet',
    lastUsedAt: mockListClockBase - 1300000,
    entrypoint: 'sdk-ts'
  });
  // 合卡的历史侧专用会话：主链一次 Agent spawn + 它的 sidechain 子流 + tool_result。
  // 【为什么不挂进 Timeline Session】那份 fixture 顶上有一张精确到「第几条出 day/time 行」的
  // 对照表（message-timestamps.spec.ts 逐条断言），多塞两条消息会把它整片打红。
  sessions.push({
    id: 'mock-session-subagent-history',
    title: 'Subagent History Session',
    model: 'claude-3-5-sonnet',
    lastUsedAt: mockListClockBase - 1400000,
    entrypoint: 'sdk-ts'
  });
  return sessions;
}

// E18 附件预览：attachment:read base64 分片的附件 fixture——1×1 PNG，覆盖 live meta（storedName）
// 与历史 [附件] 解析两条点击路径；不在 Map 里的 storedName 走 ok:false（文件已删降级路径）。
const MOCK_ATTACH_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const MOCK_UPLOAD_FILES = new Map([
  ['1700000000000-abcd1234-photo.png', MOCK_ATTACH_PNG],
  ['1700000000001-deadbeef-old.png', MOCK_ATTACH_PNG],
]);


io.on('connection', socket => {
  console.log(`[mock-conn] Socket connected: ${socket.id}`);

  if (deniedDeviceRetryPending) {
    deniedDeviceRetryPending = false;
    socket.deviceApproved = false;
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'device_status', payload: { status: 'pending', deviceId: 'unauthorized-fingerprint-999' }
    });
    return;
  }

  // Auto-approve socket for standard testing (simulates local trust)
  socket.deviceApproved = true;

  // 真 server 在可信端连入时重放已受信任设备列表（app.js 的 unlockSocket 之后那两条 emit）。
  // 不重放的话「设置 › 🔐 接入与设备 › 已受信任的设备」在 E2E 里恒为空段，那一整块不可测。
  socket.emit('agent:event', {
    seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
    type: 'trusted_devices', payload: { accessBypassActive, devices: trustedDevices }
  });

  // Replay initial hydration events
  const emitHydration = () => {
    // 1. init
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'init', payload: {
        model: activeModel,
        cwd: mockInstances[0].cwd,
        claudeVersion: '0.1.0-mock',
        // 一正常一失败：让「宿主机」页的 MCP 段两条渲染分支都走得到（失败态要带原始 status）
        mcpServers: [
          { name: 'filesystem', status: 'connected' },
          { name: 'postgres', status: 'failed' }
        ],
        skillsCount: 7,
        permissionMode: permissionMode,
        slashCommands: [
          { name: 'help', description: 'Show help guide' },
          { name: 'model', description: 'Switch active model' },
          { name: 'effort', description: 'Adjust Claude thinking effort' },
          // terminal 绑定命令：故意留在 slashCommands 里（真 SDK 也是这样——terminal_slash_commands
          // 是 slash_commands 的【子集】，不是从中剔除后的补集）。前端负责在补全菜单里滤掉它。
          { name: 'color', description: 'Set the prompt bar color for this session' }
        ],
        terminalSlashCommands: ['color']
      }
    });

    // 2. models（noModelsMode 武装时整条不发——复现真 server 无缓存不推、等 scout 的窗口）
    if (!noModelsMode) socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'models', payload: {
        models: [
          { value: 'default', displayName: 'Default (recommended)' }, // CLI /model 列表首项（不 pin，由 CLI 自选）；空首页高亮它代替旧 data-model="" 伪默认磁贴
          { value: 'claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] }, // xhigh：暴露 ultracode 最高档供视觉 E2E（真实档位由网关/CLI 报）
          { value: 'claude-3-5-haiku', displayName: 'Claude 3.5 Haiku' },
          { value: 'claude-3-opus', displayName: 'Claude 3 Opus' },
          { value: 'claude-3-opus[1m]', displayName: 'Claude 3 Opus (1m Context)', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] } // xhigh：真实 opus 支持，暴露 ultracode 档
        ]
      }
    });

    // 3. permission_mode
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, ts: Date.now(),
      type: 'permission_mode', payload: { mode: permissionMode }
    });

    // 4. effort_mode
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, ts: Date.now(),
      type: 'effort_mode', payload: { level: effortLevel, effective: mockEffortEffective(effortLevel) }
    });

    // 5. instances
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: { canRestart: mockCanRestart,
        viewingInstanceId,
        viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd),
        dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
        instances: mockInstances, service: mockServicePayload()
      }
    });

    // 6. status_line initial (structured format)
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'status_line', payload: {
        model: 'claude-3-5-sonnet',
        project: 'claude-chat-mobile',
        cwd: '/Users/you/code/claude-chat-mobile',
        git: { branch: 'main', changed: 0, ahead: 0, behind: 0 },
        ctx: { tokens: 12500, cacheHitPct: 5 },
        cost: 0.00
      }
    });
  };

  emitHydration();

  // P3 抽屉局部重建回归夹具：本次（re）连接是断线重连测试武装的，emitHydration() 的 instances 广播
  // 已经在上面同步发出去了——socket.io 单连接内消息严格按发送顺序送达，客户端必然先处理完 instances
  // 广播才会收到并渲染这条哨兵 system 消息。E2E 等它出现，即可确定性地知道"这次重连触发的面板判定
  // 已经跑完"，不需要引入被 npm run check 禁掉的 waitForTimeout。一次性：消费后立即回落，避免后续
  // 普通重连也带上它。seq 必须大于武装它的那条 test:reconnect-drawer-* 命令已用过的最高 seq（该命令
  // 的 result 事件用了 seq:2，同 epoch 未变）——event-dispatch.js 的去重逻辑按 (epoch, seq) 判定，
  // seq 不严格递增会被判成"重复/陈旧事件"直接丢弃、客户端根本看不到（曾在此踩坑：用 seq:1 被吞）。
  if (reconnectSettleMarkerArmed) {
    reconnectSettleMarkerArmed = false;
    socket.emit('agent:event', {
      seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
      type: 'system', payload: { message: '[MOCK_INFO] Reconnect drawer settle marker.' }
    });
  }

  // Handle setting permission mode
  socket.on('user:setPermissionMode', payload => {
    const { mode, instanceId } = payload || {};
    console.log(`[mock] Set permission mode: ${mode} for ${instanceId}`);
    if (mode) {
      permissionMode = mode;
      if (!instanceId && viewingInstanceId === null) pendingFreshPermissionMode = mode;
      const targetInstanceId = instanceId || viewingInstanceId;
      const inst = mockInstances.find(i => i.instanceId === targetInstanceId);
      if (inst) inst.permissionMode = mode;
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, instanceId: targetInstanceId, ts: Date.now(),
        type: 'permission_mode', payload: { mode }
      });
      // Broadcast instances update
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart,
          viewingInstanceId,
          viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd),
          dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
          instances: mockInstances, service: mockServicePayload(),
          defaultPermissionMode: viewingInstanceId === null ? pendingFreshPermissionOrDefault() : undefined,
          defaultEffort: viewingInstanceId === null ? pendingFreshEffortOrDefault() : undefined
        }
      });
    }
  });

  // Handle setting thinking effort
  socket.on('user:setEffort', payload => {
    const { level, instanceId } = payload || {};
    console.log(`[mock] Set thinking effort: ${level} for ${instanceId}`);
    effortLevel = level;
    if (!instanceId && viewingInstanceId === null) pendingFreshEffortLevel = level ?? null;
    const targetInstanceId = instanceId || viewingInstanceId;
    const inst = mockInstances.find(i => i.instanceId === targetInstanceId);
    if (inst) inst.effort = level;
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, instanceId: targetInstanceId, ts: Date.now(),
      type: 'effort_mode', payload: { level, effective: mockEffortEffective(level) }
    });
    // Broadcast instances update
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: { canRestart: mockCanRestart,
        viewingInstanceId,
        viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd),
        dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
        instances: mockInstances, service: mockServicePayload(),
        defaultPermissionMode: viewingInstanceId === null ? pendingFreshPermissionOrDefault() : undefined,
        defaultEffort: viewingInstanceId === null ? pendingFreshEffortOrDefault() : undefined
      }
    });
  });

  // Handle active viewing tab switch
  socket.on('user:setViewing', payload => {
    const { instanceId } = payload || {};
    console.log(`[mock] Switch viewing tab to: ${instanceId}`);
    if (instanceId && mockInstances.some(i => i.instanceId === instanceId)) {
      viewingInstanceId = instanceId;
      const inst = mockInstances.find(i => i.instanceId === instanceId);
      if (inst) {
        permissionMode = inst.permissionMode;
        effortLevel = inst.effort;
        activeModel = inst.model;
      }
      // Re-broadcast instances to all
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart,
          viewingInstanceId,
          viewingCwd: workspaceCwdOf(inst?.cwd || mockInstances[0].cwd),
          dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
          instances: mockInstances, service: mockServicePayload()
        }
      });
    }
  });

  // 彻底删除会话（mock：只从列表剔除，不碰磁盘）
  socket.on('session:deletePermanent', (payload, ack) => {
    const { sessionId } = payload || {};
    console.log(`[mock] deletePermanent: ${sessionId}`);
    if (typeof sessionId !== 'string' || !sessionId) {
      if (typeof ack === 'function') ack({ ok: false, error: '会话不存在' });
      return;
    }
    // 「服务端拒绝」这一路的 UI 回执（P0-11-delete-reject）。真 server 有三种拒法——会话不存在、
    // 正被本产品驱动、transcript mtime 落在静默期内——对前端是同一条路：ok:false + error 文案。
    // 钉死在一个固定 id 上而【不】做成 test: 命令开关：mock server 是所有并行 spec 共用的一个
    // 进程，一次性开关会被另一个分片的删除消费掉（P0-25c 那次的形态）。选这个 id 是因为它的夹具
    // 语义本来就是"主机上那份已经没了、列表还没 revalidate"——不必为此新增一行夹具会话，
    // 那会牵动未读计数与目录角标那批断言。
    if (sessionId === 'mock-session-deleted') {
      if (typeof ack === 'function') ack({ ok: false, error: '会话不存在' });
      return;
    }
    deletedSessionIds.add(sessionId);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // Handle Tab close
  socket.on('session:close', payload => {
    const { instanceId } = payload || {};
    console.log(`[mock] Close Tab: ${instanceId}`);
    const idx = mockInstances.findIndex(i => i.instanceId === instanceId);
    if (idx !== -1) {
      const closedCwd = mockInstances[idx].cwd;
      const shouldEmitLateClosedSessionEvents = lateClosedSessionEventsInstanceId === instanceId;
      if (pendingPermission?.instanceId === instanceId) pendingPermission = null;
      if (pendingQuestion?.instanceId === instanceId) pendingQuestion = null;
      if (syncPendingSnapshotInstanceId === instanceId) {
        syncPendingSnapshot = null;
        syncPendingSnapshotInstanceId = null;
      }
      if (shouldEmitLateClosedSessionEvents) lateClosedSessionEventsInstanceId = null;
      mockInstances.splice(idx, 1);
      if (viewingInstanceId === instanceId) {
        viewingInstanceId = mockInstances[0]?.instanceId ?? null;
        if (!viewingInstanceId) {
          permissionMode = 'default';
          effortLevel = null;
          pendingFreshPermissionMode = undefined;
          pendingFreshEffortLevel = undefined;
          pendingFreshCwd = closedCwd;
        }
      }
      const viewingCwd = workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || closedCwd);
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart,
          viewingInstanceId,
          viewingCwd,
          dirs: Array.from(new Set([...mockInstances.map(i => i.cwd), viewingCwd])),
          instances: mockInstances, service: mockServicePayload(),
          defaultPermissionMode: viewingInstanceId === null ? pendingFreshPermissionOrDefault() : undefined,
          defaultEffort: viewingInstanceId === null ? pendingFreshEffortOrDefault() : undefined
        }
      });
      // 【迟到事件不在这里发，改由用例经 POST /__emit-late-closed-events 显式触发】
      // 原实现是 setTimeout(..., 80)，等于赌前端能在 80ms 内处理完上面这条 instances 广播、
      // bindView 切到新实例。赌输了的后果不是「慢一点」而是【事件永久丢失】，有两层：
      //   ① 前端 viewingInstanceId 还是旧的 → shouldDropAgentEvent 直接丢；
      //   ② 即使切过去了，bindView 的 replayBuffer.begin() 早于 sync:since 发出，事件会先进缓冲，
      //      而 ack 回调走 resolve(handle,'reload') 时【缓冲整个被丢弃】改拉磁盘历史——那条 finished
      //      是实时 system 事件，磁盘历史里根本没有它。
      // 两层都不重发，用例只能干等到超时。所以放宽用例的断言 timeout 是死路（实测 10s→30s 照样红，
      // 报的是「30s 内 #messages 一次都没变过」）；单纯把 80ms 调大也只是缩窄窗口而非消除竞态——
      // sync:since 往返一慢就又回去了。
      // 判据交回用例：它能断言「切换确实完成了」（新会话的历史已上屏），那一刻再触发才是确定的。
      if (shouldEmitLateClosedSessionEvents) pendingLateClosedSessionEventsInstanceId = instanceId;
    }
  });

  // 新会话：清查看 tab（viewingInstanceId=null）→ 前端进空首页。模拟服务端 session:new（不 dispose 后台实例）。
  // 配合 test:freshbusy 复现「新会话首发乐观 busy 被懒开广播冲掉」的回归场景。
  socket.on('session:new', (payload, maybeAck) => {
    // 真 server 这条是带 ack 的（前端靠它拿回刚建好的 worktree 路径）。mock 此前只收 payload、
    // 从不调 ack——前端传进来的回调于是永不执行，而"没建成"和"没人回话"在 UI 上长得一模一样。
    const ack = typeof payload === 'function' ? payload : maybeAck;
    const obj = payload && typeof payload === 'object' ? payload : {};
    const requestedCwd = typeof obj.cwd === 'string' ? obj.cwd : null;
    const viewingCwd = requestedCwd
      || mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd
      || mockInstances[0]?.cwd
      || '/Users/you/code/claude-chat-mobile';
    console.log(`[mock] session:new → 进空首页（viewingInstanceId=null, cwd=${viewingCwd})`);
    // P0-12f：武装时把这一整条回应推后，并在权威包【之前】补一条在途旧包。旧实例取 session:new
    // 到达时前端还在看的那个（此刻 viewingInstanceId 尚未被下面清掉）。一次性消费。
    if (staleInstancesOnNextNew) {
      staleInstancesOnNextNew = false;
      const staleViewing = viewingInstanceId;
      const staleInst = mockInstances.find(i => i.instanceId === staleViewing);
      // 服务端侧状态重置与非武装路径【逐行一致】，只推迟 emit——否则这条用例还顺带改了
      // permission/effort 的起点，红绿就不再只由那道守卫决定。
      viewingInstanceId = null;
      permissionMode = 'default';
      effortLevel = null;
      pendingFreshPermissionMode = undefined;
      pendingFreshEffortLevel = undefined;
      pendingFreshCwd = viewingCwd;
      console.log(`[mock] P0-12f 武装生效：${STALE_INSTANCES_DELAY_MS}ms 后先发在途旧包（viewing=${staleViewing}, sessionId=${staleInst?.sessionId}）再发权威包`);
      if (typeof ack === 'function') ack({ ok: true, instanceId: null, sessionId: null });
      setTimeout(() => {
        // ① 在途旧包：viewingInstanceId 仍是旧实例，且该实例带着旧 sessionId。
        //    前端此刻 displayedInstanceId 仍指着它、displayedSessionId 已被 btnNew 清空——
        //    正好凑齐 FE-001 的前三个条件，只差 sessionIdClearedByNav 这道守卫。
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId: staleViewing,
            viewingCwd: staleInst?.cwd || viewingCwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload() }
        });
        // ② 权威包：viewingInstanceId=null。前端 displayedInstanceId 仍是旧实例，故走 bindView，
        //    拿 prevSessionId / sid=null 去做草稿交换——缺陷就在这一步把输入框清掉。
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId: null,
            viewingCwd,
            dirs: Array.from(new Set([...mockInstances.map(i => i.cwd), viewingCwd])),
            instances: mockInstances, service: mockServicePayload(),
            defaultPermissionMode: pendingFreshPermissionOrDefault(),
            defaultEffort: pendingFreshEffortOrDefault() }
        });
        // ③ 送达锚点（见 staleInstancesOnNextNew 处的注释）。
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'status_line', payload: {
            project: viewingCwd.split('/').filter(Boolean).pop() || viewingCwd,
            cwd: viewingCwd,
            git: { branch: STALE_PROBE_BRANCH, staged: 0, modified: 3, untracked: 1, changed: 4, ahead: 0, behind: 0 },
          }
        });
      }, STALE_INSTANCES_DELAY_MS);
      return;
    }
    viewingInstanceId = null;
    permissionMode = 'default';
    effortLevel = null;
    pendingFreshPermissionMode = undefined;
    pendingFreshEffortLevel = undefined;
    pendingFreshCwd = viewingCwd;
    const dirs = Array.from(new Set([...mockInstances.map(i => i.cwd), viewingCwd]));
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: { canRestart: mockCanRestart,
        viewingInstanceId: null,
        viewingCwd,
        dirs,
        instances: mockInstances, service: mockServicePayload(),
        defaultPermissionMode: pendingFreshPermissionOrDefault(),
        defaultEffort: pendingFreshEffortOrDefault()
      }
    });
    // 真 server 这条 handler 末尾有 `lastStatusLine = null; scheduleStatusRefresh()`（src/server/app.js
    // session:new），300ms 后按新 cwd 发一条 status_line——compose 页的状态栏与顶栏改动角标全靠它。
    // mock 此前只发 instances，于是「新会话页该不该显示 git」这件事在 E2E 层根本无从断言（永远没数据）。
    // 无实例，故不带 model/ctx：对齐 buildWebStatusLine 在 agent 为空时只产出 cwd/project/git 的形状。
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'status_line', payload: {
        project: viewingCwd.split('/').filter(Boolean).pop() || viewingCwd,
        cwd: viewingCwd,
        git: { branch: 'main', staged: 0, modified: 3, untracked: 1, changed: 4, ahead: 0, behind: 0 },
      }
    });
    if (typeof ack === 'function') ack({ ok: true, instanceId: null, sessionId: null });
  });

  // 回空首页枢纽：清 viewing、保留 live 实例与 pending 档（与 session:new 分工，对齐真 server session:home）。
  // 前端 leaveComposeReady → 底部输入条隐藏，直到再点 ＋ 或进入会话。
  socket.on('session:home', (payload, maybeAck) => {
    const ack = typeof payload === 'function' ? payload : maybeAck;
    const obj = payload && typeof payload === 'object' ? payload : {};
    const requestedCwd = typeof obj.cwd === 'string' && obj.cwd ? obj.cwd : null;
    const viewingCwd = requestedCwd
      || mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd
      || pendingFreshCwd
      || mockInstances[0]?.cwd
      || '/Users/you/code/claude-chat-mobile';
    console.log(`[mock] session:home → 空首页枢纽（viewingInstanceId=null, cwd=${viewingCwd})`);
    viewingInstanceId = null;
    // 不重置 permissionMode/effort/pendingFresh*（与 session:new 区分）
    pendingFreshCwd = viewingCwd;
    const dirs = Array.from(new Set([...mockInstances.map(i => i.cwd), viewingCwd]));
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: { canRestart: mockCanRestart,
        viewingInstanceId: null,
        viewingCwd,
        dirs,
        instances: mockInstances, service: mockServicePayload(),
        defaultPermissionMode: pendingFreshPermissionOrDefault(),
        defaultEffort: pendingFreshEffortOrDefault()
      }
    });
    if (typeof ack === 'function') ack({ ok: true, instanceId: null, sessionId: null });
  });

  // Handle session list request for sidebar directory browsing
  socket.on('session:list', (payload, rawCallback) => {
    // 已读位点搭 session:list 回去（与真 server 一致：不另开广播，保证行数据与未读判定同帧）。
    // 包一层统一注入而不是逐个 callback 出口加——这个 handler 有五个以上返回分支，漏一个就会让
    // 那条路径下的抽屉用旧位点渲染，而症状（少数几行未读不对）几乎不可能在 E2E 里被归因。
    // 与真 server 一致只回本页行的位点（全量表最多 500 条，而抽屉每 12 秒 revalidate 一次）：
    // mock 若整份回，「裁剪后前端还够不够用」这个问题在 E2E 里就永远暴露不出来。
    const { cwd, all } = payload || {};
    const query = typeof payload?.query === 'string' ? payload.query.trim().toLowerCase() : '';
    // pinned 与 readState 一样在包装层统一注入：这个 handler 有五个以上返回分支，漏一个就会让那条
    // 路径下的「稍后再看」组凭空消失。搜索态不补（同真 server）：往结果里塞未匹配的行是污染搜索语义。
    const callback = typeof rawCallback === 'function'
      ? (res) => {
        const rows = res?.sessions || [];
        const pinned = query ? [] : pinnedRowsFor(cwd, rows);
        rawCallback({ ...res, pinned, readState: readStateForRows([...rows, ...pinned]) });
      }
      : rawCallback;
    console.log(`[mock] session:list for cwd: ${cwd}${query ? ` query=${query}` : ''}`);
    if (cwd === '/Users/you/code/claude-chat-mobile') {
      if (typeof callback === 'function') {
        const sessions = mainCwdSessions().filter(s => !deletedSessionIds.has(s.id));
        if (terminalRaceArmed) {
          terminalRaceListCount += 1;
          if (terminalRaceListCount === 2) {
            const staleSessions = sessions.map(s => ({ ...s }));
            const target = staleSessions.find(s => s.id === 'mock-session-archived');
            if (target) target.terminal = 'busy';
            setTimeout(() => {
              callback({
                currentSessionId: 'mock-session-visual-test',
                sessions: staleSessions,
                terminalBusy: true,
                hasMore: false,
                total: staleSessions.length,
              });
              io.emit('agent:event', {
                seq: 1,
                epoch: 'mock-epoch-terminal-race',
                sessionId: 'mock-session-visual-test',
                instanceId: 'inst_1',
                ts: Date.now(),
                type: 'system',
                payload: { message: '[MOCK_INFO] Delayed stale session list delivered.' },
              });
            }, 600);
            return;
          }
        }
        if (terminalRefreshArmed) {
          terminalRefreshListCount += 1;
          if (terminalRefreshListCount >= 2) {
            const target = sessions.find(s => s.id === 'mock-session-archived');
            if (target) target.terminal = 'busy';
          }
        }
        if (query) {
          const matched = sessions.filter(s => String(s.title || '').toLowerCase().includes(query));
          callback({
            currentSessionId: 'mock-session-visual-test',
            sessions: matched,
            terminalBusy: terminalBadgeArmed || desktopBadgeArmed || (terminalRefreshArmed && terminalRefreshListCount >= 2),
            terminalWaiting: terminalWaitingArmed,
            hasMore: false,
            total: sessions.length,
          });
          return;
        }
        // overflow：截断态 hasMore；显示全部后仍诚实报告「还有更早的」（total 虚高模拟窗外会话）
        const overflowHidden = historyOverflowMode ? 7 : 0;
        const total = sessions.length + overflowHidden;
        const visibleSessions = historyOverflowMode && !all ? sessions.slice(0, 3) : sessions;
        const hasMore = historyOverflowMode
          ? (all ? overflowHidden > 0 : true)
          : false;
        callback({
          currentSessionId: 'mock-session-visual-test',
          sessions: visibleSessions,
          terminalBusy: terminalBadgeArmed || desktopBadgeArmed || (terminalRefreshArmed && terminalRefreshListCount >= 2),
          terminalWaiting: terminalWaitingArmed,
          hasMore,
          total,
        });
        if (terminalRefreshArmed && terminalRefreshListCount === 1) {
          const live = mockInstances.find(i => i.instanceId === 'inst_1');
          if (live) live.state = 'permission';
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'instances', payload: { canRestart: mockCanRestart,
              viewingInstanceId,
              viewingCwd: '/Users/you/code/claude-chat-mobile',
              dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
              instances: mockInstances,
              service: mockServicePayload(),
            },
          });
        }
      }
    } else if (cwd === '/Users/you/code/another-react-project') {
      if (typeof callback === 'function') {
        if (terminalCloseRaceOtherArmed) {
          terminalCloseRaceOtherArmed = false;
          setTimeout(() => {
            callback({ currentSessionId: null, sessions: [], terminalBusy: true, hasMore: false });
            io.emit('agent:event', {
              seq: 1,
              epoch: 'mock-epoch-terminal-close-race',
              sessionId: 'mock-session-visual-test',
              instanceId: 'inst_1',
              ts: Date.now(),
              type: 'system',
              payload: { message: '[MOCK_INFO] Delayed closed-drawer session list delivered.' },
            });
          }, 600);
          return;
        }
        callback({
          currentSessionId: 'mock-session-another',
          sessions: [
            {
              id: 'mock-session-another',
              title: 'Another App Concurrency',
              model: 'claude-3-5-haiku',
              lastUsedAt: mockListClockBase,
              entrypoint: 'sdk-ts'
            },
            {
              id: 'mock-session-another-done',
              title: 'Background Done Result',
              model: 'claude-3-5-haiku',
              lastUsedAt: mockListClockBase - 1500,
              entrypoint: 'sdk-ts'
            },
            {
              id: 'mock-session-another-running',
              title: 'Background Task Running',
              model: 'claude-3-5-haiku',
              lastUsedAt: mockListClockBase - 1000,
              entrypoint: 'sdk-ts'
            },
            {
              id: 'mock-session-another-permission',
              title: 'Background Needs Approval',
              model: 'claude-3-5-haiku',
              lastUsedAt: mockListClockBase - 500,
              entrypoint: 'sdk-ts'
            },
            {
              id: 'mock-session-scroll-replay',
              title: 'Scroll Replay Session',
              model: 'claude-3-5-sonnet',
              lastUsedAt: mockListClockBase - 300,
              entrypoint: 'sdk-ts'
            },
            {
              // P0-REPLAY-BUFFER：会话面板行由 session:list 驱动（liveInst 只是叠加角标/已打开态，
              // 见 app.js populateSubtree renderRows——不在这份列表里的 live-only 实例不会出现一行），
              // 这两条必须与 mockInstances 里 test:replay-buffer-*-setup 注册的 sessionId 对上，
              // 否则侧栏点不到、测试会卡在 openSessionByTitle 超时（同 mock-session-scroll-replay 的模式）。
              id: 'mock-session-replay-flood',
              title: 'Replay Flood Session',
              model: 'claude-3-5-sonnet',
              lastUsedAt: mockListClockBase - 200,
              entrypoint: 'sdk-ts'
            },
            {
              id: 'mock-session-replay-small',
              title: 'Replay Small Session',
              model: 'claude-3-5-sonnet',
              lastUsedAt: mockListClockBase - 100,
              entrypoint: 'sdk-ts'
            },
            {
              // BUSY-ORPHAN：切回已结束会话但回放缺 result 的场景专用（同上条的登记理由）。
              // ⚠ lastUsedAt 必须比本文件里所有其它条目都旧。首页最近列表是【跨工作区归并后取前 8】
              // （panel-state.js 的 mergeRecentSessionsAcrossWorkspaces，limit=8），往这份清单里插一条
              // 「新」会话会把原本排第 8 的那条挤出列表——P0-11am 断言的 mock-session-another-done 正好
              // 是 -1500、卡在第 8 位，插一条 -80 就让它掉到第 9，那条用例随即红。
              // 2026-09-12 撞过，且【单跑 P0-11am 是绿的、只有全量才红】：单跑时那条用例自己不读这份
              // 清单，得先有别的 spec 把首页最近列表画出来才暴露。往这里加条目前先数一遍前 8。
              // 本场景只从侧栏进入（openWorkspaceSession），不依赖出现在首页最近列表里。
              id: 'mock-session-orphan',
              title: 'Orphan Replay Session',
              model: 'claude-3-5-sonnet',
              lastUsedAt: mockListClockBase - 3000000,
              entrypoint: 'sdk-ts'
            },
            {
              // BUSY-ORPHAN-MIXED：回放【旧轮完整 FIFO + 当前轮 delta】的场景专用。
              // lastUsedAt 同样必须最旧，理由见上一条。
              id: 'mock-session-orphan-mixed',
              title: 'Orphan Mixed Session',
              model: 'claude-3-5-sonnet',
              lastUsedAt: mockListClockBase - 3100000,
              entrypoint: 'sdk-ts'
            },
            {
              // P0-REPLAY-UNREAD-DISMISS：回放缓冲程序性落底 × 未读胶囊自动确认已读协同场景专用。
              id: 'mock-session-replay-unread',
              title: 'Replay Unread Session',
              model: 'claude-3-5-sonnet',
              lastUsedAt: mockListClockBase - 50,
              entrypoint: 'sdk-ts'
            }
          ],
          terminalBusy: terminalSummaryOtherArmed,
          terminalWaiting: terminalSummaryOtherWaitingArmed,
        });
      }
    } else {
      if (typeof callback === 'function') {
        callback({ sessions: [] });
      }
    }
  });

  socket.on('session:switch', (payload, callback) => {
    const { sessionId, cwd } = payload || {};
    console.log(`[mock] session:switch sessionId=${sessionId}, cwd=${cwd}`);
    const knownArchived = {
      // P0-DESTROY-6b：server 重启摧毁 inst_1 后，「继续此会话」按钮走 session:switch 重开原会话
      // （真 server 语义 = 从磁盘 transcript 懒 resume，得到新实例；mock 复用同 id 够验前端链路）。
      'mock-session-visual-test': {
        instanceId: 'inst_1',
        title: 'Visual Sandbox (Main)'
      },
      'mock-session-archived': {
        instanceId: 'inst_archived',
        title: 'Archived Planning Session'
      },
      'mock-session-gap': {
        instanceId: 'inst_gap',
        title: 'Archived Gap Session'
      },
      'mock-session-worktree': {
        instanceId: 'inst_worktree',
        title: 'Worktree Driving Session',
        cwd: '/Users/you/code/claude-chat-mobile/.claude/worktrees/wt-x'
      },
      'mock-session-timeline': {
        instanceId: 'inst_timeline',
        title: 'Timeline Session'
      },
      'mock-session-subagent-history': {
        instanceId: 'inst_subagent_history',
        title: 'Subagent History Session'
      },
      'mock-session-older-migration': {
        instanceId: 'inst_older_migration',
        title: 'Older Migration Session'
      },
      'mock-session-long-history': {
        instanceId: 'inst_long_history',
        title: 'Long History Session'
      }
    };
    if (bgLockedArmed && sessionId === 'mock-session-gap') {
      // 逐字对齐 app/src/ops/cli-bg-session-lock.js 的 kind='bg' 分支：落地页显示的就是这句，
      // 措辞漂了用例照样绿，但用户读到的会是另一句话。
      if (typeof callback === 'function') callback({
        ok: false,
        error: '会话正被 CLI 后台任务「ECS 部署审查」占用（pid 11557）。从 web 打开会中断它，'
          + '所以没有打开——请在本机 `claude agents` 接管，或等它跑完再开',
      });
      return;
    }
    // 树已删 + 没有 live 实例 → 拒，并说清是哪一棵（逐字对齐 app/src/server/app.js 的
    // session:switch 分支）。已 live 的**不拒**：那时点它只是切视图，不需要 spawn 任何东西。
    if (worktreeGoneArmed && sessionId === 'mock-session-worktree'
        && !mockInstances.some(i => i.sessionId === sessionId)) {
      if (typeof callback === 'function') callback({
        ok: false,
        error: '这个会话的 worktree「wt-x」已被删除，所以打不开了。'
          + '对话记录还在磁盘上，把那棵 worktree 重新建回原路径即可恢复。',
      });
      return;
    }
    const meta = knownArchived[sessionId];
    // 归组后再比：托管 worktree 会话的列表项 cwd 是 `<父仓>/.claude/worktrees/<name>`，
    // 真 server 的 routeCwd 放行这一形态（resolveManagedWorktree）。只比字面量会把它判成
    // 「session not found」，那条路径在 E2E 里就永远走不到。
    if (!meta || workspaceCwdOf(cwd) !== '/Users/you/code/claude-chat-mobile') {
      if (typeof callback === 'function') callback({ ok: false, error: 'mock session not found' });
      return;
    }

    let archivedInst = mockInstances.find(i => i.instanceId === meta.instanceId);
    if (!archivedInst) {
      archivedInst = {
        instanceId: meta.instanceId,
        cwd: meta.cwd || '/Users/you/code/claude-chat-mobile',
        sessionId,
        title: meta.title,
        state: 'idle',
        permissionMode: 'default',
        effort: null,
        model: 'claude-3-5-sonnet'
      };
      mockInstances.push(archivedInst);
    }
    viewingInstanceId = archivedInst.instanceId;
    permissionMode = archivedInst.permissionMode;
    effortLevel = archivedInst.effort;
    activeModel = archivedInst.model;
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: { canRestart: mockCanRestart,
        viewingInstanceId,
        viewingCwd: workspaceCwdOf(archivedInst.cwd),
        dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
        instances: mockInstances, service: mockServicePayload()
      }
    });
    if (typeof callback === 'function') callback({ ok: true, instanceId: archivedInst.instanceId, sessionId: archivedInst.sessionId });
  });

  // P0-FORK：镜像真实 session:fork handler 的收尾（app/src/server/app.js）——建/聚焦新实例、广播 instances、ack。
  // 只认 mock-session-archived → mock-session-forked 这一条固定映射，够验前端长按→confirm→切视图链路。
  // uuid 白名单只收 assistant 侧（a-archived-*）：user 气泡长按理应解析出前一条 assistant 的 uuid、不是
  // 自己的（u-archived-*）——若前端解析回归成送自己的 uuid，这里会拒绝，P0-FORKc 能抓到。
  // 文件轴 Rewind 预览。ack 形状与真 server 逐字对齐（app/src/server/app.js 的 session:rewind:preview）——
  // 这里是平行实现，字段漂了 E2E 也不会红，改真 server 的 ack 时必须回来同步这一处。
  //
  // uuid 白名单【只收 user 侧】（u-archived-*），与上面 fork handler 恰好相反（它只收 a-archived-*）。
  // 这不是笔误：rewindFiles 要的是【被丢弃那轮 prompt 自身】的 uuid，而 fork 的锚点语义是
  // 「保留到这条为止」故取前一条 assistant。两个功能会并排出现在同一个长按菜单里，前端若图省事
  // 复用 resolveForkAnchorUuid，送来的就是 a-archived-*，这里拒绝，E2E 能当场抓到。
  // `/rewind` 第一步的候选清单。ack 形状与真 server 的 session:rewind:candidates 逐字对齐——
  // 同样是平行实现，改真 server 的 ack 必须回来同步这一处。
  //
  // 第一条给 canRewind:false（对应 planRewind 的 first-turn：它之前没有可保留的锚点），
  // 前端必须把它渲染成不可选。给的若全是可选项，「置灰」那条断言就永远走不到。
  // changedFiles 一条 0 一条非 0，分别对应终端的 "No code changes" 与文件数标注。
  socket.on('session:rewind:candidates', (payload, callback) => {
    const { sessionId, cwd } = payload || {};
    console.log(`[mock] session:rewind:candidates sessionId=${sessionId}, cwd=${cwd}`);
    if (typeof callback !== 'function') return;
    if (cwd !== '/Users/you/code/claude-chat-mobile' || sessionId !== 'mock-session-archived') {
      callback({ ok: false, error: '会话不存在' });
      return;
    }
    // 文案与下方 session:history 的 user 气泡【逐字一致】：E2E 要在清单里按这段文字点中某一轮，
    // 对不上就只能按下标点，那种用例换个顺序就悄悄测了另一条。
    // canRewind:false 只给首轮（真 server 的 planRewind 判 first-turn）——它之前没有可保留的锚点。
    // canForkConversation / canRestoreCode 是【两个轴】，不是一个 canRewind：首轮不能分叉对话
    // （之前没有可保留的锚点），但文件快照照样能还原，所以它仍然可选、只是模式受限。
    // 末轮 changedFiles=null＝未知（最后一轮的改动还没有下一个 snapshot 来反映）。
    callback({
      ok: true,
      items: [
        { promptUuid: 'u-archived-1', text: 'Summarize archived plan', timestamp: '2024-01-01T00:00:00Z', changedFiles: 0, canForkConversation: false, canRestoreCode: true },
        { promptUuid: 'u-archived-2', text: 'Any follow-up questions?', timestamp: '2024-01-01T00:05:00Z', changedFiles: 3, canForkConversation: true, canRestoreCode: true },
        { promptUuid: 'u-archived-3', text: 'One more thing please', timestamp: '2024-01-01T00:09:00Z', changedFiles: 2, canForkConversation: true, canRestoreCode: true },
        { promptUuid: 'u-archived-4', text: 'Just run some shell commands', timestamp: '2024-01-01T00:12:00Z', changedFiles: 0, canForkConversation: true, canRestoreCode: true },
        { promptUuid: 'u-archived-5', text: 'An old turn with no snapshot', timestamp: '2024-01-01T00:15:00Z', changedFiles: 0, canForkConversation: true, canRestoreCode: true },
        { promptUuid: 'u-archived-6', text: 'Switch away while I decide', timestamp: '2024-01-01T00:18:00Z', changedFiles: 1, canForkConversation: true, canRestoreCode: true },
        { promptUuid: 'u-archived-7', text: 'Go home while I decide', timestamp: '2024-01-01T00:21:00Z', changedFiles: null, canForkConversation: true, canRestoreCode: true },
      ],
    });
  });

  socket.on('session:rewind:preview', (payload, callback) => {
    const { sessionId, cwd, promptUuid } = payload || {};
    console.log(`[mock] session:rewind:preview sessionId=${sessionId}, cwd=${cwd}, promptUuid=${promptUuid}`);
    if (typeof callback !== 'function') return;
    if (cwd !== '/Users/you/code/claude-chat-mobile' || sessionId !== 'mock-session-archived') {
      callback({ ok: false, error: '会话不存在' });
      return;
    }
    if (typeof promptUuid === 'string' && promptUuid.startsWith('a-archived')) {
      // 送来了 assistant uuid = 前端复用了 fork 的锚点解析。
      // 【与真 server 的路径差异，有意为之】真 server 上 planRewind 认得出 assistant 行也有 uuid，
      // 会一路走到 rewindFiles，由 CLI 报「找不到检查点」——结果同样是拒绝，只是慢一个往返。
      // mock 提前在这里拒，是为了让 E2E 能拿到一个稳定可断言的错误，不必依赖 CLI 的措辞。
      callback({ ok: false, error: '这一轮无法回退：无法确定回退位置。', reason: 'prompt-not-found' });
      return;
    }
    if (promptUuid === 'u-archived-1') {
      // 夹具里这是会话【首条】消息，其前面没有可保留的 chain entry，planRewind 判 first-turn。
      // 【2026-09-21 起不再整体拒绝】那是【对话轴】的限制，而「只恢复代码」不 fork——真 server
      // 现在放行并回 canForkConversation:false，mock 必须给同一个答案，否则两边对同一条夹具的
      // 判断相反，E2E 守的就不是真 server 的行为。
      callback({
        ok: true, canRewind: true, canForkConversation: false,
        filesChanged: ['/Users/you/code/claude-chat-mobile/app/public/js/app.js'],
        insertions: 4, deletions: 1, keepUuid: null, dirtyOverlap: [],
      });
      return;
    }
    // u-archived-2 → 正常成功路径；u-archived-3 → preview 同样成功，但 confirm 时分叉会失败
    // （P0-REWINDd 打的是「文件回了、新会话没建成」那一支）。
    if (promptUuid === 'u-archived-2' || promptUuid === 'u-archived-3') {
      callback({
        ok: true, canRewind: true,
        filesChanged: ['/Users/you/code/claude-chat-mobile/app/public/js/app.js', '/Users/you/code/claude-chat-mobile/README.md'],
        insertions: 12, deletions: 5,
        keepUuid: promptUuid === 'u-archived-2' ? 'a-archived-1' : 'a-archived-2', // 目标轮之前最后一条 chain entry
        // G5：只有 u-archived-3 那档摆出「工作区有未提交改动且会被回退覆盖」，
        // 让 E2E 能同时测到「有警告」与「没警告」两侧——只测有警告的话，
        // 一个恒返回警告的实现也全绿。
        dirtyOverlap: promptUuid === 'u-archived-3' ? ['app/public/js/app.js'] : [],
      });
      return;
    }
    // 锚点有效、但这一轮没有任何经 Edit/Write 落盘的文件 → 真 server 在 app.js 那句
    // `canRewind: !!res?.canRewind && filesChanged.length > 0` 上判 false，并带 reason 说明是哪一种。
    // 用户实测撞上的就是这一档（那一轮 50 个工具调用全是 Bash，checkpoint 只快照 edits）。
    if (promptUuid === 'u-archived-4') {
      callback({ ok: true, canRewind: false, reason: 'no-file-changes', filesChanged: [], insertions: 0, deletions: 0 });
      return;
    }
    // 「确认框还开着，会话被切走了」：ack 之后立刻推一条 instances，把 viewingInstanceId
    // 换成另一个实例。前端的 appConfirm 正在 await，这条广播会在它等待期间落地、
    // 把 displayedSessionId 改掉。真 server 上等价的触发是别处来的任意一次 broadcastInstances。
    if (promptUuid === 'u-archived-6') {
      callback({ ok: true, canRewind: false, reason: 'no-file-changes', filesChanged: [], insertions: 0, deletions: 0 });
      const other = mockInstances.find(i => i.instanceId !== viewingInstanceId) || mockInstances[0];
      viewingInstanceId = other.instanceId;
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart,
          viewingInstanceId, viewingCwd: other.cwd,
          dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
          instances: mockInstances, service: mockServicePayload() },
      });
      console.log('[mock] u-archived-6 —— preview 之后切走会话，模拟确认框等待期间的会话切换');
      return;
    }
    // 与上一档同源、只差一个取值：viewingInstanceId 清成 null ⇒ 前端 displayedSessionId 变 null。
    // 守卫写成 `now?.sessionId && ...` 会在这里短路失效（PR #102 review 的 P1）。
    if (promptUuid === 'u-archived-7') {
      callback({ ok: true, canRewind: true, filesChanged: ['/Users/you/code/claude-chat-mobile/app/public/js/app.js'], insertions: 3, deletions: 1, keepUuid: 'a-archived-6', dirtyOverlap: [] });
      viewingInstanceId = null;
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart,
          viewingInstanceId: null, viewingCwd: null,
          dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
          instances: mockInstances, service: mockServicePayload() },
      });
      console.log('[mock] u-archived-7 —— preview 之后回到首页，viewing 清空');
      return;
    }
    // 另一种 canRewind:false：SDK 侧根本没有这条消息的检查点（res.canRewind 为 false），
    // 不是「这一轮没改文件」。出路一样，成因不同，文案必须不同。
    if (promptUuid === 'u-archived-5') {
      callback({ ok: true, canRewind: false, reason: 'no-checkpoint', filesChanged: [], insertions: 0, deletions: 0 });
      return;
    }
    callback({ ok: false, error: '这一轮无法回退：无法确定回退位置。', reason: 'prompt-not-found' });
  });

  // 回退执行：回滚文件 + 分叉出「回到那一刻」的新会话（原会话保留）。ack 与真 server 对齐——
  // 成功时真 server 走 finishOpenFocus 收尾，所以带 instanceId / sessionId。
  // u-archived-2 → 成功；u-archived-3 → 文件回了但分叉失败（原会话未受影响那一档）。
  socket.on('session:rewind:confirm', (payload, callback) => {
    const { sessionId, cwd, promptUuid, mode } = payload || {};
    console.log(`[mock] session:rewind:confirm sessionId=${sessionId}, promptUuid=${promptUuid}, mode=${mode}`);
    if (typeof callback !== 'function') return;
    if (cwd !== '/Users/you/code/claude-chat-mobile' || sessionId !== 'mock-session-archived') {
      callback({ ok: false, error: '会话不存在' });
      return;
    }
    // mode 语义与真 server 的 rewindStepsFor 逐字对齐（缺省=两样都做）：
    // conversation 跳过文件回滚，code 跳过分叉。这一档是平行实现，真 server 改了要回来同步。
    const restoreCode = mode !== 'conversation';
    const forkConversation = mode !== 'code';
    // 只回退对话时不碰文件，所以「这一轮有没有可回退的文件改动」根本不成为门槛——
    // u-archived-4/5（canRewind:false 那两档）走 conversation 必须放行，那正是它们的出路。
    // first-turn（u-archived-1）只在【需要 fork】时才拒 —— 对齐真 server：planRewind 是对话轴
    // 判据，而「只恢复代码」不 fork，照拒就是让那个按钮点了必然失败（PR #104 review）。
    if (forkConversation && promptUuid === 'u-archived-1') {
      callback({ ok: false, error: '这是会话的第一轮，前面没有可回退到的位置。', reason: 'first-turn' });
      return;
    }
    if (restoreCode && !['u-archived-1', 'u-archived-2', 'u-archived-3'].includes(promptUuid)) {
      callback({ ok: false, error: '这一轮无法回退：无法确定回退位置。', reason: 'prompt-not-found' });
      return;
    }
    const forked = forkConversation && promptUuid !== 'u-archived-3';
    const filesChanged = restoreCode ? ['/Users/you/code/claude-chat-mobile/app/public/js/app.js'] : [];
    const forkedSessionId = forked ? 'mock-session-forked' : null;
    callback({
      ok: true, forkedSessionId, filesChanged,
      // u-archived-3 那档顺带摆出「一个链接被跳过 + 一个文件没恢复」，
      // 让 E2E 能验到 logic/rewind.js 组装的两条提示真的上屏（真 server 的这两个字段
      // 分别来自 rewindFiles 的 skippedLinks 与回滚后复核的 unrestored）。
      skippedLinks: restoreCode && !forked ? 1 : 0,
      unrestored: restoreCode && !forked ? ['/Users/you/code/claude-chat-mobile/README.md'] : [],
      // prefill：真 server 从 transcript 取那一轮的原话回填输入框。
      // 这里给夹具里那条 user 气泡的原文，E2E 才能断言真的填回去了。
      prefill: 'Any follow-up questions?',
      ...(forked ? { instanceId: 'inst_forked', sessionId: forkedSessionId } : {}),
      warning: forkConversation && !forked ? '文件已回退，但新会话创建失败（mock）。原会话未受影响，可重试。' : null,
    });
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId, ts: Date.now(),
      type: 'rewind_applied',
      payload: {
        cwd, droppedFromUuid: promptUuid, forkedSessionId, filesChanged, skippedLinks: 0,
        // 与真 server 的 rewind_applied payload 逐字对齐：前端靠它挑文案（只恢复代码那档
        // 本来就没有新会话，照 forkedSessionId 判会误报成创建失败）。
        mode: forkConversation ? (restoreCode ? 'code_and_conversation' : 'conversation') : 'code',
      },
    });
  });

  socket.on('session:fork', (payload, callback) => {
    const { sessionId, cwd, uuid, keepAnchorTurn } = payload || {};
    console.log(`[mock] session:fork sessionId=${sessionId}, cwd=${cwd}, uuid=${uuid}, keepAnchorTurn=${keepAnchorTurn}`);
    if (typeof callback !== 'function') return;
    // 【护栏随协议翻转】2026-09-18 起锚点由服务端对着 transcript 算（planFork），前端只送
    // 「这条气泡自己的 uuid + 语义标志」。于是这道护栏守的东西换了——不再是「只收 assistant 侧」，
    // 而是【uuid 侧别必须与 keepAnchorTurn 一致】：
    //   keepAnchorTurn=true （长按 assistant「从这里分叉」= 保留这一轮）→ 必须是 a-archived-*
    //   keepAnchorTurn=false（长按 user「丢弃这条及之后」）             → 必须是 u-archived-*
    // 送反了说明前端把两个方向的语义接错了，当场拒绝。旧护栏「只收 assistant」在新协议下
    // 会把合法的 user 侧请求也拒掉，留着就是假红。
    const wantAssistantSide = keepAnchorTurn !== false;
    const sideOk = wantAssistantSide
      ? /^a-archived-\d+$/.test(uuid || '')
      : /^u-archived-\d+$/.test(uuid || '');
    if (cwd !== '/Users/you/code/claude-chat-mobile' || sessionId !== 'mock-session-archived' || !sideOk) {
      callback({ ok: false, error: 'mock fork source not found' });
      return;
    }
    // 会话首轮往前没有可保留的锚点——真 server 的 planFork 在这一档返回 first-turn，
    // mock 必须给同一个答案，否则两边对同一条夹具的判断相反、E2E 守的就不是真 server 的行为。
    if (!wantAssistantSide && uuid === 'u-archived-1') {
      callback({ ok: false, error: '这是会话的第一轮，前面没有可回退到的位置。', reason: 'first-turn' });
      return;
    }
    const forkedId = 'inst_forked';
    let forkedInst = mockInstances.find(i => i.instanceId === forkedId);
    if (!forkedInst) {
      forkedInst = {
        instanceId: forkedId,
        cwd: '/Users/you/code/claude-chat-mobile',
        sessionId: 'mock-session-forked',
        title: 'Archived Planning Session (fork)',
        state: 'idle',
        permissionMode: 'default',
        effort: null,
        model: 'claude-3-5-sonnet'
      };
      mockInstances.push(forkedInst);
    }
    viewingInstanceId = forkedInst.instanceId;
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: { canRestart: mockCanRestart,
        viewingInstanceId,
        viewingCwd: forkedInst.cwd,
        dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
        instances: mockInstances, service: mockServicePayload()
      }
    });
    callback({ ok: true, instanceId: forkedInst.instanceId, sessionId: forkedInst.sessionId });
  });

  // 存量 fixture 统一落在「今天、彼此相差 1 秒」：消息流时间戳只会在每段历史顶部多一行日期，
  // 段内不插时间行（gap 远小于阈值），故不触碰任何既有断言。
  // 基准锚在【今天 12:00】而不是 Date.now() 往回减——后者在 2000 条的 long-history fixture 上
  // 要横跨 33 分钟，本地 0 点前后跑就会把一批消息甩到昨天，在历史中段凭空多出一条日期分隔行。
  function stampHistoryMessages(res) {
    if (!Array.isArray(res?.messages)) return res;
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const base = noon.getTime();
    return {
      ...res,
      messages: res.messages.map((m, i) => (m?.timestamp
        ? m
        : { ...m, timestamp: new Date(base + i * 1000).toISOString() })),
    };
  }

  socket.on('session:history', (payload, rawCallback) => {
    const { sessionId, cwd } = payload || {};
    console.log(`[mock] session:history sessionId=${sessionId}, cwd=${cwd}`);
    if (typeof rawCallback !== 'function') return;
    // 真 server 的每条历史消息都带 timestamp（transcript 原样透传，见 app/src/sessions/history.js）。
    // 这里统一在出口补齐，而不是逐个分支手写——17 处 callback 漏一个就是一处静默的契约 drift。
    // 已显式带 timestamp 的（如 mock-session-timeline fixture）保持原值不覆盖。
    const callback = res => rawCallback(stampHistoryMessages(res));
    // P0-NOSID 区分度标记：真 server 在无 sessionId 时压根查不到（回「会话不存在」）。这里故意返回一段
    // 可识别文案——只要它出现在页面上，就说明前端仍然清屏改走了磁盘，即修复失效。断言它「不出现」。
    if (noSessionIdMode) {
      callback({ messages: [{ role: 'assistant', content: 'NOSID_DISK_MUST_NOT_APPEAR', uuid: 'a-nosid-disk' }] });
      return;
    }
    // 失败支：真 server 在 sessionId 非法 / jsonl 不存在、被删、改名、读坏时回 { messages: [], error }
    // （app/src/server/app.js 的 session:history handler）。前端据 error 打灰行「历史消息加载失败」；
    // 漏发时 loading 卡已被 hideLoadingCard() 抹掉，消息区【完全空白】，连失败提示都没有。
    // mock 这个 handler 有 17 处 callback、此前无一带 error，整条失败路径在 E2E 里不可达。
    if (historyErrorArmed) {
      historyErrorArmed = false; // 一次性：只影响紧接着的那一次拉取，不污染后续用例
      callback({ messages: [], error: '会话不存在' });
      return;
    }
    // P0-ORDER：在 ack【之前】推一条 history_append，精确复刻真实时序——web 拉历史的往返窗口里，
    // server 的 catchUpTick 检出终端刚落定的消息就直接推过来了。前端先渲染这条增量、再收到历史本体，
    // 若历史只会 appendChild 到尾部，就会出现「新消息在上、整段旧历史在下」。
    if (historyOrderRaceArmed && sessionId === 'mock-session-timeline') {
      historyOrderRaceArmed = false;
      socket.emit('agent:event', {
        seq: 99, epoch: activeEpoch, sessionId, instanceId: viewingInstanceId, ts: Date.now(),
        type: 'history_append',
        payload: {
          external: true,
          // 时刻锚在 fixture 最后一条（今天 08:30）之后 10 分钟，【不用 Date.now()】——
          // 用当前时刻的话，在本地 08:30 之前跑测试就会早于那条历史，被「时间倒流不插行」吃掉，
          // marker 变成 null。而断言若只写 not.toBe('day')，null 也满足 → 整条用例假绿。
          // 固定 10 分钟间隔（≥5 分钟阈值、同日、user）保证必出 time 行，与跑测试的时刻无关。
          messages: [{
            role: 'user', content: 'RACE_LATE_ARRIVAL', uuid: 'u-race-1',
            timestamp: (() => { const d = new Date(); d.setHours(8, 40, 0, 0); return d.toISOString(); })(),
          }],
        },
      });
    }
    // P0-ACK-TIMEOUT：窗口期推一条追平，然后【不 ack】直接 return——连接保持，前端只能靠 15s 超时收尾。
    // 这条 return 是本用例的全部机关：ack 一旦返回，走的就是正常路径，测不到 err 分支的取舍。
    if (historyAckTimeoutArmed && sessionId === 'mock-session-timeline') {
      historyAckTimeoutArmed = false;
      socket.emit('agent:event', {
        seq: 98, epoch: activeEpoch, sessionId, instanceId: viewingInstanceId, ts: Date.now(),
        type: 'history_append',
        payload: {
          external: true,
          // 与 P0-ORDER 同样锚在「今天 08:40」而不用 Date.now()：历史本体这次压根不会落地，
          // 固定时刻能让断言不受跑测试的时钟影响（理由详见上面 RACE_LATE_ARRIVAL 的注释）。
          messages: [{
            role: 'user', content: 'ACK_TIMEOUT_HELD_APPEND', uuid: 'u-ack-timeout-1',
            timestamp: (() => { const d = new Date(); d.setHours(8, 40, 0, 0); return d.toISOString(); })(),
          }],
        },
      });
      return; // ★ 故意不调用 callback
    }
    if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-timeline') {
      // P0-TS 时间戳 fixture。时刻按「相对今天」构造（非硬编码日历日），跑在任何一天都稳定。
      // 期望 marker 共 5 个 = day×3（#1 首条 / #4 跨天 / #7 跨天）+ time×2（#5 / #9）：
      //   #1 user     前天 09:00  → day   规则2 首条
      //   #2 assistant 前天 09:01 → 无    规则5 role 抑制
      //   #3 工具卡    前天 09:02 → 无    不参与、不打 data-ts（故不推进 prevTs）
      //   #4 assistant 昨天 00:02 → day   规则4 跨天不受 role 抑制（prevTs 仍是 #2 的前天 09:01）
      //   #5 user     昨天 22:00  → time  同日 + user + gap 21h58m（「昨天」这天的 day 行已被 #4 消耗）
      //   #6 子agent正文 昨天 22:01 → 无   进子卡、不打 data-ts
      //   #7 user     今天 08:00  → day   规则4 跨天（prevTs = #5 的昨天 22:00）
      //   #8 assistant 今天 08:20 → 无    规则5 同轮抑制（虽超 5 分钟阈值）
      //   #9 user     今天 08:30  → time  同日 + user + gap 10min
      const day = n => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
      const iso = (n, hh, mm) => { const d = day(n); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
      const timelineMessages = [
          { role: 'user', content: 'Timeline day-before prompt', uuid: 'u-tl-1', timestamp: iso(2, 9, 0) },
          { role: 'assistant', content: 'Timeline day-before reply', uuid: 'a-tl-2', timestamp: iso(2, 9, 1) },
          { kind: 'tool_use', role: 'assistant', toolUseId: 'tl-tool-1', name: 'Read', inputSummary: '{"file":"a.ts"}', timestamp: iso(2, 9, 2) },
          { kind: 'tool_result', role: 'user', toolUseId: 'tl-tool-1', ok: true, outputSummary: 'ok', timestamp: iso(2, 9, 2) },
          { role: 'assistant', content: 'Timeline past-midnight reply', uuid: 'a-tl-4', timestamp: iso(1, 0, 2) },
          { role: 'user', content: 'Timeline yesterday evening prompt', uuid: 'u-tl-5', timestamp: iso(1, 22, 0) },
          { role: 'assistant', content: 'Timeline subagent body', uuid: 'a-tl-6', parentToolUseId: 'tl-tool-1', timestamp: iso(1, 22, 1) },
          { role: 'user', content: 'Timeline today morning prompt', uuid: 'u-tl-7', timestamp: iso(0, 8, 0) },
          { role: 'assistant', content: 'Timeline today long-turn reply', uuid: 'a-tl-8', timestamp: iso(0, 8, 20) },
          { role: 'user', content: 'Timeline today follow-up', uuid: 'u-tl-9', timestamp: iso(0, 8, 30) }
      ];
      // P0-DUP-OPT ③：武装后历史里多带一条「刚发出的那条用户消息」，对齐真 server 的写盘时序。
      if (dupOptimisticArmed) {
        timelineMessages.push({ role: 'user', content: DUP_OPTIMISTIC_CMD, uuid: 'u-dup-echo', timestamp: iso(0, 8, 35) });
      }
      callback({ messages: timelineMessages });
    } else if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-subagent-history') {
      // 合卡的 history 侧：形态与 live 的 test:subagent 场景一一对应（同样的 subagent_type 与
      // outputSummary），让 tool-cards.spec 能把两侧的 DOM 断言写成同一组——刷新前后不一致时必红。
      const sahTs = n => new Date(Date.now() - n * 60_000).toISOString();
      callback({
        messages: [
          { role: 'user', content: 'Subagent history prompt', uuid: 'u-sah-1', timestamp: sahTs(9) },
          {
            kind: 'tool_use', role: 'assistant', toolUseId: 'sah-agent-1', name: 'Agent',
            inputSummary: '{"description":"Review auth module","subagent_type":"code-reviewer"}',
            timestamp: sahTs(8)
          },
          // 【这里【没有】子代理的执行内容，是照着真形态来的】2026-09-10 全库实证：主 transcript
          // 里 isSidechain 一条都没有，子代理执行全在 <sessionId>/subagents/agent-*.jsonl。
          // 于是历史回放拿到的卡是空壳，内容要靠展开时的 subagent:flow 拉——上面那个处理器给的就是它。
          // 早先这里塞过一条 parentToolUseId 的 assistant，那是照着「以为的形态」写的假夹具：
          // 它让空壳缺陷在 E2E 里【物理不可见】。
          {
            kind: 'tool_result', role: 'user', toolUseId: 'sah-agent-1', ok: true,
            outputSummary: 'Subagent code-reviewer finished review.', timestamp: sahTs(6)
          },
          { role: 'assistant', content: 'Subagent history follow-up', uuid: 'a-sah-5', timestamp: sahTs(5) }
        ]
      });
    } else if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-archived') {
      callback({
        messages: [
          // uuid：P0-FORK 长按分叉锚点定位用（expandHistoryEntry 透出，见 app/src/sessions/history.js）。
          // 两轮对话：验证长按第二条 user 气泡时前端解析出的是前一条 assistant 的 uuid（a-archived-1），
          // 不是它自己的 uuid（u-archived-2）——见下方 session:fork handler 只认 assistant uuid。
          { role: 'user', content: 'Summarize archived plan', uuid: 'u-archived-1' },
          { role: 'assistant', content: 'Archived plan replay from session history.', uuid: 'a-archived-1' },
          { role: 'user', content: 'Any follow-up questions?', uuid: 'u-archived-2' },
          { role: 'assistant', content: 'No further questions needed.', uuid: 'a-archived-2' },
          // 第三轮专供 Rewind 的「文件回了、分叉没建成」那一支（P0-REWINDd）：
          // 真 server 上这一支来自 sdkForkSession 抛错，E2E 无从制造，只能在 mock 里留一个入口。
          { role: 'user', content: 'One more thing please', uuid: 'u-archived-3' },
          { role: 'assistant', content: 'Sure, anything else?', uuid: 'a-archived-3' },
          // 第四轮专供「锚点有效、但这一轮没有文件改动」那一档（P0-REWINDj）：
          // 真 server 上这是 filesChanged 为空（那一轮只跑了 Bash，没经 Edit/Write 落盘），
          // canRewind 被判 false。用户最容易撞上的恰恰是这一档——它此前只有一句无出路的提示。
          { role: 'user', content: 'Just run some shell commands', uuid: 'u-archived-4' },
          { role: 'assistant', content: 'Ran them, nothing written to disk.', uuid: 'a-archived-4' },
          // 第五轮专供另一种 canRewind:false——SDK 说这条消息没有可用检查点（快照过期/被清理）。
          // 与第四轮出路相同、成因不同，两条用例互为对照：文案判据写反会同时红。
          { role: 'user', content: 'An old turn with no snapshot', uuid: 'u-archived-5' },
          { role: 'assistant', content: 'That one is too old to restore.', uuid: 'a-archived-5' },
          // 第六轮专供「确认框还开着时会话被切走」那一档（P0-REWINDm）：preview 回完之后
          // mock 立刻推一条改了 viewingInstanceId 的 instances 广播，前端 bindView 会把
          // displayedSessionId 换掉——正是 requestSessionRewind 头部那段快照注释警告的形态。
          { role: 'user', content: 'Switch away while I decide', uuid: 'u-archived-6' },
          { role: 'assistant', content: 'Sure, take your time.', uuid: 'a-archived-6' },
          // 第七轮专供「面板开着时回到首页」那一档（P0-REWINDn）：与第六轮的区别是
          // viewingInstanceId 被清成 null ⇒ 前端 displayedSessionId 变 null。守卫若写成
          // `now?.sessionId && now.sessionId !== frozen` 会在这里短路失效，仍对冻结的旧会话
          // 执行破坏性回退（PR #102 review 的 P1）。
          { role: 'user', content: 'Go home while I decide', uuid: 'u-archived-7' },
          { role: 'assistant', content: 'Okay, heading home.', uuid: 'a-archived-7' }
        ]
      });
    } else if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-forked') {
      // P0-FORK：session:fork 成功后前端切视图会拉这条会话历史；文案与源会话不同，便于断言真切换了。
      callback({
        messages: [
          { role: 'user', content: 'Summarize archived plan', uuid: 'u-archived-1' },
          { role: 'assistant', content: 'Forked session ready.', uuid: 'a-forked-1' }
        ]
      });
    } else if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-visual-test' && foregroundFoundMissingHistoryMode) {
      foregroundFoundMissingHistoryMode = false;
      callback({
        messages: [
          { role: 'user', content: 'Recovered foreground prompt' },
          { role: 'assistant', content: 'Authoritative history after foreground reload.' }
        ]
      });
    } else if (sessionId === 'mock-session-worktree') {
      // 逐字复刻真 server 的归属校验：transcript 只存在于【驾驶轴】那个 project 目录，
      // 拿工作区轴（父仓）来查必然 sessionFileExists=false → { messages: [], error: '会话不存在' }。
      // 前端若用 currentCwd（=viewingCwd=父仓）拉历史就会踩到这一支，正是 2026-09-13 真机那格。
      if (cwd !== '/Users/you/code/claude-chat-mobile/.claude/worktrees/wt-x') {
        callback({ messages: [], error: '会话不存在' });
        return;
      }
      callback({
        messages: [
          { role: 'user', content: 'Worktree prompt', uuid: 'u-wt-1' },
          { role: 'assistant', content: 'WORKTREE_HISTORY_LOADED', uuid: 'a-wt-1' }
        ]
      });
    } else if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-gap') {
      callback({
        messages: [
          { role: 'user', content: 'Gap recovery prompt' },
          { role: 'assistant', content: 'History fallback after sync gap.' }
        ]
      });
    } else if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-older-migration') {
      callback({
        messages: [
          { role: 'user', content: 'Review older migration notes' },
          { role: 'assistant', content: 'Older migration history loaded from session:list overflow.' }
        ]
      });
    } else if (cwd === '/Users/you/code/claude-chat-mobile' && sessionId === 'mock-session-long-history') {
      // Part B：长会话切入分块渲染压测——2000 条触达 HISTORY_MAX_MESSAGES 上限（app/src/sessions/history.js）
      const messages = [];
      for (let i = 0; i < 2000; i++) {
        messages.push({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: i === 1999 ? 'Long history final message marker' : `Long history stress message #${i}`
        });
      }
      callback({ messages });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-gap-pending') {
      callback({
        messages: [
          { role: 'user', content: 'Gap pending fallback prompt' },
          { role: 'assistant', content: 'Gap pending history after buffer trim.' }
        ]
      });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-gap-question') {
      callback({
        messages: [
          { role: 'user', content: 'Gap question fallback prompt' },
          { role: 'assistant', content: 'Gap question history after buffer trim.' }
        ]
      });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-scroll-replay') {
      // P0-SCROLL-1：首次冷切入内容（30 条，撑满一屏）——不含后续"离开期间产出"的新消息，
      // 那条只在第二次 sync:since（真正切回）时作为 replay 事件补发，见下方 sync:since handler。
      const messages = [];
      for (let i = 0; i < 30; i++) {
        messages.push({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Scroll replay baseline message #${i}`
        });
      }
      callback({ messages });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-replay-flood') {
      // P0-REPLAY-BUFFER（大量积压→reload）：第一次冷切入返回一小段基线（建 DOM 缓存）；第二次
      // （bufferAction='reload' 后 loadHistory 重新拉取）返回"磁盘权威真相"，文案与 sync:since 那 165
      // 条 live 回放事件（"Flood live reply #N"）完全不同——断言只应看到这里的文案，看不到那边的，
      // 才能证明真的走了清屏 + session:history 批量渲染，而不是把缓冲事件逐条渲染出来。
      if (!replayFloodHistoryArmed) {
        replayFloodHistoryArmed = true;
        const messages = [];
        for (let i = 0; i < 4; i++) {
          messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Flood baseline message #${i}` });
        }
        callback({ messages });
      } else {
        callback({
          messages: [
            { role: 'user', content: 'Flood baseline message #0' },
            { role: 'assistant', content: 'Flood reload marker: disk history now reflects everything that piled up while away.' }
          ]
        });
      }
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-orphan-mixed') {
      const messages = [];
      for (let i = 0; i < 4; i++) {
        messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Mixed baseline message #${i}` });
      }
      callback({ messages });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-orphan') {
      // BUSY-ORPHAN：恒定返回基线（同 mock-session-replay-small 套路）。第一次冷切入靠它建 DOM 缓存，
      // 这样第二次切回才会走 'keep' → flush，让缺 result 的那批回放事件真的逐条派发出来。
      const messages = [];
      for (let i = 0; i < 4; i++) {
        messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Orphan baseline message #${i}` });
      }
      callback({ messages });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-replay-small') {
      // P0-REPLAY-BUFFER（少量积压→flush）：flush 路径不清屏、不重拉 session:history，这里恒定返回
      // 基线内容——若因回归错误地被第二次调用，仍只会重渲染这份基线（不含"Small live reply #N"），
      // 断言据此能抓到误判成 reload 的回归。
      const messages = [];
      for (let i = 0; i < 4; i++) {
        messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Small baseline message #${i}` });
      }
      if (replaySmallExternalWritten) messages.push({ role: 'user', content: 'Small terminal message written while away' });
      callback({ messages });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-replay-unread') {
      // P0-REPLAY-UNREAD-DISMISS：首次冷切入基线（同 mock-session-replay-small 套路，建 DOM 缓存）；
      // 第二次切回走 flush（不重拉 session:history），这里恒定返回同一份基线。
      const messages = [];
      for (let i = 0; i < 4; i++) {
        messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Unread replay baseline message #${i}` });
      }
      callback({ messages });
    } else if (cwd === '/Users/you/code/another-react-project' && sessionId === 'mock-session-another') {
      // TC-7 并发 tab：冷切入 inst_2 时 shouldReloadOnEnter(!hasCache && replayed>0)→reload，
      // 会 clearView 掉 sync:since 活缓冲回放，必须以磁盘 history 为真相源回填（否则 hydrated=0）。
      callback({
        messages: [
          { role: 'user', content: 'Show me status please' },
          { role: 'assistant', content: 'This is the concurrent session "Another App Concurrency" historical message!' }
        ]
      });
    } else {
      callback({ messages: [] });
    }
  });

  // 工作区 git 变更（只读）：确定性 fixture 供 P0 git-changes E2E
  socket.on('git:status', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({
      ok: true,
      branch: 'dev',
      staged: [{ path: 'staged.js', xy: 'M ' }],
      unstaged: [{ path: 'work.js', xy: ' M' }],
      untracked: [{ path: 'new-file.js' }],
      truncated: false,
    });
  });
  // 新会话的「源分支」选择器。真 server 走 git for-each-ref；这里给一组固定分支，
  // 让 E2E 能验"点开能选、选中回填"而不依赖宿主机有没有 git 仓库。
  socket.on('git:branches', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({ ok: true, branches: ['dev', 'main', 'feature/login'], current: 'dev' });
  });
  socket.on('git:diff', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const path = payload?.path || 'file.js';
    const side = payload?.side === 'staged' ? 'staged' : 'unstaged';
    ack({
      ok: true,
      path,
      side,
      patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old line\n+new line\n`,
      binary: false,
      truncated: false,
      empty: false,
    });
  });
  // 文件浏览列表：P0-21 选「浏览项目文件」后需可渲染；另两条供 P0-21b 覆盖 CM 查看器命中/回退两路。
  socket.on('browse:list', (_payload, callback) => {
    if (typeof callback !== 'function') return;
    callback({
      ok: true,
      entries: [
        { name: 'README.md', kind: 'file', size: 12, mtime: Date.now() },
        { name: 'demo.js', kind: 'file', size: 48, mtime: Date.now() },
        { name: 'huge.log', kind: 'file', size: 500_000, mtime: Date.now() },
        { name: 'conflict.js', kind: 'file', size: 20, mtime: Date.now() },
      ],
      truncated: false,
      totalCount: 4,
    });
  });

  // P0-EDIT：demo.js 可变内容 + mock "hash"（就用内容本身当哈希——不用跟真 sha256 位对位，
  // 只要「变了就不同、没变就相同」这个契约成立即可）。per-connection 状态，each gotoMock 一份新的。
  let mockDemoJsContent = 'function greet(name) {\n  return `Hello, ${name}!`;\n}\n';
  const mockHashOf = text => `mockhash:${text}`;

  // 文件浏览：browse:read（契约内事件；仅实现文本 fixture——附件的 base64 分片已归 attachment:read）。
  socket.on('browse:read', (payload, callback) => {
    if (typeof callback !== 'function') return;
    const { relPath, offset = 0, encoding } = payload || {};  // maxBytes 随附件分片一起挪去 attachment:read
    // 文本路径：工作区 untracked 预览 fixture
    if (encoding !== 'base64' && String(relPath || '') === 'new-file.js') {
      const text = 'console.log("untracked");\n';
      return callback({ ok: true, content: text, totalSize: text.length, bytesRead: text.length, truncated: false, binary: false });
    }
    // P0-21b/P0-EDIT：一次性读全的小 .js → 前端应切 CM 查看器；带 contentHash → 可编辑（files:write 基线）。
    if (encoding !== 'base64' && String(relPath || '') === 'demo.js') {
      const text = mockDemoJsContent;
      return callback({ ok: true, content: text, totalSize: text.length, bytesRead: text.length, truncated: false, binary: false, contentHash: mockHashOf(text) });
    }
    // P0-21b：首页即 truncated（模拟 >256KB）→ 前端须留在 pre 纯文本，不切 CM。
    if (encoding !== 'base64' && String(relPath || '') === 'huge.log') {
      const text = 'x'.repeat(1000);
      return callback({ ok: true, content: text, totalSize: 500_000, bytesRead: text.length, truncated: true, binary: false });
    }
    // P0-EDIT：可编辑但保存必冲突的固定 fixture（模拟"编辑期间文件被 Claude 并发改过"，不用真并发编排）。
    if (encoding !== 'base64' && String(relPath || '') === 'conflict.js') {
      const text = 'const x = 1;\n';
      return callback({ ok: true, content: text, totalSize: text.length, bytesRead: text.length, truncated: false, binary: false, contentHash: 'conflict-fixture-hash' });
    }
    // 附件不再走本通道（2026-09-06 搬家后归 attachment:read），这里不再有 .ccm-uploads 分支。
    console.log(`[mock] browse:read relPath=${relPath} offset=${offset} encoding=${encoding} 未命中 fixture`);
    return callback({ ok: false, error: '路径不在授权范围内，或不是文件' });
  });

  // E18 附件预览：attachment:read（契约内事件）。入参只有 storedName——与真实 server 一致，目录由
  // 服务端算，客户端无从表达路径。命中 MOCK_UPLOAD_FILES 才回内容，其余 ok:false（文件已删场景）。
  socket.on('attachment:read', (payload, callback) => {
    if (typeof callback !== 'function') return;
    const { storedName, offset = 0, maxBytes = 256 * 1024 } = payload || {};
    const name = String(storedName || '');
    // 镜像真实 server 的 isBareStoredName 闸：带分隔符或前导点的一律当不存在，回同一句。
    const bare = name && !/[/\\]/.test(name) && !name.startsWith('.');
    const bytes = bare ? MOCK_UPLOAD_FILES.get(name) : null;
    console.log(`[mock] attachment:read storedName=${name} offset=${offset} hit=${Boolean(bytes)}`);
    if (!bytes) return callback({ ok: false, error: '附件不存在或已被删除' });
    const slice = bytes.subarray(offset, offset + maxBytes);
    callback({
      ok: true,
      content: slice.toString('base64'),
      totalSize: bytes.length,
      bytesRead: slice.length,
      truncated: offset + slice.length < bytes.length,
      binary: true
    });
  });

  // P0-EDIT：编辑器保存。只认 demo.js，镜像真实 writeFileInScope 的 baseHash 冲突语义——
  // baseHash 不等于当前 mockHashOf(mockDemoJsContent) 即 conflict，不静默覆盖。
  socket.on('files:write', (payload, callback) => {
    if (typeof callback !== 'function') return;
    const { relPath, content, baseHash } = payload || {};
    console.log(`[mock] files:write relPath=${relPath}`);
    if (String(relPath || '') === 'conflict.js') {
      return callback({ ok: false, code: 'conflict', error: '文件已被修改（可能是 Claude 正在改），请刷新后重试' });
    }
    if (String(relPath || '') !== 'demo.js') {
      return callback({ ok: false, code: 'not_found', error: 'mock 只支持写 demo.js' });
    }
    if (baseHash !== mockHashOf(mockDemoJsContent)) {
      return callback({ ok: false, code: 'conflict', error: '文件已被修改（可能是 Claude 正在改），请刷新后重试' });
    }
    mockDemoJsContent = String(content || '');
    callback({ ok: true, contentHash: mockHashOf(mockDemoJsContent), bytesWritten: mockDemoJsContent.length });
  });

  // P0-MENTION：composer @ 文件引用候选源。固定小候选池 + 简单子串过滤（够验前端触发→防抖→
  // 渲染 chips→点选回填链路，不用照抄服务端 matchFiles 的完整分档排序算法）。
  const MOCK_MENTION_FILES = ['src/app.js', 'src/agent/agent.js', 'README.md', 'package.json'];
  socket.on('files:search', (payload, callback) => {
    if (typeof callback !== 'function') return;
    const q = String(payload?.query || '').toLowerCase().trim();
    console.log(`[mock] files:search query=${q}`);
    // 空 query：对齐真服务 / CLI @ 补全，返回全部候选（不筛）
    const paths = q
      ? MOCK_MENTION_FILES.filter(p => p.toLowerCase().includes(q))
      : MOCK_MENTION_FILES.slice();
    callback({ ok: true, paths });
  });

  // Console modal trace fetch. Production serves persisted per-session interaction logs;
  // the visual lane returns a stable mock row so Clear can be tested without real Claude.
  socket.on('logs:get', (payload, callback) => {
    if (typeof callback !== 'function') return;
    const instanceId = payload?.instanceId || viewingInstanceId;
    const inst = mockInstances.find(i => i.instanceId === instanceId);
    callback({
      logs: [{
        ts: Date.now() - 1000,
        type: 'sys_info',
        text: `[MOCK_LOG] Session trace for ${inst?.title || instanceId || 'new chat'}`,
        model: inst?.model || activeModel,
        effort: inst?.effort || 'model-default',
        permissionMode: inst?.permissionMode || permissionMode
      }, ...(mockSessionLogsByInstance.get(instanceId) || [])],
      diagLogs: mockDiagLogsByInstance.get(instanceId) || [],
    });
  });

  // 连接 RTT 探活（与真 server 对齐）：立即 ack，不改业务状态
  socket.on('conn:ping', (_payload, ack) => {
    if (typeof ack === 'function') ack({ ok: true, t: Date.now() });
  });

  // client:presence（PWA 前台/后台上报，与真 server 对齐）。真 server 在「回来」这一拍算离开时长、
  // 够久就用一次旁路提问生成会话摘要（见 src/server/app.js maybeRecapOnReturn）。mock 没有模型，
  // 改为：只要观察到 hidden true→false 的跳变就发一条固定文案的 session_recap。
  // **这里必须发**：出向契约要求 real ⊆ mock，真 server 发得出而 mock 从不产出的 type 会让
  // E2E 永远覆盖不到它（agent-event-contract.js 的 real_type_not_mock）。
  let mockWasHidden = false;
  socket.on('client:presence', (p) => {
    const hidden = !!p?.hidden;
    if (hidden) { mockWasHidden = true; return; }
    if (!mockWasHidden) return;
    mockWasHidden = false;
    const inst = mockInstances.find(i => i.instanceId === viewingInstanceId);
    io.emit('agent:event', {
      seq: 0,
      epoch: 'server',
      sessionId: inst?.sessionId || null,
      instanceId: viewingInstanceId,
      cwd: inst?.cwd,
      ts: Date.now(),
      type: 'session_recap',
      payload: { text: '正在给 agent.js 补测试，上一轮已跑通，下一步是补边界用例。', awayMs: 6 * 60_000 },
    });
  });

  // 跨设备已读位点（与真 server 对齐）：read:sync 归并客户端本地表并回权威态，read:mark 收单条增量。
  // 客户端上报的 baselineTs 一律忽略——全局单一基线正是「换设备整屏复亮」的根因修复。
  socket.on('read:sync', (payload, ack) => {
    mergeIntoReadState('seen', payload?.seen);
    mergeIntoReadState('manual', payload?.manual);
    if (typeof ack === 'function') ack({ ok: true, state: readStateSnapshot() });
  });

  socket.on('read:mark', payload => {
    const sessionId = payload?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (typeof payload?.manual === 'boolean') {
      if (payload.manual) mergeIntoReadState('manual', { [sessionId]: payload.at ?? Date.now() });
      else {
        delete mockReadState.manual[sessionId];
        mergeIntoReadState('seen', { [sessionId]: payload.at ?? Date.now() });
      }
    } else {
      mergeIntoReadState('seen', { [sessionId]: payload.seenAt ?? Date.now() });
    }
  });

  // config:refresh（CLI 配置刷新按钮，与真 server 对齐）：mock 无真实 CLI settings 可重读，ack ok 即可；
  // 小延迟让 E2E 能稳定抓到按钮的禁用→转圈→恢复这段瞬态（真 server 那边 sdkResolveSettings 本身也非零耗时）。
  socket.on('config:refresh', async (_payload, ack) => {
    await delay(150);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // 服务状态面板（与真 server service:status 契约对齐，判定化：不带裸计数器）：确定性 payload 供 E2E 断言；
  // deliveryFailure 由 test:service-delivery-failure 注入，rateLimitLockout/clientError 由 test:service-incidents 注入
  // 一键开关（真 server 会 spawn 安装器写 ~/.claude/settings.json；mock 只翻状态位并回同款报告）
  // statusline 桥的装/卸（与 hooks:setup 同构）。真 server 走 execFile 调 scripts 下的安装器，
  // 这里只切内存态——mock 的职责是让前端两条渲染分支都走得到，不是复刻安装器。
  // server 进程日志。真 server 读 LOG_FILE 的尾部；mock 给几行确定性样本 + 一条错误支
  // （test:server-log-missing 拨过去），让前端两条渲染分支都走得到。
  socket.on('logs:server', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (mockServerLogMissing) {
      return ack({ ok: false, path: '/Users/you/Library/Logs/ccm-server.log', lines: [], error: '日志文件不存在（未配置 LOG_FILE，或进程输出没有重定向到文件）' });
    }
    const limit = Number(payload?.limit) > 0 ? Math.min(Number(payload.limit), 500) : 200;
    const lines = [
      '2026-09-10T12:00:00.000+00:00 [boot] ccm server 启动，端口 3000',
      '2026-09-10T12:00:01.100+00:00 [conn] abc123 已连接（来自 127.0.0.1）',
      '2026-09-10T12:00:02.200+00:00 [hooks] CLI hooks 桥未安装',
      '2026-09-10T12:00:03.300+00:00 [push] 测试推送：成功 0 条、失败 1 条',
    ].slice(-limit);
    ack({ ok: true, path: '/Users/you/Library/Logs/ccm-server.log', lines, truncated: false, size: 4096 });
  });

  // 接入二维码。真 server 用 shared/qrcode.js 现编矩阵；mock 给一个确定性的小矩阵——
  // 前端要验的是「两步展开 + 定时隐藏 + 含不含 token」，不是编码器本身（那有自己的单测）。
  socket.on('connect:qr', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const includeToken = payload?.target !== 'public' || !mockAccessProtected;
    const size = 21;
    const matrix = Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => (r + c) % 2));
    ack({
      ok: true,
      url: includeToken ? 'http://192.168.1.9:3000/#token=mock-token-value' : 'https://ccm.example.com',
      matrix, size, includeToken,
      note: includeToken ? '' : '该域名受 Cloudflare Access 保护，二维码里不含令牌。',
    });
  });

  // 审批规则只读面。真 server 走 sdkResolveSettings 读合并后的 settings；mock 给一份确定性的
  // 三档样本，让前端的分档渲染与计数都走得到。
  socket.on('permissions:rules', (payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({
      ok: true,
      cwd: payload?.cwd || mockInstances[0].cwd,
      rules: mockPermissionRules,
    });
  });

  socket.on('statusline:setup', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const action = payload?.action;
    if (!['install', 'uninstall'].includes(action)) return ack({ ok: false, error: '未知操作' });
    mockStatuslineState = action === 'install' ? 'installed' : 'not-installed';
    ack({ ok: true, state: mockStatuslineState, report: action === 'install' ? '✅ 已接管 statusLine 命令。' : '已恢复原命令。' });
  });

  socket.on('hooks:setup', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const action = payload?.action;
    if (!['install', 'uninstall', 'verify'].includes(action)) return ack({ ok: false, error: '未知操作' });
    if (action === 'install') mockHooksState = 'installed';
    if (action === 'uninstall') mockHooksState = 'not-installed';
    ack({ ok: true, state: mockHooksState, report: action === 'install' ? '✅ 安装成功，端到端验证通过。' : '已移除。' });
    // 与真 server 一致：装/卸后广播新的安装态（前端另有 ack 回填兜底，两条都要保真）
    io.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
      type: 'instances', payload: { canRestart: mockCanRestart,
        viewingInstanceId,
        viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd),
        dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
        instances: mockInstances, service: mockServicePayload(),
      },
    });
  });

  // 测试推送：mock 默认无订阅（与真机初见形态一致，也是最需要被说清的那一态）
  socket.on('push:test', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({ ok: true, sent: 0, failed: 0, subscribed: false });
  });

  // 配置面板的读取路径。夹具刻意混了三种形态：普通值、敏感项（只给 set+length）、未设置的空值，
  // 让 E2E 能断言「敏感项显示的是遮罩文案而不是明文」。
  socket.on('env:get', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({
      ok: true,
      envFileExists: true,
      ...buildMockEnvView(),
    });
  });

  // env:set 的回声实现：**不写任何文件**，只把收到的 key 原样回给前端。
  // 这不是在测服务端（那由 env-file / env-schema 单测覆盖），而是锁住前端最关键的一条不变量：
  // 「只提交真正改动过的项」—— 全量提交会把敏感项的遮罩文案当成新值写回去，
  // AUTH_TOKEN 会变成「已设置（64 字符）」，所有设备连同正在操作的手机一起被关在门外。
  socket.on('env:set', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const changes = payload?.changes || {};
    const keys = Object.keys(changes);
    // list 档与真 server 的 checkList 同判据：非数组当场拒。
    // mock 绝不能让「送了个字符串」看起来成功了——那正是这一档当初被标只读的失败形态
    // （下游 Array.isArray 判否 → 静默回落旧白名单 → 用户看到「保存成功」而配置没变）。
    if (Object.hasOwn(changes, 'WORKDIRS')) {
      if (!Array.isArray(changes.WORKDIRS)) {
        return ack({
          ok: false,
          results: [{ key: 'WORKDIRS', level: 'error', message: '工作区列表 必须是数组（每项为路径字符串或 {path, sessionLimit}）' }],
        });
      }
      mockWorkdirsList = changes.WORKDIRS.map((e) => (typeof e === 'string' ? { path: e } : e));
    }
    // restartRequired 按 key 分档，不能恒 true：WORKDIRS 在 schema 里标着 reload:'hot'（全表唯一），
    // 改它即时生效，提示重启会诱导用户白白中断所有会话与后台任务。mock 不能 import app/src
    // （前后端边界），所以这里显式对齐真 server 的 reloadKindOf —— 那边缺省是 restart，同样保守。
    const HOT_RELOAD_KEYS = new Set(['WORKDIRS']);
    ack({ ok: true, results: [], written: keys, restartRequired: keys.some(k => !HOT_RELOAD_KEYS.has(k)) });
  });

  socket.on('service:status', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({
      ok: true,
      startedAt: MOCK_SERVICE_STARTED_AT,
      versions: { server: '1.2.1-mock', cli: '0.1.0-mock', sdk: '0.3.201-mock' },
      deliveryFailure: mockDeliveryFailure,
      rateLimitLockout: mockRateLimitLockout,
      clientError: mockClientError,
      // 「重启记录」段夹具：默认给一条例行的（每天一次的 DHCP 漂移重启，**不标黄**）。
      // 默认不给 flapping 样本：那会让 E2E 每次都看到黄字，掩盖真正的回归。
      // flapping 那条路径由 test:service-flapping 场景注入 —— 否则 alert→text-warning 这个映射
      // 从来没被断言过，把它改成恒 null 全套 E2E 照样绿（2026-08-14 第三轮审查）。
      restarts: mockRestarts,
      // 「终端会话推送」段夹具：默认未安装（新用户初见的形态，也是最需要被引导的那一态）
      hooksBridge: { state: mockHooksState, off: false },
      statuslineBridge: { state: mockStatuslineState, off: false },
      logging: { interactions: true, sdkDebug: false, stderr: true },
      timestamp: Date.now(),
    });
  });

  // 「安全日志」段夹具：确定性三条，刻意覆盖三档 severity —— 公网限速(danger) / 本机限速(warning)
  // / 设备批准(neutral)。少了「本机」那条，「来源分叉后本机不再标 danger」这个判定就从来没被
  // E2E 走过，把 describeRateLimitSource 改成恒返回 public 照样全绿。
  socket.on('audit:get', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    const base = MOCK_SERVICE_STARTED_AT;
    ack({
      ok: true,
      capacity: 5000,
      records: [
        { id: 'a3', ts: base + 60_000, action: 'auth_rate_limited', target: 'ip:203.0.113.7', outcome: 'locked', meta: { via: 'http' } },
        { id: 'a2', ts: base + 30_000, action: 'auth_rate_limited', target: 'ip:127.0.0.1', outcome: 'locked', meta: { via: 'http' } },
        { id: 'a1', ts: base, action: 'device_approved', target: 'dev0123456789', outcome: 'allowed', meta: { via: 'web' } },
      ],
    });
  });

  // UI 安全体检（④）：确定性快照。WHITELIST 特意带一条危险规则 —— renderDoctor 里
  // `c.safe.dangerous` 那段明细渲染否则从来没被 E2E 走过。
  socket.on('doctor:run', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({
      checks: [
        { id: 'AUTH_TOKEN', status: 'ok', detail: '已设置（长度 64）', safe: { isSet: true, length: 64 } },
        { id: 'CLAUDE_BIN', status: 'ok', detail: '0.1.0-mock (Claude Code)' },
        { id: 'CONFIG_PERMS', status: 'warn', detail: '1 个配置文件权限过宽（非 0600）' },
        { id: 'WHITELIST', status: 'warn', detail: '1 条偏宽规则', safe: { dangerous: [{ rule: 'Bash(*)', reason: '任意命令', scope: 'user' }] } },
      ],
      readiness: { level: 'caution', summary: '可用，但有需留意的偏宽项' },
    });
  });

  // Handle sync:since for switching workspace viewing instances and historical message hydration
  socket.on('sync:since', (payload, callback) => {
    const { instanceId, sessionId } = payload || {};
    console.log(`[mock] sync:since received for instanceId=${instanceId}, sessionId=${sessionId}`);
    // Bug2 状态对账：mock 侧有未决审批/提问快照时随 ack 带回（模拟真 server 的 pendingRequestsSnapshot）——
    // 前端 applyPendingSnapshot 在视图稳定后据此重建卡片，即使原始 permission_request 事件从未回放。
    const ack = (replayed, extra = {}) => {
      if (typeof callback === 'function') {
        const pending = (!syncPendingSnapshotInstanceId || syncPendingSnapshotInstanceId === instanceId) ? syncPendingSnapshot : null;
        const unreadOnEntry = mockUnreadOnEntryInstanceId === instanceId ? mockUnreadOnEntry : 0;
        callback({ ok: true, replayed, pending, unreadOnEntry, ...extra });
      }
    };
    // P0-DUP-OPT ②：ack 带 diskLen 大于前端已渲染的条数（timeline fixture 是 10 条），
    // 触发 shouldReloadOnEnter 的「磁盘 ahead → reload」分支。真 server 只在 replayed=0 时回这个字段
    // （replayed>0 时恒 null，外部写入改由 diskExternalLen 报），mock 默认两个都不回（null→0），
    // 所以这条分支此前在整套 E2E 里【结构性不可达】。
    if (dupOptimisticArmed && sessionId === 'mock-session-timeline') {
      console.log('[mock] P0-DUP-OPT — sync:since ack 带 diskLen=11，逼出全量重载');
      ack(0, { diskLen: 11 });
      return;
    }
    // P0-SYNC-ACK-TIMEOUT：吞掉本次 ack、连接保持。前端只能靠 socket.timeout 的 err 分支收尾——
    // 裸 ack 下这个回调永不执行，加载卡永转、历史永不加载（F3）。放在所有分支之前：吞的是整个 ack。
    if (syncAckTimeoutArmed && sessionId === 'mock-session-timeline') {
      syncAckTimeoutArmed = false;
      console.log('[mock] sync:since swallowed (sync-ack-timeout armed)');
      return;
    }
    // P0-NOSID：无 sessionId 的活实例——回放 live 事件（replayed>0），模拟「事件在流、磁盘还没有」。
    // 前端此时若走 reload 就会清屏拉 session:history（下面那条 handler 会返回一段绝不该出现的文案），
    // 正确行为是保留缓冲回放。放在 inst_2 分支之前：它按 instanceId 分流，不会互相干扰。
    if (noSessionIdMode && instanceId === 'inst_1') {
      socket.emit('agent:event', {
        seq: 1, epoch: 'mock-epoch-nosid', sessionId: null, instanceId: 'inst_1', ts: Date.now(),
        type: 'user_message', payload: { text: 'NOSID_USER_ASK' }
      });
      socket.emit('agent:event', {
        seq: 2, epoch: 'mock-epoch-nosid', sessionId: null, instanceId: 'inst_1', ts: Date.now(),
        type: 'text_delta', payload: { messageId: 'msg_nosid_1', text: 'NOSID_LIVE_FROM_BUFFER' }
      });
      ack(2);
      return;
    }
    // P1 回归（2026-09-12 PR #38 review）：回放批次里【既有已结束的旧轮、又有当前正在跑的新轮】。
    // 这是生产 sync:since 的真实形状——eventsSince 返回按 seq 的完整 FIFO，旧轮的 result 一定在里面。
    // 若只挡住 delta 不点亮、却让旧轮那条 result 照常 setBusy(false)，就会把 bindView 刚按权威
    // state='busy' 播下的 busy 清掉，而属于新轮的 delta 已不会再点亮它 → 运行条与停止钮双双消失。
    if (instanceId === 'inst_orphan_mixed') {
      if (!orphanMixedArmed) {
        orphanMixedArmed = true;
        ack(0);
        return;
      }
      const epoch = 'mock-epoch-orphan-mixed';
      const sid = 'mock-session-orphan-mixed';
      const base = { epoch, sessionId: sid, instanceId: 'inst_orphan_mixed', replay: true };
      // 逐条写成字面量、type 不走变量：agent-event-contract 的扫描器是静态的，把 type 收进辅助函数的
      // 形参会让它报 dynamic_type（本文件其余场景同样是逐条字面量，别为省行数改回去）。
      // ① 已经结束的旧轮：user_message → text_delta → result（完整 FIFO，result 必在里面）
      socket.emit('agent:event', { ...base, seq: 1, ts: Date.now(), type: 'user_message', payload: { text: 'Mixed: the turn that already finished' } });
      // 旧轮的 thinking：它绝不能渗进【当前那一轮】的 spinner 元数据（PR #38 review 第三轮 P2）
      socket.emit('agent:event', { ...base, seq: 2, ts: Date.now(), type: 'thinking_delta', payload: { messageId: 'msg_mixed_old', text: 'old-turn thinking…' } });
      socket.emit('agent:event', { ...base, seq: 3, ts: Date.now(), type: 'text_delta', payload: { messageId: 'msg_mixed_old', text: 'Mixed old-turn reply. ' } });
      socket.emit('agent:event', { ...base, seq: 4, ts: Date.now(), type: 'result', payload: { messageId: 'msg_mixed_old', durationMs: 100, costUsd: 0, isError: false, models: ['claude-3-5-sonnet'] } });
      // ② 当前仍在跑的新轮：只有 user_message + delta，没有 result（它还没结束）
      socket.emit('agent:event', { ...base, seq: 5, ts: Date.now(), type: 'user_message', payload: { text: 'Mixed: the turn that is still running' } });
      socket.emit('agent:event', { ...base, seq: 6, ts: Date.now(), type: 'text_delta', payload: { messageId: 'msg_mixed_new', text: 'Mixed new-turn chunk. ' } });
      ack(6);
      return;
    }
    // 现场复现（2026-09-12）：切回一个【已经跑完】的会话，但回放流里只有 text_delta、缺配对 result。
    // 三个 delta 各自 setBusy(true)，而清 busy 的两条通道同时不可达：轮次终止事件不在这批里，
    // instances.state 是 idle → 入场不 seed、看门狗 shouldForceClearBusyFromBroadcast 也只挂在广播上。
    // replayed=4 远低于 REPLAY_BUFFER_RELOAD_THRESHOLD(100) → 走 flush，事件真的逐条派发。
    if (instanceId === 'inst_orphan') {
      if (!orphanReplayArmed) {
        orphanReplayArmed = true;
        ack(0);
        return;
      }
      const epoch = 'mock-epoch-orphan';
      const sid = 'mock-session-orphan';
      socket.emit('agent:event', {
        seq: 1, epoch, sessionId: sid, instanceId: 'inst_orphan', ts: Date.now(),
        type: 'user_message', payload: { text: 'Orphan replay: the turn that finished while I was away' }, replay: true
      });
      for (let i = 0; i < 3; i++) {
        socket.emit('agent:event', {
          seq: i + 2, epoch, sessionId: sid, instanceId: 'inst_orphan', ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_orphan_1', text: `Orphan live chunk #${i}. ` }, replay: true
        });
      }
      ack(4); // 故意不发 result：这正是被测的形态
      return;
    }
    if (instanceId === 'inst_2') {
      if (busySilentSwitchMode) {
        // 静默窗口：只回放 user_message（replayed=1 → !hasCache 触发 reload 分支），
        // 故意不发 text_delta/tool_use/result——这些会各自 setBusy，掩盖「reload 后运行条被抹掉」的缺陷。
        // 运行态真相靠 instances 广播的 inst_2.state='busy'（bindView 入场 seed + reload 后 reseed）。
        socket.emit('agent:event', {
          seq: 1, epoch: 'mock-epoch-another', sessionId: 'mock-session-another', instanceId: 'inst_2', ts: Date.now(),
          type: 'user_message', payload: { text: 'Run the long P0 suite in background' }
        });
        ack(1);
        return;
      }
      // Replay some historical message events for inst_2
      socket.emit('agent:event', {
        seq: 1, epoch: 'mock-epoch-another', sessionId: 'mock-session-another', instanceId: 'inst_2', ts: Date.now(),
        type: 'user_message', payload: { text: 'Show me status please' }
      });
      socket.emit('agent:event', {
        seq: 2, epoch: 'mock-epoch-another', sessionId: 'mock-session-another', instanceId: 'inst_2', ts: Date.now(),
        type: 'text_delta', payload: { messageId: 'msg_another_1', text: 'This is the concurrent session "Another App Concurrency" historical message!' }
      });
      socket.emit('agent:event', {
        seq: 3, epoch: 'mock-epoch-another', sessionId: 'mock-session-another', instanceId: 'inst_2', ts: Date.now(),
        type: 'result', payload: { messageId: 'msg_another_1', durationMs: 1000, costUsd: 0.0005, isError: false, models: ['claude-3-5-haiku'] }
      });
      ack(3);
    } else if (instanceId === 'inst_scroll_replay') {
      // P0-SCROLL-1：第一次切入（!hasCache）→ shouldReloadOnEnter 走 'reload'，走 loadHistory 拉
      // session:history 的 30 条基线、不靠这里的回放（同 inst_2 的 TC-7 注释）；这里只 ack(0)。
      // 第二次切回（hasCache=true）→ 'keep' 分支，推一条"离开期间产生的新内容"验证强制落底。
      if (!switchBackReplayArmed) {
        switchBackReplayArmed = true;
        ack(0);
      } else {
        // 补发内容必须实际撑出可观高度（>120px scrollBottom() 的 near 阈值），否则旧代码「侥幸」
        // 落在 near 判定内也会通过，测不出「不强制补一次落底就停在旧位置」这个真实 bug——单行短
        // 文本不够，用多行长文本模拟真实的一段长回复。
        socket.emit('agent:event', {
          seq: 1, epoch: 'mock-epoch-scroll-replay', sessionId: 'mock-session-scroll-replay', instanceId: 'inst_scroll_replay', ts: Date.now(),
          type: 'user_message', payload: { text: 'What happened while I was away? Please give me the full detailed status report.' }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: 'mock-epoch-scroll-replay', sessionId: 'mock-session-scroll-replay', instanceId: 'inst_scroll_replay', ts: Date.now(),
          type: 'text_delta', payload: {
            messageId: 'msg_scroll_replay_1',
            text: 'This new message arrived while you were on another tab.\n\n' +
              Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: a fairly long status update produced while you were away, so this reply spans many lines.`).join('\n\n')
          }
        });
        socket.emit('agent:event', {
          seq: 3, epoch: 'mock-epoch-scroll-replay', sessionId: 'mock-session-scroll-replay', instanceId: 'inst_scroll_replay', ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_scroll_replay_1', durationMs: 500, costUsd: 0.0002, isError: false, models: ['claude-3-5-sonnet'] }
        });
        ack(3);
      }
    } else if (instanceId === 'inst_replay_flood') {
      // P0-REPLAY-BUFFER（大量积压→reload）：第一次冷入场同 inst_scroll_replay，只 ack(0) 走
      // loadHistory 建 DOM 缓存。第二次（切回）一口气推 55 轮×3 事件=165 条（user_message+text_delta+
      // result），远超 REPLAY_BUFFER_RELOAD_THRESHOLD（logic.js，100）——客户端应判定 'reload'：
      // 丢弃这批缓冲事件、改走上面 session:history 的第二段"权威真相"，故这里的 "Flood live reply #N"
      // 文案绝不应该出现在最终渲染结果里。
      if (!replayFloodSyncArmed) {
        replayFloodSyncArmed = true;
        ack(0);
      } else {
        const epoch = 'mock-epoch-replay-flood';
        const sid = 'mock-session-replay-flood';
        for (let i = 0; i < 55; i++) {
          const mid = `flood_msg_${i}`;
          const ts = Date.now();
          socket.emit('agent:event', {
            seq: i * 3 + 1, epoch, sessionId: sid, instanceId: 'inst_replay_flood', ts,
            type: 'user_message', payload: { text: `Flood live turn #${i}` }, replay: true
          });
          socket.emit('agent:event', {
            seq: i * 3 + 2, epoch, sessionId: sid, instanceId: 'inst_replay_flood', ts,
            type: 'text_delta', payload: { messageId: mid, text: `Flood live reply #${i} should never render (reload should discard it)` }, replay: true
          });
          socket.emit('agent:event', {
            seq: i * 3 + 3, epoch, sessionId: sid, instanceId: 'inst_replay_flood', ts,
            type: 'result', payload: { messageId: mid, durationMs: 10, costUsd: 0, isError: false, models: ['claude-3-5-sonnet'] }, replay: true
          });
        }
        if (replayFloodSlowAck) {
          replayFloodSlowAck = false;
          console.log('[mock] P0-REPLAY-SLOWACK — 165 条已推，ack 推迟 4s（晚于前端回放缓冲的 3s 超时）');
          setTimeout(() => ack(165), 4000);
        } else {
          ack(165);
        }
      }
    } else if (instanceId === 'inst_replay_small') {
      // P0-REPLAY-BUFFER（少量积压→flush）：第二次（切回）推 7 轮×3 事件=21 条，低于阈值——客户端
      // 应判定 'flush'：按序正常派发（走原 handler），只是抑制中间各自的滚动、派发完一次性强制落底。
      // 与基线（session:history 建立的 4 条）一起，最终应同时看到基线 + 这 21 条对应的内容。
      if (!replaySmallSyncArmed) {
        replaySmallSyncArmed = true;
        ack(0);
      } else {
        const epoch = 'mock-epoch-replay-small';
        const sid = 'mock-session-replay-small';
        for (let i = 0; i < 7; i++) {
          const mid = `small_msg_${i}`;
          const ts = Date.now();
          socket.emit('agent:event', {
            seq: i * 3 + 1, epoch, sessionId: sid, instanceId: 'inst_replay_small', ts,
            type: 'user_message', payload: { text: `Small live turn #${i}` }, replay: true
          });
          socket.emit('agent:event', {
            seq: i * 3 + 2, epoch, sessionId: sid, instanceId: 'inst_replay_small', ts,
            type: 'text_delta', payload: { messageId: mid, text: `Small live reply #${i} rendered via flush` }, replay: true
          });
          socket.emit('agent:event', {
            seq: i * 3 + 3, epoch, sessionId: sid, instanceId: 'inst_replay_small', ts,
            type: 'result', payload: { messageId: mid, durationMs: 10, costUsd: 0, isError: false, models: ['claude-3-5-sonnet'] }, replay: true
          });
        }
        // 离开期间终端写了第 5 条（基线 4 条之后），前端已渲染 4 条 → 该重载
        if (replaySmallExternalArmed) replaySmallExternalWritten = true;
        ack(21, replaySmallExternalArmed ? { diskLen: null, diskExternalLen: 5 } : {});
      }
    } else if (instanceId === 'inst_replay_unread') {
      // P0-REPLAY-UNREAD-DISMISS（回放缓冲程序性落底 × 未读胶囊自动确认已读协同）：同 inst_replay_small
      // 的两段式门控（第二次切回推 21 条低于阈值的积压事件 → flush + scrollBottom(true) 程序性落底），
      // 但第二次 ack 额外挂 unreadOnEntry=3——验证"切入积压未读会话时程序性落底不应误清胶囊，只有用户
      // 后续真实滚动到底部才应该"（app.js shouldAckUnreadOnScroll + scrollBottom 的 programmaticScrollUntil
      // 窗口）。ack() 默认按 mockUnreadOnEntry/mockUnreadOnEntryInstanceId 单例算出的值恒为 0（本场景不
      // 设置那对全局字段）——用 extra.unreadOnEntry 直接覆盖，自包含，不与 test:unread-pill（inst_2）
      // 等其它场景共享可变状态，不受测试执行顺序影响。
      if (!replayUnreadSyncArmed) {
        replayUnreadSyncArmed = true;
        ack(0);
      } else {
        const epoch = 'mock-epoch-replay-unread';
        const sid = 'mock-session-replay-unread';
        for (let i = 0; i < 7; i++) {
          const mid = `unread_replay_msg_${i}`;
          const ts = Date.now();
          socket.emit('agent:event', {
            seq: i * 3 + 1, epoch, sessionId: sid, instanceId: 'inst_replay_unread', ts,
            type: 'user_message', payload: { text: `Unread replay live turn #${i}` }, replay: true
          });
          socket.emit('agent:event', {
            seq: i * 3 + 2, epoch, sessionId: sid, instanceId: 'inst_replay_unread', ts,
            type: 'text_delta', payload: { messageId: mid, text: `Unread replay live reply #${i} rendered via flush` }, replay: true
          });
          socket.emit('agent:event', {
            seq: i * 3 + 3, epoch, sessionId: sid, instanceId: 'inst_replay_unread', ts,
            type: 'result', payload: { messageId: mid, durationMs: 10, costUsd: 0, isError: false, models: ['claude-3-5-sonnet'] }, replay: true
          });
        }
        ack(21, { unreadOnEntry: 3 });
      }
    } else if (instanceId === 'inst_worktree') {
      // 重连后的 sync:since 回 gap，逼前端走 reloadCurrentFromHistory（**不是** bindView 的 reload
      // 分支——那条用 entry.cwd，早就是对的）。这条路径的注释原话：「锁屏/切后台冻结页面断开 socket，
      // viewingInstanceId 全程不变，故不会走 bindView，只会走到这里」，正是真机复现的那一格。
      ack(0, { gap: true });
    } else if (instanceId === 'inst_gap') {
      socket.emit('agent:event', {
        seq: 1, epoch: 'mock-epoch-gap-partial', sessionId: 'mock-session-gap', instanceId: 'inst_gap', ts: Date.now(),
        type: 'text_delta', payload: { messageId: 'msg_gap_partial', text: 'Partial gap buffer that must be discarded' }
      });
      ack(1, { gap: true });
    } else if (instanceId === 'inst_gap_pending') {
      socket.emit('agent:event', {
        seq: 1, epoch: 'mock-epoch-gap-pending-partial', sessionId: 'mock-session-gap-pending', instanceId: 'inst_gap_pending', ts: Date.now(),
        type: 'text_delta', payload: { messageId: 'msg_gap_pending_partial', text: 'Partial pending gap buffer that must be discarded' }
      });
      ack(1, { gap: true });
    } else if (instanceId === 'inst_gap_question') {
      socket.emit('agent:event', {
        seq: 1, epoch: 'mock-epoch-gap-question-partial', sessionId: 'mock-session-gap-question', instanceId: 'inst_gap_question', ts: Date.now(),
        type: 'text_delta', payload: { messageId: 'msg_gap_question_partial', text: 'Partial question gap buffer that must be discarded' }
      });
      ack(1, { gap: true });
    } else if (instanceId === 'inst_1') {
      if (foregroundFoundMissingMode) {
        foregroundFoundMissingMode = false;
        ack(0, { found: false });
        return;
      }
      if (foregroundSyncReplayMode) {
        foregroundSyncReplayMode = false;
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_foreground_sync_1', text: 'Foreground sync baseline response.' }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_foreground_sync_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Foreground sync replay completed.' }
        });
        ack(3);
        return;
      }
      ack(0); // Fallback to history or empty
    } else {
      ack(0);
    }
  });

  const scenarioRegistry = createVisualMockScenarioRegistry([
    ...createStatusScenarios(() => ({
      io, socket, activeEpoch, viewingInstanceId, activeModel, permissionMode, mockInstances, delay, addMockSessionLog,
      setMockDeliveryFailure: value => { mockDeliveryFailure = value; },
      setMockServiceIncidents: ({ rateLimitLockout = null, clientError = null } = {}) => {
        mockRateLimitLockout = rateLimitLockout; mockClientError = clientError;
      },
      setMockRestarts: value => { mockRestarts = value; },
      setMockCanRestart: value => { mockCanRestart = value; },
      getMockCanRestart,
      setViewingInstanceId: value => { viewingInstanceId = value; },
      // test:server-restart：把 service.startedAt 拨到另一个值（模拟重连到重启后的新 server 进程）
      // + 广播时带上同形 service payload（真 server 的 instances 广播恒带 service 字段）。
      bumpServiceStartedAt: () => { mockServiceStartedAtOverride = (mockServiceStartedAtOverride ?? MOCK_SERVICE_STARTED_AT) + 60_000; },
      mockServicePayload,
    })),
    ...createContentScenarios(() => ({
      io, socket, activeEpoch, viewingInstanceId, activeModel, mockInstances, delay, mockServicePayload, getMockCanRestart,
      setViewingInstanceId: value => { viewingInstanceId = value; },
      armHistoryOrderRace: () => { historyOrderRaceArmed = true; },
      armHistoryAckTimeout: () => { historyAckTimeoutArmed = true; },
      armSyncAckTimeout: () => { syncAckTimeoutArmed = true; },
    })),
    {
      // commands_changed（SDK 0.3.229）：CLI 中途发现新命令/skill 时的全量推送。真 server 侧由
      // app/src/agent/agent.js 的同名 subtype 分支转成 slash_commands 事件，这里直接产出那个事件。
      //
      // 列表故意与首帧 init 的（help / model / effort）**不同且不是超集**：契约语义是 REPLACE 整份
      // 列表而非合并，只有让旧命令真的消失，E2E 才区分得出这两种实现。保留 model 一项是因为
      // app.js 对 `/model` 有条 includes('model') 的特判分支，去掉它会顺带改变那条无关行为。
      commands: ['test:commands-changed'],
      run: async ({ activeInst }) => {
        // epoch:'server' 与首帧 init/models 同源：这类会话元信息不属于任何一轮对话，
        // 走 dispatcher 的 seq 去重会被当成重复丢弃（lastSeq 早被本轮用户消息推过 0）。
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'slash_commands', payload: {
            slashCommands: [
              { name: 'deploy', description: 'Deploy to production' },
              { name: 'rollback', description: 'Roll back the last deploy' },
              { name: 'model', description: 'Switch active model' },
              // ★ color 必须留在这份新列表里，否则「推送后 /color 仍不出现在补全」那条断言恒真
              // ——新列表本来就没有它，测的就不是「名单是否被沿用」了（正对照：仪器得先看得见）。
              // 真 server 侧这条路【带不到】terminal 名单（SDK 的 SlashCommand[] 无该标记），
              // 所以这里也不发 terminalSlashCommands，让前端走「缺省即保留」那条分支。
              { name: 'color', description: 'Set the prompt bar color for this session' },
            ],
          },
        });
        // 收尾这一轮：不发 result 的话发送钮停在 stop 态，后续断言得先等 20s 超时窗。
        // 真 server 侧 slash_commands 与回合是两条独立的线，这里补 result 纯粹是让夹具可用。
        activeInst.state = 'idle';
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_cmds_changed', durationMs: 20, costUsd: 0, isError: false, models: [activeModel] },
        });
      },
    },
    {
      // P0-12f 的武装命令：只置标志、不改任何视图状态，把「在途旧包」留到下一次 session:new 再发。
      // 必须在一个【已有 sessionId 的会话】里发，否则旧包里没有可重填的 sessionId，FE-001 的
      // `if (target?.sessionId)` 早退，用例就测了个空。
      commands: ['test:stale-instances-on-new'],
      run: async ({ activeInst }) => {
        staleInstancesOnNextNew = true;
        console.log('[mock] test:stale-instances-on-new — 下一次 session:new 前插一条在途旧 instances 包');
        activeInst.state = 'idle';
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_stale_arm', durationMs: 20, costUsd: 0, isError: false, models: [activeModel] },
        });
      },
    },
    {
      // 下一步建议：真 server 在 result 结算【之后】用一次旁路提问生成（src/agent/agent.js maybeSuggest），
      // 所以这里的顺序也是先 result 再 prompt_suggestion——建议条的显示时机依赖"这一轮已经收尾"。
      // 出向契约要求 real ⊆ mock：真 server 发得出而 mock 从不产出的 type，E2E 永远覆盖不到。
      commands: ['test:prompt-suggestion'],
      run: async ({ activeInst }) => {
        activeInst.state = 'idle';
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_suggestion', durationMs: 30, costUsd: 0, isError: false, models: [activeModel] },
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'prompt_suggestion', payload: { text: '给 agent.js 补几个边界用例' },
        });
      },
    },
    {
      // 额度墙「到点自动继续」（真 server：src/server/auto-continue.js）。前三条各造一个相位的横幅条目，
      // resetsAt 取「今天 15:50」让文案可断言；第四条模拟到点后真 server 代发的那句（user_message 带
      // origin:auto-continuation）。先发 result 收尾本轮：场景命中后不走回合收尾，不发的话发送钮停在 stop。
      commands: ['test:auto-continue-armed', 'test:auto-continue-offered', 'test:auto-continue-stale', 'test:auto-continue-fired'],
      run: async ({ cmd, activeInst }) => {
        activeInst.state = 'idle';
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: activeInst.sessionId, instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_auto_continue', durationMs: 30, costUsd: 0, isError: false, models: [activeModel] },
        });
        if (cmd === 'test:auto-continue-fired') {
          socket.emit('agent:event', {
            seq: 2, epoch: activeEpoch, sessionId: activeInst.sessionId, instanceId: viewingInstanceId, ts: Date.now(),
            type: 'user_message',
            payload: { text: 'Your usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.', uuid: 'u-auto-continue-1', origin: 'auto-continuation' },
          });
          return;
        }
        const reset = new Date(); reset.setHours(15, 50, 0, 0);
        const phase = cmd.slice('test:auto-continue-'.length);
        mockAutoContinue = [{
          sessionId: activeInst.sessionId, cwd: activeInst.cwd, phase,
          reason: phase === 'offered' ? 'disabled' : phase === 'stale' ? 'slept' : null,
          resetsAt: reset.getTime(), fireAt: phase === 'armed' ? reset.getTime() + 30_000 : null,
          rateLimitType: 'five_hour', origin: 'auto',
        }];
        broadcastAutoContinue();
      },
    },
    {
      // 建议条的生命周期：显示之后【不经输入框】开一轮新的，再在轮内补一条迟到的建议。
      // 中段对应真实里几条都不碰输入框的驾驶路径（审批/选项回答、另一台设备、CLI 侧），
      // 末段对应 server 的 askSide 先返回、用户那条消息随后才到的窗口——maybeSuggest 的
      // pendingTurns 闸在那一刻还是 0，放行的建议会落到一块已经在跑的屏幕上。
      commands: ['test:prompt-suggestion-stale'],
      run: async ({ activeInst }) => {
        activeInst.state = 'idle';
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_suggestion_stale_0', durationMs: 30, costUsd: 0, isError: false, models: [activeModel] },
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'prompt_suggestion', payload: { text: '给 agent.js 补几个边界用例' },
        });
        await delay(300);
        activeInst.state = 'busy';
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_suggestion_stale', text: '新一轮已经开跑。' },
        });
        await delay(300);
        socket.emit('agent:event', {
          seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'prompt_suggestion', payload: { text: '这条建议迟到了' },
        });
        await delay(300);
        // 栅栏：这句上屏 ⇒ 上面那条迟到建议一定已被前端处理过。没有它，「仍然没显示」只是
        // 在赛跑里跑赢了一次，换台慢机器就变成假绿。
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_suggestion_stale', text: '迟到建议已送达。' },
        });
        await delay(100);
        activeInst.state = 'idle';
        socket.emit('agent:event', {
          seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_suggestion_stale', durationMs: 30, costUsd: 0, isError: false, models: [activeModel] },
        });
      },
    },
    {
      commands: ['test:question', 'test:question-multi', 'test:question-duplicate', 'test:question-remote-resolved', 'test:question-result-error'],
      run: async ({ cmd, activeInst }) => {
        console.log(`[mock] Starting ${cmd} sequence`);
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_quest_1', text: '<thinking>Claude needs clarifying requirements before proceeding...</thinking>' }
        });
        await delay(500);

        questSeq += 1;
        const questToolId = `t_ask_choice_${questSeq}`;
        const questMsgId = `msg_quest_${questSeq}`;
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: questToolId, name: 'AskUserQuestion', inputSummary: 'Choose a publish channel' }
        });
        await delay(500);

        activeInst.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        const questMulti = cmd === 'test:question-multi';
        pendingQuestion = {
          requestId: `${questToolId}#0`,
          toolUseId: questToolId,
          messageId: questMsgId,
          header: questMulti ? 'Deploy targets' : undefined,
          multiSelect: questMulti,
          options: ['main (Stable Production)', 'dev (Bleeding-Edge Integration)', 'release-v1.0 (LTS)']
        };

        const questionEvent = {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'question', payload: {
            requestId: pendingQuestion.requestId,
            text: 'We are ready to tag and deploy this mobile dashboard app. Which branch should be our target publish destination?',
            // header / multiSelect 与真 server 逐字段对齐（agent.js:1445-1453）。此前 mock 一条都不发，于是
            // approval-questions.js 的整个多选分支（☐ 前缀 / 提示行 /「确认选择」按钮 / optionIndexes 回程）在
            // E2E 里不可达——而 mock 的【入站】handler 早就解析 optionIndexes 了（本文件 user:answer 分支）：
            // 回程建好了、去程从未建起来，正是平行实现漂移的形状。test:question-multi 撑开这一档。
            header: pendingQuestion.header,
            multiSelect: pendingQuestion.multiSelect,
            options: pendingQuestion.options
          }
        };

        // Emit multi-choice question
        socket.emit('agent:event', questionEvent);
        if (cmd === 'test:question-duplicate') {
          socket.emit('agent:event', { ...questionEvent, seq: 4, ts: Date.now(), type: 'question' });
        }
        if (cmd === 'test:question-result-error') {
          await delay(600);
          activeInst.state = 'idle';
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
          });
          socket.emit('agent:event', {
            seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'result', payload: { messageId: pendingQuestion.messageId, durationMs: 900, costUsd: 0.001, isError: true, errors: ['mock question turn failed'], models: [activeModel] }
          });
          pendingQuestion = null;
        }
        if (cmd === 'test:question-remote-resolved') {
          await delay(600);
          const selectedOption = pendingQuestion.options[0];
          io.emit('agent:event', {
            seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'request_resolved', payload: { requestId: pendingQuestion.requestId, kind: 'question', outcome: 'option 0' }
          });
          socket.emit('agent:event', {
            seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'tool_result', payload: { toolUseId: pendingQuestion.toolUseId, ok: true, outputSummary: `answered on another trusted device: ${selectedOption}`, denyKind: 'answered' }
          });
          socket.emit('agent:event', {
            seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'text_delta', payload: { messageId: pendingQuestion.messageId, text: `\n\nQuestion was answered on another trusted device: **${selectedOption}**.` }
          });
          await delay(250);
          activeInst.state = 'idle';
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
          });
          socket.emit('agent:event', {
            seq: 7, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'result', payload: { messageId: pendingQuestion.messageId, durationMs: 900, costUsd: 0.001, isError: false, models: [activeModel] }
          });
          pendingQuestion = null;
        }
      },
    },
    {
      // P0-06-NOEND（2026-09-22 review P1）：审批挂着时来一条「不结束轮次」的 error。真 server 上是轮中切权限档
      // 失败（agent.setPermissionMode 没有 busy 守卫）、socket handler 抛错这类，payload 带 endsTurn:false。
      // 先走 test:permission 把审批挂上，再按 socket handler 抛错的形状推那条 error（epoch:'server'、不带
      // instanceId——前端落到当前查看的 tab 上）。不占 seq：批准之后那一轮的续发从 seq 4 起，占了会被去重吞掉。
      command: 'test:permission-then-noend-error',
      run: async ctx => {
        await scenarioRegistry.run('test:permission', ctx);
        await delay(300);
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'error', payload: { message: '服务端处理 user:setPermissionMode 出错：boom', recoverable: true, endsTurn: false },
        });
      },
    },
    {
      commands: ['test:permission', 'test:permission-persistable', 'test:permission-remote-resolved', 'test:permission-result-error'],
      run: async ({ cmd, activeInst }) => {
        console.log(`[mock] Starting ${cmd} sequence`);
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'thinking_delta', payload: { messageId: 'msg_perm_1', text: '<thinking>Preparing to push local test commits to the remote origin server...</thinking>' }
        });
        await delay(500);

        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: 't_git_push', name: 'run_command', inputSummary: 'git push origin main' }
        });
        await delay(500);

        if (alwaysAllowedPermissionNamesByInstance.get(viewingInstanceId)?.has('run_command')) {
          socket.emit('agent:event', {
            seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'tool_result', payload: { toolUseId: 't_git_push', ok: true, outputSummary: 'git push success: branch main -> origin' }
          });
          socket.emit('agent:event', {
            seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'text_delta', payload: { messageId: 'msg_perm_1', text: '\n\n✓ Successfully pushed latest codebase additions!' }
          });
          await delay(250);
          activeInst.state = 'idle';
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
          });
          socket.emit('agent:event', {
            seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'result', payload: { messageId: 'msg_perm_1', durationMs: 900, costUsd: 0.001, isError: false, models: [activeModel] }
          });
          return;
        }

        activeInst.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        pendingPermission = {
          requestId: 'req_perm_git_push',
          toolUseId: 't_git_push',
          messageId: 'msg_perm_1',
          name: 'run_command',
          input: 'git push origin main',
          cwd: activeInst.cwd
        };

        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'permission_request', payload: {
            requestId: pendingPermission.requestId,
            name: pendingPermission.name,
            input: pendingPermission.input,
            cwd: pendingPermission.cwd,
            ...mockPermFields(pendingPermission.name, pendingPermission.input, pendingPermission.cwd),
            // test:permission-persistable 才带——真 server 只在 CLI 给了会落盘的 suggestions 时下发这个字段，
            // 而实测它很稀疏（7MB 日志里两条）。默认不带，正是为了让「没有永久选项」那条主路径也被测到。
            ...(cmd === 'test:permission-persistable' ? { persistDestinations: ['localSettings'] } : {}),
          }
        });

        if (cmd === 'test:permission-result-error') {
          await delay(600);
          activeInst.state = 'idle';
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
          });
          socket.emit('agent:event', {
            seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'result', payload: { messageId: pendingPermission.messageId, durationMs: 900, costUsd: 0.001, isError: true, errors: ['mock permission turn failed'], models: [activeModel] }
          });
          pendingPermission = null;
        }

        if (cmd === 'test:permission-remote-resolved') {
          await delay(600);
          io.emit('agent:event', {
            seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'request_resolved', payload: { requestId: pendingPermission.requestId, kind: 'permission', outcome: 'allow' }
          });
          socket.emit('agent:event', {
            seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'tool_result', payload: { toolUseId: pendingPermission.toolUseId, ok: true, outputSummary: 'approved on another trusted device: git push success' }
          });
          socket.emit('agent:event', {
            seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'text_delta', payload: { messageId: pendingPermission.messageId, text: '\n\nPermission was approved on another trusted device.' }
          });
          await delay(250);
          activeInst.state = 'idle';
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
          });
          socket.emit('agent:event', {
            seq: 7, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'result', payload: { messageId: pendingPermission.messageId, durationMs: 900, costUsd: 0.001, isError: false, models: [activeModel] }
          });
          pendingPermission = null;
        }
      },
    },
    {
      command: 'test:fresh-settings-echo',
      run: async ({ requestedModel }) => {
        console.log('[mock] test:fresh-settings-echo — 回显新会话首发设置');
        await delay(150);
        const freshInst = openFreshMockInstance(requestedModel);
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: freshInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        const effectiveModel = requestedModel || '未指定(沿用)';
        const effectiveEffort = freshInst.effort || 'model-default';
        await delay(250);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: null, instanceId: freshInst.instanceId, ts: Date.now(),
          type: 'text_delta', payload: {
            messageId: 'msg_fresh_settings_echo_1',
            text: `新会话设置回显：model=${effectiveModel}; permission=${freshInst.permissionMode}; effort=${effectiveEffort}`
          }
        });

        freshInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: freshInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: null, instanceId: freshInst.instanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_fresh_settings_echo_1', durationMs: 250, costUsd: 0, isError: false, models: [requestedModel || activeModel] }
        });
      },
    },
    {
      command: 'test:settings-echo',
      run: async ({ activeInst, requestedModel }) => {
        console.log('[mock] Echoing selected model / permission / effort for settings regression');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        const effectiveModel = requestedModel || '未指定(沿用)';
        const effectivePermission = activeInst.permissionMode || permissionMode || 'default';
        const effectiveEffort = activeInst.effort || effortLevel || 'model-default';
        await delay(250);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: {
            messageId: 'msg_settings_echo_1',
            text: `设置回显：model=${effectiveModel}; permission=${effectivePermission}; effort=${effectiveEffort}`
          }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_settings_echo_1', durationMs: 250, costUsd: 0, isError: false, models: [requestedModel || activeModel] }
        });
      },
    },
    {
      commands: ['test:pendingsnapshot', 'test:pendingsnapshot-duplicate'],
      run: async ({ cmd }) => {
        // Bug2 regression: sync:since ack.pending must rebuild cards when the original event is gone.
        console.log(`[mock] ${cmd} — 设快照但不发 permission_request，切 viewing 到 inst_2 触发 sync:since`);
        const permissionSnapshot = { requestId: 'req_snapshot', name: 'run_command', input: 'rm -rf /tmp/stale', cwd: mockInstances.find(i => i.instanceId === 'inst_2')?.cwd };
        syncPendingSnapshot = {
          permissions: cmd === 'test:pendingsnapshot-duplicate' ? [permissionSnapshot, permissionSnapshot] : [permissionSnapshot],
          questions: []
        };
        syncPendingSnapshotInstanceId = 'inst_2';
        viewingInstanceId = 'inst_2';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: mockInstances.find(i => i.instanceId === 'inst_2')?.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      // 日志文件不存在档：验前端点名原因，而不是显示成一份看起来很干净的空日志
      command: 'test:server-log-missing',
      run: async () => {
        console.log('[mock] test:server-log-missing — logs:server 走 ENOENT 支');
        mockServerLogMissing = true;
      },
    },
    {
      // 未读角标：切到 inst_2 时 sync:since ack 带 unreadOnEntry=1，模拟离开期间攒了 1 条未读顶层消息。
      // inst_2 的默认 sync:since 回放固定是 2 条顶层气泡（user_message + text_delta 各一），
      // unreadOnEntry=1 应定位到最后一条（resolveUnreadAnchorIndex(2,1)=1）。
      // P0-11x：给两条无 live 实例的主工作区会话标上终端直跑态，验证抽屉 ⌨️ 徽标 busy/alive 两态可区分。
      command: 'test:hooks-installed',
      run: async () => {
        console.log('[mock] test:hooks-installed — 配置面板「终端会话推送」显示已启用');
        mockHooksState = 'installed';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd),
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload(),
          },
        });
      },
    },
    {
      // 真 server 读 ~/.claude 出错时（文件损坏/权限变更）会广播 state:'unknown'
      // （app/src/ops/cli-hooks-bridge.js:322 的 catch）。这一档早先被前端判成"整段不渲染"，
      // 而它是手机上唯一能看到 hooks 桥的入口——消失即彻底失联。
      command: 'test:hooks-unknown',
      run: async () => {
        console.log('[mock] test:hooks-unknown — 安装态读取失败（服务端 catch 分支）');
        mockHooksState = 'unknown';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd),
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload(),
          },
        });
      },
    },
    {
      command: 'test:terminal-badge',
      run: async () => {
        console.log('[mock] test:terminal-badge — archived=busy / gap=alive，下次 session:list 带 terminal 字段');
        terminalBadgeArmed = true;
      },
    },
    {
      command: 'test:bg-locked',
      run: async () => {
        console.log('[mock] test:bg-locked — gap 会话被后台 agent 独占：列表带 bgLocked，switch 一律拒');
        bgLockedArmed = true;
      },
    },
    {
      // 2026-09-13：会话开着的时候那棵 worktree 被删掉（真机顺序就是这样——模型自己
      // `git worktree remove` 完，同一个会话还在跑）。真 server 侧 instance.cwd **保持悬空**
      // （transcript 仍按它解析），另发一个 panelCwd 承担展示轴；这里逐字模拟那份广播。
      command: 'test:worktree-gone',
      run: async () => {
        console.log('[mock] test:worktree-gone — wt-x 被删：列表行标已删、面板回落父仓、switch 拒');
        worktreeGoneArmed = true;
        const inst = mockInstances.find(i => i.instanceId === 'inst_worktree');
        if (inst) {
          inst.panelCwd = '/Users/you/code/claude-chat-mobile'; // 驾驶轴 cwd 刻意不动
          inst.worktreeGone = true;
        }
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd),
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload(),
          },
        });
      },
    },
    {
      command: 'test:desktop-badge',
      run: async () => {
        console.log('[mock] test:desktop-badge — archived/visual=busy、gap=alive，来源均 claude-desktop');
        desktopBadgeArmed = true;
        // 1.5s 后只改一个 live 实例的 state 并广播 instances（实例集合不变）。前端据此走
        // 「非结构变化 → refreshDirBadges + refreshSessionStatusChips」增量分支，逐行【从
        // row.dataset 重建 chip】——这正是首次渲染路径覆盖不到的那一段。用例拿 inst_1 变成
        // 「需要你」当广播到达的锚点，再断言无 live 实例的那行来源没丢。
        setTimeout(() => {
          const live = mockInstances.find(i => i.instanceId === 'inst_1');
          if (live) live.state = 'permission';
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'instances', payload: { canRestart: mockCanRestart,
              viewingInstanceId,
              viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd),
              dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
              instances: mockInstances, service: mockServicePayload(),
            },
          });
        }, 1500);
      },
    },
    {
      command: 'test:terminal-waiting',
      run: async () => {
        console.log('[mock] test:terminal-waiting — archived=waiting / gap=alive，验证第三态与 busy/alive 不同形');
        terminalWaitingArmed = true;
      },
    },
    {
      command: 'test:terminal-refresh',
      run: async () => {
        console.log('[mock] test:terminal-refresh — 第二次 session:list 才给 archived 标 terminal=busy，不发 instances');
        terminalRefreshArmed = true;
        terminalRefreshListCount = 0;
      },
    },
    {
      command: 'test:terminal-summary',
      run: async () => {
        console.log('[mock] test:terminal-summary — 另一工作区仅 terminalBusy 汇总为 true，返回行均无 terminal');
        terminalSummaryOtherArmed = true;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: '/Users/you/code/claude-chat-mobile',
            dirs: ['/Users/you/code/claude-chat-mobile', '/Users/you/code/another-react-project'],
            instances: mockInstances,
            service: mockServicePayload(),
          },
        });
      },
    },
    {
      command: 'test:terminal-summary-waiting',
      run: async () => {
        console.log('[mock] test:terminal-summary-waiting — 另一工作区仅 terminalWaiting 汇总为 true，返回行均无 terminal');
        terminalSummaryOtherWaitingArmed = true;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: '/Users/you/code/claude-chat-mobile',
            dirs: ['/Users/you/code/claude-chat-mobile', '/Users/you/code/another-react-project'],
            instances: mockInstances,
            service: mockServicePayload(),
          },
        });
      },
    },
    {
      command: 'test:terminal-race',
      run: async () => {
        console.log('[mock] test:terminal-race — 第二次 session:list 延迟返回旧 busy，第三次立即返回无 terminal');
        terminalRaceArmed = true;
        terminalRaceListCount = 0;
      },
    },
    {
      command: 'test:terminal-close-race',
      run: async () => {
        console.log('[mock] test:terminal-close-race — 另一工作区 session:list 关闭抽屉后才回 terminalBusy=true');
        terminalCloseRaceOtherArmed = true;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: '/Users/you/code/claude-chat-mobile',
            dirs: ['/Users/you/code/claude-chat-mobile', '/Users/you/code/another-react-project'],
            instances: mockInstances,
            service: mockServicePayload(),
          },
        });
      },
    },
    {
      command: 'test:unread-pill',
      run: async () => {
        console.log('[mock] test:unread-pill — inst_2 有 1 条未读，切 viewing 触发 sync:since 展示胶囊');
        mockUnreadOnEntry = 1;
        mockUnreadOnEntryInstanceId = 'inst_2';
        viewingInstanceId = 'inst_2';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: mockInstances.find(i => i.instanceId === 'inst_2')?.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      // P0-SCROLL-1：验证「切走再切回、离开期间后台产出新内容」时强制落底到真正的底部，而非停在
      // 缓存的旧内容底部。inst_scroll_replay 首次冷切入走 loadHistory（session:history 30 条撑满
      // 一屏，建立 DOM 缓存）；切回主会话后（模拟"离开"）；第二次切回该实例时 sync:since 命中
      // hasCache=true 分支，推送一条新的补发消息（switchBackReplayArmed 门控，只在第二次触发）。
      command: 'test:scroll-replay-setup',
      run: async () => {
        console.log('[mock] test:scroll-replay-setup — 注册 inst_scroll_replay（长历史，供切走再切回验证强制落底）');
        if (!mockInstances.some(i => i.instanceId === 'inst_scroll_replay')) {
          mockInstances.push({
            instanceId: 'inst_scroll_replay',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-scroll-replay',
            title: 'Scroll Replay Session',
            state: 'idle',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-sonnet'
          });
        }
        switchBackReplayArmed = false;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd), dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      // P0-REPLAY-BUFFER（大量积压→reload）：同 test:scroll-replay-setup 两段式门控，但第二次切回时
      // sync:since 推 165 条积压事件（远超阈值）——客户端应判定 reload，清屏改走 session:history。
      command: 'test:replay-buffer-flood-setup',
      run: async () => {
        console.log('[mock] test:replay-buffer-flood-setup — 注册 inst_replay_flood（供验证大量积压走 reload 批量渲染）');
        if (!mockInstances.some(i => i.instanceId === 'inst_replay_flood')) {
          mockInstances.push({
            instanceId: 'inst_replay_flood',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-replay-flood',
            title: 'Replay Flood Session',
            state: 'idle',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-sonnet'
          });
        }
        replayFloodSyncArmed = false;
        replayFloodHistoryArmed = false;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd), dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      // P0-REPLAY-SLOWACK：同 test:replay-buffer-flood-setup，外加武装「切回那次 ack 晚于前端 3s 超时才到」。
      // 合成一条命令：setup 发出后本轮不收尾、发送钮停在停止态，紧接着再发第二条会卡住。
      command: 'test:replay-buffer-flood-slowack-setup',
      run: async ctx => {
        await scenarioRegistry.run('test:replay-buffer-flood-setup', ctx);
        replayFloodSlowAck = true;
      },
    },
    {
      // P0-REPLAY-BUFFER（少量积压→flush）：第二次切回时 sync:since 只推 21 条积压事件（低于阈值）——
      // 客户端应判定 flush，正常增量派发但抑制中间滚动，不清屏、不重拉 session:history。
      command: 'test:replay-buffer-small-setup',
      run: async () => {
        console.log('[mock] test:replay-buffer-small-setup — 注册 inst_replay_small（供验证少量积压走 flush 增量渲染）');
        if (!mockInstances.some(i => i.instanceId === 'inst_replay_small')) {
          mockInstances.push({
            instanceId: 'inst_replay_small',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-replay-small',
            title: 'Replay Small Session',
            state: 'idle',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-sonnet'
          });
        }
        replaySmallSyncArmed = false;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd), dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      // P0-SYNC-EXT：同 test:replay-buffer-small-setup，外加武装「离开期间终端写过这个会话」——在 Replay
      // Small Session 的第二次切入（切回）时生效。合成一条命令：setup 发出后本轮不收尾、发送钮停在停止态，
      // 紧接着再发第二条会卡住。
      command: 'test:replay-buffer-small-external-setup',
      run: async ctx => {
        await scenarioRegistry.run('test:replay-buffer-small-setup', ctx);
        replaySmallExternalArmed = true;
      },
    },
    {
      // P0-REPLAY-UNREAD-DISMISS：同 test:replay-buffer-small-setup 套路（第二次切回走 flush），但那次
      // ack 额外带 unreadOnEntry=3——验证回放缓冲程序性落底与未读胶囊自动确认已读的协同（不应被程序性
      // 落底误清，只应被用户后续真实滚动到底部清除）。
      command: 'test:replay-buffer-unread-setup',
      run: async () => {
        console.log('[mock] test:replay-buffer-unread-setup — 注册 inst_replay_unread（供验证程序性落底不误清未读胶囊）');
        if (!mockInstances.some(i => i.instanceId === 'inst_replay_unread')) {
          mockInstances.push({
            instanceId: 'inst_replay_unread',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-replay-unread',
            title: 'Replay Unread Session',
            state: 'idle',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-sonnet'
          });
        }
        replayUnreadSyncArmed = false;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd), dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      command: 'test:gap-pending-snapshot',
      run: async () => {
        console.log('[mock] test:gap-pending-snapshot — gap ack 后仍带回 pending snapshot');
        let inst = mockInstances.find(i => i.instanceId === 'inst_gap_pending');
        if (!inst) {
          inst = {
            instanceId: 'inst_gap_pending',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-gap-pending',
            title: 'Gap Pending Recovery',
            state: 'permission',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-haiku',
            activeTool: 'Bash'
          };
          mockInstances.push(inst);
        } else {
          inst.state = 'permission';
          inst.activeTool = 'Bash';
        }
        pendingPermission = {
          instanceId: 'inst_gap_pending',
          requestId: 'req_gap_pending_snapshot',
          toolUseId: 't_gap_pending_snapshot',
          messageId: 'msg_gap_pending_snapshot_1',
          name: 'run_command',
          input: 'rm -rf /tmp/gap-stale',
          cwd: inst.cwd
        };
        syncPendingSnapshot = {
          permissions: [{
            requestId: pendingPermission.requestId,
            name: pendingPermission.name,
            input: pendingPermission.input,
            cwd: pendingPermission.cwd,
            ...mockPermFields(pendingPermission.name, pendingPermission.input, pendingPermission.cwd)
          }],
          questions: []
        };
        syncPendingSnapshotInstanceId = 'inst_gap_pending';
        viewingInstanceId = 'inst_gap_pending';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: inst.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
      },
    },
    {
      command: 'test:questionsnapshot',
      run: async () => {
        console.log('[mock] test:questionsnapshot — 设 question 快照但不发原始 question 事件，切 viewing 到 inst_2 触发 sync:since');
        pendingQuestion = {
          requestId: 'req_question_snapshot#0',
          toolUseId: 't_question_snapshot',
          messageId: 'msg_question_snapshot_1',
          options: ['main', 'dev', 'release-v1.0']
        };
        syncPendingSnapshot = {
          permissions: [],
          questions: [{
            requestId: pendingQuestion.requestId,
            text: 'Which release branch should receive the restored pending answer?',
            options: pendingQuestion.options
          }]
        };
        syncPendingSnapshotInstanceId = 'inst_2';
        viewingInstanceId = 'inst_2';
        const inst = mockInstances.find(i => i.instanceId === 'inst_2');
        if (inst) inst.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: inst?.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      command: 'test:gap-question-snapshot',
      run: async () => {
        console.log('[mock] test:gap-question-snapshot — gap ack 后仍带回 AskUserQuestion pending snapshot');
        let inst = mockInstances.find(i => i.instanceId === 'inst_gap_question');
        if (!inst) {
          inst = {
            instanceId: 'inst_gap_question',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-gap-question',
            title: 'Gap Question Recovery',
            state: 'permission',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-haiku',
            activeTool: 'AskUserQuestion'
          };
          mockInstances.push(inst);
        } else {
          inst.state = 'permission';
          inst.activeTool = 'AskUserQuestion';
        }
        pendingQuestion = {
          instanceId: 'inst_gap_question',
          requestId: 'req_gap_question_snapshot#0',
          toolUseId: 't_gap_question_snapshot',
          messageId: 'msg_gap_question_snapshot_1',
          options: ['main', 'dev', 'release-v1.0']
        };
        syncPendingSnapshot = {
          permissions: [],
          questions: [{
            requestId: pendingQuestion.requestId,
            text: 'Which release branch should receive the gap-restored pending answer?',
            options: pendingQuestion.options
          }]
        };
        syncPendingSnapshotInstanceId = 'inst_gap_question';
        viewingInstanceId = 'inst_gap_question';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: inst.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
      },
    },
    {
      commands: ['test:mirror-observed-settings', 'ultracode test:mirror-observed-settings'],
      run: async ({ activeInst }) => {
        const mirrorInstanceId = viewingInstanceId;
        const mirrorSessionId = activeInst.sessionId || 'mock-session-visual-test';
        console.log('[mock] test:mirror-observed-settings — 模拟 CLI 设置观察态');
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: mirrorSessionId, instanceId: mirrorInstanceId, cwd: activeInst.cwd, ts: Date.now(),
          type: 'mirror_state',
          payload: {
            readonly: true,
            stale: true,
            observedCli: { model: 'claude-opus-4-8[1m]', permissionMode: 'auto', effort: 'max' },
          }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: null, instanceId: mirrorInstanceId, ts: Date.now(),
          type: 'models', payload: { models: [
            { value: 'default', displayName: 'Default (recommended)' },
            { value: 'claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] },
            { value: 'claude-3-opus[1m]', displayName: 'Claude 3 Opus (1m Context)', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] },
          ] }
        });
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: mirrorSessionId, instanceId: mirrorInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_mirror_observed_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:diag-sample',
      run: async ({ cmd, activeInst }) => {
        // 注入覆盖 mirror/queue/interrupt 三个子系统的合成诊断事件，供 P0-16h 断言 console modal
        // 三态过滤 + formatDiagLogEntry 渲染出人话而非裸 JSON。末尾照常 emit 一条 result 结束本轮，
        // 否则前端一直停在 busy（#streamLiveStatus 常驻），waitForIdle 永久超时。
        console.log(`[mock] ${cmd} — 注入诊断时间线合成事件`);
        addMockDiagLog(activeInst.instanceId, 'mirror', 'state_change', { reason: 'entry_lock', readonly: true, prevReadonly: false, stale: false });
        addMockDiagLog(activeInst.instanceId, 'interrupt', 'settled', { outcome: 'success', ms: 12, droppedCount: 0, timedOut: false });
        addMockDiagLog(activeInst.instanceId, 'queue', 'turn_settled', { wasInterrupted: true, durationMs: 340, isError: false });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: activeInst.sessionId, instanceId: activeInst.instanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_diag_sample_1', durationMs: 340, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      commands: ['test:mirror-readonly', 'test:mirror-readonly-delayed'],
      run: async ({ cmd, activeInst }) => {
        const delayedMirror = cmd === 'test:mirror-readonly-delayed';
        const mirrorInstanceId = viewingInstanceId;
        const mirrorSessionId = activeInst.sessionId || 'mock-session-visual-test';
        const mirrorCwd = activeInst.cwd;
        console.log(`[mock] ${cmd} — 模拟终端会话正在运行，只读追平锁`);
        if (delayedMirror) await delay(650);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: mirrorSessionId, instanceId: mirrorInstanceId, cwd: mirrorCwd, ts: Date.now(),
          type: 'mirror_state', payload: { readonly: true }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: mirrorSessionId, instanceId: mirrorInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_mirror_readonly_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
        // TC-003 附带修复：2026-07-13「排队接管」上线后，非 stale 会话点「接管 CLI 会话」只 armed（见 app.js
        // armedTakeoverStep），不再像旧的两态模型那样立即解锁——需要终端本轮完结（readonly:false 到达）才自动
        // 放行。此前本场景从不发这个后续事件，P0-17c/17f 的「点接管 → 断言解锁」断言因此永久等不到，被
        // task-progress.spec.ts:55/100 的旧横幅文案断言抢先失败掩盖，两个问题叠在一起。同 test:mirror-armed
        // 场景的手法，补一次延迟后的 readonly:false，模拟终端本轮完结——不管此刻是否已点接管，效果都正确
        // （armed 则 unlock-focus 自动放行；未 armed 则直接照常解锁），零改动测试断言本身。
        await delay(1200);
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: mirrorSessionId, instanceId: mirrorInstanceId, ts: Date.now(),
          type: 'mirror_state', payload: { readonly: false }
        });
      },
    },
    {
      commands: ['test:taskprogress', 'test:taskprogress-failed', 'test:taskprogress-hold'],
      run: async ({ cmd, activeInst }) => {
        // Mirrors transient SDK background task heartbeats without adding buffered events.
        console.log(`[mock] ${cmd} — 推送后台任务进度心跳序列 + 完成/失败通知`);
        // WS-009：本场景每步都 await delay 后再 emit——期间用户可能切 tab 令全局 viewingInstanceId 变。冻结 dispatch
        // 时的目标实例 id，全场景事件都用它（对齐相邻 mirror handler 用 mirrorInstanceId 的正确写法），否则切走后
        // 这些 task_progress/notification/result 会被标成【当前查看的另一实例】。
        const targetInstanceId = activeInst.instanceId;
        activeInst.state = 'busy';
        const failedTask = cmd === 'test:taskprogress-failed';
        const progressSteps = failedTask
          ? ['步骤 1/3：读取源文件…', '步骤 2/3：运行测试失败…']
          : ['步骤 1/3：读取源文件…', '步骤 2/3：合并重复逻辑…', '步骤 3/3：运行测试验证…'];
        for (const message of progressSteps) {
          await delay(600);
          io.emit('agent:event', {
            seq: 50, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetInstanceId, ts: Date.now(),
            type: 'task_progress', transient: true, payload: { taskId: 'bg_task_1', taskType: 'local_agent', message, description: message, lastToolName: 'Bash' }
          });
        }
        // -hold 变体：三拍心跳后长驻 8s 再收尾。默认变体从「步骤 3/3」到撤横幅只有 600ms 窗口，
        // 装不下折叠/详情联动这类多步断言（会随机在断言中途被 task_notification 撤掉横幅）。
        await delay(cmd === 'test:taskprogress-hold' ? 8000 : 600);
        io.emit('agent:event', {
          seq: 51, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetInstanceId, ts: Date.now(),
          type: 'task_notification', payload: {
            source: 'system',
            taskId: 'bg_task_1',
            status: failedTask ? 'failed' : 'completed',
            summary: failedTask ? 'mock background task failed' : '后台任务已完成',
            // B2：真服务端从 CLI 的 task_notification.output_file 透传此字段；前端据它挂「查看输出」。
            // mock 只需给一个非空值——路径本身不被前端使用（前端只发 taskId，路径在服务端侧解析）。
            outputFile: '/tmp/mock-task-output.log',
            // 与真 server 逐字段对齐（agent.js:2448-2459）。skipTranscript 是 housekeeping 任务的静音开关，
            // 漏发会让 CLI 的常驻/清理任务每完成一次就往聊天流打一条完成条并弹通知——正是 dd82cd9 修掉的现象。
            // 前端只认 === true（task-status.js:405），所以这里发 false 与真 server 的常规任务同形。
            toolUseId: 'toolu_mock_bgtask_1',
            skipTranscript: false
          }
        });
        await delay(150);
        activeInst.state = 'idle';
        socket.emit('agent:event', {
          seq: 100, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_bgtask', durationMs: 2000, costUsd: 0.001, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:taskprogress-multi',
      run: async ({ activeInst }) => {
        // 多任务全量快照（emitBgTasksSnapshot 形态）：验证横幅默认折叠 + 混合分组行归属/详情/停止。
        // 窗口 8s：展开后还要点组头、第一行详情、行内「停」（ack 兜底 1.5s），2s 会在中途被 notification 撤横幅。
        console.log('[mock] test:taskprogress-multi — 推送多任务全量快照');
        const targetInstanceId = activeInst.instanceId;
        activeInst.state = 'busy';
        const tasks = [
          { taskId: 'bg_task_a', taskType: 'local_agent', message: 'Explore：搜索用例' },
          { taskId: 'bg_task_b', taskType: 'local_bash', message: 'npm test' },
          { taskId: 'bg_task_c', taskType: 'local_agent', message: 'Synthesize：汇总结果' },
        ];
        io.emit('agent:event', {
          seq: 50, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetInstanceId, ts: Date.now(),
          type: 'task_progress', transient: true,
          payload: { taskId: tasks[0].taskId, taskType: tasks[0].taskType, message: tasks[0].message, tasks }
        });
        await delay(8000);
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 51, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetInstanceId, ts: Date.now(),
          type: 'task_notification', payload: { source: 'system', status: 'completed', summary: '全部后台任务完成', tasks: [] }
        });
        socket.emit('agent:event', {
          seq: 100, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_bgtask_multi', durationMs: 2000, costUsd: 0.001, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:exitplan',
      run: async ({ activeInst }) => {
        // Regression TC-15: approving ExitPlanMode should fall permission mode back to default.
        console.log('[mock] test:exitplan — plan 模式 + ExitPlanMode 审批');
        activeInst.permissionMode = 'plan';
        activeInst.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, ts: Date.now(),
          type: 'permission_mode', payload: { mode: 'plan' }
        });
        pendingPermission = {
          requestId: 'req_exit_plan', toolUseId: 't_exit_plan', messageId: 'msg_exitplan_1',
          name: 'ExitPlanMode', input: '## 计划\n1. 实现 X\n2. 测试 Y', cwd: activeInst.cwd,
          setMode: 'default'
        };
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: pendingPermission.toolUseId, name: pendingPermission.name, inputSummary: pendingPermission.input }
        });
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'permission_request', payload: { requestId: pendingPermission.requestId, name: pendingPermission.name, input: pendingPermission.input, cwd: pendingPermission.cwd, ...mockPermFields(pendingPermission.name, pendingPermission.input, pendingPermission.cwd) }
        });
      },
    },
    {
      command: 'test:freshbusy',
      run: async ({ requestedModel }) => {
        // 回归（shouldRestoreOptimisticBusy）：新会话首发的乐观 busy 不应被「懒开 → 广播 instances →
        // 前端 bindView→clearView(setBusy(false))」冲掉。前置 session:new 已使前端 viewingInstanceId=null
        // （空首页），故 send() 这条消息时置了 _pendingFirstSend。
        console.log('[mock] test:freshbusy — 模拟新会话首发懒开');
        await delay(150);
        // 懒开：新建 FRESH 实例（sessionId=null，区别于 resume），切 viewing 并广播 instances
        // —— 这一步触发前端 bindView→clearView 的 setBusy(false)，是 bug 现场。
        const freshInst = openFreshMockInstance(requestedModel);
        const freshId = freshInst.instanceId;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: mockInstances[0].cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        // 关键窗口：模拟 SDK 启动慢，此后约 1.1s 不发任何 delta。E2E 在此窗口断言 pill 仍可见
        // （修复前已被 clearView 冲掉 → fail；修复后由 setInstances 补回 → pass）。
        await delay(1100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: null, instanceId: freshId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_fresh_1', text: '新会话首发回复。' }
        });
        await delay(100);
        const fInst = mockInstances.find(i => i.instanceId === freshId);
        if (fInst) fInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: mockInstances[0].cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 100, epoch: activeEpoch, sessionId: null, instanceId: freshId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_fresh_1', durationMs: 1300, costUsd: 0.001, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // 排队已移除：模拟「一轮在跑」——发送闸关上（turnRunning）、主按钮变停止钮、常驻提示行出现。
      // 1.2s 后轮次结束自动解锁，供 spec 断言恢复可发送。
      command: 'test:turn-running',
      run: async ({ activeInst }) => {
        console.log('[mock] Simulating an in-flight turn (send gate closed)');
        activeInst.state = 'busy';
        activeInst.turnRunning = true;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] A turn is running; new messages are refused until it finishes.' }
        });

        await delay(1200);
        activeInst.turnRunning = false;
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_turn_running_1', durationMs: 1200, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:foreground-sync-replay',
      run: async ({ activeInst }) => {
        console.log('[mock] Completing current turn, then arming duplicate foreground sync replay');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        await delay(100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_foreground_sync_1', text: 'Foreground sync baseline response.' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_foreground_sync_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
        foregroundSyncReplayMode = true;
      },
    },
    {
      command: 'test:foreground-found-missing',
      run: async ({ activeInst }) => {
        console.log('[mock] Completing current turn, then arming foreground sync found=false history reload');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });

        await delay(100);
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: 'msg_foreground_found_missing_1', text: 'Stale foreground instance response.' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_foreground_found_missing_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
        await delay(350);
        foregroundFoundMissingMode = true;
        foregroundFoundMissingHistoryMode = true;
        socket.emit('agent:event', {
          seq: 3, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Foreground found=false fixture armed.' }
        });
      },
    },
    {
      command: 'test:background-done',
      run: async ({ activeInst }) => {
        console.log('[mock] Marking background workspace as done');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'done',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        const bgInst = mockInstances.find(i => i.instanceId === 'inst_2');
        if (bgInst) bgInst.state = 'done';
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: activeInst.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Background workspace finished and is ready to review.' }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_background_done_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:background-error',
      run: async ({ activeInst }) => {
        console.log('[mock] Marking background workspace as error');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'error',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        const bgInst = mockInstances.find(i => i.instanceId === 'inst_2');
        if (bgInst) bgInst.state = 'error';
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: activeInst.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_background_error_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:background-priority',
      run: async ({ activeInst }) => {
        console.log('[mock] Marking one background workspace with mixed states');
        const backgroundCwd = '/Users/you/code/another-react-project';
        const ensureInstance = ({ instanceId, sessionId, title, state, activeTool }) => {
          let inst = mockInstances.find(i => i.instanceId === instanceId);
          if (!inst) {
            inst = {
              instanceId,
              cwd: backgroundCwd,
              sessionId,
              title,
              state,
              activeTool,
              permissionMode: 'plan',
              effort: 'medium',
              model: 'claude-3-5-haiku'
            };
            mockInstances.push(inst);
          }
          Object.assign(inst, { cwd: backgroundCwd, sessionId, title, state, activeTool });
        };
        ensureInstance({
          instanceId: 'inst_2',
          sessionId: 'mock-session-another-done',
          title: 'Background Done Result',
          state: 'done',
          activeTool: null
        });
        ensureInstance({
          instanceId: 'inst_3',
          sessionId: 'mock-session-another-running',
          title: 'Background Task Running',
          state: 'busy',
          activeTool: 'Task'
        });
        ensureInstance({
          instanceId: 'inst_4',
          sessionId: 'mock-session-another-permission',
          title: 'Background Needs Approval',
          state: 'permission',
          activeTool: 'Bash'
        });
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: activeInst.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_background_priority_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:background-taskprogress',
      run: async ({ activeInst }) => {
        console.log('[mock] Emitting background task_progress without changing current view');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'busy',
            activeTool: 'Task',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        const bgInst = mockInstances.find(i => i.instanceId === 'inst_2');
        if (bgInst) {
          bgInst.state = 'busy';
          bgInst.activeTool = 'Task';
        }
        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: activeInst.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        await delay(200);
        io.emit('agent:event', {
          seq: 50, epoch: activeEpoch, sessionId: 'mock-session-another', instanceId: 'inst_2', ts: Date.now(),
          type: 'task_progress',
          transient: true,
          payload: {
            taskId: 'bg_foreign_task_1',
            taskType: 'local_agent',
            message: '另一个工作区正在运行后台任务：步骤 1/2'
          }
        });
        await delay(150);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_background_taskprogress_1', durationMs: 350, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:history-overflow',
      run: async () => {
        console.log('[mock] test:history-overflow — session:list 默认截断，显示全部后返回较早历史');
        historyOverflowMode = true;
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Session history overflow fixture enabled.' }
        });
        await delay(100);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_history_overflow_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // P3 抽屉局部重建 + SWR 保鲜回归夹具①：断线重连但数据"零变化"——验证 sessionsCache 不被清空、
      // openSessionPanel/rebuildDirSections 不做无意义的整段重建：抽屉已展开的目录 DOM 节点应原样
      // 保留（不出现骨架屏闪现）。先同 test:tab 补一个第二工作区，覆盖"多目录场景下都不受扰动"。
      command: 'test:reconnect-drawer-quiet',
      run: async () => {
        console.log('[mock] test:reconnect-drawer-quiet — 断线重连但数据零变化，验证抽屉 DOM 不被无谓重建');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd),
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        // 尽快结束这一轮（result），不留悬空 busy 态干扰后续断线重连观测。
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_reconnect_quiet_1', durationMs: 50, costUsd: 0, isError: false, models: [activeModel] }
        });
        // 给 E2E 测试留足时间在断线前展开两个目录、等 session:list 落地、给行元素打标记——这个窗口
        // 必须显著大于"展开目录→发 session:list→收到 ack"这段路径可能耗费的真实时间，否则断线可能
        // 卡在某个目录的 session:list 请求已发出但 ack 还没收到的节点上：那次 ack 永远丢失（socket.io
        // 断线中的 ack 不会重投），该目录就会一直卡在骨架屏，直到用户手动折叠再展开——2.5s 留足冗余。
        await delay(2500);
        reconnectSettleMarkerArmed = true;
        setTimeout(() => socket.disconnect(true), 50);
      },
    },
    {
      // P3 抽屉局部重建 + SWR 保鲜回归夹具②：断线期间主工作区会话"真的"被改名（模拟自主续跑产出新
      // 标题），reconnect 后验证：① 抽屉确实显示新标题（不是缓存钝化的旧内容）；② 未涉及的其它工作区
      // 目录 DOM 不被连坐重建（按目录分键 diff 只重建真正变化的那一个目录）。
      command: 'test:reconnect-drawer-refresh',
      run: async () => {
        console.log('[mock] test:reconnect-drawer-refresh — 断线期间改主工作区标题，reconnect 后核对局部刷新');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd),
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        // 尽快结束这一轮（result），不留悬空 busy 态干扰后续断线重连观测。
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_reconnect_refresh_1', durationMs: 50, costUsd: 0, isError: false, models: [activeModel] }
        });
        // 同 test:reconnect-drawer-quiet：2.5s 冗余窗口，避免断线卡在某个目录的 session:list 请求
        // 已发出但 ack 还没收到的节点上。
        await delay(2500);
        reconnectDrawerTitleChanged = true;
        const mainInst = mockInstances.find(i => i.instanceId === 'inst_1');
        if (mainInst) mainInst.title = 'Renamed After Reconnect';
        reconnectSettleMarkerArmed = true;
        setTimeout(() => socket.disconnect(true), 50);
      },
    },
    {
      command: 'test:tab',
      run: async () => {
        console.log('[mock] Simulating multiple tab concurrency');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }

        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd),
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Concurrency Mode Triggered! A second workspace tab "Another App Concurrency" is now live. Try clicking the tabs at the top!' }
        });

        await delay(500);

        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'Concurrency Mode Triggered! A second workspace tab is now live.' }
        });
      },
    },
    {
      command: 'test:tab-model-effort',
      run: async () => {
        console.log('[mock] Simulating tab switch with model and effort state');
        const existingInst2 = mockInstances.find(i => i.instanceId === 'inst_2');
        const modelEffortInst = {
          instanceId: 'inst_2',
          cwd: '/Users/you/code/another-react-project',
          sessionId: 'mock-session-another',
          title: 'Another App Concurrency',
          state: 'idle',
          permissionMode: 'plan',
          effort: 'high',
          model: 'claude-3-opus[1m]'
        };
        if (existingInst2) Object.assign(existingInst2, modelEffortInst);
        else mockInstances.push(modelEffortInst);

        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd),
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });

        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Model and effort switch fixture ready.' }
        });
        await delay(100);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_tab_model_effort_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // P1 回归（2026-09-12 PR #38 review）：注册 inst_orphan_mixed，state='busy' 且 turnRunning=true
      // ——轮次【确实还在跑】。它的回放含旧轮完整 FIFO + 新轮 delta，见 sync:since 分支。
      command: 'test:busy-orphan-mixed',
      run: async () => {
        console.log('[mock] test:busy-orphan-mixed — 回放含旧轮 result + 新轮 delta，验证运行条不被旧 result 清掉');
        orphanMixedArmed = false;
        if (!mockInstances.some(i => i.instanceId === 'inst_orphan_mixed')) {
          mockInstances.push({
            instanceId: 'inst_orphan_mixed',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-orphan-mixed',
            title: 'Orphan Mixed Session',
            // 前台轮与真后台任务【并存】：bgActive 与 turnRunning 同时为真。这个组合是刻意选的——
            // 只有「turnRunning===true 一定保住」那段判据能救它，退回 shouldBindBusyFromBroadcast
            // 会因 bgActive===true 恒返回 false 而把前台轮误判成不存在（第四轮 P2）。
            state: 'busy',
            bgActive: true,
            turnRunning: true,
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-sonnet'
          });
        }
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd),
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        await delay(100);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_mixed_setup', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // 现场复现（2026-09-12）：注册 inst_orphan，state='idle'（轮次早已结束）。
      // 它的 sync:since 回放 user_message + 3 条 text_delta 但【不发 result】——模拟轮次终止事件遗失。
      command: 'test:busy-orphan-replay',
      run: async () => {
        console.log('[mock] test:busy-orphan-replay — inst_orphan 回放缺 result，验证运行条会不会永久卡住');
        orphanReplayArmed = false;
        if (!mockInstances.some(i => i.instanceId === 'inst_orphan')) {
          mockInstances.push({
            instanceId: 'inst_orphan',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-orphan',
            title: 'Orphan Replay Session',
            state: 'idle',
            bgActive: false,
            turnRunning: false,
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-sonnet'
          });
        }
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd),
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        await delay(100);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_orphan_setup', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      // 回归：切走再切回一个「后端在跑但正处静默窗口（无 delta/result）」的会话，运行条应重新出现。
      // inst_2 置 state='busy'，其 sync:since 走 busySilentSwitchMode 只回放 user_message（触发 reload、不发 result）。
      command: 'test:busy-silent-switch',
      run: async () => {
        console.log('[mock] test:busy-silent-switch — inst_2 busy 静默窗口，验证切回后运行条重种');
        busySilentSwitchMode = true;
        const busyInst = {
          instanceId: 'inst_2',
          cwd: '/Users/you/code/another-react-project',
          sessionId: 'mock-session-another',
          title: 'Another App Concurrency',
          state: 'busy',
          bgActive: false,
          permissionMode: 'default',
          effort: null,
          model: 'claude-3-5-haiku'
        };
        const existing = mockInstances.find(i => i.instanceId === 'inst_2');
        if (existing) Object.assign(existing, busyInst); else mockInstances.push(busyInst);

        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd),
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        // 当前视图（inst_1）收尾 → waitForIdle 可用；inst_2 的 busy 只体现在 instances.state。
        await delay(100);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { messageId: 'msg_busy_silent_1', durationMs: 100, costUsd: 0, isError: false, models: [activeModel] }
        });
      },
    },
    {
      command: 'test:close-current-pending',
      run: async () => {
        console.log('[mock] test:close-current-pending — 当前 inst_1 待审批，同时保留 inst_2 作为关闭后的回退会话');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        viewingInstanceId = 'inst_1';
        const inst1 = mockInstances.find(i => i.instanceId === 'inst_1');
        inst1.state = 'permission';
        inst1.activeTool = 'Bash';
        pendingPermission = {
          instanceId: 'inst_1',
          requestId: 'req_close_current_pending',
          toolUseId: 't_close_current_pending',
          messageId: 'msg_close_current_pending_1',
          name: 'run_command',
          input: 'git push origin main',
          cwd: inst1.cwd
        };
        syncPendingSnapshot = {
          permissions: [{
            requestId: pendingPermission.requestId,
            name: pendingPermission.name,
            input: pendingPermission.input,
            cwd: pendingPermission.cwd,
            ...mockPermFields(pendingPermission.name, pendingPermission.input, pendingPermission.cwd)
          }],
          questions: []
        };
        syncPendingSnapshotInstanceId = 'inst_1';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: inst1.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Close current pending source session before approving anything.' }
        });
      },
    },
    {
      command: 'test:late-closed-current-events',
      run: async () => {
        console.log('[mock] test:late-closed-current-events — 关闭当前 inst_1 后继续发旧实例迟到事件');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        viewingInstanceId = 'inst_1';
        const inst1 = mockInstances.find(i => i.instanceId === 'inst_1');
        inst1.state = 'permission';
        inst1.activeTool = 'Bash';
        pendingPermission = {
          instanceId: 'inst_1',
          requestId: 'req_close_current_late',
          toolUseId: 't_close_current_late',
          messageId: 'msg_close_current_late_1',
          name: 'run_command',
          input: 'git push origin main',
          cwd: inst1.cwd
        };
        syncPendingSnapshot = {
          permissions: [{
            requestId: pendingPermission.requestId,
            name: pendingPermission.name,
            input: pendingPermission.input,
            cwd: pendingPermission.cwd,
            ...mockPermFields(pendingPermission.name, pendingPermission.input, pendingPermission.cwd)
          }],
          questions: []
        };
        syncPendingSnapshotInstanceId = 'inst_1';
        lateClosedSessionEventsInstanceId = 'inst_1';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: inst1.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Close current stale source session before late events arrive.' }
        });
      },
    },
    {
      command: 'test:permCrossTab',
      run: async () => {
        // 跨 tab 审批清弹窗回归（坐实诊断「安全」结论的前端支柱）：viewing=inst_1 弹审批，
        // 同时备好后台 inst_2（不切）。配 test:switchAway 切走 → 前端 bindView→clearView 应清弹窗。
        console.log('[mock] test:permCrossTab — inst_1 弹审批 + 备好后台 inst_2');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2', cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another', title: 'Another App Concurrency',
            state: 'busy', permissionMode: 'plan', effort: 'medium', model: 'claude-3-5-haiku'
          });
        }
        viewingInstanceId = 'inst_1';
        const inst1ct = mockInstances.find(i => i.instanceId === 'inst_1');
        inst1ct.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: inst1ct.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        pendingPermission = { requestId: 'req_perm_cross_tab', toolUseId: 't_cross', messageId: 'msg_cross_1', name: 'run_command', input: 'git push origin main', cwd: inst1ct.cwd };
        syncPendingSnapshot = {
          permissions: [{ requestId: pendingPermission.requestId, name: pendingPermission.name, input: pendingPermission.input, cwd: pendingPermission.cwd, ...mockPermFields(pendingPermission.name, pendingPermission.input, pendingPermission.cwd) }],
          questions: []
        };
        syncPendingSnapshotInstanceId = 'inst_1';
        // 独立 epoch：前端见新 epoch 即重置 seq 去重基线，避免被前序 TC 累积的 lastSeq 误吞
        socket.emit('agent:event', {
          seq: 1, epoch: 'mock-epoch-crosstab', sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'permission_request', payload: { requestId: pendingPermission.requestId, name: pendingPermission.name, input: pendingPermission.input, cwd: pendingPermission.cwd, ...mockPermFields(pendingPermission.name, pendingPermission.input, pendingPermission.cwd) }
        });

        // 弹窗渲染后自动「切到 inst_2」（viewing 变化）→ 前端 bindView → clearView 应清掉 inst_1 的审批弹窗。
        // 内部自动切，避免 runner 在弹窗打开时再走 input+btnSend——那样点击坐标会穿透到 sheet 上的审批按钮、误发回答。
        await delay(1500);
        viewingInstanceId = 'inst_2';
        const inst2ct = mockInstances.find(i => i.instanceId === 'inst_2');
        console.log('[mock] test:permCrossTab — 自动切 viewing → inst_2（应触发前端 clearView 清弹窗）');
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: inst2ct.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      command: 'test:questionCrossTab',
      run: async () => {
        console.log('[mock] test:questionCrossTab — inst_1 弹 AskUserQuestion + 自动切 viewing → inst_2');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2', cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another', title: 'Another App Concurrency',
            state: 'busy', permissionMode: 'plan', effort: 'medium', model: 'claude-3-5-haiku'
          });
        }
        viewingInstanceId = 'inst_1';
        const inst1ct = mockInstances.find(i => i.instanceId === 'inst_1');
        inst1ct.state = 'permission';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: inst1ct.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        pendingQuestion = {
          requestId: 'req_question_cross_tab#0',
          toolUseId: 't_question_cross_tab',
          messageId: 'msg_question_cross_tab_1',
          options: ['main (Stable Production)', 'dev (Bleeding-Edge Integration)', 'release-v1.0 (LTS)']
        };
        const questionText = 'We are ready to tag and deploy this mobile dashboard app. Which branch should be our target publish destination?';
        syncPendingSnapshot = {
          permissions: [],
          questions: [{
            requestId: pendingQuestion.requestId,
            text: questionText,
            options: pendingQuestion.options
          }]
        };
        syncPendingSnapshotInstanceId = 'inst_1';
        socket.emit('agent:event', {
          seq: 1, epoch: 'mock-epoch-question-crosstab', sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'tool_use', payload: { toolUseId: pendingQuestion.toolUseId, name: 'AskUserQuestion', inputSummary: 'Choose a publish channel' }
        });
        socket.emit('agent:event', {
          seq: 2, epoch: 'mock-epoch-question-crosstab', sessionId: 'mock-session-visual-test', instanceId: 'inst_1', ts: Date.now(),
          type: 'question', payload: {
            requestId: pendingQuestion.requestId,
            text: questionText,
            options: pendingQuestion.options
          }
        });
        await delay(1500);
        viewingInstanceId = 'inst_2';
        const inst2ct = mockInstances.find(i => i.instanceId === 'inst_2');
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: inst2ct.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
      },
    },
    {
      command: 'test:close-background-question-pending',
      run: async () => {
        console.log('[mock] test:close-background-question-pending — 后台 inst_1 保留待答问题，当前查看 inst_2');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        const inst1 = mockInstances.find(i => i.instanceId === 'inst_1');
        inst1.state = 'permission';
        inst1.activeTool = 'AskUserQuestion';
        pendingQuestion = {
          instanceId: 'inst_1',
          requestId: 'req_close_background_question#0',
          toolUseId: 't_close_background_question',
          messageId: 'msg_close_background_question_1',
          options: ['main (Stable Production)', 'dev (Bleeding-Edge Integration)', 'release-v1.0 (LTS)']
        };
        const backgroundQuestionText = 'Which branch should be our target publish destination?';
        syncPendingSnapshot = {
          permissions: [],
          questions: [{
            requestId: pendingQuestion.requestId,
            text: backgroundQuestionText,
            options: pendingQuestion.options
          }]
        };
        syncPendingSnapshotInstanceId = 'inst_1';
        viewingInstanceId = 'inst_2';
        const inst2 = mockInstances.find(i => i.instanceId === 'inst_2');
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: inst2.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
      },
    },
    {
      command: 'test:late-closed-session-events',
      run: async () => {
        console.log('[mock] test:late-closed-session-events — 关闭后台 inst_1 后继续发旧实例迟到事件');
        if (!mockInstances.some(i => i.instanceId === 'inst_2')) {
          mockInstances.push({
            instanceId: 'inst_2',
            cwd: '/Users/you/code/another-react-project',
            sessionId: 'mock-session-another',
            title: 'Another App Concurrency',
            state: 'idle',
            permissionMode: 'plan',
            effort: 'medium',
            model: 'claude-3-5-haiku'
          });
        }
        const inst1 = mockInstances.find(i => i.instanceId === 'inst_1');
        inst1.state = 'permission';
        inst1.activeTool = 'Bash';
        pendingPermission = {
          instanceId: 'inst_1',
          requestId: 'req_close_background_late',
          toolUseId: 't_close_background_late',
          messageId: 'msg_close_background_late_1',
          name: 'run_command',
          input: 'git push origin main',
          cwd: inst1.cwd
        };
        syncPendingSnapshot = {
          permissions: [{
            requestId: pendingPermission.requestId,
            name: pendingPermission.name,
            input: pendingPermission.input,
            cwd: pendingPermission.cwd,
            ...mockPermFields(pendingPermission.name, pendingPermission.input, pendingPermission.cwd)
          }],
          questions: []
        };
        syncPendingSnapshotInstanceId = 'inst_1';
        lateClosedSessionEventsInstanceId = 'inst_1';
        viewingInstanceId = 'inst_2';
        const inst2 = mockInstances.find(i => i.instanceId === 'inst_2');
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId,
            viewingCwd: inst2.cwd,
            dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            instances: mockInstances, service: mockServicePayload()
          }
        });
      },
    },
    {
      command: 'test:empty',
      run: async () => {
        console.log('[mock] Reset to empty start screen state');
        // Clear instances and set viewingInstanceId to null
        mockInstances.length = 0;
        viewingInstanceId = null;
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart,
            viewingInstanceId: null,
            viewingCwd: '/Users/you/code/claude-chat-mobile',
            dirs: ['/Users/you/code/claude-chat-mobile'],
            instances: [],
            defaultPermissionMode: 'default',
            defaultEffort: null,
            // ★ service 不可省：真 server 的 instances 广播**恒带**这个字段
            // （computeServiceHealth 无条件返回），而 mock server 是所有并行 spec 共用的一个进程——
            // 这里 io.emit 会广播到**其它测试正在用的页面**上，把它们的 latestServiceHealth
            // 冲成 undefined，于是依赖它的段落（两个桥）整段消失。
            // 2026-09-10：P0-25c 在四分片并行下间歇 8s 超时，根因就是这一处漏网。
            service: mockServicePayload()
          }
        });
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: null, instanceId: null, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Empty start screen activated' }
        });
        await delay(300);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: null, ts: Date.now(),
          type: 'result', payload: { text: 'Empty start screen activated' }
        });
      },
    },
    {
      command: 'test:restore',
      run: async () => {
        console.log('[mock] Restoring normal chat state from empty');
        if (mockInstances.length === 0) {
          mockInstances.push({
            instanceId: 'inst_1',
            cwd: '/Users/you/code/claude-chat-mobile',
            sessionId: 'mock-session-visual-test',
            title: 'Visual Sandbox (Main)',
            state: 'idle',
            permissionMode: 'default',
            effort: null,
            model: 'claude-3-5-sonnet'
          });
          viewingInstanceId = 'inst_1';
        }
        emitHydration();
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] Chat state restored' }
        });
        await delay(300);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'Chat state restored' }
        });
      },
    },
    {
      command: 'test:devicerequests',
      run: async ({ activeInst }) => {
        console.log('[mock] Emitting pending device requests with busy cycle');
        activeInst.state = 'busy';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        await delay(200);

        pendingDevices = createPendingDeviceRequests();
        emitPendingDevices();
        socket.emit('agent:event', {
          seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'system', payload: { message: '[MOCK_INFO] 2 pending devices emitted for visual testing' }
        });

        activeInst.state = 'idle';
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
        });
        await delay(300);
        socket.emit('agent:event', {
          seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'result', payload: { text: 'Device requests emitted' }
        });
      },
    },
    {
      commands: ['test:tofu', 'test:tofu-denied'],
      run: async ({ cmd }) => {
        console.log('[mock] Forcing unapproved TOFU status');
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'device_status', payload: { status: 'pending', deviceId: 'unauthorized-fingerprint-999' }
        });

        if (cmd === 'test:tofu-denied') {
          await delay(500);
          deniedDeviceRetryPending = true;
          socket.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'device_status', payload: { status: 'denied', deviceId: 'unauthorized-fingerprint-999' }
          });
          setTimeout(() => socket.disconnect(true), 50);
          return;
        }

        // Set timeout to auto-approve and restore state after 8 seconds
        setTimeout(() => {
          console.log('[mock] Auto-approving TOFU screen to return to chat state');
          socket.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'device_status', payload: { status: 'approved', deviceId: 'unauthorized-fingerprint-999' }
          });
          emitHydration();
        }, 8000);
      },
    },
    {
      command: 'test:tofu-delayed',
      run: async () => {
        console.log('[mock] Delaying unapproved TOFU status so the UI can hold a draft');
        await delay(600);
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'device_status', payload: { status: 'pending', deviceId: 'unauthorized-fingerprint-999' }
        });

        setTimeout(() => {
          console.log('[mock] Auto-approving delayed TOFU screen to return to chat state');
          socket.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
            type: 'device_status', payload: { status: 'approved', deviceId: 'unauthorized-fingerprint-999' }
          });
          emitHydration();
          socket.emit('agent:event', {
            seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
            type: 'result', payload: { messageId: 'msg_tofu_delayed_1', durationMs: 1200, costUsd: 0, isError: false, models: [activeModel] }
          });
        }, 1200);
      },
    },
    {
      command: 'test:tofu-denied-delayed',
      run: async () => {
        console.log('[mock] Delaying TOFU denial so the UI can hold a draft through pending and denied states');
        await delay(600);
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'device_status', payload: { status: 'pending', deviceId: 'unauthorized-fingerprint-999' }
        });

        await delay(900);
        deniedDeviceRetryPending = true;
        socket.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'device_status', payload: { status: 'denied', deviceId: 'unauthorized-fingerprint-999' }
        });
        setTimeout(() => socket.disconnect(true), 50);
      },
    },
  ]);

  // Handle custom trigger command inputs
  socket.on('user:message', async (payload, ack) => {
    // 在途轮拒收（排队已移除）：镜像真 server 的 busy 负 ack。判据用 turnRunning 而非 state==='busy'——
    // 只有显式模拟在途轮的场景（test:turn-running）才置它，别的 busy 场景仍走 mock 的"总是成功"语义。
    const gateInst = mockInstances.find(i => i.instanceId === viewingInstanceId);
    if (gateInst?.turnRunning === true) {
      console.log('[mock] user:message refused — turn running');
      if (typeof ack === 'function') {
        ack({ ok: false, error: '当前任务运行中，请等待完成后再发送', busy: true, retryable: false });
      }
      return;
    }
    // REL-01：真实 app/server.js 现支持 ack（离线重发路径用 socket.timeout().emit(...,ack)）；
    // mock 本就是"总是成功"语义，无需等分支处理完才 ack，此处立即回，避免离线重发场景在 mock 下永远超时。
    if (typeof ack === 'function') ack({ ok: true });
    const resetGen = mockResetGeneration; // 见 mockResetGeneration：下面的 await 醒来时用它判断是否已换了用例
    const messagePayload = payload && typeof payload === 'object' ? payload : {};
    const text = typeof payload === 'string' ? payload : messagePayload.text;
    const requestedModel = typeof messagePayload.model === 'string' ? messagePayload.model : '';
    const attachments = Array.isArray(messagePayload.attachments)
      ? messagePayload.attachments.map(a => ({
        name: a?.name,
        mimeType: a?.mimeType,
        size: a?.size,
        thumb: a?.thumb
      }))
      : undefined;
    // 「在新 worktree 里开」：真 server 在懒开实例之前 `git worktree add`，再拿那棵树当 cwd。
    // mock 不碰磁盘，只把收到的意图回显成一条 system——这条 E2E 要验的是**前端把参数发出去了**
    // （勾选框亮着但请求里没这两个字段，在别处全是绿的）。真正"建对没有"由跑真 git 的
    // tests/unit/git-worktree.test.mjs 与集成层守，不在这一层重复。
    //
    // 必须先把实例开出来再发：空首页上 viewingInstanceId 还是 null，而前端对 agent:event 有
    // 实例过滤（logic 的 shouldDropAgentEvent），带 instanceId:null 的事件会被静默丢掉——
    // 第一版就是这么写的，断言红在"文本没出现"，看着像参数没发出去。
    if (messagePayload.useWorktree === true) {
      if (viewingInstanceId === null) {
        const fresh = openFreshMockInstance(requestedModel);
        io.emit('agent:event', {
          seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
          type: 'instances',
          payload: {
            canRestart: mockCanRestart, viewingInstanceId, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))),
            viewingCwd: fresh?.cwd || mockInstances[0].cwd, instances: mockInstances, service: mockServicePayload(),
          },
        });
      }
      const cur = mockInstances.find(i => i.instanceId === viewingInstanceId);
      const src = typeof messagePayload.sourceBranch === 'string' && messagePayload.sourceBranch
        ? messagePayload.sourceBranch : '(current)';
      io.emit('agent:event', {
        seq: 1, epoch: 'mock-epoch-worktree', sessionId: cur?.sessionId ?? null,
        instanceId: viewingInstanceId, ts: Date.now(),
        type: 'system',
        payload: { message: `[MOCK_INFO] worktree requested from ${src}` },
      });
    }
    if (typeof text !== 'string') return;
    const cmd = text.trim();

    console.log(`[mock] User message received: "${cmd}"`);

    // 回归（全新会话首轮点停止后不跳回主页）：test:fresh-interrupt 需要在【回显用户消息之前】就已
    // 存在懒开的 FRESH 实例（sessionId=null，对齐真实 server 未见 SDK init 的窗口）——否则本函数下方
    // "Always echo"会先用 viewingInstanceId=null 广播 user_message，随后才广播的 instances 触发前端
    // bindView→clearView 会把刚回显的气泡一并清空。真实 server 的时序是反过来的：懒开先 broadcastInstances()
    // 后才 a.send()（才 emit user_message）——此处提前创建，让回显自然带上正确的 instanceId，对齐真实时序。
    // test:slow-echo 同样纳入：新会话首发是本 bug 最严重的场景（FRESH 的 attemptedModel 是 undefined，
    // 选了模型就必然触发 setModel 那一跳），且它比"已有会话"多一道坎——懒开广播会触发前端
    // bindView→clearView 清屏，乐观气泡必须活过这次清屏才算真修好。走同一条懒开分支才能把这道坎测出来。
    if ((cmd === 'test:fresh-interrupt' || cmd === 'test:slow-echo') && viewingInstanceId === null) {
      console.log(`[mock] ${cmd} — 模拟新会话首发懒开（sessionId 未到，先广播 instances 再回显）`);
      openFreshMockInstance(requestedModel);
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd), dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });
    }

    // P0-DUP-OPT ①：已有会话里发消息 → 服务端懒开一个【新实例】（真 server 上是实例被
    // INSTANCE_IDLE_RECLAIM_MS 回收后重新 resume）→ broadcastInstances → 前端 bindView。
    // sessionId 不变、instanceId 变，正是「同会话换实例」这条日常路径。
    if (cmd === DUP_OPTIMISTIC_CMD) {
      dupOptimisticArmed = true;
      const cur = mockInstances.find(i => i.instanceId === viewingInstanceId);
      if (cur) {
        cur.instanceId = 'inst_dup_reopened';
        viewingInstanceId = 'inst_dup_reopened';
      }
      console.log('[mock] P0-DUP-OPT — 同会话换实例并广播 instances，触发前端 bindView');
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: workspaceCwdOf(mockInstances.find(i => i.instanceId === viewingInstanceId)?.cwd || mockInstances[0].cwd), dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });
      await delay(DUP_OPTIMISTIC_DELAY_MS);
    }

    // 服务端慢路径显式化（test:slow-echo）。真实 server 从收到 user:message 到 emit user_message 之间
    // 压着一串 await：懒开实例（currentSessionForCwd 读盘 + dedupedResume spawn CLI + transcript 尾读）
    // 与 agent.js#send 里那次 setModel control_request——后者打给一个刚 spawn 还没起来的 CLI，上界就是
    // logic/outbox-send.js 的 SERVER_PRE_TURN_UPPER_BOUND_MS(10s)。
    // mock 默认同步 echo，于是「气泡要等服务端回包才出现」这个真机可见的空窗在 E2E 里【结构性不可见】，
    // 整套回归都跑在"回包瞬时"这一个不真实的时序上。本命令把那段空窗显式化，让「发送后气泡是否立即
    // 可见」成为可断言的行为。延迟值远大于任何同步渲染耗时，断言侧用短于它的 timeout 才有区分力。
    if (cmd === 'test:slow-echo') {
      console.log(`[mock] test:slow-echo — 模拟服务端前置慢路径，延迟 ${SLOW_ECHO_DELAY_MS}ms 后才回显 user_message`);
      await delay(SLOW_ECHO_DELAY_MS);
    }

    // 上面两处 await 期间可能已经 __reset（下一条用例开始了）：迟到的处理不得再碰新用例的状态。
    if (resetGen !== mockResetGeneration) {
      console.log(`[mock] user:message "${cmd}" 醒来时已 __reset，丢弃`);
      return;
    }

    // Always echo user message back
    const echoClientMessageId = typeof messagePayload.clientMessageId === 'string' ? messagePayload.clientMessageId : undefined;

    // 「已 send、还没送达 SDK」的窄窗：真 server 里 send() 返回 true 后消息可能仍在 this.queue，此时点停止
    // 会走 agent.js:947/997 的 queue_dropped 并带上 clientMessageIds，前端据此把那颗气泡标成灰色终态
    // （app.js:1977 markMessageDropped）。mock 此前从不发这个字段，整条路径在 E2E 里不可达——而它失效的
    // 后果是「消息永久消失且屏幕不留任何痕迹」：气泡看起来正常已发送，用户照原文重发会命中服务端
    // commitProcessed 去重被当成功。这里收下消息但【不回显】，等 user:interrupt 收口。
    if (cmd === 'test:queue-drop') {
      if (echoClientMessageId) queuedUndeliveredClientMessageIds.push(echoClientMessageId);
      console.log(`[mock] test:queue-drop — 收下不回显，等 user:interrupt 走 queue_dropped（${echoClientMessageId}）`);
      return;
    }
    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
      type: 'user_message', payload: {
        text: cmd, attachments,
        // Rewind 锚点：真 server 随 user_message 下发 uuid，live 气泡靠它拿 dataset.uuid。
        // mock 不带的话，E2E 里 live 气泡长按恒无效——那个缺陷在真机上不存在，是 mock 自己的分歧。
        uuid: `u-live-${Date.now()}`,
        ...(echoClientMessageId ? { clientMessageId: echoClientMessageId } : {})
      }
    });

    // test:external-echo：上面那条回显被本地占位气泡认领之后，再推一条【本地没有占位气泡】的
    // user_message。这是「另一台设备发的消息」与回放的形态——前端 matchedBubble 只在 .opacity-70
    // 里找，找不到就走「在线新建 user 气泡」那条分支，与占位转正是两个调用点。
    // 【不带 clientMessageId】正是要点：带了就会被认领，又走回转正分支去了。
    if (cmd === 'test:external-echo') {
      socket.emit('agent:event', {
        seq: 1, epoch: 'server', sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'user_message', payload: {
          text: 'EXTERNAL_USER_MESSAGE',
          uuid: 'u-external-1', // Rewind 锚点，同上面回显那条
        }
      });
      console.log('[mock] test:external-echo — 已推一条无占位气泡的 user_message');
      return;
    }

    if (cmd.startsWith('ultracode ')) {
      activeEpoch = 'mock-epoch-ultracode-' + Date.now();
      const activeInst = mockInstances.find(i => i.instanceId === viewingInstanceId);
      if (!activeInst) return;
      // 部分回归场景刻意在已武装 ultracode 时验证其它状态；先让显式 registry 命令接管，
      // 普通 ultracode prompt 再走下方通用 mock 回复。
      if (await scenarioRegistry.run(cmd, { activeInst, requestedModel })) return;
      activeInst.state = 'busy';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });

      await delay(150);
      socket.emit('agent:event', {
        seq: 1, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'text_delta', payload: { messageId: 'msg_ultracode_1', text: `ultracode mock response for: ${cmd}` }
      });

      activeInst.state = 'idle';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });
      socket.emit('agent:event', {
        seq: 2, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'result', payload: { messageId: 'msg_ultracode_1', durationMs: 150, costUsd: 0, isError: false, models: [activeModel] }
      });
      return;
    }

    // Intercept test commands
    if (cmd.startsWith('test:')) {
      activeEpoch = 'mock-epoch-' + cmd.replace(/[^a-zA-Z0-9]/g, '_') + '-' + Date.now();
      const activeInst = mockInstances.find(i => i.instanceId === viewingInstanceId);
      if (activeInst) {
        activeInst.aborted = false; // WS-008：新场景开始，清 abort 标志（interrupt 会置 true 令流式循环提前退出）
        // WS-008b：光靠 aborted 挡不住「中断后立刻发下一条」——它和上面这行清标志互相打架：
        // 停止把 aborted 置 true，但流式循环还睡在 delay 里没醒；此时新命令进来先把标志清回 false，
        // 循环醒来看到 false 就继续跑完整整 16s，最后那记 instances 广播带的是【启动时快照的】
        // viewingInstanceId，落在好几个 test 之后 → 前端 bindView 清屏，表现为毫不相干的用例莫名其妙
        // 少了消息（实测：P0-04b 泄漏的循环打中 P0-13 的 test:tool 窗口）。
        // 加单调递增的回合号：旧循环发现回合已经不是自己那一轮，立即退出。两条退出路径互不干扰。
        activeInst.turnSeq = (activeInst.turnSeq ?? 0) + 1;
      }

      if (await scenarioRegistry.run(cmd, { activeInst, requestedModel })) return;
    }
  });

  // Handle user permission decision
  socket.on('user:approve', async payload => {
    const { requestId, decision, alwaysThisSession, instanceId, exitMode } = payload || {};
    console.log(`[mock] User approve received: requestId=${requestId}, decision=${decision}, always=${alwaysThisSession}${exitMode ? `, exitMode=${exitMode}` : ''}`);

    if (pendingPermission && pendingPermission.requestId === requestId) {
      const activeInst = mockInstances.find(i => i.instanceId === (instanceId || viewingInstanceId));
      activeInst.state = 'busy';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });

      // Broadcast resolved
      io.emit('agent:event', {
        seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'request_resolved', payload: { requestId, kind: 'permission', outcome: decision }
      });

      if (decision === 'allow') {
        if (alwaysThisSession && pendingPermission.name) {
          const targetInstanceId = activeInst.instanceId;
          if (!alwaysAllowedPermissionNamesByInstance.has(targetInstanceId)) {
            alwaysAllowedPermissionNamesByInstance.set(targetInstanceId, new Set());
          }
          alwaysAllowedPermissionNamesByInstance.get(targetInstanceId).add(pendingPermission.name);
        }
        // 对齐 CLI plan-exit：ExitPlanMode 批准时优先用客户端 exitMode，否则用场景预设 setMode
        const EXIT_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions']);
        const resolvedMode = (pendingPermission.name === 'ExitPlanMode' && EXIT_MODES.has(exitMode))
          ? exitMode
          : pendingPermission.setMode;
        if (resolvedMode) {
          const inst = mockInstances.find(i => i.instanceId === viewingInstanceId);
          if (inst) inst.permissionMode = resolvedMode;
          io.emit('agent:event', {
            seq: 0, epoch: 'server', sessionId: null, instanceId: viewingInstanceId, ts: Date.now(),
            type: 'permission_mode', payload: { mode: resolvedMode }
          });
        }
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: pendingPermission.toolUseId, ok: true, outputSummary: pendingPermission.approveOutput || 'git push success: branch main -> origin' }
        });
        socket.emit('agent:event', {
          seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: pendingPermission.messageId, text: pendingPermission.approveText || '\n\n✓ Successfully pushed latest codebase additions!' }
        });
      } else {
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId: pendingPermission.toolUseId, ok: false, outputSummary: 'user denied command execution', denyKind: 'denied' }
        });
        socket.emit('agent:event', {
          seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
          type: 'text_delta', payload: { messageId: pendingPermission.messageId, text: '\n\n🚫 Git push command was rejected by user. Aborted.' }
        });
      }

      await delay(500);
      activeInst.state = 'idle';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });

      socket.emit('agent:event', {
        seq: 7, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'result', payload: { messageId: pendingPermission.messageId, durationMs: 1200, costUsd: 0.001, isError: false, models: [activeModel] }
      });

      pendingPermission = null;
      syncPendingSnapshot = null;
      syncPendingSnapshotInstanceId = null;
    }
  });

  // B2：后台任务输出（对齐 server task:output）。真服务端只收 taskId、路径从自己记录的 CLI
  // 上报值取（客户端永远不传路径），mock 同样只按 taskId 分发，不接受任何路径入参。
  socket.on('task:output', ({ taskId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (taskId === 'bg_task_1') {
      return ack({ ok: true, text: 'MOCK_TASK_OUTPUT_LINE\n=== e2e finished ok ===', truncated: false, size: 42 });
    }
    ack({ ok: false, error: '输出不可用（mock 未记录该任务）' });
  });

  // 工具全文展开（对齐 server tool:full）：mock 对已知 toolUseId 返回全文
  // 子代理执行流水的按需拉取（历史侧展开卡片时触发）。真 server 走 readSubagentFlow 读
  // <sessionId>/subagents/agent-*.jsonl；这里给等价形状的 fixture。
  // items 的形状与 session:history 的消息同构（text 条目不带 kind，工具类才带）——真 server 那边
  // 是复用 expandHistoryEntry 得到的，mock 若漂了，前端"复用同一套渲染"的前提就假了。
  socket.on('subagent:flow', ({ toolUseId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (toolUseId !== 'sah-agent-1') return ack({ ok: false, reason: 'not_found' });
    return ack({
      ok: true,
      agentType: 'code-reviewer',
      description: 'Review auth module',
      total: 3,
      truncated: false,
      items: [
        { role: 'assistant', content: 'Scanning auth handlers for CSRF gaps…', timestamp: new Date(Date.now() - 8 * 60_000).toISOString(), isSidechain: true, parentToolUseId: 'sah-agent-1' },
        { kind: 'tool_use', role: 'assistant', toolUseId: 'sah-read-1', name: 'Read', inputSummary: '{"file_path":"app/src/auth.js"}', timestamp: new Date(Date.now() - 7 * 60_000).toISOString(), isSidechain: true, parentToolUseId: 'sah-agent-1' },
        { kind: 'tool_result', role: 'user', toolUseId: 'sah-read-1', ok: true, outputSummary: 'export function login() { /* ... */ }', timestamp: new Date(Date.now() - 7 * 60_000).toISOString(), isSidechain: true, parentToolUseId: 'sah-agent-1' },
      ],
    });
  });

  socket.on('tool:full', ({ toolUseId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (toolUseId === 't_bash') {
      return ack({ ok: true, text: '✓ All 5 visual regression unit tests passed successfully!\n(extra full lines from tool:full mock)' });
    }
    if (toolUseId === 't_trunc') {
      return ack({ ok: true, text: 'FULL_TOOL_OUTPUT_LINE\n'.repeat(40).trim() });
    }
    ack({ ok: false, error: '全文不可用（mock 未缓存）' });
  });

  // P0-DIFF：工具卡「预览变更」（对齐 server tool:preview）。t_fc_edit/t_fc_write 复用
  // test:file-changes 场景（scenarios/content.js）建的工具卡——点其「预览变更」按钮即可触发。
  socket.on('tool:preview', ({ toolUseId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (toolUseId === 't_fc_edit') {
      // 三行片段只中间一行变：验证前后保留上下文行、只中间 -/+ 各一行（行级 diff，非整块红绿）。
      return ack({
        ok: true,
        name: 'Edit',
        inWhitelist: true,
        attribution: { workdirLabel: 'claude-chat-mobile', relPath: 'README.md' },
        diff: { hunks: [{ old: 'line one\nold middle\nline three', new: 'line one\nnew middle\nline three' }] },
      });
    }
    if (toolUseId === 't_fc_write') {
      // Write 无 old：维持既有整块绿（不走行级 diff）。
      return ack({
        ok: true,
        name: 'Write',
        inWhitelist: true,
        attribution: { workdirLabel: 'claude-chat-mobile', relPath: 'CLAUDE.md' },
        diff: { added: 'line1\nline2\nline3' },
      });
    }
    if (toolUseId === 't_fc_read') {
      // Read 类工具的预览走 snippet（不是 diff）。真 server 只在 toolInput.name === 'Read' 时带这个字段
      // （socket-files.js）。mock 此前没有这一支，t_fc_read 落到下面的兜底 ok:false ——于是 app.js:2283
      // 那整段「图片→缩略图 / 文本→代码高亮」在 E2E 里不可达。漏发时用户点「📄 预览文件」只看到一行
      // 路径归属，下面什么都没有，也没有错误提示（因为 ok:true 走不到错误支）。
      return ack({
        ok: true,
        name: 'Read',
        inWhitelist: true,
        attribution: { workdirLabel: 'claude-chat-mobile', relPath: 'package.json' },
        snippet: { snippet: '{\n  "name": "claude-chat-mobile",\n  "version": "1.6.2"\n}', truncated: false },
      });
    }
    ack({ ok: false, error: '预览不可用（mock 未缓存）' });
  });

  // Handle user question choice selection (optionIndex / optionIndexes / freeText)
  socket.on('user:answer', async payload => {
    const { requestId, optionIndex, optionIndexes, freeText, instanceId } = payload || {};
    console.log(`[mock] User answer received: requestId=${requestId}, choice=${optionIndex}, multi=${Array.isArray(optionIndexes) ? optionIndexes.join(',') : ''}, freeText=${freeText ? '[set]' : ''}`);

    if (pendingQuestion && pendingQuestion.requestId === requestId) {
      const activeInst = mockInstances.find(i => i.instanceId === (instanceId || viewingInstanceId));
      activeInst.state = 'busy';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });

      const free = typeof freeText === 'string' ? freeText.trim() : '';
      let selectedOption;
      let outcome;
      if (free) {
        selectedOption = free;
        outcome = `other: ${free}`;
      } else if (Array.isArray(optionIndexes) && optionIndexes.length) {
        const labels = optionIndexes.map(i => {
          const o = pendingQuestion.options[i];
          return (o && typeof o === 'object') ? (o.label || '') : o;
        }).filter(Boolean);
        selectedOption = labels.join('、');
        outcome = `options ${optionIndexes.join(',')}`;
      } else {
        const o = pendingQuestion.options[optionIndex];
        selectedOption = (o && typeof o === 'object') ? (o.label || o) : o;
        outcome = `option ${optionIndex}`;
      }

      // Broadcast resolved
      io.emit('agent:event', {
        seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'request_resolved', payload: { requestId, kind: 'question', outcome }
      });

      socket.emit('agent:event', {
        seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'tool_result', payload: { toolUseId: pendingQuestion.toolUseId, ok: true, outputSummary: `User selected: ${selectedOption}`, denyKind: 'answered' }
      });

      socket.emit('agent:event', {
        seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'text_delta', payload: {
          messageId: pendingQuestion.messageId,
          text: pendingQuestion.answerText
            ? pendingQuestion.answerText.replace('{option}', selectedOption)
            : `\n\nUnderstood. We will target the **${selectedOption}** branch. Beginning compilation...`
        }
      });

      await delay(800);
      activeInst.state = 'idle';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });

      socket.emit('agent:event', {
        seq: 7, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: viewingInstanceId, ts: Date.now(),
        type: 'result', payload: { messageId: pendingQuestion.messageId, durationMs: 1800, costUsd: 0.0018, isError: false, models: [activeModel] }
      });

      pendingQuestion = null;
    }
  });

  socket.on('user:approveDevice', payload => {
    pendingDevices = pendingDevices.filter(d => d.shortId !== payload?.shortId);
    emitPendingDevices();
  });

  socket.on('user:denyDevice', payload => {
    pendingDevices = pendingDevices.filter(d => d.shortId !== payload?.shortId);
    emitPendingDevices();
  });

  // 吊销已信任设备。真 server 走 decideRevokeByShortId：命中自己 → 拒绝（self），
  // 0/多命中 → 拒绝（not_found）。mock 复刻这两个出口，否则 E2E 里那两支不可达。
  // 改名（对位真 server 的 user:renameTrustedDevice）。归一逻辑不复刻——那是 devices.js 的
  // 单测面；这里只保证「发出去能存下、重播回来」，让 E2E 覆盖得到那条交互。
  socket.on('user:renameTrustedDevice', payload => {
    const hit = trustedDevices.find(d => d.shortId === payload?.shortId);
    if (!hit) { emitTrustedDevices(); return; }
    const alias = String(payload?.alias ?? '').trim();
    hit.alias = alias || null;
    emitTrustedDevices();
  });

  socket.on('user:revokeTrustedDevice', payload => {
    const shortId = payload?.shortId;
    const hit = trustedDevices.filter(d => d.shortId === shortId);
    if (hit.length !== 1) { emitTrustedDevices(); return; }
    if (hit[0].isCurrent) { emitTrustedDevices(); return; } // 自吊销守卫
    trustedDevices = trustedDevices.filter(d => d.shortId !== shortId);
    emitTrustedDevices();
  });

  // 后台任务停止（对齐 server task:stop → agent.stopTask）：mock 仅记日志，幂等
  // 真 server 的 ack 是 agent.stopTask 的返回值：disposed / 无 taskId / control_request 10s 超时都回
  // false，前端据 `res?.ok === true` 分流成灰色「已请求停止后台任务…」与橙色「停止请求未生效：任务
  // 可能已结束」。mock 此前 handler 签名连 ack 参数都没有、从不回调，于是前端只能吃 1.5s 兜底、恒走
  // 灰色支——橙色那条在整套 E2E 里不可达，用户以为停掉了而任务还挂在面板上。
  // 语义取「同一个 taskId 停第二次 = 它已经不在了」，与真 server 的 false 同因，且不必新造场景。
  socket.on('task:stop', (payload, ack) => {
    const taskId = payload?.taskId || '';
    console.log(`[mock] task:stop taskId=${taskId} instanceId=${payload?.instanceId || viewingInstanceId}`);
    const first = !mockStoppedTaskIds.has(taskId);
    mockStoppedTaskIds.add(taskId);
    if (typeof ack === 'function') ack({ ok: first });
  });

  // 额度墙自动继续横幅的按钮（真 server：app.js 的 user:autoContinue → auto-continue.js 的 act()）。
  // 相位迁移照抄真 server：cancel 撤条目 · arm 只接受 offered → armed · continueNow 只接受 stale（真 server
  // 随即代发续跑、条目撤掉）。其余组合 ok:false 且不改状态——前端据此重画、解锁按钮。
  socket.on('user:autoContinue', (payload, ack) => {
    const { sessionId, action } = payload || {};
    const idx = mockAutoContinue.findIndex(e => e.sessionId === sessionId);
    const e = idx >= 0 ? mockAutoContinue[idx] : null;
    let ok = false;
    if (e && action === 'cancel') { mockAutoContinue.splice(idx, 1); ok = true; }
    else if (e && action === 'arm' && e.phase === 'offered') {
      mockAutoContinue[idx] = { ...e, phase: 'armed', reason: null, origin: 'manual', fireAt: e.resetsAt + 30_000 };
      ok = true;
    } else if (e && action === 'continueNow' && e.phase === 'stale') {
      mockAutoContinue.splice(idx, 1);
      ok = true;
      // 真 server 接着就代发续跑那句（fire → a.send(..., { origin: 'auto-continuation' })）。
      // 必须模拟出来：否则 continueNow 与 cancel 在前端看到的结果一样（横幅收起），发错动作也测不出来。
      // epoch:'server' + seq:0：前端只对非 server epoch 做 seq 去重（同 user:interrupt 那条合成事件的约定）。
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId, instanceId: viewingInstanceId, ts: Date.now(),
        type: 'user_message',
        payload: { text: 'Your usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.', uuid: 'u-auto-continue-now', origin: 'auto-continuation' },
      });
    }
    if (ok) broadcastAutoContinue();
    if (typeof ack === 'function') ack(ok ? { ok: true } : { ok: false, error: e ? 'invalid_action' : 'not_found' });
  });

  // Handle user interrupt (stop button / question skip)
  // 真实 agent 里 interrupt → AbortSignal → handleQuestion abortHandler →
  // request_resolved(aborted) + denyKinds(cancelled) + 轮次收尾。mock 对齐这条链，
  // 否则「跳过此问题」只能发出 interrupt 却关不掉弹窗（前端故意不乐观关窗）。
  // 注意：agent:event 带 activeEpoch 时 seq 必须单调递增——前端 `ev.seq <= lastSeq` 会丢弃回退 seq，
  // 所以这里绝不能发 seq:0（question 已是 seq:3 时会把 resolved 整条滤掉）。
  socket.on('user:interrupt', payload => {
    const { instanceId } = payload || {};
    const targetId = instanceId || viewingInstanceId;
    console.log(`[mock] User interrupt received for instance ${targetId}`);
    const activeInst = mockInstances.find(i => i.instanceId === targetId);
    if (activeInst) {
      activeInst.aborted = true; // WS-008：令仍在跑的流式场景（如 test:stream-long）下个 delay 后提前退出，不再后台续发事件
      activeInst.state = 'idle';
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, ts: Date.now(),
        type: 'instances', payload: { canRestart: mockCanRestart, viewingInstanceId, viewingCwd: activeInst.cwd, dirs: Array.from(new Set(mockInstances.map(i => i.cwd))), instances: mockInstances, service: mockServicePayload() }
      });
    }
    // 尚未送达 SDK 的消息随停止落终态（真 server：agent.js:947 超时强制收口 / :997 正常 interrupt 路径）。
    // 与 request_resolved 分开发：真 server 里这两件事本就无先后依赖。
    if (queuedUndeliveredClientMessageIds.length) {
      // epoch:'server' + seq:0 是本 mock 对「合成/无主事件」的既有约定（同函数末尾那条『已中断』同形）：
      // event-dispatch.js:85 只对【非 server epoch】做 seq 去重，而 `event.seq <= state.lastSeq` 会把
      // seq:0 当成重复【静默丢弃】——第一版我按真 epoch 发，事件到了浏览器却一个字都不显示。
      io.emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: null, instanceId: targetId, ts: Date.now(),
        type: 'system', payload: {
          message: '尚未送达的消息已随停止取消',
          kind: 'queue_dropped',
          clientMessageIds: queuedUndeliveredClientMessageIds.splice(0),
        }
      });
    }

    // 挂起的 AskUserQuestion：按真实 abort 路径关闭
    // 真实 agent 对每道题 emit request_resolved({ requestId: `${toolUseID}#${i}`, outcome:'aborted' })
    // ——requestId 用带 #i 的完整 id，前端 matchQ 直接相等命中；seq 接在 question(seq:3) 之后。
    if (pendingQuestion) {
      const q = pendingQuestion;
      const toolUseId = q.toolUseId || (typeof q.requestId === 'string' ? q.requestId.split('#')[0] : null);
      io.emit('agent:event', {
        seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetId, ts: Date.now(),
        type: 'request_resolved', payload: { requestId: q.requestId, kind: 'question', outcome: 'aborted' }
      });
      if (toolUseId) {
        socket.emit('agent:event', {
          seq: 5, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetId, ts: Date.now(),
          type: 'tool_result', payload: { toolUseId, ok: false, outputSummary: '问题已取消', denyKind: 'cancelled' }
        });
      }
      if (q.messageId) {
        socket.emit('agent:event', {
          seq: 6, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetId, ts: Date.now(),
          // interrupted 与真 server 对齐（agent.js:2906）：前端 presentTurnResult 用它【压过】isError 分流，
          // 漏发会把「你按了停止」渲染成红色「出错：」条 + 推送标题「⚠️ 任务出错」。
          type: 'result', payload: { messageId: q.messageId, durationMs: 200, costUsd: 0, isError: false, interrupted: true, models: [activeModel] }
        });
      }
      pendingQuestion = null;
      syncPendingSnapshot = null;
      syncPendingSnapshotInstanceId = null;
    }

    // 挂起的权限审批：interrupt 同样应清掉（真实 agent dispose/interrupt 路径会 deny）
    if (pendingPermission) {
      io.emit('agent:event', {
        seq: 4, epoch: activeEpoch, sessionId: 'mock-session-visual-test', instanceId: targetId, ts: Date.now(),
        type: 'request_resolved', payload: { requestId: pendingPermission.requestId, kind: 'permission', outcome: 'denied' }
      });
      pendingPermission = null;
      syncPendingSnapshot = null;
      syncPendingSnapshotInstanceId = null;
    }

    socket.emit('agent:event', {
      seq: 0, epoch: 'server', sessionId: null, instanceId: targetId, ts: Date.now(),
      type: 'system', payload: { message: '已中断', kind: 'interrupted' }
    });
  });

  socket.on('disconnect', () => {
    console.log(`[mock-conn] Socket disconnected: ${socket.id}`);
  });
});

const bindHost = process.env.CCM_MOCK_BIND || '127.0.0.1';
httpServer.listen(PORT, bindHost, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Antigravity Visual Mock Server is running on port ${PORT}`);
  console.log(`📍 Web UI URL: http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${PORT}`);
  console.log(`🛠️ To execute visual tests, open this URL in your browser!`);
  console.log(`======================================================\n`);
});
