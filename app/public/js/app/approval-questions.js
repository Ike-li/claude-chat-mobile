import { isAnsweredQuestionId } from '../logic/composer.js';
import { formatPermInputDisplay } from '../logic/tool-cards.js';
import { describePersistScope, describeChromePermission } from '../logic/permissions.js';
import { questionGroupKey, isGroupedQuestion, questionDraftLabel, buildQuestionGroupAnswers } from '../logic/questions.js';
import { verifyIntegrity } from '../canonicalize.js';
import { t } from '../i18n.js';

// 审批卡弹出后按钮不响应的时长（UX-003 / 验收 O70）。
const PERM_ARM_MS = 600;

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
  const permTitle = byId('permTitle'), permTool = byId('permTool'), permCwd = byId('permCwd'), permInput = byId('permInput');
  const permAlways = byId('permAlways'), permAlwaysLabel = byId('permAlwaysLabel'), permIntegrityWarn = byId('permIntegrityWarn');
  const permPersistWrap = byId('permPersistWrap'), permPersistLabel = byId('permPersistLabel'), permPersistHint = byId('permPersistHint');
  const permExitModeWrap = byId('permExitModeWrap'), permInterrupt = byId('permInterrupt');
  const permAllowBtn = byId('permAllow'), permDenyBtn = byId('permDeny'), permIntegrityReload = byId('permIntegrityReload');
  const questionText = byId('questionText'), questionOptions = byId('questionOptions');
  const questionHeader = byId('questionHeader'), questionMultiHint = byId('questionMultiHint');
  const questionMultiSubmit = byId('questionMultiSubmit'), questionSkip = byId('questionSkip');
  const questionOtherToggle = byId('questionOtherToggle'), questionOtherPanel = byId('questionOtherPanel');
  const questionOtherInput = byId('questionOtherInput'), questionOtherSubmit = byId('questionOtherSubmit');
  const questionOtherWrap = byId('questionOtherWrap'), questionTabs = byId('questionTabs');
  const questionReview = byId('questionReview'), questionReviewList = byId('questionReviewList');
  const questionReviewMissing = byId('questionReviewMissing'), questionGroupSubmit = byId('questionGroupSubmit');

  const { permissionQueue: permQueue, questionQueue, markQuestionAnswered, isQuestionAnswered } = queues;

  let activePerm = null;
  let permPersistAvailable = false;
  let permExpandBtn = null;             // M1：展开按钮引用，showNextPerm 前清除
  let activeQuestion = null;
  let selectedExitMode = 'default';     // ExitPlanMode 退出后权限档（对齐 CLI plan-exit）；默认 default
  let multiSelectedIndexes = new Set(); // multiSelect 当前题勾选的下标
  let permArmTimer = null;
  let permArming = false;
  // 别的界面盖在当前会话上（打不开的会话的落地页）时，审批 / 提问卡先收起、不弹（验收 O38）；卡本身留着，
  // resume 时原样再弹出来。期间新到的照常排队。
  let suspended = false;

  // ---- 审批完整性预检（协议步骤4）----
  // 渲染前（严格说：渲染后异步补验，见下）重算指纹比对服务端锚定的 fp，防传输层篡改（op 被改而 fp
  // 未同步改）。不阻塞卡片显示；真正的执行门槛在后端 resolvePermission（agent.js），即使因浏览器兼容性
  // 等原因未能核验，审批本身仍受后端 fail-closed 保护。
  // 核验出不符时「允许」一直禁用（验收 O28）：回传的 op 就是这张卡展示的内容，服务端按锚定指纹判，
  // 必然拒跑——留着「允许」可点，用户以为自己批准了眼前这条命令，得到的却是一次拒绝。只剩拒绝，
  // 或刷新页面从服务端待办快照重取这张卡。
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
    syncPermButtons();
  }
  // 三个动作按钮的可点状态只在这里算：防误触期内全部禁用；完整性不符时「允许」一直禁用。
  // 用原生 disabled 而不只是 pointer-events：后者挡不住键盘（焦点落到「允许」再回车照样批），
  // 外观上也看不出现在不能点（验收 O70）。
  function syncPermButtons() {
    const mismatch = Boolean(activePerm && permIntegrityMismatched.has(activePerm.requestId));
    if (permAllowBtn) permAllowBtn.disabled = permArming || mismatch;
    if (permDenyBtn) permDenyBtn.disabled = permArming;
    if (permInterrupt) permInterrupt.disabled = permArming;
  }
  if (permIntegrityReload) permIntegrityReload.onclick = () => location.reload();

  // ---- 审批弹窗（4a：完整命令 + cwd）----
  function showNextPerm() {
    if (activePerm || permQueue.length === 0) return;
    activePerm = permQueue.shift();
    // Claude in Chrome：标题写出网站，勾选文案写明实际放行范围。两处都每张卡片重写——上一张的改写不能粘到下一张。
    const chrome = describeChromePermission(activePerm);
    if (permTitle) {
      permTitle.textContent = chrome?.title || '';
      permTitle.classList.toggle('hidden', !chrome);
    }
    if (permAlwaysLabel) permAlwaysLabel.textContent = chrome?.alwaysLabel || t('总是允许此类操作');
    permTool.textContent = activePerm.name;
    permCwd.textContent = `${t('工作目录：')}${activePerm.cwd}`;
    // 每张新卡片先重置警示条（上一张若显示过不应带到这张）；若这条请求排队期间已判定过指纹不符
    // （permIntegrityMismatched），直接补显示——不会再触发一次新的异步校验。
    if (permIntegrityWarn) permIntegrityWarn.classList.add('hidden');
    if (permIntegrityMismatched.has(activePerm.requestId)) showPermIntegrityWarning();
    // 先上防误触再开窗：开窗那一刻按钮就已经是禁用的，不留一个「已显示、还没禁用」的间隙。
    armPermSheetButtons();
    // UX-001：ExitPlanMode 计划用 renderMarkdown（DOMPurify）；普通命令去 JSON 引号、mono 纯文本。
    // M1：超 4000 字显示展开按钮，而非截断（防恶意内容藏尾部）
    permExpandBtn?.remove(); permExpandBtn = null;
    const display = formatPermInputDisplay(activePerm.name, activePerm.input);
    const full = display.text || '';
    const applyPermInput = (text) => {
      if (display.mode === 'markdown') {
        permInput.classList.remove('font-mono', 'whitespace-pre-wrap');
        permInput.classList.add('msg-body');
        permInput.innerHTML = render(text);
      } else {
        permInput.classList.remove('msg-body');
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
    // 「永久」档只在 CLI 给了会落盘的规则时才存在。没有规则可写却摆一个「永久」选项，
    // 点了什么也不会发生——那比没有更糟。
    const persistScope = describePersistScope(activePerm.persistDestinations);
    permPersistAvailable = !!persistScope;
    if (permPersistWrap) {
      permPersistWrap.classList.add('hidden'); // 勾了「总是允许」才展开，见下方 permAlways 的 change
      if (permPersistLabel) permPersistLabel.textContent = persistScope?.label || '';
      if (permPersistHint) permPersistHint.textContent = persistScope?.hint || '';
      // ★ 每张新卡片都回到「仅本会话」：**不继承上一条的选择**——上一条可能是个无害的 Read，
      // 这一条可能是 rm。持久授权不该有粘性。
      const sessionRadio = permPersistWrap.querySelector?.('input[value="session"]');
      if (sessionRadio) sessionRadio.checked = true;
    }
    // ExitPlanMode：展示退出后权限档选择（对齐 CLI plan-exit）；其它工具隐藏
    selectedExitMode = 'default';
    if (permExitModeWrap) {
      const isExit = activePerm.name === 'ExitPlanMode';
      permExitModeWrap.classList.toggle('hidden', !isExit);
      if (isExit) paintExitModeChips();
    }
    if (!suspended) {
      // 先上防误触再开窗（同上）；被别的界面盖着时不弹，resume 时再弹
      armPermSheetButtons();
      openSheet(permModal);
    }
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
  // UX-003：弹出后约 600ms 内按钮不响应，防拇指热区误触授权。验收 O70 实测面板出现 0.5 秒时在输入框
  // 原位置点一下就批准了（「允许」正好压在输入框上）——原来的 350ms 盖不住这一下。
  function armPermSheetButtons(ms = PERM_ARM_MS) {
    if (!permModal) return;
    permModal.classList.add('sheet-arming');
    permArming = true;
    syncPermButtons();
    if (permArmTimer) clearTimeout(permArmTimer);
    permArmTimer = setTimeout(() => {
      permModal.classList.remove('sheet-arming');
      permArmTimer = null;
      permArming = false;
      syncPermButtons();
    }, ms);
  }
  // 勾了「总是允许」才展开范围选择；取消勾选时连同选择一起收起并复位。
  permAlways?.addEventListener?.('change', () => {
    if (!permPersistWrap) return;
    permPersistWrap.classList.toggle('hidden', !(permAlways.checked && permPersistAvailable));
    if (!permAlways.checked) {
      const sessionRadio = permPersistWrap.querySelector?.('input[value="session"]');
      if (sessionRadio) sessionRadio.checked = true;
    }
  });

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
      // 永久蕴含本会话，故两个字段一起送、由服务端那一处判据统一裁决。
      // 没勾「总是允许」时 persistRules 恒 false——单选钮的状态不参与。
      persistRules: permAlways.checked && permPersistAvailable
        && permPersistWrap?.querySelector?.('input[value="persist"]')?.checked === true,
      instanceId: getViewingInstanceId(), // 台阶3：路由到当前查看 tab 实例（切过去后审批的本就是该实例）
      // op：回传本卡片渲染时所见的确切操作（审批完整性绑定协议步骤5）——
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
  // 单题：点选项即交（多选点「确认选择」）。多题（服务端标了 questionCount > 1）：对齐 CLI 合成一张组卡，
  // 顶部标签栏来回切题，答案先攒成草稿，最后在复查页整组一次提交；没答完时「提交」禁用（机主定，CLI 允许缺题）。
  // activeGroup = { key: toolUseID, questions（按 questionIndex 升序）, drafts, cursor }，cursor 等于题数时停在
  // 复查页；组卡期间 activeQuestion 恒为 null。
  let activeGroup = null;
  // 组卡草稿按 toolUseID 留着：切会话时 clearAll 收卡，切回来 pending 快照重建组卡时接着用。只在提交 / 整组
  // 终态时删；上限兜住没等到终态的组（abort 只发逐题 resolved，不发整组那条）。
  const groupDrafts = new Map();
  const GROUP_DRAFTS_MAX = 20;
  function draftsFor(key) {
    if (!groupDrafts.has(key)) {
      groupDrafts.set(key, new Map());
      while (groupDrafts.size > GROUP_DRAFTS_MAX) groupDrafts.delete(groupDrafts.keys().next().value);
    }
    return groupDrafts.get(key);
  }
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
    if (activeQuestion || activeGroup || questionQueue.length === 0) return;
    const next = questionQueue.shift();
    if (isGroupedQuestion(next)) {
      const key = questionGroupKey(next.requestId);
      const questions = [next];
      for (let i = questionQueue.length - 1; i >= 0; i--) {
        if (questionGroupKey(questionQueue[i].requestId) === key) questions.push(...questionQueue.splice(i, 1));
      }
      questions.sort((a, b) => a.questionIndex - b.questionIndex);
      activeGroup = { key, questions, drafts: draftsFor(key), cursor: 0 };
      paintGroup();
    } else {
      activeQuestion = next;
      questionTabs?.classList.add('hidden');
      showQuestionPage(true);
      paintQuestion(activeQuestion);
    }
    if (!suspended) openSheet(questionModal);
    updateSendButtonState();
  }
  // 题面与复查页互斥；单题卡恒为题面。
  function showQuestionPage(onQuestion) {
    for (const node of [questionText, questionOptions, questionOtherWrap]) node?.classList.toggle('hidden', !onQuestion);
    questionReview?.classList.toggle('hidden', onQuestion);
    if (!onQuestion) for (const node of [questionHeader, questionMultiHint, questionMultiSubmit]) node?.classList.add('hidden');
  }
  // 多选按钮：单题卡是「确认选择」，一项不选不可点；组卡里是去下一题（最后一题去复查页），不选也能走。
  function syncMultiSubmit() {
    if (!questionMultiSubmit) return;
    const n = multiSelectedIndexes.size;
    const base = !activeGroup ? t('确认选择')
      : activeGroup.cursor === activeGroup.questions.length - 1 ? t('检查回答') : t('下一题');
    questionMultiSubmit.disabled = !activeGroup && n === 0;
    questionMultiSubmit.textContent = n ? `${base} (${n})` : base;
  }
  // 题面：header / 正文 / 选项（含说明与预览），单题卡与组卡共用。picked 是要画成已选的下标；
  // 点选项后单题卡直接交，组卡记草稿并跳下一题。
  function paintQuestion(q, picked = []) {
    multiSelectedIndexes = new Set(picked);
    const multi = Boolean(q.multiSelect);
    if (questionHeader) {
      const h = q.header ? String(q.header) : '';
      questionHeader.textContent = h;
      questionHeader.classList.toggle('hidden', !h || Boolean(activeGroup)); // 组卡的 header 已在标签栏上
    }
    questionText.textContent = q.text;
    if (questionMultiHint) {
      questionMultiHint.classList.toggle('hidden', !multi);
      questionMultiHint.textContent = activeGroup ? t('可多选') : t('可多选，选完点下方「确认选择」');
    }
    if (questionMultiSubmit) questionMultiSubmit.classList.toggle('hidden', !multi);
    syncMultiSubmit();
    // 组卡里「其他」只是记一份草稿，还没提交
    if (questionOtherSubmit) questionOtherSubmit.textContent = activeGroup ? t('确定') : t('提交其他答案');
    questionOptions.innerHTML = '';
    resetQuestionOtherUI();
    (q.options || []).forEach((opt, i) => {
      const wrap = el(`<div class="rounded-lg border border-line bg-sunk overflow-hidden"></div>`);
      const btn = el(`<button type="button" class="w-full py-2.5 px-3 text-ink text-sm text-left"></button>`);
      const label = optionLabel(opt);
      const pickedNow = multiSelectedIndexes.has(i);
      btn.textContent = multi ? `${pickedNow ? '☑' : '☐'} ${label}` : label;
      if (pickedNow) {
        paintMultiOption(wrap, true);
        if (!multi) btn.setAttribute('aria-pressed', 'true');
      }
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
          if (activeGroup) setGroupDraft(multiSelectedIndexes.size ? { optionIndexes: [...multiSelectedIndexes] } : null);
          syncMultiSubmit();
        };
      } else {
        btn.onclick = () => {
          if (!activeGroup) { answerQuestion(i); return; }
          setGroupDraft({ optionIndex: i });
          goToGroupStep(activeGroup.cursor + 1);
        };
      }
      questionOptions.appendChild(wrap);
    });
  }

  // ---- 多题组卡 ----
  function groupQuestionTitle(q) {
    return q.header ? String(q.header) : t('第 {n} 题').replace('{n}', q.questionIndex + 1);
  }
  function setGroupDraft(draft) {
    const g = activeGroup;
    const q = g.questions[g.cursor];
    if (draft) g.drafts.set(q.questionIndex, draft);
    else g.drafts.delete(q.questionIndex);
    paintGroupTabs(); // ☐ / ☑ 跟着变
  }
  function goToGroupStep(cursor) {
    activeGroup.cursor = Math.max(0, Math.min(cursor, activeGroup.questions.length));
    paintGroup();
  }
  // 标签栏 + 当前题（或复查页）。切回某题时按草稿恢复单选、多选勾选与「其他」里写的字。
  function paintGroup() {
    const g = activeGroup;
    paintGroupTabs();
    const onReview = g.cursor >= g.questions.length;
    showQuestionPage(!onReview);
    if (onReview) {
      paintGroupReview();
    } else {
      const q = g.questions[g.cursor];
      const draft = g.drafts.get(q.questionIndex);
      paintQuestion(q, draft?.optionIndexes ?? (Number.isInteger(draft?.optionIndex) ? [draft.optionIndex] : []));
      if (typeof draft?.freeText === 'string') {
        questionOtherPanel?.classList.remove('hidden');
        if (questionOtherInput) questionOtherInput.value = draft.freeText;
      }
    }
    const sheet = questionModal?.firstElementChild;
    if (sheet) sheet.scrollTop = 0; // 换题回到顶部：上一题选项长时，不至于看不到这题的题目
  }
  function paintGroupTabs() {
    if (!questionTabs) return;
    const g = activeGroup;
    questionTabs.classList.remove('hidden');
    questionTabs.innerHTML = '';
    const addTab = (text, step) => {
      const tab = el(`<button type="button" class="shrink-0 max-w-[10rem] truncate px-2.5 py-1 rounded-full border text-xs"></button>`);
      tab.textContent = text;
      const on = step === g.cursor;
      tab.classList.toggle('border-accent', on);
      tab.classList.toggle('bg-accent-wash', on);
      tab.classList.toggle('text-ink', on);
      tab.classList.toggle('border-line', !on);
      tab.classList.toggle('text-ink-soft', !on);
      if (on) tab.setAttribute('aria-current', 'step');
      tab.onclick = () => goToGroupStep(step);
      questionTabs.appendChild(tab);
    };
    g.questions.forEach((q, i) => {
      const answered = Boolean(questionDraftLabel(q, g.drafts.get(q.questionIndex)));
      addTab(`${answered ? '☑' : '☐'} ${groupQuestionTitle(q)}`, i);
    });
    addTab(`✓ ${t('提交')}`, g.questions.length);
  }
  // 复查页：逐题列答案，点一行回那题改；没答的标「未作答」，答完才能提交。
  function paintGroupReview() {
    const g = activeGroup;
    const { missing } = buildQuestionGroupAnswers(g.questions, g.drafts);
    if (questionReviewList) {
      questionReviewList.innerHTML = '';
      g.questions.forEach((q, i) => {
        const label = questionDraftLabel(q, g.drafts.get(q.questionIndex));
        const row = el(`<button type="button" class="w-full text-left rounded-lg border bg-sunk px-3 py-2 ${label ? 'border-line' : 'border-warning'}"></button>`);
        const title = el(`<div class="text-xs text-ink-faint"></div>`);
        title.textContent = groupQuestionTitle(q);
        const body = el(`<div class="text-sm text-ink"></div>`);
        body.textContent = q.text;
        const answer = el(`<div class="text-sm mt-1 ${label ? 'text-success' : 'text-warning'}"></div>`);
        answer.textContent = label ? `→ ${label}` : t('未作答');
        row.appendChild(title);
        row.appendChild(body);
        row.appendChild(answer);
        row.onclick = () => goToGroupStep(i);
        questionReviewList.appendChild(row);
      });
    }
    if (questionReviewMissing) {
      questionReviewMissing.textContent = missing.length ? t('还有 {n} 题没答，答完才能提交').replace('{n}', missing.length) : '';
      questionReviewMissing.classList.toggle('hidden', !missing.length);
    }
    if (questionGroupSubmit) questionGroupSubmit.disabled = missing.length > 0;
  }
  function submitQuestionGroup() {
    const g = activeGroup;
    if (!g) return;
    const { answers, missing } = buildQuestionGroupAnswers(g.questions, g.drafts);
    if (missing.length) return; // 按钮此时是禁用的
    if (!socket.connected) { addBar(t('网络未连接，请等待重新连接后再操作'), 'text-danger'); return; }
    // 先标记已答再 emit/关窗（同 answerQuestion）；整组 key 入库即覆盖组里每一个 #i
    markQuestionAnswered(g.key);
    groupDrafts.delete(g.key);
    socket.emit('user:answer', { requestId: g.key, answers, instanceId: getViewingInstanceId() });
    const labels = g.questions.map(q => `「${questionDraftLabel(q, g.drafts.get(q.questionIndex))}」`);
    finishQuestionUI(`${t('已选择：')}${labels.join(t('、'))}`);
  }

  function finishQuestionUI(barText) {
    activeQuestion = null;
    activeGroup = null;
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
    if (!activeQuestion && !activeGroup) return;
    const freeText = (questionOtherInput?.value || '').trim();
    if (!freeText) {
      addBar(t('请先输入其他答案'), 'text-info');
      questionOtherInput?.focus();
      return;
    }
    if (activeGroup) { // 组卡：只记草稿，整组提交时才发
      setGroupDraft({ freeText });
      goToGroupStep(activeGroup.cursor + 1);
      return;
    }
    if (!socket.connected) { addBar(t('网络未连接，请等待重新连接后再操作'), 'text-danger'); return; }
    markQuestionAnswered(activeQuestion.requestId);
    socket.emit('user:answer', { requestId: activeQuestion.requestId, freeText, instanceId: getViewingInstanceId() });
    finishQuestionUI(`${t('已回答（其他）：')}${freeText}`);
  }
  if (questionMultiSubmit) questionMultiSubmit.onclick = () => (activeGroup ? goToGroupStep(activeGroup.cursor + 1) : answerQuestionMulti());
  if (questionGroupSubmit) questionGroupSubmit.onclick = () => submitQuestionGroup();
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
      if (!activeQuestion && !activeGroup) return;
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
    if (!activeQuestion && !activeGroup) return;
    activeQuestion = null;
    activeGroup = null;
    closeSheet(questionModal);
  }
  // 组里某题已在别处作答（别的设备整组提交时逐题各来一条，或没刷新的旧页面逐题即交）：从组卡拿掉、草稿作废，
  // 否则本机整组提交会带上它而被服务端整组拒收。整组 key 是终态，整张卡收掉。
  function resolveInActiveGroup(requestId) {
    const g = activeGroup;
    if (requestId === g.key) {
      groupDrafts.delete(g.key);
      dropActiveQuestion();
      return;
    }
    const idx = g.questions.findIndex(q => q.requestId === requestId);
    if (idx === -1) return;
    g.drafts.delete(g.questions[idx].questionIndex);
    g.questions.splice(idx, 1);
    if (!g.questions.length) {
      groupDrafts.delete(g.key);
      dropActiveQuestion();
      return;
    }
    if (idx < g.cursor) g.cursor--;
    paintGroup();
  }

  const controller = {
    // 幂等去重：sync:since 切入补发的 pending 快照可能与 buffer 回放的原始事件同 requestId。
    isDuplicatePermission(requestId) {
      return activePerm?.requestId === requestId || permQueue.some(r => r.requestId === requestId);
    },
    // 问题侧多一道：已本地作答/已收 request_resolved 的忽略重放（切会话、probe、整页刷新后的 sync）。
    isDuplicateQuestion(requestId) {
      if (activeQuestion?.requestId === requestId || questionQueue.some(q => q.requestId === requestId)) return true;
      if (activeGroup?.questions.some(q => q.requestId === requestId)) return true;
      return isQuestionAnswered(requestId);
    },
    enqueuePermission(p) { permQueue.push(p); showNextPerm(); },
    enqueueQuestion(p) {
      // 同组后到的题（服务端逐题下发，紧跟第一题）并进当前组卡，不另排队
      const g = activeGroup;
      if (g && questionGroupKey(p.requestId) === g.key) {
        let at = g.questions.findIndex(q => q.questionIndex > p.questionIndex);
        if (at === -1) at = g.questions.length;
        g.questions.splice(at, 0, p);
        if (at <= g.cursor) g.cursor++;
        paintGroupTabs();
        if (g.cursor >= g.questions.length) paintGroupReview();
        return;
      }
      questionQueue.push(p);
      showNextQuestion();
    },
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
      if (activeGroup) resolveInActiveGroup(requestId);
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
      permArming = false;
      syncPermButtons();
    },
    // 输入区是否该被"先处理当前审批/选择"挡住。
    hasPending() { return Boolean(activePerm || activeQuestion || activeGroup); },
    suspend() {
      if (suspended) return;
      suspended = true;
      if (activePerm) closeSheet(permModal);
      if (activeQuestion || activeGroup) closeSheet(questionModal);
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      if (activePerm) { armPermSheetButtons(); openSheet(permModal); } // 先上锁、后开窗，时长同 showNextPerm（PERM_ARM_MS）
      if (activeQuestion || activeGroup) openSheet(questionModal);
    },
  };
  context.state.approvals = controller;
  return controller;
}
