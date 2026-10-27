// theme.js —— 把 logic/theme 的偏好落到 DOM：data-theme、theme-color meta、hljs 样式表 media。
// 跟随系统时清掉 data-theme，并把 meta/link 的 media 还原成 prefers-color-scheme；
// 强制浅/深时写 data-theme，并把对应资源的 media 设为 all、另一侧 not all。
import {
  THEME_COLORS,
  readThemePref,
  resolveTheme,
  themeHtmlAttribute,
} from './logic/theme.js';

const LIGHT_MEDIA = '(prefers-color-scheme: light)';
const DARK_MEDIA = '(prefers-color-scheme: dark)';

function setMedia(el, media) {
  if (!el) return;
  if (media == null || media === '') el.removeAttribute('media');
  else el.setAttribute('media', media);
}

/**
 * @param {Document} doc
 * @param {'light'|'dark'|'system'} pref
 * @param {{ systemDark?: boolean }} [opts]
 */
export function applyThemeToDocument(doc, pref, { systemDark = false } = {}) {
  if (!doc?.documentElement) return resolveTheme(pref, systemDark);
  const attr = themeHtmlAttribute(pref);
  if (attr) doc.documentElement.setAttribute('data-theme', attr);
  else doc.documentElement.removeAttribute('data-theme');

  const resolved = resolveTheme(pref, systemDark);

  // theme-color：带 data-ccm-palette 的两条 media meta（见 index.html）
  for (const meta of doc.querySelectorAll('meta[name="theme-color"][data-ccm-palette]')) {
    const palette = meta.getAttribute('data-ccm-palette');
    if (pref === 'system') {
      setMedia(meta, palette === 'dark' ? DARK_MEDIA : LIGHT_MEDIA);
    } else if (palette === resolved) {
      setMedia(meta, 'all');
    } else {
      setMedia(meta, 'not all');
    }
    if (THEME_COLORS[palette]) meta.setAttribute('content', THEME_COLORS[palette]);
  }

  // highlight.js 主题表
  const lightLink = doc.getElementById('hljsThemeLight');
  const darkLink = doc.getElementById('hljsThemeDark');
  if (pref === 'system') {
    setMedia(lightLink, LIGHT_MEDIA);
    setMedia(darkLink, DARK_MEDIA);
  } else if (resolved === 'light') {
    setMedia(lightLink, 'all');
    setMedia(darkLink, 'not all');
  } else {
    setMedia(lightLink, 'not all');
    setMedia(darkLink, 'all');
  }

  return resolved;
}

export function readAndApplyTheme(doc, {
  getItem = (typeof localStorage !== 'undefined' ? (k) => localStorage.getItem(k) : null),
  systemDark = false,
} = {}) {
  const pref = readThemePref(getItem);
  applyThemeToDocument(doc, pref, { systemDark });
  return pref;
}

export { readThemePref, writeThemePref, resolveTheme, THEME_STORAGE_KEY, THEME_COLORS } from './logic/theme.js';
