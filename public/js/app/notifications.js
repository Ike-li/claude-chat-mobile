import { pushEnvHint, urlBase64ToUint8Array } from '../logic.js';

export function createNotificationController(context, {
  addBar = () => {},
  autoBind = true,
  getToken = () => '',
} = {}) {
  const deps = context.dependencies;
  const documentRef = deps.document || globalThis.document;
  const windowRef = deps.window || globalThis.window || {};
  const navigatorRef = deps.navigator || globalThis.navigator || {};
  const NotificationApi = deps.Notification || windowRef.Notification;
  const fetchFn = deps.fetch || globalThis.fetch;
  const showAlert = deps.alert || windowRef.alert || (() => {});
  const logger = deps.console || globalThis.console;
  let vapidKey = null;

  function notify(title, body, { force = false } = {}) {
    if ((!force && !documentRef?.hidden) || !NotificationApi || NotificationApi.permission !== 'granted') return false;
    try {
      new NotificationApi(title, { body, icon: '/icons/icon-192.png', tag: 'ccm' });
      return true;
    } catch {
      return false;
    }
  }

  function environment() {
    const userAgent = navigatorRef.userAgent || '';
    const isIOS = /iP(hone|ad|od)/.test(userAgent)
      || (/Macintosh/.test(userAgent) && navigatorRef.maxTouchPoints > 1);
    const isStandalone = navigatorRef.standalone === true
      || windowRef.matchMedia?.('(display-mode: standalone)').matches === true;
    return {
      isSecureContext: windowRef.isSecureContext,
      isIOS,
      isStandalone,
      hasPushManager: 'serviceWorker' in navigatorRef && 'PushManager' in windowRef,
    };
  }

  async function subscribe() {
    try {
      const registration = await navigatorRef.serviceWorker.register('/js/sw.js');
      await navigatorRef.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
      }
      const token = getToken();
      const authQuery = token ? `?token=${encodeURIComponent(token)}` : '';
      const response = await fetchFn(`/push/subscribe${authQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription),
      });
      if (!response.ok) {
        logger?.warn?.('[push] 订阅未保存(HTTP', `${response.status})`);
        return false;
      }
      context.dom.btnPush?.classList.add('hidden');
      return true;
    } catch (error) {
      logger?.warn?.('[push] 订阅失败:', error.message);
      return false;
    }
  }

  async function setup() {
    if (!vapidKey) {
      try {
        const token = getToken();
        const authQuery = token ? `?token=${encodeURIComponent(token)}` : '';
        const response = await fetchFn(`/push/vapid-public-key${authQuery}`);
        if (!response.ok) return;
        vapidKey = (await response.json()).key;
      } catch {
        return;
      }
    }
    const hint = pushEnvHint(environment());
    if (hint !== 'ready') {
      context.dom.btnPush?.classList.remove('hidden');
      return;
    }
    if (NotificationApi?.permission === 'granted') {
      void subscribe();
    } else if (NotificationApi?.permission !== 'denied') {
      context.dom.btnPush?.classList.remove('hidden');
    }
  }

  function explain(message, className) {
    showAlert(message);
    addBar(message, className);
  }

  async function requestSubscription() {
    const hint = pushEnvHint(environment());
    if (hint === 'need-https') {
      explain('⚠️ 推送需 HTTPS：局域网 http 下浏览器会拦截通知订阅。请用 https 隧道（cloudflared 等）访问本站。', 'text-warning');
      return;
    }
    if (hint === 'ios-add-home') {
      explain('📲 iOS 收推送需先「添加到主屏幕」：点底部分享按钮 → 添加到主屏幕，再从主屏图标打开本站开启通知。', 'text-info');
      return;
    }
    if (hint === 'unsupported') {
      explain('🚫 当前浏览器不支持 Web Push（iOS 需 16.4+ 且已加主屏）。', 'text-warning');
      return;
    }
    if (!vapidKey) {
      explain('⚠️ 订阅失败：服务端未启用/配置 Web Push 密钥，或当前未加载成功密钥。请检查 VAPID 环境变量并重启服务。', 'text-danger');
      return;
    }
    try {
      if (!NotificationApi) throw new Error('当前浏览器/环境不支持 Notification API');
      const permission = await NotificationApi.requestPermission();
      if (permission === 'granted') {
        const ok = await subscribe();
        if (ok) explain('🔔 成功订阅推送通知！', 'text-success');
        else explain('⚠️ 订阅未成功，请稍后重试', 'text-warning');
      } else {
        explain('🚫 接收推送通知权限已被拒绝，可在浏览器地址栏左侧设置中重新允许', 'text-warning');
        context.dom.btnPush?.classList.add('hidden');
      }
    } catch (error) {
      explain(`❌ 订阅出错: ${error.message}`, 'text-danger');
    }
  }

  if (autoBind && context.dom.btnPush) context.dom.btnPush.onclick = requestSubscription;
  return { environment, notify, requestSubscription, setup, subscribe };
}
