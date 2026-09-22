// Service Worker — Web Push only (E15). No caching, no offline.

// 不调用 skipWaiting 时，新版本默认要等所有旧版本控制的页面标签全部关闭才会激活——
// PWA 用户几乎不会主动关标签，新版本可能长期停在 waiting 态，推送逻辑的修复永远用不上。
self.addEventListener('install', () => {
  self.skipWaiting();
});

// 不调用 clients.claim 时，新 SW 激活后也不会立刻接管已打开的页面（那些页面仍由旧 SW
// 控制，直到下一次导航/刷新）——新旧代码短暂共存，行为不一致。
self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

// 订阅被浏览器/推送服务主动轮换（不是用户操作，如端点过期）时触发。不处理的话，旧端点
// 持续留在服务端记录里但已经失效——用户从此收不到任何推送，且没有任何提示。
//
// 这里只做浏览器端重新订阅：SW 上下文拿不到 localStorage 里的 AUTH_TOKEN（不同执行
// 线程，规范不提供该访问），不能在这里直接调用需要鉴权的 /push/subscribe。下次用户
// 打开应用时，notifications.js 的 setup()→subscribe() 会读到这个新订阅并无条件重新
// POST /push/subscribe 上报（那条路径本就不省略"已有订阅"时的上报），从而自愈。
// applicationServerKey 从旧订阅的 options 上原样复用（PushSubscriptionOptions 标准
// 字段）——不需要额外获取 VAPID key。拿不到旧 key（部分浏览器不提供 oldSubscription）
// 就放弃自动续订，等用户下次手动打开应用时走全新订阅流程，不比现状差。
self.addEventListener('pushsubscriptionchange', e => {
  const applicationServerKey = e.oldSubscription?.options?.applicationServerKey;
  if (!applicationServerKey) return;
  e.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }).catch(() => {})
  );
});

self.addEventListener('push', e => {
  const data = e.data?.json() ?? {};
  const title = data.title || 'Claude';
  const body  = data.body  || '';
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body,
      icon:     '/icons/icon-192.png',
      badge:    '/icons/icon-192.png',
      // 按会话分组：固定字面量会让「同 tag 替换」语义跨会话生效——锁屏时项目 B 的「✅ 任务完成」
      // 静默吃掉项目 A 的「⚠️ 请求许可」，审批一直卡到 TTL 过期。同会话内替换是有意设计
      // （跑完把「运行中」换成「已完成」），按 sessionId 分组恰好保留它，同时让不同会话各占一条。
      tag:      data.data?.sessionId ? `ccm-${data.data.sessionId}` : 'ccm-push',
      renotify: true,
      data:     data.data || null,   // ②2c：深链锚点 {instanceId, sessionId, cwd}，供 notificationclick 定位会话
    }),
    // 应用图标角标：SW 上下文没有 navigator 全局，Badging API 挂在 self.registration 上
    // （ServiceWorkerRegistration.setAppBadge，不是 navigator.setAppBadge）。无参数=系统通用圆点提示
    // "有新东西"——SW 侧不知道精确未读数字，不硬造。registration?. 与 setAppBadge?. 均用 optional
    // chaining：不支持的平台/浏览器静默跳过；.catch 吞 reject——部分平台（权限边界/半支持）
    // badge API 会 reject，绝不能让它毒化 Promise.all 导致 waitUntil 失败、拖累 SW 生命周期。
    Promise.resolve(self.registration?.setAppBadge?.()).catch(() => {}),
  ]));
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
    Promise.all([
      // 用户点开通知即回到 app，角标应清除（同 push 处注释：SW 上下文角标挂 self.registration，非 navigator）。
      // .catch 同 push：badge reject 不得毒化 Promise.all，否则深链 focus/openWindow 整段失败。
      Promise.resolve(self.registration?.clearAppBadge?.()).catch(() => {}),
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        const w = list.find(c => new URL(c.url).origin === self.location.origin);
        if (w) {
          if (d && d.instanceId) w.postMessage({ type: 'ccm:deeplink', instanceId: d.instanceId, sessionId: d.sessionId, cwd: d.cwd });
          return w.focus();
        }
        return clients.openWindow('/' + hash);
      })
    ])
  );
});
