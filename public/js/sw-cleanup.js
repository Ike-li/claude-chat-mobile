// sw-cleanup.js —— 自愈：注销任何残留的 v1 service worker + 清其缓存。
// v2 不使用 service worker；但 v1.9.0 曾注册过 SW，旧 PWA 会持续拦截请求、喂回陈旧外壳，
// 导致升级后死在「未连接」。仅当确有注册时清理并刷新一次（无注册则不触发，不会循环）。
// 外置而非内联：让 CSP 保持 script-src 'self'（不放开 'unsafe-inline'）。
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (rs) {
    if (!rs.length) return;
    rs.forEach(function (r) { r.unregister(); });
    if (window.caches && caches.keys) caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); });
    location.reload();
  }).catch(function () {});
}
