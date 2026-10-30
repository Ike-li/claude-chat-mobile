// 底栏 composer 的控件：模型 / 权限 / 思考强度的磁贴网格与隐藏 select、底栏 pill 与会话档摘要同步、短 session_id 胶囊；
// 输入框上方的斜杠命令提示与 @ 文件引用候选（同款纵向浮层，共用键盘导航与 a11y 状态）。
// #359 Step 5 从 app.js 原样迁出；与 app.js 共用的可变态经 getter / setter 注入，声明在实例化点之后的依赖经惰性包装注入。

import { applyAtMentionPick, buildSlashCommandHints, composerHintOptionId, detectAtMentionQuery, effortLevelSubtitle, effortLevelsFor, effortUiState, esc, formatComposeDefaultsSummary, modelGridEmptyHint, modelLabelFor, modelTileValueFor, permissionModeTileSpecs, pillPermTone, resolveComposerHintKeydown, resolveModelPillText, resolveModelTileDisplay, sessionIdBlockView, shouldSendOnEnter, withAutoTier, withUltracodeTier } from '../logic.js';
import { t } from '../i18n.js';

export function createComposerControls(context, {
  $, addBar, addModeBar, appConfirm, autosize, btnSessions, closeLeftSidebar, customEffortGrid,
  customEffortGroup, customModelGrid, customPermGrid, effortOwnerModel, effortOwnerWrap, effortRow,
  effortSelect, effortUnsupported, el, ensureModelOption, haptic, hidePromptSuggestion, inputEl,
  isTouchDevice, leftSidebar, modelInput, modelIntent, permModeSelect, pillDefaults, pillEffort,
  pillEffortText, pillModelText, pillPermText, projectsState, refreshComposeDefaultsSummary, requestCwd,
  send, socket, topContextPill, updateSendButtonState, getComposeReady, getComposing, getCurrentEffort,
  getCurrentGatewaySuffix, getCurrentModel, getCurrentPermMode, getCwdDefaultModel, getMirrorReadonlySid,
  getModelsList, getUltracodeArmed, getViewingInstanceId, setCurrentEffort, setCurrentGatewaySuffix,
  setCurrentModel, setCurrentPermMode, setCurrentSessionIdForCopy, setUltracodeArmed,
} = {}) {

  // 短 session_id 胶囊：显前 8 位、点按复制完整 id。便于对照 CLI /resume、日志、多设备定位同一会话。
  // 无 id 时不再只藏行——那会在面板底部留下一个没人管的「🆔 会话标识」标题（标题恒显），形似渲染故障；
  // 改为收起胶囊 + 就地说明懒创建（判定与文案见 logic/panel-state.js sessionIdBlockView）。
  function updatePillSession(sid, emptyCtx = {}) {
    const pill = $('pillSession'), txt = $('pillSessionText'), row = $('settingsSessionRow');
    if (!pill || !txt) return;
    const view = sessionIdBlockView({ sessionId: sid, ...emptyCtx });
    setCurrentSessionIdForCopy(view.showRow ? sid : null);
    txt.textContent = view.showRow ? sid.slice(0, 8) : '';
    pill.classList.toggle('hidden', !view.showRow);
    row?.classList.toggle('hidden', !view.showRow);
    const hint = $('settingsSessionHint');
    if (hint) {
      hint.textContent = view.hint || '';
      hint.classList.toggle('hidden', !view.hint);
    }
  }

  function syncModelUI(model, displayOverride) {
    // 底栏模型 chip：原样显示当前 model（+ 网关后缀）；未选时用 CLI default 的 displayName 或 cwd 默认裸名。
    const cliDefault = (getModelsList() || []).find(m => (typeof m === 'string' ? m : m?.value) === 'default');
    const cliDefaultLabel = cliDefault && typeof cliDefault === 'object'
      ? (cliDefault.displayName || 'Default (recommended)')
      : null;
    const modelPillText = displayOverride || resolveModelPillText({
      model,
      gatewaySuffix: getCurrentGatewaySuffix(),
      modelsList: getModelsList(),
      cwdDefaultModel: getCwdDefaultModel(),
      cliDefaultLabel,
    });
    if (pillModelText) pillModelText.textContent = modelPillText;
    if (customModelGrid) {
      // 空选中时高亮 CLI 的 default 项（与终端 /model 列表一致），不靠 data-model="" 伪项。
      // 在跑的 wire 不是档位 id：映射到它所在的那张磁贴（验收 O53），列表里没有才落到兜底卡（value 即它本身）
      const activeVal = model
        ? (modelTileValueFor(model, getModelsList(), getCurrentGatewaySuffix()) || model)
        : (cliDefault ? 'default' : '');
      customModelGrid.querySelectorAll('.model-tile').forEach(tile => {
        const tileVal = tile.dataset.model;
        const isCurrent = tileVal === activeVal;
        tile.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
        const title = tile.querySelector('.text-xs');
        if (isCurrent) {
          tile.classList.add('ring-1', 'ring-accent', 'border-accent', 'text-accent', 'bg-accent-wash/30');
          if (title) {
            title.classList.add('text-accent');
            title.classList.remove('text-ink');
          }
        } else {
          tile.classList.remove('ring-1', 'ring-accent', 'border-accent', 'text-accent', 'bg-accent-wash/30');
          if (title) {
            title.classList.remove('text-accent');
            title.classList.add('text-ink');
          }
        }
      });
    }
    // compose 页默认档摘要与底栏同源；模型段变了就地刷 title
    syncDefaultsPillTitle();
    if (getComposeReady()) refreshComposeDefaultsSummary();
  }

  function rebuildCustomModelGrid(models) {
    if (!customModelGrid) return;
    customModelGrid.innerHTML = '';
    // 终端等价：只渲染 CLI/SDK supportedModels 列表，不自造「默认模型」空磁贴。
    // CLI 列表自带 value:"default" / "Default (recommended)"；空首页未选时高亮该项。
    const list = models || [];
    const hasCliDefault = list.some(m => (typeof m === 'string' ? m : m?.value) === 'default');
    // 选中规则：已有具体 currentModel → 精确/别名命中；否则 FRESH 高亮 CLI default 项
    const selectedVal = getCurrentModel()
      || (modelInput?.value || '')
      || (hasCliDefault ? 'default' : '');

    // 条数 = SDK 列表；标题 = 真实 wire id（resolvedModel），value 仍用 SDK 档位 id
    const tiles = resolveModelTileDisplay(list);
    // 「使用中」只给一张：在跑 / 选中的模型映射到它所在的磁贴（验收 O53）。此前按 wire 相等把同 wire 的几档全标上，
    // 网关下四档同指一个 wire 时四张一起「使用中」。
    const activeVal = modelTileValueFor(selectedVal, list, getCurrentModel() ? getCurrentGatewaySuffix() : '') || selectedVal;
    tiles.forEach(({ value: val, title, subtitle }) => {
      const display = title;
      const active = val === activeVal
        || (!getCurrentModel() && val === 'default' && (selectedVal === 'default' || !selectedVal));
      const using = active ? t(' · 使用中') : '';
      // 原生 button + aria-pressed（验收 O13），同权限六档：选中态给读屏的那一路靠 aria-pressed，syncModelUI 跟着改
      const card = el(`
        <button type="button" data-model="${esc(val)}" aria-pressed="${active ? 'true' : 'false'}" class="model-tile w-full text-left p-2 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all ${active ? 'ring-1 ring-accent border-accent text-accent bg-accent-wash/30' : ''}">
          <div class="text-xs font-semibold truncate ${active ? 'text-accent' : 'text-ink'}">${esc(display)}${using ? `<span class="text-[11px] font-normal opacity-80">${esc(using)}</span>` : ''}</div>
          <div class="text-xs text-ink-soft truncate mt-0.5">${esc(subtitle || val)}</div>
        </button>
      `);
      card.onclick = () => {
        if (getMirrorReadonlySid()) { addBar(t('终端驾驶中，设置已冻结——接管后可调'), 'text-info'); return; }
        haptic('tap');
        // value 保持 SDK 条目 id；发送时 resolveSendModel 再 pin wire
        modelInput.value = val === 'default' ? '' : val;
        modelIntent.markPicked(); // 用户点的才算发送意图（见 resolveOutgoingModel）
        delete modelInput.dataset.fullModel;
        if (val !== 'default') ensureModelOption(val);
        syncModelUI(val === 'default' ? '' : val);
        rebuildEffortOptions(val === 'default' ? (getCwdDefaultModel() || getCurrentModel()) : val);
      };
      customModelGrid.appendChild(card);
    });
    syncModelGridEmptyHint();
  }

  // 「✨ 模型」标题恒显，网格却可能一张卡都没有（该 cwd 无 models 缓存时服务端不推、等 scout；
  // scout 起不来则一直空着）——空白＝又一个孤儿标题。这里按【实际渲染出的磁贴数】判，而不是按
  // models 列表长度：磁贴有两个来源（本函数上方的候选列表 + ensureModelOption 追加的「当前加载
  // 模型」），只看列表会一边说没清单一边摆着一张卡。故两个产出点都要调用本函数收口。
  function syncModelGridEmptyHint() {
    const emptyEl = $('modelGridEmpty');
    if (!emptyEl || !customModelGrid) return;
    const hint = modelGridEmptyHint({ tileCount: customModelGrid.querySelectorAll('.model-tile').length });
    emptyEl.textContent = hint || '';
    emptyEl.classList.toggle('hidden', !hint);
  }

  function updateModelAndSuffix(rawModel) {
    if (!rawModel) {
      setCurrentModel('');
      setCurrentGatewaySuffix('');
      syncModelUI('');
      return '';
    }
    const match = rawModel.match(/\[[^\]]+\]$/);
    if (match) {
      setCurrentGatewaySuffix(match[0]);
      setCurrentModel(rawModel.replace(/\[[^\]]+\]$/, ''));
    } else {
      setCurrentGatewaySuffix('');
      setCurrentModel(rawModel);
    }
    syncModelUI(getCurrentModel());
    return getCurrentModel();
  }

  let permModeSeen = false;             // 首次服务端同步只定基线不上屏（刷新/重连不冒「切换」假象）

  let effortSeen = false;               // 首次服务端同步只定基线不上屏（同 permModeSeen）

  // ---- @ 文件引用：与 / 斜杠同款纵向浮层（absolute bottom-full），不再横滑 chips ----
  // 语义只插相对路径文本，agent 自己 Read；移动端纯触摸点选。
  // 面板挂在 input 父级（与 #cmdHints 同层），见下方 slash 提示初始化。
  let atMentionList = null; // 延迟到 slash hints 同批创建
  let atMentionState = null; // { matchStart } —— 当前触发态；null=未触发
  let atMentionReqId = 0;    // 每次触发/取消自增；files:search ack 里比对，迟到结果直接丢弃
  let atMentionDebounceTimer = null;
  // #392：listbox 高亮下标；-1 = 尚未用方向键选中（Enter 仍走发送）
  let atMentionActiveIndex = -1;
  let cmdHintActiveIndex = -1;

  function clearComposerHintA11y() {
    inputEl.setAttribute('aria-expanded', 'false');
    inputEl.removeAttribute('aria-controls');
    inputEl.removeAttribute('aria-activedescendant');
  }

  function applyComposerHintActive(listEl, dataAttr, index) {
    if (!listEl) return;
    const opts = [...listEl.querySelectorAll(`[${dataAttr}]`)];
    opts.forEach((row, i) => {
      const on = i === index;
      row.setAttribute('aria-selected', on ? 'true' : 'false');
      row.classList.toggle('bg-sunk', on);
    });
    if (index >= 0 && opts[index]) {
      inputEl.setAttribute('aria-activedescendant', opts[index].id);
      opts[index].scrollIntoView({ block: 'nearest' });
    } else {
      inputEl.removeAttribute('aria-activedescendant');
    }
  }

  function setComposerHintExpanded(listId) {
    if (!listId) { clearComposerHintA11y(); return; }
    inputEl.setAttribute('aria-expanded', 'true');
    inputEl.setAttribute('aria-controls', listId);
  }

  function hideCmdHints() {
    const cmdHintsEl = document.getElementById('cmdHints');
    if (cmdHintsEl) { cmdHintsEl.classList.add('hidden'); cmdHintsEl.innerHTML = ''; }
    cmdHintActiveIndex = -1;
    if (!atMentionList || atMentionList.classList.contains('hidden')) clearComposerHintA11y();
  }

  function hideAtMentionList() {
    atMentionState = null;
    atMentionReqId++;
    atMentionActiveIndex = -1;
    if (atMentionDebounceTimer) { clearTimeout(atMentionDebounceTimer); atMentionDebounceTimer = null; }
    if (atMentionList) { atMentionList.classList.add('hidden'); atMentionList.innerHTML = ''; }
    const cmdHintsEl = document.getElementById('cmdHints');
    if (!cmdHintsEl || cmdHintsEl.classList.contains('hidden')) clearComposerHintA11y();
  }

  inputEl.addEventListener('keydown', e => {
    const composingNow = e.isComposing || e.keyCode === 229 || getComposing();
    // #392：开着的候选浮层优先吃方向键 / Enter 选中 / Escape（拦在发送之前）
    if (!composingNow) {
      const atOpts = (atMentionList && !atMentionList.classList.contains('hidden'))
        ? atMentionList.querySelectorAll('[data-path]') : [];
      const cmdHintsEl = document.getElementById('cmdHints');
      const cmdOpts = (cmdHintsEl && !cmdHintsEl.classList.contains('hidden'))
        ? cmdHintsEl.querySelectorAll('[data-cmd]') : [];
      const openKind = atOpts.length ? 'at' : (cmdOpts.length ? 'cmd' : null);
      if (openKind) {
        const optionCount = openKind === 'at' ? atOpts.length : cmdOpts.length;
        const activeIndex = openKind === 'at' ? atMentionActiveIndex : cmdHintActiveIndex;
        const decision = resolveComposerHintKeydown({
          key: e.key,
          open: true,
          optionCount,
          activeIndex,
          composing: false,
        });
        if (decision.action === 'move') {
          e.preventDefault();
          if (openKind === 'at') {
            atMentionActiveIndex = decision.nextIndex;
            applyComposerHintActive(atMentionList, 'data-path', atMentionActiveIndex);
          } else {
            cmdHintActiveIndex = decision.nextIndex;
            applyComposerHintActive(cmdHintsEl, 'data-cmd', cmdHintActiveIndex);
          }
          return;
        }
        if (decision.action === 'select') {
          e.preventDefault();
          if (openKind === 'at') {
            const path = atOpts[decision.nextIndex]?.dataset?.path;
            if (path) pickAtMention(path);
          } else {
            const cmd = cmdOpts[decision.nextIndex]?.dataset?.cmd;
            if (cmd) pickCmdHint(cmd);
          }
          return;
        }
        if (decision.action === 'dismiss') {
          e.preventDefault();
          if (openKind === 'at') hideAtMentionList();
          else hideCmdHints();
          return;
        }
      }
    }
    if (e.key === 'Enter' && !composingNow && shouldSendOnEnter({ shiftKey: e.shiftKey, isTouchDevice })) {
      e.preventDefault();
      send();
    }
    // ESC 关候选浮层（排队撤回已随排队功能一并移除，ESC 不再有第三个语义）
    if (e.key === 'Escape') {
      if (atMentionList && !atMentionList.classList.contains('hidden')) { hideAtMentionList(); return; }
      const cmdHintsEl = document.getElementById('cmdHints');
      if (cmdHintsEl && !cmdHintsEl.classList.contains('hidden')) { hideCmdHints(); return; }
    }
  });
  // hideAtMentionList 即关闭 @ 候选（Escape / 选中后）；不再保留未使用的 hideAtMentionChips 别名

  function pickAtMention(path) {
    if (!atMentionState) return;
    const cursor = inputEl.selectionStart ?? inputEl.value.length;
    const { text, cursorPos } = applyAtMentionPick(inputEl.value, { matchStart: atMentionState.matchStart, cursorPos: cursor, path });
    inputEl.value = text;
    hideAtMentionList();
    inputEl.focus();
    inputEl.setSelectionRange(cursorPos, cursorPos);
    autosize();
    updateSendButtonState();
  }

  function renderAtMentionList(paths, { emptyHint = '' } = {}) {
    if (!atMentionList) return;
    // 与 / 互斥：出文件列表时收起斜杠提示（hints 在下方初始化，调用时已就绪）
    hideCmdHints();
    atMentionActiveIndex = -1;
    atMentionList.innerHTML = '';
    if (!paths?.length) {
      if (emptyHint) {
        atMentionList.innerHTML = `<div class="px-3 py-2 text-xs text-ink-faint" data-testid="at-mention-empty">${esc(emptyHint)}</div>`;
        atMentionList.classList.remove('hidden');
        setComposerHintExpanded('atMentionHints');
        inputEl.removeAttribute('aria-activedescendant');
      } else {
        atMentionList.classList.add('hidden');
        clearComposerHintA11y();
      }
      return;
    }
    atMentionList.innerHTML = paths.map((p, i) => {
      const safe = esc(p);
      const id = composerHintOptionId('at', i);
      return `<div id="${id}" role="option" aria-selected="false" class="px-3 py-2.5 hover:bg-sunk active:bg-sunk cursor-pointer text-sm font-mono truncate" data-testid="at-mention-chip" data-path="${safe}" title="${safe}">${safe}</div>`;
    }).join('');
    atMentionList.classList.remove('hidden');
    setComposerHintExpanded('atMentionHints');
    applyComposerHintActive(atMentionList, 'data-path', atMentionActiveIndex);
  }

  function renderAtMentionLoading() {
    if (!atMentionList) return;
    hideCmdHints();
    atMentionActiveIndex = -1;
    atMentionList.innerHTML = `<div class="px-3 py-2 text-xs text-ink-faint" data-testid="at-mention-loading">${esc(t('查找文件…'))}</div>`;
    atMentionList.classList.remove('hidden');
    setComposerHintExpanded('atMentionHints');
    inputEl.removeAttribute('aria-activedescendant');
  }

  function checkAtMention() {
    // IME 组字中不触发（避免中文输入半成品误搜）；compositionend 再跑一次
    if (getComposing()) return;
    const cursor = inputEl.selectionStart ?? inputEl.value.length;
    const hit = detectAtMentionQuery(inputEl.value.slice(0, cursor));
    if (!hit) { if (atMentionState) hideAtMentionList(); return; }
    atMentionState = { matchStart: hit.matchStart };
    if (atMentionDebounceTimer) clearTimeout(atMentionDebounceTimer);
    const reqId = ++atMentionReqId;
    // 立刻给反馈，避免「打 @ 像没反应」（空 query 也会出候选列表）
    renderAtMentionLoading();
    atMentionDebounceTimer = setTimeout(() => {
      if (!socket?.connected) {
        if (reqId === atMentionReqId) renderAtMentionList([], { emptyHint: t('未连接，无法搜索文件') });
        return;
      }
      const cwd = requestCwd();
      // 「无文件夹」的新会话页：目录要等首条消息才建，还没有任何文件
      if (projectsState.isNoFolder(cwd) && !getViewingInstanceId()) { renderAtMentionList([], { emptyHint: t('无匹配文件') }); return; }
      socket.emit('files:search', { cwd, query: hit.query }, res => {
        if (reqId !== atMentionReqId) return; // 迟到 ack：期间已改 query / 取消触发，丢弃
        if (!res?.ok) {
          renderAtMentionList([], { emptyHint: res?.error || t('文件搜索失败') });
          return;
        }
        const paths = Array.isArray(res.paths) ? res.paths : [];
        renderAtMentionList(paths, {
          emptyHint: paths.length ? '' : t('无匹配文件'),
        });
      });
    }, 150);
  }
  inputEl.addEventListener('input', checkAtMention);
  inputEl.addEventListener('blur', hideAtMentionList);

  // ---- 斜杠命令提示 + @ 文件引用列表（同款纵向浮层，互斥显示；#392 listbox）----
  const hints = el(`<div id="cmdHints" role="listbox" aria-label="${esc(t('斜杠命令候选'))}" class="hidden absolute bottom-full left-0 mb-1 bg-surface border border-line rounded-lg max-h-60 overflow-y-auto w-full z-50" style="box-shadow:var(--shadow-pop)" data-testid="cmd-hints"></div>`);
  atMentionList = el(`<div id="atMentionHints" role="listbox" aria-label="${esc(t('文件引用候选'))}" class="hidden absolute bottom-full left-0 mb-1 bg-surface border border-line rounded-lg max-h-60 overflow-y-auto w-full z-50" style="box-shadow:var(--shadow-pop)" data-testid="at-mention-chips"></div>`);
  inputEl.setAttribute('aria-expanded', 'false');
  inputEl.setAttribute('aria-autocomplete', 'list');
  inputEl.setAttribute('aria-haspopup', 'listbox');
  inputEl.parentElement.style.position = 'relative';
  inputEl.parentElement.appendChild(hints);
  inputEl.parentElement.appendChild(atMentionList);
  // mousedown 防 blur 清空列表（点选行时 input 不失焦）
  atMentionList.addEventListener('mousedown', e => e.preventDefault());
  hints.addEventListener('mousedown', e => e.preventDefault());
  atMentionList.addEventListener('click', e => {
    const row = e.target.closest?.('[data-path]');
    if (row?.dataset?.path) pickAtMention(row.dataset.path);
  });
  function pickCmdHint(cmd) {
    inputEl.value = cmd + ' ';
    hideCmdHints();
    inputEl.focus();
    autosize();
    updateSendButtonState();
  }
  // 前端本地拦截命令（不透传后端），并入提示列表。说明现取 t()：跟着当前语言走
  const localCommandHints = () => [
    { name: 'model', description: t('切换模型') },
    { name: 'rewind', description: t('把代码和/或对话恢复到之前的某个时间点') },
  ];

  inputEl.addEventListener('input', () => {
    const val = inputEl.value;
    if (val) hidePromptSuggestion(); // 用户已经在写自己的了，建议就该让位
    if (val.startsWith('/')) {
      hideAtMentionList(); // 与 @ 互斥
      // terminal 绑定命令（/color /statusline 这类）不进手机补全菜单——判据由 SDK 下发，
      // 不是本地黑名单。只隐藏菜单项，手输仍照常透传给 CLI（见 buildSlashCommandHints 头注）。
      const matches = buildSlashCommandHints({
        commands: window.availableSkills || [],
        terminalCommands: window.terminalSlashCommands || [],
        localCommands: localCommandHints(),
        prefix: val.slice(1),
      });
      cmdHintActiveIndex = -1;
      if (matches.length > 0) {
        // 说明与参数提示来自 skill / 插件 / MCP 文件，是第三方内容：一律 esc() 后才进 innerHTML
        hints.innerHTML = matches.map((cmd, i) => {
          const safe = esc(cmd.name);
          const id = composerHintOptionId('cmd', i);
          const arg = cmd.argumentHint ? ` <span class="text-ink-soft">${esc(cmd.argumentHint)}</span>` : '';
          const desc = cmd.description ? `<div class="slash-hint-desc text-xs text-ink-soft truncate">${esc(cmd.description)}</div>` : '';
          return `<div id="${id}" role="option" aria-selected="false" class="px-3 py-2.5 hover:bg-sunk active:bg-sunk cursor-pointer text-sm" data-cmd="/${safe}"><div class="font-mono truncate">/${safe}${arg}</div>${desc}</div>`;
        }).join('');
        hints.classList.remove('hidden');
        setComposerHintExpanded('cmdHints');
        applyComposerHintActive(hints, 'data-cmd', cmdHintActiveIndex);
      } else {
        hideCmdHints();
      }
    } else {
      hideCmdHints();
    }
    autosize();
  });

  hints.addEventListener('click', e => {
    const row = e.target.closest?.('[data-cmd]');
    const cmd = row?.dataset?.cmd;
    if (cmd) pickCmdHint(cmd);
  });
  document.addEventListener('click', e => {
    if (!hints.contains(e.target) && e.target !== inputEl) hideCmdHints();
    if (atMentionList && !atMentionList.contains(e.target) && e.target !== inputEl) hideAtMentionList();
    // 点抽屉外面任意处 = 收抽屉。通用确认 sheet 与会话行「⋯」菜单（z-50，盖在抽屉之上）不算「外面」：
    // 从抽屉里发起的操作（标为已读 / 未读、重命名、删除）做完应回到抽屉、看到那一行的新状态，而不是抽屉顺手滑走。
    const insideConfirmSheet = Boolean(e.target.closest?.('#confirmModal, #sessionMenuModal, #sessionRenameModal'));
    // 本身就是「打开抽屉」入口的按钮（顶栏「需要你」chip、落地页「选择其他会话」）：同一次点击冒泡到这里，
    // 不豁免就是开了又立刻关上（验收 O37）。新入口在 index.html 上标 data-opens-drawer 即可。
    const opensDrawer = Boolean(e.target.closest?.('[data-opens-drawer]'));
    if (!leftSidebar.classList.contains('-translate-x-full') && !leftSidebar.contains(e.target) && !btnSessions.contains(e.target) && !(topContextPill && topContextPill.contains(e.target)) && !insideConfirmSheet && !opensDrawer && e.target.isConnected)
      closeLeftSidebar();
  });


  // ---- 权限档切换：清单 = SDK PermissionMode（SDK_PERMISSION_MODES / 后端 CCM_PERMISSION_MODES）----
  // 磁贴与 hidden select 均由 rebuildPermissionModeUi 动态填充，禁止 HTML 写死档位。
  // 文案 = CLI/桌面英文原名（Manual / Accept edits / …），不走 t()/i18n——与终端等价。
  // setPermMode 仅由 init/permission_mode 服务端事件驱动（权威回执，函数声明有提升），onchange 不再
  // 乐观调用——故上屏的系统条 = 服务端已确认切换。程序设 select.value 不触发 onchange，无回声循环。
  const _permTileSpecs = permissionModeTileSpecs();
  const PERM_LABEL = Object.fromEntries(_permTileSpecs.map(s => [s.id, s.bar]));
  const PERM_PILL_LABEL = Object.fromEntries(_permTileSpecs.map(s => [s.id, s.pill]));

  function rebuildPermissionModeUi() {
    const specs = permissionModeTileSpecs(undefined, { autoModeDisabled: context.state.autoModeDisabled === true });
    if (permModeSelect) {
      const prev = permModeSelect.value;
      permModeSelect.innerHTML = '';
      for (const s of specs) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.selectLabel; // CLI 原名，不 t()
        opt.disabled = s.disabled;       // 禁用之前就开在 Auto 的会话照常显示 Auto（程序设 value 不受 disabled 影响）
        permModeSelect.appendChild(opt);
      }
      if (prev && specs.some(s => s.id === prev)) permModeSelect.value = prev;
      else if (specs[0]) permModeSelect.value = specs[0].id;
    }
    if (customPermGrid) {
      customPermGrid.innerHTML = '';
      for (const s of specs) {
        const dangerCls = s.danger ? ' text-danger' : '';
        const titleCls = s.danger ? 'text-danger' : 'text-ink';
        const descCls = s.danger ? 'text-danger' : 'text-ink-soft'; // 原 text-red-500/80：Tailwind 原色叠透明度，浅 2.89 / 深 3.34（O102）
        // 元素是 <button> 而不是套了 class 的 <div>：这六张里有一张是 Bypass permissions
        // （绕过全部权限检查），而 div 版本 Tab 走不到、辅助技术不认得是控件、也读不出当前选的是哪档
        // （2026-08-26 探索性测试 VC-D4-03 实测：role/tabindex/aria-pressed 全为 null）。
        // 用原生 button 而不是 div+role+tabindex+键盘处理：焦点、Enter/Space 激活、焦点环全部白送，
        // 且下面那个 click 委托（closest('.perm-tile')）一行都不用改。
        // aria-pressed 是这组按钮的「选中态」——单选语义靠它播报，样式那圈 ring 只有看得见的人能用。
        // disabled（#461 settings 禁用了 auto）：原生 disabled 让它 Tab 不到、读屏报不可用；说明行已换成原因。
        const stateCls = s.disabled ? ' opacity-55 cursor-not-allowed' : ' active:bg-sunk cursor-pointer';
        const card = el(`
          <button type="button" data-mode="${esc(s.id)}" aria-pressed="false"${s.disabled ? ' disabled' : ''} class="perm-tile w-full text-left p-2 rounded-xl border border-line bg-surface transition-all${stateCls}${dangerCls}">
            <div class="text-xs font-semibold ${titleCls} leading-snug">${esc(s.title)}</div>
            <div class="text-[11px] ${descCls} mt-0.5 leading-snug line-clamp-2">${esc(s.desc)}</div>
          </button>
        `);
        customPermGrid.appendChild(card);
      }
      // 重建后按当前档重画选中框
      if (getCurrentPermMode()) setPermMode(getCurrentPermMode(), true);
    }
  }
  rebuildPermissionModeUi();

  function clearCliUnknownPermissionOption() {
    permModeSelect?.querySelector('option[data-cli-observed-unknown]')?.remove();
  }
  // ---- 底栏会话档摘要 chip title（与 compose 页 formatComposeDefaultsSummary 同源）----
  // 三段文案由 setPermMode / setEffortMode / syncModelUI 各自维护 pillXxxText；title 只拼不另算，
  // 避免 CLI 镜像 / 网关别名边上两套文案漂移。
  function syncDefaultsPillTitle() {
    if (!pillDefaults) return;
    const summary = formatComposeDefaultsSummary({
      modelLabel: (pillModelText?.textContent || '').trim(),
      modeLabel: (pillPermText?.textContent || '').trim(),
      effortLabel: pillEffort?.classList.contains('hidden')
        ? ''
        : (pillEffortText?.textContent || '').trim(),
    });
    pillDefaults.title = summary || t('会话设置');
  }

  function setPermMode(mode, silent = false) {
    if (!permModeSelect || !mode) return;
    clearCliUnknownPermissionOption();
    if (!silent && permModeSeen && mode !== getCurrentPermMode()) {
      // UX-019：空态不打条（胶囊高亮）；有消息后保留「权限档 → X」留痕
      addModeBar(`${t('权限档 →')} ${PERM_LABEL[mode] || mode}`,
        mode === 'bypassPermissions' ? 'text-danger' : 'text-ink-faint');
    }
    permModeSeen = true;
    setCurrentPermMode(mode);
    permModeSelect.value = mode;
    const danger = mode === 'bypassPermissions';
    permModeSelect.classList.toggle('ring-1', danger);
    permModeSelect.classList.toggle('ring-danger', danger);
    permModeSelect.classList.toggle('text-danger', danger);

    // Sync Pill Display Text（CLI 英文档名；Bypass 仅权限段标红，非整颗 chip）
    if (pillPermText) {
      pillPermText.textContent = PERM_PILL_LABEL[mode] || mode;
      const tone = pillPermTone(mode);
      pillPermText.classList.toggle('text-danger', tone === 'danger');
      pillPermText.classList.toggle('pill-perm-plan', tone === 'plan');
    }

    // Sync Custom Perm Tiles Selection Styling
    if (customPermGrid) {
      customPermGrid.querySelectorAll('.perm-tile').forEach(tile => {
        const isCurrent = tile.dataset.mode === mode;
        // 选中态有两条通道，必须一起更新：ring 那圈给看得见的人，aria-pressed 给读屏。
        // 只改样式的话，辅助技术用户读到的是六个一模一样的按钮、无从知道当前在哪一档。
        tile.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
        if (isCurrent) {
          tile.classList.add('ring-1', 'ring-accent', 'border-accent', 'bg-accent-wash/30');
          const title = tile.querySelector('.text-xs');
          if (title) title.classList.add('text-accent');
        } else {
          tile.classList.remove('ring-1', 'ring-accent', 'border-accent', 'bg-accent-wash/30');
          const title = tile.querySelector('.text-xs');
          if (title) title.classList.remove('text-accent');
        }
      });
    }
    syncDefaultsPillTitle();
    if (getComposeReady()) refreshComposeDefaultsSummary();
  }
  permModeSelect.onchange = async () => {
    // 单驾驶员：终端驾驶中（只读锁）设置一并冻结——权限档实际只作用于 web 自己的实例、碰不到终端进程，
    // 此刻切档只会造成「我切了怎么终端没变」的误解；接管后再调。拨回 select 防 UI 与实际档漂移。
    if (getMirrorReadonlySid()) { permModeSelect.value = getCurrentPermMode(); addBar(t('终端驾驶中，设置已冻结——接管后可调'), 'text-info'); return; }
    const mode = permModeSelect.value;
    if (mode === getCurrentPermMode()) return;
    // bypass 二次危险确认（终端等价：终端首次 bypass 亦需确认）；取消则回退 select
    if (mode === 'bypassPermissions' &&
        !(await appConfirm({
          title: t('⚠️ 切到 bypass（跳过所有审批）'),
          body: t('claude 将无需确认即可改文件、跑命令；一次提示注入即可波及整台机器。'),
          okText: t('开启 bypass'),
          tone: 'danger',
        }))) {
      permModeSelect.value = getCurrentPermMode();
      return;
    }
    socket.emit('user:setPermissionMode', { mode });
    // 不乐观更新：等 server 广播 permission_mode（成功回执，毫秒级）驱动 setPermMode 拨档 + 上屏；
    // 失败则 agent 发 error 红条且不广播，下轮 init 拨回 select
  };

  // ---- 思考强度切换（CLI /effort：五档 + ultracode + auto；切档=实例置换、下条消息生效）----
  // setEffortMode 仅由 effort_mode 服务端事件驱动（成功回执广播 / 拒切拨回单发），onchange 不乐观更新。
  // 后端可直接回 level=ultracode（Settings.ultracode 会话 flag），不再靠本地「只武装不重建」偷换。
  function setEffortMode(level, silent = false) {
    if (!effortSelect) return;
    const val = level || null; // 空串/undefined 归一为 null（没指定：CLI 按 settings / 模型默认继承）
    setUltracodeArmed(val === 'ultracode');
    if (!silent && effortSeen && val !== getCurrentEffort()) {
      addModeBar(`${t('思考强度 →')} ${val || t('CLI 默认')}${t('（下一条消息生效）')}`, 'text-ink-faint');
    }
    effortSeen = true;
    setCurrentEffort(val);
    // settings 来的档不算选中（不高亮、select 停在占位），候选就是 select 现有的选项
    const ui = effortUiState(val, [...effortSelect.options].map(o => o.value), {
      mirrorReadonly: Boolean(getMirrorReadonlySid()),
      effective: context.state.effortEffective,
      source: context.state.effortSource,
    });
    effortSelect.value = ui.selected;

    if (pillEffortText) pillEffortText.textContent = ui.label;

    if (customEffortGrid) {
      const activeLevel = ui.selected;
      customEffortGrid.querySelectorAll('.effort-tile').forEach(tile => {
        const tileVal = tile.dataset.level || '';
        const isCurrent = activeLevel === tileVal;
        // 选中态两条通道同 perm/model 磁贴：ring 给看得见的人，aria-pressed 给读屏（#403）
        tile.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
        if (isCurrent) {
          tile.classList.add('ring-1', 'ring-accent', 'border-accent', 'text-accent', 'bg-accent-wash/30');
          const title = tile.querySelector('.text-xs') || tile;
          title.classList.add('text-accent');
        } else {
          tile.classList.remove('ring-1', 'ring-accent', 'border-accent', 'text-accent', 'bg-accent-wash/30');
          const title = tile.querySelector('.text-xs') || tile;
          title.classList.remove('text-accent');
        }
      });
    }
    syncDefaultsPillTitle();
    if (getComposeReady()) refreshComposeDefaultsSummary();
  }
  // 把当前模型（init.model 规范名）桥接到 models 候选项（取其 supportedEffortLevels）。
  // 先精确 value 命中；否则 alias↔规范名桥接：剥 [Nm] 上下文后缀，候选别名作为 family 子串落在规范名里、
  // 且后缀一致（如 claude-opus-4-8[1m] ↔ opus[1m]）。纯从 SDK 列表派生，不硬编码任何模型名。
  // effort 档位按当前模型动态渲染（CLI/SDK 透传，不硬编码）：决策在 logic.js 的 effortLevelsFor，此处只渲染。
  // opts.silentClear：仅刷新面板显示、不得触发网络副作用——adoptPanelState 切 tab 查看别的（空闲）实例时传
  // true。根因：effort 只能在开实例时设定，之后随消息切模型不会跟着清空，二者可脱节而持久化仍非空；
  // 若在这里无脑 emit user:setEffort(null)，仅仅切一下 tab 查看就会让 server 判定档位不匹配、
  // 把一个空闲实例用户选好的档位清回 auto，只有真正的模型切换（onchange/tile 点击/`/model`）才该触发它。
  function rebuildEffortOptions(modelValue, opts) {
    if (!effortSelect) return;
    const silentClear = Boolean(opts?.silentClear);
    const { hidden, levels: baseLevels } = effortLevelsFor(modelValue, getModelsList());
    // xhigh-capable 模型上追加 ultracode 最高档，末位再追加 auto（= 模型默认），顺序同 CLI /effort
    const show = withAutoTier(withUltracodeTier(baseLevels));
    // 强度是所选模型的下级：标题挂上模型名，档位才有归属。用 displayName 而非裸 value，
    // 与模型磁贴主标题同源。空 modelValue（CLI「不 pin」）回落到 cwd 默认/当前模型——部分调用点
    // 已自带这个回落，这里统一兜一次，免得某条路径漏了就显示成无主的档位。
    const ownerLabel = modelLabelFor(modelValue || getCwdDefaultModel() || getCurrentModel(), getModelsList());
    if (effortOwnerModel) effortOwnerModel.textContent = ownerLabel;
    effortOwnerWrap?.classList.toggle('hidden', !ownerLabel);
    effortOwnerWrap?.classList.toggle('inline-flex', Boolean(ownerLabel));
    if (hidden) {
      // 候选明确声明该模型不支持 effort（区别于“当前 CLI 档未知”）：Web 驾驶时把实例档清回
      // model-default，等服务端 effort_mode 回执再更新 currentEffort；CLI 镜像只读态绝不写回。
      if (!silentClear && !getMirrorReadonlySid() && getCurrentEffort() !== null) socket.emit('user:setEffort', { level: null });
      // 连 option 一起清：只置 value 的话，上个模型的候选还留着，随后到达的 effort_mode 回执经
      // setEffortMode 能把 value 设回其中一档——不支持调档的模型上凭空冒出一个档（CI 上撞过）。
      effortSelect.innerHTML = '';
      if (customEffortGrid) customEffortGrid.innerHTML = '';
      effortRow?.classList.add('hidden');
      pillEffort?.classList.add('hidden');
      // 整段不再消失——凭空少一栏用户只会以为界面坏了。就地说明「这个模型没有这档可调」，
      // 底栏 pill 仍隐藏（确实没有档位可显示，留个空 chip 反而是噪音）。
      customEffortGroup?.classList.remove('hidden');
      if (effortUnsupported) {
        effortUnsupported.textContent = ownerLabel
          ? `${ownerLabel}${t(' 不支持调节思考强度，按模型默认执行。')}`
          : t('当前模型不支持调节思考强度，按模型默认执行。');
        effortUnsupported.classList.remove('hidden');
      }
      syncDefaultsPillTitle();
      return;
    }
    effortRow?.classList.remove('hidden');
    pillEffort?.classList.remove('hidden');
    customEffortGroup?.classList.remove('hidden');
    effortUnsupported?.classList.add('hidden');

    // 候选列表只决定「能选什么」，不得改写当前档事实。CLI 镜像拿不到档位时保留 null/未知，
    // 不能因为候选第一项是 low 就谎报 low；FRESH settings=low 会由服务端明确下发，仍正常选中。
    const ui = effortUiState(getCurrentEffort(), show, {
      mirrorReadonly: Boolean(getMirrorReadonlySid()),
      effective: context.state.effortEffective,
      source: context.state.effortSource,
    });
    effortSelect.innerHTML = '';
    if (!ui.selected && !getUltracodeArmed()) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = ui.placeholder;
      placeholder.disabled = true;
      effortSelect.appendChild(placeholder);
    }
    for (const lv of show) {
      const o = document.createElement('option');
      o.value = lv;
      o.textContent = lv;
      effortSelect.appendChild(o);
    }
    effortSelect.value = getUltracodeArmed() ? 'ultracode' : ui.selected;

    if (customEffortGrid) {
      customEffortGrid.innerHTML = '';
      const currentVal = getUltracodeArmed() ? 'ultracode' : (effortSelect.value || '');
      for (const lv of show) {
        const active = currentVal === lv;
        const isUltra = lv === 'ultracode';
        // UX-014：副文案增量信息，非「思考等级: low」同义反复
        const sub = effortLevelSubtitle(lv) || (isUltra ? t('xhigh + 多 agent · 最彻底') : '');
        // 原生 button + aria-pressed：与 .perm-tile / .model-tile 对齐，Tab 可达、读屏能报选中态（#403）。
        // 故意不加 w-full：#customEffortGrid 是 flex-wrap 芯片行；w-full 会竖排撑高，把权限尾格挤出首屏（P0-09r）。
        const lvTile = el(`
          <button type="button" data-level="${esc(lv)}" aria-pressed="${active ? 'true' : 'false'}" class="effort-tile text-left p-2 rounded-xl border border-line bg-surface active:bg-sunk cursor-pointer transition-all ${active ? 'ring-1 ring-accent border-accent text-accent bg-accent-wash/30' : ''}">
            <div class="text-xs font-semibold ${active ? 'text-accent' : 'text-ink'}">${esc(lv)}</div>
            ${sub ? `<div class="text-xs text-ink-soft mt-0.5">${esc(sub)}</div>` : ''}
          </button>
        `);
        lvTile.onclick = () => {
          haptic('tap');
          effortSelect.value = lv;
          effortSelect.onchange();
        };
        customEffortGrid.appendChild(lvTile);
      }
    }
    // 同步 pill 文案（没指定显「CLI 默认」，已知实际档时带上它）
    if (pillEffortText) {
      pillEffortText.textContent = getUltracodeArmed() ? 'ultracode' : ui.label;
    }
    syncDefaultsPillTitle();
    if (getComposeReady()) refreshComposeDefaultsSummary();
  }
  effortSelect.onchange = () => {
    // 单驾驶员：终端驾驶中设置冻结（同 permModeSelect.onchange）——effort 切档还会 dispose+重开实例。
    if (getMirrorReadonlySid()) { effortSelect.value = getCurrentEffort() || ''; addBar(t('终端驾驶中，设置已冻结——接管后可调'), 'text-info'); return; }
    // 原样发 UI 档（含 ultracode）；server 映射 xhigh+Settings.ultracode 并置换实例。xhigh↔ultracode 也必须重建。
    // auto 原样发（服务端映射成 effortLevel:null 控制请求）；它不是 null——null 是「没指定」。
    const uiLevel = effortSelect.value || null;
    // settings 来的档点同一档不是空操作：用户要把它钉成自己的选择（服务端只改来源，不动实例）
    if (uiLevel === getCurrentEffort() && context.state.effortSource !== 'cli-settings') return;
    socket.emit('user:setEffort', { level: uiLevel });
    // 不做乐观提示：前端预知不了服务端走轻路径（控制请求、不续接会话）还是重路径（dispose+resume），
    // 而这里唯一能写的文案必然在其中一半场景下说谎。两条路径服务端都有回执——轻路径广播
    // effort_mode（由 setEffortMode 上屏），重路径先发 system/resuming，失败发红条。
  };

  return { checkAtMention, clearCliUnknownPermissionOption, hints, rebuildCustomModelGrid, rebuildEffortOptions, rebuildPermissionModeUi, setEffortMode, setPermMode, syncDefaultsPillTitle, syncModelGridEmptyHint, syncModelUI, updateModelAndSuffix, updatePillSession };
}
