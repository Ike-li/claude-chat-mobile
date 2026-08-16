import { t } from '../i18n.js';

// 两级删除会话
// L1=从产品移除（session:delete，transcript 保留）；L2=彻底删底层文件（session:deletePermanent，二次确认）。
// 只对「未打开的历史会话」提供入口（见 sessionRow）——已打开的会话先关闭 tab 再删，避免删一个正被本产品
// 驱动的会话（后端 L2 保护①也会拒，但前端不给入口更清晰）。
//
// deleteTarget 是本模块私有：此前它是 app.js 顶层的一个 let，而唯一读写它的就是本文件这几个 handler。
export function createSessionDeleteController(context, {
  $: byId,
  socket,
  addBar = () => {},
  appConfirm = async () => false,
  openSheet = () => {},
  closeSheet = () => {},
  onDeleted = () => {},
} = {}) {
  const deleteSessionModal = byId('deleteSessionModal'), deleteSessionTitle = byId('deleteSessionTitle');
  const deleteL1Btn = byId('deleteL1Btn'), deleteL2Btn = byId('deleteL2Btn');
  const deleteSessionCancel = byId('deleteSessionCancel');

  let deleteTarget = null; // { sessionId, cwd, title }

  function openDeleteSession(sessionId, cwd, title) {
    deleteTarget = { sessionId, cwd, title };
    deleteSessionTitle.textContent = title || sessionId;
    openSheet(deleteSessionModal);
  }

  if (deleteSessionCancel) deleteSessionCancel.onclick = () => { deleteTarget = null; closeSheet(deleteSessionModal); };
  if (deleteL1Btn) deleteL1Btn.onclick = () => {
    if (!deleteTarget) return;
    // 局部变量不叫 t：i18n 的 t() 在本文件里到处都要用，同名会静默遮蔽成「t is not a function」，
    // 而 ESLint 看不出问题（t 确实有定义）。
    const target = deleteTarget; deleteTarget = null;
    closeSheet(deleteSessionModal);
    socket.emit('session:delete', { sessionId: target.sessionId, cwd: target.cwd }, res => {
      if (res?.ok) { addBar(`${t('已从列表移除：')}${target.title || target.sessionId}`, 'text-ink-faint'); onDeleted(); }
      else addBar(res?.error || t('移除失败'), 'text-danger');
    });
  };
  if (deleteL2Btn) deleteL2Btn.onclick = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    // L2 显式二次确认（"显式二次确认删底层 transcript 文件"）——不可恢复，故在 L1 一级弹窗之上再加一道（z-50 叠 z-40，取消回到删除 sheet）。
    if (!(await appConfirm({
      title: t('🗑 彻底删除底层文件？'),
      body: `${t('会话「')}${target.title || target.sessionId}${t('」在主机上的记录将被真正抹除。')}\n${t('此操作不可恢复。')}`,
      okText: t('彻底删除'),
      tone: 'danger',
    }))) return;
    deleteTarget = null;
    closeSheet(deleteSessionModal);
    socket.emit('session:deletePermanent', { sessionId: target.sessionId, cwd: target.cwd }, res => {
      if (res?.ok) { addBar(`${t('已彻底删除：')}${target.title || target.sessionId}`, 'text-ink-faint'); onDeleted(); }
      else addBar(res?.error || t('彻底删除失败'), 'text-danger');
    });
  };

  const controller = { openDeleteSession };
  context.state.sessionDelete = controller;
  return controller;
}
