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
// 【★ 每一项都要指向页面里一个真实元素】
// 改成活数据只治了三行。behavior / diag / help 仍是写死的枚举，两级导航上线五天就漂了两条：
// behavior 行写着页面里根本不存在的「会花钱的功能」（全仓只有那一处出现过这个词），diag 行列了
// 四条日志而那一页只有一条——另两条在顶栏与服务状态面板里。根因不是谁写错了，是**文案与内容分居
// 两个文件**：改 L2 页内容的人没有任何理由回头改 L1 的字符串，而"记得回来改"正是失败的那一步。
//
// 所以摘要不再是字符串数组，而是 `{ text, el }` 对：`el` 是这一项在 L2 页里对应元素的 id。
// 单测读 index.html 逐项校验该 id 存在，写一个页面里没有的词会直接红。`summary` 由 items 拼出，
// 不另写一份。判据一句话：**摘要里出现的，点进去一定找得到**——反过来，页面里整段缺席的东西
// （旧 server 没有的两个桥）也不许出现在摘要里。
//
// 【三条静态行为什么也走这里】
// behavior / diag / help 的摘要目前不依赖任何状态，写成常量也能跑。仍旧从这里出，是为了让
// "L1 有几行、各是什么" 只有一个事实源——接线层按 GENERAL_NAV_IDS 找 L2 页容器，两处分叉会让
// 某一页永远打不开，而那种失败在 UI 上表现为"点了没反应"，最难归因。

import { t, getLang } from '../i18n.js';
import { formatUptime } from './format.js';

// L1 六行的 id 与顺序。接线层据此定位 L2 页容器（#generalPage-<id>），测试据此钉住顺序。
export const GENERAL_NAV_IDS = Object.freeze([
  'notify', 'devices', 'host', 'behavior', 'diag', 'help',
]);

// 中文「提示音开」不插空格，其余语言必须插——上一版直接拼接，英文界面渲染出的是
// "Soundon · Vibrationoff"。分隔符按语言算而不塞进翻译串里：写成 `' on'` 的话，下一个看到它的
// 人会顺手 trim 掉，而那看起来完全像是在清理多余空格。
const sep = () => (getLang() === 'zh' ? '' : ' ');

// 开/关读成人话。**不要简化成「开着的才列出来」**：那样"提示音关了"和"这项不存在"在文案上
// 不可区分，而用户来这一行恰恰是想确认"我关过的那个是不是还关着"。
const onOff = (label, on) => `${label}${sep()}${t(on ? '开' : '关')}`;

// items → 完整行。summary 只在这里拼一次，别在各 row 函数里另写。
const row = (id, icon, title, items, dot = false) => ({
  id, icon, title, items,
  summary: items.map(i => i.text).join(' · '),
  dot,
});

// 收不到推送算不上"待办"（不是点一下就能处理完的事，可能是系统权限被拒），不点红点；
// 侧栏另有 #btnPush 那条专门的可行动入口。
function notifyRow({ push = {}, alerts = {} } = {}) {
  return row('notify', '🔔', t('通知'), [
    // 推送未订阅是这一行最重要的信息：本机收不到任何锁屏通知，其余开关都是空转。
    { text: push.subscribed ? t('推送已开') : t('推送未开启'), el: 'pushStatusRow' },
    { text: onOff(t('提示音'), !!alerts.sound), el: 'prefAlertSound' },
    { text: onOff(t('震动'), !!alerts.vibrate), el: 'prefAlertVibrate' },
    // 锁屏预览决定推送 body 里带不带问题/工具原文，是这一页隐私影响最大的开关。
    { text: onOff(t('锁屏预览'), !!push.preview), el: 'prefPushPreview' },
  ]);
}

function devicesRow({ devices = {} } = {}) {
  const trusted = Number.isFinite(devices.trusted) ? devices.trusted : 0;
  const pending = Number.isFinite(devices.pending) ? devices.pending : 0;
  const items = [{ text: `${trusted} ${t('台已信任')}`, el: 'trustedDevicesSection' }];
  if (pending > 0) items.push({ text: `${pending} ${t('台待批')}`, el: 'trustedDevicesList' });
  // 扫码是全站唯一「把一台新手机接进来」的动作，此前入口只报台数、一个字没提它。
  items.push({ text: t('扫码接新设备'), el: 'btnQrReveal' });
  items.push({ text: t('本机指纹'), el: 'deviceFingerprintShort' });
  // 待批设备是真待办：点进去就能批。这是 L1 上唯一会亮红点的一行。
  return row('devices', '🔐', t('接入与设备'), items, pending > 0);
}

// 桥的开关态压成一个词。四档判据与 formatStatuslineBridgeRow / formatHooksBridgeRow 同源：
// off 先判（env 直接决定、不经读盘）→ installed 是开 → drifted/unknown 既非开也非关。
// ★ 「待查」这一档不许并进"关"：读成关会让用户去开一个可能已经开着的东西，读成开又会让他以为
//   终端通知有人管着。页面里那两段对这两个 state 也刻意不给动作按钮，同一个理由。
function bridgeItem(bridge, label, el) {
  const state = bridge?.state;
  if (!state) return null; // 旧 server 无此字段 → 页面里整段缺席，摘要跟着不提
  if (bridge.off) return { text: onOff(label, false), el };
  if (state === 'unknown' || state === 'drifted') return { text: `${label}${sep()}${t('待查')}`, el };
  return { text: onOff(label, state === 'installed'), el };
}

function hostRow({ service = null, now = Date.now() } = {}) {
  const items = [];
  // 两个 CLI 桥是这一页上仅有的真开关，排在活数据之前：L1 是目录，先答"点进去能做什么"。
  const hooks = bridgeItem(service?.hooksBridge, t('终端推送'), 'hooksBridgeSection');
  if (hooks) items.push(hooks);
  const statusline = bridgeItem(service?.statuslineBridge, t('终端状态栏'), 'statuslineBridgeSection');
  if (statusline) items.push(statusline);

  const startedAt = service?.startedAt;
  // 运行时长要能读出"服务在我不知情时重启过"——formatUptime 与连接横幅共用同一份格式化，
  // 免得同一段时长在两处读成两个数。时长与版本在 L2 页里都只在「服务状态」面板里看得到。
  if (typeof startedAt === 'number' && startedAt > 0 && now >= startedAt) {
    items.push({ text: `${t('已运行')} ${formatUptime(now - startedAt)}`, el: 'btnServiceStatus' });
  }
  const server = service?.versions?.server;
  // 'unknown' 是 versions 的缺省字面量，不是版本号——照原样显示会变成"v unknown"。
  if (typeof server === 'string' && server && server !== 'unknown') {
    items.push({ text: `v${server}`, el: 'btnServiceStatus' });
  }
  // 一条都算不出来（service:status 还没回来 / 旧 server）时给确定的占位，不给空字符串——
  // 空摘要在 L1 上是一行半高的空白，看起来像渲染坏了。
  if (!items.length) items.push({ text: t('状态读取中'), el: 'btnServiceStatus' });
  // MCP 清单（#hostEnvSection）刻意不进摘要：四项已满，而它是只读清单，行动价值低于两个开关。
  return row('host', '🖥', t('宿主机'), items);
}

function behaviorRow({ lang = 'zh' } = {}) {
  const langLabel = { zh: t('中文'), en: 'English', auto: t('跟随浏览器') }[lang] || t('中文');
  return row('behavior', '🛠', t('行为与开关'), [
    { text: langLabel, el: 'prefLangGroup' },
    { text: t('审批规则'), el: 'permissionRulesSection' },
    // 旧文案第三项是「会花钱的功能」——那个词在页面里从来不存在。这一项真正对应的是
    // 「全部配置」按钮，它后面才是端口 / 工作区 / 推送那张表。
    { text: t('端口与工作区'), el: 'btnEnvConfig' },
  ]);
}

function diagRow() {
  return row('diag', '🩺', t('排查'), [
    { text: t('安全体检'), el: 'btnSecurityCheck' },
    { text: t('服务日志'), el: 'btnServerLog' },
    // 这两条此前只列在文案里，入口散在顶栏与服务状态面板；现已在本页各给一个跳转入口。
    { text: t('会话日志'), el: 'btnDiagSessionLog' },
    { text: t('安全日志'), el: 'btnDiagSecurityLog' },
  ]);
}

function helpRow() {
  return row('help', '🔑', t('帮助'), [
    { text: t('新设备怎么批'), el: 'accessHelpOpen' },
    { text: t('令牌在哪'), el: 'accessHelpOpen' },
    { text: t('连不上'), el: 'accessHelpOpen' },
    { text: 'GitHub', el: 'linkGithub' },
  ]);
}

// MCP 服务器里「一切正常」的唯一取值。SDK 的 d.ts 只声明 `status: string`，没给取值集合——
// 所以这里用**白名单**而不是黑名单：不认识的值一律落到「有问题」一侧。
// 把一个连不上的服务器显示成正常，比显示成未知更糟——用户会拿着一个绿灯去别处找原因。
const MCP_OK_STATUS = 'connected';

/**
 * 把 init 事件里的 mcp_servers 译成「几个、哪个坏了」。
 *
 * 这份数据早就随 init 到了浏览器（agent/agent.js 的 emit('init', {mcpServers})），
 * 只是从来没有渲染面——补它只差一个格式化。
 *
 * @param {Array<{name?: string, status?: string}>|null|undefined} servers
 * @returns {{total: number, failed: number, items: Array<{name: string, status: string, ok: boolean}>}|null}
 *   没有任何服务器时返回 null（调用方据此整段隐藏，不给空计数占位）
 */
export function formatMcpServers(servers) {
  if (!Array.isArray(servers) || !servers.length) return null;
  const items = servers
    .filter(s => s && typeof s.name === 'string' && s.name)
    .map(s => {
      const status = typeof s.status === 'string' ? s.status : '';
      return { name: s.name, status, ok: status === MCP_OK_STATUS };
    });
  if (!items.length) return null;
  return { total: items.length, failed: items.filter(i => !i.ok).length, items };
}

/**
 * 算出 L1 六行的展示态。
 *
 * @param {object} [state]
 * @param {{subscribed?: boolean, preview?: boolean}} [state.push] 本设备的 web-push 订阅态与锁屏预览偏好
 * @param {{sound?: boolean, vibrate?: boolean}} [state.alerts] 本机提示音/震动偏好
 * @param {{trusted?: number, pending?: number}} [state.devices] 信任表与待审队列的条数
 * @param {{startedAt?: number, versions?: {server?: string},
 *          hooksBridge?: {state?: string, off?: boolean},
 *          statuslineBridge?: {state?: string, off?: boolean}}} [state.service] service:status 的 ack
 * @param {'zh'|'en'|'auto'} [state.lang]
 * @param {number} [state.now]
 * @returns {Array<{id: string, icon: string, title: string, summary: string, dot: boolean,
 *                  items: Array<{text: string, el: string}>}>}
 *   items 的 el 是该项在 L2 页里对应元素的 id——摘要里出现的，点进去一定找得到（单测逐项校验）
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
