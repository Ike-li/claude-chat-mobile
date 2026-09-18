// app/general-nav.js —— 通用设置面板的两级导航（L1 目录 ↔ 6 个 L2 页）。
//
// 【为什么要两级】
// 平铺到九组之后，面板必须靠一排 sticky 分段 chip 才能导航——那是「一个容器装不下了」的症状，
// 不是一个功能。两级之后 L1 只有 6 行、一眼扫完；每行的副标题由 logic/general-nav.js 从当前状态
// 算出，不再是会漂的功能枚举（旧的那四个词上线后已有两个和真实组标题对不上）。
//
// 【职责边界】
// 本模块只管「显示哪一层、标题写什么、行点了去哪」。每个 L2 页**内部**的渲染仍归各自原有的
// 接线（renderPushStatusRow / renderTrustedDevices / renderHooksBridge…），一个字都没搬——
// 那些函数按 id 找元素，而 id 在改版里逐字保留了。
//
// 【与 createSettingsController 的关系】
// 那个控制器只管开合手势与滚动锁，认的是 `body` 一个 DOM key，不碰内容结构。所以两级导航
// 完全长在它内部，二者零耦合。

import { t } from '../i18n.js';
import { summarizeGeneralNav, GENERAL_NAV_IDS } from '../logic/general-nav.js';

const PAGE_ATTR = 'data-general-page';

export function createGeneralNav({
  doc = typeof document !== 'undefined' ? document : null,
  // 取当前状态算 L1 摘要。由 app.js 注入——本模块不持有任何应用状态。
  state = () => ({}),
  // 切进某一页时的钩子：有些页要「每次进来重算」（如 host 页的服务状态）。
  onEnterPage = () => {},
  haptic = () => {},
} = {}) {
  const $ = id => doc?.getElementById(id) || null;
  const pages = () => Array.from(doc?.querySelectorAll(`[${PAGE_ATTR}]`) || []);

  // 当前层：null = L1 目录，否则是某个 L2 页的 id。
  let current = null;

  function applyHeader(pageId) {
    const back = $('generalBack');
    const title = $('generalSheetTitle');
    const sub = $('generalSheetSub');
    if (!pageId) {
      back?.classList.add('hidden');
      if (title) title.textContent = `⚙️ ${t('设置与状态')}`;
      if (sub) {
        sub.textContent = t('下拉或点外侧关闭 · 不含本会话的模型与权限');
        sub.classList.remove('hidden');
      }
      return;
    }
    const row = summarizeGeneralNav(state()).find(r => r.id === pageId);
    back?.classList.remove('hidden');
    if (title) title.textContent = row ? `${row.icon} ${row.title}` : t('设置与状态');
    // L2 里副标题让位给返回键与页名：那句「下拉或点外侧关闭」是 L1 的操作提示，
    // 在子页里重复一遍只会占掉本就紧张的标题栏高度。
    if (sub) sub.classList.add('hidden');
  }

  /** 回到 L1 目录（每次打开面板都从这里开始）。 */
  function showHome() {
    current = null;
    for (const p of pages()) p.classList.add('hidden');
    $('generalNavHome')?.classList.remove('hidden');
    applyHeader(null);
    render();
    // 切层后滚回顶部：L2 页可能被滚到过底部，返回时若不复位，L1 会停在一片空白上。
    const body = $('generalSheetBody');
    if (body) body.scrollTop = 0;
  }

  /**
   * 切到某个 L2 页。
   * @param {string} pageId GENERAL_NAV_IDS 之一
   * @param {{anchor?: string}} [opts] anchor = 切完后滚到的元素 id（深链用）
   */
  function showPage(pageId, { anchor = null } = {}) {
    if (!GENERAL_NAV_IDS.includes(pageId)) return false;
    const target = doc?.getElementById(`generalPage-${pageId}`);
    if (!target) return false;
    current = pageId;
    $('generalNavHome')?.classList.add('hidden');
    for (const p of pages()) p.classList.toggle('hidden', p !== target);
    applyHeader(pageId);
    const body = $('generalSheetBody');
    if (body) body.scrollTop = 0;
    onEnterPage(pageId);
    if (anchor) {
      // 等切层与该页自己的动态段渲染完再滚，否则 bounding box 还是 0（同 applyGeneralScrollTarget 的教训）
      requestAnimationFrame(() => requestAnimationFrame(() => {
        doc?.getElementById(anchor)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }));
    }
    return true;
  }

  /** 重画 L1 六行。摘要是活数据，任何状态变化后都可以再调一次。 */
  function render() {
    const host = $('generalNavRows');
    if (!host) return;
    const rows = summarizeGeneralNav(state());
    host.replaceChildren();
    for (const row of rows) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'w-full flex items-center gap-2.5 p-2.5 rounded-xl border border-line bg-surface active:bg-sunk transition-all text-left';
      btn.dataset.navTo = row.id;
      btn.setAttribute('data-testid', `general-nav-${row.id}`);

      const icon = doc.createElement('span');
      icon.className = 'text-base shrink-0 w-5 text-center';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = row.icon;

      const group = doc.createElement('span');
      group.className = 'flex-1 min-w-0';
      const title = doc.createElement('span');
      title.className = 'block text-[13px] font-semibold text-ink';
      title.textContent = row.title;
      const summary = doc.createElement('span');
      summary.className = 'block text-[11px] text-ink-faint mt-0.5 leading-snug';
      // 摘要是动态文案，textContent 插值同现有行渲染惯例（CSP 安全）
      summary.textContent = row.summary;
      group.append(title, summary);

      btn.append(icon, group);
      if (row.dot) {
        const dot = doc.createElement('span');
        dot.className = 'w-1.5 h-1.5 rounded-full bg-danger shrink-0';
        dot.setAttribute('data-testid', `general-nav-dot-${row.id}`);
        btn.appendChild(dot);
      }
      const arrow = doc.createElement('span');
      arrow.className = 'text-ink-faint shrink-0';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '→';
      btn.appendChild(arrow);

      host.appendChild(btn);
    }
  }

  function bind() {
    // 行点击用事件委托：render() 每次重建按钮，逐个绑会在重画后失效。
    $('generalNavRows')?.addEventListener('click', ev => {
      const btn = ev.target?.closest?.('[data-nav-to]');
      if (!btn) return;
      haptic();
      showPage(btn.dataset.navTo);
    });
    $('generalBack')?.addEventListener('click', () => {
      haptic();
      showHome();
    });
  }

  return {
    bind,
    render,
    showHome,
    showPage,
    currentPage: () => current,
  };
}
