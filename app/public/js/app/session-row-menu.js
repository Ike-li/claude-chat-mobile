// 抽屉会话行「⋯」的底部菜单（2026-10-25，对齐桌面端 SessionDropdownMenu）。一行只剩这一个入口：
// 此前的 ✕、🗑 与红色侧滑「关闭」三处并存，侧滑还和抽屉自己的左滑收起抢同一次手势。
// 菜单里有哪些项由 logic 的 sessionRowMenuItems 算，本模块只管画进 #sessionMenuModal、点了交回调用方。
//
// 先收菜单再交回：关闭 / 删除接着要开确认 sheet，菜单若还开着，确认答完焦点会还给一个已经没用的菜单。
export function createSessionRowMenu(context, {
  $: byId,
  el,
  openSheet,
  closeSheet,
} = {}) {
  const modal = byId('sessionMenuModal');
  const titleEl = byId('sessionMenuTitle');
  const list = byId('sessionMenuItems');

  const close = () => { if (modal.classList.contains('sheet-open')) closeSheet(modal); };
  byId('sessionMenuCancel').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  function itemButton(item, onSelect) {
    // 灰掉的项照样画出来并写明原因（同桌面端的 disabled + description）：藏起来用户不知道怎样才能用
    const btn = el(`<button type="button" class="w-full text-left p-2.5 rounded-xl border border-line bg-surface text-sm${item.disabled ? ' cursor-not-allowed' : ' active:bg-sunk'}"></button>`);
    btn.dataset.menuAction = item.action;
    btn.disabled = Boolean(item.disabled);
    const label = el(`<span class="font-semibold block${item.disabled ? ' text-ink-faint' : item.danger ? ' text-danger' : ' text-ink'}"></span>`);
    label.textContent = item.label;
    btn.appendChild(label);
    if (item.hint) {
      const hint = el('<span class="text-xs text-ink-soft block" data-testid="session-menu-hint"></span>');
      hint.textContent = item.hint;
      btn.appendChild(hint);
    }
    btn.addEventListener('click', () => { close(); onSelect(item.action); });
    return btn;
  }

  function open({ title, items, onSelect }) {
    titleEl.textContent = title;
    list.replaceChildren(...items.map(item => itemButton(item, onSelect)));
    openSheet(modal);
  }

  const controller = { open };
  context.state.sessionRowMenu = controller;
  return controller;
}
