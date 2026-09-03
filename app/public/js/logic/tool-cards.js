// logic/tool-cards.js —— 工具摘要与卡片标题 · Task 工具 · 文件变更统计 · 子 agent 判定
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t } from '../i18n.js';
import { isSyntheticTaskId } from './bg-tasks.js';

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
// 折中为流内特化渲染：标题去 JSON 噪音、结果显 ☐/◐/☒ 清单（维护者 7/17 拍板）。
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

// 子 agent 可折叠卡片标题（默认收起；维护者选定「可折叠卡片」形态）。
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
