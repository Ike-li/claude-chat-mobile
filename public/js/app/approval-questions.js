import { isAnsweredQuestionId, formatPermInputDisplay } from '../logic.js';
import { verifyIntegrity } from '../canonicalize.js';
import { t } from '../i18n.js';

export function createInteractionQueueState(context, { answeredCapacity = 200 } = {}) {
  const permissionQueue = [];
  const questionQueue = [];
  const answeredQuestionIds = new Set();

  function markQuestionAnswered(requestId) {
    if (!requestId) return;
    answeredQuestionIds.add(requestId);
    while (answeredQuestionIds.size > answeredCapacity) {
      answeredQuestionIds.delete(answeredQuestionIds.values().next().value);
    }
  }

  function isQuestionAnswered(requestId) {
    return isAnsweredQuestionId(requestId, answeredQuestionIds);
  }

  const state = {
    permissionQueue,
    questionQueue,
    answeredQuestionIds,
    markQuestionAnswered,
    isQuestionAnswered,
  };
  context.state.interactions = state;
  return state;
}

// 审批 / 选择题两个弹窗的完整状态机：当前卡片、展开按钮、ExitPlanMode 档位、多选下标、
// 指纹不符集合、按钮武装计时器，连同两个弹窗自己的 DOM 引用，一并归本模块所有。
//
// 【为什么整体搬】此前这七个可变量散在 app.js 顶层作用域，而「清空当前审批与提问」这段
// 五行清理序列在 app.js 里被逐字抄了四遍（epoch 重置 / result / error / clearView），
// 任何一处漏抄一行就是弹窗关不掉或状态残留。收敛后外部只需四个动词，抄不出分叉。
//
// 调用方仍自行负责 alertCue / notify（提示音与推送是 app 的编排，不是弹窗的职责），
// 因此去重判定与入队拆成两个方法，保持「先响提示音、再弹窗」的既有顺序。
export function createApprovalController(context, {
  queues,
  $: byId,
  el = () => null,
  render = text => text,
  addBar = () => {},
  haptic = () => {},
  socket,
  permModal = null,
  questionModal = null,
  openSheet = () => {},
  closeSheet = () => {},
  requestInterrupt = () => {},
  updateSendButtonState = () => {},
  getViewingInstanceId = () => null,
} = {}) {
  const permTool = byId('permTool'), permCwd = byId('permCwd'), permInput = byId('permInput');
  const permAlways = byId('permAlways'), permIntegrityWarn = byId('permIntegrityWarn');
  const permExitModeWrap = byId('permExitModeWrap'), permInterrupt = byId('permInterrupt');
  const questionText = byId('questionText'), questionOptions = byId('questionOptions');
  const questionHeader = byId('questionHeader'), questionMultiHint = byId('questionMultiHint');
  const questionMultiSubmit = byId('questionMultiSubmit'), questionSkip = byId('questionSkip');
  const questionOtherToggle = byId('questionOtherToggle'), questionOtherPanel = byId('questionOtherPanel');
  const questionOtherInput = byId('questionOtherInput'), questionOtherSubmit = byId('questionOtherSubmit');

  const { permissionQueue: permQueue, questionQueue, markQuestionAnswered, isQuestionAnswered } = queues;

  let activePerm = null;
  let permExpandBtn = null;             // M1：展开按钮引用，showNextPerm 前清除
  let activeQuestion = null;
  let selectedExitMode = 'default';     // ExitPlanMode 退出后权限档（对齐 CLI plan-exit）；默认 default
  let multiSelectedIndexes = new Set(); // multiSelect 当前题勾选的下标
  let permArmTimer = null;

  // ---- 审批完整性预检（NFR-17，承接 docs/design.md 协议步骤4）----
  // 渲染前（严格说：渲染后异步补验，见下）重算指纹比对服务端锚定的 fp，防传输层篡改（op 被改而 fp
  // 未同步改）。不阻塞卡片显示——真正的执行门槛在后端 resolvePermission（agent.js），这里只是"谨慎
  // 确认"提示，即使因浏览器兼容性等原因未能核验也不影响审批本身仍受后端 fail-closed 保护。
  // 校验结果不符时记入本集合：请求排队时校验完成（还不是 activePerm）也不丢失判定，
  // showNextPerm() 晋升它为 activePerm 时据此补显示警示条（而不是要求它重新触发一次异步校验）。
  const permIntegrityMismatched = new Set();
  async function verifyPermIntegrity(p) {
    if (!p.fp) return; // 服务端理论上总带 fp；防御性跳过，不误判
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      // 非安全上下文（纯局域网 http:// 访问）：Web Crypto 不可用，前端预检优雅降级——
      // 后端完整性校验不受影响，仍是真正生效的门槛。
      console.warn('[integrity] crypto.subtle 不可用（非安全上下文），跳过前端预检');
      return;
    }
    let ok;
    try {
      ok = await verifyIntegrity(p.fp, { tool: p.name, args: p.input, cwd: p.cwd });
    } catch (e) {
      console.error('[integrity] 前端预检计算异常，不误判为篡改：', e.message);
      return;
    }
    if (!ok) {
      permIntegrityMismatched.add(p.requestId);
      if (activePerm?.requestId === p.requestId) showPermIntegrityWarning();
    }
  }
  function showPermIntegrityWarning() {
    if (permIntegrityWarn) permIntegrityWarn.classList.remove('hidden');
  }

  // ---- 审批弹窗（4a：完整命令 + cwd）----
  function showNextPerm() {
    if (activePerm || permQueue.length === 0) return;
    activePerm = permQueue.shift();
    permTool.textContent = activePerm.name;
    permCwd.textContent = `${t('工作目录：')}${activePerm.cwd}`;
    // 每张新卡片先重置警示条（上一张若显示过不应带到这张）；若这条请求排队期间已判定过指纹不符
    // （permIntegrityMismatched），直接补显示——不会再触发一次新的异步校验。
    if (permIntegrityWarn) permIntegrityWarn.classList.add('hidden');
    if (permIntegrityMismatched.has(activePerm.requestId)) showPermIntegrityWarning();
    // UX-001：ExitPlanMode 计划用 renderMarkdown（DOMPurify）；普通命令去 JSON 引号、mono 纯文本。
    // M1：超 4000 字显示展开按钮，而非截断（防恶意内容藏尾部）
    permExpandBtn?.remove(); permExpandBtn = null;
    const display = formatPermInputDisplay(activePerm.name, activePerm.input);
    const full = display.text || '';
    const applyPermInput = (text) => {
      if (display.mode === 'markdown') {
        permInput.classList.remove('font-mono', 'whitespace-pre-wrap');
        permInput.classList.add('msg-body', 'perm-input-md');
        permInput.innerHTML = render(text);
      } else {
        permInput.classList.remove('msg-body', 'perm-input-md');
        permInput.classList.add('font-mono', 'whitespace-pre-wrap');
        permInput.textContent = text;
      }
    };
    if (full.length > 4000) {
      applyPermInput(full.slice(0, 4000));
      permExpandBtn = el(`<button class="text-xs text-accent mt-1 block">${t('…显示全部')} (${full.length} ${t('字符')})</button>`);
      permExpandBtn.onclick = () => { applyPermInput(full); permExpandBtn.remove(); permExpandBtn = null; };
      permInput.after(permExpandBtn);
    } else {
      applyPermInput(full);
    }
    permAlways.checked = false;
    // ExitPlanMode：展示退出后权限档选择（对齐 CLI plan-exit）；其它工具隐藏
    selectedExitMode = 'default';
    if (permExitModeWrap) {
      const isExit = activePerm.name === 'ExitPlanMode';
      permExitModeWrap.classList.toggle('hidden', !isExit);
      if (isExit) paintExitModeChips();
    }
    openSheet(permModal);
    // UX-003：弹出后 350ms 内按钮不可点，防拇指热区误触授权
    armPermSheetButtons(350);
    updateSendButtonState();
  }
  function paintExitModeChips() {
    if (!permExitModeWrap) return;
    permExitModeWrap.querySelectorAll('.perm-exit-mode').forEach(btn => {
      const on = btn.getAttribute('data-exit-mode') === selectedExitMode;
      btn.classList.toggle('border-accent', on);
      btn.classList.toggle('bg-accent-wash', on);
      btn.classList.toggle('text-ink', on);
      btn.classList.toggle('border-line', !on);
      btn.classList.toggle('text-ink-soft', !on);
    });
  }
  function armPermSheetButtons(ms = 350) {
    if (!permModal) return;
    permModal.classList.add('sheet-arming');
    if (permArmTimer) clearTimeout(permArmTimer);
    permArmTimer = setTimeout(() => {
      permModal.classList.remove('sheet-arming');
      permArmTimer = null;
    }, ms);
  }
  function answerPerm(decision) {
    if (!activePerm) return;
    if (!socket.connected) { // 断线瞬间点审批：emit 大概率送不达，不能乐观显示"已处理"却让请求悬空未决
      addBar(t('网络未连接，请等待重新连接后再操作'), 'text-danger');
      return;
    }
    const wasExitPlanMode = activePerm.name === 'ExitPlanMode'; // 下方 activePerm 即置 null，提前捕获
    const payload = {
      requestId: activePerm.requestId,
      decision,
      alwaysThisSession: permAlways.checked,
      instanceId: getViewingInstanceId(), // 台阶3：路由到当前查看 tab 实例（切过去后审批的本就是该实例）
      // op：回传本卡片渲染时所见的确切操作（承接 docs/design.md NFR-17 审批完整性绑定协议步骤5）——
      // 服务端用它重算指纹比对 canUseTool 时锚定的 fp，不一致 fail-closed 拒绝（agent.js#resolvePermission）。
      op: { tool: activePerm.name, args: activePerm.input, cwd: activePerm.cwd }
    };
    // 仅 ExitPlanMode 批准时带 exitMode；拒绝/其它工具不传
    if (wasExitPlanMode && decision === 'allow') payload.exitMode = selectedExitMode || 'default';
    socket.emit('user:approve', payload);
    const exitNote = (wasExitPlanMode && decision === 'allow') ? ` → ${payload.exitMode}` : '';
    addBar(`${decision === 'allow' ? t('✅ 已允许：') : t('🚫 已拒绝：')}${activePerm.name}${exitNote}`, 'text-ink-faint');
    permIntegrityMismatched.delete(activePerm.requestId);
    activePerm = null;
    permExpandBtn?.remove(); permExpandBtn = null;
    closeSheet(permModal);
    showNextPerm();
    updateSendButtonState();
  }
  byId('permAllow').onclick = () => answerPerm('allow');
  byId('permDeny').onclick = () => answerPerm('deny');
  // ExitPlanMode 档位 chip 点选
  if (permExitModeWrap) {
    permExitModeWrap.querySelectorAll('.perm-exit-mode').forEach(btn => {
      btn.onclick = () => {
        selectedExitMode = btn.getAttribute('data-exit-mode') || 'default';
        paintExitModeChips();
      };
    });
  }

  // ---- 选择题弹窗（E7：AskUserQuestion）----
  function resetQuestionOtherUI() {
    if (questionOtherPanel) questionOtherPanel.classList.add('hidden');
    if (questionOtherInput) questionOtherInput.value = '';
  }
  function optionLabel(opt) {
    if (opt == null) return '';
    if (typeof opt === 'string') return opt;
    return opt.label || '';
  }
  function paintMultiOption(btn, selected) {
    btn.classList.toggle('border-accent', selected);
    btn.classList.toggle('bg-accent-wash', selected);
    btn.classList.toggle('border-line', !selected);
    btn.classList.toggle('bg-sunk', !selected);
  }
  function showNextQuestion() {
    if (activeQuestion || questionQueue.length === 0) return;
    activeQuestion = questionQueue.shift();
    multiSelectedIndexes = new Set();
    const multi = Boolean(activeQuestion.multiSelect);
    if (questionHeader) {
      const h = activeQuestion.header ? String(activeQuestion.header) : '';
      questionHeader.textContent = h;
      questionHeader.classList.toggle('hidden', !h);
    }
    questionText.textContent = activeQuestion.text;
    if (questionMultiHint) questionMultiHint.classList.toggle('hidden', !multi);
    if (questionMultiSubmit) {
      questionMultiSubmit.classList.toggle('hidden', !multi);
      questionMultiSubmit.disabled = true;
      questionMultiSubmit.textContent = t('确认选择');
    }
    questionOptions.innerHTML = '';
    resetQuestionOtherUI();
    (activeQuestion.options || []).forEach((opt, i) => {
      const wrap = el(`<div class="rounded-lg border border-line bg-sunk overflow-hidden"></div>`);
      const btn = el(`<button type="button" class="w-full py-2.5 px-3 text-ink text-sm text-left"></button>`);
      const label = optionLabel(opt);
      btn.textContent = multi ? `☐ ${label}` : label;
      if (opt && typeof opt === 'object' && opt.description) {
        const desc = el(`<div class="px-3 pb-2 text-[11px] text-ink-faint leading-snug"></div>`);
        desc.textContent = opt.description;
        wrap.appendChild(btn);
        wrap.appendChild(desc);
      } else {
        wrap.appendChild(btn);
      }
      if (opt && typeof opt === 'object' && opt.preview) {
        const prevBtn = el(`<button type="button" class="w-full text-left px-3 pb-2 text-[11px] text-info underline">${t('查看预览')}</button>`);
        const prevBox = el(`<pre class="hidden mx-3 mb-2 p-2 rounded bg-canvas border border-line-soft text-[11px] whitespace-pre-wrap break-words text-ink-soft max-h-40 overflow-y-auto"></pre>`);
        prevBox.textContent = String(opt.preview);
        prevBtn.onclick = (e) => {
          e.stopPropagation();
          prevBox.classList.toggle('hidden');
          prevBtn.textContent = prevBox.classList.contains('hidden') ? t('查看预览') : t('收起预览');
        };
        wrap.appendChild(prevBtn);
        wrap.appendChild(prevBox);
      }
      if (multi) {
        btn.onclick = () => {
          if (multiSelectedIndexes.has(i)) multiSelectedIndexes.delete(i);
          else multiSelectedIndexes.add(i);
          const on = multiSelectedIndexes.has(i);
          btn.textContent = `${on ? '☑' : '☐'} ${label}`;
          paintMultiOption(wrap, on);
          if (questionMultiSubmit) {
            questionMultiSubmit.disabled = multiSelectedIndexes.size === 0;
            questionMultiSubmit.textContent = multiSelectedIndexes.size
              ? `${t('确认选择')} (${multiSelectedIndexes.size})`
              : t('确认选择');
          }
        };
      } else {
        btn.onclick = () => answerQuestion(i);
      }
      questionOptions.appendChild(wrap);
    });
    openSheet(questionModal);
    updateSendButtonState();
  }
  function finishQuestionUI(barText) {
    activeQuestion = null;
    multiSelectedIndexes = new Set();
    closeSheet(questionModal);
    resetQuestionOtherUI();
    showNextQuestion();
    if (barText) addBar(barText, 'text-ink-faint');
    updateSendButtonState();
  }
  function answerQuestion(index) {
    if (!activeQuestion) return;
    if (!socket.connected) { addBar(t('网络未连接，请等待重新连接后再操作'), 'text-danger'); return; } // 断线瞬间选择：emit 大概率送不达，不能乐观标记已答
    // 先标记已答再 emit/关窗：紧接的切会话/sync 即使抢在 server resolve 前到达，也不会重弹
    markQuestionAnswered(activeQuestion.requestId);
    socket.emit('user:answer', { requestId: activeQuestion.requestId, optionIndex: index, instanceId: getViewingInstanceId() }); // 台阶3 路由
    const label = optionLabel(activeQuestion.options[index]);
    finishQuestionUI(`${t('已选择：')}${label}`);
  }
  function answerQuestionMulti() {
    if (!activeQuestion || !multiSelectedIndexes.size) {
      addBar(t('请至少选择一项'), 'text-info');
      return;
    }
    if (!socket.connected) { addBar(t('网络未连接，请等待重新连接后再操作'), 'text-danger'); return; }
    const indexes = [...multiSelectedIndexes].sort((a, b) => a - b);
    markQuestionAnswered(activeQuestion.requestId);
    socket.emit('user:answer', { requestId: activeQuestion.requestId, optionIndexes: indexes, instanceId: getViewingInstanceId() });
    const labels = indexes.map(i => optionLabel(activeQuestion.options[i])).filter(Boolean);
    finishQuestionUI(`${t('已选择：')}${labels.join(t('、'))}`);
  }
  function answerQuestionOther() {
    if (!activeQuestion) return;
    const freeText = (questionOtherInput?.value || '').trim();
    if (!freeText) {
      addBar(t('请先输入其他答案'), 'text-info');
      questionOtherInput?.focus();
      return;
    }
    if (!socket.connected) { addBar(t('网络未连接，请等待重新连接后再操作'), 'text-danger'); return; }
    markQuestionAnswered(activeQuestion.requestId);
    socket.emit('user:answer', { requestId: activeQuestion.requestId, freeText, instanceId: getViewingInstanceId() });
    finishQuestionUI(`${t('已回答（其他）：')}${freeText}`);
  }
  if (questionMultiSubmit) questionMultiSubmit.onclick = () => answerQuestionMulti();
  if (questionOtherToggle) {
    questionOtherToggle.onclick = () => {
      if (!questionOtherPanel) return;
      questionOtherPanel.classList.toggle('hidden');
      if (!questionOtherPanel.classList.contains('hidden')) questionOtherInput?.focus();
    };
  }
  if (questionOtherSubmit) questionOtherSubmit.onclick = () => answerQuestionOther();
  if (questionOtherInput) {
    questionOtherInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); answerQuestionOther(); }
    });
  }
  // 跳过/中止：复用 user:interrupt。后端 handleQuestion 已监听 abort → deny「问题已取消」；
  // 弹窗内必须自带此入口——遮罩盖住输入区「停止」时否则无路可走。
  // 不在本地乐观关窗：等 request_resolved(aborted) / result 走既有清理，避免多设备/重放分叉。
  if (questionSkip) {
    questionSkip.onclick = () => {
      if (!activeQuestion) return;
      haptic('tap');
      addBar(t('已跳过提问（中止本轮）'), 'text-ink-faint');
      requestInterrupt();
    };
  }
  // 权限弹窗内「中止本轮」：对齐 CLI Esc，遮罩盖住输入区停止键时仍可中止
  if (permInterrupt) {
    permInterrupt.onclick = () => {
      if (!activePerm) return;
      haptic('tap');
      addBar(t('已请求中止本轮'), 'text-ink-faint');
      requestInterrupt();
    };
  }

  // ---- 对外接口 ----
  function dropActivePerm() {
    if (!activePerm) return;
    activePerm = null;
    closeSheet(permModal);
    permExpandBtn?.remove(); permExpandBtn = null;
  }
  function dropActiveQuestion() {
    if (!activeQuestion) return;
    activeQuestion = null;
    closeSheet(questionModal);
  }

  const controller = {
    // 幂等去重：sync:since 切入补发的 pending 快照可能与 buffer 回放的原始事件同 requestId。
    isDuplicatePermission(requestId) {
      return activePerm?.requestId === requestId || permQueue.some(r => r.requestId === requestId);
    },
    // 问题侧多一道：已本地作答/已收 request_resolved 的忽略重放（切会话、probe、整页刷新后的 sync）。
    isDuplicateQuestion(requestId) {
      if (activeQuestion?.requestId === requestId || questionQueue.some(q => q.requestId === requestId)) return true;
      return isQuestionAnswered(requestId);
    },
    enqueuePermission(p) { permQueue.push(p); showNextPerm(); },
    enqueueQuestion(p) { questionQueue.push(p); showNextQuestion(); },
    verifyPermIntegrity,
    // M4：审批完成后广播（多设备或重放缓冲），关闭陈旧弹窗并晋升下一张。
    resolvePermission(requestId) {
      if (activePerm?.requestId === requestId) {
        dropActivePerm();
      } else {
        const idx = permQueue.findIndex(r => r.requestId === requestId);
        if (idx !== -1) permQueue.splice(idx, 1);
      }
      permIntegrityMismatched.delete(requestId);
      showNextPerm();
    },
    // question requestId 格式 '${toolUseID}#i'；单题 resolved 用 '#i'，整组终态用 toolUseID。
    resolveQuestion(requestId) {
      const matchQ = qId => qId === requestId || qId.startsWith(requestId + '#');
      markQuestionAnswered(requestId); // 整组 toolUseID 也入库 → isAnsweredQuestionId 覆盖所有 #i
      if (activeQuestion && matchQ(activeQuestion.requestId)) {
        markQuestionAnswered(activeQuestion.requestId);
        dropActiveQuestion();
      } else {
        // 可能一次终态清掉队列里同 tool 的多题
        for (let i = questionQueue.length - 1; i >= 0; i--) {
          if (matchQ(questionQueue[i].requestId)) {
            markQuestionAnswered(questionQueue[i].requestId);
            questionQueue.splice(i, 1);
          }
        }
      }
      showNextQuestion();
    },
    // 清空两条队列与当前卡片。epoch 重置 / result / error / 切会话四处共用同一份实现——
    // 此前是四份逐字复制，漏抄一行就是弹窗关不掉。
    clearAll() {
      permQueue.length = 0;
      dropActivePerm();
      questionQueue.length = 0;
      dropActiveQuestion();
      // 指纹不符集合也归零：requestId 在 toolUseID 缺失时回落成 `perm_${++permSeq}`，而 permSeq 是
      // AgentSession 的实例字段、构造期归零（src/agent/agent.js）——dispose+resume / 切会话都会造出
      // 新实例、重新从 perm_1 发号。而本 Set 活在页面生命周期里，不清就会让一次真实的指纹不符
      // 之后、后面同号的【正常】审批卡被误挂"内容可能被篡改"。
      permIntegrityMismatched.clear();
    },
    // 通用 sheet 关闭路径（背板/手势关窗）复用：清掉防误触 arming 计时器，避免下次打开残留。
    cancelPermArming() {
      if (permArmTimer) { clearTimeout(permArmTimer); permArmTimer = null; }
    },
    // 输入区是否该被"先处理当前审批/选择"挡住。
    hasPending() { return Boolean(activePerm || activeQuestion); },
  };
  context.state.approvals = controller;
  return controller;
}
