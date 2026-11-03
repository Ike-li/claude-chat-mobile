import { t } from '../i18n.js';

// 给会话改名（#458），对应终端 /rename：抽屉会话行「⋯」→「重命名」，sheet 里预填当前标题。
// 服务端 session:rename 走 SDK renameSession（往 transcript 尾追加 custom-title），清洗与校验以服务端为准；
// 这里只挡「空着点保存」。失败原因写在 sheet 里、不关 sheet，用户改完能直接再存——
// 抽屉开着时消息流整个被遮罩盖住，写到别处等于没说（同 session-delete.js 头注那次真机教训）。
// 成功后交回 onRenamed：抽屉怎么刷新、终端可能盖回去的提示放哪，由调用方决定。
const RENAME_ACK_TIMEOUT_MS = 10_000;

export function createSessionRenameController(context, {
  $: byId,
  socket,
  openSheet,
  closeSheet,
  onRenamed = () => {},
} = {}) {
  const modal = byId('sessionRenameModal');
  const input = byId('sessionRenameInput');
  const errorEl = byId('sessionRenameError');
  const saveBtn = byId('sessionRenameSave');
  let target = null; // { sessionId, cwd, sectionKey }
  let saving = false;

  const showError = text => {
    errorEl.textContent = text || '';
    errorEl.classList.toggle('hidden', !text);
  };
  const syncSave = () => { saveBtn.disabled = saving || !input.value.trim(); };
  const close = () => {
    target = null;
    if (modal.classList.contains('sheet-open')) closeSheet(modal);
  };

  function save() {
    if (!target || saving || !input.value.trim()) return;
    const request = target;
    const { sessionId, cwd, sectionKey } = request;
    saving = true;
    syncSave();
    showError('');
    socket.timeout(RENAME_ACK_TIMEOUT_MS).emit('session:rename', { sessionId, cwd, title: input.value }, (err, res) => {
      // 等回执期间 sheet 被关掉、或又给别的会话打开了（open 换了 target）：结果不再碰眼前这张 sheet。
      // 改名成功照样交给 onRenamed——服务端确实改了，抽屉得跟上
      const current = target === request;
      if (current) { saving = false; syncSave(); }
      if (err || !res?.ok) {
        if (current) showError(err ? t('改名无响应，请稍后再试') : (res?.error || t('改名失败')));
        return;
      }
      if (current) close();
      onRenamed({ sessionId, cwd, sectionKey, title: res.title, terminalMayOverwrite: res.terminalMayOverwrite === true });
    });
  }

  byId('sessionRenameCancel').addEventListener('click', close);
  saveBtn.addEventListener('click', save);
  input.addEventListener('input', () => { showError(''); syncSave(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); }
  });
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  // sectionKey：这一行所在的抽屉小节（worktree / scratch 会话的 cwd 是成员目录，不是小节的键）
  function open({ sessionId, cwd, title, sectionKey = cwd }) {
    target = { sessionId, cwd, sectionKey };
    saving = false;
    input.value = title || '';
    showError('');
    syncSave();
    openSheet(modal);
    input.focus();
    input.select();
  }

  const controller = { open };
  context.state.sessionRename = controller;
  return controller;
}
