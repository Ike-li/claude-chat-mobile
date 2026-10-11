import { t } from '../i18n.js';
import { widgetDisplayMode, widgetSvgDataUri, widgetTitleText } from '../logic/widget.js';

// 桌面端 show_widget 图表的渲染（决策与 SVG 主题化在 logic/widget.js）。
// live 工具卡与历史回显两条路径共用：返回一个节点交给调用方插在工具卡后面，返回 null 表示
// 退回现有的一行工具调用显示——调用方什么都不用多做。
//
// 安全面：SVG 只经 data:image/svg+xml 的 <img> 显示（图片文档不执行脚本、不加载外部资源），
// 交互 HTML 一律不执行，只显示标题和提示。两条都不需要改 CSP。
//
// 主题：CCM 只跟系统深浅色（app.css 的 prefers-color-scheme），图片里的 SVG 看不到页面变量，
// 所以按当前主题现算颜色；系统切换深浅色时把已渲染的图重算一遍。源码记在 WeakMap 里，
// 节点随消息被清掉时一并释放。
export function createWidgetRenderer({ doc = document, win = window, openPreviewUrl = () => {} } = {}) {
  const sources = new WeakMap();
  const darkQuery = win.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
  const theme = () => (darkQuery?.matches ? 'dark' : 'light');
  // 图片底色取界面卡片色，灯箱的黑色遮罩上也看得清深色字
  const background = () => win.getComputedStyle?.(doc.documentElement).getPropertyValue('--surface').trim() || '';
  const srcFor = code => widgetSvgDataUri(code, { theme: theme(), background: background() });

  darkQuery?.addEventListener?.('change', () => {
    for (const img of doc.querySelectorAll('img.widget-svg')) {
      const code = sources.get(img);
      const src = code ? srcFor(code) : null;
      if (src) img.src = src;
    }
  });

  function render(widget) {
    const mode = widgetDisplayMode(widget);
    if (!mode) return null;
    const title = widgetTitleText(widget.title);
    const fig = doc.createElement('figure');
    fig.className = 'msg-frame widget-card';
    fig.dataset.widgetKind = mode;
    if (mode === 'html') {
      fig.classList.add('rounded-lg', 'border', 'border-line', 'bg-surface', 'px-3', 'py-2', 'text-xs');
      if (title) {
        const name = doc.createElement('div');
        name.className = 'text-ink-soft truncate';
        name.textContent = title;
        fig.appendChild(name);
      }
      const note = doc.createElement('div');
      note.className = 'widget-note text-ink-faint';
      note.textContent = t('交互图表，请在桌面端查看');
      fig.appendChild(note);
      return fig;
    }
    const src = srcFor(widget.code);
    if (!src) return null;
    const img = doc.createElement('img');
    img.className = 'widget-svg';
    img.alt = title || t('图表');
    sources.set(img, widget.code);
    // XML 解析失败（模型写了 HTML 才认的实体、没闭合的标签）浏览器只给一张裂图：撤掉整块，留一行工具调用
    img.addEventListener('error', () => fig.remove());
    img.addEventListener('click', () => openPreviewUrl(title || t('图表'), img.src));
    img.src = src;
    fig.appendChild(img);
    return fig;
  }

  return { render };
}
