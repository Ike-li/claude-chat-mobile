// logic/mirror.js —— 只读镜像横幅/提示 · 接管状态机
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t } from '../i18n.js';

// 排队接管状态机（接管=等终端本轮完结再放行，纯 web 侧、零终端侵入）。
// 驾驶中点「接管 CLI 会话」进入 armed：不立即解锁（立即发送会与终端在跑的 turn 并发写盘），而是等
// 现有镜像锁的自动释放信号。armed 期间只有三个出口：
//   unlock-focus  = readonly=false 到达（终端本轮完结，服务端自动解锁）→ 放行 + 聚焦输入
//   unlock-stale  = 同会话转 stale（等待中终端 5 分钟零写入疑似中断）→ 自动完成接管（提示保留分叉风险说明）
//   disarm        = 用户切走会话（armed 意图随视图作废，与 mirrorOverriddenSid 同策略）
// 未 armed 时对任何信号回 none，不干扰现有 onMirrorState 解锁路径。
export function armedTakeoverStep(state = {}, signal = {}) {
  const { armed, armedSid } = state || {};
  if (!armed) return { action: 'none' };
  const { kind, readonly, stale, sessionId } = signal || {};
  if (kind === 'switch') return { action: 'disarm' };
  if (kind === 'mirror') {
    if (!readonly) return { action: 'unlock-focus' };
    if (stale && sessionId === armedSid) return { action: 'unlock-stale' };
  }
  return { action: 'none' };
}

// 只读镜像锁横幅文案（三态：armed / stale / driving）。
// 与后端 lifecycle 文案对齐：只读 ≠ 会话结束；stale = 疑似中断（可续接），不是「已结束」。
// 主操作在发送钮位「续接 CLI 会话」；自动解锁仍由服务端 ~12.5s 静默负责，不写假精密倒计时。
// autonomous：server 端 classifyTranscriptTail 能确定这是本会话自己被 ScheduleWakeup/CronCreate 定时
// 唤起（尾窗内查到 harness 注入的 marker），而非真不知道来源的「大概率终端」——2026-07-24 真机复现过
// 100% web 发起的会话被自主循环唤起时误显「终端会话运行中」；两者磁盘形态相同、锁本身都该维持，
// 只是这里换更准确的措辞。查不到 marker（老调用方不传/确实是未知来源）时保持原「终端」文案不变。
// isWebInitiated（2092778）：web 自己发起的会话刷新后内存态丢失、易被误判 stale，故对它**只**抑制
// 「疑似中断」这类推断态。armed 不在抑制之列——那是用户刚点下「续接」的显式操作，任何来源都必须
// 如实反馈（原实现用提前 return 连 armed 一起吞了，而 app.js 两个调用点又硬编码 isWebInitiated:true，
// 导致「已请求续接」文案在生产中完全不可达，图标却照常切成 ⏳，自相矛盾）。
export function formatMirrorBannerText({ armed = false, stale = false, autonomous = false, isWebInitiated = false } = {}) {
  if (armed) return autonomous
    ? t('只读镜像：已请求续接，等待自主循环当前操作完成…')
    : t('只读镜像：已请求续接，等待终端当前操作完成…');
  // 不写「超 5 分钟无活动」：stale 有两条触发路径，服务重启腰斩那条（mirrorStaleFlag 的 serverStartedAt
  // 判据）几十秒就会置位，写死时长会说谎。文案只讲判定结论「疑似中断、可续接」。
  if (stale && !isWebInitiated) return autonomous
    ? t('只读镜像：自主循环疑似中断——确认已停可续接')
    : t('只读镜像：终端疑似中断——确认已停可续接');
  if (autonomous) return t('只读镜像：本会话自主循环执行中，移动端当前只读');
  return t('只读镜像：终端会话运行中，移动端当前只读');
}

// 驾驶中点输入区/附件时的可操作说明（比横幅短句更完整：能/不能/硬要怎么做）。
// 主操作指向发送钮位「续接」。单行 · 分隔：addBar 用 textContent，无 pre-wrap。
// isWebInitiated 语义同 formatMirrorBannerText：只抑制 stale 这类推断态，绝不抑制 armed。
export function formatMirrorComposerHint({ armed = false, stale = false, autonomous = false, isWebInitiated = false } = {}) {
  // 等待上界「最长约 5 分钟」锚定 server 端 history.js MIRROR_STALE_PENDING_MS（注册表负证据命中时
  // 秒级；这里写保守上界）——2026-07-28 真机：用户杀掉 CLI 后以为排队永远不放行，点了重启服务。
  if (armed) return autonomous
    ? t('只读镜像：已请求续接——等自主循环当前操作完成后自动可写；若它已停止，最长约 5 分钟自动判定中断并完成续接。可点「取消续接」撤销。')
    : t('只读镜像：已请求续接——等终端当前操作完成后自动可写；若终端已被关闭，最长约 5 分钟自动判定中断并完成续接。可点「取消续接」撤销。');
  if (stale && !isWebInitiated) return autonomous
    ? t('只读镜像：自主循环疑似中断。确认已停后点「续接」即可在手机继续（会话历史仍在）。')
    : t('只读镜像：终端疑似中断。确认终端已停后点「续接」即可在手机继续（会话历史仍在）。');
  if (autonomous) return t('只读镜像：本会话自主循环执行中，移动端当前只读 · 不能：打字/发图/改模型权限思考 · 能：看消息、等自主循环静默后自动可写 · 硬要手机继续：点右侧「续接」（等本轮结束再放行；有分叉风险）');
  return t('只读镜像：终端会话运行中，移动端当前只读 · 不能：打字/发图/改模型权限思考 · 能：看消息、等终端静默后自动可写 · 硬要手机继续：点右侧「续接」（等本轮结束再放行；疑似中断可立即续接，有分叉风险）');
}

// 同文案节流：避免用户连点输入框刷一串相同 bar；换文案（armed/stale 切换）立即放行。
export function shouldEmitThrottledHint({
  lastText = '',
  lastAt = 0,
  nextText = '',
  now = 0,
  throttleMs = 2500,
} = {}) {
  if (!nextText) return false;
  if (nextText === lastText && Number(now) - Number(lastAt) < Number(throttleMs)) return false;
  return true;
}

// 是否接纳一条 mirror_state（防跨会话/跨工作区误锁）。
// 契约：
//   · readonly=false → 一律接受解锁（含 sessionId/instanceId 为空的权威空闲快照）
//   · readonly=true  → 仅当 event.instanceId 与当前 viewingInstanceId 严格相等才接受；
//     缺 instanceId、viewing 为空首页、或指向别的 tab → 拒绝（否则 CLI 在 A 驾驶会把 B 的新会话锁死）
// 不读 sessionId：server 广播以 instanceId 为查看锚点；sessionId 在 FRESH 懒开前可能为 null。
export function acceptMirrorState({ readonly = false, eventInstanceId = null, viewingInstanceId = null } = {}) {
  if (!readonly) return true;
  if (eventInstanceId == null || eventInstanceId === '') return false;
  if (viewingInstanceId == null || viewingInstanceId === '') return false;
  return eventInstanceId === viewingInstanceId;
}

// 切视图/切工作区时是否应先本地复位只读锁（等 server 按新上下文重判）。
// viewing 变了必清；空首页内换 cwd（viewing 恒 null）也要清——否则 A 空首页残留的锁会挂到 B 空首页。
// 例外：同会话静默换实例（externalDirty/effort 触发的 dispose+resume，非用户主动切换）——sessionId
// 不变，只是 instanceId 换了个身份，不该把用户刚做出的本地接管选择（mirrorOverriddenSid）冲掉，
// 否则终端只读锁会在这轮忙碌（用户自己发的消息）时被重新广播锁上。sessionId 未知（null）保守仍清。
export function shouldResetMirrorOnViewChange({
  prevViewing = null,
  nextViewing = null,
  prevCwd = null,
  nextCwd = null,
  cwdSeen = false,
  prevSessionId = null,
  nextSessionId = null,
} = {}) {
  if (prevViewing !== nextViewing) {
    const sameSession = prevSessionId != null && nextSessionId != null && prevSessionId === nextSessionId;
    if (!sameSession) return true;
  }
  if (cwdSeen && nextCwd && prevCwd && nextCwd !== prevCwd) return true;
  return false;
}
