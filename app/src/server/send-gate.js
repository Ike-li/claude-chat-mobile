// send-gate.js —— 发送闸：消息交给 SDK 之前的判定与投递（工厂 + 全注入，同 auto-continue）。
//
// 【拆成两半】prepare 只判不发，deliver 只发不判。user:message 依次调用两者；判定结果「在途轮」要单独分支的
// 调用方（排队）可以在两者之间插入自己的逻辑。路由、懒开、校验、去重快路径属于「消息要去哪、合不合法」，
// 留在 user:message 里，这里只回答「此刻能不能往这个实例写」。
//
// 【viewingInstanceId 等模块级状态不搬】它们属于 app.js（N1-VIEWING-INSTANCE），这里经回调读写。
//
// 【无人值守模式】server 替不在跟前的用户发消息时（排队释放）过的也是这道闸，但比交互路径严，差异只有两处：
//   1. 交互路径不查驾驶员：SESSION-01 的硬拦截在前端，人点发送就算显式接管。没有人点的时候这个前提不成立，
//      所以多一道注册表和镜像锁检查。注册表在这里是否定证据，读不全就不发（unverified）。
//   2. externalDirty 不置换：置换是替用户接管终端写过的会话，还可能杀掉后台任务，用户不在跟前时不做。
// 判定不过一律不发，由调用方转成用户看得见的状态。无人值守调用方只看 code：没有客户端在等回执。
import { locationError, transcriptCwdOf } from '../sessions/session-location.js';
import { awaitResumeDivergence, gateResumeDivergence } from '../sessions/resume-anchor.js';
import { sessionHasOtherDriver } from '../sessions/session-registry.js';
import { buildPromptText, toEventMeta } from '../files/uploads.js';
import { externalDirtyBusyNack, shouldClaimViewingAfterSwap } from './instance-routing.js';

export function createSendGate({
  recoverLocation,
  disposeForSwap,
  resume,
  effortOf,
  effortSourceOf,
  getViewingInstanceId,
  claimViewing,
  reselectViewingAfter,
  broadcastInstances,
  listTerminalStates,
  mirrorEngine,
  saveAttachments,
  commitProcessed,
  onManualSend,
  noteLiveTerminalOnTakeover,
  takeWritesLost,
  interactionLog,
  diagLog,
}) {
  // 规则 5 置换：dispose 旧实例 + resume 冷读磁盘。调用方已确认实例空闲。
  async function swapInstance(a, onResuming) {
    const cwd = transcriptCwdOf(a), sid = a.sessionId;
    const mode = a.externalObserved?.permissionMode ?? a.permissionMode;
    const eff = effortOf(a.instanceId), effSource = effortSourceOf(a.instanceId);
    const disposedId = a.instanceId;
    interactionLog.addSessionLog(sid, 'sys_info', '[SYS] 会话曾被外部（终端）驱动，发送前置换实例吸收外部轮次（防陈旧上下文分叉）');
    // 体感：置换会冷启动 resume，前端先收到 system 条再等 init，避免「点了没反应」
    onResuming?.({ sessionId: sid, instanceId: disposedId });
    // SS-NEW-001 / SRV-NEW-002：silent dispose——不 reselect 到 remaining[0]、不 clearMirror、不中间 broadcast；
    // viewing 保持死指针，await 后按 shouldClaimViewingAfterSwap 决定是否原子接管（用户切走则不抢）。
    disposeForSwap(disposedId);
    // SRV-003：走 dedupedResume 而非裸 openInstance，并发 swap 收敛到同一 resume Promise。
    // R1（2026-08-06）：与 setEffort 同款收口——silent dispose 后 viewing 是死指针，await 抛错
    // 会被 socket.js 兜底 catch 接走，下面的 claim/reselect/broadcast 全不执行、死指针永久留存。
    let next;
    try {
      next = await resume(cwd, sid, { mode, effort: eff, effortSource: effSource, authorizedRoot: a.authorizedRoot });
    } catch (err) {
      if (getViewingInstanceId() === disposedId) reselectViewingAfter(cwd);
      broadcastInstances();
      throw err;
    }
    if (shouldClaimViewingAfterSwap({ disposedId, viewingNow: getViewingInstanceId() })) {
      claimViewing(next);
    } else if (getViewingInstanceId() === disposedId) {
      // 安全网：理论上 silent 后 viewing 应仍是 disposedId 或用户已改；若仍死指针却未 claim，落 reselect
      reselectViewingAfter(cwd);
    }
    broadcastInstances();
    return next;
  }

  // 无人值守时才查：有没有别的驾驶员。返回拦截原因，放行返回 null。
  async function otherDriverCode(a) {
    const states = await listTerminalStates();
    if (!states) return 'unverified';
    if (sessionHasOtherDriver(states, a.sessionId)) return 'other_driver';
    if (getViewingInstanceId() === a.instanceId && mirrorEngine.isReadonly()) return 'other_driver';
    return null;
  }

  /**
   * 判定这条消息此刻能不能写进实例。不发送、不 commit 去重 ID。
   * @param {{unattended?:boolean, ackDivergence?:string, onResuming?:Function}} [options]
   * @returns {Promise<{ok:true, instance:object} | {ok:false, code:string, instance:object, ack?:object}>}
   *   instance 是判定后的实例（置换后是新实例），ack 是给客户端的负回执。
   *   code：location | external_dirty_busy | diverged | turn_running，无人值守另有 other_driver | unverified。
   */
  async function prepare(instance, { unattended = false, ackDivergence, onResuming } = {}) {
    let a = instance;
    if (unattended) {
      const code = await otherDriverCode(a);
      if (code) return { ok: false, code, instance: a };
    }
    if (a.sessionId) {
      const location = await recoverLocation(a);
      // 只有 stale（读盘期间实例变了）值得重发；多份记录 / 越界 / 不存在重发必再失败，客户端须停止重试
      if (location.status !== 'found') {
        return { ok: false, code: 'location', instance: a, ack: { ok: false, error: locationError(location), permanent: location.status !== 'stale' } };
      }
    }
    // 陈旧上下文守卫（2026-07-12 单驾驶员，修「接管后的语义分叉」）：实例的 SDK 子进程上下文是进程内存态、
    // 只在启动(resume)那一刻读过磁盘；外部驱动方（终端 CLI）此后写的轮次，web 靠追平【显示】了、但子进程
    // 【内存里没有】——直接发送=模型看不到那些轮次、还从旧位置分叉出第二条 parentUuid 链。externalDirty 由
    // catchUpTick 观察到外部 text 写入时标记（其 localBusy 吸收逻辑已排除己方写入），此处先置换实例
    // （dispose+resume 冷读最新磁盘，同 effort 切档模式）再发送。
    // 已知边界：catchUpTick 只盯当前查看会话——后台 tab 被外部写过、切入后首个 tick(≤2.5s)前极速发送不经
    // 此守卫（切入流程本身 1-2s，实际难触发）；接受，不为此每次发送读盘比对。
    if (a.externalDirty && a.sessionId) {
      if (unattended) return { ok: false, code: 'other_driver', instance: a };
      // SRV-003：忙碌中禁止置换（会 kill 在途 canUseTool / turn）；可重试 ack，客户端保留 pending。
      // 文案区分「吸收终端写入」与具体忙因（turn / 审批 / 后台任务），避免 UI 已「完成」仍见笼统「会话正在处理」。
      if (a.isBusy()) {
        const nack = externalDirtyBusyNack({
          pendingTurns: a.pendingTurns,
          bgTaskCount: a.bgTasks?.size ?? 0,
          pendingPermissionCount: a.pendingPermissions?.size ?? 0,
          pendingQuestionCount: a.pendingQuestions?.size ?? 0,
          pendingElicitationCount: a.pendingElicitations?.size ?? 0,
        });
        interactionLog.addSessionLog(
          a.sessionId,
          'sys_info',
          `[SYS] externalDirty 置换被拒（${nack.reason}）：${nack.detail}`,
        );
        return {
          ok: false, code: 'external_dirty_busy', instance: a,
          ack: { ok: false, error: nack.error, busy: nack.busy === true, retryable: nack.retryable, reason: nack.reason },
        };
      }
      a = await swapInstance(a, onResuming);
    }
    // 续接分叉守卫（SESSION-04，2026-10-16）：这个实例 resume 时算出 CLI 会接上的链不含最新那段对话
    //（开着的旧终端在旧叶子下写过行、又比手机侧晚重贴 last-prompt）。静默发出去，模型就从那一支接上、忘了
    // 最新那段，回显却照样把它画出来。先拒收，由用户在面板上选「从最新那条分叉」或「仍然发送」。
    // 不 commit 去重 ID：同一 clientMessageId 带上确认重发要能成功。
    if (!(await awaitResumeDivergence(a))) {
      interactionLog.addSessionLog(a.logKey(), 'sys_info', '[SYS] 续接分叉：判定超时未落定，按读不动放行');
    }
    const divergenceGate = gateResumeDivergence(a.resumeDivergence, ackDivergence);
    if (divergenceGate.action === 'reject') {
      interactionLog.addSessionLog(a.logKey(), 'sys_info', '[SYS] 续接分叉：发送前拒收，等用户选择分叉或仍然发送');
      return { ok: false, code: 'diverged', instance: a, ack: divergenceGate.ack };
    }
    if (divergenceGate.clear) a.resumeDivergence = null;
    // 在途轮拒收（排队已移除 2026-07-30）：判据只认在途轮，不用 isBusy()——后台任务挂着仍可发送。
    // 放在 send() 之前而非依赖其返回值，是为了让拒绝理由精确：send() 返回 false 还covers disposed
    // 与窄竞态，那些是可重试的，而"任务运行中"要的是【不】自动重试（否则等于把排队搬到客户端）。
    // 不 commit 去重 ID、不记 userMessageIn：同一 clientMessageId 稍后重发必须还能成功。
    if (a.pendingTurns > 0) {
      return { ok: false, code: 'turn_running', instance: a, ack: { ok: false, error: '当前任务运行中，请等待完成后再发送', busy: true, retryable: false } };
    }
    return { ok: true, instance: a };
  }

  /**
   * 把消息交给实例。只发不判，调用方必须先过 prepare。
   * @param {{text:string, model?:string, attachments?:Array, clientMessageId?:string, startedAt?:number, shouldSend?:Function}} message
   *   shouldSend 传给 a.send，在入队那一刻判断还要不要发：落盘和切模型都要等，这期间用户可能取消。
   * @returns {Promise<{ok:true, ack:object} | {ok:false, reason:string, notice?:string, ack:object}>}
   *   notice 是给发送方的一句提示；reason 给无人值守调用方判去向。
   */
  async function deliver(a, { text, model, attachments, clientMessageId, startedAt = Date.now(), shouldSend }) {
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    const cancellable = shouldSend ? { shouldSend } : {};
    // FRESH 首轮 sessionId 可能仍 null：走 agent.logKey()（provisionalKey）与 agent 内 userMessageOut/agentSend 对齐
    interactionLog.userMessageIn(a.logKey(), text, model || a.activeModel || a.reportedModel || a.defaultModel, a.effort || 'model-default', a.permissionMode || 'default'); // 交互日志：client → server；model/effort/perm 走 chip 字段
    let sent;
    try {
      if (hasAttachments) {
        // 落盘 <cwd>/.ccm-uploads/ → 绝对路径注入 prompt → 送 SDK（claude 用 Read 读，白名单内免审批）；
        // 气泡走 displayText（原文，不含路径）+ 去完整 data 的元数据（含小 thumb，进缓冲供回放）
        // SRV-004：saveAttachments 抛错必须结构化 ack（permanent 磁盘类），避免离线队列永久重试。
        const saved = await saveAttachments(a.cwd, attachments);
        sent = await a.send(buildPromptText(text, saved), model, {
          displayText: text,
          attachments: toEventMeta(saved),
          clientMessageId, // FE-002：离线乐观气泡对账
          ...cancellable,
        });
      } else {
        // F1：send 改 async（setModel 需 await）；clientMessageId 供前端对账
        sent = await a.send(text, model, { clientMessageId, ...cancellable });
      }
    } catch (err) {
      // SRV-004：附件落盘失败 / 其它同步抛错 → 负 ACK；附件失败多半 permanent（权限/symlink/满盘）
      const msg = err?.message || String(err);
      const permanent = hasAttachments; // 附件校验已过、落盘仍失败 → 重试通常无意义
      return {
        ok: false,
        reason: hasAttachments ? 'attachment_failed' : 'send_failed',
        notice: hasAttachments ? `附件保存失败：${msg}` : `发送失败：${msg}`,
        ack: { ok: false, error: msg, permanent, retryable: !permanent },
      };
    }
    // BE-002：send 返回 false = 实例已弃用，或上面那道在途轮闸到 send 之间的窄竞态（setModel await
    // 让出点里另一条抢先开了轮）——都是可重试的临时失败，消息【未】入队。
    // 必须回传 ok:false + retryable 让客户端保留 pending、稍后重连重试，且【不能】commit 去重 ID——
    // 否则下次重发命中去重被假成功丢弃。旧代码无条件 ack{ok:true} 且忽略 send 返回值是「假成功丢消息」根因。
    if (!sent) {
      return { ok: false, reason: 'send_failed', ack: { ok: false, error: '发送失败，请重试', retryable: true } };
    }
    // 只在消息真正成功入队后才登记去重 ID（此后同 ID 重发才判 duplicate、幂等）。
    // 【必须排在下面所有副作用之前】send 已 resolve = 消息确实进了 SDK 队列，从这一刻起它就是
    // 「已处理」。排在 diagLog / takeOver 之后的话，那两步任一抛异常都会走 finally 释放 in-flight
    // 而去重 ID 未登记 → 客户端收负 ack 重发 → isProcessed 与 isInFlight 双双为假 → handler 整条
    // 重跑并二次 a.send()，同一条 prompt 投给 Claude 两次。加 try/finally 之前那条陈旧的 in-flight
    // 占用反而会挡住重试（卡到重启，但至多一次），即修 F1 时把「卡死」换成了「可能重复投递」。
    // 顺序不变量由 tests/invariants/message-dedup.test.mjs 的源码级断言钉住（2026-08-04 code review）。
    commitProcessed(clientMessageId, a);
    // 用户自己接着发了：这个会话的「到点自动继续」作废（人已经接手，到点再代发就是插队的第二条）
    onManualSend(a.sessionId);
    noteLiveTerminalOnTakeover(a);
    // 上一个 CLI 退出时报的磁盘写丢，放到这里才说：视图已绑定，且正是用户要接着用这段上下文的时候。
    // 不能在创建实例时发：notice 进环形缓冲后 replayed > 0，无 DOM 缓存的入场走 'reload'，缓冲被整批丢掉。
    const writesLost = takeWritesLost(a.sessionId);
    if (writesLost) a.emitNotice(writesLost, 'warning');
    diagLog.record(a.logKey(), 'message', 'enqueued', { ms: Date.now() - startedAt, hasAttachments }); // Part C
    if (getViewingInstanceId() === a.instanceId && mirrorEngine.isReadonly()) {
      // 前端显式接管后第一条消息已成功入 Web SDK 队列：服务端此刻也切换驾驶方，避免 statusline 继续
      // 被旧 mirrorReadonly 锁在 CLI 来源。失败入队不清锁，仍保持终端权威。
      mirrorEngine.takeOver(a.sessionId);
    }
    // 入队即在跑：立即广播 turnRunning=true，多端禁发送按钮无延迟（本端已乐观置位，这条管其它端）。
    broadcastInstances();
    return { ok: true, ack: { ok: true, instanceId: a.instanceId } };
  }

  return { prepare, deliver };
}
