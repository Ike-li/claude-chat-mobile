import { t } from '../i18n.js';

// `/rewind` 面板 —— 对齐终端 /rewind 的两步交互。
//
// 第一步「回到哪一轮之前」：列出每一轮人类 prompt，标出这一轮动过几个文件。
// 第二步「怎么回退」：三个模式，与终端同名同序
//   1. Restore code and conversation · 2. Restore conversation · 3. Restore code
// （终端还有 4/5 两个 Summarize，那属于压缩不是回退，本面板不列——不做假选项。）
//
// 【为什么是斜杠命令而不是长按气泡】原入口是长按 user 气泡弹二选一，2026-09-20 撤掉：
// 长按是隐藏手势，发现不了；而回退在终端里本来就有名字（/rewind），照搬过来用户不用学新东西。
// 与 /model 同一条路数——TUI 命令不可透传给 SDK（非交互，出不来选择界面），前端本地拦截后
// 自己画界面，最后落到既有的 session:rewind:preview / confirm 上。
//
// 【第一步不逐条调 preview】清单里每条的「动过几个文件」来自 transcript 自带的
// file-history-snapshot（服务端 listRewindCandidates 算好），不是 N 次 rewindFiles dryRun——
// 那是 N 个 SDK 控制请求，列个清单不该付这个代价。preview 只在选中某一轮后发一次。
export function createRewindCommandController(context, {
  $: byId,
  socket,
  openSheet = () => {},
  closeSheet = () => {},
  // 失败不走 addBar：面板是 sheet，消息流被它盖住，写进去用户一眼都看不到
  // （2026-09-12 抽屉删会话撞过同款）。失败一律留在面板里说。
  //
  // 面板开着时用户可能切走会话（instances 广播会改 displayedSessionId）。确认前比对一次：
  // 拿打开面板时冻结的 sessionId 继续做，等于对一个用户已经不在看的会话执行破坏性操作。
  getCurrentSession = () => ({ sessionId: null, cwd: null }),
  onRewound = () => {},
} = {}) {
  const modal = byId('rewindModal');
  const listEl = byId('rewindList');
  const step2El = byId('rewindStep2');
  const titleEl = byId('rewindTitle');
  const hintEl = byId('rewindHint');
  const pickedEl = byId('rewindPicked');
  const effectEl = byId('rewindEffect');
  const footnoteEl = byId('rewindFootnote');
  const backBtn = byId('rewindBack');
  const cancelBtn = byId('rewindCancel');
  const modeBoth = byId('rewindModeBoth');
  const modeConversation = byId('rewindModeConversation');
  const modeCode = byId('rewindModeCode');

  // 本面板自己的瞬时态。不落 app.js 顶层作用域（CLAUDE.md 的模块化约定）。
  let picked = null;        // 选中的候选项
  let session = null;       // { sessionId, cwd } —— 打开面板那一刻冻结，避免中途切会话打到别的会话上
  let busy = false;         // confirm 在飞：防连击（服务端 G3 也有锁，这里是少发一次请求）
  let items = [];           // 当前清单：返回上一步要重渲它，选中某条时正文/文件数也直接取自它

  function emitAsync(event, payload) {
    return new Promise(resolve => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      socket.emit(event, payload, done);
      setTimeout(() => done({ ok: false, error: t('请求超时，请重试') }), 20000);
    });
  }

  function close() {
    closeSheet(modal);
    picked = null; session = null; busy = false;
  }

  function showStep1() {
    picked = null;
    listEl.classList.remove('hidden');
    step2El.classList.add('hidden');
    backBtn.classList.add('hidden');
    titleEl.textContent = t('回退');
    hintEl.textContent = t('把代码和/或对话恢复到某条消息发出之前……');
  }

  function renderList(list) {
    items = list || [];
    if (!items.length) {
      listEl.innerHTML = `<div class="text-sm text-ink-soft py-6 text-center">${t('这个会话还没有可回退的轮次')}</div>`;
      return;
    }
    // 倒序：最近的在最上面。终端里光标默认停在末尾的 (current)，手机上没有光标概念，
    // 改成「最近的排最前」——要回退的多半是刚说过的那几句。
    listEl.innerHTML = items.slice().reverse().map(item => {
      // 只有两个轴都不行才整条置灰。首轮不能分叉对话（之前没有可保留的锚点），但文件快照照样
      // 能还原，所以它仍然可选——进去之后由第二步把「分叉」相关的模式禁掉。
      const disabled = !item.canForkConversation && !item.canRestoreCode;
      // changedFiles=null 是「未知」而不是 0：最后一轮的改动还没有下一个 snapshot 来反映，
      // 报「无代码改动」会把「改了一堆」说成没改。准确值由第二步的 preview 给。
      const changed = item.changedFiles == null
        ? `<span class="text-ink-soft">${t('代码改动待确认')}</span>`
        : item.changedFiles > 0
          ? `<span class="text-accent-deep">${item.changedFiles} ${t('个文件改动')}</span>`
          : `<span class="text-ink-soft">${t('无代码改动')}</span>`;
      const reason = !item.canForkConversation
        ? `<div class="text-xs text-ink-soft mt-0.5">${t('会话首轮，只能恢复代码')}</div>` : '';
      return `<div class="py-2.5 border-b border-line ${disabled ? 'opacity-40' : 'active:bg-sunk cursor-pointer'}"
        ${disabled ? '' : `data-uuid="${escapeAttr(item.promptUuid)}"`}>
        <div class="text-sm text-ink break-words line-clamp-2">${escapeHtml(item.text) || `<em class="text-ink-soft">${t('（空消息）')}</em>`}</div>
        <div class="text-xs mt-1">${changed}</div>
        ${reason}
      </div>`;
    }).join('');
  }

  // 面板里的候选正文来自 transcript，是用户自己写的文本——按 HTML 注入处理，不信任。
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  async function openPanel(sessionId, cwd) {
    if (!modal) return;
    session = { sessionId, cwd };
    showStep1();
    listEl.innerHTML = `<div class="text-sm text-ink-soft py-6 text-center">${t('正在读取会话…')}</div>`;
    openSheet(modal);
    const res = await emitAsync('session:rewind:candidates', { sessionId, cwd });
    // await 期间用户可能已经关掉面板或切了会话——旧结果不得覆盖新状态。
    if (!session || session.sessionId !== sessionId) return;
    if (!res?.ok) {
      listEl.innerHTML = `<div class="text-sm text-danger py-6 text-center">${escapeHtml(res?.error || t('读取失败'))}</div>`;
      return;
    }
    renderList(res.items || []);
  }

  async function pick(uuid) {
    const item = items.find(i => i.promptUuid === uuid);
    picked = item || { promptUuid: uuid, text: '', changedFiles: 0 };
    listEl.classList.add('hidden');
    step2El.classList.remove('hidden');
    backBtn.classList.remove('hidden');
    titleEl.textContent = t('回退');
    hintEl.textContent = t('确认要恢复到这条消息发出之前：');
    pickedEl.textContent = picked.text || t('（空消息）');
    effectEl.textContent = t('正在计算影响面…');
    footnoteEl.textContent = t('回退不影响手动或通过 bash 改过的文件。');
    setModeButtons(false);

    const res = await emitAsync('session:rewind:preview', {
      sessionId: session.sessionId, cwd: session.cwd, promptUuid: uuid,
    });
    if (!picked || picked.promptUuid !== uuid) return; // 已经返回上一步或换了一条
    if (!res?.ok) {
      effectEl.innerHTML = `<span class="text-danger">${escapeHtml(res?.error || t('无法读取回退预览'))}</span>`;
      setModeButtons(false);
      return;
    }
    // canRewind=false 有两种成因：这一轮没往盘上写过东西（no-file-changes），或找不到这条消息的
    // 文件快照（no-checkpoint）。旧的长按入口在这里只回一句「没有可回退的文件改动」就结束了——
    // 真机实测用户连点 6 次，每次同一句话、界面上没有任何下一步。出路一直都在：对话轴不要求有
    // 文件改动。所以这里不再整体拒绝，只把两个要动文件的模式置灰，「只恢复对话」照常可选。
    const canCode = res.canRewind !== false;
    const files = Array.isArray(res.filesChanged) ? res.filesChanged : [];
    // 第一行永远说清 fork 语义（终端同一位置写的是 "The conversation will be forked."）：
    // 这是本方案区别于原地截断的核心——原会话一个字节不动，用户据此知道回退不是不可逆的。
    const forkLine = `<div>${t('对话将分叉出新会话，原会话完整保留。')}</div>`;
    let codeLine;
    if (!canCode) {
      codeLine = res.reason === 'no-checkpoint'
        ? t('找不到这一轮的文件快照，只能恢复对话。')
        : t('这一轮没有代码改动，只能恢复对话。');
    } else if (files.length) {
      const shown = files.slice(0, 3).map(escapeHtml).join('、');
      codeLine = `${t('将恢复')} ${files.length} ${t('个文件：')}${shown}${files.length > 3 ? '…' : ''}`;
      // G5：工作区里有会被这次回退覆盖的未提交改动。警告必须摆在【选模式之前】——
      // 事后再说就晚了，那些改动已经没了。
      const dirty = Array.isArray(res.dirtyOverlap) ? res.dirtyOverlap : [];
      if (dirty.length) {
        codeLine += `<div class="text-danger mt-1">${t('其中')} ${dirty.length} ${t('个文件有未提交的改动，回退会覆盖它们：')}`
          + `${dirty.slice(0, 3).map(escapeHtml).join('、')}${dirty.length > 3 ? '…' : ''}</div>`;
      }
    } else {
      codeLine = t('这一轮没有代码改动。');
    }
    effectEl.innerHTML = `${forkLine}<div class="mt-1">${codeLine}</div>`;
    // 对话轴以 preview 的回答为准（清单那份是同源算的，但 preview 更晚、更权威）。
    setModeButtons(true, canCode, res.canForkConversation !== false && picked.canForkConversation !== false);
  }

  // enabled=整体可用（preview 回来了、confirm 不在飞）
  // codeEnabled=这一轮有没有可还原的文件；forkEnabled=这一轮能不能分叉对话（首轮不能）。
  // 两个轴分开禁：首轮仍可「只恢复代码」，而没有文件改动的轮次仍可「只恢复对话」。
  function setModeButtons(enabled, codeEnabled = true, forkEnabled = true) {
    const set = (b, on) => {
      if (!b) return;
      b.disabled = !on;
      b.classList.toggle('opacity-40', !on);
    };
    set(modeConversation, enabled && forkEnabled);
    set(modeBoth, enabled && codeEnabled && forkEnabled);
    set(modeCode, enabled && codeEnabled);
  }

  async function confirm(mode) {
    if (!picked || !session || busy) return;
    // 面板开着的这段时间里会话被切走了 → 拒绝。冻结的锚点属于上一个会话，对当前这个执行
    // 破坏性操作是意外；成功路径早有同款校验，这里不能因为入口换了就少一道。
    // 【包括 null 也要比】原先写的是 `now?.sessionId && ...`，于是用户切回首页/新会话面
    // （displayedSessionId 变成 null）时条件短路、守卫整个失效，仍会对冻结的旧会话执行破坏性
    // 回退。判据是「当前看的还是不是那个会话」，null 同样是「不是」（PR #102 review）。
    const now = getCurrentSession();
    if ((now?.sessionId ?? null) !== session.sessionId) {
      effectEl.innerHTML = `<span class="text-danger">${escapeHtml(t('会话已切换，回退已取消，请重新发起'))}</span>`;
      setModeButtons(false);
      return;
    }
    busy = true;
    setModeButtons(false);
    const res = await emitAsync('session:rewind:confirm', {
      sessionId: session.sessionId, cwd: session.cwd, promptUuid: picked.promptUuid, mode,
    });
    busy = false;
    if (!res?.ok) {
      // 失败留在面板里说，不写进被 sheet 盖住的消息流（2026-09-12 的教训：
      // 操作在哪一层发起，回执就得在哪一层）。
      effectEl.innerHTML = `<span class="text-danger">${escapeHtml(res?.error || t('回退失败'))}</span>`;
      setModeButtons(true);
      return;
    }
    close();
    onRewound(res);
  }

  function bind() {
    if (!modal) return;
    listEl?.addEventListener('click', e => {
      const row = e.target.closest('[data-uuid]');
      if (row) pick(row.dataset.uuid);
    });
    backBtn?.addEventListener('click', () => { showStep1(); renderList(items); });
    cancelBtn?.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modeBoth?.addEventListener('click', () => confirm('code_and_conversation'));
    modeConversation?.addEventListener('click', () => confirm('conversation'));
    modeCode?.addEventListener('click', () => confirm('code'));

    modeBoth.textContent = t('恢复代码和对话');
    modeConversation.textContent = t('只恢复对话');
    modeCode.textContent = t('只恢复代码');
  }

  bind();
  return { openPanel, close };
}
