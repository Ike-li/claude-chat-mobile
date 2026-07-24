// i18n.js —— 运行时词典（无构建步骤：zh 原文即 key，恒等设计）。
// t() 在 zh locale（默认）下原样返回中文——零开销，且不影响任何既有断言中文文案的测试（单测/E2E 均
// 固定跑 zh，见 roadmap ⑨）。en locale 下查字典，未收录的 key 静默回落中文原文，不是"未翻译就报错"——
// 允许按域逐步迁移，本文件只是阶段 0 的地基 + 阶段 1（index.html 静态串）的起步词条。
// 语言选择持久化 localStorage；切换后提示用户手动刷新生效（不做响应式重渲，保持极简）。
export const LANG_STORAGE_KEY = 'ccm_lang';

// 阶段 1 起步：index.html 高频静态串（composer placeholder、常驻按钮/标题等）。
// scripts/i18n-check.js 会扫全仓 t('...') 调用与 data-i18n 属性值，报词典里的孤儿 key。
export const EN_DICT = Object.freeze({
  '给 Claude 发消息...': 'Message Claude...',
  '停止': 'Stop',
  '取消': 'Cancel',
  '确定': 'Confirm',
  '选择模型': 'Select model',
  '完成提示': 'Completion alerts',
  '提示音': 'Sound',
  '震动': 'Vibration',
  '推送内容': 'Push content',
  '推送带内容预览': 'Include content preview in push',
  '访问与设备': 'Access & devices',
  '浏览项目文件': 'Browse project files',
  '编辑': 'Edit',
  '保存': 'Save',
  '（空目录）': '(empty directory)',
  '加载中…': 'Loading…',
  '语言': 'Language',
  '切换后请刷新页面生效；目前仅部分界面文案已翻译。': 'Refresh the page after switching; only part of the UI is translated so far.',
});

let currentLang = 'zh';

export function setLang(lang) {
  currentLang = lang === 'en' ? 'en' : 'zh';
}

export function getLang() {
  return currentLang;
}

export function t(zh) {
  if (currentLang !== 'en' || typeof zh !== 'string') return zh;
  return zh in EN_DICT ? EN_DICT[zh] : zh;
}

// 读原始存储偏好（'zh'/'en'/'auto'），不做 navigator 解析——供设置面板回显用户真实选择，
// 区别于 getLang()（恒返回运行时已折叠的 zh/en，'auto' 会被解析掉，设置面板不能拿它反显下拉框，
// 否则用户选了「跟随浏览器」刷新后重开设置会看着像被静默改回了固定语言）。
export function readLangPref(getItem) {
  const stored = typeof getItem === 'function' ? getItem(LANG_STORAGE_KEY) : null;
  return (stored === 'zh' || stored === 'en' || stored === 'auto') ? stored : 'zh';
}

// 启动时解析语言偏好：显式 'zh'/'en' 直接用；'auto' 按 navigator.language 首段判定
// （en 开头→en，其余→zh）；未设置过 / 未知值一概保底 zh（不静默变英文，最小惊讶）。
export function resolveInitialLang(getItem, navigatorLanguage) {
  const pref = readLangPref(getItem);
  if (pref === 'auto') return /^en/i.test(String(navigatorLanguage || '')) ? 'en' : 'zh';
  return pref;
}

export function writeLangPref(setItem, lang) {
  if (typeof setItem !== 'function') return false;
  setItem(LANG_STORAGE_KEY, lang);
  return true;
}
