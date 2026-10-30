// 诊断日志抽屉（顶栏 🖥 与「排查」页的「会话日志」共用的那张 sheet）：开合、筛选、复制、拉服务端日志与实时追加。
// #359 Step 1 从 app.js 原样迁出；app.js 里跨模块的可变态（viewingInstanceId、general、modelsList）经 getter 注入。

import { consoleLogEntryLayout, filterConsoleEntries, formatDiagLogEntry, formatLogsForCopy, isRestoredBoundary, logEntryVisibleForInstance, resolveGatewayModelName, shouldStickScrollToBottom } from '../logic.js';
import { t } from '../i18n.js';

export function createConsoleModal(context, {
  $, btnConsole, clientLogger, closeSheet, consoleClear, consoleClose, consoleFilterButtons, consoleLogArea,
  consoleModal, copyText, openSheet, reopenGeneralAt, setGestureDismiss, socket, getGeneral, getModelsList,
  getViewingInstanceId,
} = {}) {
  // 这张抽屉有两个来源：顶栏 🖥（直接开在聊天页上，关掉就该回聊天页）与「排查」页的「会话日志」
  // （开之前收了设置 sheet，关掉要把人送回那一页）。null = 不是从设置切进来的。
  // 三条关法（✕ / 点遮罩 / 再点顶栏按钮）必须走同一个函数：同一张面板两种关法落到两个地方，
  // 正是这个仓库踩过不止一次的坑。
  let consoleFrom = null;
  function openConsole({ from = null } = {}) {
    if (!consoleModal) return;
    consoleFrom = from;
    if (from) getGeneral().close(); // 设置 sheet 与本抽屉同 z-40，叠着会互相拦点击
    openSheet(consoleModal);
    loadConsoleLogs();
  }
  function closeConsole() {
    if (consoleModal) closeSheet(consoleModal);
    if (!consoleFrom) return;
    const back = consoleFrom;
    consoleFrom = null;
    reopenGeneralAt(back);
  }
  // #399 / #425：把手下拉与 ✕ / 遮罩同一条 closeConsole（含从排查页退回设置）
  setGestureDismiss(consoleModal, () => closeConsole());

  if (btnConsole) {
    btnConsole.onclick = () => {
      if (!consoleModal) return;
      if (consoleModal.classList.contains('sheet-open')) closeConsole();
      else openConsole();
    };
  }
  // 「排查」页的会话日志入口：内容与顶栏那张是同一张抽屉，不另建一套渲染。
  if ($('btnDiagSessionLog')) $('btnDiagSessionLog').onclick = () => openConsole({ from: 'diag' });

  if (consoleClose) consoleClose.onclick = closeConsole;

  if (consoleModal) {
    consoleModal.onclick = (e) => {
      if (e.target === consoleModal) closeConsole();
    };
  }

  if (consoleClear) {
    consoleClear.onclick = () => {
      clientLogger.clear(); // 清内存缓冲 + 落盘空缓冲（否则重开又恢复已清的旧条目）
      lastRenderedLogs = [];
      if (consoleLogArea) consoleLogArea.innerHTML = '';
    };
  }

  // 全部/交互/诊断 过滤：切换态 + 高亮当前按钮 + 本地重渲（数据已在服务端拉取过，无需重新请求）。
  function updateConsoleFilterButtons() {
    for (const btn of consoleFilterButtons) {
      const active = btn.dataset.filter === consoleFilter;
      // #368：过滤钮高亮用 --console-*，不用 Tailwind gray
      btn.classList.toggle('bg-console-sunk', active);
      btn.classList.toggle('text-console-ink', active);
      btn.classList.toggle('text-console-ink-faint', !active);
    }
  }
  for (const btn of consoleFilterButtons) {
    btn.onclick = () => {
      if (btn.dataset.filter === consoleFilter) return;
      consoleFilter = btn.dataset.filter;
      updateConsoleFilterButtons();
      loadConsoleLogs();
    };
  }

  // 「复制全部」：把当前抽屉可见日志拼成多行文本，发给电脑 / 贴给 Claude 排障——手机端唯一带走途径。
  const consoleCopy = $('consoleCopy');
  if (consoleCopy) {
    consoleCopy.onclick = async () => {
      const text = formatLogsForCopy(lastRenderedLogs);
      if (!text) return;
      const ok = await copyText(text);
      const orig = consoleCopy.textContent;
      consoleCopy.textContent = ok ? t('已复制') : t('复制失败');
      setTimeout(() => { consoleCopy.textContent = orig; }, 1500);
    };
  }

  function loadConsoleLogs(id) {
    const instId = id || getViewingInstanceId();
    if (!instId) {
      // 首页无选中实例：服务端日志按实例隔离故无从拉，但连接级(client_conn)日志无工作区归属、恒显——
      // 仍渲染它们，否则首页打开日志抽屉一片空白、断连/重连痕迹全丢（logEntryVisibleForInstance 对 client_conn 恒 true）。
      if (consoleLogArea) {
        consoleLogArea.innerHTML = '';
        renderLogList(filterConsoleEntries(clientLogger.entries().filter(e => logEntryVisibleForInstance(e, null)), consoleFilter));
      }
      return;
    }
    socket.emit('logs:get', { instanceId: instId }, (res) => {
      if (!consoleLogArea) return;
      // WS-019：迟到 ACK 守卫——发起后若已切到别的实例，丢弃本回调。否则 A 的日志回包会清空并覆盖共享的
      // consoleLogArea（当前显示 B 的日志）。仅调试抽屉、只读、下次打开自愈，但迟到覆盖仍是可见错乱。
      if (getViewingInstanceId() !== instId) return;
      consoleLogArea.innerHTML = '';
      let mergedLogs = [];
      if (res && Array.isArray(res.logs)) {
        mergedLogs = [...res.logs];
      }
      // 诊断时间线（镜像/排队/停止）：原始 {ts,subsystem,event,detail} 经 formatDiagLogEntry 译成
      // 判定过的一句话，与交互日志同一时间线合并展示，靠 diag_ 前缀 type 供过滤/着色区分。
      if (res && Array.isArray(res.diagLogs)) {
        mergedLogs = mergedLogs.concat(res.diagLogs.map(formatDiagLogEntry));
      }
      // 只合并属于本实例(或连接级恒显)的 client 日志——修切工作区残留上个区日志（clientLogBuffer 全局无隔离）。
      // 服务端日志(res.logs)已按 sessionId 隔离、无 instanceId 字段，不经此过滤。
      mergedLogs = mergedLogs.concat(clientLogger.entries().filter(e => logEntryVisibleForInstance(e, instId)));
      mergedLogs.sort((a, b) => a.ts - b.ts);
      mergedLogs = filterConsoleEntries(mergedLogs, consoleFilter);
      if (mergedLogs.length > 200) {
        mergedLogs = mergedLogs.slice(mergedLogs.length - 200);
      }
      renderLogList(mergedLogs);
    });
  }

  let consoleFilter = 'all'; // 交互日志抽屉过滤态：all|interaction|diag（切换即本地重渲，不重新请求服务端）
  // 服务端推来的 session_log：面板开着、且不在「诊断」筛选时实时追加
  function appendSessionLog(entry) {
    if (consoleModal?.classList.contains('sheet-open') && consoleFilter !== 'diag') appendLogEntry(entry);
  }
  // 诊断时间线 diag_log：面板开着且未把筛选切到「仅交互」时追加——切到「诊断」/「全部」都应看见
  function appendDiagLog(p) {
    if (consoleModal?.classList.contains('sheet-open') && consoleFilter !== 'interaction') appendLogEntry(formatDiagLogEntry(p));
  }
  let lastRenderedLogs = []; // 抽屉当前渲染的条目快照——「复制全部」的所见即所得数据源
  // 批量渲染日志：在恢复段(上次会话)与本次会话交界插一条「—— 本次会话 ——」分隔（isRestoredBoundary）。
  // 实时 onEntry 追加的都是本次(非 restored)、永不触发分隔，故分隔只在此批量路径出现。
  function renderLogList(entries) {
    if (!consoleLogArea) return;
    lastRenderedLogs = entries;
    let prev = null;
    for (const entry of entries) {
      if (isRestoredBoundary(prev, entry)) {
        const sep = document.createElement('div');
        sep.className = 'text-center text-[10px] text-console-ink-faint select-none py-1';
        sep.textContent = t('—— 本次会话 ——');
        consoleLogArea.appendChild(sep);
      }
      appendLogEntry(entry); // 批量路径每条 soft；循环后一次 force 落底（打开抽屉/切换过滤）
      prev = entry;
    }
    // 打开即看最新：全量/过滤重渲结束后强制贴底（实时 onEntry 仍走 soft stick）
    consoleLogArea.scrollTop = consoleLogArea.scrollHeight;
  }

  function appendLogEntry(p, { force = false } = {}) {
    if (!p || !consoleLogArea) return;
    // 布局契约：纵向 row + 可换行 meta + 满宽 body（见 logic.js consoleLogEntryLayout）。
    // 旧横向 flex 会在窄屏被 chip 挤成一字宽竖排。
    const layout = consoleLogEntryLayout();
    const row = document.createElement('div');
    row.className = layout.row;

    const meta = document.createElement('div');
    meta.className = layout.meta;

    const tsStr = p.ts ? new Date(p.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
    const tsSpan = document.createElement('span');
    tsSpan.className = 'text-console-ink-faint select-none shrink-0 font-semibold';
    tsSpan.textContent = `[${tsStr}]`;
    meta.appendChild(tsSpan);

    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'px-1 py-0.5 rounded text-[9px] uppercase font-bold tracking-wider shrink-0';
    let badgeText;
    let textClass;

    switch (p.type) {
      case 'user_in':
        badgeSpan.className += ' bg-blue-950/60 text-blue-400 border border-blue-800/40';
        badgeText = 'user→srv';
        textClass = 'text-blue-100/90';
        break;
      case 'user_out':
        badgeSpan.className += ' bg-cyan-950/60 text-cyan-400 border border-cyan-800/40';
        badgeText = 'srv→cli';
        textClass = 'text-cyan-100/90';
        break;
      case 'agent_send':
        badgeSpan.className += ' bg-purple-950/60 text-purple-400 border border-purple-800/40';
        badgeText = 'agt→sdk';
        textClass = 'text-purple-100/90';
        break;
      case 'agent_result':
        badgeSpan.className += ' bg-emerald-950/60 text-emerald-400 border border-emerald-800/40';
        badgeText = 'sdk→agt';
        textClass = 'text-emerald-100/90';
        break;
      case 'sys_info':
        badgeSpan.className += ' bg-rose-950/60 text-rose-400 border border-rose-800/40';
        badgeText = 'sys-info';
        textClass = 'text-rose-100/90';
        break;
      case 'client_conn':
        badgeSpan.className += ' bg-amber-950/60 text-amber-400 border border-amber-800/40';
        badgeText = 'cli-conn';
        textClass = 'text-amber-100/90';
        break;
      case 'client_send':
        badgeSpan.className += ' bg-blue-950/60 text-blue-400 border border-blue-800/40';
        badgeText = 'web-send';
        textClass = 'text-blue-100/90';
        break;
      case 'client_recv':
        badgeSpan.className += ' bg-indigo-950/60 text-indigo-400 border border-indigo-800/40';
        badgeText = 'web-recv';
        textClass = 'text-indigo-100/90';
        break;
      case 'client_stream':
        badgeSpan.className += ' bg-teal-950/60 text-teal-400 border border-teal-800/40';
        badgeText = 'stream';
        textClass = 'text-teal-100/90';
        break;
      // 诊断时间线（镜像/排队/停止）：徽标按子系统身份着色，正文按 severity 着色（见下方覆盖），
      // 不是像上面几类那样身份色/正文色绑死——这样超时/失败这类事件能在一堆中性事件里视觉跳出来。
      case 'diag_mirror':
        badgeSpan.className += ' bg-indigo-950/60 text-indigo-400 border border-indigo-800/40';
        badgeText = 'mirror';
        textClass = 'text-console-ink';
        break;
      case 'diag_queue':
        badgeSpan.className += ' bg-orange-950/60 text-orange-400 border border-orange-800/40';
        badgeText = 'queue';
        textClass = 'text-console-ink';
        break;
      case 'diag_interrupt':
        badgeSpan.className += ' bg-red-950/60 text-red-400 border border-red-800/40';
        badgeText = 'interrupt';
        textClass = 'text-console-ink';
        break;
      case 'diag_control':
        badgeSpan.className += ' bg-slate-800 text-slate-400 border border-slate-600/40';
        badgeText = 'control';
        textClass = 'text-console-ink';
        break;
      case 'diag_statusline':
        badgeSpan.className += ' bg-cyan-950/60 text-cyan-400 border border-cyan-800/40';
        badgeText = 'usage';
        textClass = 'text-console-ink';
        break;
      default:
        badgeSpan.className += ' bg-console-surface text-console-ink-soft border border-console-line';
        badgeText = p.type || 'log';
        textClass = 'text-console-ink';
    }
    // 诊断事件正文按 severity 覆盖着色（身份色留在徽标上，见上面 diag_* 分支注释）
    if (p.severity === 'danger') textClass = 'text-red-300';
    else if (p.severity === 'warning') textClass = 'text-amber-300';
    badgeSpan.textContent = badgeText;
    meta.appendChild(badgeSpan);

    // 模型 ID 独立 chip（紧邻 type 角标）：仅当 entry 带 model 时渲染；中性配色区别于 type 语义色。
    // 网关映射场景（同 syncModelUI）：候选项确有 resolvedModel 才覆盖显示真实模型名，否则保留原始
    // p.model 原样显示，不回落 displayName——诊断日志的价值在于忠实记录"那一刻实际记的值"。
    // title 悬停在覆盖时补显原始档位名，便于对照 setModel 实际请求的是哪个别名。
    if (p.model) {
      const gatewayName = resolveGatewayModelName(p.model, getModelsList());
      const displayText = gatewayName || p.model;
      const modelSpan = document.createElement('span');
      modelSpan.className = 'px-1 py-0.5 rounded text-[9px] font-bold shrink-0 bg-slate-800 text-slate-300 border border-slate-600/50 max-w-[120px] truncate';
      modelSpan.textContent = displayText;
      modelSpan.title = gatewayName ? `${p.model} → ${gatewayName}` : p.model;
      meta.appendChild(modelSpan);
    }
    // 思考强度 / 权限档 chip（那一刻的档位）：只要 entry 带该字段就渲染，默认值（model-default/default）
    // 也照显——每条数据流记录都完整列出模型 + 强度 + 权限档。字段缺失（如 sys_info 不带这俩）仍跳过、不画空 chip。
    const metaChip = (val, cls, prefix) => {
      if (!val) return;
      const c = document.createElement('span');
      c.className = `px-1 py-0.5 rounded text-[9px] font-bold shrink-0 ${cls}`;
      c.textContent = prefix + val;
      meta.appendChild(c);
    };
    metaChip(p.effort, 'bg-indigo-950/60 text-indigo-300 border border-indigo-700/40', '🧠');
    metaChip(p.permissionMode, 'bg-amber-950/60 text-amber-300 border border-amber-700/40', '🔑');

    row.appendChild(meta);

    const textSpan = document.createElement('span');
    textSpan.className = `${layout.body} ${textClass}`;
    textSpan.textContent = (p.text || '').replace(/\\n/g, '\n');
    row.appendChild(textSpan);

    // 在 append 前判定 stick：append 后 scrollHeight 会涨，贴底用户的 dist 可能瞬时变大并误判为「不在底部」。
    const stick = shouldStickScrollToBottom({
      scrollHeight: consoleLogArea.scrollHeight,
      scrollTop: consoleLogArea.scrollTop,
      clientHeight: consoleLogArea.clientHeight,
      force,
    });
    consoleLogArea.appendChild(row);
    if (stick) consoleLogArea.scrollTop = consoleLogArea.scrollHeight;
  }

  return { appendDiagLog, appendLogEntry, appendSessionLog, loadConsoleLogs };
}
