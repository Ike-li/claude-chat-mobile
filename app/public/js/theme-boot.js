// theme-boot.js —— 在首屏 CSS 前同步写入 <html data-theme>，避免手动主题下的 FOUC。
// 与 logic/theme.js 的 THEME_STORAGE_KEY / 合法值保持字面一致（本文件必须是经典脚本、
// 不能 import module，故不共享模块；单测钉两边的键名）。
// 外置而非内联：保持 CSP script-src 'self'。
(function () {
  try {
    var p = localStorage.getItem('ccm_theme');
    if (p === 'light' || p === 'dark') {
      document.documentElement.setAttribute('data-theme', p);
    }
  } catch (e) { /* 隐私模式 / 禁用 storage：保持跟随系统 */ }
})();
