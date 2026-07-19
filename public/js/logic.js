// logic.js —— app.js 的纯决策逻辑。
// 红线：本文件只做数据→数据，不得 import / 触碰 DOM / window / socket / 任何全局可变状态。
// 目的：让 app.js（浏览器 import）与 tests/unit/logic.test.mjs（node:test）共用同一份逻辑，零依赖、零构建。

// HTML 转义。app.js 多处复用（审批命令、工具参数摘要）+ ansiToHtml 内部。
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 工具卡片摘要可读化：agent 侧 stringify 是紧凑单行，手机展开难读。
// 能 parse 的 JSON（对象/数组）→ 2 空格缩进；非 JSON / 截断残缺 / 空 → 原样（String 化）。
// 只做数据→数据，不碰 DOM/hljs（高亮由 app.js 渲染层复用现有 hljs）。
export function formatToolSummary(summary) {
  if (summary == null) return '';
  if (typeof summary !== 'string') return String(summary);
  const s = summary;
  if (!s) return '';
  const t = s.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return s;
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

// UX-018：模型磁贴 displayName 撞车时主标题回退 value，避免整排同名。
export function resolveModelTileDisplay(models) {
  const list = Array.isArray(models) ? models : [];
  const rows = list.map(m => {
    if (typeof m === 'string') {
      return { value: m, displayName: m, description: '', raw: m };
    }
    const value = m?.value != null ? String(m.value) : '';
    const displayName = (m?.displayName != null && String(m.displayName).trim())
      ? String(m.displayName).trim()
      : value;
    const description = m?.description != null ? String(m.description) : '';
    return { value, displayName, description, raw: m };
  });
  const counts = new Map();
  for (const r of rows) {
    const key = r.displayName || r.value;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return rows.map(r => {
    const key = r.displayName || r.value;
    const duplicate = (counts.get(key) || 0) > 1;
    const title = duplicate ? (r.value || r.displayName || 'model') : (r.displayName || r.value || 'model');
    const subtitle = r.description || r.value || '';
    return { value: r.value, title, subtitle, duplicate, raw: r.raw };
  });
}

// UX-020：同名附件序号；可选大小。
export function formatAttachmentChipLabel(name, occurrence = 1, sizeBytes) {
  const base = (name != null && String(name).trim()) ? String(name).trim() : '附件';
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
    low: '更快更省',
    medium: '均衡',
    med: '均衡',
    high: '更深入',
    xhigh: '很深入更慢',
    max: '最深入更慢更贵',
    ultracode: 'xhigh + 多 agent workflow · 最彻底',
  };
  return map[lv] || '';
}

// UX-010：镜像只读时不与本地忙碌条同现。
export function shouldShowBusyWithMirror({ mirrorReadonly = false, busy = false } = {}) {
  if (mirrorReadonly) return false;
  return Boolean(busy);
}

// 输入区主按钮：CLI 镜像只读 → 续接/取消续接；否则 busy 且无内容 → 停止；有内容时优先发送/排队（FE-004）。
// 审批/提问 sheet、输入禁用、queueFull、sendInFlight 仍按原闸挡发送；sheet 打开时不 morph 停止（中止走 sheet 逃生口）。
// mirrorReadonly 优先于 blockedByDisabledInput：镜像时 input 仍 disabled，但主按钮要可点「续接」。
export function resolveComposerPrimaryMode({
  busy = false,
  hasContent = false,
  interruptPending = false,
  queueFull = false,
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
        label: '取消',
        title: '取消排队中的续接，继续只读追平',
        ariaLabel: '取消续接',
      };
    }
    return {
      mode: 'resume',
      enabled: true,
      label: '续接',
      title: '续接 CLI 会话：运行中会排队等本轮结束，疑似中断需确认',
      ariaLabel: '续接 CLI 会话',
    };
  }
  if (blockedByUserRequest) {
    return {
      mode: 'send',
      enabled: false,
      title: '请先处理当前审批或选择',
      ariaLabel: '发送',
    };
  }
  if (blockedByDisabledInput) {
    return {
      mode: 'send',
      enabled: false,
      title: '请先完成设备授权或解除只读状态',
      ariaLabel: '发送',
    };
  }
  // busy 且输入空 → 停止（queueFull 不挡中止）
  if (busy && !hasContent) {
    if (interruptPending) {
      return {
        mode: 'stop',
        enabled: false,
        title: '正在停止…',
        ariaLabel: '正在停止',
      };
    }
    return {
      mode: 'stop',
      enabled: true,
      title: '停止',
      ariaLabel: '停止',
    };
  }
  // 发送路径（含 busy+有内容 排队）
  if (queueFull) {
    return {
      mode: 'send',
      enabled: false,
      title: '前面已有消息在排队，请等当前任务结束',
      ariaLabel: '发送',
    };
  }
  if (blockedBySendInFlight) {
    return {
      mode: 'send',
      enabled: false,
      title: '请稍候…',
      ariaLabel: '发送',
    };
  }
  if (hasContent) {
    return {
      mode: 'send',
      enabled: true,
      title: '',
      ariaLabel: '发送',
    };
  }
  return {
    mode: 'send',
    enabled: false,
    title: '',
    ariaLabel: '发送',
  };
}

// 排队可见性（对齐 CLI「Queued」态）：user_message.queued=true 的气泡挂排队标记，
// 本轮 result 到达时转正；被撤回/随停止取消时由 system{queue_cancelled/queue_dropped} 落终态。
export function queuedBubbleState({ queued = false } = {}) {
  if (!queued) return { show: false, label: '' };
  return { show: true, label: '⏳ 排队中 · 本轮结束后发送' };
}

// 撤回回填决策（对齐 CLI ESC 撤回→内容回编辑器）：输入框为空 → 直接回填；
// 已有未发内容 → 撤回文本置于其上（空行分隔）——零丢失、无隐藏暂存，比覆盖/丢弃都诚实。
export function resolveCancelRefill({ inputText = '', cancelledText = '' } = {}) {
  const cur = typeof inputText === 'string' ? inputText : '';
  const back = typeof cancelledText === 'string' ? cancelledText : '';
  if (!cur.trim()) return { mode: 'fill', value: back };
  return { mode: 'prepend', value: `${back}\n\n${cur}` };
}

// 流内 live 活动行兜底文案（不写 disk/history）。busy 主形态是 formatCliSpinnerLine 的 CLI 式
// spinner 行——对齐 CLI 不报具体工具（工具卡自会显示命令），故只剩 stopping/default 两种。
export function formatLiveActivityText(kind = 'default') {
  if (kind === 'stopping') return '正在停止…';
  return 'Claude 正在执行任务...';
}

// UX-010：横幅优先级仲裁（同屏最多一条）。
// bannerPriority = 任务约定名；pickBannerToShow 保留给已接线 app.js import。
export function bannerPriority({ mirror = false, task = false, subagent = false, activity = false } = {}) {
  if (mirror) return 'mirror';
  if (task) return 'task';
  if (subagent) return 'subagent';
  if (activity) return 'activity';
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
  const label = STATUS_ICON_LABELS[k] || STATUS_ICON_LABELS.pending;
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
  const cap = Math.max(8, Number(maxLen) || 48);
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
  const t = raw.trim();
  if (t[0] !== '{') return null;
  try {
    const parsed = JSON.parse(t);
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
      if (out.tasks.length === 0) return '（无任务）';
      return out.tasks.map(t => {
        const id = t?.id != null ? `#${t.id} ` : '';
        const subject = typeof t?.subject === 'string' ? t.subject : '';
        const blocked = Array.isArray(t?.blockedBy) && t.blockedBy.length
          ? `（被 ${t.blockedBy.map(b => `#${b}`).join(' ')} 阻塞）` : '';
        return `${taskStatusIcon(String(t?.status ?? 'pending'))} ${id}${subject}${blocked}`.trimEnd();
      }).join('\n');
    }
    if (outputSummary.trim() === 'No tasks found') return '（无任务）';
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
    return `☐ 已建任务 #${out.task.id}${subject}`;
  }
  if (name === 'TaskUpdate') {
    if (out.success === false) return `更新失败：${out.error || '未知原因'}`;
    if (out.taskId == null) return null;
    const sc = out.statusChange;
    if (sc?.from && sc?.to) return `${taskStatusIcon(sc.to)} #${out.taskId} ${sc.from} → ${sc.to}`;
    const fields = Array.isArray(out.updatedFields) && out.updatedFields.length
      ? `（${out.updatedFields.join(', ')}）` : '';
    return `#${out.taskId} 已更新${fields}`;
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

// 文件类工具卡片预览入口文案：Read 只读文件片段/图片，Edit/Write/… 才是 diff 变更。
// 后端 tool_use.file.changeKind 已区分（read|edit|write|multiedit|notebook）；changeKind 优先，name 兜底。
export function toolPreviewLabel(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const kind = m.changeKind != null ? String(m.changeKind) : '';
  const name = m.name != null ? String(m.name) : '';
  const isRead = kind === 'read' || (!kind && name === 'Read');
  return isRead ? '📄 预览文件' : '📄 预览变更';
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
    title: `已编辑 ${files.length} 个文件`,
    statsLabel: `+${added} -${removed}`,
  };
}

// ultracode = CLI /effort 菜单 xhigh 之上的最高档（= xhigh effort + dynamic workflow 编排）。
// SDK 的 effort flag 只认 low..max、不认 ultracode，故 web 借道「xhigh effort + 每轮注入本关键词」复现：
// 关键词触发 CLI 的 ultracodeKeywordTrigger → 该轮 opt into Workflow 工具。已有关键词时保持原文，避免叠加。
export function withUltracodeKeyword(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'ultracode';
  return /^ultracode(?:\s|$)/i.test(t) ? t : `ultracode ${t}`;
}

// 思考档位列表拼装：ultracode 仅在模型支持 xhigh 时作为最高档追加（CLI:"Requires an xhigh-capable model"）。
// 幂等——列表已含 ultracode 则不重复（防 rebuildEffortOptions 反复渲染叠加）。
export function withUltracodeTier(levels) {
  const arr = Array.isArray(levels) ? levels : [];
  if (!arr.includes('xhigh') || arr.includes('ultracode')) return arr;
  return [...arr, 'ultracode'];
}

// 选中思考档 → { effort, ultracode }：ultracode 档在 SDK 层不存在，借道 xhigh + 武装每轮关键词；
// 其余档原样发 effort（空/未选归 null=模型默认）、不武装。effort 值始终是后端白名单认得的合法值。
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

// effort 档位决策（rebuildEffortOptions 的纯部分；DOM 渲染留在 app.js）。返回 { hidden, levels }：
//   · 解析到模型且支持 effort → { hidden:false, levels: 该模型 supportedEffortLevels }
//   · 解析到但不支持（如 haiku）   → { hidden:true,  levels: [] }（app.js 隐藏整行）
//   · 解析不到（列表未到/桥接不上）→ { hidden:false, levels: 全候选 supportedEffortLevels 并集 }（CLI 全局集）
export function effortLevelsFor(modelValue, modelsList) {
  const entry = modelEntryFor(modelValue, modelsList);
  const levels = (entry && typeof entry === 'object' && Array.isArray(entry.supportedEffortLevels)) ? entry.supportedEffortLevels : null;
  if (entry && (!levels || !levels.length)) return { hidden: true, levels: [] }; // 明确不支持 effort
  const show = (levels && levels.length) ? levels
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
    label: normalized || (mirrorReadonly ? 'CLI 档位未知' : '默认思考'),
    placeholder: normalized
      ? `${normalized}（当前模型不可选）`
      : (mirrorReadonly ? 'CLI 当前档未知' : '模型默认'),
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

// per-cwd 状态聚合：该 cwd 各实例状态取最高优先级（permission>error>busy>aborted>done>idle；失败比在跑更需关注）。
// aborted（P1-4 已中止独立状态）介于 done 与 busy 之间：比顺利完成更值得回头看一眼（为什么被中止），但
// 已是终态，不该盖过仍在运行的其它会话。
export function aggregateStates(instances, dirs) {
  const rank = { idle: 0, done: 1, aborted: 2, busy: 3, error: 4, permission: 5 };
  const out = {};
  for (const d of (dirs || [])) out[d] = 'idle';
  for (const x of instances || []) {
    if (!(x.cwd in out)) out[x.cwd] = 'idle';
    if ((rank[x.state] ?? 0) > (rank[out[x.cwd]] ?? 0)) out[x.cwd] = x.state;
  }
  return out;
}

// 汇总「其他工作区」状态给左上角按钮角标：跨目录取最高优先级，返回单个 state（或 null=无动静）。
// 注意：这里 done>busy（完成=有结果待看，比在跑更该提示），与 aggregateStates 的 busy>done 有意不同——
// 那是 per-cwd 聚合、这是按钮汇总；且排除 currentCwd（当前工作区自身动静在聊天视图内呈现，不点亮汇总角标）。
export function summarizeOtherWorkspaces(workdirStates, availableDirs, currentCwd) {
  const rank = { busy: 1, done: 2, aborted: 3, error: 4, permission: 5 };
  let top = null, topRank = 0;
  for (const d of (availableDirs || [])) {
    if (d === currentCwd) continue;
    const st = workdirStates && workdirStates[d];
    if ((rank[st] || 0) > topRank) { topRank = rank[st]; top = st; }
  }
  return top; // 'permission'|'error'|'aborted'|'done'|'busy'|null
}

// 顶部/空状态展示名：路径仍作为运行时事实保留，移动端 UI 只露出项目末段。
export function projectDisplayName(path) {
  const s = String(path || '').replace(/\/+$/, '');
  if (!s) return '无项目';
  return s.split('/').pop() || '无项目';
}

// 空会话启动页只在没有可渲染会话流时出现：新建后尚未首发，或还没有 viewing instance。
export function shouldShowStartScreen({ viewingInstanceId, sessionId } = {}) {
  return !viewingInstanceId || !sessionId;
}

// 空表面形态：＋ / 🏠 分流。
//   none    = 已在真实会话（有 session 流），不渲染空态页
//   home    = 枢纽（最近工作区/会话），输入条隐藏
//   compose = 干净新会话页（工作区确认 + 默认档 + 示例 prompt），输入条显示
// 判定：先 shouldShowStartScreen；再看 composeReady（点 ＋ / session:new）。
export function resolveEmptySurface({ viewingInstanceId, sessionId, composeReady = false } = {}) {
  if (!shouldShowStartScreen({ viewingInstanceId, sessionId })) return 'none';
  return composeReady ? 'compose' : 'home';
}

// 新会话页「本工作区将开 CLI 用的默认档」摘要。读前端已同步的 pill 文案（L0>L3>L4）。
// 空/空白项跳过；全空回落固定文案（scout/defaults 未到时仍有可读提示）。
export function formatComposeDefaultsSummary({ modelLabel, modeLabel, effortLabel } = {}) {
  const parts = [modelLabel, modeLabel, effortLabel]
    .map(s => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : '使用工作区默认配置';
}

// 顶部工作区 pill（点开文件浏览）可见性：空首页/compose 枢纽已自有工作区入口，
// 顶栏再放文件夹会重复且暗示「当前在会话里」。仅在有可渲染会话流时显示。
export function shouldShowTopContextPill({ viewingInstanceId, sessionId } = {}) {
  return !shouldShowStartScreen({ viewingInstanceId, sessionId });
}

// 底部输入条（composer）可见性：空首页枢纽只做「选工作区/会话」，不提供直接发消息入口——
// 避免未选项目就打字、懒开新会话的歧义路径。显示条件：
//   · 已进入可渲染会话（有 sessionId）
//   · 或用户刚点 ＋ / session:new 进入 compose 就绪空窗（composeReady）
//   · 或新会话首发在途（pendingFirstSend：懒开瞬间 sid 仍空，不能闪藏输入区）
// 与 shouldShowStartScreen 正交：composeReady 时 resolveEmptySurface='compose'（干净新会话页 + 输入条）。
export function shouldShowComposer({ viewingInstanceId, sessionId, composeReady = false, pendingFirstSend = false } = {}) {
  if (sessionId) return true;
  if (pendingFirstSend) return true;
  if (composeReady) return true;
  // viewingInstanceId 有无都不改变「无 sid 且未 compose」→ 隐藏
  void viewingInstanceId;
  return false;
}

// 空首页「最近活跃」：把各 workdir 的 session:list 结果摊平，按 lastUsedAt 降序取 topN。
// 每条附 cwd + workspaceName，前端可一键 session:switch 跨工作区，不必先开侧栏目录树。
// dirLists: Array<{ cwd, sessions: Array<{ id, title, lastUsedAt, ... }> }>
// 无 id 的行跳过；缺 lastUsedAt 的排最后（仍可点开）；非法 limit 回落默认 8。
export function mergeRecentSessionsAcrossWorkspaces(dirLists, { limit = 8 } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 8;
  const rows = [];
  for (const entry of Array.isArray(dirLists) ? dirLists : []) {
    if (!entry || typeof entry.cwd !== 'string' || !entry.cwd) continue;
    const cwd = entry.cwd;
    const workspaceName = projectDisplayName(cwd);
    const sessions = Array.isArray(entry.sessions) ? entry.sessions : [];
    for (const s of sessions) {
      if (!s || typeof s.id !== 'string' || !s.id) continue;
      rows.push({
        id: s.id,
        title: s.title || '无标题会话',
        lastUsedAt: s.lastUsedAt ?? null,
        cwd,
        workspaceName,
        entrypoint: s.entrypoint ?? null,
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
//    发送窗口内 pendingSendBusy + prevSessionId===sessionId 才补，避免把 A 的发送态挂到 B。
export function shouldRestoreOptimisticBusy({
  pendingFirstSend,
  pendingSendBusy,
  viewingInstanceId,
  sessionId,
  prevSessionId,
} = {}) {
  if (!viewingInstanceId) return false;
  // 新会话首发：无 sessionId 的懒开实例
  if (pendingFirstSend && !sessionId) return true;
  // 同会话静默换实例：发送已发出、sessionId 前后一致且非空
  if (pendingSendBusy && sessionId && sessionId === prevSessionId) return true;
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
      message: '',
    };
  }
  const error = (ack && typeof ack.error === 'string' && ack.error.trim())
    ? ack.error.trim()
    : '发送失败';
  const permanent = Boolean(ack?.permanent);
  const retryable = Boolean(ack?.retryable) || (!permanent && !ack?.stale);
  const stale = Boolean(ack?.stale);
  let message = error;
  if (error === 'stale_instance' || stale) {
    message = '目标会话已关闭，请刷新后重发';
  } else if (!message.startsWith('发送') && !message.includes('失败')) {
    message = `发送失败：${message}`;
  }
  return {
    ok: false,
    clearBusy: true,
    restoreDraft: true,
    retryable,
    permanent,
    stale,
    message,
  };
}

// 离线队列单条重发 ack 决策（FE-NEW-001）。与在线不同：不恢复草稿（气泡已在消息流）、
// permanent 必停重试；timeout/err 与非 permanent 负 ack 一律 requeue。
// outcome: 'ok' | 'permanent' | 'requeue'
export function presentOfflineResendAck(err, ack) {
  if (!err && ack && ack.ok === true) {
    return { outcome: 'ok', permanent: false, requeue: false, clearBusyIfViewing: false, message: '' };
  }
  if (!err && ack && ack.ok === false && ack.permanent) {
    const error = (typeof ack.error === 'string' && ack.error.trim()) ? ack.error.trim() : '发送失败';
    return { outcome: 'permanent', permanent: true, requeue: false, clearBusyIfViewing: true, message: error };
  }
  // 超时 / 可重试失败 / 畸形 ack
  return {
    outcome: 'requeue',
    permanent: false,
    requeue: true,
    clearBusyIfViewing: false,
    message: err ? '未确认送达' : ((ack && typeof ack.error === 'string' && ack.error.trim()) || '发送失败'),
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

// sync:since 的 ack 回调决策（probe 与普通 connect 路径共用）：
//   err（探测 timeout，仅 probe 路径会有）→ 'reconnect'：判定半开死连接，强制 disconnect+connect 触发干净重连；
//   res.found===false（实例已 dispose/重启/effort 换 id 没了）→ 'reload'：清屏重载历史（connect 路径不先 clearView，
//     无法靠 replayed 自辨「实例没了」与「实例还在只是无新事件」，靠 found 区分）；
//   其余（有回放 / 无新事件 / 实例还在）→ 'none'：交给正常 agent:event 经 epoch/seq 去重增量渲染。
// 普通 connect 路径无 timeout、err 恒 null → 不会误判 reconnect。
export function syncAckAction(err, res) {
  if (err) return 'reconnect';
  if (res && res.found === false) return 'reload';
  if (res && res.gap) return 'reload'; // 缓冲超窗、中间有缺口 → 清屏全量重载历史，否则残缺需手刷
  return 'none';
}

// 切视图入场（bindView 的 sync:since ack 回调）该拿什么当渲染真相：活缓冲/DOM 缓存 vs 磁盘 history 全量重载。
// 与 syncAckAction 分工不同——那是「重连/probe」路径（connect 后补发），这是「切视图入场」路径（bindView 独立决策）。
// 要害盲区①：CLI 在终端外部 `--resume` 写盘的消息【不经过】web 这个 SDK 实例的活缓冲，只落磁盘 transcript。
// 若 web 离开期间被外部写过，切回时 replayed=0（活缓冲无那些消息）却 hasCache=true（有旧 DOM 缓存）——
// 旧逻辑信缓存不拉盘 → 永远看不到外部写入。故此处比对 server 报的磁盘 history 条数 diskLen 与前端上次为该
// 会话渲染到的 seenDiskLen：磁盘更长 = 被外部写过 = 当作一种 gap，清屏全量重载磁盘（唯一真相源、清屏天然无重复）。
// 要害盲区②（PWA 下拉刷新 / 整页 reload）：sessionDomCache 是内存态，硬刷新后 hasCache=false；server 实例仍在，
// sync:since(0) 回放环形缓冲（BUFFER_CAP=500 事件）。旧逻辑见 replayed>0 就 keep → 永远不拉 session:history，
// 只剩缓冲里能拼出的最近一两轮（流式 text_delta 很快填满 500 槽；且 gap 要求 lastSeq>0，硬刷新 lastSeq=0 永远
// 判不出缺口）。故「无 DOM 缓存」必须优先走磁盘全量——有缓冲回放过时用 reload（先清再装，避免缓冲片段叠历史）。
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
export function shouldReloadOnEnter({ replayed, gap, hasCache, diskLen = 0, seenDiskLen = 0 } = {}) {
  if (gap) return 'reload';
  // 冷入场（整页刷新/无 DOM 缓存）优先于「有缓冲就 keep」——缓冲只保最近事件，不是全量历史。
  if (!hasCache) return (replayed > 0) ? 'reload' : 'load';
  if (replayed > 0) return 'keep';
  if (diskLen > seenDiskLen) return 'reload';
  return 'keep';
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
    return { title: '默认模型', subtitle: naked, showsName: true };
  }
  return { title: '沿用当前模型', subtitle: '不指定特定模型', showsName: false };
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
        summary: n.title || n.toolName || n.reason || '需要你',
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
          summary: inst.title || '待审批',
        });
      }
    }
  }
  if (service && service.deliveryFailure && typeof service.deliveryFailure === 'object') {
    const df = service.deliveryFailure;
    items.push({
      kind: 'delivery_failure',
      ref: df.channel || null,
      summary: `推送失败（${df.channel || 'push'}）`,
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
  const live = Array.isArray(instances) && instances.some(i => i && i.instanceId === target.instanceId);
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
export function presentTurnResult(payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const durationMs = typeof p.durationMs === 'number' ? p.durationMs : 0;
  const cost = typeof p.costUsd === 'number' ? ` · $${p.costUsd.toFixed(4)}` : '';
  const secs = (durationMs / 1000).toFixed(1);
  const errorText = Array.isArray(p.errors) ? p.errors.filter(Boolean).join('; ') : '';

  if (p.interrupted) {
    return {
      kind: 'aborted',
      statusBar: { text: `已中止 · ${secs}s${cost}`, cls: 'text-ink-faint' },
      errorBar: null,
      notify: { title: '⏹ 任务已中止', body: `用时 ${secs}s` },
      failToolsMessage: '已中止',
      haptic: 'warning',
    };
  }
  if (p.isError) {
    return {
      kind: 'error',
      statusBar: { text: `完成 · ${secs}s${cost}`, cls: 'text-ink-faint' },
      errorBar: errorText ? { text: `出错：${errorText}`, cls: 'text-danger' } : null,
      notify: { title: '⚠️ 任务出错', body: errorText.slice(0, 80) || `用时 ${secs}s` },
      failToolsMessage: errorText || '工具执行已因本轮错误停止',
      haptic: 'error',
    };
  }
  return {
    kind: 'success',
    statusBar: { text: `完成 · ${secs}s${cost}`, cls: 'text-ink-faint' },
    errorBar: null,
    notify: { title: '✅ 任务完成', body: `用时 ${secs}s` },
    failToolsMessage: null,
    haptic: 'success',
  };
}

// CLI "Retrying in 4s · attempt 2/10" 的 web 横幅文案。字段来自 SDK system/api_retry 经 agent 归一后的 payload。
export function formatApiRetryBanner(payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const attempt = Number(p.attempt);
  const maxRetries = Number(p.maxRetries ?? p.max_retries);
  const delayMs = Number(p.delayMs ?? p.retry_delay_ms);
  const hasAttempt = Number.isFinite(attempt) && attempt > 0;
  const hasMax = Number.isFinite(maxRetries) && maxRetries > 0;
  const secs = Number.isFinite(delayMs) && delayMs > 0 ? Math.ceil(delayMs / 1000) : 0;
  const err = typeof p.error === 'string' ? p.error : '';
  const kind = err === 'rate_limit' ? '限流重试中' : err === 'overloaded' ? '过载重试中' : '重试中';
  const frac = hasAttempt && hasMax ? ` · ${attempt}/${maxRetries}` : (hasAttempt ? ` · 第 ${attempt} 次` : '');
  const wait = secs > 0 ? ` · ${secs}s 后` : '';
  return `${kind}${frac}${wait}`;
}

// 服务状态可见性（见 docs/design.md「用户可观察状态」）：与"需要你(N)"聚合（会话待处理，
// 论证依据=注意力不对称）是不同的轴——这里只答"ccm 这个服务本身有没有出过岔子"（NFR-15，论证依据=可维护性），
// 不复用/不混入会话状态判定。每设备独立感知：本地 localStorage 存上次已知的服务启动时刻，与服务端下发的
// 当前启动时刻对比，不同即服务重启过（LaunchAgent 静默拉起/意外崩溃恢复），当前设备此前不知情。
export function detectServiceRestart({ startedAt, lastSeenStartedAt } = {}) {
  const valid = typeof startedAt === 'number' && Number.isFinite(startedAt);
  if (!valid) return { changed: false, nextStartedAt: lastSeenStartedAt ?? null }; // 防御：坏数据不覆盖已有基线
  if (lastSeenStartedAt == null) return { changed: false, nextStartedAt: startedAt }; // 首次见到，只建基线不告警
  return { changed: startedAt !== lastSeenStartedAt, nextStartedAt: startedAt };
}

function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 60000) return '刚刚';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

// 组装会话面板"服务"小节文案（需要你之后、目录列表之前，仅异常时渲染）。空数组=一切正常。
// 判定化告警四类，固定顺序：重启 → 限速锁定(⛔ 安全信号) → 投递失败(🔔) → 前端错误(🐞)。
// 各类均由服务端时效窗判定（超窗自动退场，见 metrics.js recentIncident/recentDeliveryFailure）；
// 旧 server 无新字段 → 优雅缺席。刻意不吞并/复用"需要你(N)"聚合的展示逻辑——
// 两条轴分开陈列，不让服务健康看起来像"更多同类待办"。
export function formatServiceNotices({ service, restartChanged, now } = {}) {
  const notices = [];
  if (restartChanged) {
    notices.push('🔄 服务自上次连接后已重启，请确认之前任务是否正常完成');
  }
  const countSuffix = c => (Number.isFinite(c) && c > 0 ? `（累计 ${c} 次）` : '');
  const lockout = service && service.rateLimitLockout;
  if (lockout && typeof lockout.at === 'number') {
    notices.push(`⛔ 登录限速锁定于 ${formatAgo(now - lockout.at)}${countSuffix(lockout.count)}——可能有人在暴力尝试你的入口`);
  }
  const df = service && service.deliveryFailure;
  if (df && typeof df.at === 'number') {
    const channelLabel = df.channel === 'ntfy' ? 'ntfy' : 'push';
    const cnt = Number.isFinite(df.count) && df.count > 0 ? `，累计 ${df.count} 次` : '';
    notices.push(`🔔 推送最近失败于 ${formatAgo(now - df.at)}（${channelLabel}${cnt}）`);
  }
  const ce = service && service.clientError;
  if (ce && typeof ce.at === 'number') {
    notices.push(`🐞 前端错误发生于 ${formatAgo(now - ce.at)}${countSuffix(ce.count)}，详见日志面板`);
  }
  return notices;
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
  if (!msg && typeof taskId === 'string' && taskId && !taskId.startsWith('__notask_')) {
    msg = taskId.slice(0, 12);
  }
  if (!msg) msg = '后台任务';
  // 洗掉「Search: search:」类重复段（workflow 阶段名 + last_tool 同词）
  msg = msg.replace(/^([A-Za-z一-鿿]{2,24})\s*[:：]\s*\1\s*[:：]\s*/i, '$1：');
  const t = taskType != null ? String(taskType).trim() : '';
  if (t === 'local_agent' || t === 'agent') {
    if (/^🤖/.test(msg)) return msg;
    if (/^[^\s：:]{2,40}[：:]/.test(msg)) return `🤖 ${msg}`;
    return `🤖 ${msg}`;
  }
  if (t === 'local_bash' || t === 'bash') {
    return msg.startsWith('🖥') ? msg : `🖥 ${msg}`;
  }
  return msg;
}

// 子 agent 可折叠卡片标题（默认收起；机主选「可折叠卡片」形态）。
// running=true → 运行中；false → 已完成（主 Agent tool_result 或本轮 result 收束）。
// 类型缺失时兜底「子 agent」（stream_event 首批 delta 可能早于带 subagent_type 的 assistant）。
export function formatSubagentCardTitle({ subagentType, running = true } = {}) {
  const raw = subagentType != null ? String(subagentType).trim() : '';
  const type = raw || '子 agent';
  return running ? `🤖 ${type} 运行中` : `🤖 ${type} 已完成`;
}

// 工具摘要是否已被 agent/history 截断（口径：尾缀「 …（已截断）」——见 agent.js truncate）。
// 前端据此显「展开全文」；payload.truncated 优先（布尔），缺省时嗅探摘要串。
export function isToolSummaryTruncated(summary, { truncated } = {}) {
  if (truncated === true) return true;
  if (truncated === false) return false;
  return typeof summary === 'string' && summary.includes('…（已截断）');
}

// 只读镜像锁横幅文案（三态：armed / stale / driving）。
// 主操作在发送钮位「续接 CLI 会话」；横幅只报状态。自动解锁仍由服务端 ~12.5s 静默负责，不写假精密倒计时。
export function formatMirrorBannerText({ armed = false, stale = false } = {}) {
  if (armed) return '已请求续接，等待终端当前操作完成…';
  if (stale) return '终端疑似中断（超 5 分钟无活动）——确认已停可续接';
  return '终端会话运行中，移动端当前只读';
}

// 驾驶中点输入区/附件时的可操作说明（比横幅短句更完整：能/不能/硬要怎么做）。
// 主操作指向发送钮位「续接」。单行 · 分隔：addBar 用 textContent，无 pre-wrap。
export function formatMirrorComposerHint({ armed = false, stale = false } = {}) {
  if (armed) return '已请求续接：等终端当前操作完成后自动可写。可点「取消续接」撤销。';
  if (stale) return '终端疑似中断。确认终端已停后点「续接」即可在手机继续。';
  return '终端会话运行中，移动端当前只读 · 不能：打字/发图/改模型权限思考 · 能：看消息、等终端静默后自动可写 · 硬要手机继续：点右侧「续接」（等本轮结束再放行；疑似中断可立即续接，有分叉风险）';
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
export function shouldResetMirrorOnViewChange({
  prevViewing = null,
  nextViewing = null,
  prevCwd = null,
  nextCwd = null,
  cwdSeen = false,
} = {}) {
  if (prevViewing !== nextViewing) return true;
  if (cwdSeen && nextCwd && prevCwd && nextCwd !== prevCwd) return true;
  return false;
}

// 后台任务停止按钮态：有非空 taskId 且横幅可见才可点（对齐 SDK stopTask(taskId)）。
export function taskStopUiState({ taskId, bannerVisible = true } = {}) {
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  return { canStop: Boolean(id) && bannerVisible !== false, taskId: id || null };
}

// CLI 式 spinner 动词表：逐字提取自本机 claude CLI bundle（2.1.211）的本地词表，保终端等价性。
export const SPINNER_VERBS = Object.freeze(['Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking', 'Beaming', "Beboppin'", 'Befuddling', 'Billowing', 'Blanching', 'Bloviating', 'Boogieing', 'Boondoggling', 'Booping', 'Bootstrapping', 'Brewing', 'Bunning', 'Burrowing', 'Calculating', 'Canoodling', 'Caramelizing', 'Cascading', 'Catapulting', 'Cerebrating', 'Channeling', 'Channelling', 'Choreographing', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Combobulating', 'Composing', 'Computing', 'Concocting', 'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Crystallizing', 'Cultivating', 'Deciphering', 'Deliberating', 'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing', 'Doodling', 'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing', 'Enchanting', 'Envisioning', 'Fermenting', 'Fiddle-faddling', 'Finagling', 'Flambéing', 'Flibbertigibbeting', 'Flowing', 'Flummoxing', 'Fluttering', 'Forging', 'Forming', 'Frolicking', 'Frosting', 'Gallivanting', 'Galloping', 'Garnishing', 'Generating', 'Gesticulating', 'Germinating', 'Gitifying', 'Grooving', 'Gusting', 'Harmonizing', 'Hashing', 'Hatching', 'Herding', 'Honking', 'Hullaballooing', 'Hyperspacing', 'Ideating', 'Imagining', 'Improvising', 'Incubating', 'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning', 'Kneading', 'Leavening', 'Levitating', 'Lollygagging', 'Manifesting', 'Marinating', 'Meandering', 'Metamorphosing', 'Misting', 'Moonwalking', 'Moseying', 'Mulling', 'Mustering', 'Musing', 'Nebulizing', 'Nesting', 'Newspapering', 'Noodling', 'Nucleating', 'Orbiting', 'Orchestrating', 'Osmosing', 'Perambulating', 'Percolating', 'Perusing', 'Philosophising', 'Photosynthesizing', 'Pollinating', 'Pondering', 'Pontificating', 'Pouncing', 'Precipitating', 'Prestidigitating', 'Processing', 'Proofing', 'Propagating', 'Puttering', 'Puzzling', 'Quantumizing', 'Razzle-dazzling', 'Razzmatazzing', 'Recombobulating', 'Reticulating', 'Roosting', 'Ruminating', 'Sautéing', 'Scampering', 'Schlepping', 'Scurrying', 'Seasoning', 'Shenaniganing', 'Shimmying', 'Simmering', 'Skedaddling', 'Sketching', 'Slithering', 'Smooshing', 'Sock-hopping', 'Spelunking', 'Spinning', 'Sprouting', 'Stewing', 'Sublimating', 'Swirling', 'Swooping', 'Symbioting', 'Synthesizing', 'Tempering', 'Thinking', 'Thundering', 'Tinkering', 'Tomfoolering', 'Topsy-turvying', 'Transfiguring', 'Transmuting', 'Twisting', 'Undulating', 'Unfurling', 'Unravelling', 'Vibing', 'Waddling', 'Wandering', 'Warping', 'Whatchamacalliting', 'Whirlpooling', 'Whirring', 'Whisking', 'Wibbling', 'Working', 'Wrangling', 'Zesting', 'Zigzagging']);

export function pickSpinnerVerb(rand = Math.random) {
  return SPINNER_VERBS[Math.floor(rand() * SPINNER_VERBS.length)] || 'Working';
}

// CLI 式动态状态行组装：✻ Stewing… (55s · ↓ 3.3k tokens · thought for 1s)
// thinking = null | { state: 'active'|'done', ms }；outTokens 空/0 省段。
// 对齐 CLI 不挂工具后缀段——正在执行的命令由消息流里的工具卡显示，此行只保动词+秒表+tokens+thinking。
export function formatCliSpinnerLine({
  verb = '',
  elapsedSec = 0,
  outTokens = null,
  thinking = null,
  effort = null,
  glyph = '✻',
} = {}) {
  const v = String(verb || '').trim() || 'Working';
  const fmtTok = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const segs = [`${Math.max(0, Math.floor(Number(elapsedSec) || 0))}s`];
  if (Number.isFinite(outTokens) && outTokens > 0) segs.push(`↓ ${fmtTok(outTokens)} tokens`);
  if (thinking?.state === 'active') {
    segs.push(effort ? `thinking with ${effort} effort` : 'thinking…');
  } else if (thinking?.state === 'done') {
    segs.push(`thought for ${Math.max(1, Math.round((thinking.ms || 0) / 1000))}s`);
  }
  return `${glyph} ${v}… (${segs.join(' · ')})`;
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
  if (secs < 60) return `${secs} 秒`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时 ${mins % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

// 基础段四行。versions 缺失字段显 unknown（升级半途/旧 server 也能渲染）；
// 连接行的延迟复用 formatRttMs（非法→'' 时只显「已连接」，不残留陈旧数字）。
export function serviceStatusBasicRows({ startedAt, versions, connected, rttMs, now, logging } = {}) {
  const startedValid = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0;
  const uptime = startedValid ? formatUptime(now - startedAt) : '';
  let startedLabel = '未知';
  if (startedValid) {
    const d = new Date(startedAt);
    const two = n => String(n).padStart(2, '0');
    startedLabel = `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
  }
  const v = versions && typeof versions === 'object' ? versions : {};
  const pick = key => (typeof v[key] === 'string' && v[key] ? v[key] : 'unknown');
  const rtt = formatRttMs(rttMs);
  const rows = [
    { label: '运行时长', value: uptime || '未知' },
    { label: '启动于', value: startedLabel },
    { label: '版本', value: `server ${pick('server')} · CLI ${pick('cli')} · SDK ${pick('sdk')}` },
    { label: '连接', value: connected ? `已连接${rtt ? ` · 延迟 ${rtt}` : ''}` : '未连接' },
  ];
  // 日志开关可见性：DEBUG_SDK_MESSAGES 曾长开半月把日志刷到 149M，此前没有任何界面能看到
  // "调试开关开着"这个事实。sdkDebug 开着标 alert（接线层标黄）；旧 server ack 无 logging → 优雅缺席。
  if (logging && typeof logging === 'object') {
    const sw = v => (v ? '开' : '关');
    rows.push({
      label: '日志开关',
      value: `交互日志 ${sw(logging.interactions)} · SDK 调试 ${sw(logging.sdkDebug)} · stderr ${sw(logging.stderr)}`,
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
    message: clampStr(String(message ?? ''), CLIENT_ERROR_CAPS.message) || '(无错误信息)',
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
    const t = e?.ts ? new Date(e.ts).toLocaleTimeString() : '';
    const type = String(e?.type ?? '').replace(/^client_/, '');
    return `[${t}] ${type} ${e?.text ?? ''}`.trim();
  }).join('\n');
}

// 本次会话分隔线判定：合并按 ts 升序=恢复段(上次会话)在前、本次在后；在恢复段末尾→本次开头的
// 交界处（前条 restored、当前非 restored）画一次「—— 本次会话 ——」。全本次或全恢复都不画。
export function isRestoredBoundary(prevEntry, entry) {
  return !!prevEntry?.restored && !entry?.restored;
}
