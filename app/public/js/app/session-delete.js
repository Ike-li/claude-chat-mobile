import { t } from '../i18n.js';

// 彻底删除会话（原两级删除的 L2）。
// 只对「未打开的历史会话」提供入口（见 sessionRow）——已打开的会话先关闭 tab 再删，避免删一个正被本产品
// 驱动的会话（后端保护①也会拒，但前端不给入口更清晰）。
//
// 2026-08-26：砍掉 L1「从列表移除」软隐藏——它制造 CLI/web 不等价，且产品内无反隐藏入口。
// 现在 🗑 直接走 appConfirm → session:deletePermanent。
//
// 成功与失败走【两条不同的反馈通道】，这是有意的，不是不一致：
//   成功 → addBar（聊天消息流）。抽屉里那一行当场消失已经是回答，消息流那条是留给关掉抽屉之后的账。
//   失败 → showDrawerNotice（抽屉内）。🗑 只在抽屉里存在，而抽屉打开时 #sidebarScrim
//          （fixed inset-0 z-30）盖住整个视口——写进消息流的失败提示用户一眼都看不到。
//          2026-09-12 真机撞上的就是这个：后端 5 分钟静默期保护正常拒绝了，用户只看到"点了没反应"。
export function createSessionDeleteController(context, {
  socket,
  addBar = () => {},
  showDrawerNotice = () => {},
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
        showDrawerNotice(res?.error || t('彻底删除失败'));
      }
    });
  }

  const controller = { openDeleteSession };
  context.state.sessionDelete = controller;
  return controller;
}
