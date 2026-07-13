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
// 驾驶中点「接管会话」进入 armed：不立即解锁（立即发送会与终端在跑的 turn 并发写盘），而是等
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
