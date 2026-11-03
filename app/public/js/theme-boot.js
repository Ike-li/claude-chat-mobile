// theme-boot.js —— 在首屏 CSS 前同步写入 <html data-theme>，避免手动主题下的 FOUC；
// 并按同一解析结果切换 PWA <link rel="manifest">（manifest 无媒体查询，见 #387）。
// 与 logic/theme.js 的 THEME_STORAGE_KEY / 合法值 / MANIFEST_HREF 保持字面一致（本文件必须是经典脚本、
// 不能 import module，故不共享模块；单测钉两边的键名与路径）。
// 外置而非内联：保持 CSP script-src 'self'。
// 依赖：index.html 把 <link rel="manifest"> 放在本脚本之前，才能在 boot 时改到 href。
(function () {
  try {
    var p = localStorage.getItem('ccm_theme');
    var dark = false;
    if (p === 'light' || p === 'dark') {
      document.documentElement.setAttribute('data-theme', p);
      dark = p === 'dark';
    } else if (window.matchMedia) {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    var link = document.querySelector('link[rel="manifest"]');
    if (link) {
      link.setAttribute('href', dark ? '/manifest-dark.webmanifest' : '/manifest-light.webmanifest');
    }
  } catch (e) { /* 隐私模式 / 禁用 storage：保持跟随系统 */ }
})();
