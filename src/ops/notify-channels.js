// 通知发送通道（Web Push E15 + ntfy ②2b）：订阅存储 + 两通道发送，从 server/app.js 下沉。
// 通知是尽力而为：没配则优雅缺席、失败绝不阻断主流程；真失败（非订阅过期）计 metrics
// 并回调 onDeliveryFailure（app 层用它触发 instances 广播的服务健康可见性）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { ntfyRequestInit } from './notifications.js';
import * as metrics from './metrics.js';

export function createNotifyChannels({
  dataDir,
  env = process.env,
  fetchImpl = fetch,
  webpushImpl = webpush,
  onDeliveryFailure = () => {},
}) {
  const vapidPublicKey = env.VAPID_PUBLIC_KEY || '';
  const vapidPrivateKey = env.VAPID_PRIVATE_KEY || '';
  const vapidSubject = env.VAPID_SUBJECT || '';
  const pushEnabled = !!(vapidPublicKey && vapidPrivateKey && vapidSubject);
  if (pushEnabled) webpushImpl.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  // ⚠️ 通知正文可能含命令详情 → 建议自托管 ntfy 或 topic + NTFY_TOKEN，勿用公共 ntfy.sh 裸 topic。
  const ntfyUrl = env.NTFY_URL || '';
  const ntfyTopic = env.NTFY_TOPIC || '';
  const ntfyToken = env.NTFY_TOKEN || '';
  const ntfyEnabled = !!(ntfyUrl && ntfyTopic);

  // 深链绝对 URL（ntfy click / web push 深链共用）：PUBLIC_URL 优先，回退 CF_ACCESS_HOSTNAME 拼
  // https；都无则通知不带 click（仍正常送达，只是点击不深链）。
  const publicUrl = env.PUBLIC_URL || (env.CF_ACCESS_HOSTNAME ? `https://${env.CF_ACCESS_HOSTNAME}` : '');

  const pushSubFile = join(dataDir, 'push-subscription.json');
  // 多设备：按 endpoint 去重的订阅数组（旧版单对象格式向后兼容读入）。手机 + iPad 各留一条，
  // 推送时遍历全部、按 410/404 单独剔除失效——不再"后订阅顶掉前订阅"只剩最后一台收推送。
  let pushSubscriptions = [];
  try {
    const raw = JSON.parse(readFileSync(pushSubFile, 'utf8'));
    if (Array.isArray(raw)) pushSubscriptions = raw.filter(s => s?.endpoint);
    else if (raw?.endpoint) pushSubscriptions = [raw]; // 向后兼容旧单对象格式
  } catch {}

  function persistPushSubscriptions() {
    try { writeFileSync(pushSubFile, JSON.stringify(pushSubscriptions)); } catch (e) {
      console.error('[push] 保存订阅失败:', e.message);
    }
  }

  function savePushSubscription(sub) {
    if (!sub?.endpoint) return;
    pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== sub.endpoint); // 同设备重订覆盖
    pushSubscriptions.push(sub);
    persistPushSubscriptions();
  }

  async function pushNotify(title, body, data) {
    if (!pushEnabled || pushSubscriptions.length === 0) return;
    const payload = JSON.stringify(data ? { title, body, data } : { title, body });
    const expired = [];
    await Promise.all(pushSubscriptions.map(sub =>
      webpushImpl.sendNotification(sub, payload)
        .then(() => metrics.inc('push_success')) // NFR-15 推送成功率（分子）
        .catch(e => {
          if (e.statusCode === 410 || e.statusCode === 404) expired.push(sub.endpoint); // 过期/注销：订阅生命周期正常结束，非"通知失败"
          else {
            metrics.inc('push_failure'); console.error('[push] 推送失败:', e.statusCode ?? '', e.message); // NFR-15 notify_failed 信号：真失败（非订阅过期）才计
            metrics.gauge('push_failure_last_ts', Date.now()); onDeliveryFailure(); // 服务状态可见性：带时间戳，供 recentDeliveryFailure 判定
          }
        })
    ));
    if (expired.length) {                       // 仅剔除失效的那几条，其余设备订阅保留
      pushSubscriptions = pushSubscriptions.filter(s => !expired.includes(s.endpoint));
      persistPushSubscriptions();
      console.warn(`[push] 清除 ${expired.length} 条失效订阅`);
    }
  }

  // ②2b：向 ntfy 发一条（Node 原生 fetch，零依赖）。没配 / 出错都静默——尽力而为，绝不阻断主流程。
  async function ntfyNotify(title, body, meta = {}) {
    if (!ntfyEnabled) return;
    try {
      const { url, init } = ntfyRequestInit({ url: ntfyUrl, topic: ntfyTopic, token: ntfyToken }, title, body, meta);
      const res = await fetchImpl(url, init);
      if (!res.ok) {
        // BE-015：fetch 对 4xx/5xx 正常 resolve——不查 res.ok 会把投递失败（401 token 错 / 404 topic 错 / 5xx）
        // 静默当成功。只记状态码（不记 title/body：SEC-04 明文经第三方，勿落日志）。不重试不阻断主流程。
        console.error(`[ntfy] 推送失败: HTTP ${res.status}`);
        metrics.inc('ntfy_failure'); metrics.gauge('ntfy_failure_last_ts', Date.now()); onDeliveryFailure();
      }
    } catch (e) {
      console.error('[ntfy] 推送失败:', e.message);
      metrics.inc('ntfy_failure'); metrics.gauge('ntfy_failure_last_ts', Date.now()); onDeliveryFailure();
    }
  }

  return {
    pushEnabled,
    ntfyEnabled,
    vapidPublicKey,
    publicUrl,
    savePushSubscription,
    pushNotify,
    ntfyNotify,
    subscriptionCount: () => pushSubscriptions.length,
  };
}
