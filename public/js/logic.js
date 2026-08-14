// logic.js —— app.js 的纯决策逻辑。
// 红线：本文件只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让 app.js（浏览器 import）与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的 import 是 ./i18n.js：它是纯查表 + 一个语言开关（模块级 currentLang，仅 setLang 改），
// 在 node 与浏览器下行为一致、不引入宿主依赖，故不破坏上面那条红线的目的。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。
// （原注释写的是「不得 import … 零依赖」，与第一行的 i18n import 直接矛盾，已按真实边界改写。）

// HTML 转义。app.js 多处复用（审批命令、工具参数摘要）+ ansiToHtml 内部。
import { t, getLang } from './i18n.js';
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 权限档：与 @anthropic-ai/claude-agent-sdk PermissionMode 枚举对齐 ----
// SDK 仅类型层有枚举、无运行时 list；本数组 = 前端显示/校验的权威源，由
// tests/unit/permission-modes-sdk-sync.test.mjs 与 sdk.d.ts + 后端 CCM_PERMISSION_MODES 锁集合。
// 展示顺序：安全档在前，bypassPermissions 置底（危险档）。
//
// 文案不走 i18n：与 CLI / 桌面端菜单同源英文（Manual / Accept edits / Plan / …），
// 协议值仍是 default|acceptEdits|…（manual 是 default 的 CLI 别名）。
export const SDK_PERMISSION_MODES = Object.freeze([
  'default',
  'plan',
  'acceptEdits',
  'dontAsk',
  'auto',
  'bypassPermissions',
]);

export function isSdkPermissionMode(mode) {
  return SDK_PERMISSION_MODES.includes(mode);
}

/**
 * CLI / 桌面端展示名 + SDK 注释级说明（固定英文，禁止 t()/中文本地化）。
 * title/pill/bar 对齐桌面菜单：Manual · Accept edits · Plan · Auto · Bypass permissions
 * （dontAsk 桌面菜单常不露出，用 SDK 语义 Don't ask）。
 */
const PERMISSION_MODE_TILE_META = Object.freeze({
  default: {
    title: 'Manual',
    desc: 'Prompts for dangerous operations',
    selectLabel: 'Manual',
    pill: 'Manual',
    bar: 'Manual',
    danger: false,
  },
  plan: {
    title: 'Plan',
    desc: 'Planning mode, no tool execution',
    selectLabel: 'Plan',
    pill: 'Plan',
    bar: 'Plan',
    danger: false,
  },
  acceptEdits: {
    title: 'Accept edits',
    desc: 'Auto-accept file edit operations',
    selectLabel: 'Accept edits',
    pill: 'Accept edits',
    bar: 'Accept edits',
    danger: false,
  },
  dontAsk: {
    title: "Don't ask",
    desc: 'Deny if not pre-approved, no prompts',
    selectLabel: "Don't ask",
    pill: "Don't ask",
    bar: "Don't ask",
    danger: false,
  },
  auto: {
    title: 'Auto',
    desc: 'Model classifier approves or denies',
    selectLabel: 'Auto',
    pill: 'Auto',
    bar: 'Auto',
    danger: false,
  },
  bypassPermissions: {
    title: 'Bypass permissions',
    desc: 'Bypass all permission checks',
    selectLabel: 'Bypass permissions',
    pill: 'Bypass',
    bar: 'Bypass permissions',
    danger: true,
  },
});

/**
 * 按 SDK 清单生成权限磁贴规格（只数据，不碰 DOM；文案固定英文，调用方勿再 t()）。
 * @param {readonly string[]} [modes=SDK_PERMISSION_MODES]
 * @returns {{ id: string, title: string, desc: string, selectLabel: string, pill: string, bar: string, danger: boolean }[]}
 */
export function permissionModeTileSpecs(modes = SDK_PERMISSION_MODES) {
  const list = Array.isArray(modes) ? modes : SDK_PERMISSION_MODES;
  return list.filter(isSdkPermissionMode).map((id) => {
    const meta = PERMISSION_MODE_TILE_META[id];
    return {
      id,
      title: meta?.title || id,
      desc: meta?.desc || '',
      selectLabel: meta?.selectLabel || id,
      pill: meta?.pill || id,
      bar: meta?.bar || id,
      danger: Boolean(meta?.danger),
    };
  });
}

// 工具卡片摘要可读化：agent 侧 stringify 是紧凑单行，手机展开难读。
// 能 parse 的 JSON（对象/数组）→ 2 空格缩进；非 JSON / 截断残缺 / 空 → 原样（String 化）。
// 只做数据→数据，不碰 DOM/hljs（高亮由 app.js 渲染层复用现有 hljs）。
export function formatToolSummary(summary) {
  if (summary == null) return '';
  if (typeof summary !== 'string') return String(summary);
  const s = summary;
  if (!s) return '';
  const trimmed = s.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return s;
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s; // 截断残缺 JSON 等：不抛、原样
  }
}

// UX-001：审批 sheet 内容可读化（数据→数据）。
// ExitPlanMode 计划书走 markdown 源文（调用方 renderMarkdown + DOMPurify）；
// 普通命令去掉 JSON.stringify 对字符串包的引号/\n 转义，保留纯文本供 mono 展示。
// 对象 input：ExitPlanMode 优先取 .plan 字段；其余 pretty JSON。
export function formatPermInputDisplay(toolName, input) {
  const isExit = String(toolName || '') === 'ExitPlanMode';
  let text;
  if (input == null) text = '';
  else if (typeof input === 'string') text = input;
  else if (typeof input === 'object') {
    text = (isExit && typeof input.plan === 'string')
      ? input.plan
      : JSON.stringify(input, null, 2);
  } else text = String(input);
  return { mode: isExit ? 'markdown' : 'text', text };
}

// UX-002：工具卡收起态标题「工具名 · inputSummary 截断」。
// 摘要优先取常见短字段（path/command 等），否则压成单行；maxLen 控制摘要段长度（默认 48）。
const TOOL_SUMMARY_KEYS = [
  'file_path', 'filePath', 'path', 'command', 'cmd', 'pattern', 'query',
  'url', 'description', 'plan',
];
// UX-019：空态（empty-start）不向消息区打档位变更系统条；有消息后仍可留痕。
// 审批留痕（已允许/已拒绝）不走此闸，由调用方直接 addBar。
export function shouldEmitModeChangeBar({ emptyStart = false } = {}) {
  return !emptyStart;
}

// 模型磁贴：条数与 SDK/TUI supportedModels 一一对应（不去重合并）。
// 标题优先真实 wire id（resolvedModel）；无则 displayName/value。
// value 仍用 SDK 的 value（default/opus/…）保证可区分；发送时 resolveSendModel 再 pin wire。
export function resolveModelTileDisplay(models) {
  const list = Array.isArray(models) ? models : [];
  const rows = list.map(m => {
    if (typeof m === 'string') {
      return { value: m, displayName: m, description: '', resolvedModel: '', raw: m };
    }
    const value = m?.value != null ? String(m.value) : '';
    const displayName = (m?.displayName != null && String(m.displayName).trim())
      ? String(m.displayName).trim()
      : value;
    const resolvedModel = (m?.resolvedModel != null && String(m.resolvedModel).trim())
      ? String(m.resolvedModel).trim()
      : '';
    const description = m?.description != null ? String(m.description) : '';
    return { value, displayName, description, resolvedModel, raw: m };
  });

  // 标题撞车计数（多个档位映射同一 wire 时标题相同，靠副标题档位名区分）
  const titleKey = (r) => r.resolvedModel || r.displayName || r.value;
  const titleCounts = new Map();
  for (const r of rows) {
    const k = titleKey(r);
    titleCounts.set(k, (titleCounts.get(k) || 0) + 1);
  }

  return rows.map(r => {
    const wire = r.resolvedModel;
    const title = wire || r.displayName || r.value || 'model';
    // 有 wire：副标题用档位 value/displayName（TUI 档名），便于同 wire 多卡区分
    // 无 wire：description 或 value
    let subtitle;
    if (wire) {
      if (r.value === 'default') {
        subtitle = r.displayName && r.displayName !== wire
          ? r.displayName
          : (r.description || 'default');
      } else if (r.value && r.value !== wire) {
        subtitle = r.displayName && r.displayName !== wire && r.displayName !== r.value
          ? `${r.value} · ${r.displayName}`
          : r.value;
      } else {
        subtitle = r.description || r.displayName || '';
      }
    } else {
      subtitle = r.description || r.value || '';
    }
    const duplicate = (titleCounts.get(titleKey(r)) || 0) > 1;
    return {
      value: r.value, // 保持 SDK 条目 id，不与其它卡撞 data-model
      title,
      subtitle,
      duplicate,
      raw: r.raw,
    };
  });
}

/** value=default 条目的 resolvedModel（wire），无则 '' */
export function defaultResolvedModel(modelsList) {
  if (!Array.isArray(modelsList)) return '';
  const def = modelsList.find(m => (typeof m === 'string' ? m : m?.value) === 'default');
  if (!def || typeof def === 'string') return '';
  return def.resolvedModel != null ? String(def.resolvedModel).trim() : '';
}

/** 选中 value 对应的 wire；无则 '' */
export function resolvedModelForValue(value, modelsList) {
  if (value == null || value === '' || !Array.isArray(modelsList)) return '';
  const entry = modelsList.find(m => (typeof m === 'string' ? m : m?.value) === value);
  if (!entry || typeof entry === 'string') return '';
  return entry.resolvedModel != null ? String(entry.resolvedModel).trim() : '';
}

// 发送：优先 pin 真实 wire（resolvedModel）；default/空 → default 的 wire，否则 undefined 让 CLI 自选
export function resolveSendModel({ selectValue = '', fullModel = '', modelsList = [] } = {}) {
  const raw = String(fullModel || selectValue || '').trim();
  if (!raw || raw === 'default') {
    return defaultResolvedModel(modelsList) || undefined;
  }
  // 已是 wire 或档位别名：有 resolved 用 wire，否则原样
  const wire = resolvedModelForValue(raw, modelsList)
    || resolveGatewayModelName(raw, modelsList);
  return wire || raw;
}

// UX-020：同名附件序号；可选大小。
export function formatAttachmentChipLabel(name, occurrence = 1, sizeBytes) {
  const base = (name != null && String(name).trim()) ? String(name).trim() : t('附件');
  const n = Math.max(1, Number(occurrence) || 1);
  let label = n > 1 ? `${base} (${n})` : base;
  if (sizeBytes != null && Number.isFinite(Number(sizeBytes))) {
    const b = Number(sizeBytes);
    let sizeStr;
    if (b < 1024) sizeStr = `${b}B`;
    else if (b < 1024 * 1024) sizeStr = `${Math.max(1, Math.round(b / 1024))}KB`;
    else sizeStr = `${(b / (1024 * 1024)).toFixed(1)}MB`;
    label += ` · ${sizeStr}`;
  }
  return label;
}

// UX-015：cache 比例/百分数取整为 "N%"。
export function formatCachePercent(ratio) {
  if (ratio == null || !Number.isFinite(Number(ratio))) return '—';
  let n = Number(ratio);
  if (n >= 0 && n <= 1) n *= 100;
  return `${Math.round(n)}%`;
}

// UX-014：思考档副文案（增量信息，非重复等级名）。
export function effortLevelSubtitle(level) {
  const lv = String(level || '').toLowerCase();
  const map = {
    low: t('更快更省'),
    medium: t('均衡'),
    med: t('均衡'),
    high: t('更深入'),
    xhigh: t('很深入更慢'),
    max: t('最深入更慢更贵'),
    ultracode: t('xhigh + 多 agent workflow · 最彻底'),
  };
  return map[lv] || '';
}

// UX-010：镜像只读时不与本地忙碌条同现。
export function shouldShowBusyWithMirror({ mirrorReadonly = false, busy = false } = {}) {
  if (mirrorReadonly) return false;
  return Boolean(busy);
}

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

// 流内 live 活动行兜底文案（不写 disk/history）。busy 主形态是 formatCliSpinnerLine 的 CLI 式
// spinner 行——对齐 CLI 不报具体工具（工具卡自会显示命令）。
// kind: default | stopping | sending（发送 ack 前的短暂阶段）。
export function formatLiveActivityText(kind = 'default') {
  if (kind === 'stopping') return t('正在停止…');
  if (kind === 'sending') return t('正在发送…');
  return t('Claude 正在执行任务...');
}

// 点停止后 interruptPending 的安全超时（ms）。限流重试时 SDK interrupt 可能挂起或不回 interrupted，
// 超时后前端必须自行清位，否则停止钮永久 disabled + live 行卡「正在停止…」。
export const INTERRUPT_PENDING_TIMEOUT_MS = 12_000;

// 哪些 system payload 应清掉前端 interruptPending。
// · kind:interrupted —— 中止成功（主路径）
// · 「当前没有可中断的任务」—— 后端 interrupt 失败回执（限流重试中常见），也必须清位
export function shouldClearInterruptPendingOnSystem(payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (p.kind === 'interrupted') return true;
  // 后端 kind（优先）或固定中文原文（agent 现写死中文，勿经 t()——en locale 会匹配失败卡 12s，D1）
  if (p.kind === 'no_interruptible_task') return true;
  if (typeof p.message === 'string' && p.message.includes('没有可中断的任务')) return true;
  return false;
}

// system 条的语义色。kind:'notice' 承载 SDK 的一批自由文本（informational / mirror_error /
// notification / model_refusal_* / compact_error / 额度耗尽 / 子 agent 报错），按 level 分级；
// 其余既有 system（已中断、上下文已压缩、排队回执…）恒中性灰。
// level 只在 notice 语义下生效——防止别处误带 level 把中性回执染色。
export function systemBarClass(payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (p.kind !== 'notice') return 'text-ink-faint';
  if (p.level === 'error') return 'text-danger';
  if (p.level === 'warning') return 'text-warning';
  return 'text-ink-faint';
}

// UX-010：横幅优先级仲裁（同屏最多一条）。
// mirror 状态已迁到 input placeholder + 续接钮，#mirrorBanner 恒隐——不得再压住 task_progress
// （多子代理/后台任务进度是用户在只读时仍需要看到的）。
// 序：task > subagent > activity > mirror(占位) > null。
export function bannerPriority({ mirror = false, task = false, subagent = false, activity = false } = {}) {
  if (task) return 'task';
  if (subagent) return 'subagent';
  if (activity) return 'activity';
  if (mirror) return 'mirror';
  return null;
}
export const pickBannerToShow = bannerPriority;

// UX-004：流式 markdown 预览节流间隔（ms）。
export function formatStreamPreviewIntervalMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? n : 80;
}

// UI-007：高频状态标 SVG（可信静态串，无用户输入）。currentColor 吃语义色。
// 返回 { html, label }；html 供 innerHTML 到 .t-status / 角标；label 作 aria-label。
const STATUS_ICON_PATHS = {
  // hourglass-ish circle for pending/busy
  pending: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  busy: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  ok: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l2.5 2.5L16 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  error: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  warn: '<path d="M12 3l9 16H3L12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  denied: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  answered: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l2.5 2.5L16 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  aborted: '<rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9h6v6H9z" fill="currentColor"/>',
};
// 下面几张查表存中文原文、到取用点才 t()：模块顶层常量在 import 阶段求值，那时 app.js 还没跑到
// setLang()，直接在表里 t() 会把这些标签永久钉死成中文。
const STATUS_ICON_LABELS = {
  pending: '进行中',
  busy: '运行中',
  ok: '成功',
  error: '出错',
  warn: '待审批',
  denied: '已拒绝',
  answered: '已回答',
  aborted: '已中止',
};
export function statusIconSpec(kind) {
  const k = STATUS_ICON_PATHS[kind] ? kind : 'pending';
  const path = STATUS_ICON_PATHS[k];
  const label = t(STATUS_ICON_LABELS[k] || STATUS_ICON_LABELS.pending);
  const html = `<svg class="status-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">${path}</svg>`;
  return { html, label, kind: k };
}

export function formatToolCardTitle(toolName, inputSummary, maxLen = 48) {
  const name = String(toolName || '').trim() || 'tool';
  const raw = inputSummary == null ? '' : String(inputSummary).trim();
  if (!raw || raw === '{}') return name; // 空对象输入不拼「· {}」（CLI 对空输入零渲染）
  let snippet = raw;
  if (raw[0] === '{' || raw[0] === '[') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const k of TOOL_SUMMARY_KEYS) {
          if (typeof parsed[k] === 'string' && parsed[k].trim()) {
            snippet = parsed[k].trim();
            break;
          }
        }
      }
    } catch { /* 残缺 JSON 原样 */ }
  }
  snippet = snippet.replace(/\s+/g, ' ');
  const n = Number(maxLen);
  const cap = Math.max(8, Number.isNaN(n) ? 48 : n); // 0 是显式值须夹到下限 8，不当「未传」回落默认
  if (snippet.length > cap) snippet = snippet.slice(0, cap - 1) + '…';
  return `${name} · ${snippet}`;
}

// Task 清单工具（CLI 内建 todo：TaskCreate/TaskUpdate/TaskList/TaskGet）。
// CLI 对这组工具 renderToolUseMessage=null + 专用任务面板；web 无面板，
// 折中为流内特化渲染：标题去 JSON 噪音、结果显 ☐/◐/☒ 清单（机主 7/17 拍板）。
const TASK_LIST_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const TASK_STATUS_ICONS = { pending: '☐', in_progress: '◐', completed: '☒' };
const taskStatusIcon = s => TASK_STATUS_ICONS[s] ?? `[${s}]`;

function parseJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed[0] !== '{') return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; } // agent 端截断的残缺 JSON → null，调用方走通用路径
}

// 特化收起态标题；非 Task 清单工具返回 null → 调用方回落 formatToolCardTitle。
export function formatTaskToolTitle(toolName, inputSummary, maxLen = 48) {
  const name = String(toolName || '').trim();
  if (!TASK_LIST_TOOLS.has(name)) return null;
  const input = parseJsonObject(inputSummary) ?? {};
  if (name === 'TaskCreate') {
    const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
    return subject ? formatToolCardTitle(name, subject, maxLen) : name;
  }
  const id = (typeof input.taskId === 'string' || typeof input.taskId === 'number') && String(input.taskId).trim()
    ? `#${String(input.taskId).trim()}` : '';
  if (name === 'TaskUpdate') {
    const status = typeof input.status === 'string' ? input.status.trim() : '';
    if (id && status) return `${name} · ${id} → ${status}`;
    return id ? `${name} · ${id}` : name;
  }
  if (name === 'TaskGet') return id ? `${name} · ${id}` : name;
  return name; // TaskList 输入恒空
}

// 特化结果正文（纯文本，调用方 textContent 注入、不走 hljs）。返回 null → 通用 JSON pretty。
// 两种输入形态都认：live 走 agent.js 的结构化 tool_use_result JSON；历史回显走
// history.js 的 block.content 文本（"#1 [pending] 主题" / "No tasks found"）。
export function renderTaskToolResultText(toolName, outputSummary) {
  const name = String(toolName || '').trim();
  if (!TASK_LIST_TOOLS.has(name) || typeof outputSummary !== 'string') return null;
  const out = parseJsonObject(outputSummary);
  if (name === 'TaskList') {
    if (out) {
      if (!Array.isArray(out.tasks)) return null;
      if (out.tasks.length === 0) return t('（无任务）');
      return out.tasks.map(task => {
        const id = task?.id != null ? `#${task.id} ` : '';
        const subject = typeof task?.subject === 'string' ? task.subject : '';
        const blocked = Array.isArray(task?.blockedBy) && task.blockedBy.length
          ? `${t('（被')} ${task.blockedBy.map(b => `#${b}`).join(' ')}${t(' 阻塞）')}` : '';
        return `${taskStatusIcon(String(task?.status ?? 'pending'))} ${id}${subject}${blocked}`.trimEnd();
      }).join('\n');
    }
    if (outputSummary.trim() === 'No tasks found') return t('（无任务）');
    // 历史文本形态逐行转图标；整体不匹配则交还通用路径
    const lines = outputSummary.trim().split('\n');
    const converted = lines.map(l => {
      const m = /^#(\S+) \[([\w-]+)\] (.*)$/.exec(l.trim());
      return m ? `${taskStatusIcon(m[2])} #${m[1]} ${m[3]}` : null;
    });
    return converted.every(Boolean) ? converted.join('\n') : null;
  }
  if (!out) return null;
  if (name === 'TaskCreate') {
    if (out.task?.id == null) return null;
    const subject = typeof out.task.subject === 'string' && out.task.subject ? `：${out.task.subject}` : '';
    return `${t('☐ 已建任务')} #${out.task.id}${subject}`;
  }
  if (name === 'TaskUpdate') {
    if (out.success === false) return `${t('更新失败：')}${out.error || t('未知原因')}`;
    if (out.taskId == null) return null;
    const sc = out.statusChange;
    if (sc?.from && sc?.to) return `${taskStatusIcon(sc.to)} #${out.taskId} ${sc.from} → ${sc.to}`;
    const fields = Array.isArray(out.updatedFields) && out.updatedFields.length
      ? `（${out.updatedFields.join(', ')}）` : '';
    return `#${out.taskId} ${t('已更新')}${fields}`;
  }
  return null; // TaskGet 详情信息量大，保留通用 JSON 展示
}

// 从 paste 事件的 clipboardData 里挑出 image/* 文件（桌面 Chrome 截图/复制图 → Ctrl/Cmd+V）。
// 返回 File 数组；纯文本/无图返回 []——调用方应保留默认粘贴文字行为。
// 只做数据筛选，不读盘/不转 base64（那是 app.js 附件托盘的既有路径）。
export function pickPasteImageFiles(clipboardData) {
  const items = clipboardData?.items;
  if (!items || typeof items.length !== 'number') return [];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || it.kind !== 'file') continue;
    const type = String(it.type || '');
    if (!type.startsWith('image/')) continue;
    const file = typeof it.getAsFile === 'function' ? it.getAsFile() : null;
    if (file) out.push(file);
  }
  return out;
}

// 发送前托盘点预览：把附件的完整 base64 拼成 <img src> 可用的 data URI。
// 仅 image/* + 非空 data；否则 null（调用方不弹灯箱，避免把 PDF/二进制当图打开）。
export function attachmentDataUrl(att) {
  if (!att || typeof att !== 'object') return null;
  const mime = String(att.mimeType || '');
  const data = att.data;
  if (!mime.startsWith('image/')) return null;
  if (typeof data !== 'string' || !data) return null;
  return `data:${mime};base64,${data}`;
}

// E18 附件预览：历史消息的附件只有文件名（transcript 不落 mimeType），按扩展名猜 image/*。
// 非图片扩展名 → null（调用方按「不可预览」处理，不把任意字节当图打开）。SVG 在 <img> 上下文不执行脚本，安全。
const IMAGE_MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  bmp: 'image/bmp', svg: 'image/svg+xml',
};
export function guessImageMime(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? (IMAGE_MIME_BY_EXT[m[1].toLowerCase()] || null) : null;
}

// 文件类工具卡片预览入口文案：Read 只读文件片段/图片，Edit/Write/… 才是 diff 变更。
// 后端 tool_use.file.changeKind 已区分（read|edit|write|multiedit|notebook）；changeKind 优先，name 兜底。
export function toolPreviewLabel(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const kind = m.changeKind != null ? String(m.changeKind) : '';
  const name = m.name != null ? String(m.name) : '';
  const isRead = kind === 'read' || (!kind && name === 'Read');
  return isRead ? t('📄 预览文件') : t('📄 预览变更');
}

// 是否「会改盘」的文件工具（进 turn-end 变更汇总；Read 排除）。
export function isFileMutationTool({ name, changeKind } = {}) {
  const kind = changeKind != null ? String(changeKind) : '';
  if (kind === 'read') return false;
  if (kind === 'edit' || kind === 'write' || kind === 'multiedit' || kind === 'notebook') return true;
  const n = name != null ? String(name) : '';
  return n === 'Edit' || n === 'Write' || n === 'MultiEdit' || n === 'NotebookEdit';
}

// 文本行数（用于 +/- 估算；空串 0；末尾换行按 split 自然计数）。
export function countContentLines(text) {
  if (text == null) return 0;
  const s = String(text);
  if (!s) return 0;
  return s.split('\n').length;
}

// 从工具完整 input 估 +/- 行（与终端「一块旧/新文本」观感对齐；非精确 diff 算法）。
export function estimateMutationLineStats(name, input = {}) {
  const n = name != null ? String(name) : '';
  if (n === 'Edit') {
    return {
      added: countContentLines(input?.new_string),
      removed: countContentLines(input?.old_string),
    };
  }
  if (n === 'MultiEdit') {
    const edits = Array.isArray(input?.edits) ? input.edits : [];
    let added = 0, removed = 0;
    for (const e of edits) {
      added += countContentLines(e?.new_string);
      removed += countContentLines(e?.old_string);
    }
    return { added, removed };
  }
  if (n === 'Write') {
    return { added: countContentLines(input?.content), removed: 0 };
  }
  if (n === 'NotebookEdit') {
    return { added: countContentLines(input?.new_source), removed: 0 };
  }
  return { added: 0, removed: 0 };
}

// 本轮文件变更账本：key=path。同文件多次 Edit 累加 +/-，保留最后 toolUseId（点审核预览用）。
// map: Map<path, { path, changeKind, toolUseId, name, added, removed }>
export function accumulateTurnFileChange(map, event = {}) {
  if (!map || typeof map.set !== 'function') return map;
  const e = event && typeof event === 'object' ? event : {};
  const path = e.path != null ? String(e.path).trim() : '';
  if (!path) return map;
  if (!isFileMutationTool({ name: e.name, changeKind: e.changeKind })) return map;
  const added = Number.isFinite(e.added) ? Math.max(0, Math.floor(e.added)) : 0;
  const removed = Number.isFinite(e.removed) ? Math.max(0, Math.floor(e.removed)) : 0;
  const prev = map.get(path);
  if (!prev) {
    map.set(path, {
      path,
      changeKind: e.changeKind || null,
      toolUseId: e.toolUseId || null,
      name: e.name || null,
      added,
      removed,
    });
    return map;
  }
  prev.added += added;
  prev.removed += removed;
  if (e.toolUseId) prev.toolUseId = e.toolUseId;
  if (e.changeKind) prev.changeKind = e.changeKind;
  if (e.name) prev.name = e.name;
  return map;
}

// 汇总账本 → 卡片数据。无变更 → null。
export function summarizeTurnFileChanges(map) {
  if (!map || typeof map.values !== 'function') return null;
  const files = [...map.values()]
    .filter(f => f && f.path)
    .map(f => ({
      path: f.path,
      baseName: String(f.path).split(/[/\\]/).pop() || f.path,
      changeKind: f.changeKind || null,
      toolUseId: f.toolUseId || null,
      name: f.name || null,
      added: Number(f.added) || 0,
      removed: Number(f.removed) || 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) return null;
  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  return {
    fileCount: files.length,
    added,
    removed,
    files,
    title: `${t('已编辑')} ${files.length} ${t('个文件')}`,
    statsLabel: `+${added} -${removed}`,
  };
}

// ultracode = CLI /effort 菜单最高档（会话 Settings.ultracode + effort xhigh）。
// SDK Options.effort 只认 low..max；UI 在 xhigh-capable 上追加 ultracode 菜单项（与 CLI 对齐），
// spawn 时 server 映射为 effort=xhigh + settings:{ultracode:true}，不改写用户正文。
// withUltracodeKeyword：仅当用户自己在消息里写 ultracode 时仍原样发送（CLI 关键词 trigger）；Web 切档不自动注入。
export function withUltracodeKeyword(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 'ultracode';
  return /^ultracode(?:\s|$)/i.test(trimmed) ? trimmed : `ultracode ${trimmed}`;
}

// 思考档位列表：ultracode 仅在模型支持 xhigh 时追加（对齐 CLI /effort），幂等。
export function withUltracodeTier(levels) {
  const arr = Array.isArray(levels) ? levels : [];
  if (!arr.includes('xhigh') || arr.includes('ultracode')) return arr;
  return [...arr, 'ultracode'];
}

// UI 档 → SDK 参数：ultracode → { effort:'xhigh', ultracode:true }；其余原样。
export function resolveEffortSelection(uiLevel) {
  if (uiLevel === 'ultracode') return { effort: 'xhigh', ultracode: true };
  return { effort: uiLevel || null, ultracode: false };
}

// 模型桥接：把规范名 / 网关后缀名（如 claude-opus-4-8[1m]）匹配到 models 候选项。
// modelsList 由调用方传入（app.js 的 let modelsList / 测试夹具）。先精确命中，再按 [Nm] 后缀 + base 子串桥接。
export function modelEntryFor(value, modelsList) {
  if (!value || !modelsList || !modelsList.length) return null;
  const exact = modelsList.find(m => (typeof m === 'string' ? m : m?.value) === value);
  if (exact) return exact;
  const sfx = (value.match(/\[[^\]]+\]$/) || [''])[0];
  const base = value.replace(/\[[^\]]+\]$/, '');
  return modelsList.find(m => {
    if (!m || typeof m === 'string' || !m.value) return false;
    const mSfx = (m.value.match(/\[[^\]]+\]$/) || [''])[0];
    const mBase = m.value.replace(/\[[^\]]+\]$/, '');
    if (mSfx !== sfx || !mBase) return false;
    // 子串桥接须在词边界位置（前后都是 '-' 或字符串开头/结尾）：防 'deepseek-v3' 误匹配 'deepseek-v3.1'
    const idx = base.indexOf(mBase);
    if (idx < 0) return false;
    const after = idx + mBase.length;
    return (idx === 0 || base[idx - 1] === '-')
      && (after >= base.length || base[after] === '-' || base[after] === '[');
  }) || null;
}

// 模型的「给人看的名字」：用于会话设置里折叠头的当前值、以及思考强度区块的归属标签。
// 走与 effortLevelsFor 同一条 modelEntryFor 桥接路径——两处若各解析一套，会出现标题写着 A、
// 档位却是 B 的错位。取 displayName 与模型磁贴主标题同源，无则回落 value，解析不到则诚实回落原值。
// ⚠️ 与底栏 model chip 是**两套有意不同**的展示：chip 显原始 value（P0-09e/P0-09j 锁定它不得被
// displayName 覆盖，用户选了 opus 就得看到 opus）；这里替代的是磁贴列表，故随磁贴用 displayName。
// 空模型（CLI「不 pin」语义）返回空串：没有具体模型可归属时，由调用方给「当前模型」的兜底文案，
// 不能把 'default' 这种内部字面量摆给用户看。
export function modelLabelFor(modelValue, modelsList) {
  if (!modelValue) return '';
  const entry = modelEntryFor(modelValue, modelsList);
  if (entry && typeof entry === 'object') return entry.displayName || entry.value || modelValue;
  if (typeof entry === 'string' && entry) return entry;
  return modelValue;
}

// select / 文案：CLI displayName 优先，否则 value。不把 resolvedModel 抬成展示名（中转站不重写）。
export function resolveModelDisplayName(value, modelsList) {
  if (value == null || value === '') return '';
  const entry = modelEntryFor(value, modelsList);
  if (entry && typeof entry === 'object') {
    if (entry.displayName != null && String(entry.displayName).trim()) return String(entry.displayName).trim();
    if (entry.value != null && String(entry.value)) return String(entry.value);
  }
  return String(value);
}

// 网关真实模型名探测：仅当候选项确有非空 resolvedModel 时返回它，否则返回空字符串——不回落
// displayName/value。用于 pill / 交互日志 diag chip 这类历史上只显示"原始值"、从不回落 displayName
// 的展示位——只解决"网关映射导致显示裸别名"这一个问题，不改变无网关映射时的既有展示契约
// （P0-09e/P0-09j 锁定了 pill 必须显示用户实际选中的原始值，不能被 displayName 覆盖）。
export function resolveGatewayModelName(value, modelsList) {
  if (value == null || value === '') return '';
  const entry = modelEntryFor(value, modelsList);
  if (entry && typeof entry === 'object' && entry.resolvedModel != null && String(entry.resolvedModel).trim()) {
    return String(entry.resolvedModel).trim();
  }
  return '';
}

// 底栏 pill：网关场景优先显示 wire（resolvedModel），与磁贴方案 B 一致。
// · 已选：resolveGatewayModelName 或 value+后缀
// · 未选：default.resolved → cliDefaultLabel → cwd 默认（经网关解析）→「默认」
export function resolveModelPillText({ model, gatewaySuffix = '', modelsList, cwdDefaultModel, cliDefaultLabel } = {}) {
  const sfx = gatewaySuffix || '';
  if (model) {
    const raw = String(model) + sfx;
    return resolveGatewayModelName(raw, modelsList) || raw;
  }
  const defWire = defaultResolvedModel(modelsList);
  if (defWire) return defWire;
  if (cliDefaultLabel) return String(cliDefaultLabel);
  if (cwdDefaultModel) {
    const full = String(cwdDefaultModel);
    const naked = full.replace(/\[[^\]]+\]$/, '');
    return resolveGatewayModelName(naked, modelsList)
      || resolveGatewayModelName(full, modelsList)
      || naked;
  }
  return t('默认');
}

// effort 档位决策（rebuildEffortOptions 的纯部分；DOM 渲染留在 app.js）。返回 { hidden, levels }：
//   · 解析到模型且支持 effort → { hidden:false, levels: 该模型 supportedEffortLevels }
//   · 解析到但不支持（如 haiku）   → { hidden:true,  levels: [] }（app.js 隐藏整行）
//   · 解析不到（列表未到/桥接不上）→ { hidden:false, levels: 全候选 supportedEffortLevels 并集 }（CLI 全局集）
export function effortLevelsFor(modelValue, modelsList) {
  const entry = modelEntryFor(modelValue, modelsList);
  const levels = (entry && typeof entry === 'object' && Array.isArray(entry.supportedEffortLevels)) ? entry.supportedEffortLevels : null;
  if (entry && (!levels || !levels.length)) return { hidden: true, levels: [] }; // 明确不支持 effort
  const show = (levels && levels.length) ? levels.slice() // 拷贝，避免调用方原地修改污染 modelsList 共享条目
    : [...new Set((modelsList || []).flatMap(m => (m && typeof m === 'object' && Array.isArray(m.supportedEffortLevels)) ? m.supportedEffortLevels : []))];
  return { hidden: false, levels: show };
}

// effort 展示态必须保留后端真值；重建候选列表只决定 select 能否选中，绝不能把未知/null 猜成 low。
// mirrorReadonly 时 null 的语义是「外部 CLI 活进程档位不可观测」，与 FRESH 的「模型默认」分开文案。
export function effortUiState(level, supportedLevels, { mirrorReadonly = false } = {}) {
  const normalized = level || null;
  const levels = Array.isArray(supportedLevels) ? supportedLevels : [];
  const selected = normalized && levels.includes(normalized) ? normalized : '';
  return {
    level: normalized,
    selected,
    label: normalized || (mirrorReadonly ? t('CLI 档位未知') : t('默认思考')),
    placeholder: normalized
      ? `${normalized}${t('（当前模型不可选）')}`
      : (mirrorReadonly ? t('CLI 当前档未知') : t('模型默认')),
  };
}

// 设置面板的数据源必须按驾驶方整组切换：CLI 镜像态只展示 CLI 观察值，哪怕某字段未知；
// 绝不能拿 Web 接管偏好补空，否则会把 saved low/bypass/model 伪装成终端当前状态。
export function resolvePanelState({ mirrorReadonly = false, observedCli, web } = {}) {
  const source = mirrorReadonly ? 'cli' : 'web';
  const selected = (mirrorReadonly ? observedCli : web) || {};
  return {
    source,
    model: selected.model ?? null,
    permissionMode: selected.permissionMode ?? null,
    effort: selected.effort ?? null,
  };
}

// 工作区抽屉只显示需要用户理解/处理的三态。terminal 独立于 live 实例合并，避免 idle/done live tab
// 遮住同会话正在运行的终端进程；done/aborted/idle 都是普通终态，不占抽屉主状态位。
export function resolveDrawerStatus({ liveState, terminalState } = {}) {
  if (liveState === 'permission') return 'permission';
  if (liveState === 'error') return 'error';
  if (liveState === 'busy' || terminalState === 'busy') return 'busy';
  return null;
}

// per-cwd 状态聚合：该 cwd 各实例状态取最高优先级（permission>error>busy>aborted>done>idle；失败比在跑更需关注）。
// aborted（P1-4 已中止独立状态）介于 done 与 busy 之间：比顺利完成更值得回头看一眼（为什么被中止），但
// 已是终态，不该盖过仍在运行的其它会话。
export function aggregateStates(instances, dirs) {
  const rank = { idle: 0, done: 1, aborted: 2, busy: 3, error: 4, permission: 5 };
  const out = {};
  for (const d of (dirs || [])) out[d] = 'idle';
  // worktree 实例 cwd 不在白名单 dirs 时，归入最长前缀父仓，使父工作区角标/sessionsDot 可见（K2）
  function parentDir(cwd) {
    if (!cwd) return null;
    if (cwd in out) return cwd;
    let best = null;
    for (const d of Object.keys(out)) {
      if (cwd === d || cwd.startsWith(d.endsWith('/') ? d : d + '/')) {
        if (!best || d.length > best.length) best = d;
      }
    }
    return best;
  }
  for (const x of instances || []) {
    const key = parentDir(x.cwd) || x.cwd;
    if (!(key in out)) out[key] = 'idle';
    if ((rank[x.state] ?? 0) > (rank[out[key]] ?? 0)) out[key] = x.state;
  }
  return out;
}

// 汇总「其他工作区」状态给左上角按钮角标：只提示需要你/出错/运行中三态；完成、中止、空闲
// 都是普通终态，不持续点亮入口。排除 currentCwd（当前工作区动静在聊天视图内呈现）。
export function summarizeOtherWorkspaces(workdirStates, availableDirs, currentCwd) {
  const rank = { busy: 1, error: 2, permission: 3 };
  let top = null, topRank = 0;
  for (const d of (availableDirs || [])) {
    if (d === currentCwd) continue;
    const st = workdirStates && workdirStates[d];
    if ((rank[st] || 0) > topRank) { topRank = rank[st]; top = st; }
  }
  return top; // 'permission'|'error'|'busy'|null
}

// 顶部/空状态展示名：路径仍作为运行时事实保留，移动端 UI 只露出项目末段。
export function projectDisplayName(path) {
  const s = String(path || '').replace(/\/+$/, '');
  if (!s) return t('无项目');
  return s.split('/').pop() || t('无项目');
}

// 空会话启动页只在没有可渲染会话流时出现：新建后尚未首发，或还没有 viewing instance。
// freshInterrupted：全新会话首轮（sessionId 尚未由 SDK init 返回）已发过消息且被点停止——用户消息
// 气泡 + 中断提示已经渲染在屏幕上，不该套用"sessionId 为空 → 显启动页"这条给真正从未发送过消息的
// 新会话用的既有判据（否则会把已有内容的聊天视图错误地打回主页/新会话页）。要求 viewingInstanceId 非空
// 才生效——调用方须自行把 freshInterrupted 收窄到"确实是当前正在看的这个实例"（见 app.js
// freshInterruptedInstanceId），此处只再兜底一次，防止无实例的真空首页被意外绕过。
// live：该实例此刻正在跑（在途轮 / busy）。sessionId 还没到不代表没内容可看——CLI 的实时输出经 SDK
// 一路推到前端，与它自己往 transcript 落盘是两条独立通道，前者永远更早。真机 2026-07-30 bc29ccc2：
// CLI 因第三方网关故障 31 分钟没吐 system/init，期间实例活着、事件在流，旧判据却把它判成「空首页」，
// bindView 当场 return，服务端环形缓冲里那 31 分钟内容一条都到不了屏幕。
export function shouldShowStartScreen({ viewingInstanceId, sessionId, freshInterrupted = false, live = false } = {}) {
  if (viewingInstanceId && freshInterrupted) return false;
  if (viewingInstanceId && live) return false;
  return !viewingInstanceId || !sessionId;
}

// 点停止后顿一下直接跳主页（回归修复）：中断失败（不限时超时——任何原因 SDK interrupt() reject 都会
// 走 agent.js settleForce 强杀子进程，见 tests/unit/agent-control.test.mjs）→ 子进程退出 → onExit →
// 该 instanceId 从 agents Map 删除、且无同 cwd 存活实例可回退（instance-routing.js
// reselectViewingTarget 默认 allowCrossWorkspace=false）→ viewingInstanceId 广播为 null。
// 前端旧逻辑把"viewingInstanceId 变 null"一律当"该显示空表面(home/compose)"处理，导致用户刚点停止就
// 被静默弹回主页，看不到任何"发生了什么"的反馈。
//
// 本函数只回答一个问题："这次 viewingInstanceId 变 null，是不是因为我正在看的这个实例真的被摧毁了"，
// 用于和"用户主动导航离开"（返回主页 / 新建会话 / 切到其他会话）区分：
//   · 用户主动返回主页/新建会话：原实例仍留在 instances 列表里（只是不再被查看），没有被摧毁——
//     不会同时满足"曾在列表 + 现在从列表消失"。
//   · 用户主动切到其他存活会话：newViewingInstanceId 非 null（有下一个可看的目标），不是摧毁。
//   只有"曾在列表里 + 现在从列表消失 + newViewing 变 null"三者同时成立，才精确对应摧毁场景。
//
// explicitCloseInstanceId：用户主动关闭自己正在查看的会话（抽屉「关闭」/侧滑 ✕，无其它存活实例可
// 回退时）广播形态与"被摧毁"完全相同（服务端 disposeInstance 同样让 viewingInstanceId 变 null +
// 该实例从列表消失），但这是用户自己确认过的主动操作，不该显示"意外中断"——调用方在点击关闭时
// 记下这个 id，传入本函数即可排除；id 不匹配（关的是别的实例）时不受影响。
export function wasViewingInstanceDestroyed({
  prevViewingInstanceId,
  newViewingInstanceId,
  prevIds,
  currIds,
  explicitCloseInstanceId = null,
} = {}) {
  if (!prevViewingInstanceId) return false; // 本来就没有正在查看的实例——没什么好判的
  if (newViewingInstanceId != null) return false; // 有下一个可看的目标（哪怕换了别的）——不是摧毁
  if (explicitCloseInstanceId && explicitCloseInstanceId === prevViewingInstanceId) return false; // 用户主动关闭——不是意外
  const has = (set, id) => (set instanceof Set ? set.has(id) : Array.isArray(set) && set.includes(id));
  if (!has(prevIds, prevViewingInstanceId)) return false; // 防御性：声称"之前在看"却不在快照里，不敢断言摧毁
  return !has(currIds, prevViewingInstanceId); // 曾在列表、现在消失了 → 真被摧毁
}

// server 重启检测：整机重启时 agents Map/viewingInstanceId 全部归零（纯内存态，不从磁盘恢复），
// 重连后首条 instances 广播的形态（正在看的实例从列表消失 + viewing 变 null）与「实例被单独摧毁」
// 完全同构——wasViewingInstanceDestroyed 三条件全部命中，无法自辨，会把每次重启都误报成
// 「停止操作未能正常结束」。区分信号 = 广播恒带的 service.startedAt（服务端进程级常量
// SERVICE_STARTED_AT，重启必变）：前后两条广播的 startedAt 都在且不同 → server 重启。
// 任一侧缺失（首条广播无基线 / 旧服务端·mock 手工 payload 不带 service）保守不判，
// 回落既有 destroyed 行为——缺字段不能当"变了"。
export function detectServerRestart({ prevStartedAt = null, newStartedAt = null } = {}) {
  return prevStartedAt != null && newStartedAt != null && prevStartedAt !== newStartedAt;
}

// 空表面形态：＋ / 🏠 分流。
//   destroyed = 正在查看的实例被摧毁（见 wasViewingInstanceDestroyed），需要用户手动确认下一步
//   none    = 已在真实会话（有 session 流），不渲染空态页
//   home    = 枢纽（最近工作区/会话），输入条隐藏
//   compose = 干净新会话页（工作区确认 + 默认档 + 示例 prompt），输入条显示
// 判定：instanceDestroyed 优先于其余三态（这是比常规空表面更需要用户关注的非常规状态）；
// 其余沿用原判定：先 shouldShowStartScreen；再看 composeReady（点 ＋ / session:new）。
export function resolveEmptySurface({ viewingInstanceId, sessionId, composeReady = false, freshInterrupted = false, instanceDestroyed = false, live = false } = {}) {
  if (instanceDestroyed) return 'destroyed';
  if (!shouldShowStartScreen({ viewingInstanceId, sessionId, freshInterrupted, live })) return 'none';
  return composeReady ? 'compose' : 'home';
}

// 新会话页「本工作区将开 CLI 用的默认档」摘要。读前端已同步的 pill 文案（L0>L3>L4）。
// 空/空白项跳过；全空回落固定文案（scout/defaults 未到时仍有可读提示）。
export function formatComposeDefaultsSummary({ modelLabel, modeLabel, effortLabel } = {}) {
  const parts = [modelLabel, modeLabel, effortLabel]
    .map(s => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : t('使用工作区默认配置');
}

// 顶部工作区 pill（点开文件浏览）可见性：空首页/compose 枢纽已自有工作区入口，
// 顶栏再放文件夹会重复且暗示「当前在会话里」。仅在有可渲染会话流时显示。
export function shouldShowTopContextPill({ viewingInstanceId, sessionId } = {}) {
  return !shouldShowStartScreen({ viewingInstanceId, sessionId });
}

// 顶栏 RTT 芯片：好网（good/ok）隐藏，只在 warn/bad 时出现——正常时顶栏安静，异常才说话。
// 连接点 title / 状态行仍可由接线层带延迟数字，不依赖芯片可见。
export function shouldShowRttChip(ms) {
  const tone = rttToneClass(ms);
  return tone === 'warn' || tone === 'bad';
}

// 底部输入条（composer）可见性：空首页枢纽只做「选工作区/会话」，不提供直接发消息入口——
// 避免未选项目就打字、懒开新会话的歧义路径。显示条件：
//   · 已进入可渲染会话（有 sessionId）
//   · 或用户刚点 ＋ / session:new 进入 compose 就绪空窗（composeReady）
//   · 或新会话首发在途（pendingFirstSend：懒开瞬间 sid 仍空，不能闪藏输入区）
// 与 shouldShowStartScreen 正交：composeReady 时 resolveEmptySurface='compose'（干净新会话页 + 输入条）。
// freshInterrupted：见 shouldShowStartScreen 同名参数注释——全新会话首轮被中断后，pendingFirstSend
// 早已一次性消费为 false，若不加这个例外，输入条会跟着"判定该显启动页"一起被隐藏，用户没法接着发消息。
export function shouldShowComposer({ viewingInstanceId, sessionId, composeReady = false, pendingFirstSend = false, freshInterrupted = false } = {}) {
  if (sessionId) return true;
  if (pendingFirstSend) return true;
  if (composeReady) return true;
  // 须仍有 viewingInstanceId 才生效——防调用方把"未设置"(null)当成偶然与空 viewingInstanceId 相等
  // 而误判命中（例如两者都是 null 时的巧合相等），空首页(无 viewingInstanceId)不能被凭空绕过。
  if (viewingInstanceId && freshInterrupted) return true;
  // viewingInstanceId 有无都不改变「无 sid 且未 compose」→ 隐藏
  void viewingInstanceId;
  return false;
}

// 空首页「最近活跃」：把各显式 workdir 的 session 列表摊平，按 lastUsedAt 降序取 topN。
// 每条附 cwd + workspaceName，前端可一键 session:switch，不必先开侧栏目录树。
// dirLists: Array<{ cwd, sessions, workspaceName? }>
//   - workspaceName 非空字符串时优先于 projectDisplayName(cwd)
// 无 id 的行跳过；缺 lastUsedAt 的排最后（仍可点开）；非法 limit 回落默认 8。
// git worktree 路径若要用，须写入 workdirs.json 成为独立 workdir，不再有自动分组通道。
export function mergeRecentSessionsAcrossWorkspaces(dirLists, { limit = 8 } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8;
  const rows = [];
  for (const entry of Array.isArray(dirLists) ? dirLists : []) {
    if (!entry || typeof entry.cwd !== 'string' || !entry.cwd) continue;
    const cwd = entry.cwd;
    const override = typeof entry.workspaceName === 'string' ? entry.workspaceName.trim() : '';
    const workspaceName = override || projectDisplayName(cwd);
    const sessions = Array.isArray(entry.sessions) ? entry.sessions : [];
    for (const s of sessions) {
      if (!s || typeof s.id !== 'string' || !s.id) continue;
      rows.push({
        id: s.id,
        title: s.title || t('无标题会话'),
        lastUsedAt: s.lastUsedAt ?? null,
        cwd,
        workspaceName,
        entrypoint: s.entrypoint ?? null,
        terminal: s.terminal ?? null, // 'busy'|'alive'|null：CLI 进程注册表自报的终端直跑态
      });
    }
  }
  rows.sort((a, b) => {
    const ta = Number(a.lastUsedAt) || 0;
    const tb = Number(b.lastUsedAt) || 0;
    return tb - ta;
  });
  return rows.slice(0, cap);
}

// 乐观 busy（send() 的 setBusy(true)）会被「服务端换实例 → 广播 instances → setInstances →
// bindView → clearView 的 setBusy(false)」冲掉，直到首个 delta 才重现。两种场景要补回：
// 1) 新会话首发懒开：pendingFirstSend + 已绑定新实例 + 尚无 sessionId（FRESH、SDK init 未回；
//    区别于 session:switch 打开的已有会话——有 sessionId 时不得仅凭 pendingFirstSend 补）。
// 2) 同会话静默换实例：externalDirty / effort 等 dispose+resume（instanceId 变、sessionId 不变），
//    pendingSendBusySessionId 直接命中当前 sessionId 才补。用"这条乐观 busy 到底属于哪个 session"
//    （而非旧版"这次切换前后 session 是否一致"）判定，防止发送方 A 被甩开后从未等到 result/error、
//    标志一直卡 true，之后被无关的 B 自己的同会话换实例误捡到（B 换实例前后 sessionId 天然一致，
//    旧版比对法看不出这条 busy 其实是 A 的遗留）。
export function shouldRestoreOptimisticBusy({
  pendingFirstSend,
  pendingSendBusySessionId,
  viewingInstanceId,
  sessionId,
} = {}) {
  if (!viewingInstanceId) return false;
  // 新会话首发：无 sessionId 的懒开实例
  if (pendingFirstSend && !sessionId) return true;
  // 同会话静默换实例：乐观 busy 的登记会话与当前会话一致才补
  if (pendingSendBusySessionId && sessionId && pendingSendBusySessionId === sessionId) return true;
  return false;
}

// 在线 user:message 的 socket ack 决策（纯函数）。成功只清 in-flight；失败须清乐观 busy +
// 可见文案，并可恢复草稿（输入已被 send() 清空）。旧实现把 ack 当 clearSendInFlight 忽略 payload。
export function presentOnlineSendAck(ack) {
  if (ack && ack.ok === true) {
    return {
      ok: true,
      clearBusy: false,
      restoreDraft: false,
      retryable: false,
      permanent: false,
      stale: false,
      requeue: false,
      message: '',
    };
  }
  const error = (ack && typeof ack.error === 'string' && ack.error.trim())
    ? ack.error.trim()
    : t('发送失败');
  // 在途轮拒收（排队已移除）：被拒的是【这条新消息】，不是正在跑的那轮——
  // clearBusy 必须 false，否则会把在跑那轮的状态行/停止钮一起清掉；也不 requeue，
  // 自动重发等于把排队搬到客户端。文字回填输入框（send 已清空它）。
  if (ack?.busy === true) {
    return {
      ok: false,
      busy: true,
      clearBusy: false,
      restoreDraft: true,
      retryable: false,
      permanent: false,
      stale: false,
      requeue: false,
      message: error,
    };
  }
  const permanent = Boolean(ack?.permanent);
  const retryable = Boolean(ack?.retryable) || (!permanent && !ack?.stale);
  const stale = Boolean(ack?.stale);
  let message = error;
  if (error === 'stale_instance' || stale) {
    message = t('目标会话已关闭，请刷新后重发');
  } else if (!message.startsWith(t('发送')) && !message.includes(t('失败'))) {
    message = `${t('发送失败：')}${message}`;
  }
  // retryable 且非 permanent/stale → 入 outbox 自动重试（与离线路径对齐）；此时不回填草稿，避免与队列双份
  const requeue = retryable && !permanent && !stale;
  return {
    ok: false,
    clearBusy: true,
    restoreDraft: !requeue,
    retryable,
    permanent,
    stale,
    requeue,
    message,
  };
}

// 在线发送 transport 层（socket.timeout err 或 ack）决策——与 presentOfflineResendAck 对齐。
// err 非空 = 超时/断连；无 err 时委托 presentOnlineSendAck。
export function presentOnlineSendTransport(err, ack) {
  if (err) {
    return {
      ok: false,
      clearBusy: true,
      restoreDraft: false,
      retryable: true,
      permanent: false,
      stale: false,
      requeue: true,
      message: t('未确认送达，已排队重试'),
    };
  }
  return presentOnlineSendAck(ack);
}

// ---- 发送 outbox（在线/离线统一耐久队列的纯决策）----
// 条目可序列化字段不含 bubbleEl；app.js 用 clientMessageId 回挂 DOM。
export const OUTBOX_MAX_ITEMS = 20;
export const OUTBOX_STORAGE_KEY = 'ccm-outbox-v1';

export function serializeOutboxItem(item) {
  if (!item || typeof item !== 'object') return null;
  const clientMessageId = typeof item.clientMessageId === 'string' ? item.clientMessageId : '';
  if (!clientMessageId) return null;
  return {
    text: item.text == null ? '' : String(item.text),
    model: item.model == null ? null : item.model,
    attachments: Array.isArray(item.attachments) ? item.attachments : undefined,
    clientMessageId,
    instanceId: item.instanceId == null ? null : item.instanceId,
    cwd: item.cwd == null ? null : item.cwd,
  };
}

// 有界入队：超 maxItems 丢最旧。返回 { queue, dropped }。
export function planOutboxEnqueue(queue, item, { maxItems = OUTBOX_MAX_ITEMS } = {}) {
  const base = Array.isArray(queue) ? queue.slice() : [];
  const row = serializeOutboxItem(item);
  if (!row) return { queue: base, dropped: [] };
  // 同 clientMessageId 去重：后写覆盖前（重试路径可能重复 push）
  const without = base.filter(x => x?.clientMessageId !== row.clientMessageId);
  without.push({ ...row, ...(item.bubbleEl ? { bubbleEl: item.bubbleEl } : {}) });
  if (without.length <= maxItems) return { queue: without, dropped: [] };
  const overflow = without.length - maxItems;
  return { queue: without.slice(overflow), dropped: without.slice(0, overflow) };
}

export function parseDurableOutbox(raw) {
  if (raw == null || raw === '') return [];
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const row of data) {
    const s = serializeOutboxItem(row);
    if (s) out.push(s);
  }
  return out;
}

export function dumpDurableOutbox(queue) {
  const items = (Array.isArray(queue) ? queue : [])
    .map(serializeOutboxItem)
    .filter(Boolean);
  return JSON.stringify(items);
}

// 离线队列单条重发 ack 决策（FE-NEW-001）。与在线不同：不恢复草稿（气泡已在消息流）、
// permanent 必停重试；timeout/err 与非 permanent 负 ack 一律 requeue。
// outcome: 'ok' | 'permanent' | 'requeue' | 'blocked'
// blocked = 撞上在途轮（排队已移除）：队列首条发出去就开跑，其后各条必被拒。继续 requeue 会空转成
// 客户端排队，故落终态由用户手动重发。与 permanent 的区别：blocked 稍后重发能成功，不是死信。
export function presentOfflineResendAck(err, ack) {
  if (!err && ack && ack.ok === true) {
    return { outcome: 'ok', permanent: false, requeue: false, clearBusyIfViewing: false, message: '' };
  }
  if (!err && ack && ack.ok === false && ack.busy === true) {
    const error = (typeof ack.error === 'string' && ack.error.trim()) ? ack.error.trim() : t('当前任务运行中，完成后可发送');
    return { outcome: 'blocked', permanent: false, requeue: false, clearBusyIfViewing: false, message: error };
  }
  // stale（目标实例已关闭）也是死信：服务端 fail-closed 的负 ack 只带 {stale:true}、【不带】permanent，
  // 落到下面的兜底 requeue 就成了「每次重连重发一遍、永不退场」。判据与在线路径 presentOnlineSendAck
  // 逐字对齐（error==='stale_instance' || ack.stale），并把裸协议串换成人话——用户看到的是提示不是错误码。
  if (!err && ack && ack.ok === false && (ack.stale === true || ack.error === 'stale_instance')) {
    return {
      outcome: 'permanent', permanent: true, requeue: false, clearBusyIfViewing: true,
      message: t('目标会话已关闭，请刷新后重发'),
    };
  }
  if (!err && ack && ack.ok === false && ack.permanent) {
    const error = (typeof ack.error === 'string' && ack.error.trim()) ? ack.error.trim() : t('发送失败');
    return { outcome: 'permanent', permanent: true, requeue: false, clearBusyIfViewing: true, message: error };
  }
  // 超时 / 可重试失败 / 畸形 ack
  return {
    outcome: 'requeue',
    permanent: false,
    requeue: true,
    clearBusyIfViewing: false,
    message: err ? t('未确认送达') : ((ack && typeof ack.error === 'string' && ack.error.trim()) || t('发送失败')),
  };
}

// 离线批处理后是否应 busy：仅当「仍有目标为当前 viewing 的重入队项」或「本批有 viewing 相关 ok 且
// 指望 result 清 busy」时保持 busy。FE-NEW-001：永久失败且无剩余 viewing 队列 → 必须 clear。
// remainingItems = 本批结束后仍在 offlineQueue 的项；viewingInstanceId 可为 null。
export function shouldBusyAfterOfflineBatch({ viewingInstanceId, remainingItems = [], hadViewingOk = false } = {}) {
  const viewingPending = remainingItems.some(it => it && it.instanceId != null && it.instanceId === viewingInstanceId);
  if (viewingPending) return true;
  // 本批对当前 viewing 成功发出 → 短暂 busy 等 result（与在线一致）；非 viewing 成功不抬 busy
  if (hadViewingOk && viewingInstanceId != null) return true;
  return false;
}

// 重发横幅文案：addBar 无条件贴当前会话消息流（app.js 的 addBar 不带归属过滤），而队列项的目标
// 是【入队时刻】那个实例——两者不是一回事。不标注就会读成「这条排队消息在本会话发了」，
// 叠上服务端 sysTo 的「目标会话已关闭」（同样贴当前视图）尤其像串会话。
// 归属判据与 shouldBusyAfterOfflineBatch / app.js 的 targetsViewing 逐字一致：
// instanceId != null 且相等才算本视图——两边同为 null（首页 + 首发未开实例）不得配成一对。
export function planOutboxDrainNotice({ items = [], viewingInstanceId = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const foreign = list.filter(
    it => !(it && it.instanceId != null && it.instanceId === viewingInstanceId)
  ).length;
  let text;
  if (foreign === 0) {
    text = `${t('正在重发离线发送队列中的')} ${total} ${t('条消息...')}`;
  } else if (foreign === total) {
    text = `${t('正在重发')} ${total} ${t('条离线消息（发往其它会话）...')}`;
  } else {
    text = `${t('正在重发离线发送队列中的')} ${total} ${t('条消息...')}${t('（其中 ')}${foreign}${t(' 条发往其它会话）')}`;
  }
  return { total, foreign, text };
}

// 通知预览安全截断（FE-NEW-002）：JSON.stringify(undefined) 是 undefined，.slice 会抛。
export function safeJsonPreview(value, maxLen = 80) {
  let s;
  try {
    if (value === undefined) s = 'null';
    else s = JSON.stringify(value);
    if (s === undefined) s = 'null'; // stringify 对 undefined 顶层返回 undefined
  } catch {
    s = '[unserializable]';
  }
  s = String(s);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// 切入已在跑的 live 实例时是否 seed busy（FE-NEW-004）。state 来自 instances[].state。
export function shouldSeedBusyFromInstanceState(state) {
  return state === 'busy' || state === 'permission';
}

// reload 清屏后运行态重种：state 优先取 ack 时刻 instances 广播的最新值（切回瞬间 turn
// 恰结束时入场 entry.state 是过期快照，直接用会 stale-busy）；广播查不到才回退入场快照。
export function shouldReseedBusyAfterReload({ instances = [], instanceId, entryState } = {}) {
  const live = instances.find(x => x?.instanceId === instanceId);
  return shouldSeedBusyFromInstanceState(live ? live.state : entryState);
}

// instances 广播（视图未变）→ 运行条单向对齐：只置 true、绝不置 false。
// bgActive===true 排除：纯后台任务期无 result 事件可释放，单向置 true 会卡死运行条
//（该期 UI 归 task_progress 横幅）；undefined（旧服务端/视觉 mock）视为无后台任务。
export function shouldBindBusyFromBroadcast({ state, bgActive } = {}) {
  if (bgActive === true) return false;
  return shouldSeedBusyFromInstanceState(state);
}

// 看门狗：上面单向对齐的代价——终止事件（result/error/interrupted）若被实例路由过滤丢弃或丢包，
// 本地 liveLine 会永久卡在 busy=true 空转（见 ccm 现场：会话已结束、spinner 仍在跑）。这里补另一半：
// 服务端 stateOf() 已把后台任务折进 'busy'（instance-manager.js），故此处只看 state 而非 bgActive——
// 真后台任务期 state 仍是 'busy'，不会被误清。宽限期防止刚发送、服务端 pendingTurns 尚未计入广播的
// 乐观 busy 窗口被误清（同量级于 app.js 的 SEND_ACK_FALLBACK_MS）。
export const BUSY_BROADCAST_CLEAR_GRACE_MS = 5000;
export function shouldForceClearBusyFromBroadcast({ state, localBusy = false, turnStartTs = null, now = 0, graceMs = BUSY_BROADCAST_CLEAR_GRACE_MS } = {}) {
  if (!localBusy || shouldSeedBusyFromInstanceState(state)) return false;
  if (!turnStartTs) return true;
  return (now - turnStartTs) >= graceMs;
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

// 回车键是否触发发送（2026-07-13 排查报告 §4：移动端回车发送截断）。桌面物理键盘用 Shift+Enter
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

// E16：24-bit ANSI 前景色(\x1b[38;2;R;G;Bm)与重置(\x1b[0m/\x1b[m) → span；其他 SGR 吞序列保文本；
// 逐段 esc 后拼接（安全顺序：escape → 着色 → 调用方 DOMPurify），结尾补闭合防未闭合 ANSI。
export function ansiToHtml(s) {
  let out = '', open = 0;
  // eslint-disable-next-line no-control-regex -- 本函数职责就是解析 ANSI 转义序列
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    // eslint-disable-next-line no-control-regex -- 同上
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!m) { out += esc(part); continue; }
    const rgb = /^38;2;(\d{1,3});(\d{1,3});(\d{1,3})$/.exec(m[1]);
    if (rgb) { out += `<span style="color:rgb(${rgb[1]},${rgb[2]},${rgb[3]})">`; open++; }
    else if (m[1] === '' || m[1] === '0') { out += '</span>'.repeat(open); open = 0; }
  }
  return out + '</span>'.repeat(open);
}

// E15：将 URL-safe Base64（无填充）的公钥字符串转为 Uint8Array（PushManager.subscribe 要求的格式）。
// 纯逻辑，可在 node:test 中直接验证。
export function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// 长会话切入分块渲染的推进数学：给定已处理条数/总数/块大小，算出这一块的结束位置与是否处理完。
// chunkSize<=0 防呆到至少推进 1 条，避免调用方传入非法值时死循环。
export function nextHistoryRenderChunk({ processed, total, chunkSize }) {
  const end = Math.min(processed + Math.max(1, chunkSize | 0), total);
  return { end, done: end >= total };
}

// 连接 RTT 数值段：合法有限非负 number → 整数 ms（≥1000 用 1 位小数 s）。
// 接线层再拼人话前缀「延迟 …」；非法/未知 → ''，接线层据此隐藏，避免断线残留陈旧数字。
export function formatRttMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

// 连接 RTT 色阶语义 token：good(<150) / ok(<400) / warn(<1000) / bad(≥1000)。
// 返回语义名而非 Tailwind class；接线层：good/ok → 中性 ink-soft（不与绿点抢色），warn/bad → warning/danger。
// 非法 → ''，与 formatRttMs 对齐（隐藏时不着色）。
export function rttToneClass(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 150) return 'good';
  if (ms < 400) return 'ok';
  if (ms < 1000) return 'warn';
  return 'bad';
}

// 移动端切前台/网络恢复/bfcache 恢复时的重连决策。要害：`socket.connected` 在「半开连接」下会撒谎——
// 切后台冻结 JS、TCP 未必断、engine.io 心跳计时被冻结尚未发现 server 失联，回前台瞬间它仍是 true。
// 故 connected 时不能直接判健康（否则白等 socket.io 心跳超时 ~45s 才被动重连 = 用户感受的「卡住」），
// 返回 'probe'：发一条带 timeout 的 sync:since 同时探活+补发；未连返回 'connect'：直接重连（connect handler 会 sync）。
export function foregroundReconnectAction(connected) {
  return connected ? 'probe' : 'connect';
}

// ── 连接状态顶部横幅（页面级可见反馈）────────────────────────────────────────
// 存在理由：连接态此前只有 #connDot 那个 3.5px 小圆点，而唯一的人话文案写给了恒 hidden 的
// #statusLine（见 index.html 注释）——系统知道、代码写了、界面上没有任何可读反馈。这里把
// 判定抽成纯函数，接线层（app/connection-banner.js）只负责按返回值刷 DOM。
//
// 四个阈值都是「延迟出现」而非「立即出现」：局域网秒连、手机切后台回来的瞬时断开都不该闪横幅。
// retry 严格晚于两个显示阈值，否则会出现「按钮先于横幅可见」的不可能态（单测钉住这条不变量）。
export const CONN_BANNER_CONNECTING_DELAY_MS = 800;    // 首连：超过才显示「连接中…」
export const CONN_BANNER_DISCONNECT_DELAY_MS = 1000;   // 断线：超过才显示「连接断开…」
export const CONN_BANNER_RETRY_DELAY_MS = 5000;        // 超过才露「立即重试」（短抖动靠自动重连）
export const CONN_BANNER_RECONNECTED_LINGER_MS = 1600; // 「已重新连接」绿条停留时长

// phase：'connecting'（从未连上过）| 'offline'（连上过又断了）| 'online'
// elapsedMs：当前 phase 已持续时长；suppressed：鉴权门/Access 重登门打开中（全屏页与横幅不能并存）
// wasVisible：进入 online 那一刻横幅是否可见——决定要不要给「已重新连接」，秒连不该闪绿条
// 返回 null（不显示）或 { tone, label, detail, spinner, retry }；label 是中文原文（key），接线层才 t()
export function resolveConnectionBanner({ phase, elapsedMs, suppressed = false, wasVisible = false } = {}) {
  if (suppressed) return null;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (phase === 'connecting') {
    if (elapsedMs < CONN_BANNER_CONNECTING_DELAY_MS) return null;
    // 首连不报「已断开 N 秒」：从没连上过，无「断开」可言
    return { tone: 'info', label: '连接中…', detail: '', spinner: true, retry: elapsedMs >= CONN_BANNER_RETRY_DELAY_MS };
  }
  if (phase === 'offline') {
    if (elapsedMs < CONN_BANNER_DISCONNECT_DELAY_MS) return null;
    return {
      tone: 'warn',
      label: '连接断开，自动重连中…',
      detail: `${t('已断开')} ${formatUptime(elapsedMs)}`,
      spinner: true,
      retry: elapsedMs >= CONN_BANNER_RETRY_DELAY_MS,
    };
  }
  if (phase === 'online') {
    if (!wasVisible || elapsedMs >= CONN_BANNER_RECONNECTED_LINGER_MS) return null;
    // 已经连上了，不该还转圈
    return { tone: 'success', label: '已重新连接', detail: '', spinner: false, retry: false };
  }
  return null;
}

// sync:since 的 ack 回调决策（probe 与普通 connect 路径共用）：
//   err（ack 超时/断线，probe 与 connect 补传两路都会有）→ 'reconnect'：判定半开死连接，强制 disconnect+connect 触发干净重连；
//   res.found===false（实例已 dispose/重启/effort 换 id 没了）→ 'reload'：清屏重载历史（connect 路径不先 clearView，
//     无法靠 replayed 自辨「实例没了」与「实例还在只是无新事件」，靠 found 区分）；
//   其余（有回放 / 无新事件 / 实例还在）→ 'none'：交给正常 agent:event 经 epoch/seq 去重增量渲染。
// connect 补传路径现同样带 timeout（F3/2026-08-06）：裸 ack 断线时被 _clearAcks() 丢弃，pending 快照
// 对账会永久缺失；err → 'reconnect' 干净重连是有意行为，不是误判。
export function syncAckAction(err, res, { seenDiskLen = 0, hasSessionId = true } = {}) {
  if (err) return 'reconnect';
  // 无 sessionId（CLI 未吐 init）：'reload' 会清屏后拿 session:history 换回「会话不存在」→ 白屏。
  // 同 shouldReloadOnEnter 的首条闸；息屏回前台 / 断网重连不经 bindView，只走这条路径，故两处都要有。
  if (!hasSessionId) return 'none';
  if (res && res.found === false) return 'reload';
  if (res && res.gap) return 'reload'; // 缓冲超窗、中间有缺口 → 清屏全量重载历史，否则残缺需手刷
  // 同会话重连/probe：活缓冲可能有回放，但 CLI 外部写盘只增 diskLen——必须比 seenDiskLen（G1）
  const diskLen = res && Number.isFinite(res.diskLen) ? res.diskLen : 0;
  if (diskLen > seenDiskLen) return 'reload';
  return 'none';
}

// 切视图入场（bindView 的 sync:since ack 回调）该拿什么当渲染真相：活缓冲/DOM 缓存 vs 磁盘 history 全量重载。
// 与 syncAckAction 分工不同——那是「重连/probe」路径（connect 后补发），这是「切视图入场」路径（bindView 独立决策）。
// 要害盲区①：CLI 在终端外部 `--resume` 写盘的消息【不经过】web 这个 SDK 实例的活缓冲，只落磁盘 transcript。
// 若 web 离开期间被外部写过，切回时 replayed=0（活缓冲无那些消息）却 hasCache=true（有旧 DOM 缓存）——
// 旧逻辑信缓存不拉盘 → 永远看不到外部写入。故此处比对 server 报的磁盘 history 条数 diskLen 与前端上次为该
// 会话渲染到的 seenDiskLen：磁盘更长 = 被外部写过 = 当作一种 gap，清屏全量重载磁盘（唯一真相源、清屏天然无重复）。
// 要害盲区②（PWA 下拉刷新 / 整页 reload）：sessionDomCache 是内存态，硬刷新后 hasCache=false；server 实例仍在，
// sync:since(0) 回放环形缓冲（BUFFER_CAP=2000 事件，见 src/agent/agent.js）。旧逻辑见 replayed>0 就 keep →
// 永远不拉 session:history，只剩缓冲里能拼出的最近几轮（流式 text_delta 仍可填满 cap；且 gap 要求 lastSeq>0，
// 硬刷新 lastSeq=0 永远判不出缺口）。故「无 DOM 缓存」必须优先走磁盘全量——有缓冲回放过时用 reload
// （先清再装，避免缓冲片段叠历史）。
//   gap → 'reload'（缓冲超窗，同 syncAckAction）；
//   !hasCache && replayed>0 → 'reload'（冷入场：缓冲片段 ≠ 全量历史，清屏拉盘）；
//   !hasCache → 'load'（聊天区空、拉磁盘首次填充，不必再清）；
//   hasCache && replayed>0 → 'keep'（切 tab 秒恢复：DOM 缓存已是全量渲染真相 + 活缓冲增量，不重载以免丢实时 thinking）；
//   hasCache && diskLen>seenDiskLen → 'reload'（外部写入盲区：缓存已过期，清屏全量重载）；
//   否则 → 'keep'（缓存仍是最新，保留 DOM 秒恢复）。
// ⚠️ 已知边界（code-review 发现4，有意不修）：seenDiskLen 只由 loadHistory/onHistoryAppend 维护，
//   web 自己 live 流跑出来的轮次【不】更新它。于是"发一轮(磁盘增长)→切走→切回同实例(无外部活动、replayed=0、
//   缓存命中)"会 diskLen>seenDiskLen → 多余 reload（闪屏+滚动跳，但内容正确）。这是【安全侧】：现状 under-count
//   → 多 reload(安全)；若改成让 live 轮 bump seenDiskLen，一旦 over-count 就变 under-reload = 漏外部写入 =
//   数据丢失(正是 #1 盲区)。宁可闪一下、不可漏消息，故保留。
// ⚠️ 冷入场 reload 的代价：环形缓冲里尚未落盘的实时 thinking/在跑工具卡会被 clearView 清掉；硬刷新本就是
//   用户主动重入，可接受——后续 live 事件与 pending 快照仍会接上。
export function shouldReloadOnEnter({ replayed, gap, hasCache, diskLen = 0, seenDiskLen = 0, hasSessionId = true } = {}) {
  // 实例还没拿到 sessionId（CLI 未吐 system/init）：session:history 无从查起——server 端 handler 的
  // sessionFileExists 守卫会直接回「会话不存在」，清屏换来的必定是白屏。此时服务端环形缓冲里的回放
  // 是唯一能看到的内容（它就是 CLI 经 stdout 实时吐出来的那份），宁可残缺也不能清空。
  // 真机 2026-07-30 bc29ccc2：web 发起 /code-review max，CLI 因第三方网关故障 31 分钟没吐 init，
  // 期间整页刷新 → 走 !hasCache && replayed>0 → 'reload' → 清屏后拿不回任何东西 → 白屏。
  // 判据用「有没有 sessionId」而非 diskLen：后者在 replayed>0 时 server 根本不读（恒 null，见
  // src/server/app.js 的 sync:since），拿 null 当 0 会把整页刷新一律变成 keep，毁掉冷入场拉盘的修复。
  if (!hasSessionId) return 'keep';
  if (gap) return 'reload';
  // 冷入场（整页刷新/无 DOM 缓存）优先于「有缓冲就 keep」——缓冲只保最近事件，不是全量历史。
  if (!hasCache) return (replayed > 0) ? 'reload' : 'load';
  // 磁盘 ahead 优先于 replayed>0 keep：外部 CLI 写盘不进活缓冲，切回/同会话有回放时仍可能漏显（G1/G2）。
  if (diskLen > seenDiskLen) return 'reload';
  if (replayed > 0) return 'keep';
  return 'keep';
}

// 修「切回会话停在旧位置 + 内容一条条冒出来像重播」：shouldReloadOnEnter 的 'keep' / syncAckAction 的
// 'none' 分支恢复的是【离开时缓存的旧内容】，之后离开期间产生的新内容才作为 sync:since 补发事件逐条
// 到达，各自走非强制 scrollBottom（未必够到"距底部<120px"的阈值）——视觉上就是先停在旧底部、再被动
// 跟着新内容一点点往下挪。'load'/'reload' 分支已由 loadHistory 完成时的 scrollBottom(true) 兜底，
// 无需重复触发；只有 keep/none 且确有真实回放内容时才需要这一次额外的强制落底。
export function shouldForceScrollAfterReplay({ action, replayed } = {}) {
  if (action !== 'keep' && action !== 'none') return false;
  return Number.isFinite(replayed) && replayed > 0;
}

// 回放缓冲决策（修「切会话/重连时离开期间积压的消息像打字机一样逐条蹦出」）：
// 根因——src/server/app.js 的 'sync:since' handler 是先把该实例环形缓冲里离开期间攒的事件逐条经
// agent:event 信封（带 replay:true 标记）逐个推给客户端发完，才调用 done()/ack（for 循环在 ack 之前，
// 顺序不可颠倒，是既有设计）。旧客户端逻辑对 replay 事件走的是和实时消息完全相同的增量渲染路径
// （text_delta/tool_use/tool_result 等逐条 handler、各自触发一次 scrollBottom），于是"离开期间攒的一长串
// 消息"会在 ack 到达前就已逐条吐到屏幕上——replay:true 目前只用来静音提示音，不做任何批量合并。
// 修法：客户端必须在请求续传（sync:since）之前就架起缓冲区（app.js + app/event-dispatch.js 的
// createReplayBuffer：begin/offer/resolve），把命中该 instanceId 的事件先原样入队不渲染（含期间可能
// 穿插的非 replay 实时事件，保序），ack 到达后才知道"这次到底缓冲了多少条"，本函数据此二选一：
//   'reload' —— 丢弃缓冲队列，改走 session:history 的既有批量渲染路径（loadHistory/renderHistoryBubbles
//                已经是分块解析 + 一次性 fragment 插入 + 单次 scrollBottom(true) 落底，无需改动）；
//   'flush'  —— 按到达顺序把缓冲事件正常派发（走原有 handler 增量渲染），但抑制每条各自触发的滚动，
//                全部派发完只做一次强制落底。
// 优先级（新增独立层，不揉进 shouldReloadOnEnter/syncAckAction 改坏原有语义）：
//   1) priorAction 已经是 'reload'（shouldReloadOnEnter 切视图 / syncAckAction 重连两条入口共用口径）
//      或 'load'（shouldReloadOnEnter 冷入场分支）→ 直接 'reload'，这层不再重复判断——磁盘全量重载
//      已经在路上，缓冲队列本就该被丢弃、无需再单独处理。
//   2) busy（该实例当前正有实时轮次在跑，调用方按 shouldSeedBusyFromInstanceState 的口径传入）→ 恒
//      'flush'。进行中的流式内容只活在服务端环形缓冲、尚未落盘，reload 走磁盘 session:history 会把这段
//      丢掉；哪怕缓冲堆积再多事件，也只能老实 flush（抑制中间滚动，但内容一条不能少）。
//   3) 其余（priorAction 是 'keep'/'none'，即 shouldReloadOnEnter/syncAckAction 已判定"不用重载"）：
//      bufferedCount 达到阈值 → 'reload'（补上"但攒太多也该重载"这一判断，是解决"逐条吐消息"问题的
//      主力路径——积压很多时直接走批量渲染，而不是让几十上百个 DOM mutation 挤在一起抖动）；
//      未达阈值 → 'flush'（少量补发，正常增量 + 抑制中间滚动 + 收尾强制落底一次，视觉上与"瞬间到达"
//      无区别，不必为了几条消息就清屏重载）。
//
// REPLAY_BUFFER_RELOAD_THRESHOLD=100 的理由：text_delta 按小段流式拆分，一次几十字的单轮回复就可能
// 有几十个 text_delta 事件（长回复、开思考模式时 thinking_delta，或夹杂 tool_use/tool_result，事件数
// 还会再往上加），但单轮再长也很少突破百级；真正"离开期间攒了好几轮回复"（本次要修的场景）每轮至少
// 贡献 user_message + N×text_delta + result 等几十个事件，2-3 轮就能轻松过百。取 100 使两头都不误判：
// 定低了会让正常的单轮长回复也被判成"积压"走清屏重载——不算错但多余地闪一下，flush 明明能不闪就搞定；
// 定高了会让真堆积多轮的场景仍在走逐条 flush——几十上百次独立 DOM mutation 挤在一起，观感依然是抖动/
// 蹦出，正是本次要修的问题本身。
export const REPLAY_BUFFER_RELOAD_THRESHOLD = 100;

export function resolveReplayBufferAction({ bufferedCount = 0, priorAction, busy = false, hasSessionId = true, threshold = REPLAY_BUFFER_RELOAD_THRESHOLD } = {}) {
  if (priorAction === 'reload' || priorAction === 'load') return 'reload';
  // 无 sessionId：同 shouldReloadOnEnter 的首条闸——一层已判 'keep'，这层不能因为「积压超阈值」
  // 就把它升级回 reload，那同样是清屏换一个拿不到的磁盘。busy 分支只覆盖「轮次进行中」，
  // 轮次结束后再刷新 busy=false，只剩这条闸兜着。
  if (!hasSessionId) return 'flush';
  if (busy) return 'flush';
  return bufferedCount >= threshold ? 'reload' : 'flush';
}

// stick-to-bottom 判定（聊天 messagesEl / 客户端日志 consoleLogArea 共用）：
// force 总是落底；否则仅当「距底 < threshold」时跟随。上翻读历史时新内容不得拽回。
// 默认 120 与 app.js 历史 scrollBottom 阈值对齐。
export function shouldStickScrollToBottom({
  scrollHeight, scrollTop, clientHeight,
  force = false,
  threshold = 120,
} = {}) {
  if (force) return true;
  const dist = Number(scrollHeight) - Number(scrollTop) - Number(clientHeight);
  return Number.isFinite(dist) && dist < threshold;
}

// 未读胶囊"跳到第一条未读"定位：未读消息永远是当前已渲染顶层气泡列表的尾部 N 条（N=服务端
// unreadOnEntry），不需要跨路径消息 ID 贯穿磁盘存储和实时流——渲染完成后对列表做一次位置计算即可。
// 返回 -1 表示无需定位；unreadCount 超过实际渲染条数时 clamp 到 0（滚到已加载内容最顶部），不越界。
export function resolveUnreadAnchorIndex(listLength, unreadCount) {
  if (!Number.isFinite(unreadCount) || unreadCount <= 0 || listLength <= 0) return -1;
  return Math.max(0, listLength - unreadCount);
}

// 未读胶囊第三条自动确认已读路径（与「点击胶囊」「IntersectionObserver 扫到锚点」并存，见 app.js
// showUnreadPillIfAny/ackUnread，三条互不替代）：用户手动滚动到贴近底部，视为「已经看到最新消息」。
// 核心难点——切入积压了很多未读的会话时，回放缓冲（P0-REPLAY-BUFFER）落底会程序性调一次
// scrollBottom(true) 把视图直接推到最新消息处；这次滚动不代表用户已经看到胶囊、意识到自己错过了
// 什么，若不排除会让胶囊在用户还没反应过来时就被这次程序性落底误判成"已读"清掉。
// withinProgrammaticWindow 由调用方（app.js messagesEl 的 scroll 监听）根据 scrollBottom() 内部维护的
// "程序性滚动窗口"时间戳算出并传入布尔值，这里只消费结果，不关心具体时长/定时器实现。贴底判断直接
// 复用 shouldStickScrollToBottom（不重新发明一遍阈值逻辑），用它的默认 threshold。
export function shouldAckUnreadOnScroll({
  pillVisible = false,
  withinProgrammaticWindow = false,
  scrollHeight, scrollTop, clientHeight,
} = {}) {
  if (!pillVisible) return false;
  if (withinProgrammaticWindow) return false;
  return shouldStickScrollToBottom({ scrollHeight, scrollTop, clientHeight });
}

// 同 sessionId 的 DOM 缓存恢复策略：已完成的对话/工具卡片按会话不可变，与当前 instanceId 无关。
// instance 会因 effort/model 切档被 dispose+open 换新（新 epoch/seq 空间），但历史 DOM 仍可秒恢复；
// 仅当「缓存归属实例 === 当前实例」时才复用 lastSeq/epoch 做增量续传，否则 seq 从 0 跟新实例，
// 避免旧实例的 seq 基线对新缓冲错位（错位会漏事件或把新事件当重复丢掉）。
//   restore=false           → 无节点可恢复，走 loading + history
//   restore + reuseSeqBaseline → 贴回 DOM，并用 cached.lastSeq/epoch 增量 sync
//   restore + !reuseSeqBaseline → 贴回 DOM，resumeFromSeq=0（新实例全量增量从空缓冲起）
export function sessionDomCachePlan({ cached, currentInstanceId } = {}) {
  if (!cached?.nodes?.length) {
    return { restore: false, resumeFromSeq: 0, reuseSeqBaseline: false, epoch: null, lastSeq: 0 };
  }
  const sameInstance = cached.instanceId === currentInstanceId;
  if (sameInstance) {
    const lastSeq = Number(cached.lastSeq) || 0;
    return {
      restore: true,
      resumeFromSeq: lastSeq,
      reuseSeqBaseline: true,
      epoch: cached.epoch ?? null,
      lastSeq,
    };
  }
  return { restore: true, resumeFromSeq: 0, reuseSeqBaseline: false, epoch: null, lastSeq: 0 };
}

// 软键盘弹起时，底部输入区(footer)该用多大的 padding-bottom 给键盘让位。
//   iOS Safari：键盘只缩 visualViewport、layout viewport(innerHeight)不动 → 需手动补 (innerHeight-viewportHeight)
//     把输入框顶到键盘上方；
//   Android(viewport meta interactive-widget=resizes-content)：layout viewport 随键盘一起缩，
//     innerHeight≈viewportHeight → inset≈0、本就不需补。
// 要害(E17 附件回流空白 bug)：inputFocused=false（键盘应已收起）时**一律回落 baseBottom**。否则点附件按钮
//   唤起系统文件/相册选择器时，输入框失焦、innerHeight/viewportHeight 在抢/还焦点期间瞬时错配
//   （innerHeight 已恢复全屏、viewportHeight 还停在键盘弹起的小值），会算出一个大 inset 被写死进 padding，
//   留出半屏空白且无人复位。按焦点门控后，键盘收起即回落静息值，空白自愈。
// inset 为负/NaN/0 同样回落 baseBottom，绝不写负 padding。
export function keyboardInsetPadding({ innerHeight, viewportHeight, viewportOffsetTop = 0, inputFocused, baseBottom = 0 }) {
  if (!inputFocused) return baseBottom;
  const inset = innerHeight - viewportHeight - viewportOffsetTop;
  if (!(inset > 0)) return baseBottom;
  return baseBottom + inset;
}

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

// 模型网格「默认磁贴」（data-model=""）文案决策。currentModel 非空=已选/已知具体模型 → 磁贴非激活、显通用文案。
// currentModel 为空且已知 cwd 默认 → 显真实默认名（诚实：cwd 级最佳猜测、非该会话确定值；续接无记录会话真实
// 模型可能不同，首条消息后由 init.model 校正）。仅改文案，不影响发送（modelInput.value 恒空、不传 --model）。
export function defaultModelTileLabel({ currentModel, cwdDefaultModel } = {}) {
  if (!currentModel && cwdDefaultModel) {
    const naked = String(cwdDefaultModel).replace(/\[[^\]]+\]$/, '');
    return { title: t('默认模型'), subtitle: naked, showsName: true };
  }
  return { title: t('沿用当前模型'), subtitle: t('不指定特定模型'), showsName: false };
}

// 用户气泡长消息折叠决策（纯函数）。
// 移动端痛点：长指令气泡占满屏、想上滑看前面的内容被它顶住。阈值取「实际换行数 + 自动换行估算」
// 偏多的一类——超阈值则建议折叠（DOM 接线在 app.js 渲染 max-height + 展开按钮）。
//
// 行数估算：显式 \n 拆出的段 + 每段按 cols 字符自动换行行数（cols≈手机气泡可容纳字符宽）。
// cols 取 30：实测旧款 iPhone Safari 中文 16px 气泡约 28-32 字符/行，取偏窄值保守触发折叠。
//   返回 { fold: bool, lines: number }
//   fold 仅当超 foldLines（默认 10）行——短指令（一两周行）不折，覆盖原痛点又不过度。
export function userBubbleFold(text, { foldLines = 10, cols = 30 } = {}) {
  const s = String(text ?? '');
  if (!s) return { fold: false, lines: 0 };
  let lines = 0;
  for (const seg of s.split('\n')) {
    lines += seg.length === 0 ? 1 : Math.ceil(seg.length / cols);
  }
  return { fold: lines > foldLines, lines };
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

// 统一判定：会话待处理 + 服务异常 → ok | attention | alert（顶栏 connDot 边框 / 注意力信号）。
// priority: alert > attention > ok。抽屉不再复述计数；状态落在需要你卡、工作区树角标、主聊天面。
export function whatNeedsAttention({ instances, needsYou, service } = {}) {
  const items = [];
  if (Array.isArray(needsYou)) {
    for (const n of needsYou) {
      if (!n) continue;
      items.push({
        kind: n.reason === 'awaiting_input' ? 'awaiting_input' : 'awaiting_approval',
        ref: n.instanceId || n.sessionId || null,
        summary: n.title || n.toolName || n.reason || t('需要你'),
      });
    }
  }
  // needsYou 可能空但 instance 仍 permission（竞态/旧端）——补一条
  if (!items.length && Array.isArray(instances)) {
    for (const inst of instances) {
      if (inst?.state === 'permission') {
        items.push({
          kind: 'awaiting_approval',
          ref: inst.instanceId || null,
          summary: inst.title || t('待审批'),
        });
      }
    }
  }
  if (service && service.deliveryFailure && typeof service.deliveryFailure === 'object') {
    const df = service.deliveryFailure;
    items.push({
      kind: 'delivery_failure',
      ref: df.channel || null,
      summary: `${t('推送失败（')}${df.channel || 'push'}${t('）')}`,
    });
    return { level: 'alert', items };
  }
  if (items.length) return { level: 'attention', items };
  return { level: 'ok', items: [] };
}

// 通知深链落地策略（②2c）：通知带 {instanceId, sessionId, cwd}，点击后据客户端 instances 快照决定动作。
//   setViewing = instanceId 仍在 live 列表 → 直接切视图（最快）
//   switch     = 实例已失效（懒重生 / 关闭 / epoch 变化）但会话在 → session:switch 懒 resume（服务端校验归属）
//   list       = 都定位不到（缺 sessionId 或无 instanceId）→ 打开会话列表让用户手选
export function resolveDeepLinkTarget(target, instances = []) {
  if (!target || !target.instanceId) return { action: 'list' };
  // instanceId 是【进程内计数器】（instance-manager 的 `inst_${++counter}`，server 重启即从 inst_1 重新发号），
  // 所以「同号」不等于「同一个会话」。重启后点一条留在通知栏的旧通知，很可能落进另一个项目的会话——
  // 用户以为自己在 A、实际在 B，在 B 里发消息/授权都是错投，比点不开严重得多。通知 data 里本来就带了
  // sessionId，这里一并校验：对不上就不当 live，回落到下面按 sessionId 懒 resume 的 switch 分支。
  const live = Array.isArray(instances) && instances.some(i => i
    && i.instanceId === target.instanceId
    && (!target.sessionId || !i.sessionId || i.sessionId === target.sessionId));
  if (live) return { action: 'setViewing', instanceId: target.instanceId };
  if (target.sessionId) return { action: 'switch', sessionId: target.sessionId, cwd: target.cwd };
  return { action: 'list' };
}

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

// 轮次 result → 聊天流条/通知/触感/挂起工具收尾。
// CLI 对用户主动中止只呈现 interrupt，不把 SDK 伴随的 is_error + ede_diagnostic 当红色错误。
// 后端 agent.js 在 interrupt() 成功后给紧随的 result 打 interrupted=true；此处优先于 isError。
// opts.rand 注入过去式动词随机源（默认 Math.random），仅供测试确定化；成功轮收尾行用它。
export function presentTurnResult(payload = {}, opts = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const durationMs = typeof p.durationMs === 'number' ? p.durationMs : 0;
  const cost = typeof p.costUsd === 'number' ? ` · $${p.costUsd.toFixed(4)}` : '';
  const secs = (durationMs / 1000).toFixed(1);
  const errorText = Array.isArray(p.errors) ? p.errors.filter(Boolean).join('; ') : '';

  if (p.interrupted) {
    return {
      kind: 'aborted',
      statusBar: { text: `${t('已中止')} · ${secs}s${cost}`, cls: 'text-ink-faint' },
      errorBar: null,
      notify: { title: t('⏹ 任务已中止'), body: `${t('用时')} ${secs}s` },
      failToolsMessage: t('已中止'),
      haptic: 'warning',
    };
  }
  if (p.isError) {
    return {
      kind: 'error',
      statusBar: { text: `${t('完成')} · ${secs}s${cost}`, cls: 'text-ink-faint' },
      errorBar: errorText ? { text: `${t('出错：')}${errorText}`, cls: 'text-danger' } : null,
      notify: { title: t('⚠️ 任务出错'), body: errorText.slice(0, 80) || `${t('用时')} ${secs}s` },
      failToolsMessage: errorText || t('工具执行已因本轮错误停止'),
      haptic: 'error',
    };
  }
  // 成功轮收尾对齐 CLI turn_duration 行：✻ <过去式动词> for <时长>。
  // 累计 cost 不再挂后缀（状态栏 #cliStatus 随时可看），保终端等价的收敛观感。
  return {
    kind: 'success',
    statusBar: { text: `✻ ${pickTurnDoneVerb(opts.rand)} for ${formatCliDuration(durationMs)}`, cls: 'text-ink-faint' },
    errorBar: null,
    notify: { title: t('✅ 任务完成'), body: `${t('用时')} ${secs}s` },
    failToolsMessage: null,
    haptic: 'success',
  };
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
// 两处刻意不给按钮：① env 停用时——正解是改 .env 重启，给按钮等于误导；② 漂移时——用户自己动过
// settings.json，一键覆盖会踩掉他的改动，交给他自己 hooks:status 决断。
// 旧 server 不带 hooksBridge / 读不出状态 → 返回 null 整段不渲染，宁可缺席也不误报"未安装"。
export function formatHooksBridgeRow(hooksBridge) {
  const state = hooksBridge?.state;
  if (!state || state === 'unknown') return null;
  const label = t('终端会话推送');
  if (hooksBridge.off) {
    return { label, value: t('已停用（CLI_HOOKS_BRIDGE=off）'), tone: 'muted', action: null };
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
    .filter((u) => u.last24h > 0 || u.flapping)
    .map((u) => ({
      label: u.label,
      // flapping 的判据是频率（1 小时内 ≥3 次），不是「上次退出码非 0」
      text: u.flapping
        ? `1 小时内重启 ${u.lastHour} 次`
        : `24 小时内 ${u.last24h} 次 · 上次 ${formatAgoShort(now - u.lastRestartAt)}前`,
      alert: !!u.flapping,
    }));

  const timeline = recent.map((e) => ({
    label: e.label,
    text: `${formatAgoShort(now - e.ts)}前 ${restartKindText(e.kind)}`,
  }));

  return { summary, timeline, empty: false };
}

function restartKindText(kind) {
  if (kind === 'restarted') return '重启';
  if (kind === 'started') return '启动';
  if (kind === 'stopped') return '停止';
  return kind || '?';
}

// 粗粒度「多久以前」。UI 要的是量级不是精度。
export function formatAgoShort(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

export function formatServiceNotices({ service, now } = {}) {
  const notices = [];
  const countSuffix = c => (Number.isFinite(c) && c > 0 ? `${t('（累计')} ${c} ${t('次）')}` : '');
  const lockout = service && service.rateLimitLockout;
  if (lockout && typeof lockout.at === 'number') {
    notices.push(`${t('⛔ 登录限速锁定于')} ${formatAgo(now - lockout.at)}${countSuffix(lockout.count)}${t('——可能有人在暴力尝试你的入口')}`);
  }
  const df = service && service.deliveryFailure;
  if (df && typeof df.at === 'number') {
    const channelLabel = df.channel === 'ntfy' ? 'ntfy' : 'push';
    const cnt = Number.isFinite(df.count) && df.count > 0 ? `${t('，累计')} ${df.count} ${t('次')}` : '';
    notices.push(`${t('🔔 推送最近失败于')} ${formatAgo(now - df.at)}（${channelLabel}${cnt}）`);
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

// 交互日志抽屉「全部｜交互｜诊断」三态过滤：诊断行的 type 统一 diag_ 前缀。未知 filter 值保守
// 原样返回（不误伤显示）。
export function filterConsoleEntries(entries, filter) {
  const list = Array.isArray(entries) ? entries : [];
  if (filter === 'diag') return list.filter(e => String(e?.type || '').startsWith('diag_'));
  if (filter === 'interaction') return list.filter(e => !String(e?.type || '').startsWith('diag_'));
  return list;
}

// 子 agent 事件判定：agent.js 对 parent_tool_use_id 消息分流 emit 时带 parentToolUseId。
// 前端 text_delta/thinking_delta/tool_use/tool_result 用它决定「嵌进子 agent 卡」vs「主流气泡」。
// 只认非空字符串——数字/空串都当主流，防脏字段把主对话误收进卡。
export function isSubagentPayload(p) {
  return !!(p && typeof p.parentToolUseId === 'string' && p.parentToolUseId);
}

// 会 spawn 子 agent / 后台阶段 的主工具：预建折叠卡、活动横幅、历史 sidechain 挂靠共用。
// Workflow（ultracode 工作流）与 Agent/Task 同列——否则 web 点 Workflow 只有橙条、看不到子代理卡挂点。
export function isSpawnToolName(name) {
  return name === 'Agent' || name === 'Task' || name === 'Workflow';
}

// 后台任务行主标题：优先可读 message；local_agent 加 🤖，bash 加 🖥。
// 避免再叠「子代理 ·」当 message 已是「Plan：…」形态。
export function formatBgTaskRowLabel({ taskType, message, taskId, subagentType } = {}) {
  let msg = (typeof message === 'string' && message.trim()) ? message.trim() : '';
  if (!msg && subagentType) msg = String(subagentType).trim();
  if (!msg && typeof taskId === 'string' && taskId && !isSyntheticTaskId(taskId)) {
    msg = taskId.slice(0, 12);
  }
  if (!msg) msg = t('后台任务');
  // 洗掉「Search: search:」类重复段（workflow 阶段名 + last_tool 同词）
  msg = msg.replace(/^([A-Za-z一-鿿]{2,24})\s*[:：]\s*\1\s*[:：]\s*/i, '$1：');
  const kind = taskType != null ? String(taskType).trim() : '';
  if (kind === 'local_agent' || kind === 'agent') {
    if (/^🤖/.test(msg)) return msg;
    if (/^[^\s：:]{2,40}[：:]/.test(msg)) return `🤖 ${msg}`;
    return `🤖 ${msg}`;
  }
  if (kind === 'local_bash' || kind === 'bash') {
    return msg.startsWith('🖥') ? msg : `🖥 ${msg}`;
  }
  return msg;
}

// 子 agent 可折叠卡片标题（默认收起；机主选「可折叠卡片」形态）。
// running=true → 运行中；false → 已完成（主 Agent tool_result 或本轮 result 收束）。
// 类型缺失时兜底「子 agent」（stream_event 首批 delta 可能早于带 subagent_type 的 assistant）。
export function formatSubagentCardTitle({ subagentType, running = true } = {}) {
  const raw = subagentType != null ? String(subagentType).trim() : '';
  const type = raw || t('子 agent');
  return running ? `🤖 ${type} ${t('运行中')}` : `🤖 ${type} ${t('已完成')}`;
}

// 工具摘要是否已被 agent/history 截断（口径：尾缀「 …（已截断）」——见 agent.js truncate）。
// 前端据此显「展开全文」；payload.truncated 优先（布尔），缺省时嗅探摘要串。
export function isToolSummaryTruncated(summary, { truncated } = {}) {
  if (truncated === true) return true;
  if (truncated === false) return false;
  return typeof summary === 'string' && summary.includes(t('…（已截断）'));
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

// 后台任务停止按钮态：有非空 taskId 且横幅可见才可点（对齐 SDK stopTask(taskId)）。
// 合成任务 id：SDK 侧不存在这个 id，任何「停止」都必然静默失败，展示上也不该露出内部命名空间。
// 两类来源：
//   __notask_*  —— agent.js 在 SDK 未给 task_id 时的占位；
//   localcmd:*  —— 本地 slash 命令期间从磁盘 subagents/ 观察出来的子代理（agent.js
//                  LOCAL_CMD_TASK_PREFIX），它们是 CLI fork 上下文里的进程。
// 【为什么抽出来】这是个「协议字段」性质的判断，消费者有停止策略、行标题回落、meta shortId 三处。
// 2026-08-05 第一轮只改了停止策略一处，另两处继续泄漏 `#localcmd:a`（真机截图可见）——
// 合成键必须扫全部消费者，不能靠单个 helper 自觉。
// 前缀字面量前后端各写一份：边界规则禁止 public/js 引用 src/，改一处必须改另一处。
export function isSyntheticTaskId(taskId) {
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  return id.startsWith('__notask_') || id.startsWith('localcmd:');
}

export function taskStopUiState({ taskId, bannerVisible = true } = {}) {
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  // 合成键（agent.js 在 SDK 未给 task_id 时用 `__notask_${taskType}` 占位）不是真实 taskId：
  // 它在 SDK 侧根本不存在，q.stopTask('__notask_local_agent') 必然静默失败，而 UI 仍会打一条
  // 「已请求停止…」，任务行挂到 BG_TASK_ORPHAN_TTL_MS(3min) 才消失。同文件的行标签渲染早就知道要排除
  // 这个前缀（task-status.js 里 `!taskId.startsWith('__notask_')` 才显示 #shortId），停止按钮漏了。
  const synthetic = isSyntheticTaskId(id);
  return { canStop: Boolean(id) && !synthetic && bannerVisible !== false, taskId: synthetic ? null : (id || null) };
}

// 后台任务列表是否折叠：默认单任务展开（不挡内容）、多任务收起（避免堆满屏挡聊天内容）；
// 用户手动展开/收起后一律遵从用户选择，直至横幅整体撤下重置。
// 用户表态对单任务同样生效——折叠热区是整条横幅头行，任何任务数下点了都必须有反应，否则是死点击。
export function bgTaskListCollapsed({ count = 0, userExpanded = null } = {}) {
  if (count <= 0) return false; // 无任务：列表整体不存在，值不生效但保持确定性
  if (userExpanded === true) return false;
  if (userExpanded === false) return true;
  return count > 1;
}

// 后台任务详情面板：进度历史条目格式化。
// description = 工具态即时更新（如 "Running tests..."），summary = AI ~30s 进度摘要。
// 两者择一显示（summary 优先，因更语义化；description 兜底）。
export function formatProgressHistoryEntry({ ts, description, lastToolName, summary } = {}) {
  const time = typeof ts === 'number' ? formatProgressTimestamp(ts) : '';
  const text = (typeof summary === 'string' && summary.trim())
    || (typeof description === 'string' && description.trim())
    || '';
  const prefix = lastToolName ? `${lastToolName} · ` : '';
  return { time, text: prefix + text, hasSummary: Boolean(summary?.trim()) };
}

// 进度时间戳：5 分钟内显示相对时间（如 "30s前"、"2m前"），超过显示 HH:MM:SS。
export function formatProgressTimestamp(ts) {
  const diff = Date.now() - ts;
  if (diff < 0) return '0s';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 300000) return `${Math.floor(diff / 60000)}m`;
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// 后台任务详情面板状态：当前 taskId 与 activeDetailId 匹配时展开。
export function taskDetailState({ taskId, activeDetailId } = {}) {
  if (!taskId || !activeDetailId) return { visible: false };
  return { visible: taskId === activeDetailId };
}

// CLI 式 spinner 动词表：逐字提取自本机 claude CLI bundle（2.1.211）的本地词表，保终端等价性。
export const SPINNER_VERBS = Object.freeze(['Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking', 'Beaming', "Beboppin'", 'Befuddling', 'Billowing', 'Blanching', 'Bloviating', 'Boogieing', 'Boondoggling', 'Booping', 'Bootstrapping', 'Brewing', 'Bunning', 'Burrowing', 'Calculating', 'Canoodling', 'Caramelizing', 'Cascading', 'Catapulting', 'Cerebrating', 'Channeling', 'Channelling', 'Choreographing', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Combobulating', 'Composing', 'Computing', 'Concocting', 'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Crystallizing', 'Cultivating', 'Deciphering', 'Deliberating', 'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing', 'Doodling', 'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing', 'Enchanting', 'Envisioning', 'Fermenting', 'Fiddle-faddling', 'Finagling', 'Flambéing', 'Flibbertigibbeting', 'Flowing', 'Flummoxing', 'Fluttering', 'Forging', 'Forming', 'Frolicking', 'Frosting', 'Gallivanting', 'Galloping', 'Garnishing', 'Generating', 'Gesticulating', 'Germinating', 'Gitifying', 'Grooving', 'Gusting', 'Harmonizing', 'Hashing', 'Hatching', 'Herding', 'Honking', 'Hullaballooing', 'Hyperspacing', 'Ideating', 'Imagining', 'Improvising', 'Incubating', 'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning', 'Kneading', 'Leavening', 'Levitating', 'Lollygagging', 'Manifesting', 'Marinating', 'Meandering', 'Metamorphosing', 'Misting', 'Moonwalking', 'Moseying', 'Mulling', 'Mustering', 'Musing', 'Nebulizing', 'Nesting', 'Newspapering', 'Noodling', 'Nucleating', 'Orbiting', 'Orchestrating', 'Osmosing', 'Perambulating', 'Percolating', 'Perusing', 'Philosophising', 'Photosynthesizing', 'Pollinating', 'Pondering', 'Pontificating', 'Pouncing', 'Precipitating', 'Prestidigitating', 'Processing', 'Proofing', 'Propagating', 'Puttering', 'Puzzling', 'Quantumizing', 'Razzle-dazzling', 'Razzmatazzing', 'Recombobulating', 'Reticulating', 'Roosting', 'Ruminating', 'Sautéing', 'Scampering', 'Schlepping', 'Scurrying', 'Seasoning', 'Shenaniganing', 'Shimmying', 'Simmering', 'Skedaddling', 'Sketching', 'Slithering', 'Smooshing', 'Sock-hopping', 'Spelunking', 'Spinning', 'Sprouting', 'Stewing', 'Sublimating', 'Swirling', 'Swooping', 'Symbioting', 'Synthesizing', 'Tempering', 'Thinking', 'Thundering', 'Tinkering', 'Tomfoolering', 'Topsy-turvying', 'Transfiguring', 'Transmuting', 'Twisting', 'Undulating', 'Unfurling', 'Unravelling', 'Vibing', 'Waddling', 'Wandering', 'Warping', 'Whatchamacalliting', 'Whirlpooling', 'Whirring', 'Whisking', 'Wibbling', 'Working', 'Wrangling', 'Zesting', 'Zigzagging']);

export function pickSpinnerVerb(rand = Math.random) {
  return SPINNER_VERBS[Math.floor(rand() * SPINNER_VERBS.length)] || 'Working';
}

// 回合收尾行过去式动词表（8 词，逐字取自 CLI 2.1.211 bundle 的 turn_duration 词表 $6s，兜底 "Worked"）。
// 与活 spinner 的 SPINNER_VERBS 是两套独立词表——CLI 亦如此：spinner 用现在分词、收尾行用过去式。
export const TURN_DONE_VERBS = Object.freeze(['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked']);

export function pickTurnDoneVerb(rand = Math.random) {
  return TURN_DONE_VERBS[Math.floor(rand() * TURN_DONE_VERBS.length)] || 'Worked';
}

// 回合收尾行时长格式：移植 CLI Hs（turn_duration 分支，不含 hideTrailingZeros/mostSignificantOnly）。
// <60s → "8s"（整秒下取整）；更长 "2m 49s" / "1h 2m 3s" / "1d 2h 3m"（秒四舍五入，逢 60 逐位进位；天级不带秒）。
// 负数/非有限值 → "0s"（turn 时长恒为整数 ms≥0，防御性归零；亚毫秒不可达故不还原 CLI 的 "0.0s" 分支）。
export function formatCliDuration(ms) {
  const e = Number(ms);
  if (!Number.isFinite(e) || e <= 0) return '0s';
  if (e < 60000) return `${Math.floor(e / 1000)}s`;
  let d = Math.floor(e / 86400000);
  let h = Math.floor((e % 86400000) / 3600000);
  let m = Math.floor((e % 3600000) / 60000);
  let s = Math.round((e % 60000) / 1000);
  if (s === 60) { s = 0; m++; }
  if (m === 60) { m = 0; h++; }
  if (h === 24) { h = 0; d++; }
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// 距上次 agent:event 的安静期提示阈值（秒）。纯前端文案层心理预期管理，
// 与服务端 agent.js idleTimeoutMs（默认 10 分钟）完全独立，不共享常量、不改服务端判定。
export const LIVE_STALE_HINT_SEC = 20; // ≥20s 无事件 → 追加「仍在等待响应」
export const LIVE_STALE_WARN_SEC = 60; // ≥60s 无事件 → 追加更明确的慢响应提示（两级互斥，不叠加）

// 三阶段等待判定：sendInFlight 优先（发送 ack 前）→ 已见 content delta → responding，否则 waiting。
// waiting/responding 当前共用 formatCliSpinnerLine；安静太久自然衔接到 stale 提示，不另发明文案。
export function resolveLiveWaitPhase({ sendInFlight = false, sawContentDelta = false } = {}) {
  if (sendInFlight) return 'sending';
  return sawContentDelta ? 'responding' : 'waiting';
}

// CLI 式动态状态行组装：✻ Stewing… (55s · ↓ 3.3k tokens · thought for 1s)
// thinking = null | { state: 'active'|'done', ms }；outTokens 空/0 省段。
// sinceLastEventSec：null=不适用（断线等）不追加；≥hint/warn 追加安静期提示。
// 对齐 CLI 不挂工具后缀段——正在执行的命令由消息流里的工具卡显示，此行只保动词+秒表+tokens+thinking。
export function formatCliSpinnerLine({
  verb = '',
  elapsedSec = 0,
  outTokens = null,
  thinking = null,
  effort = null,
  glyph = '✻',
  sinceLastEventSec = null,
} = {}) {
  const v = String(verb || '').trim() || 'Working';
  // 秒表行 token 带 1 位小数；≥1000.0k 抬 m（对齐 statuslineFmtTok 边界）
  const fmtTok = n => {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
    if (n >= 1e3) {
      const k = n / 1e3;
      if (k >= 1000) return `${(k / 1000).toFixed(1)}m`;
      return `${k.toFixed(1)}k`;
    }
    return String(n);
  };
  const segs = [`${Math.max(0, Math.floor(Number(elapsedSec) || 0))}s`];
  if (Number.isFinite(outTokens) && outTokens > 0) segs.push(`↓ ${fmtTok(outTokens)} tokens`);
  if (thinking?.state === 'active') {
    segs.push(effort ? `thinking with ${effort} effort` : 'thinking…');
  } else if (thinking?.state === 'done') {
    segs.push(`thought for ${Math.max(1, Math.round((thinking.ms || 0) / 1000))}s`);
  }
  if (Number.isFinite(sinceLastEventSec)) {
    if (sinceLastEventSec >= LIVE_STALE_WARN_SEC) segs.push(t('响应较慢，可能是深度思考或网络问题'));
    else if (sinceLastEventSec >= LIVE_STALE_HINT_SEC) segs.push(t('仍在等待响应'));
  }
  return `${glyph} ${v}… (${segs.join(' · ')})`;
}

// CLI 式 API 重试行：✻ API 错误 503 · 4s 后重试 · 第 2/10 次
// 整行顶替 spinner——CLI 亦如此（retryStatus ? 重试行 : spinner 行 的二选一，而非往括号里加段；
// CLI spinner 括号只有 suffix/elapsed/tokens/thinking 四个槽，没有错误位）。
// errorStatus 为 null 是真实高频形态（连接超时无 HTTP 响应，见 sdk.d.ts SDKAPIRetryMessage 注释），
// 走「等待 API 响应 … 检查网络」分支，对齐 CLI 的 stalled 文案，绝不显示 undefined。
// 边界：SDK 的 api_retry payload 只给状态码 + 错误枚举，没有上游报文原文；原文只能等重试耗尽后的
// 终态 error 事件（agent.js 从 assistant.error 的 message.content 透传）。此行不伪造原文。
export function formatCliRetryLine({
  attempt = null,
  maxRetries = null,
  remainingSec = null,
  errorStatus = null,
  glyph = '✻',
} = {}) {
  const status = Number(errorStatus);
  const hasStatus = Number.isFinite(status) && status > 0;
  const head = hasStatus ? `${t('API 错误')} ${status}` : t('等待 API 响应');
  const segs = [];
  // null/undefined 表示「没有倒计时数据」→ 省略段；0 是真实状态（马上重试）→ 照显
  const rs = remainingSec === null || remainingSec === undefined || remainingSec === '' ? NaN : Number(remainingSec);
  if (Number.isFinite(rs)) segs.push(t('Ns 后重试').replace('N', String(Math.max(0, Math.floor(rs)))));
  const a = Number(attempt);
  const m = Number(maxRetries);
  const hasAttempt = Number.isFinite(a) && a > 0;
  const hasMax = Number.isFinite(m) && m > 0;
  if (hasAttempt && hasMax) segs.push(t('第 A/B 次').replace('A', String(a)).replace('B', String(m)));
  else if (hasAttempt) segs.push(t('第 N 次').replace('N', String(a)));
  if (!hasStatus) segs.push(t('检查网络'));
  return segs.length ? `${glyph} ${head} · ${segs.join(' · ')}` : `${glyph} ${head}`;
}

// thinking 秒数 burst 累计：delta 间隔 ≤ gapMs 计入时长，超 gap 视为新 burst 不补空档；首帧只记 lastTs。
export function advanceThinkingClock({ ms = 0, lastTs = 0 } = {}, nowTs, gapMs = 2000) {
  const now = Number(nowTs) || 0;
  const prev = Number(lastTs) || 0;
  const delta = prev > 0 ? now - prev : 0;
  return { ms: (Number(ms) || 0) + (delta > 0 && delta <= gapMs ? delta : 0), lastTs: now };
}

// 底栏 sheet 下拉关闭判定：位移够大，或带一点位移的快速下甩 → close；否则 snap 回原位。
// dy / velocityY 正向=向下（px / px·ms⁻¹）；负值（上推）一律 snap。
export function resolveSheetDragEnd({
  dy = 0,
  velocityY = 0,
  dismissPx = 96,
  dismissVelocity = 0.55,
  minFlickDy = 24,
} = {}) {
  const d = Number(dy) || 0;
  const v = Number(velocityY) || 0;
  if (d < 0) return 'snap';
  if (d >= dismissPx) return 'close';
  if (v >= dismissVelocity && d >= minFlickDy) return 'close';
  return 'snap';
}

// ── 服务状态面板（service:status ack → 三段渲染）────────────────────────────
// 与 formatAgo 分工：这里是"运行了多久"（时长），那边是"多久之前"（时点距今）。
export function formatUptime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs} ${t('秒')}`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} ${t('分钟')}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${t('小时')} ${mins % 60} ${t('分')}`;
  return `${Math.floor(hours / 24)} ${t('天')} ${hours % 24} ${t('小时')}`;
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

// 本次会话分隔线判定：合并按 ts 升序=恢复段(上次会话)在前、本次在后；在恢复段末尾→本次开头的
// 交界处（前条 restored、当前非 restored）画一次「—— 本次会话 ——」。全本次或全恢复都不画。
export function isRestoredBoundary(prevEntry, entry) {
  return !!prevEntry?.restored && !entry?.restored;
}

// 长按历史气泡「从这里分叉」该发哪条消息的 uuid 给 forkSession（upToMessageId）：
// assistant 气泡 = 分叉点就是它自己；user 气泡故意不用自身 uuid，而是取它前面最近一条 assistant 的
// uuid——语义是「从这里开始重新问」（新会话里下一步就是重新打字），而非把这条提问原样复制进新会话末尾。
// DOM 侧负责找 precedingAssistantUuid（沿 previousElementSibling 回溯），本函数只做决策、不碰 DOM。
export function resolveForkAnchorUuid({ role, ownUuid = null, precedingAssistantUuid = null } = {}) {
  if (role === 'assistant') return ownUuid || null;
  return precedingAssistantUuid || null;
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

/** token 短格式：1.0m / 13k / 42；round 到 k 后 ≥1000 抬升 m，避免 1000k */
export function statuslineFmtTok(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) {
    const k = Math.round(n / 1e3);
    if (k >= 1000) return `${(k / 1000).toFixed(1)}m`;
    return `${k}k`;
  }
  return String(n);
}

/** git 短文案：branch +暂存 !改动 ?未跟踪 ↑ahead ↓behind（对齐展开态） */
export function formatStatuslineGitBrief(git) {
  if (!git?.branch) return '';
  let b = String(git.branch);
  if (git.staged || git.modified || git.untracked) {
    if (git.staged) b += ` +${git.staged}`;
    if (git.modified) b += ` !${git.modified}`;
    if (git.untracked) b += ` ?${git.untracked}`;
  } else if (git.changed) {
    b += ` ✱${git.changed}`;
  }
  if (git.ahead) b += ` ↑${git.ahead}`;
  if (git.behind) b += ` ↓${git.behind}`;
  return b;
}

/**
 * 顶栏工作区 pill 的「未提交改动数」角标文案（空串＝隐藏）。
 * 存在的理由：工作区面板（文件/改动）此前全靠用户主动点 pill 才能发现；有改动时让入口自己招手。
 *
 * 口径取 changed（`git status --porcelain` 行数，一文件一条），**不取 staged+modified+untracked 之和**
 * ——三分不互斥，`MM`（既暂存又有新改动）会被双计，见 src/ops/statusline.js parsePorcelain。
 * 数据源是 status_line 事件里现成的 git 段，不额外发 git:status；git 段缺席（非 git 仓库 /
 * WEB_STATUSLINE=off / git 不可用）即隐藏，与 gitStatus 自身「优雅缺席」的口径一致。
 */
export function formatWorkspaceChangeBadge(git) {
  if (!git?.branch) return '';                          // 非 git 仓库 / git 段缺席
  const n = git.changed;
  if (!Number.isInteger(n) || n <= 0) return '';        // 干净、缺字段、NaN、负数、字符串一律隐藏
  return n > 99 ? '99+' : String(n);                    // pill 空间有限，超 99 截断
}

/** ctx 短文案：优先百分比，否则绝对 token */
export function formatStatuslineCtxBrief(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  if (Number.isFinite(ctx.usedPercent)) return `ctx ${Math.round(ctx.usedPercent)}%`;
  if (Number.isFinite(ctx.tokens)) return `ctx ${statuslineFmtTok(ctx.tokens)}`;
  return '';
}

/**
 * ctx left Y/Z：剩余 / 窗口。占用优先级（必须与 usedPercent 同源，禁 lastUsage 单轮假 remaining）：
 * 1) totalTokens（SDK getContextUsage 全量）
 * 2) usedPercent×window（有 % 时；即使 tokens 非 0 也不信单轮 lastUsage）
 * 3) tokens（仅无 %：CLI total_input / 静态路径）
 * 4) 明确 0 占用 → left=window
 * 无 windowSize → ''。
 */
export function formatStatuslineCtxLeft(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const win = ctx.windowSize;
  if (!Number.isFinite(win) || win <= 0) return '';
  let used;
  if (Number.isFinite(ctx.totalTokens) && ctx.totalTokens > 0) used = ctx.totalTokens;
  else if (Number.isFinite(ctx.usedPercent) && ctx.usedPercent > 0) {
    used = Math.round(win * Math.min(100, Math.max(0, ctx.usedPercent)) / 100);
  } else if (Number.isFinite(ctx.tokens) && ctx.tokens > 0) used = ctx.tokens;
  else if (
    (Number.isFinite(ctx.totalTokens) && ctx.totalTokens === 0)
    || (Number.isFinite(ctx.usedPercent) && ctx.usedPercent === 0)
    || (Number.isFinite(ctx.tokens) && ctx.tokens === 0)
  ) {
    used = 0;
  } else {
    return '';
  }
  return `left ${statuslineFmtTok(Math.max(0, win - used))}/${statuslineFmtTok(win)}`;
}

/**
 * 折叠 summary：git · ctx；皆无时回落 'statusline'（CLI 不可用态由调用方另写）。
 */
export function formatStatuslineCollapsedSummary(p) {
  const parts = [];
  const git = formatStatuslineGitBrief(p?.git);
  const ctx = formatStatuslineCtxBrief(p?.ctx);
  if (git) parts.push(git);
  if (ctx) parts.push(ctx);
  return parts.length ? parts.join(' · ') : 'statusline';
}

/**
 * 点按复制用的多行纯文本（git/ctx/model/cost/sid/source…），便于粘到 issue。
 */
export function formatStatuslineCopyText(p) {
  if (!p || typeof p !== 'object') return '';
  const lines = [];
  const summary = formatStatuslineCollapsedSummary(p);
  if (summary && summary !== 'statusline') lines.push(summary);
  if (p.model) lines.push(`model ${p.model}`);
  if (p.effort) lines.push(`effort ${p.effort}`);
  if (p.project) lines.push(`project ${p.project}`);
  if (p.git?.repo) lines.push(`repo ${p.git.repo}`);
  if (Number.isFinite(p.cost)) lines.push(`est $${Number(p.cost).toFixed(2)}`);
  if (p.session?.id) lines.push(`sid ${p.session.id}`);
  if (p.source?.kind === 'cli') lines.push('source CLI');
  if (p.source?.kind === 'sdk') lines.push('source Web SDK');
  if (p.version) lines.push(`v${p.version}`);
  return lines.join('\n');
}

// Edit/MultiEdit 工具卡「预览变更」超过这么多行就不值得算 LCS——old/new_string 本是 Claude 挑的
// 紧凑定位锚点，正常几行到几十行；真撞到这个量级多半是异常输入，调用方应退回整块红/绿块渲染。
export const MAX_DIFF_LINES_FOR_LCS = 500;

// 行级 unified diff（经典 LCS 动态规划）：把 old_string/new_string 拆成逐行 "  同" / "- 删" / "+ 增"
// 前缀字符串数组，交给 git-changes.js renderPatchLines 复用着色（它认 +/-/@@ 行首前缀）。片段小
// （见上）：O(n·m) 无压力，不做 @@ 折叠——Edit 的 old/new 本就局部，摊开比猜"哪段能折叠"更可靠。
export function unifiedDiffLines(oldStr, newStr) {
  const oldS = String(oldStr ?? ''), newS = String(newStr ?? '');
  // 纯新增/纯删除单独短路：''.split('\n') 恒产出 [''] 一个"空行"，若落进下方通用 LCS 会多算出一条
  // 无对应内容的 - / + 行（渲染层显示成一条空白红/绿条）。只在恰好一侧整体为空串时短路——两侧都空
  // （degenerate 场景）、或只是尾部多个换行符（如 'a\nb' → 'a\nb\n'，newLines 是 ['a','b','']，
  // 长度>1 非整体空串）不受影响，仍走通用路径，那些情况的空行是真实变更、该显示。
  if (oldS === '' && newS !== '') return newS.split('\n').map(l => `+ ${l}`);
  if (newS === '' && oldS !== '') return oldS.split('\n').map(l => `- ${l}`);
  const oldLines = oldS.split('\n');
  const newLines = newS.split('\n');
  const n = oldLines.length, m = newLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push(`  ${oldLines[i]}`);
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${oldLines[i]}`);
      i++;
    } else {
      out.push(`+ ${newLines[j]}`);
      j++;
    }
  }
  while (i < n) { out.push(`- ${oldLines[i]}`); i++; }
  while (j < m) { out.push(`+ ${newLines[j]}`); j++; }
  return out;
}

// ---- P3 工作区抽屉：SWR 缓存保鲜 + 按目录局部重建 ----
// 断线重连 / 后台实例变化时，旧实现要么整段清空 sessionsCache（哪怕只有一个目录真变了），要么靠单一
// 全局 structKey 触发 openSessionPanel() 全量重建整个抽屉——即使用户只是切到后台又切回、数据其实没变，
// 也会"清空→骨架屏→等网络往返"，观感等同"重新拉了一遍数据"。以下两组纯函数把决策拆成两层，故意不
// 合并成一个函数（关注点不同：一个管缓存内容要不要重渲染，一个管要不要重建 DOM 子树）：
// ① session:list 响应内容签名比较；② 按目录分键的实例签名 diff。

// session:list 响应回来后，判断内容是否真的变了再决定要不要重渲染该目录的会话行列表——避免"缓存已
// 秒开正确内容→响应回来后又无条件整段重渲"的多余闪烁/重排。hasPrevEntry=false（此前无缓存，正显示
// 骨架屏）时恒需要渲染：骨架屏必须被替换，哪怕真实数据恰好是空列表。粒度：id+title(前 40 字)+
// lastUsedAt 足以代表用户会感知到的变化，不做深度字段比对；hasMore 单独比较（决定"显示全部"按钮的
// 出现/消失，不影响每一行的签名本身）。
export function shouldRerenderSessionList({ hasPrevEntry = false, prevSessions, prevHasMore = false, nextSessions, nextHasMore = false } = {}) {
  if (!hasPrevEntry) return true;
  if (!!prevHasMore !== !!nextHasMore) return true;
  // terminal 进签名：CLI 进程 busy/alive 状态或副文本变化必须重渲，否则抽屉会陈旧。
  const signature = list => (Array.isArray(list) ? list : [])
    .map(s => `${s?.id || ''}:${(s?.title || '').slice(0, 40)}:${s?.lastUsedAt || ''}:${s?.terminal || ''}`)
    .join('|');
  return signature(prevSessions) !== signature(nextSessions);
}

// 按目录分键的实例签名：每个 cwd 一段签名片段（id+sessionId+title 前 20 字拼接），代替原先"整个实例
// 集拼一个全局签名"的做法——粒度对齐原全局 structKey，只是从"任何一个实例变化都命中"改成"命中哪个
// 目录就只标记哪个目录"。状态字段（busy/idle/permission/error）故意不进签名，那些由 refreshDirBadges/
// refreshSessionStatusChips 独立、更轻量地实时刷新，不需要牵动 DOM 子树重建。
export function buildDirInstanceSignatures(instances = [], dirs = []) {
  const byDir = new Map();
  for (const d of (dirs || [])) byDir.set(d, []);
  for (const inst of (instances || [])) {
    if (!inst?.instanceId) continue;
    if (!byDir.has(inst.cwd)) byDir.set(inst.cwd, []);
    byDir.get(inst.cwd).push(`${inst.instanceId}:${inst.sessionId || ''}:${(inst.title || '').slice(0, 20)}`);
  }
  const out = {};
  for (const [d, frags] of byDir) out[d] = frags.join(',');
  return out;
}

// 比较前后两份"按目录分键的签名"，返回签名变化的 cwd 列表（升序排序，确定性）——调用方只需重建这些
// 目录的 DOM 子树，其余目录原样不动（不撤离滚动位置/侧滑态/"显示全部"展开态等本地态）。目录集合本身
// 变化（新增/删除工作区）、viewingInstanceId 变化两类"结构性"场景不经这个函数——调用方应直接全量
// 重建，不必对这两种低频场景做精细化 diff。
export function diffDirSignatures(prev = {}, next = {}) {
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  const changed = [];
  for (const k of keys) {
    if ((prev || {})[k] !== (next || {})[k]) changed.push(k);
  }
  return changed.sort();
}

// 发送前的网关后缀回贴。S5 原意：只对「不在 supportedModels 候选里的自设名」（如用户 /model 手设并
// 剥离了后缀的）补回网关后缀；候选内的值本就是网关合法完整名，原样发送。
// 回归（7febabc）：resolveSendModel 自那次改成返回 **wire**（entry.resolvedModel），而守卫仍只比
// m.value（档位别名）。wire 按设计就不等于任何条目的 value，于是 .some() 恒 false → 后缀必贴，
// 网关工作区里每一次显式选模型都送出 `grok-4.5[1m][1m]` 这种非法名，setModel 抛错或整轮 API 失败。
// 判据必须同时认 value 与 resolvedModel —— 两者都是「候选内的合法名」。
export function applyGatewaySuffix(model, gatewaySuffix = '', modelsList = []) {
  if (!model || !gatewaySuffix) return model;
  const list = Array.isArray(modelsList) ? modelsList : [];
  const known = list.some(m => (typeof m === 'string'
    ? m === model
    : m?.value === model || m?.resolvedModel === model));
  return known ? model : model + gatewaySuffix;
}

// ---- 消息流时间戳（稀疏式）：判定层 ----
// 三条数据源的时间形态不同——live 信封是 epoch ms（agent.js emit 的 ts），历史/镜像是 ISO 串
// （transcript 原样透传的 entry.timestamp）。归一在此收敛，调用方不必各自判类型。
// 拿不准一律返回 null：调用方据此「不打戳、不插行」，是安全退化而非报错。

// 时间戳归一。0 与负数一并视为无效——epoch 0 是 1970，在本项目语境里只可能是脏数据。
export function normalizeMessageTs(raw) {
  if (raw == null) return null;
  const ms = raw instanceof Date ? raw.getTime()
    : typeof raw === 'number' ? raw
      : typeof raw === 'string' ? Date.parse(raw)
        : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// 本地日历日相等。刻意不用 (a-b)<86400000：DST 切换日只有 23 或 25 小时，跨月/跨年也算不对。
export function isSameLocalDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear()
    && x.getMonth() === y.getMonth()
    && x.getDate() === y.getDate();
}

// 同批连续消息的默认「静默窗」：窗内不重复插时间行。
export const MESSAGE_TIME_GAP_MS = 5 * 60 * 1000;

// 要不要在这条消息之前插时间行、插哪种。返回 null = 不插。
//
// 【判定顺序即语义，不可调换】
//  2 先于 5：会话首条无条件给日期头，否则 fork 出来的、首条恰为 assistant 的会话整段没有日期归属。
//  3 先于 4：时钟回拨时宁可不插，也不能画出「今天」后面跟「昨天」这种自相矛盾的序列。
//  4 先于 5：跨天的日期行【不受 role 抑制】——否则「Claude 跨午夜回复 → 次日整段对话」全都归不到日子上。
//  5 先于 6：同轮抑制只掐 time 行。Claude 一个回合动辄十几分钟，若 role 无关则几乎每轮一行，
//           「稀疏」当场退化成「每条都显」。语义收敛为「你什么时候回来的」，只由用户发言触发。
//
// prevTs 取【上一条任意主链气泡的创建时刻】（不是上一条 user 的）。注意 assistant 气泡在本轮首个
// text_delta 到达时就建好了，所以它的时刻是回合【开头】而非结束——长回合下会比预期更常插行，
// 这是已知偏差（回写气泡时间戳需要额外状态，不划算）。
export function resolveMessageTimeMarker({ ts, prevTs = null, role, gapMs = MESSAGE_TIME_GAP_MS } = {}) {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (prevTs == null) return { kind: 'day', ts };
  if (ts < prevTs) return null;
  if (!isSameLocalDay(ts, prevTs)) return { kind: 'day', ts };
  if (role !== 'user') return null;
  return ts - prevTs >= gapMs ? { kind: 'time', ts } : null;
}

// ---- 消息流时间戳：格式化层 ----
// 刻意不用 Intl.DateTimeFormat / toLocaleDateString——输出随浏览器 ICU 版本漂移，断言会脆。
// 同款手搓先例见 serviceStatusBasicRows。英文月份是普通常量数组、不进 EN_DICT：
// i18n 门禁只扫「词典有、代码没有」的孤儿 key，把 12 个月份塞进词典反而全是孤儿。
const MONTH_ABBR_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = n => String(n).padStart(2, '0');

export function formatClockHm(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 「今天/昨天/更早」。昨天用 setDate(getDate()-1) 求，不用 now-86400000——
// 后者在 DST 切换日会错一天，也处理不了月初/年初回退。
export function formatCalendarDayLabel(ts, now) {
  if (isSameLocalDay(ts, now)) return t('今天');
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (isSameLocalDay(ts, y.getTime())) return t('昨天');

  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  if (getLang() === 'en') {
    const md = `${MONTH_ABBR_EN[d.getMonth()]} ${d.getDate()}`;
    return sameYear ? md : `${md}, ${d.getFullYear()}`;
  }
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return sameYear ? md : `${d.getFullYear()}年${md}`;
}

// marker → 可直接 textContent 的文案。day 行走微信形态单行「今天 09:00」。
// 若将来要「日期行只写日期、时间另起一行」，只改这里的模板串，判定层零改动。
export function formatMessageTimeMarker(marker, { now = Date.now() } = {}) {
  if (!marker?.kind) return '';
  const hm = formatClockHm(marker.ts);
  return marker.kind === 'day' ? `${formatCalendarDayLabel(marker.ts, now)} ${hm}` : hm;
}
