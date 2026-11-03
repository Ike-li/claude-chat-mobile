// logic/theme.js —— 本机主题偏好（浅色 / 深色 / 跟随系统）的纯判定。
// 红线同 logic/ 其余模块：只做数据→数据，不碰 DOM / window / localStorage。
// 存储键与语言偏好 ccm_lang 同模式；缺省「跟随系统」以保持升级前行为（纯 prefers-color-scheme）。

export const THEME_STORAGE_KEY = 'ccm_theme';

/** 与 app.css :root / dark --canvas、index.html theme-color 同源 */
export const THEME_COLORS = Object.freeze({
  light: '#F4F3EE',
  dark: '#121211',
});

const PREFS = new Set(['light', 'dark', 'system']);

/** 读原始存储偏好（'light'/'dark'/'system'）；未知 / 未设 → 'system'（升级最小惊讶）。 */
export function readThemePref(getItem) {
  const stored = typeof getItem === 'function' ? getItem(THEME_STORAGE_KEY) : null;
  return PREFS.has(stored) ? stored : 'system';
}

export function writeThemePref(setItem, pref) {
  if (typeof setItem !== 'function') return false;
  const next = PREFS.has(pref) ? pref : 'system';
  setItem(THEME_STORAGE_KEY, next);
  return true;
}

/** 折叠成实际渲染主题：'system' 跟 systemDark，其余原样。 */
export function resolveTheme(pref, systemDark) {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemDark ? 'dark' : 'light';
}

/**
 * <html data-theme> 该写什么：强制档写 light/dark；跟随系统则去掉属性，交给 CSS 媒体查询。
 * @returns {'light'|'dark'|null} null = 调用方应 removeAttribute
 */
export function themeHtmlAttribute(pref) {
  return pref === 'light' || pref === 'dark' ? pref : null;
}

/** L1 摘要 / 设置磁贴文案用的短标签（调用方再 t()）。 */
export function themePrefLabelKey(pref) {
  if (pref === 'light') return '浅色';
  if (pref === 'dark') return '深色';
  return '跟随系统';
}

/** PWA manifest href for a resolved palette (Web Manifest has no media queries). */
export const MANIFEST_HREF = Object.freeze({
  light: '/manifest-light.webmanifest',
  dark: '/manifest-dark.webmanifest',
});

export function manifestHrefForTheme(resolved) {
  return resolved === 'dark' ? MANIFEST_HREF.dark : MANIFEST_HREF.light;
}
