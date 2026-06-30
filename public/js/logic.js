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
