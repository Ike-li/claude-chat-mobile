import { t } from '../i18n.js';

// 彻底删除会话（原两级删除的 L2）。
// 只对「未打开的历史会话」提供入口（见 sessionRow）——已打开的会话先关闭 tab 再删，避免删一个正被本产品
// 驱动的会话（后端保护①也会拒，但前端不给入口更清晰）。
//
// 2026-08-26：砍掉 L1「从列表移除」软隐藏——它制造 CLI/web 不等价，且产品内无反隐藏入口。
// 现在 🗑 直接走 appConfirm → session:deletePermanent。
export function createSessionDeleteController(context, {
  socket,
  addBar = () => {},
  appConfirm = async () => false,
  onDeleted = () => {},
} = {}) {
  async function openDeleteSession(sessionId, cwd, title) {
    const label = title || sessionId;
    if (!(await appConfirm({
      title: t('🗑 删除会话？'),
      body: `${t('会话「')}${label}${t('」在主机上的记录将被真正抹除。')}\n${t('此操作不可恢复。')}`,
      okText: t('彻底删除'),
      tone: 'danger',
    }))) return;
    socket.emit('session:deletePermanent', { sessionId, cwd }, res => {
      if (res?.ok) {
        addBar(`${t('已彻底删除：')}${label}`, 'text-ink-faint');
        onDeleted({ sessionId, cwd });
      } else {
        addBar(res?.error || t('彻底删除失败'), 'text-danger');
      }
    });
  }

  const controller = { openDeleteSession };
  context.state.sessionDelete = controller;
  return controller;
}
