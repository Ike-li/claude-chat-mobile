/* ══════════════════════════════════════════════════════════════════
   docs-to-book · 首次绘制前必须完成的两件事（模板：随站点拷入 assets/）
   在 <head> 里同步加载，早于 app.js。放到 body 末尾会先白后暗、侧栏回顶。
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var root = document.documentElement;

  // ── 主题：localStorage → 系统偏好 → 不设属性（样式表默认浅色）──────
  // file:// 下部分浏览器会对 storage 抛异常，包一层，坏了也只是回到浅色。
  var saved = null;
  try { saved = localStorage.getItem('docsbook-theme'); } catch (e) {}
  if (saved === 'dark' || saved === 'light') root.setAttribute('data-theme', saved);
  else if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches)
    root.setAttribute('data-theme', 'dark');

  // ── 侧栏滚动位置：由 build 在 <aside class="sidebar"> 之后立即调用 ──
  // 时机必须在侧栏绘制之后、页面绘制之前，所以是一个由外壳显式触发的函数。
  window.__restoreNavScroll = function () {
    try {
      var sb = document.querySelector('.sidebar');
      if (!sb) return;
      var pos = null;
      try { pos = sessionStorage.getItem('docsbook-nav-scroll'); } catch (e) {}
      var act = sb.querySelector('.nav a.active');
      var inView = function () {
        if (!act) return true;
        var r = act.getBoundingClientRect(), s = sb.getBoundingClientRect();
        return r.top >= s.top && r.bottom <= s.bottom;
      };
      var center = function () {
        if (!act) return;
        var r = act.getBoundingClientRect(), s = sb.getBoundingClientRect();
        sb.scrollTop += (r.top - s.top) - (sb.clientHeight / 2) + (r.height / 2);
      };
      if (pos !== null) { sb.scrollTop = parseInt(pos, 10) || 0; if (!inView()) center(); }
      else if (act && !inView()) center();
    } catch (e) {}
  };
})();
