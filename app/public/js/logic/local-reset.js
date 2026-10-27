// logic/local-reset.js —— 设置页底部两档（#302）的判定：「重新加载」清哪些键、放过哪个 SW；「重置本机数据」怎么说后果。
//
// 红线同 logic/ 其余模块：只做数据→数据，不碰 DOM / window / socket。唯一允许的宿主外 import 是 ../i18n.js。

import { t } from '../i18n.js';

// 「重新加载」只删这几个可再生的键，其余一律保留：令牌、离线 outbox、拒收暂存、已读表（可能含还没同步的离线修改）、
// 语言、主题与推送偏好都不可再生。写成白名单而不是黑名单：漏列一个只是少清一点缓存，多清一个就是丢数据。
export const RELOAD_CLEARABLE_KEYS = Object.freeze(['slash_commands', 'slash_commands_terminal', 'ccm_expanded_dirs', 'current_session']);

// 当前唯一合法的 SW 是推送用的 /sw.js（判据同 sw-cleanup.js：按 pathname，不看查询串）。
// 「重新加载」必须放过它：注销了推送就静默失效，而 setup() 会再注册一个，只看「注册还在」看不出来。
export function isPushServiceWorker(scriptURL) {
  try {
    return new URL(scriptURL).pathname === '/sw.js';
  } catch {
    return false;
  }
}

/**
 * 「重置本机数据」确认框。叫「重置」不叫「退出登录」：走 Cloudflare Access 的设备没有本地令牌也能握手，
 * 重置后会自动连上，只是本机存的东西清空了。
 * @param {{pending?: number, deadLetters?: number, accessPath?: boolean}} input
 *   pending：待发送或未确认送达（离线队列 + 取出了还没结论的）；deadLetters：被拒收暂存的
 */
export function localResetConfirm({ pending = 0, deadLetters = 0, accessPath = false } = {}) {
  const lines = [
    accessPath
      ? t('这台设备经 Cloudflare Access 登录：重置后会自动重新连上，只是本机保存的东西都清空了。')
      : t('重置后要重新输入访问令牌或扫码。'),
    t('这台设备可能需要重新审批。'),
  ];
  if (pending > 0) lines.push(t('{n} 条待发送或未确认送达的消息会丢失。').replace('{n}', String(pending)));
  if (deadLetters > 0) lines.push(t('{n} 条被拒收暂存的消息会丢失。').replace('{n}', String(deadLetters)));
  lines.push(t('服务端的已读位点和设备信任表不受影响。'));
  return { title: t('重置本机数据'), body: lines.join('\n'), okText: t('重置'), tone: 'danger' };
}
