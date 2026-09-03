// logic/service-diag.js —— 服务状态行 · 重启记录 · 诊断时间线 · 控制台日志 · 客户端错误上报 · 推送/告警偏好
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t } from '../i18n.js';
import { formatRttMs, formatUptime } from './format.js';

// 交互日志(控制台)某条目是否该在当前查看实例下显示。修「切工作区残留上个区日志」：clientLogBuffer 是
// 全局缓冲、无实例隔离，loadConsoleLogs 过去把它无差别合并进每个实例的控制台 → 上个工作区的
// web-send/recv/stream 漏到新工作区。client_conn 是 socket 连接级事件、无工作区归属 → 恒显；
// 其余按 entry.instanceId 精确匹配当前实例（含两端皆 null 的空首页；undefined 视同 null，旧条目不误判）。
// 服务端日志(logs:get)本就按 sessionId 隔离、不经此函数。
export function logEntryVisibleForInstance(entry, instanceId) {
  if (!entry) return false;
  if (entry.type === 'client_conn') return true;
  return (entry.instanceId ?? null) === (instanceId ?? null);
}

// 交互日志行布局 class 契约（appendLogEntry 唯一来源）。
// 旧布局：row 横向 flex + 多个 chip shrink-0 + 正文 break-all → 窄屏正文可用宽≈0，中文逐字竖排。
// 新布局：row 纵向；meta 可换行承载时间戳/type/model/effort/perm；body 独占满宽、break-words 正常折行。
export function consoleLogEntryLayout() {
  return {
    row: 'flex flex-col gap-1 font-mono text-[11px]',
    meta: 'flex flex-wrap items-center gap-1.5 min-w-0 leading-5',
    body: 'w-full min-w-0 break-words whitespace-pre-wrap leading-5',
  };
}

// Web Push 环境判定（E15 / ②2a）：手机端「通知没触发过」多半卡在这几道门，返回该给用户的引导标识。
//   need-https   = 非 secure context（局域网 http，浏览器直接拦掉 SW/Push）——优先级最高
//   ios-add-home = iOS 且未「添加到主屏幕」（Safari 标签页无 PushManager，必须先装成 PWA 才有 Push API）
//   unsupported  = 浏览器压根没 Push API（旧 iOS <16.4，或不支持的浏览器）
//   ready        = 前提齐备，可请求授权 + 订阅
// 缺省入参（环境未探明）保守回 need-https，宁可提示也不静默失败——正是本次要修的「静默没反应」根因。
export function pushEnvHint({ isSecureContext, isIOS, isStandalone, hasPushManager } = {}) {
  if (!isSecureContext) return 'need-https';
  if (isIOS && !isStandalone) return 'ios-add-home';
  if (!hasPushManager) return 'unsupported';
  return 'ready';
}

// 订阅失败原因分类（2026-09-03）。pushEnvHint 判的是订阅【之前】就能同步看出的本地前提；
// 这里判的是订阅【失败之后】拿到的那句 error.message——网络可达性是异步、外部、会变的，
// 进不了上面那个纯环境判定。
//
// 【为什么值得单独判一类】Chromium 系（Android Chrome/Edge/三星）的 Web Push 由 Google FCM 承载，
// subscribe() 要先向 Google 的注册端点注册。无法访问 Google 的网络下这一步必然失败，而浏览器
// 只抛一句 'Registration failed - push service error'，原样透给用户等于天书（实测机主在中国大陆
// 网络下正是卡在这里）。判出来才能告诉他「开代理重试一次就好，之后不用一直开」。
//
// 【iOS 恒 null】那条路走 Apple 的 web.push.apple.com，压根不经 Google。给 iPhone 用户提代理
// 是把人指向完全错误的排查方向，比不解释更糟。
//
// 【permission 必须先判】'Registration failed - permission denied' 同时含 "registration failed"，
// 顺序反了会把「权限被拒」误报成「网络不通」——两者的下一步动作毫无交集。
export function describeSubscribeError(message, { isIOS = false } = {}) {
  if (isIOS) return null;
  const msg = String(message ?? '');
  if (!msg) return null;
  if (/permission (denied|blocked)/i.test(msg)) return null;
  if (/push (service|server)/i.test(msg)) return 'push-service-unreachable';
  if (/registration failed/i.test(msg)) return 'push-service-unreachable';
  return null;
}

// 推送订阅状态行（配置面板「推送内容」段上方）。
// 为什么需要它：推送不通时此前界面上**没有任何痕迹**——铃铛按钮本身在"权限被拒"时会被隐藏、
// 在"已授权但订阅失败"时压根不出现，用户只会得出"这功能没用"的结论（实测机主机器上
// push-subscription.json 从未存在过，而 UI 一个字都没说）。状态必须看得见，且看得出下一步做什么。
export function formatPushStatusRow({ hint = 'ready', permission = 'default', subscribed = false } = {}) {
  const label = t('推送通知');
  if (hint === 'need-https') {
    return { label, value: t('不可用'), tone: 'warn', action: null,
      hint: t('浏览器只在 HTTPS 下允许订阅推送。用隧道域名（https）打开本站即可。') };
  }
  if (hint === 'ios-add-home') {
    return { label, value: t('不可用'), tone: 'warn', action: null,
      hint: t('iOS 必须先「添加到主屏幕」，再从主屏图标打开本站才能订阅推送。') };
  }
  if (hint === 'unsupported') {
    return { label, value: t('不可用'), tone: 'warn', action: null,
      hint: t('当前浏览器不支持 Web Push（iOS 需 16.4+ 且已加主屏）。') };
  }
  if (permission === 'denied') {
    return { label, value: t('已被拒绝'), tone: 'warn', action: null,
      hint: t('此前拒绝过通知权限。需在浏览器/系统的站点设置里改回「允许」，再回来开启。') };
  }
  if (subscribed) {
    return { label, value: t('已开启'), tone: 'ok', action: null };
  }
  // 已授权却没订阅上 = 订阅请求失败过（此前这条路彻底静默，用户永远不知道）
  const value = permission === 'granted' ? t('未完成订阅') : t('未开启');
  return { label, value, tone: 'warn', action: 'subscribe', actionText: t('开启'),
    hint: t('开启后，需要你审批、有提问、任务完成时手机会收到通知') };
}

// 完成提示（提示音 / 震动 / 前台系统通知）本地偏好——默认全开，仅显式存 '0' 为关。
// storage 键与 localStorage 对齐；纯函数便于单测，不直接碰 window。
export const ALERT_PREF_KEYS = Object.freeze({
  sound: 'ccm_alert_sound',
  vibrate: 'ccm_alert_vibrate',
  foregroundComplete: 'ccm_alert_fg_complete',
});
export function readAlertPrefs(getItem) {
  const g = typeof getItem === 'function' ? getItem : () => null;
  // 缺省 / 非 '0' → true（默认开）；只有字面量 '0' 为关
  const on = (k) => g(k) !== '0';
  return {
    sound: on(ALERT_PREF_KEYS.sound),
    vibrate: on(ALERT_PREF_KEYS.vibrate),
    foregroundComplete: on(ALERT_PREF_KEYS.foregroundComplete),
  };
}
export function writeAlertPref(setItem, key, enabled) {
  const storageKey = ALERT_PREF_KEYS[key];
  if (!storageKey || typeof setItem !== 'function') return false;
  setItem(storageKey, enabled ? '1' : '0');
  return true;
}

// ⑧ 推送内容预览开关——与上面 ALERT_PREF_KEYS 反极性：默认关，仅显式存 '1' 为开。web-push 通道本身
// 已是 RFC 8291 端到端加密（push service/FCM 读不到明文），但仍是"锁屏可见明文"的泄露面，默认最小化、
// 要更详细的通知内容需机主本人主动选择（订阅时随 prefs.preview 一并 POST，见 app/notifications.js）。
export const PUSH_PREVIEW_PREF_KEY = 'ccm_push_preview';
export function readPushPreviewPref(getItem) {
  const g = typeof getItem === 'function' ? getItem : () => null;
  return g(PUSH_PREVIEW_PREF_KEY) === '1';
}
export function writePushPreviewPref(setItem, enabled) {
  if (typeof setItem !== 'function') return false;
  setItem(PUSH_PREVIEW_PREF_KEY, enabled ? '1' : '0');
  return true;
}

function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 60000) return t('刚刚');
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} ${t('分钟前')}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${t('小时前')}`;
  return `${Math.floor(hours / 24)} ${t('天前')}`;
}

// 服务状态面板「终端会话推送」行：CLI hooks 桥的安装态 + 该给什么按钮。
// 这是手机上唯一能开关它的入口（npm 命令只能在电脑终端跑），所以文案要说清"开了能多得到什么"。
// 三处刻意不给按钮：① env 停用时——正解是改 .env 重启，给按钮等于误导；② 漂移时——用户自己动过
// settings.json，一键覆盖会踩掉他的改动，交给他自己 hooks:status 决断；③ 状态读不出时——盲点
// "开启"可能覆盖一份其实存在、只是没读成功的配置。
//
// 缺席只留给「不知道有没有这功能」这一种：旧 server 不带 hooksBridge 字段时前端无从判断，返回 null
// 整段不渲染。而 state==='unknown' 是 server 明确说「读 ~/.claude 出错了」（cli-hooks-bridge.js:322
// 的 catch），功能确定存在——早先把它一并判成 null，等于让一个已知故障表现得像"这里从来没东西"，
// 而这一段是手机上唯一能看到/操作 hooks 桥的入口，消失即彻底失联。改为就地说明：既不误报未装
// （原判据要守的正是这条），也不留白。
export function formatHooksBridgeRow(hooksBridge) {
  const state = hooksBridge?.state;
  if (!state) return null;
  const label = t('终端会话推送');
  // off 先判：它由 env 直接决定、不经读盘，比「安装态读不出」更确定也更要紧——功能整体停用时
  // 装没装都不影响它不工作，先报读取失败会把人引去修一个修好了也没用的东西。
  if (hooksBridge.off) {
    return { label, value: t('已停用（CLI_HOOKS_BRIDGE=off）'), tone: 'muted', action: null };
  }
  if (state === 'unknown') {
    return {
      label,
      value: t('状态读取失败'),
      tone: 'warn',
      action: null,
      hint: t('读不出 ~/.claude/settings.json 的安装记录，可能是文件损坏或权限变更；在电脑上跑 npm run hooks:status 查看'),
    };
  }
  if (state === 'installed') {
    return { label, value: t('已启用'), tone: 'ok', action: 'uninstall', actionText: t('关闭') };
  }
  if (state === 'drifted') {
    return { label, value: t('配置已被改动'), tone: 'warn', action: null };
  }
  return {
    label,
    value: t('未启用'),
    tone: 'muted',
    action: 'install',
    actionText: t('开启'),
    hint: t('开启后，你在电脑终端里跑的会话完成或需要你时，手机会收到通知'),
  };
}

// 组装会话面板"服务"小节文案（需要你之后、目录列表之前，仅异常时渲染）。空数组=一切正常。
// 判定化告警三类，固定顺序：限速锁定(⛔ 安全信号) → 投递失败(🔔) → 前端错误(🐞)。
// 各类均由服务端时效窗判定（超窗自动退场，见 metrics.js recentIncident/recentDeliveryFailure）；
// 旧 server 无新字段 → 优雅缺席。刻意不吞并/复用"需要你(N)"聚合的展示逻辑——
// 两条轴分开陈列，不让服务健康看起来像"更多同类待办"。
// 「重启记录」段的行。
//
// 判定化而不是给裸计数器：`launchctl` 的 LastExitStatus 是瞬时值，回答不了「这正常吗」。
// 机主机器上的实证——隧道恒为 -9，因为自建看门狗每天按 DHCP 漂移 kickstart 一次。
// 所以这里展示的是**频率 + 时间线**：每天一次一眼看得出是例行的，密集连发才是真出事了。
export function formatRestartRows({ restarts, now = Date.now() } = {}) {
  const units = restarts?.units || [];
  const recent = restarts?.recent || [];
  if (units.length === 0 && recent.length === 0) {
    return { summary: [], timeline: [], empty: true };
  }

  const summary = units
    // `|| u.flapping` 不是冗余的防御：flapping 恒蕴含 last24h ≥ 3（1 小时窗口 ⊂ 24 小时窗口），
    // 但那是**当前生产者**的性质，判据万一改了这里不该跟着漏掉告警行。
    .filter((u) => u.last24h > 0 || u.flapping)
    .map((u) => ({
      label: u.label,
      // flapping 的判据是频率（1 小时内 ≥3 次），不是「上次退出码非 0」
      text: u.flapping
        ? `${t('1 小时内重启')} ${u.lastHour} ${t('次')}`
        // manual24h 单独说：这一行的「N 次」只数无法解释的重启，而「上次」指向的是全部重启里
        // 最近的一条。一次崩溃 + 三次面板重启若不点明，就成了「24 小时内 1 次 · 上次 刚刚」，
        // 而那个「上次」并不在这 1 次里 —— 同一行自相矛盾。旧 server 不带这个字段，照旧不显示。
        : `${t('24 小时内')} ${u.last24h} ${t('次')}${u.manual24h > 0 ? `（${t('另有手动重启')} ${u.manual24h} ${t('次')}）` : ''} · ${t('上次')} ${formatAgoShort(now - u.lastRestartAt)}`,
      alert: !!u.flapping,
    }));

  const timeline = recent.map((e) => ({
    label: e.label,
    text: `${formatAgoShort(now - e.ts)} ${restartKindText(e.kind)}`,
  }));

  return { summary, timeline, empty: false };
}

function restartKindText(kind) {
  if (kind === 'restarted') return t('重启');
  if (kind === 'started') return t('启动');
  if (kind === 'stopped') return t('停止');
  // 用户从手机点的「立即重启」，在退出前记下的声明。它不计入 flapping 频率，但要进时间线：
  // 少了这一条，时间线上就只剩一次孤零零的「重启」，看的人无从判断那是自己按的还是崩的。
  if (kind === 'restart-requested') return t('手动重启');
  return kind || '?';
}

// 粗粒度「多久以前」。UI 要的是量级不是精度。
// 返回的是**完整短语**，调用方不要再补「前」。
// 此前这里混着两类返回值：'刚刚' / '?' 本身就是完整的，而 '5 分钟' 是待补量词的片段，
// 两个调用点又无条件拼「前」 —— 于是每次重启服务后打开服务状态，那条刚记下的必然读作
// 「刚刚前 启动」；客户端时钟落后于服务端时差值为负，还会读作「?前 重启」。
// 同文件的 formatAgo 一直是把「前」烘焙进每个分支的，与它对齐。
export function formatAgoShort(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const m = Math.floor(ms / 60000);
  if (m < 1) return t('刚刚');
  if (m < 60) return `${m} ${t('分钟前')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${t('小时前')}`;
  return `${Math.floor(h / 24)} ${t('天前')}`;
}

// 限速桶 key → 来源画像。入参是后端 rlSourceKey 的产物（'ip:<桶>' / 'cfip:<桶>'，IPv6 已归成
// /64 前缀），也就是**限速真正计数的那个粒度**——刻意不另算一套「客户端 IP」，否则面板说的地址
// 和被锁的桶会是两回事。
//
// 【为什么必须分叉】(2026-09-02) 告警行此前无条件拼「可能有人在暴力尝试你的入口」。机主看到后
// 翻 audit-records.json 才发现两次锁定的 target 都是 ip:127.0.0.1 —— 本机自己的旧 token 连试八次。
// 一条把「自己手滑」讲成「有人在攻击你」的红色告警，比不报还糟：真出事那天它已经被当成噪音了。
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', 'localhost']);
// 后端 ipRateBucket 把 ::1 归成 /64 前缀 `0:0:0:0::/64`（IANA 保留段，含 loopback / unspecified）。
// 只认字面量 ::1 会让 BIND_HOST=:: 下本机锁定被说成公网暴力尝试。
const LOOPBACK_V6_BUCKETS = new Set(['0:0:0:0::/64', '::/64']);
// 私网/内网：IPv4 RFC1918 + link-local + 100.64/10（CGNAT，也是 Tailscale 的地址池）；
// IPv6 ULA(fc00::/7 → fc/fd 开头) + link-local(fe80::/10)。边界写死在正则里——172.15/172.32、
// 100.63/100.128 都是公网，多吃一段就会把真正的外部攻击说成「局域网」。
function isPrivateAddr(addr) {
  const s = addr.toLowerCase();
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(s)) return true;
  return /^(f[cd]|fe80)/.test(s);
}
function isLoopbackAddr(addr) {
  const s = String(addr || '').toLowerCase();
  return LOOPBACK_ADDRS.has(s) || LOOPBACK_V6_BUCKETS.has(s);
}
export function describeRateLimitSource(source) {
  const raw = String(source ?? '').trim();
  const addr = raw.replace(/^(?:cfip|ip):/, '');
  if (!addr) return { scope: 'unknown', addr: '' };
  if (isLoopbackAddr(addr)) return { scope: 'local', addr };
  if (isPrivateAddr(addr)) return { scope: 'lan', addr };
  return { scope: 'public', addr };
}

// 「连不上」与「对方答了话但拒绝了」是两类根因，下一步动作毫无交集（前者查网络/代理，
// 后者查 VAPID/token 配置），故只翻译前者。整串精确匹配而非子串：describeDeliveryError 的输出
// 要么是裸 errno、要么是 'HTTP <code>'、要么是清洗过的短语，不会是长句，宽松匹配只会误伤。
const DELIVERY_NET_UNREACHABLE = /^(ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|network error)$/i;

export function formatServiceNotices({ service, now } = {}) {
  const notices = [];
  const countSuffix = c => (Number.isFinite(c) && c > 0 ? `${t('（累计')} ${c} ${t('次）')}` : '');
  const lockout = service && service.rateLimitLockout;
  if (lockout && typeof lockout.at === 'number') {
    const src = describeRateLimitSource(lockout.source);
    // unknown（旧 server ack 无 source）保留原保守措辞：说不清来源时，宁可提醒过度也不误导为安全。
    const tail = src.scope === 'local' ? `${t('——来自本机')} ${src.addr}${t('，多半是你自己的旧 token')}`
      : src.scope === 'lan' ? `${t('——来自局域网')} ${src.addr}`
        : src.scope === 'public' ? `${t('——公网')} ${src.addr} ${t('在暴力尝试你的入口')}`
          : t('——可能有人在暴力尝试你的入口');
    notices.push(`${t('⛔ 登录限速锁定于')} ${formatAgo(now - lockout.at)}${countSuffix(lockout.count)}${tail}`);
  }
  const df = service && service.deliveryFailure;
  if (df && typeof df.at === 'number') {
    const channelLabel = df.channel === 'ntfy' ? 'ntfy' : 'push';
    const cnt = Number.isFinite(df.count) && df.count > 0 ? `${t('，累计')} ${df.count} ${t('次')}` : '';
    // reason 已由后端 describeDeliveryError 清洗（不含 endpoint URL，见 src/ops/notifications.js）。
    // 空串也要当缺席处理，否则行尾留一个孤零零的冒号。
    const reason = String(df.reason ?? '').trim();
    // 网络不可达类是裸 errno，对用户是天书，而它恰恰是最常见的一类——宿主机连不出去时推送全灭，
    // 手机端却一切正常（订阅还在、铃铛已收起），这行是唯一的可见面。errno 保留在括号里给排查用。
    // 不写死「Google FCM」：iOS 订阅的 endpoint 在 Apple，同一条路也会走到这里。
    const reasonText = reason && DELIVERY_NET_UNREACHABLE.test(reason)
      ? `${df.channel === 'ntfy' ? t('连不上 ntfy 服务') : t('连不上推送服务')}（${reason}）`
      : reason;
    notices.push(`${t('🔔 推送最近失败于')} ${formatAgo(now - df.at)}（${channelLabel}${cnt}）${reasonText ? `：${reasonText}` : ''}`);
  }
  const ce = service && service.clientError;
  if (ce && typeof ce.at === 'number') {
    notices.push(`${t('🐞 前端错误发生于')} ${formatAgo(now - ce.at)}${countSuffix(ce.count)}${t('，详见日志面板')}`);
  }
  return notices;
}

// 诊断时间线（镜像/轮次/停止）文案模板：每条事件译成判定过的一句话 + severity，不裸吐 detail
// JSON——折叠会重蹈 logs:clientError 链路"只知道发生过、不知道具体是哪条"的覆辙，这里刻意保留
// 每条事件的细节和时间顺序；"判定化"精神只用在 severity 着色上，不用在合并/折叠时间线上。
const DIAG_TAG_LABEL = {
  interrupt: '停止', stop_task: '停止单任务',
  set_model: '切换模型', set_permission_mode: '切换权限档',
};
// statusline 额度(5h/7d)不可用原因 → 一句话文案。third_party_auth 是预期状态（API Key/Bedrock/
// Vertex 等本就不带订阅额度），非故障；其余三种代表"本该有却没显示"，值得警觉。
const RATE_REASON_LABEL = {
  rpc_no_method: 'Claude Code 版本过旧，暂不支持额度查询接口',
  rpc_error: 'SDK 额度接口调用失败或超时',
  third_party_auth: '当前鉴权（API Key / Bedrock / Vertex 等）不提供订阅额度信息',
  no_valid_window: 'SDK 返回的额度数据缺失或超出正常范围',
};
export function formatDiagLogEntry({ ts, subsystem, event, detail = {} } = {}) {
  const d = detail && typeof detail === 'object' ? detail : {};
  let text, severity = 'neutral';
  if (event === 'race_settle') {
    const tagLabel = t(DIAG_TAG_LABEL[d.tag]) || d.tag || t('控制请求');
    if (d.ok) {
      text = `${tagLabel} ${t('成功（')}${d.ms}ms）`;
    } else {
      text = `${tagLabel} ${t('失败：')}${d.error || 'timeout'}（${d.ms}ms）`;
      severity = 'danger';
    }
  } else if (subsystem === 'mirror' && event === 'state_change') {
    text = d.readonly ? `${t('🔒 镜像锁定（')}${d.reason || t('未知')}）` : `${t('🔓 镜像解锁（')}${d.reason || t('未知')}）`;
  } else if (subsystem === 'mirror' && event === 'entry_lock_decision') {
    text = d.locked
      ? `${t('🔒 切入即锁定：终端疑似在跑（尾部=')}${d.tailVerdict}）`
      : `${t('👀 切入未锁：')}${d.agedOutStale ? t('陈旧挂起，判定已过期') : `${t('尾部=')}${d.tailVerdict}`}`;
  } else if (subsystem === 'interrupt' && event === 'settled') {
    if (d.outcome === 'success') {
      // droppedCount = 停止时尚未送达 SDK 的消息数（send 后数毫秒的窄竞态窗），排队移除后通常恒 0
      text = d.droppedCount > 0 ? `${t('⏹ 停止成功（丢弃')} ${d.droppedCount} ${t('条未送达消息，')}${d.ms}ms）` : `${t('⏹ 停止成功（')}${d.ms}ms）`;
    } else if (d.outcome === 'forced_settle') {
      text = d.timedOut ? `${t('⏱ 停止超时，已强制收口（')}${d.ms}ms）` : `${t('⚠️ 停止被拒，已强制收口（')}${d.ms}ms）`;
      severity = 'warning';
    } else if (d.outcome === 'no_task') {
      text = t('ℹ️ 当前无可中断任务');
    } else if (d.outcome === 'disposed') {
      text = t('实例已释放，停止请求作废');
    } else {
      text = `${t('⏹ 停止：')}${d.outcome ?? t('未知结果')}`;
    }
  } else if (subsystem === 'queue' && event === 'turn_settled') {
    text = d.wasInterrupted ? t('轮次因中断结束') : `${t('轮次结束（')}${Number.isFinite(d.durationMs) ? d.durationMs + 'ms' : '?'}）`;
  } else if (subsystem === 'resume' && event === 'settled') {
    text = `${t('续接完成（')}${d.ms}ms）`;
  } else if (subsystem === 'catchup' && event === 'tick') {
    text = `${t('追平巡检一次（')}${d.ms}ms）`;
  } else if (subsystem === 'message' && event === 'enqueued') {
    text = d.hasAttachments ? `${t('消息已入队（含附件，')}${d.ms}ms）` : `${t('消息已入队（')}${d.ms}ms）`;
  } else if (subsystem === 'statusline' && event === 'rate_reason_change') {
    if (d.reason) {
      const label = t(RATE_REASON_LABEL[d.reason]) || d.reason;
      // 耗时只在故障那一刻出现：SDK get_usage 在 CLI 侧含网络请求 + 全量 transcript 扫盘，
      // 「本次 Nms／上次成功 Nms」是判断 1500ms 阈值是否太紧、扫盘是否在变慢的唯一实测依据。
      const timing = `${Number.isFinite(d.ms) ? `，${d.ms}ms` : ''}${Number.isFinite(d.lastOkMs) ? `${t('／上次成功 ')}${d.lastOkMs}ms` : ''}`;
      text = `${t('📊 额度显示不可用：')}${label}${d.message ? `（${d.message}）` : ''}${timing}`;
      severity = d.reason === 'third_party_auth' ? 'neutral' : 'warning';
    } else {
      const prevLabel = t(RATE_REASON_LABEL[d.previousReason]) || d.previousReason || t('未知原因');
      text = `${t('📊 额度显示已恢复（此前：')}${prevLabel}）`;
    }
  } else {
    // 未识别的 (subsystem,event) 组合：兜底渲染，不静默吞掉（延续 agent.js map() 对未映射 SDK 消息的既有原则）
    text = `${subsystem}/${event} ${JSON.stringify(d).slice(0, 200)}`;
  }
  return { ts, type: `diag_${subsystem}`, text, severity };
}

// 审计记录 → 一行人话 + severity（服务状态面板「安全日志」段）。
// 抽屉告警只说「发生了什么」；这一段回答「是谁、几次、从哪来」。
// 判定只用在 severity 着色，不做合并。未知 action 兜底渲染，不静默吞。
const AUDIT_SCOPE_LABEL = { local: '本机', lan: '局域网', public: '公网' };
const AUDIT_NEUTRAL_TEXT = {
  retention_cleanup: '审批记录留存清理',
  approval_restart_expired: '重启使待审批请求失效',
};
export function formatAuditEntry({ ts, action, target, outcome, meta } = {}) {
  const d = meta && typeof meta === 'object' ? meta : {};
  const tgt = target == null ? '' : String(target);
  const via = d.via ? ` · ${d.via}` : '';
  // 设备 ID 是指纹 hash，全量显示既占宽又没人逐字读；前 8 位足够在几台设备间区分。
  const shortId = tgt.slice(0, 8);
  let text, severity = 'neutral';

  if (action === 'auth_rate_limited') {
    const src = describeRateLimitSource(tgt);
    const where = src.scope === 'unknown' ? tgt : `${t(AUDIT_SCOPE_LABEL[src.scope])} ${src.addr}`;
    text = `${t('登录限速锁定')} · ${where}${via}`;
    // 只有公网来源才是安全事件。本机/局域网连试到阈值几乎总是自己的旧 token 或写错的脚本，
    // 标成 danger 会让真正该警觉的那一条淹没在自造的红字里。
    severity = src.scope === 'public' ? 'danger' : 'warning';
  } else if (action === 'device_approved') {
    text = `${t('批准设备')} ${shortId}${via}`;
  } else if (action === 'device_denied') {
    text = `${t('拒绝设备')} ${shortId}${via}`;
  } else if (action === 'device_revoked') {
    text = `${t('吊销设备')} ${shortId}${via}`;
    severity = 'warning';
  } else if (action === 'scope_violation') {
    text = `${t('越界访问被拒')} · ${tgt}`;
    severity = 'danger';
  } else if (action === 'approval_integrity_mismatch') {
    text = `${t('审批完整性校验失败')} · ${tgt}${d.tool ? ` · ${d.tool}` : ''}`;
    severity = 'danger';
  } else if (action === 'env_changed') {
    text = `${t('修改配置')} · ${tgt}`;
    severity = 'warning';
  } else if (action === 'server_restart') {
    text = `${t('重启服务')}${d.via ? ` · ${d.via}` : ''}${d.reason ? ` · ${d.reason}` : ''}`;
    if (outcome === 'denied') severity = 'warning';
  } else if (action === 'session_delete_l2') {
    text = `${t('永久删除会话')} ${tgt}`;
  } else if (action === 'file_write') {
    // 路径尾段即可：手机屏放不下绝对路径，而「改了哪个文件」才是这条记录的信息量所在。
    text = `${t('写入文件')} ${tgt.split('/').pop() || tgt}`;
  } else if (AUDIT_NEUTRAL_TEXT[action]) {
    text = t(AUDIT_NEUTRAL_TEXT[action]);
  } else {
    text = `${action || '?'}${tgt ? ` · ${tgt}` : ''}`;
  }

  // 同一个 action 的成功与失败必须看得出区别。但只追加**文案里没说过**的 outcome：
  // success/allowed 追加等于每行拖一个信息量为零的尾巴；denied/locked 已经写在动词里了
  // （「被拒」「拒绝设备」「限速锁定」）。剩下的 partial_failure / error 才是必须显式说出来的。
  const OUTCOME_ALREADY_IN_TEXT = new Set(['success', 'allowed', 'denied', 'locked', undefined, null, '']);
  if (!OUTCOME_ALREADY_IN_TEXT.has(outcome)) text += `（${outcome}）`;
  return { ts, type: 'audit', text, severity };
}

// 交互日志抽屉「全部｜交互｜诊断」三态过滤：诊断行的 type 统一 diag_ 前缀。未知 filter 值保守
// 原样返回（不误伤显示）。
export function filterConsoleEntries(entries, filter) {
  const list = Array.isArray(entries) ? entries : [];
  if (filter === 'diag') return list.filter(e => String(e?.type || '').startsWith('diag_'));
  if (filter === 'interaction') return list.filter(e => !String(e?.type || '').startsWith('diag_'));
  return list;
}

// 基础段四行。versions 缺失字段显 unknown（升级半途/旧 server 也能渲染）；
// 连接行的延迟复用 formatRttMs（非法→'' 时只显「已连接」，不残留陈旧数字）。
export function serviceStatusBasicRows({ startedAt, versions, connected, rttMs, now, logging } = {}) {
  const startedValid = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0;
  const uptime = startedValid ? formatUptime(now - startedAt) : '';
  let startedLabel = t('未知');
  if (startedValid) {
    const d = new Date(startedAt);
    const two = n => String(n).padStart(2, '0');
    startedLabel = `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
  }
  const v = versions && typeof versions === 'object' ? versions : {};
  const pick = key => (typeof v[key] === 'string' && v[key] ? v[key] : 'unknown');
  const rtt = formatRttMs(rttMs);
  const rows = [
    { label: t('运行时长'), value: uptime || t('未知') },
    { label: t('启动于'), value: startedLabel },
    { label: t('版本'), value: `server ${pick('server')} · CLI ${pick('cli')} · SDK ${pick('sdk')}` },
    { label: t('连接'), value: connected ? `${t('已连接')}${rtt ? ` · ${t('延迟')} ${rtt}` : ''}` : t('未连接') },
  ];
  // 日志开关可见性：DEBUG_SDK_MESSAGES 曾长开半月把日志刷到 149M，此前没有任何界面能看到
  // "调试开关开着"这个事实。sdkDebug 开着标 alert（接线层标黄）；旧 server ack 无 logging → 优雅缺席。
  if (logging && typeof logging === 'object') {
    const sw = v => (v ? t('开') : t('关'));
    rows.push({
      label: t('日志开关'),
      value: `${t('交互日志')} ${sw(logging.interactions)} · ${t('SDK 调试')} ${sw(logging.sdkDebug)} · stderr ${sw(logging.stderr)}`,
      alert: !!logging.sdkDebug,
    });
  }
  return rows;
}

// 指标段（九行裸计数器）已判定化撤除：裸计数对人无参照系不可解读（好/坏不可判），
// 是 /metrics 巡检端点的机器原料；有信号的两项（限速锁定/前端错误）升格进 formatServiceNotices
// 带时效窗告警。原始计数仍在 GET /metrics（鉴权）。

// ---- 全局 JS 错误上报（手机浏览器无 devtools，错误经 socket 落服务端日志）----

const CLIENT_ERROR_CAPS = { message: 500, source: 300, stack: 1500 };
const clampStr = (v, cap) => (typeof v === 'string' && v ? v.slice(0, cap) : null);

// 错误事件 → 上报载荷 + 去重签名。kind='error' 取 ErrorEvent 字段；
// kind='unhandledrejection' 的 reason 可能是 Error/字符串/任意值，分别取 message/stack 或 String 化。
export function buildClientErrorReport(kind, info = {}) {
  let message = info.message;
  let stack = info.stack;
  if (info.reason !== undefined) {
    const r = info.reason;
    if (r && typeof r === 'object') { message = r.message ?? String(r); stack = r.stack ?? stack; }
    else message = String(r);
  }
  const payload = {
    kind: kind === 'unhandledrejection' ? 'unhandledrejection' : 'error',
    message: clampStr(String(message ?? ''), CLIENT_ERROR_CAPS.message) || t('(无错误信息)'),
    source: clampStr(info.source, CLIENT_ERROR_CAPS.source),
    line: Number.isFinite(info.line) ? info.line : null,
    col: Number.isFinite(info.col) ? info.col : null,
    stack: clampStr(stack, CLIENT_ERROR_CAPS.stack),
  };
  const loc = payload.source ? `${payload.source}:${payload.line ?? '?'}` : '';
  return { payload, signature: `${payload.kind}|${payload.message.slice(0, 120)}|${loc}` };
}

// 去重+限流门（纯步进，状态由接线层持有）：同签名窗口内只报一次；窗口内最多 max 条；
// 窗口滚动整体复位。防错误风暴（如 rAF 循环里抛错）刷爆 socket 与服务端日志。
export function clientErrorGateStep(state, signature, now, { windowMs = 60000, max = 5 } = {}) {
  let s = state;
  if (!s || now - s.windowStart >= windowMs) s = { windowStart: now, sent: 0, seen: [] };
  if (s.seen.includes(signature) || s.sent >= max) return { state: s, send: false };
  return { state: { windowStart: s.windowStart, sent: s.sent + 1, seen: [...s.seen, signature] }, send: true };
}

// ---- 客户端日志持久化/导出（抗 PWA 被 iOS 杀：环形缓冲纯内存，事故瞬间证据蒸发）----

const CLIENT_LOG_SCHEMA = 1;         // 结构版本：不符即安全丢弃（不迁移旧格式，避免坏数据污染）
const CLIENT_LOG_PERSIST_MAX = 500;  // 落盘上限：防 localStorage 超配额（~5MB）

// entries → JSON 字符串（含 schema 版本）。只留最后 max 条：localStorage 同步写，越小越省。
export function serializeClientLogs(entries, { max = CLIENT_LOG_PERSIST_MAX } = {}) {
  const arr = Array.isArray(entries) ? entries.slice(-max) : [];
  return JSON.stringify({ v: CLIENT_LOG_SCHEMA, entries: arr });
}

// JSON 字符串 → entries[]。不可信持久化数据：任何异常/结构不符/版本不符一律 → []（不崩、不污染）。
// 每条打 restored:true——渲染层据此在「上次会话」与本次之间画分隔（见 isRestoredBoundary）。
export function deserializeClientLogs(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  let obj;
  try { obj = JSON.parse(raw); } catch { return []; }
  if (!obj || obj.v !== CLIENT_LOG_SCHEMA || !Array.isArray(obj.entries)) return [];
  return obj.entries
    .filter(e => e && typeof e === 'object')
    .map(e => ({ ...e, restored: true }));
}

// 节流决策：距上次落盘是否已够久（默认 2s）。lastTs 空=从没写过→立即写。push 高频，靠此免每条同步写。
export function shouldPersistLog(lastTs, now, intervalMs = 2000) {
  if (lastTs == null) return true;
  return now - lastTs >= intervalMs;
}

// 导出多行文本：`[本地时间] type text`，供抽屉「复制全部」发给电脑/贴给 Claude 排障。
export function formatLogsForCopy(entries) {
  if (!Array.isArray(entries) || !entries.length) return '';
  return entries.map(e => {
    const time = e?.ts ? new Date(e.ts).toLocaleTimeString() : '';
    const type = String(e?.type ?? '').replace(/^client_/, '');
    return `[${time}] ${type} ${e?.text ?? ''}`.trim();
  }).join('\n');
}
