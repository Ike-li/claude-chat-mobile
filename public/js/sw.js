// Service Worker — Web Push only (ADR-009/E15). No caching, no offline.
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
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const w = list.find(c => new URL(c.url).origin === self.location.origin);
      return w ? w.focus() : clients.openWindow('/');
    })
  );
});
