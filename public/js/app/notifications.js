import { urlBase64ToUint8Array } from '../logic/format.js';
import { pushEnvHint, readPushPreviewPref } from '../logic/service-diag.js';
import { t } from '../i18n.js';

export function createNotificationController(context, {
  addBar = () => {},
  autoBind = true,
  getToken = () => '',
  getDeviceToken = () => '', // A1：订阅须绑已信任设备
  // 点铃铛做什么。默认就地订阅（保底行为，也是单测里的默认路径）；app.js 注入的是「打开通用设置
  // 并滚到推送段」——那里的 #pushStatusRow 才是完整的权威版本（状态 + 原因 + 订阅按钮），
  // 铃铛只负责把人带过去，不再自己维护第二套解释分支。
  bellAction = null,
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
  // subscribe() 的失败原因。手机上看不到 console，只说"请稍后重试"等于什么都没说——
  // FCM 连不上、VAPID 无效、POST 被鉴权拦，对用户是完全不同的三件事，得说出是哪一件。
  let lastSubscribeError = '';

  // sensitive=true：正文含工具入参/问题原文（Bash 的 command、Write 的 file_path/content 头部）。
  // 这条页面内 new Notification 的旁路此前完全不看「推送内容预览」开关——而 Web Push 侧
  // （notify-channels 按 sub.prefs.preview 挑 body）与 ntfy 侧（恒最小化）都做对了。结果是：用户在设置里
  // 把预览关着、UI 也显示关，PWA 切后台（socket 未断）时命令正文照样弹上锁屏。内容没离开设备，但开关的
  // 用户可见语义失效。开关关闭时只保留标题（「⚠️ 等待审批」本身不含正文，仍能起到唤醒作用）。
  function notify(title, body, { force = false, sensitive = false, tag = '' } = {}) {
    if ((!force && !documentRef?.hidden) || !NotificationApi || NotificationApi.permission !== 'granted') return false;
    const safeBody = sensitive && !readPushPreviewPref(storageGetItem) ? '' : body;
    try {
      new NotificationApi(title, { body: safeBody, icon: '/icons/icon-192.png', tag: tag || 'ccm-push' });
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
    lastSubscribeError = '';
    try {
      // 脚本必须在站点根：SW 的默认 scope 就是脚本所在目录，只有根目录的脚本才能控制页面所在的 /。
      // 放 /js/ 下时 registration 只覆盖 /js/，下面这行 ready（等"控制当前页面"的 registration
      // 激活）就永不 resolve 也永不 reject——整个订阅流程静默挂死，按钮 disabled 后不恢复、
      // 一个提示都不弹。真机上推送因此从未订阅成功过。
      // 试过用服务端 Service-Worker-Allowed 头提权，但那个头在 CDN 后面到不了浏览器（实测 Cloudflare
      // 下报 max scope '/js/'）。放根目录不依赖任何响应头，少一个中间层就少一个故障点。
      const registration = await navigatorRef.serviceWorker.register('/sw.js');
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
      const deviceToken = typeof getDeviceToken === 'function' ? (getDeviceToken() || '') : '';
      const body = JSON.stringify({
        ...subscription.toJSON?.() ?? subscription,
        prefs: { preview: readPushPreviewPref(storageGetItem) },
        ...(deviceToken ? { deviceToken } : {}),
      });
      const response = await fetchFn(`/push/subscribe${authQuery}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(deviceToken ? { 'x-device-token': deviceToken } : {}),
        },
        body,
      });
      if (!response.ok) {
        lastSubscribeError = `HTTP ${response.status}`;
        logger?.warn?.('[push] 订阅未保存(HTTP', `${response.status})`);
        return false;
      }
      context.dom.btnPush?.classList.add('hidden');
      return true;
    } catch (error) {
      lastSubscribeError = error?.message || String(error);
      logger?.warn?.('[push] 订阅失败:', lastSubscribeError);
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
        // 带上真实原因：手机上没有 console，笼统的"稍后重试"让人（和排查的人）无从下手。
        else explain(`${t('⚠️ 订阅未成功：')}${lastSubscribeError || t('原因未知')}`, 'text-warning');
      } else {
        // 被拒后**不隐藏**铃铛：那正是用户最需要这个入口的时刻（点它能看到状态与下一步）。
        // 此前这里 add('hidden') 与 setup() 里 denied 时 remove('hidden') 直接打架——
        // 点一下铃铛就消失、刷新才回来，等于把唯一的排查入口藏了起来。
        explain(t('🚫 接收推送通知权限已被拒绝，可在浏览器地址栏左侧设置中重新允许'), 'text-warning');
      }
    } catch (error) {
      explain(`${t('❌ 订阅出错:')} ${error.message}`, 'text-danger');
    }
  }

  if (autoBind && context.dom.btnPush) context.dom.btnPush.onclick = bellAction || requestSubscription;
  return { environment, notify, requestSubscription, setup, subscribe };
}
