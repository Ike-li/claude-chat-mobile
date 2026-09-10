// logic/general-nav.js —— 通用设置 L1 目录（六行）的摘要判定层。
//
// 红线同 logic/ 其余模块：只做数据→数据，不碰 DOM / window / socket / 应用可变状态。
// 唯一允许的宿主外 import 是 ../i18n.js。
//
// 【为什么摘要要算，而不是写死一行字】
// 旧面板入口的副标题是死的功能枚举（「本机提醒 · 推送 · 语言 · 诊断」）。枚举轴的名字必然滞后于
// 内容：上线后面板长到九组，那四个词里已有两个和真实组标题对不上，还漏掉了全站唯一能吊销设备的
// 那一组。活数据不会漂——但代价是"算错"直接等于"面板上写着假话"，所以每一行都由
// tests/unit/logic-general-nav.test.mjs 钉住。
//
// 【三条静态行为什么也走这里】
// behavior / diag / help 的摘要目前不依赖任何状态，写成常量也能跑。仍旧从这里出，是为了让
// "L1 有几行、各是什么" 只有一个事实源——接线层按 GENERAL_NAV_IDS 找 L2 页容器，两处分叉会让
// 某一页永远打不开，而那种失败在 UI 上表现为"点了没反应"，最难归因。

import { t } from '../i18n.js';
import { formatUptime } from './format.js';

// L1 六行的 id 与顺序。接线层据此定位 L2 页容器（#generalPage-<id>），测试据此钉住顺序。
export const GENERAL_NAV_IDS = Object.freeze([
  'notify', 'devices', 'host', 'behavior', 'diag', 'help',
]);

// 开/关读成人话。**不要简化成「开着的才列出来」**：那样"提示音关了"和"这项不存在"在文案上
// 不可区分，而用户来这一行恰恰是想确认"我关过的那个是不是还关着"。
const onOff = (label, on) => `${label}${on ? t('开') : t('关')}`;

function notifyRow({ push = {}, alerts = {} } = {}) {
  const parts = [];
  // 推送未订阅是这一行最重要的信息：本机收不到任何锁屏通知，其余开关都是空转。
  if (!push.subscribed) parts.push(t('推送未开启'));
  else parts.push(t('推送已开'));
  parts.push(onOff(t('提示音'), !!alerts.sound));
  parts.push(onOff(t('震动'), !!alerts.vibrate));
  return {
    id: 'notify',
    icon: '🔔',
    title: t('通知'),
    summary: parts.join(' · '),
    // 收不到推送算不上"待办"（不是点一下就能处理完的事，可能是系统权限被拒），不点红点；
    // 侧栏另有 #btnPush 那条专门的可行动入口。
    dot: false,
  };
}

function devicesRow({ devices = {} } = {}) {
  const trusted = Number.isFinite(devices.trusted) ? devices.trusted : 0;
  const pending = Number.isFinite(devices.pending) ? devices.pending : 0;
  const parts = [`${trusted} ${t('台已信任')}`];
  if (pending > 0) parts.push(`${pending} ${t('台待批')}`);
  return {
    id: 'devices',
    icon: '🔐',
    title: t('接入与设备'),
    summary: parts.join(' · '),
    // 待批设备是真待办：点进去就能批。这是 L1 上唯一会亮红点的一行。
    dot: pending > 0,
  };
}

function hostRow({ service = null, now = Date.now() } = {}) {
  const parts = [];
  const startedAt = service?.startedAt;
  // 运行时长要能读出"服务在我不知情时重启过"——formatUptime 与连接横幅共用同一份格式化，
  // 免得同一段时长在两处读成两个数。
  if (typeof startedAt === 'number' && startedAt > 0 && now >= startedAt) {
    parts.push(`${t('已运行')} ${formatUptime(now - startedAt)}`);
  }
  const server = service?.versions?.server;
  // 'unknown' 是 versions 的缺省字面量，不是版本号——照原样显示会变成"v unknown"。
  if (typeof server === 'string' && server && server !== 'unknown') parts.push(`v${server}`);
  return {
    id: 'host',
    icon: '🖥',
    title: t('这台电脑'),
    // 一条都算不出来（service:status 还没回来 / 旧 server）时给确定的占位，不给空字符串——
    // 空摘要在 L1 上是一行半高的空白，看起来像渲染坏了。
    summary: parts.length ? parts.join(' · ') : t('状态读取中'),
    dot: false,
  };
}

function behaviorRow({ lang = 'zh' } = {}) {
  const langLabel = { zh: t('中文'), en: 'English', auto: t('跟随浏览器') }[lang] || t('中文');
  return {
    id: 'behavior',
    icon: '🛠',
    title: t('行为与开关'),
    summary: [langLabel, t('审批规则'), t('会花钱的功能'), t('工作区')].join(' · '),
    dot: false,
  };
}

function diagRow() {
  return {
    id: 'diag',
    icon: '🩺',
    title: t('排查'),
    summary: [t('体检'), t('服务日志'), t('会话日志'), t('安全日志')].join(' · '),
    dot: false,
  };
}

function helpRow() {
  return {
    id: 'help',
    icon: '🔑',
    title: t('帮助'),
    summary: [t('新设备怎么批'), t('令牌在哪'), t('连不上')].join(' · '),
    dot: false,
  };
}

/**
 * 算出 L1 六行的展示态。
 *
 * @param {object} [state]
 * @param {{subscribed?: boolean}} [state.push] 本设备的 web-push 订阅态
 * @param {{sound?: boolean, vibrate?: boolean}} [state.alerts] 本机提示音/震动偏好
 * @param {{trusted?: number, pending?: number}} [state.devices] 信任表与待审队列的条数
 * @param {{startedAt?: number, versions?: {server?: string}}} [state.service] service:status 的 ack
 * @param {'zh'|'en'|'auto'} [state.lang]
 * @param {number} [state.now]
 * @returns {Array<{id: string, icon: string, title: string, summary: string, dot: boolean}>}
 */
export function summarizeGeneralNav(state = {}) {
  return [
    notifyRow(state),
    devicesRow(state),
    hostRow(state),
    behaviorRow(state),
    diagRow(),
    helpRow(),
  ];
}
