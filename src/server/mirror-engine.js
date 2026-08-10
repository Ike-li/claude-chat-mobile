// mirror-engine.js —— 只读镜像 / catchUp 追平引擎：状态与编排的唯一所有者。
//
// 【为什么收敛】此前 15 个 mirror*/catchUp* 模块级可变量散在 src/server/app.js 顶层，与当时 32 个 socket
// handler 共享同一作用域；而它们的决策规则早已提纯到 src/sessions/history.js。读懂一次「终端是否在驾驶」
// 要同时看两个文件、且 app.js 里任何人都能改这些量。本模块把状态与编排合到一处，对 app.js 只暴露窄接口。
// 规则纯函数仍留在 history.js（classifyTranscriptTail 一族与 transcript 解析强耦合，搬走会断链），
// 由本模块 import——「读盘与判形态」归 history.js，「编排状态机」归这里。
//
// 【本次是纯位置迁移】逻辑一行未改：原 app.js:917-1277 整块搬入，仅把对 app.js 作用域的直接引用
// （viewingInstanceId / agents / io / instanceState 等）改为构造期注入。行为差异应为零。
import {
  getSessionHistory, historyTailKey, sessionFileSize, classifyTranscriptTail,
  catchUpStep, mirrorReleaseStep, mirrorEntryLock, mirrorStaleFlag,
  externalGrowthWhilePaused, rebaselineAbsorbedExternal, describeMirrorEntryLock,
} from '../sessions/history.js';
import { readSessionRegistry, registryIndicatesTerminalBusy, cliPresenceStep } from '../sessions/session-registry.js';
import { readCliObservedState } from '../agent/cli-mirror-state.js';
import * as diagLog from '../agent/diag-log.js';
import * as metrics from '../ops/metrics.js';

// 注入面即本引擎与 app.js 的全部耦合点：视图态读取器、实例注册表、广播通道、statusline 刷新钩子。
// viewingInstanceId 必须以 getter 注入——它在 app.js 里被 socket handler 改写，引擎每次都要读当下值。
export function createMirrorEngine({
  io,
  agents,
  instanceState,
  getViewingInstanceId,
  viewingCwdOf,
  serviceStartedAt,
  scheduleStatusRefresh,
  readCliSnapshotForSession,   // 与 app.js statusline 路由共用同一份读取器
  statusBridgeOff = false,
  // 夹具根注入（仅单测用；生产两者恒为 null → 下面展开成 {}，各 reader 用自己的默认根，行为零变化）。
  // 与 history.js 既有约定同款（"baseDir 仅供单测注入临时夹具；生产用默认 CLAUDE_DIR"）。
  // 没有这个口子，本模块的四条 tick 分支（切入预锁 / localBusy / 正常追平 / 无会话）就只能靠写
  // 真实 ~/.claude/projects 与 ~/.claude/sessions 来测——那会污染机主的 CLI 目录，且往
  // ~/.claude/sessions 塞活 pid 条目会让机主正在跑的 server 看到幻影「终端会话」。
  transcriptBaseDir = null,
  sessionRegistryDir = null,
} = {}) {
  // 展开进各 reader 的 options；null 时为空对象 = 走 reader 自己的默认根。
  const diskOpts = transcriptBaseDir ? { baseDir: transcriptBaseDir } : {};
  const registryOpts = sessionRegistryDir ? { dir: sessionRegistryDir } : {};
  // 只能轮询磁盘 transcript，把终端【已落定】的新消息追加到 web。单定时器自适配当前查看会话（切会话即重置基线），
  // 决策交纯函数 catchUpStep（history.js，单测覆盖）。看不到实时 thinking / 在跑子 agent——它们不落盘（已知边界）。
  const CATCH_UP_INTERVAL_MS = 2500;          // 常态追平间隔
  const CATCH_UP_MIRROR_INTERVAL_MS = 1000;   // 只读镜像中更勤：盯终端落盘时体感更跟手
  const MIRROR_RELEASE_MS = 12_500;           // 终端静默多久自动解锁（与 history MIRROR_RELEASE_QUIET_TICKS×2.5s 同口径）
  // 只读锁：仅当轮询【观察到外部真落定新消息】(catchUpStep emit 非空) ⇒ 判终端活跃 ⇒ 发 mirror_state 令前端
  // 禁用输入，硬防「两进程并发写同一 JSONL 致会话分叉」。解锁：切会话重判 / 用户显式接管（前端 override）。
  // 不用 transcript mtime 判活：web 端自己 resume 会话时 claude --resume 就写盘刷新 mtime（追加 mode 记录），
  // 无法据此区分「己方续接」与「终端在跑」——曾致纯 web 打开/切换会话被误锁只读（切入即 mtime 判活口径已废弃）。
  let mirrorReadonly = false;                         // 当前查看会话是否判「终端活跃、只读」（全局单值，非 per-连接）
  // 【已评估：不做 AD-5 per-连接锁粒度（2026-07-12 机主确认，Phase 8 技术债）】mirrorReadonly 是全局单值 +
  // io.to('approved') 全局广播 + viewingInstanceId 单例全局——已知缺陷：两台设备看不同会话时，
  // 给会话 B 的 mirror_state 会误解锁正看会话 A 的另一端（前端 onMirrorState 注释同款登记）。AD-5 的完整修复
  // （viewing/catchup/mirror 全改 per-(sessionId,connId) + readonly_changed 定向下发）是改动面很广的大改，触发
  // 面窄（仅"同一人多设备同看不同会话"并发），n=1 单用户下不值，保留现状。索引见 docs/hard-rules.md §5；
  // 别再因"AD-5 是改进方向"重启这个大改。
  let mirrorStale = false;                            // stale=疑似终端中断（锁着+尾部 pending+超 MIRROR_STALE_PENDING_MS 零写入），前端换「可接管」文案
  // autonomous=锁是否可确定是本会话自己被 ScheduleWakeup/CronCreate 定时唤起（尾窗内查到 harness 注入
  // 的 "# Autonomous loop check" marker，见 history.js#hasAutonomousLoopMarker），而非真不知道来源的
  // 「大概率终端」——前端据此挑更准确的横幅文案，不改变是否上锁（2026-07-24 真机复现：web-only 会话被
  // 自主循环唤起时尾部形态和终端接管完全同构，横幅误说「终端会话运行中」）。
  let mirrorAutonomous = false;
  let mirrorObservedCli = { model: null, permissionMode: null, effort: null };
  let mirrorSessionId = null, mirrorInstanceId = null; // 锁/观察态的归属；切视图空窗不得把 A 的全局锁套到 B
  function normalizeMirrorObserved(observed, readonly) {
    if (!readonly) return { model: null, permissionMode: null, effort: null };
    return {
      model: observed?.model ?? null,
      permissionMode: observed?.permissionMode ?? null,
      effort: observed?.effort ?? null,
    };
  }
  function sameMirrorObserved(a, b) {
    return a.model === b.model && a.permissionMode === b.permissionMode && a.effort === b.effort;
  }
  function mirrorOwnedBy(sessionId, instanceId) {
    return mirrorReadonly && mirrorSessionId === sessionId && mirrorInstanceId === instanceId;
  }
  function mergeCliObserved(transcriptObserved, sessionId, cwd) {
    const base = transcriptObserved || { model: null, permissionMode: null };
    if (statusBridgeOff) return { model: base.model ?? null, permissionMode: base.permissionMode ?? null, effort: null };
    const cliRead = readCliSnapshotForSession(sessionId, cwd);
    const snapshot = cliRead.state === 'fresh' ? cliRead.snapshot : null;
    return {
      model: snapshot?.model?.id ?? base.model ?? null,
      permissionMode: base.permissionMode ?? null,
      effort: snapshot?.effort ?? null,
    };
  }
  function catchUpIntervalMs(readonly = mirrorReadonly) {
    return readonly ? CATCH_UP_MIRROR_INTERVAL_MS : CATCH_UP_INTERVAL_MS;
  }
  function mirrorReleaseTicksNeeded(readonly = mirrorReadonly) {
    // 墙钟目标 MIRROR_RELEASE_MS：mirror 提速轮询时提高 tick 数，避免 1s×5=5s 过早解锁
    return Math.max(1, Math.ceil(MIRROR_RELEASE_MS / catchUpIntervalMs(readonly)));
  }
  function mirrorRemainingMs({ readonly = mirrorReadonly, quietTicks = Number(mirrorRelease?.quietTicks) || 0 } = {}) {
    if (!readonly) return 0;
    const interval = catchUpIntervalMs(readonly);
    const need = mirrorReleaseTicksNeeded(readonly);
    return Math.max(0, (need - quietTicks) * interval);
  }
  function setMirror(readonly, sessionId, force = false, stale = false, observedCli = mirrorObservedCli, forInstanceId = getViewingInstanceId(), reason = null, autonomous = mirrorAutonomous) {
    // forInstanceId = 调用方冻结的 viewing 快照（catchUpTick 入口 id）。切视图后旧 tick 不得改全局锁——
    // 否则 A 的解锁会误解锁 B，A 的上锁会以「当下 viewing」重贴到 B（跨工作区误锁根因）。
    // force 仅给 clearMirrorOnViewChange / 接管后显式解锁：允许在 viewing 已变时推权威态。
    if (!force && forInstanceId !== getViewingInstanceId()) return;
    const nextObserved = normalizeMirrorObserved(observedCli, readonly);
    const nextSessionId = readonly ? (sessionId ?? null) : null;
    const nextInstanceId = readonly ? forInstanceId : null;
    const nextAutonomous = readonly ? Boolean(autonomous) : false; // 解锁态下这个字段没有意义，归零同 sessionId/instanceId
    const quietTicks = Number(mirrorRelease?.quietTicks) || 0;
    // 用【目标】readonly 算 remaining，勿读旧 mirrorReadonly（上锁瞬间旧值仍是 false 会算成 0）
    const remainingMs = mirrorRemainingMs({ readonly, quietTicks });
    // remainingMs 变化时也要推（倒计时 UI）；与 observedCli 同理
    if (!force && readonly === mirrorReadonly && stale === mirrorStale
        && nextSessionId === mirrorSessionId && nextInstanceId === mirrorInstanceId
        && sameMirrorObserved(nextObserved, mirrorObservedCli)
        && nextAutonomous === mirrorAutonomous
        && remainingMs === (mirrorLastEmittedRemainingMs ?? -1)) return;
    // 诊断时间线：只在真正要广播状态变化时才记（上面的早退已过滤掉稳态轮询噪音）。
    // key 优先用目标 sessionId，解锁广播（sessionId=null）时退回当前实例的 sessionId，仍找不到就诚实丢弃。
    const diagSessionKey = nextSessionId || sessionId || agents.get(forInstanceId)?.sessionId || null;
    if (diagSessionKey) {
      diagLog.record(diagSessionKey, 'mirror', 'state_change', { reason, readonly, prevReadonly: mirrorReadonly, stale, autonomous: nextAutonomous });
    }
    // observedCli 也参与变化判定：CLI 在同一只读轮次里 /model 或 /permissions 后，readonly/stale 不变，
    // 仍必须推一条 mirror_state；否则 Web 会永远停在旧模型/模式。
    mirrorReadonly = readonly; mirrorStale = stale; mirrorObservedCli = nextObserved; mirrorAutonomous = nextAutonomous;
    mirrorSessionId = nextSessionId; mirrorInstanceId = nextInstanceId;
    mirrorLastEmittedRemainingMs = remainingMs;
    io.to('approved').emit('agent:event', { // SEC-01：仅广播给已批准设备
      seq: 0, epoch: 'server', sessionId: sessionId ?? null,
      instanceId: readonly ? forInstanceId : getViewingInstanceId(),
      cwd: viewingCwdOf(), // SRV-NEW-006
      ts: Date.now(), type: 'mirror_state',
      // cliSeen：本次观察期内是否见过 entrypoint=cli 的活注册表条目（cliPresenceStep 的 seen 槽）——
      // 即「确实有终端进程在/曾在驾驶」这一事实。false 时锁是靠 transcript 尾部形态【推断】出来的，
      // 前端据此决定 stale 要不要说成「终端疑似中断」：没见过终端就别断言终端，只说只读。
      payload: { readonly, stale, observedCli: nextObserved, quietTicks, remainingMs, autonomous: nextAutonomous, cliSeen: mirrorCliSeen },
    });
    scheduleStatusRefresh(); // 驾驶方或 CLI 观察态变化时立即切换/刷新 statusline 来源
    rescheduleCatchUp(); // 锁态变 → 追平间隔在 1s/2.5s 间切换
  }
  // 切视图 / 切工作区 / 新会话 / 回空首页：立即复位全局 mirror 态并广播 readonly=false。
  // 否则 catchUpTick 要等下一轮（切换分支 classifyTail 或无会话分支）才清锁，空窗内全局
  // mirrorReadonly 仍挂着 A 会话——statusline/重连快照会把「终端驾驶中」套到 B（跨工作区误锁根因）。
  // force=true 保证即使已是 false 也推一条权威空闲快照（前端 setInstances 已本地清，但重连/迟到事件靠此兜底）。
  function clearMirrorOnViewChange() {
    catchUpKey = null;
    mirrorRelease = { readonly: false, quietTicks: 0 };
    mirrorLastSize = -1;
    setMirror(false, null, true, false, mirrorObservedCli, getViewingInstanceId(), 'view_cleared');
  }
  let mirrorLastEmittedRemainingMs = -1;
  let catchUpKey = null;                              // `${cwd}\x00${sessionId}`：当前追平的会话
  let catchUpState = { baseline: 0, wasBusy: false, lastTailKey: null };
  let catchUpRebaselineRequested = false;             // BE-009：客户端（重）连时置位，下一 tick 重定基线；先检测被吸收的外部增长再标 externalDirty，防分叉
  // 只读锁释放状态机（history.js mirrorReleaseStep，含自动解锁计时）——修 code-review 发现 1：
  // 原实现上锁后无任何自动释放路径，终端写一次就把移动端输入锁死到手动切会话/接管为止。现每 tick 据
  // 「本 tick 有无外部写入 / web 是否在跑」推进 quietTicks：终端静默足够久（idle 且连续 N tick 无外部写入）自动解锁。
  let mirrorRelease = { readonly: false, quietTicks: 0 };
  let mirrorLastSize = -1;                            // 上一 tick 的 transcript 字节大小（keep-alive 判文件增长）；-1=基线未建立（切入 / localBusy 后首个正常 tick 只记 size 不判增长）
  let mirrorCliSeen = false;                          // 负证据槽（session-registry cliPresenceStep）：观察期内是否见过 entrypoint=cli 的活注册表条目；「曾见→消失」= 终端已死，喂 mirrorStaleFlag 立即判 stale；切会话在 entry 分支重置
  // 接管 fencing token（R2/2026-08-06）。tick 的三重提交守卫比对 viewing / 实例引用 / cwd+sessionId，
  // 而用户接管【不改变其中任何一项】——一个在 takeOver 之前开始读盘、之后才 resolve 的 tick 会带着
  // 接管前的观察走完提交段：重新标脏 + 广播 history_append + 重新上锁，用户刚拿到的输入权当场被夺走
  // （且随后本方轮次开跑会让 mirrorReleaseStep 维持锁，要再攒满 12.5s 静默才解锁）。
  // takeOver 递增本计数；tick 入口取快照，提交前比对——变了就整 tick 作废，与 viewing 守卫同款语义。
  let takeOverGeneration = 0;
  async function catchUpTickOnce() {
    const takeOverAtEntry = takeOverGeneration;
    const id = getViewingInstanceId();
    const a = id ? agents.get(id) : null;
    if (!a || !a.sessionId) { catchUpKey = null; mirrorRelease = { readonly: false, quietTicks: 0 }; mirrorLastSize = -1; setMirror(false, null, false, false, undefined, id, 'no_session'); return; } // 无查看会话：停、复位释放态
    const key = `${a.cwd}\x00${a.sessionId}`;
    const st = instanceState(id);
    const localBusy = st === 'busy' || st === 'permission';
    // BE-009：处理「客户端（重）连要求重定基线」。旧实现连接时直接 `catchUpKey = null` 强制下方 switch 分支重建
    // baseline，但会把「连接前终端写入、catchUpTick 尚未观察」的外部增长静默吸收——不标 externalDirty，SDK 内存
    // 上下文继续滞后 → 下条手机消息从旧位置分叉。此处在重建【之前】比较磁盘长度与旧 baseline：同一会话重连且磁盘
    // 更长 = 有被吸收的外部增长 → 标 externalDirty（下次发送前置换实例吸收），再置 catchUpKey=null 保留原「重连
    // 重渲无重复气泡」行为。真会话切换（key !== catchUpKey）不在此判、由下方 switch 分支按新会话正常重建。
    // 2026-07-18 修复：上面这段判断此前没看本函数已算好的 localBusy——手机锁屏/切后台/切网络自动重连时，若恰好
    // 撞上己方 turn 还在跑或后台任务未完，磁盘变长其实是自己写出来的，却被无条件标 externalDirty：忙碌时命中
    // externalDirtyBusyNack 硬拒绝发送（不排队、不重试）、空闲时则触发一次没必要的 dispose+resume 冷启动。现把
    // localBusy 传给 rebaselineAbsorbedExternal，与下面「己方在跑不算终端 keep-alive」对齐同一判据。
    // 同会话重连重定基线（非真切换）：下面靠 catchUpKey=null 复用切入分支，但切入分支的「陈旧 pending
    // 豁免」是为"隔天打开无人管的会话"设的——同会话连续观察不该走它，否则终端跑长工具跨过 5 分钟时，
    // 手机息屏/断网/刷新任一触发的一次重连就把已维持的锁清掉且再也建不回来（见 mirrorEntryLock）。
    let rebaselineSameSession = false;
    if (catchUpRebaselineRequested) {
      catchUpRebaselineRequested = false;
      if (key === catchUpKey) {                                        // 同一会话重连（非真切换）
        rebaselineSameSession = true;
        // SS-NEW-002：保留 messages 算 tailKey——满窗滑动时 length 不变，仅比 length 会漏标 externalDirty
        const curMsgs = await getSessionHistory(a.sessionId, a.cwd, undefined, diskOpts).catch(() => null);
        const curLen = Array.isArray(curMsgs) ? curMsgs.length : -1;
        const curTailKey = Array.isArray(curMsgs) ? historyTailKey(curMsgs) : null;
        if (getViewingInstanceId() === id && agents.get(id) === a && `${a.cwd}\x00${a.sessionId}` === key
            && takeOverGeneration === takeOverAtEntry // R2：接管已 dispose+resume 吸收过磁盘，旧观察不得重新标脏
            && rebaselineAbsorbedExternal({
              sameSession: true,
              curLen,
              baseline: catchUpState.baseline,
              localBusy, // 己方忙碌不算外部写入
              // 己方 turn【上一 tick】还在写盘：baseline 被下面 localBusy 分支冻结着、这一轮的增长是自己
              // 写的，只是尚未吸收。不传这一维，「发消息→锁屏→解锁」这条移动端主路就会把己方写入判成终端
              // 写入。刻意用 wasOwnTurn 而非 localBusy 口径的 wasBusy——等审批(permission)期间的增长可能
              // 真是终端写的，豁免它会漏标致分叉（2026-08-10，见 rebaselineAbsorbedExternal 注释）。
              wasOwnTurn: catchUpState.wasOwnTurn === true,
              prevTailKey: catchUpState.lastTailKey ?? null,
              curTailKey,
            })) {
          a.externalDirty = true; // 被 rebaseline 吸收的终端外部增长 → 标脏防分叉
        }
      }
      catchUpKey = null;                                               // 强制下方 switch 分支重建 baseline + 重评 mirror 入口锁
    }
    if (key !== catchUpKey) {                                           // 切了会话：以现有历史长度定基线，本 tick 不推
      let seedMsgs;
      try { seedMsgs = await getSessionHistory(a.sessionId, a.cwd, undefined, diskOpts); }
      catch { return; }
      const seedLen = seedMsgs.length;
      // SS-001：seed 时同步 lastTailKey，否则下一 tick 满窗会把「首次记指纹」当滑动误 reload
      // wasOwnTurn 与 wasBusy 分开记：前者只认己方 turn 在写盘（st==='busy'），供重连 rebaseline 判「这段
      // 增长是不是自己写的」；后者是 localBusy 口径（含 permission），供 catchUpStep 吸收己方写盘。见
      // rebaselineAbsorbedExternal 注释：审批窗里的增长可能真是终端写的，不能按 wasBusy 一并豁免。
      const seededState = { baseline: seedLen, wasBusy: localBusy, wasOwnTurn: st === 'busy', lastTailKey: historyTailKey(seedMsgs) };
      // 切入预判（2026-07-12 单驾驶员）：按尾部形态立即预锁——PENDING=有人正驱动（终端轮次未完结），
      // 堵「切走再切回、终端还在跑但要等下一条 text 落盘才锁」的空窗。旧「切入不预锁」是因为当时唯一
      // 判据 mtime 不可信（web resume 自身刷 mtime）；尾部形态是语义判据、可信。localBusy 豁免见 mirrorEntryLock。
      let tail = { verdict: 'settled', lastChainTs: null };
      let observedCli = { model: null, permissionMode: null };
      try { tail = await classifyTranscriptTail(a.sessionId, a.cwd, diskOpts); } catch { /* 读失败保守不锁 */ }
      try { observedCli = await readCliObservedState(a.sessionId, a.cwd, diskOpts); } catch { /* 读失败显未知 */ }
      observedCli = mergeCliObserved(observedCli, a.sessionId, a.cwd);
      // P1（7/26 CCD 调研吸收）：CLI 进程注册表权威自报，比尾部形态猜测强一档；读失败/无条目 fail-open null → 完全回落既有判定
      const entryRegistryEntry = await readSessionRegistry(a.sessionId, a.cwd, registryOpts).catch(() => null);
      const registryBusy = registryIndicatesTerminalBusy(entryRegistryEntry);
      if (getViewingInstanceId() !== id || agents.get(id) !== a || `${a.cwd}\x00${a.sessionId}` !== key
          || takeOverGeneration !== takeOverAtEntry) return; // R2：接管也是一种「世界已变」
                                          // await 让出后视图/实例/session 可能已变：旧观察结果与待提交基线全部作废，不提交
      catchUpKey = key;
      catchUpState = seededState;
      mirrorCliSeen = cliPresenceStep(false, entryRegistryEntry).seen; // 切入=负证据观察期重开：只记本次是否见到 cli，vanished 从此往后才可能成立
      mirrorLastSize = -1;                                 // 基线未建立：切入首个正常 tick 只记 size、不判增长
      // prevReadonly 只在同会话重连时给：真会话切换必须重新判定（不得把 A 的锁带到 B），
      // 重连则是同一会话的连续观察，上一刻锁着且形态仍 pending 就维持。
      const entryPrevReadonly = rebaselineSameSession && Boolean(mirrorRelease?.readonly);
      const entryLock = mirrorEntryLock({
        tailVerdict: tail.verdict,
        localBusy,
        lastChainTs: tail.lastChainTs,
        now: Date.now(),
        registryBusy,
        prevReadonly: entryPrevReadonly,
        // 谁写下这条 pending 尾部（磁盘自报）：sdk-ts=己方残留、不是终端驾驶 → 不预锁（见 mirrorEntryLock）
        tailEntrypoint: tail.lastChainEntrypoint,
      });
      // 注册表证实是活终端在驾驶 → 压制 autonomous 标记（marker 启发式的"同窗口先自主循环后真终端接管"盲区）
      const entryAutonomous = registryBusy ? false : tail.autonomous;
      mirrorRelease = { readonly: entryLock, quietTicks: 0 };
      diagLog.record(a.sessionId, 'mirror', 'entry_lock_decision', describeMirrorEntryLock({
        tailVerdict: tail.verdict, localBusy, lastChainTs: tail.lastChainTs, now: Date.now(), locked: entryLock, autonomous: entryAutonomous, registryBusy,
        prevReadonly: entryPrevReadonly, tailEntrypoint: tail.lastChainEntrypoint,
      }));
      setMirror(entryLock, a.sessionId, true,              // force 清上个会话残留的锁/发权威态
        // serverStartedAt：pending 尾部若落盘于本进程启动前 → 是被服务重启腰斩的残留，不是活驾驶员（见 mirrorStaleFlag）
        mirrorStaleFlag({ readonly: entryLock, tailPending: tail.verdict === 'pending', lastChainTs: tail.lastChainTs, now: Date.now(), registryBusy, serverStartedAt: serviceStartedAt }),
        observedCli, id, 'entry_lock', entryAutonomous);
      return;
    }
    if (localBusy) {                                                    // 己方在跑：抑制追平、免读大文件；释放态保持锁不变、不借己方忙碌攒静默
      const rel = mirrorReleaseStep(mirrorRelease, {
        externalWrite: false, localBusy: true, releaseTicks: mirrorReleaseTicksNeeded(),
      });
      // 仍须重算 stale：写死 false 会在 web 长期 busy（多子代理/bgTasks）时掩盖「主链已 5 分钟无写入」的疑似中断。
      // 追平仍抑制；只轻读 tail 形态（与正常路径同一 mirrorStaleFlag）。
      let busyTail = { verdict: 'settled', lastChainTs: null };
      let busySize = -1;
      let busyRegistryEntry = null;
      // permission 态下 web 侧不写盘，故并行取一次 size 作为「终端是否在写」的判据（见 externalGrowthWhilePaused）。
      // registryBusy 与切入/正常两个分支同口径：缺了它，注册表证明终端活着时这里仍可能把长编译误判成 stale。
      try {
        [busyTail, busySize, busyRegistryEntry] = await Promise.all([
          classifyTranscriptTail(a.sessionId, a.cwd, diskOpts).catch(() => ({ verdict: 'settled', lastChainTs: null })),
          sessionFileSize(a.sessionId, a.cwd, diskOpts).catch(() => -1),
          readSessionRegistry(a.sessionId, a.cwd, registryOpts).catch(() => null),
        ]);
      } catch { /* 读失败保守 settled：不误标 stale */ }
      const busyRegistryBusy = registryIndicatesTerminalBusy(busyRegistryEntry);
      if (getViewingInstanceId() !== id || agents.get(id) !== a || `${a.cwd}\x00${a.sessionId}` !== key
          || takeOverGeneration !== takeOverAtEntry) return; // R2：接管也是一种「世界已变」
                                          // await 让出后视图/实例/session 可能已变：待提交状态全部作废，不提交
      const busyCliPresence = cliPresenceStep(mirrorCliSeen, busyRegistryEntry);
      mirrorCliSeen = busyCliPresence.seen;
      // 等审批（可长达 APPROVAL_TTL_MS 30min）期间 web 不写盘 → 磁盘长大必是终端写的，必须标脏，
      // 否则下一条手机消息会送进停在 30 分钟前的 SDK 子进程、从旧 parentUuid 分叉出第二条链。
      if (externalGrowthWhilePaused({ state: st, prevSize: mirrorLastSize, curSize: busySize })) {
        a.externalDirty = true;
      }
      // wasOwnTurn 只在 st==='busy' 时置：permission（等审批）期间 web 侧未必不写盘（并行工具调用里免审批
      // 的那几个照跑照落盘），但更要紧的是那段增长也可能真来自终端——豁免它会让重连 rebaseline 漏标致分叉。
      catchUpState = { baseline: catchUpState.baseline, wasBusy: true, wasOwnTurn: st === 'busy', lastTailKey: catchUpState.lastTailKey ?? null };
      // busy（己方 turn 在写盘）作废 size 基线；permission（己方不写盘）维持基线，供下一 tick 判终端增长
      mirrorLastSize = st === 'permission' && busySize >= 0 ? busySize : -1;
      mirrorRelease = rel.state;
      setMirror(
        rel.readonly,
        a.sessionId,
        false,
        mirrorStaleFlag({
          readonly: rel.readonly,
          tailPending: busyTail.verdict === 'pending',
          lastChainTs: busyTail.lastChainTs,
          now: Date.now(),
          registryBusy: busyRegistryBusy,
          serverStartedAt: serviceStartedAt, // 与切入/正常分支同口径，否则文案在两态间闪烁
          cliRegistryVanished: busyCliPresence.vanished,
        }),
        undefined,
        id,
        'busy_tail',
      );
      return;
    }
    // 并行读：history / size / registry 互相独立；size 先取供 tail 读者共用，避免串行堆叠事件循环延迟
    let messages;
    let curSize;
    let tail;
    let observedCli;
    let registryEntry;
    let registryBusy;
    try {
      const sizeP = sessionFileSize(a.sessionId, a.cwd, diskOpts).catch(() => -1);
      const histP = getSessionHistory(a.sessionId, a.cwd, undefined, diskOpts);
      const regP = readSessionRegistry(a.sessionId, a.cwd, registryOpts).catch(() => null);
      curSize = await sizeP;
      const sizeOpt = { ...diskOpts, size: curSize >= 0 ? curSize : null };
      // 尾部形态（2026-07-12 单驾驶员核心判据）：轮次未完结(pending)期间维持锁——罩住「终端卡在一条几分钟的
      // 长工具上、磁盘零写入」窗（keepAlive 罩不住，原 12.5s 静默窗在此误判解锁、横幅熄灭="感觉没在跑"真实报障）。
      const tailP = classifyTranscriptTail(a.sessionId, a.cwd, sizeOpt).catch(() => ({ verdict: 'settled', lastChainTs: null }));
      const cliP = readCliObservedState(a.sessionId, a.cwd, sizeOpt).catch(() => ({ model: null, permissionMode: null }));
      messages = await histP;
      tail = await tailP;
      observedCli = mergeCliObserved(await cliP, a.sessionId, a.cwd);
      registryEntry = await regP;
      registryBusy = registryIndicatesTerminalBusy(registryEntry);
    } catch {
      return; // history 失败则整 tick 放弃（与旧 try/catch return 一致）
    }
    const { emit, state, reload } = catchUpStep(catchUpState, { messages, localBusy: false });
    if (getViewingInstanceId() !== id || agents.get(id) !== a || `${a.cwd}\x00${a.sessionId}` !== key
        || takeOverGeneration !== takeOverAtEntry) return;
                                                                      // await 让出后视图/实例/session/驾驶方可能已变：作废旧 tick，不提交 baseline/size/观察态
    catchUpState = state;                                              // 视图仍在才提交 baseline——移到切走判断之后，防切走瞬间污染 baseline 致那段外部写入在 catchUp 路径漏推
    const cliPresence = cliPresenceStep(mirrorCliSeen, registryEntry); // 负证据推进也在守卫后：切走瞬间的旧观察不得污染新会话的 seen 槽
    mirrorCliSeen = cliPresence.seen;
    // keep-alive：transcript 文件比上 tick 大 = 终端在写盘（含跑工具/思考的 tool_use/tool_result，被 text-only 过滤挡在 catchUpStep len 外）。
    // 仅基线已建立(lastSize≥0)时判增长；切入 / localBusy 后首 tick 只记 size 不判（避免把切入前既有体量或己方写盘误当终端活跃）。
    const keepAlive = mirrorLastSize >= 0 && curSize > mirrorLastSize;
    if (curSize >= 0) mirrorLastSize = curSize; // 读取瞬时失败(curSize=-1)不覆盖基线：保留上次好值，避免把「基线未建立」哨兵误写回、平白吃掉 1-2 个 tick 的 keep-alive 信号
    // SS-001：满窗滑动 → reload：全量推当前 history 窗口（替代不可 slice 的增量）+ 标 externalDirty。
    // 复用 history_append + replace:true（不新增契约事件类型），前端清屏后以 messages 重渲。
    if (reload) {
      metrics.inc('catch_up_reloads');
      a.externalDirty = true;
      io.to('approved').emit('agent:event', {
        seq: 0, epoch: 'server', sessionId: a.sessionId, instanceId: id, cwd: a.cwd, ts: Date.now(),
        type: 'history_append', payload: { messages, external: true, replace: true, reason: 'sliding_window' },
      });
    }
    const externalWrite = emit.length > 0 || reload;
    if (emit.length > 0) {                                               // 观察到外部写入 → 追平尾巴
      metrics.inc('catch_up_hits'); // NFR-15 补齐命中（catchUpTick 成功推了终端侧外部增量的次数）
      a.externalDirty = true; // 该实例的 SDK 子进程内存上下文已落后于磁盘（外部驱动方写了新轮次）——web 下次发送前须置换实例吸收，否则模型看不到这些轮次、语义分叉
      io.to('approved').emit('agent:event', { // SEC-01：会话内容，仅广播给已批准设备
        seq: 0, epoch: 'server', sessionId: a.sessionId, instanceId: id, cwd: a.cwd, ts: Date.now(),
        type: 'history_append', payload: { messages: emit, external: true }
      });
    }
    const tailPending = tail.verdict === 'pending';
    const rel = mirrorReleaseStep(mirrorRelease, {
      externalWrite, keepAlive, tailPending, localBusy: false, registryBusy,
      releaseTicks: mirrorReleaseTicksNeeded(),
    }); // 外部 text 写入/注册表自报 busy→锁；文件仍在长/轮次未完结→维持锁；真静默→累计、达阈值自动解锁
    mirrorRelease = rel.state;
    setMirror(rel.readonly, a.sessionId, false,                       // 锁/stale/CLI 观察值任一变化都广播
      // serverStartedAt 必须与切入分支同口径：只在切入传会让下一 tick 把「服务重启腰斩」的 stale 覆盖回「驾驶中」文案闪烁
      mirrorStaleFlag({ readonly: rel.readonly, tailPending, lastChainTs: tail.lastChainTs, now: Date.now(), registryBusy, serverStartedAt: serviceStartedAt, cliRegistryVanished: cliPresence.vanished }),
      observedCli, id, 'normal_tick', registryBusy ? false : tail.autonomous);
  }
  let catchUpInFlight = null;
  function catchUpTick() {
    if (catchUpInFlight) return catchUpInFlight; // interval + 手动 syncNow 单飞，防旧观察晚到覆盖新状态
    const t0 = Date.now();
    const diagKey = agents.get(getViewingInstanceId())?.sessionId ?? null; // Part C：仅供计时归档，不参与 catchUp 决策
    const running = catchUpTickOnce();
    const wrapped = running.finally(() => {
      diagLog.record(diagKey, 'catchup', 'tick', { ms: Date.now() - t0 });
      if (catchUpInFlight === wrapped) catchUpInFlight = null;
    });
    catchUpInFlight = wrapped;
    return wrapped;
  }
  // 动态追平调度：mirror 只读时 1s，常态 2.5s（墙钟解锁仍按 MIRROR_RELEASE_MS≈12.5s）
  let catchUpTimer = null;
  // stop() 是否已请求停机。没有这个闸时 stop() 拦不住「已在飞的 tick」——它的 .finally 收尾
  // （以及 tick 内 setMirror 换挡时）会无条件 rescheduleCatchUp()，把刚被清掉的定时器排回来，
  // 于是 shutdown 撞上在飞 tick 时引擎继续读盘 + io.emit，正是 app.js 调 stop() 想避免的噪音。
  let catchUpStopped = false;
  function rescheduleCatchUp() {
    if (catchUpTimer) clearTimeout(catchUpTimer);
    catchUpTimer = null;
    if (catchUpStopped) return;
    const ms = catchUpIntervalMs();
    catchUpTimer = setTimeout(() => {
      catchUpTick().catch(() => {}).finally(() => rescheduleCatchUp());
    }, ms);
    if (typeof catchUpTimer.unref === 'function') catchUpTimer.unref();
  }
  rescheduleCatchUp();
  return {
    // 定时器启停：app.js 在装配末尾调 start()，shutdown 调 stop()。
    start() { catchUpStopped = false; rescheduleCatchUp(); },
    stop() { catchUpStopped = true; if (catchUpTimer) { clearTimeout(catchUpTimer); catchUpTimer = null; } },
    // 主循环（定时器 / hooks 插队 / 前端 mirror:syncNow 三处驱动，内部单飞）
    catchUpTick,
    // 只读查询：statusline 路由与重连快照用
    mirrorOwnedBy,
    // 全局锁位裸读。接管判定（user:message）历史上读的就是这个全局 bool 而非归属判定，
    // 换成 mirrorOwnedBy 会改变行为——保持原样暴露。
    isReadonly() { return mirrorReadonly; },
    // 切视图 / 切工作区 / 新会话 / 回空首页
    clearMirrorOnViewChange,
    // 客户端(重)连：置位下一 tick 重定基线（BE-009）
    requestRebaseline() { catchUpRebaselineRequested = true; },
    // 前端显式接管后第一条消息成功入队：服务端切换驾驶方
    takeOver(sessionId) {
      takeOverGeneration += 1; // R2：作废所有在飞 tick 的观察（它们看到的是接管前的世界）
      mirrorRelease = { readonly: false, quietTicks: 0 };
      mirrorLastSize = -1;
      setMirror(false, sessionId, true, false, mirrorObservedCli, getViewingInstanceId(), 'user_takeover');
    },
    // 重连权威快照用的只读视图。注意 payload 形状与 setMirror 广播【有意不同】
    // （不含 quietTicks/remainingMs/cliSeen），是既有线上契约，勿统一。
    snapshot() {
      return { stale: mirrorStale, observedCli: mirrorObservedCli, autonomous: mirrorAutonomous };
    },
  };
}
