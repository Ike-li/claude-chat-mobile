// Service Worker — Web Push only (E15). No caching, no offline.
self.addEventListener('push', e => {
  const data = e.data?.json() ?? {};
  const title = data.title || 'Claude';
  const body  = data.body  || '';
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon:     '/icons/icon-192.png',
    badge:    '/icons/icon-192.png',
    tag:      'ccm-push',
    renotify: true,
    data:     data.data || null,   // ②2c：深链锚点 {instanceId, sessionId, cwd}，供 notificationclick 定位会话
  }));
});

// ②2c：点击通知深链回触发它的那个会话。有已开窗口 → focus + postMessage（页面据此切视图，最快）；
// 无窗口 → openWindow 带 hash（#instance=…&session=…&cwd=…），页面启动时解析。无 data 回退 '/'（保留旧行为）。
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data;
  const hash = (d && d.instanceId)
    ? '#' + new URLSearchParams({
        instance: d.instanceId,
        ...(d.sessionId ? { session: d.sessionId } : {}),
        ...(d.cwd ? { cwd: d.cwd } : {}),
      }).toString()
    : '';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const w = list.find(c => new URL(c.url).origin === self.location.origin);
      if (w) {
        if (d && d.instanceId) w.postMessage({ type: 'ccm:deeplink', instanceId: d.instanceId, sessionId: d.sessionId, cwd: d.cwd });
        return w.focus();
      }
      return clients.openWindow('/' + hash);
    })
  );
});
