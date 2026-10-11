// logic/widget.js —— 桌面端 show_widget 图表：显示决策 + SVG 主题化 + data URI
//
// 红线同 logic/ 其他子模块：只做数据→数据，不碰 DOM / window / socket / 应用可变状态。
//
// 桌面端给会话挂了 visualize MCP，模型用它画 SVG 图（或交互 HTML 组件）。那段 SVG 依赖桌面端宿主
// 样式表提供的 class 与变量，原样当图片显示会变成黑方块；作为 <img> 还要有 xmlns 和固有尺寸。
// 这里把它补成一张能独立渲染的 SVG，前端用 data:image/svg+xml 的 <img> 显示：图片里的 SVG 不执行
// 脚本、不加载外部资源，现有 CSP（img-src 'self' data:）就允许，不用改。交互 HTML 一律不执行。
//
// 色板与 class 语义出自 visualize 工具的 read_me 说明（公开文档）：
//   · 九个色板各 7 个色阶（50 / 100 / 200 / 400 / 600 / 800 / 900），见下方 RAMPS，逐格照抄原表；
//   · 「Light/dark mode quick pick」：浅色 50 填充 + 600 描边 + 800 标题 / 600 副标题；
//     深色 800 填充 + 200 描边 + 100 标题 / 200 副标题；
//   · c-{ramp} 用直接子选择器（>）作用于 rect/circle/ellipse 与 t/ts/th 文字，也可直接挂在形状上；
//   · t = 14px 常规正文色、ts = 12px 次要色、th = 14px 中粗（500）；box = 中性底 + 强描边；
//     arr = 1.5px 箭头线；leader = 0.5px 虚线引线；变量简写 --p / --s / --t / --bg2 / --b。
// read_me 没给中性变量（--p 等）的十六进制值，这里取同一张表里 gray 色板的色阶，是本项目的选择。

// read_me「Color palette」：50 / 100 / 200 / 400 / 600 / 800 / 900
const RAMPS = Object.freeze({
  purple: ['#EEEDFE', '#CECBF6', '#AFA9EC', '#7F77DD', '#534AB7', '#3C3489', '#26215C'],
  teal: ['#E1F5EE', '#9FE1CB', '#5DCAA5', '#1D9E75', '#0F6E56', '#085041', '#04342C'],
  coral: ['#FAECE7', '#F5C4B3', '#F0997B', '#D85A30', '#993C1D', '#712B13', '#4A1B0C'],
  pink: ['#FBEAF0', '#F4C0D1', '#ED93B1', '#D4537E', '#993556', '#72243E', '#4B1528'],
  gray: ['#F1EFE8', '#D3D1C7', '#B4B2A9', '#888780', '#5F5E5A', '#444441', '#2C2C2A'],
  blue: ['#E6F1FB', '#B5D4F4', '#85B7EB', '#378ADD', '#185FA5', '#0C447C', '#042C53'],
  green: ['#EAF3DE', '#C0DD97', '#97C459', '#639922', '#3B6D11', '#27500A', '#173404'],
  amber: ['#FAEEDA', '#FAC775', '#EF9F27', '#BA7517', '#854F0B', '#633806', '#412402'],
  red: ['#FCEBEB', '#F7C1C1', '#F09595', '#E24B4A', '#A32D2D', '#791F1F', '#501313'],
});
const STOP = Object.freeze({ 50: 0, 100: 1, 200: 2, 400: 3, 600: 4, 800: 5, 900: 6 });
const PICK = Object.freeze({
  light: { fill: 50, stroke: 600, title: 800, sub: 600 },
  dark: { fill: 800, stroke: 200, title: 100, sub: 200 },
});
const gray = s => RAMPS.gray[STOP[s]];
const NEUTRAL = Object.freeze({
  light: { p: gray(900), s: gray(600), t: gray(400), b: gray(200), bg2: gray(50) },
  dark: { p: gray(50), s: gray(200), t: gray(400), b: gray(600), bg2: gray(800) },
});
// 与 CCM 界面同一套系统字体栈（app.css --font-ui）。图片里加载不了网页字体，桌面端的 Anthropic Sans 用不上。
const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Microsoft YaHei",sans-serif';

// 与后端 tool-summary.js 的 WIDGET_CODE_CAP 同值（前后端互不 import，各守一道）
export const WIDGET_CODE_MAX = 256 * 1024;

const SVG_HEAD_RE = /^\s*<svg[\s>/]/i;
const SVG_TAIL_RE = /<\/svg>\s*$/i;
// 开标签：属性值里的 > 不算结束（引号内整段吞掉）
const OPEN_TAG_RE = /^\s*<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i;
const VIEWBOX_RE = /\sviewBox\s*=\s*["']\s*([-+\d.eE]+)[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)\s*["']/;
const SAFE_COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\))$/i;

// 'svg' = 显示成图片；'html' = 交互组件，只显示标题和提示；null = 退回一行工具调用。
export function widgetDisplayMode(widget) {
  if (!widget || typeof widget !== 'object') return null;
  if (widget.kind === 'html') return 'html';
  if (widget.kind !== 'svg') return null;
  const code = widget.code;
  if (typeof code !== 'string' || code.length > WIDGET_CODE_MAX) return null;
  return SVG_HEAD_RE.test(code) && SVG_TAIL_RE.test(code) ? 'svg' : null;
}

export function widgetTitleText(title, maxLen = 80) {
  if (typeof title !== 'string') return '';
  const s = title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

function themeCss(theme, background) {
  const n = NEUTRAL[theme];
  const pick = PICK[theme];
  const bg = typeof background === 'string' && SAFE_COLOR_RE.test(background.trim()) ? `;background:${background.trim()}` : '';
  const rules = [
    `svg{--p:${n.p};--s:${n.s};--t:${n.t};--bg2:${n.bg2};--b:${n.b};font-family:${FONT}${bg}}`,
    '.t{font-size:14px;font-weight:400;fill:var(--p)}',
    '.ts{font-size:12px;font-weight:400;fill:var(--s)}',
    '.th{font-size:14px;font-weight:500;fill:var(--p)}',
    '.box{fill:var(--bg2);stroke:var(--t)}',
    '.arr{fill:none;stroke:var(--t);stroke-width:1.5}',
    '.leader{fill:none;stroke:var(--t);stroke-width:.5;stroke-dasharray:4 3}',
  ];
  for (const [name, ramp] of Object.entries(RAMPS)) {
    const c = s => ramp[STOP[s]];
    const k = `.c-${name}`;
    rules.push(
      `${k}>rect,${k}>circle,${k}>ellipse,rect${k},circle${k},ellipse${k}{fill:${c(pick.fill)};stroke:${c(pick.stroke)}}`,
      `${k}>.t,${k}>.th{fill:${c(pick.title)}}`,
      `${k}>.ts{fill:${c(pick.sub)}}`,
    );
  }
  return rules.join('');
}

// 图片里的 SVG 需要固有尺寸：width="100%" 没有固有宽度，灯箱里会缩成浏览器缺省的 300×150。
// 按 viewBox 补回；只给了一边的按比例算另一边；都写死了就不动。
function sizeAttrs(attrs) {
  const vb = VIEWBOX_RE.exec(attrs);
  const vw = vb ? Number(vb[3]) : NaN;
  const vh = vb ? Number(vb[4]) : NaN;
  if (!(vw > 0 && vh > 0)) return attrs;
  const read = name => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  const w = read('width');
  const h = read('height');
  const flexible = m => !m || /%\s*$/.test(m[1] ?? m[2]);
  const px = m => { const v = /^\s*([\d.]+)(px)?\s*$/.exec(m[1] ?? m[2]); return v ? Number(v[1]) : NaN; };
  let W, H;
  if (flexible(w) && flexible(h)) { W = vw; H = vh; }
  else if (flexible(h) && px(w) > 0) { W = px(w); H = Math.round(W * vh / vw); }
  else if (flexible(w) && px(h) > 0) { H = px(h); W = Math.round(H * vw / vh); }
  else return attrs;
  return attrs.replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '') + ` width="${W}" height="${H}"`;
}

// 返回能独立当图片渲染的 SVG 文本；源码不合格返回 null（调用方退回一行工具调用）。
export function themeWidgetSvg(code, { theme = 'light', background } = {}) {
  if (typeof code !== 'string') return null;
  const m = OPEN_TAG_RE.exec(code);
  if (!m || /\/\s*$/.test(m[1])) return null;
  const mode = theme === 'dark' ? 'dark' : 'light';
  let attrs = sizeAttrs(m[1]);
  if (!/\sxmlns\s*=/.test(attrs)) attrs += ' xmlns="http://www.w3.org/2000/svg"';
  if (/\bxlink:/.test(code) && !/\sxmlns:xlink\s*=/.test(attrs)) attrs += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
  return `<svg${attrs}><style>${themeCss(mode, background)}</style>${code.slice(m[0].length)}`;
}

export function widgetSvgDataUri(code, opts) {
  const svg = themeWidgetSvg(code, opts);
  return svg == null ? null : 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
