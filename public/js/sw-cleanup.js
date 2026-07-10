// sw-cleanup.js —— 自愈：注销残留的 v1 service worker + 清其缓存，但放过当前合法的 push SW（/js/sw.js）。
// v1.9.0 曾注册过缓存型 SW，旧 PWA 会持续拦截请求、喂回陈旧外壳，导致升级后死在「未连接」。
// 当前唯一合法 SW 是 E15 Web Push 的 /js/sw.js（无缓存）——必须放过它，否则用户订阅推送后
// 每次冷加载都会把它误注销 + reload，推送静默失效（btnPush 已隐藏，用户还以为订阅在）。
// 仅当确有「遗留」注册时清理并刷新一次（无遗留则不触发，不会循环）。
// 外置而非内联：让 CSP 保持 script-src 'self'（不放开 'unsafe-inline'）。
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (rs) {
    var legacy = rs.filter(function (r) {
      var sw = r.active || r.waiting || r.installing;
      var url = (sw && sw.scriptURL) || '';
      // 按 pathname 比较（不含 query string/hash）：scriptURL 若带版本化参数（如 ?v=2）会让字面
      // endsWith 误判为"遗留"，重新触发本文件本该防住的静默失效（订阅推送后冷加载误注销）。
      var path = url;
      try { path = new URL(url).pathname; } catch (e) {}
      return !path.endsWith('/js/sw.js');
    });
    if (!legacy.length) return;
    legacy.forEach(function (r) { r.unregister(); });
    if (window.caches && caches.keys) caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); });
    location.reload();
  }).catch(function () {});
}
