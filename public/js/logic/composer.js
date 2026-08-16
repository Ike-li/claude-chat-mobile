// logic/composer.js —— 输入框主态/占位/回车语义 · 草稿交换 · 中断 pending · @ 提及
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t } from '../i18n.js';

// 输入区主按钮：CLI 镜像只读 → 续接/取消续接；否则 busy → 停止（不论输入框有无草稿）；空闲有内容 → 发送。
// 审批/提问 sheet、输入禁用、sendInFlight 仍按原闸挡发送；sheet 打开时不 morph 停止（中止走 sheet 逃生口）。
// mirrorReadonly 优先于 blockedByDisabledInput：镜像时 input 仍 disabled，但主按钮要可点「续接」。
// 2026-07-30 移除消息排队：在途轮期间不再接受新消息，此时主按钮恒为停止钮——若只在空输入时给停止钮，
// 「想插队 → 先清空输入框才看得到停止钮」这步极反直觉。草稿留在输入框里不动，运行中仍可继续打字。
// ★停止态判据必须是 turnRunning 而非 busy：busy 是粗粒度的（stateOf 把 hasBgTasks 也折进 'busy'，
// 且 bindView/loadHistory 用 shouldSeedBusyFromInstanceState 播种时并不排除 bgActive）。若用 busy，
// 纯后台任务挂着时主按钮会恒为停止钮，而移动端回车不发送、只能点这个钮 —— 用户彻底发不出消息，
// 违反「后台任务挂着不锁」。busy && !hasContent 这一支保留作兜底：turnRunning 靠广播/ack 驱动，
// 万一漏种而实际在跑，空输入时仍要能停；有草稿才说明用户想发，那时才让位给发送。
export function resolveComposerPrimaryMode({
  busy = false,
  turnRunning = false,
  hasContent = false,
  interruptPending = false,
  blockedByUserRequest = false,
  blockedByDisabledInput = false,
  blockedBySendInFlight = false,
  mirrorReadonly = false,
  mirrorArmed = false,
} = {}) {
  if (mirrorReadonly) {
    if (mirrorArmed) {
      return {
        mode: 'cancel-resume',
        enabled: true,
        // 钮面短文案，完整语义在 aria/title——避免宽按钮挤掉底栏齿轮
        label: t('取消'),
        title: t('取消排队中的续接，继续只读追平'),
        ariaLabel: t('取消续接'),
      };
    }
    return {
      mode: 'resume',
      enabled: true,
      label: t('续接'),
      title: t('续接 CLI 会话：运行中会排队等本轮结束，疑似中断需确认'),
      ariaLabel: t('续接 CLI 会话'),
    };
  }
  if (blockedByUserRequest) {
    return {
      mode: 'send',
      enabled: false,
      title: t('请先处理当前审批或选择'),
      ariaLabel: t('发送'),
    };
  }
  if (blockedByDisabledInput) {
    return {
      mode: 'send',
      enabled: false,
      title: t('请先完成设备授权或解除只读状态'),
      ariaLabel: t('发送'),
    };
  }
  // 在途轮 → 停止（有无草稿都一样：这期间发不出去，把主位让给唯一有用的操作）；
  // busy 但无在途轮（纯后台任务）→ 仅空输入时兜底给停止，有草稿则放行发送。
  if (turnRunning || (busy && !hasContent)) {
    if (interruptPending) {
      return {
        mode: 'stop',
        enabled: false,
        title: t('正在停止…'),
        ariaLabel: t('正在停止'),
      };
    }
    return {
      mode: 'stop',
      enabled: true,
      title: t('停止'),
      ariaLabel: t('停止'),
    };
  }
  if (blockedBySendInFlight) {
    return {
      mode: 'send',
      enabled: false,
      title: t('请稍候…'),
      ariaLabel: t('发送'),
    };
  }
  // 空闲有内容 → 发送（busy 已在上面走停止分支）
  if (hasContent) {
    return {
      mode: 'send',
      enabled: true,
      title: '',
      ariaLabel: t('发送'),
    };
  }
  return {
    mode: 'send',
    enabled: false,
    title: '',
    ariaLabel: t('发送'),
  };
}

/**
 * Composer 发送钮可见性：空闲无内容时隐藏灰发送（避免「点了没反应」）；
 * stop / resume / 有内容可发或可排队 均显示。无语音输入。
 */
export function shouldHideComposerSendButton({ mode, enabled, hasContent = false } = {}) {
  return mode === 'send' && !enabled && !hasContent;
}

/** 底栏权限段着色：仅 Bypass 标 danger（非整颗 chip） */
export function pillPermTone(mode) {
  if (mode === 'bypassPermissions') return 'danger';
  if (mode === 'plan') return 'plan';
  return 'neutral';
}

/** 空聚焦且无内容时是否展示 / @ 发现 hint */
export function shouldShowComposerDiscoverHint({ focused = false, hasContent = false, mirrorReadonly = false } = {}) {
  return Boolean(focused) && !hasContent && !mirrorReadonly;
}

// Composer placeholder：在途轮期间说明发不出去（输入框仍可打字、草稿保留）。
// mirrorReadonly 优先（镜像态整框只读，placeholder 由镜像文案接管）。
// busy 与 turnRunning 分开：busy 含后台任务/待审批，而发送闸只认在途轮——挂着后台任务时仍可发送。
export function resolveComposerPlaceholder({
  busy: _busy = false,
  turnRunning = false,
  mirrorReadonly = false,
  mirrorText = '',
  idleText = '给 Claude 发消息...',
} = {}) {
  if (mirrorReadonly) return mirrorText || idleText;
  if (turnRunning) return t('当前任务运行中，完成后可发送');
  return idleText;
}

// 回合末滚动：有文件汇总卡则锚定到卡（手机扫结果）；否则落底。
export function resolveTurnEndScroll({ hasFileChangesCard = false } = {}) {
  return hasFileChangesCard ? 'file-changes' : 'bottom';
}

// bindView 切视图时是否该清空输入框未发送草稿。思考强度/模型切档在 SDK 层无运行时切换能力，后端 dispose
// 旧实例 + resume 同会话开新实例（instanceId 变了、sessionId 不变），前端只看 viewingInstanceId 变化就判定
// 为「切到另一个会话」而清空草稿——这是误伤：用户视角仍在同一个聊天里，只是底层实例被静默替换。
// 判定：新旧 sessionId 相同且非空 ⇒ 同一会话静默换实例，保留草稿；否则（真实切会话/切到全新未开会话/
// 任一端为空）⇒ 清空（保守默认，不吞真实导航场景）。
// 注：真实切会话时不应「丢弃」草稿——见 planSessionDraftSwap（按 sessionId 存/取）。
export function shouldClearInputOnBindView({ prevSessionId, newSessionId } = {}) {
  return !(newSessionId && newSessionId === prevSessionId);
}

// bindView 切会话时未发送草稿的存/取计划（纯函数，app.js 持 Map 执行）。
// 修：输入框有字/附件 → 切到另一会话 → 再切回被清空（旧逻辑只 clear 不存）。
// - keep：同会话静默换实例（effort/model dispose+resume）→ 不碰输入框/附件托盘
// - swap：真实导航 → 把 prev 当前文字+附件写入缓存（若 prevSessionId 非空），恢复 new 的缓存（无则空）
// drafts 形如 Map<sessionId, {text, attachments}|string>；string 为旧缓存兼容形态（仅文字）。
// 未传/非 Map 时 restoreText=''、restoreAttachments=[]。attachments 存出/恢复均浅拷贝数组，避免调用方就地改污染缓存。
export function planSessionDraftSwap({
  prevSessionId, newSessionId, currentDraft = '', currentAttachments = [], drafts,
} = {}) {
  if (newSessionId && newSessionId === prevSessionId) return { action: 'keep' };
  const atts = Array.isArray(currentAttachments) ? currentAttachments.slice() : [];
  const save = prevSessionId
    ? {
        sessionId: prevSessionId,
        text: currentDraft == null ? '' : String(currentDraft),
        attachments: atts,
      }
    : null;
  let restoreText = '';
  let restoreAttachments = [];
  if (newSessionId && drafts && typeof drafts.get === 'function') {
    const cached = drafts.get(newSessionId);
    if (typeof cached === 'string') {
      restoreText = cached;
    } else if (cached && typeof cached === 'object') {
      restoreText = cached.text == null ? '' : String(cached.text);
      restoreAttachments = Array.isArray(cached.attachments) ? cached.attachments.slice() : [];
    }
  }
  return { action: 'swap', save, restoreText, restoreAttachments };
}

// 客户端是否应忽略某条 question 事件（已本地作答 / 已收 request_resolved）。
// 乐观作答后 clearView+sync 竞态下，server 可能尚未 resolve 就把 pending 快照/缓冲 question 再推回来；
// answeredIds 记录本端已答 requestId（及整组 toolUseID），防止重弹。server eventsSince 过滤是主路径，
// 此集合补「作答→sync 之间」与多端关窗。
// - answeredIds 形如 Set<string>；未传/无 has → 不忽略
// - requestId 为 toolUseID#i 时，若 set 含 toolUseID 也算已决（整组终态 request_resolved）
export function isAnsweredQuestionId(requestId, answeredIds) {
  if (!requestId || !answeredIds || typeof answeredIds.has !== 'function') return false;
  if (answeredIds.has(requestId)) return true;
  const hash = String(requestId).lastIndexOf('#');
  if (hash > 0 && answeredIds.has(String(requestId).slice(0, hash))) return true;
  return false;
}

// 回车键是否触发发送（2026-07-13 排查：移动端回车发送截断）。桌面物理键盘用 Shift+Enter
// 当换行「逃生舱」，非 Shift 回车一律发送；但触屏软键盘没有 Shift+Enter 这个组合，若照搬桌面语义，
// 用户想换行分段时按下的每一次回车都会被当场发出，把一条多行长消息在换行处截断成几条。
// 触摸设备下回车恒不发送（走 textarea 默认插入换行），发送收窄为仅走发送按钮；非触摸设备维持原状。
export function shouldSendOnEnter({ shiftKey, isTouchDevice } = {}) {
  return !shiftKey && !isTouchDevice;
}

// 客户端 agent:event 分流（app.js 分发入口；台阶3 instanceId 分流）：是否丢弃该事件不渲染。
// 豁免（永不丢）：instances 合成事件（它定义 viewingInstanceId 本身）、无 instanceId 的合成事件
// （status_line / init 重放 / models / permission_mode / effort_mode）。
// instancesReady=false（连接后首个 instances 广播到达前）→ 放行：重放批次都属当前查看实例。
// instancesReady=true（视图已知）→ 带 instanceId 的事件必须命中 viewingInstanceId 才渲染；
//   viewingInstanceId=null（新会话懒开、无实例）时一切带 instanceId 的后台事件都丢——否则后台活跃
//   实例的 tool_use/tool_result/user_message/result 会污染空新窗口（不能用 `viewingInstanceId &&`
//   判定：null 会短路成「不过滤」，把「视图未知」与「新会话空视图」两种相反语义混为一谈）。
export function shouldDropAgentEvent(ev, viewingInstanceId, instancesReady) {
  if (!ev || ev.type === 'instances' || !ev.instanceId) return false; // 合成/无主事件：放行
  if (!instancesReady) return false;                                  // 视图未知（首个 instances 前）：放行重放
  return ev.instanceId !== viewingInstanceId;                         // 视图已知：不匹配即丢（含 viewing=null）
}

// composer「@ 文件引用」触发检测：光标前文本是否形如「(行首或空白)@query」，query 允许路径字符
// （字母数字下划线点斜杠短横线，不含空格——一旦打出空格视为已放弃/确认引用，交由下一次 @ 重新触发）。
// 要求 @ 前是行首或空白（非单词字符），天然不误触 user@host 这类词中 @。传入「光标前」文本（非全文），
// 故多个 @ 只会命中离光标最近、仍处于「输入中」的那个。
// 全角 ＠（U+FF20，部分中文输入法）与 ASCII @ 等价。
const AT_MENTION_PATTERN = /(?:^|\s)[@＠]([\w./-]*)$/;
export function detectAtMentionQuery(textBeforeCursor) {
  const text = typeof textBeforeCursor === 'string' ? textBeforeCursor : '';
  const m = AT_MENTION_PATTERN.exec(text);
  if (!m) return null;
  // matchStart 指向 @/＠ 本身（不是 match 起点，可能含前导空白）
  const atIdx = Math.max(m[0].lastIndexOf('@'), m[0].lastIndexOf('＠'));
  return { query: m[1], matchStart: m.index + atIdx };
}

// 选中候选后重写输入框文本：把 [matchStart, cursorPos) 换成「相对路径 」，光标落在插入内容之后。
// 尾部若已跟空白（用户在已有文字中间插入引用）则不重复补空格，避免连续两个空格。
export function applyAtMentionPick(fullText, { matchStart, cursorPos, path } = {}) {
  const text = typeof fullText === 'string' ? fullText : '';
  const start = Number(matchStart) || 0;
  const cursor = Number(cursorPos) || 0;
  const before = text.slice(0, start);
  const after = text.slice(cursor);
  const inserted = /^\s/.test(after) ? String(path) : `${path} `;
  return { text: before + inserted + after, cursorPos: (before + inserted).length };
}

// ---- statusline 折叠摘要 / 剪贴板（纯数据，DOM 在 app.js）----
// 折叠态只放 git + ctx：模型/effort/权限已在底栏 pill，勿重复；展开仍有 CLI 级全量。
