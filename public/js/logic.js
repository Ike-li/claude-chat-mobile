// logic.js —— app.js 的纯决策逻辑。
// 红线：本文件只做数据→数据，不得 import / 触碰 DOM / window / socket / 任何全局可变状态。
// 目的：让 app.js（浏览器 import）与 test/logic.test.mjs（node:test）共用同一份逻辑，零依赖、零构建。

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
    return mSfx === sfx && mBase && base.includes(mBase);
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

// 新会话首发的乐观 busy（send() 的 setBusy(true)）会被「服务端懒开实例 → 广播 instances → setInstances →
// bindView → clearView 的 setBusy(false)」冲掉，直到首个 delta 才重现（已有会话发消息不触发 bindView，故无此问题）。
// 仅当：发送时置了首发标志、且已绑定到一个尚无 sessionId 的新建实例（FRESH、SDK init 未回；区别于
// session:switch 打开的已有会话）时，才在 bindView 后同步补回 busy。
export function shouldRestoreOptimisticBusy({ pendingFirstSend, viewingInstanceId, sessionId } = {}) {
  return Boolean(pendingFirstSend && viewingInstanceId && !sessionId);
}

// bindView 切视图时是否该清空输入框未发送草稿。思考强度/模型切档在 SDK 层无运行时切换能力，后端 dispose
// 旧实例 + resume 同会话开新实例（instanceId 变了、sessionId 不变），前端只看 viewingInstanceId 变化就判定
// 为「切到另一个会话」而清空草稿——这是误伤：用户视角仍在同一个聊天里，只是底层实例被静默替换。
// 判定：新旧 sessionId 相同且非空 ⇒ 同一会话静默换实例，保留草稿；否则（真实切会话/切到全新未开会话/
// 任一端为空）⇒ 清空（保守默认，不吞真实导航场景）。
export function shouldClearInputOnBindView({ prevSessionId, newSessionId } = {}) {
  return !(newSessionId && newSessionId === prevSessionId);
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
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
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

// 连接 RTT 展示文案：手机顶栏实时延迟。合法有限非负 number → 整数 ms（≥1000 用 1 位小数 s）；
// 非法/未知（null/NaN/负/非 number）→ ''，接线层据此隐藏，避免断线时残留陈旧数字。
export function formatRttMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

// 连接 RTT 色阶语义 token：good(<150) / ok(<400) / warn(<1000) / bad(≥1000)。
// 返回语义名而非 Tailwind class，接线层映射到 text-success/text-ink-soft/text-warning/text-danger；
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
// 要害盲区：CLI 在终端外部 `--resume` 写盘的消息【不经过】web 这个 SDK 实例的活缓冲，只落磁盘 transcript。
// 若 web 离开期间被外部写过，切回时 replayed=0（活缓冲无那些消息）却 hasCache=true（有旧 DOM 缓存）——
// 旧逻辑信缓存不拉盘 → 永远看不到外部写入。故此处比对 server 报的磁盘 history 条数 diskLen 与前端上次为该
// 会话渲染到的 seenDiskLen：磁盘更长 = 被外部写过 = 当作一种 gap，清屏全量重载磁盘（唯一真相源、清屏天然无重复）。
//   gap → 'reload'（缓冲超窗，同 syncAckAction）；
//   replayed>0 → 'keep'（web 端活跃、活缓冲是渲染真相，绝不重载以免丢实时 thinking / 在跑 turn）；
//   replayed===0 && !hasCache → 'load'（聊天区空、拉磁盘首次填充，不必清屏）；
//   replayed===0 && hasCache && diskLen>seenDiskLen → 'reload'（外部写入盲区：缓存已过期，清屏全量重载）；
//   否则 → 'keep'（缓存仍是最新，保留 DOM 秒恢复）。
// ⚠️ 已知边界（code-review 发现4，有意不修）：seenDiskLen 只由 loadHistory/onHistoryAppend 维护，
//   web 自己 live 流跑出来的轮次【不】更新它。于是"发一轮(磁盘增长)→切走→切回同实例(无外部活动、replayed=0、
//   缓存命中)"会 diskLen>seenDiskLen → 多余 reload（闪屏+滚动跳，但内容正确）。这是【安全侧】：现状 under-count
//   → 多 reload(安全)；若改成让 live 轮 bump seenDiskLen，一旦 over-count 就变 under-reload = 漏外部写入 =
//   数据丢失(正是 #1 盲区)。宁可闪一下、不可漏消息，故保留。
export function shouldReloadOnEnter({ replayed, gap, hasCache, diskLen = 0, seenDiskLen = 0 } = {}) {
  if (gap) return 'reload';
  if (replayed > 0) return 'keep';
  if (!hasCache) return 'load';
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

// ── 状态一瞥：live 会话实例汇总（非 OS 进程表）────────────────────────────────
// 数据源 = instances 广播的 live AgentSession 列表。running = busy 计数（含前台轮 + 后台 bgTasks）。
// 不做 PID / 僵尸：后端无子进程 PID，本函数也不假装。
const INSTANCE_STATES = ['busy', 'permission', 'error', 'done', 'aborted', 'idle'];
export function summarizeInstanceStates(instances) {
  const byState = Object.fromEntries(INSTANCE_STATES.map(s => [s, 0]));
  let total = 0;
  for (const inst of Array.isArray(instances) ? instances : []) {
    if (!inst || !inst.instanceId) continue;
    total++;
    const s = INSTANCE_STATES.includes(inst.state) ? inst.state : 'idle';
    byState[s]++;
  }
  return { total, byState, running: byState.busy };
}

// 统一判定：会话待处理 + 服务异常 → ok | attention | alert（提案 whatNeedsAttention MVP）。
// priority: alert > attention > ok。不引入 softwareEvents 环 / doctor healthVerdict（第二刀）。
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

// Part3（§6）：SDK getContextUsage() 的 categories 分解 → 展示行。对齐 CLI /context 的上下文占用分解
// （Skills / MCP tools / Memory files / Compact buffer / Free space 等）。过滤 0/坏项、按 tokens 降序、
// 算 pct（相对 maxTokens；缺 maxTokens 则 pct=null，前端只显绝对 token）。isDeferred 透传（延迟加载类别）。
// 服务状态可见性（第一性原理重新设计——见 docs/hld-ccm.md 附近）：与"需要你(N)"聚合（FR-21/AD-11，会话待处理，
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

// 组装会话面板"服务"小节文案（会话面板既有图例区之后、目录列表之前，仅异常时渲染）。空数组=一切正常。
// 刻意不吞并/复用"需要你(N)"聚合的展示逻辑——两条轴分开陈列，不让服务健康看起来像"更多同类待办"。
export function formatServiceNotices({ service, restartChanged, now } = {}) {
  const notices = [];
  if (restartChanged) {
    notices.push('🔄 服务自上次连接后已重启，请确认之前任务是否正常完成');
  }
  const df = service && service.deliveryFailure;
  if (df && typeof df.at === 'number') {
    const channelLabel = df.channel === 'ntfy' ? 'ntfy' : 'push';
    const countSuffix = Number.isFinite(df.count) && df.count > 0 ? `，累计 ${df.count} 次` : '';
    notices.push(`🔔 推送最近失败于 ${formatAgo(now - df.at)}（${channelLabel}${countSuffix}）`);
  }
  return notices;
}

// ③ 从 SDK usage_EXPERIMENTAL...() 响应提取 web 额度窗所需字段（防御性解析——运行时结构比 .d.ts 富且
// 标记 EXPERIMENTAL_MAY_CHANGE、会漂，故不绑固定 schema、逐字段存在性校验）。三条硬规则：
// ① usage 为空（fetchUsage 超时/无 q/抛错）或 rate_limits_available===false（API key / Bedrock / Vertex /
//    无 profile scope 的第三方 provider）→ 返回 { available:false }，前端据此隐藏额度窗、不显任何额度数字。
// ② 剔除 behaviors：含本机使用画像隐私（per-skill/agent/plugin/MCP 归因、请求/会话计数），绝不外露。
// ③ 成本（session.total_cost_usd）与订阅类型（max/pro）非隐私、可留。
// 窗口 key（five_hour/seven_day_opus 等）保留 SDK 原名（= SDKRateLimitInfo.rateLimitType 枚举，稳定可辨），
// 叶子字段归一 camelCase（resets_at→resetsAt）符合 web 契约。
// 注：statusline 显示面另由 statusline.js usageBitsForStatusLine 取 5h/7d + lines；本函数服务独立额度窗通道。
export function parseUsageForWeb(usage) {
  if (!usage || typeof usage !== 'object') return { available: false };
  if (usage.rate_limits_available === false) return { available: false };
  const out = { available: true };
  if (typeof usage.subscription_type === 'string' && usage.subscription_type) out.subscriptionType = usage.subscription_type;
  const sess = usage.session;
  if (sess && typeof sess === 'object' && Number.isFinite(sess.total_cost_usd)) out.session = { totalCostUsd: sess.total_cost_usd };
  const rl = usage.rate_limits;
  if (rl && typeof rl === 'object') {
    const limits = {};
    for (const key of ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet']) {
      const w = normalizeRateWindow(rl[key]);
      if (w) limits[key] = w;
    }
    if (Array.isArray(rl.model_scoped)) {
      const scoped = rl.model_scoped.map(m => {
        const w = normalizeRateWindow(m);
        if (w && m && typeof m.display_name === 'string' && m.display_name) w.displayName = m.display_name;
        return w;
      }).filter(Boolean);
      if (scoped.length) limits.model_scoped = scoped;
    }
    if (rl.extra_usage && typeof rl.extra_usage === 'object') {
      const e = rl.extra_usage, extra = {};
      if (typeof e.is_enabled === 'boolean') extra.isEnabled = e.is_enabled;
      if (Number.isFinite(e.utilization)) extra.utilization = e.utilization;
      if (Number.isFinite(e.monthly_limit)) extra.monthlyLimit = e.monthly_limit;
      if (Number.isFinite(e.used_credits)) extra.usedCredits = e.used_credits;
      if (Object.keys(extra).length) limits.extraUsage = extra;
    }
    if (Object.keys(limits).length) out.rateLimits = limits;
  }
  return out;
}

// 归一化单个额度窗：{ utilization:number|null, resets_at:string|null } → { utilization?, resetsAt? }。
// 防御性：非对象/全空 → null（调用方据此省略该窗）。utilization=0 是有效值（刚开始用）必须保留，故用
// Number.isFinite 而非真值判断。非导出 helper（parseUsageForWeb 专用）。
function normalizeRateWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const out = {};
  if (Number.isFinite(w.utilization)) out.utilization = w.utilization;
  if (typeof w.resets_at === 'string' && w.resets_at) out.resetsAt = w.resets_at;
  return Object.keys(out).length ? out : null;
}
