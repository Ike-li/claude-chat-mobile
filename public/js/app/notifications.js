import { pushEnvHint, urlBase64ToUint8Array, readPushPreviewPref } from '../logic.js';
import { t } from '../i18n.js';

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
  // ⑧ 推送内容预览偏好：与 app/alerts.js 同款 storage 注入模式（可测、抗 PWA 被杀落盘+重开恢复）。
  const storage = deps.storage || globalThis.localStorage;
  const storageGetItem = key => storage?.getItem?.(key) ?? null;
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
      // ⑧ prefs 随订阅一并存（server 端 savePushSubscription 原样落盘，见 notify-channels.js 头注）；
      // per-device 偏好——同一账号手机开预览、iPad 不开，两条订阅互不影响。
      const body = JSON.stringify({ ...subscription.toJSON?.() ?? subscription, prefs: { preview: readPushPreviewPref(storageGetItem) } });
      const response = await fetchFn(`/push/subscribe${authQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
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
      // 订阅失败时也要把入口露出来：此前 subscribe() 返回 false 就没下文了，用户既收不到推送、
      // 界面上也没有任何痕迹（实测机主机器上从未有过 push-subscription.json 却毫不知情）。
      void subscribe().then(ok => {
        if (!ok) context.dom.btnPush?.classList.remove('hidden');
      });
    } else {
      // denied 也显示：点它会解释"去浏览器站点设置里改回允许"。此前 denied 直接隐藏＝死路一条，
      // 用户永远查不出自己为什么收不到推送。
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
      explain(t('⚠️ 推送需 HTTPS：局域网 http 下浏览器会拦截通知订阅。请用 https 隧道（cloudflared 等）访问本站。'), 'text-warning');
      return;
    }
    if (hint === 'ios-add-home') {
      explain(t('📲 iOS 收推送需先「添加到主屏幕」：点底部分享按钮 → 添加到主屏幕，再从主屏图标打开本站开启通知。'), 'text-info');
      return;
    }
    if (hint === 'unsupported') {
      explain(t('🚫 当前浏览器不支持 Web Push（iOS 需 16.4+ 且已加主屏）。'), 'text-warning');
      return;
    }
    if (!vapidKey) {
      explain(t('⚠️ 订阅失败：服务端未启用/配置 Web Push 密钥，或当前未加载成功密钥。请检查 VAPID 环境变量并重启服务。'), 'text-danger');
      return;
    }
    try {
      if (!NotificationApi) throw new Error(t('当前浏览器/环境不支持 Notification API'));
      const permission = await NotificationApi.requestPermission();
      if (permission === 'granted') {
        const ok = await subscribe();
        if (ok) explain(t('🔔 成功订阅推送通知！'), 'text-success');
        else explain(t('⚠️ 订阅未成功，请稍后重试'), 'text-warning');
      } else {
        explain(t('🚫 接收推送通知权限已被拒绝，可在浏览器地址栏左侧设置中重新允许'), 'text-warning');
        context.dom.btnPush?.classList.add('hidden');
      }
    } catch (error) {
      explain(`${t('❌ 订阅出错:')} ${error.message}`, 'text-danger');
    }
  }

  if (autoBind && context.dom.btnPush) context.dom.btnPush.onclick = requestSubscription;
  return { environment, notify, requestSubscription, setup, subscribe };
}
