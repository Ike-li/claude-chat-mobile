// logic.js —— app.js 的纯决策逻辑。
// 红线：本文件只做数据→数据，不得 import / 触碰 DOM / window / socket / 任何全局可变状态。
// 目的：让 app.js（浏览器 import）与 test/logic.test.mjs（node:test）共用同一份逻辑，零依赖、零构建。

// HTML 转义。app.js 多处复用（审批命令、工具参数摘要）+ ansiToHtml 内部。
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

// per-cwd 状态聚合：该 cwd 各实例状态取最高优先级（permission>error>busy>done>idle；失败比在跑更需关注）。
export function aggregateStates(instances, dirs) {
  const rank = { idle: 0, done: 1, busy: 2, error: 3, permission: 4 };
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
  const rank = { busy: 1, done: 2, error: 3, permission: 4 };
  let top = null, topRank = 0;
  for (const d of (availableDirs || [])) {
    if (d === currentCwd) continue;
    const st = workdirStates && workdirStates[d];
    if ((rank[st] || 0) > topRank) { topRank = rank[st]; top = st; }
  }
  return top; // 'permission'|'error'|'done'|'busy'|null
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

// 依据上一条助手消息的关键词，推荐 ≤3 条后续快捷提示词（chip；渲染见 app.js renderSuggestedPrompts）。
// 纯启发式：助手输出里提到的主题 → 建议对应后续动作。本 UI 中 Claude 用中文回复，故每条规则中英
// 关键词都要覆盖——只写英文时中文回复永远匹配不到、只会落通用兜底，功能形同虚设。命中不足 3 条用
// 通用后续补足；去重、封顶 3。'ci' 走词边界匹配，免得 decision/efficiency 等把 ci 当子串误触发。
export function generateSuggestions(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase();
  const has = (...kw) => kw.some(k => lower.includes(k));
  const out = [];
  const add = (s) => { if (!out.includes(s) && out.length < 3) out.push(s); };

  if (/\bci\b|\bcd\b/.test(lower) || has('workflow', 'pipeline', '流水线', '工作流', '部署')) add('确认 CI 绿了就收工');
  if (has('test', 'spec', 'pytest', 'unittest', '测试', '单测', '用例')) {
    add('运行测试验证一下');
    if (has('unit', '单元', '单测')) add('帮我写个单测');
  }
  if (has('git', 'commit', 'push', 'repo', '提交', '推送', '仓库', '分支')) add('把修改提交到 git');
  if (has('error', 'fail', 'exception', 'bug', 'issue', 'crash', '错误', '失败', '报错', '异常', '崩溃', '出错')) add('帮我修复这个错误');
  if (has('doctor', 'setup', 'config', 'env', 'install', '配置', '环境', '安装', '自检')) add('帮我运行 doctor 自检一下');
  if (has('lint', 'format', 'refactor', 'cleanup', '格式化', '重构', '清理', '代码风格')) add('运行 lint 检查代码风格');

  // 通用兜底：任何非空回复都至少给 3 条后续（保持原设计——每轮结束恒显 chip）
  for (const g of ['继续', '还有什么需要优化的吗？', '运行一下看看效果']) add(g);
  return out;
}
