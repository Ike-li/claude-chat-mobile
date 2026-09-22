// logic/panel-state.js —— 面板/抽屉/空屏状态聚合 · 跨工作区最近列表 · 深链 · 状态图标 · 会话列表 SWR
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t } from '../i18n.js';

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
// UX-004：流式 markdown 预览节流间隔（ms）。
export function formatStreamPreviewIntervalMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? n : 80;
}

// UI-007：高频状态标（工具卡 · 抽屉角标 · 会话点）。一个 kind 一个条目，图标 / 语义色 / 标签同源。
//
// tone 曾经不在这里，而是由【每个调用方】自己 classList.add——四个调用点里有两个忘了加，于是
// 走历史回放渲染出来的成功工具卡顶着模板里残留的 text-warning，同一张卡实时看是绿 ✓、刷新后
// 变成棕色的 ✓（2026-09-09）。并进同一张表后，「加了 kind 忘了配色」在结构上写不出来。
//
// path 是可信静态串（无用户输入），currentColor 吃 tone 给的语义色。
// label 存中文原文、到 statusIconSpec 里才 t()：模块顶层常量在 import 阶段求值，那时 app.js
// 还没跑到 setLang()，直接在表里 t() 会把标签永久钉死成中文。
export const STATUS_ICONS = {
  // hourglass-ish circle for pending/busy
  pending: { tone: 'text-warning', label: '进行中', path: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  busy: { tone: 'text-warning', label: '运行中', path: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  ok: { tone: 'text-success', label: '成功', path: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l2.5 2.5L16 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' },
  error: { tone: 'text-danger', label: '出错', path: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  warn: { tone: 'text-warning', label: '待审批', path: '<path d="M12 3l9 16H3L12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  denied: { tone: 'text-danger', label: '已拒绝', path: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  // answered / aborted 是中性终态：不是工具失败，也不该占用绿色去邀功——刻意让它们退出红/绿的注意力预算
  answered: { tone: 'text-ink-soft', label: '已回答', path: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l2.5 2.5L16 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' },
  aborted: { tone: 'text-ink-soft', label: '已中止', path: '<rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9h6v6H9z" fill="currentColor"/>' },
};
// 供调用点在换色前清掉上一个状态的色（不能只 add，否则两个色类叠着靠 CSS 顺序决胜负）
export const STATUS_ICON_TONES = [...new Set(Object.values(STATUS_ICONS).map(s => s.tone))];
export function statusIconSpec(kind) {
  const k = STATUS_ICONS[kind] ? kind : 'pending';
  const { path, tone, label } = STATUS_ICONS[k];
  const html = `<svg class="status-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">${path}</svg>`;
  return { html, label: t(label), kind: k, tone };
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

// 「此刻挂着的那张会话落地页，是不是本次请求弹出来的」。
//
// 用途只有一个：session:switch 的 4 秒兜底已经把「切换无响应」弹出来了，而迟到的【成功】ack
// 随后到达（服务端可能先广播导航、后回 ack）——这时要把那张页撤掉，否则用户人已经在目标
// 会话里，屏幕上却盖着一张说它没响应的落地页。
//
// 【为什么不能无条件撤】从 4 秒兜底弹出到迟到 ack 返回之间，用户完全可能已经点开别的会话
// 并撞上一次【真实】失败，此刻挂着的是那一张。无条件 hide 会把那条真实错误一起抹掉，
// 而它是用户当下唯一看得见的线索——修一个假提示的代价不该是吞掉一个真提示。
//
// sessionId 与 cwd 两者都要比：同一个 sessionId 在不同工作区是不同会话（托管 worktree 场景），
// 只比 sessionId 会在那种场景下撤错。
export function isBlockedSurfaceTarget(target, { sessionId = null, cwd = null } = {}) {
  if (!target) return false;
  return target.sessionId === sessionId && target.cwd === cwd;
}

// 工作区抽屉只显示需要用户理解/处理的四态。terminal 独立于 live 实例合并，避免 idle/done live tab
// 遮住同会话正在运行的终端进程；done/aborted/idle 都是普通终态，不占抽屉主状态位。
//
// terminal_waiting（2026-09-04）：CLI 卡在对话框上等人按键（含权限审批框，registry status:"waiting"）。
// 排在 busy 之前——「在跑」不需要人动手，「等人」需要。排在 Web 侧 permission/error 之后——那两个
// 在手机上点一下就能处理，终端那个只能走到电脑前按，优先级理应更低。
// bgLocked（2026-09-06）：这个会话被 CLI 后台 agent 独占，web 点了会被 session:switch 拒。
// 排在最低档是刻意的——它是「此路不通」的说明，不是待办，更不该压过「需要你」这种点一下就能处理的。
// 目录角标/顶部点不传这个参数（drawerStateForDir 只喂 liveState+terminalState），会话级的
// 「打不开」不该抬到工作区层：整个工作区并没有出事，只是其中一个会话被占着。
export function resolveDrawerStatus({ liveState, terminalState, bgLocked = false } = {}) {
  if (liveState === 'permission') return 'permission';
  if (liveState === 'error') return 'error';
  if (terminalState === 'waiting') return 'terminal_waiting';
  if (liveState === 'busy' || terminalState === 'busy') return 'busy';
  if (bgLocked) return 'bg_locked';
  return null;
}

const DRAWER_STATUS_LABELS = {
  permission: '需要你',
  error: '出错',
  // 「占用」不说成「运行中」：被占的会话可能自报 idle（后台 agent 挂着一个长跑 Bash 就是这形态），
  // 说它在运行是编造状态。这条 chip 唯一要传达的是「点了打不开」。
  bg_locked: '后台占用',
  // 措辞刻意与 Web 侧「需要你」区分：那个点开就能批，这个批不了——审批 prompt 活在 CLI 进程的
  // TUI 里，不经过 web 后端的 canUseTool，web 端替不了你按键。说成「需要你」会给出错误的操作预期。
  terminal_waiting: '终端需要你',
  busy: '运行中',
};

// 会话行 chip：kind 仍是需要你/出错/运行中，busy 的文案按「此刻谁在干活」区分。
// 抽屉广播没有 origin/resume 字段，驾驶组合只能用 liveState × terminalState 表达：
//   纯 Web 回合 / Web 续接且 CLI 已 idle     → 运行中
//   纯 CLI 回合 / CLI 跑着 Web 只读或空闲 tab → 终端运行中
//   两边同时 busy（续接重叠、CLI --resume 抢走尚未 settle）→ 终端运行中
//     （registry busy 是「终端正在写」的权威信号，必须写在标题行，不能再藏进副行）
// 目录角标/顶部点仍用 resolveDrawerStatus 的三态，不把来源抬到工作区层。
//
// terminalSource（2026-09-06）：外部驾驶员不只有终端了。桌面端 Code 模式（Claude.app 的 Code
// 标签，entrypoint=claude-desktop）驾驶时说"终端运行中"是在说错话——用户会去翻终端标签页，
// 而那个回合其实跑在桌面 app 的窗口里。状态轴不变（都是 busy），只换措辞。
// 未知/缺失 source 回落"终端"：与本字段引入之前完全同形，老服务端的行不会塌成无 chip。
export function resolveDrawerStatusChip({ liveState, terminalState, terminalSource = null, bgLocked = false } = {}) {
  const status = resolveDrawerStatus({ liveState, terminalState, bgLocked });
  if (!status) return null;
  // busy × bgLocked 不是二选一：占用者自己在跑时两件事都真，措辞要同时带上。说成「终端运行中」
  // 会把人指向错误的接管路径——那不是一个终端窗口，是 `claude agents` 里的后台 job，走到电脑前
  // 打开终端也看不到它。
  const label = (status === 'busy' && bgLocked) ? '后台任务运行中'
    : (status === 'busy' && terminalState === 'busy')
      ? (terminalSource === 'claude-desktop' ? '桌面端运行中' : '终端运行中')
      : (DRAWER_STATUS_LABELS[status] || '运行中');
  return { status, label };
}

// 会话行副文本：时间 / 已打开 / id。CLI 空闲占用提到最前，避免 truncate 吃掉来源；
// CLI busy 不再写「终端」——主 chip 已是「终端运行中」。
export function formatSessionRowSubtitle({
  whenText = '',
  liveOpen = false,
  terminalState = null,
  terminalSource = null,
  shortId = null,
  worktree = null,
  worktreeGone = false,
} = {}) {
  const parts = [];
  // 托管 worktree 的归属排最前：同一页里混着父仓与各 worktree 的会话，而副文本是 truncate 的——
  // 尾部先被吃掉，归属比时间戳更不能丢。非字符串/空白一律不渲染，否则多出一个悬空的分隔符。
  // 「（已删除）」跟在名字后面而不是另起一段：这一行点不开（cwd 没了，SDK 起不来），
  // 不当场标出来就只能靠点一次读报错才知道，而它跟活着的 worktree 行长得一模一样。
  if (typeof worktree === 'string' && worktree.trim()) {
    parts.push(`worktree ${worktree.trim()}${worktreeGone ? t('（已删除）') : ''}`);
  }
  if (terminalState === 'alive') parts.push(terminalSource === 'claude-desktop' ? t('桌面端已打开') : t('终端已打开'));
  if (whenText) parts.push(whenText);
  if (liveOpen) parts.push(t('已打开'));
  if (shortId) parts.push(String(shortId));
  return parts.join(' · ');
}

// 文件 / 改动面板的目标目录（2026-09-11）。
//
// 【为什么不能直接用工作区 cwd】托管 worktree 的会话打开后，工作区轴仍归父仓（产品判据：
// worktree 是临时模式，不占抽屉条目），但 claude 实际在 `.claude/worktrees/<name>` 里改文件。
// 拿父仓 cwd 去拉 git 变更，列出来的是父仓那棵树的 diff——它看起来是空的，
// 而「看起来没改动」和「真的没改动」在 UI 上无法区分，用户会据此判断该不该合并。
//
// 【为什么优先 panelCwd 而不是直接读 cwd】worktree 目录被删掉之后（2026-09-13 真机形态），
// 实例的 cwd 仍指向那条已不存在的路径，而且**必须保持原样**——transcript 就落在按它算出的
// project 目录里，改掉 cwd 就是「历史消息加载失败」。所以服务端另发一个 panelCwd 承担
// 展示/文件/git 轴：路径还在时它恒等于 cwd，悬空时回落父仓。前端只管认它。
// 旧 server 不下发这个字段 → 回落 cwd，与引入它之前逐字同形。
//
// 无当前实例（空首页、实例刚关）→ 回落工作区 cwd，与引入本函数之前逐字同形。
export function resolvePanelCwd({ instances, viewingInstanceId, workspaceCwd } = {}) {
  const list = Array.isArray(instances) ? instances : [];
  const inst = list.find(i => i && i.instanceId === viewingInstanceId);
  return inst?.panelCwd || inst?.cwd || workspaceCwd || null;
}

// transcript 轴：「按 cwd 去磁盘找这个会话的东西」时该用哪个目录（loadHistory 拿它算 project 目录）。
//
// 【为什么不能和 resolvePanelCwd 合成一个】worktree 目录被删掉那一档两者必然分叉，而合并之后
// 无论偏向哪一侧都是静默出错、且两种错法毫无相似之处：
//   · 偏展示轴 → loadHistory 去父仓的 project 目录查，「历史消息加载失败」，而 jsonl 完好无损
//     （agent.js handleCwdChanged 那段注释讲的就是这个症状）；
//   · 偏驾驶轴 → 文件面板报「路径不在授权范围内」、改动面板报 git fatal。
// 同一份 instances 同时喂这两个消费者，分开取值是唯一不出错的写法。
export function resolveSessionCwd({ instances, viewingInstanceId, workspaceCwd } = {}) {
  const list = Array.isArray(instances) ? instances : [];
  const inst = list.find(i => i && i.instanceId === viewingInstanceId);
  return inst?.cwd || workspaceCwd || null;
}

// worktree 目录被删掉之后，文件/改动面板会静悄悄地改看父仓（见 resolvePanelCwd）。
// 【为什么不能只是静悄悄地换】resolvePanelCwd 当初存在的理由就是「拿父仓 cwd 去拉 git 变更，
// 列出来的是父仓那棵树的 diff——它看起来是空的，而『看起来没改动』和『真的没改动』在 UI 上
// 无法区分，用户会据此判断该不该合并」。回落时这个风险原样成立，所以必须显式说一句那棵树没了。
// 返回名字对（结构化），文案留给渲染层拼——i18n 没有插值，句子得在有 t() 的那一层组装。
export function resolveWorktreeGoneNotice({ instances, viewingInstanceId } = {}) {
  const list = Array.isArray(instances) ? instances : [];
  const inst = list.find(i => i && i.instanceId === viewingInstanceId);
  if (!inst?.worktreeGone) return null;
  return { worktree: projectDisplayName(inst.cwd), parent: projectDisplayName(inst.panelCwd) };
}

// 一个实例 cwd 归哪个工作区。托管 worktree 的 cwd 是 `<父仓>/.claude/worktrees/<name>`，
// **不在白名单 dirs 里**，必须归到最长前缀的父仓——否则它在任何按工作区分组的视图里都会凭空消失
// （角标与 sessionsDot 是 K2，会话行的「已打开」判定是 2026-09-12 补的：只按 inst.cwd === d 过滤时
// liveMap 对 worktree 行恒空，开着的会话被渲染成未打开，丢运行态、丢关闭入口，点一下还要多走一次
// reopen）。取最长前缀而不是任一前缀：工作区嵌套时（/repo 与 /repo/sub 都在册）才不会归错。
export function owningWorkspace(cwd, dirs) {
  if (!cwd) return null;
  const list = Array.isArray(dirs) ? dirs : [];
  if (list.includes(cwd)) return cwd;
  let best = null;
  for (const d of list) {
    if (typeof d !== 'string' || !d) continue;
    if (cwd.startsWith(d.endsWith('/') ? d : d + '/')) {
      if (!best || d.length > best.length) best = d;
    }
  }
  return best;
}

// per-cwd 状态聚合：该 cwd 各实例状态取最高优先级（permission>error>busy>aborted>done>idle；失败比在跑更需关注）。
// aborted（P1-4 已中止独立状态）介于 done 与 busy 之间：比顺利完成更值得回头看一眼（为什么被中止），但
// 已是终态，不该盖过仍在运行的其它会话。
export function aggregateStates(instances, dirs) {
  const rank = { idle: 0, done: 1, aborted: 2, busy: 3, error: 4, permission: 5 };
  const out = {};
  for (const d of (dirs || [])) out[d] = 'idle';
  for (const x of instances || []) {
    const key = owningWorkspace(x.cwd, Object.keys(out)) || x.cwd;
    if (!(key in out)) out[key] = 'idle';
    if ((rank[x.state] ?? 0) > (rank[out[key]] ?? 0)) out[key] = x.state;
  }
  return out;
}

// 汇总「其他工作区」状态给左上角按钮角标：只提示需要你/终端需要你/出错/运行中；完成、中止、空闲
// 都是普通终态，不持续点亮入口。排除 currentCwd（当前工作区动静在聊天视图内呈现）。
//
// ★ resolveDrawerStatus 现有五个非空返回值，这张 rank 表只登记其中四个——有意排除 bg_locked：
// 调用方 drawerStateForDir（app.js）只喂 liveState+terminalState，从不传 bgLocked，
// 「会话被占用打不开」是会话级的事，不该抬到工作区层去点亮全局角标（f0e193cf4，2026-09-07）。
// 其余四个是 terminal_waiting 漏挂之后（2026-09-06）补的同源优先级，序刻意与 resolveDrawerStatus
// 逐字同源，不另立一套：同样这几个状态在产品里出现两套优先级，迟早分叉，且分叉后两边各自都"看着对"。
// 给 resolveDrawerStatus 加状态时要重新判断一次：新状态是工作区级的（该收进来）还是会话级的
// （像 bg_locked 一样该排除），不能不假思索地照抄进来。
//
// 出口有两个消费者，语义不同、靠两张表分开，不在本函数里判：
//   · #sessionsDot 图标 —— 走 DRAWER_STATUS_META（渲染白名单，含 terminal_waiting）
//   · 顶栏文字 chip   —— 走 OTHER_WORKSPACE_CHIP_TONE（准入表，只放 permission/error）
// 所以 terminal_waiting 从这里出去后会点亮图标、而顶栏仍然安静——那正是想要的：图标是被动的
// 环境感知，而终端里的审批 prompt 手机上按不了键，不该占「点开就能处理」的槽位。
export function summarizeOtherWorkspaces(workdirStates, availableDirs, currentCwd) {
  const rank = { busy: 1, terminal_waiting: 2, error: 3, permission: 4 };
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

// 顶部工作区 pill（点开文件浏览 / git 改动）可见性。
//
// 判据是**工作区定了没有**，不是会话建了没有：pill 背后的 git:status 与 files:browse 只要一个 cwd
// （socket-files.js 两个 handler 都不碰 sessionId，只过 cwdInWorkDirs 范围门）。
//   · 真实会话：原样显示。
//   · compose 页（点 ＋ 后的会话懒创建窗口）：session 要等首条消息发出、SDK 吐首个 init 才有，但工作区
//     此刻已经定了（页头就写着「将在此工作区开新 CLI 会话」），文件和改动完全可看。此前这里跟着
//     shouldShowStartScreen 一起隐藏，等于让「会话还没建」顺带关掉了一项与会话无关的能力——而同一张
//     compose 页早已在读同一个仓库的 git（worktree 源分支选择器走 git:branches），两者自相矛盾。
//     页内那个 compose-project-pill 也补不上：它的 onclick 是打开会话列表抽屉，不通向文件。
//   · 空首页：工作区尚未选定（页面就是让你选的），pill 无处可指，仍隐藏。
// cwd 为空时一律隐藏——宁可没入口，也不给一个指向 null 的入口。
export function shouldShowTopContextPill({ viewingInstanceId, sessionId, composeReady = false, cwd = null } = {}) {
  if (!shouldShowStartScreen({ viewingInstanceId, sessionId })) return true;
  return Boolean(composeReady && cwd);
}

// 会话设置底部「🆔 会话标识」块：session id 是懒创建的（新会话懒开时 entry.sessionId=null，
// 要等 SDK 首个 init 事件才有），此前那行整条隐藏，只剩标题孤零零挂着——凭空少一栏，用户只会
// 以为界面坏了（与 effort 不支持时的处理同一条立场）。故不留白：没有 id 就就地说清为什么没有。
//
// 空态分两档，判据是服务端实例的有无——实例本身也是懒开的（src/server/app.js:833「session:new 后
// viewingInstanceId=null（懒创建无实例）」、2187「无可路由实例则懒开一个」），所以「实例在、id 不在」
// 只可能是消息已发出、正在等 SDK 首个 init；pendingFirstSend 补上空首页首发到懒开广播回来之间那一瞬。
//   · 尚未发送 —— 说机制（发了才会有），这是用户能采取的行动
//   · 分配在途 —— 说等待（正在创建），别把等待中说成尚未开始：真机 bc29ccc2 那次 CLI 卡了 31 分钟
//     没吐 init，实例活着、内容在流，此时告诉用户「发出第一条消息后才会分配」是答非所问
// freshInterrupted 是「实例在但没有 id 在路上」的例外（app.js:2384 的设置条件恰是「有实例、无 sid」）：
// 全新会话首轮被中断，那一轮已经作废，说「创建中」就是把已停止说成进行中——归回未发送档，
// 因为用户此时确实要再发一条才会有 id。两档都不写「你还没发消息」：那句话在分配在途时是假的。
//
// 可达性（决定这两档各自能被谁看见）：本块所在的会话设置 sheet 唯一入口是底栏 #pillDefaults，
// 它在 #composerFooter 内、随 composer 显隐（index.html:615-618）。无 sid 时 composer 只在
// composeReady / pendingFirstSend / freshInterrupted 三种情况下可见（shouldShowComposer），
// 也就是说「实例在、sid 迟迟不来」（真机 bc29ccc2 那 31 分钟）用户其实打不开这个面板。
// 分配在途档因此覆盖的是首发那一小段窗口，不是长时间卡住的那种——别据此以为它能报卡顿。
export function sessionIdBlockView({
  sessionId, viewingInstanceId = null, pendingFirstSend = false, freshInterrupted = false,
} = {}) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (sid) return { showRow: true, hint: null };
  const assigning = (Boolean(viewingInstanceId) || pendingFirstSend === true) && freshInterrupted !== true;
  return {
    showRow: false,
    hint: assigning
      ? t('会话创建中，CLI 分配 ID 后显示在这里。')
      : t('发出第一条消息后，CLI 才会创建会话并分配 ID。'),
  };
}

// 顶栏 RTT 芯片：全时段常驻显示——只要测得合法有效数值即显示，断线/未知/非法输入隐藏。
// 色阶由 rttToneClass 决定（good/ok 为中性 ink-soft，warn 为 warning，bad 为 danger）。
export function shouldShowRttChip(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;
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
        // 托管 worktree 的会话自带真实 cwd；无条件写工作区那个会把它覆盖掉，点开时按父仓去找
        // transcript，落到「会话不存在」页。workspaceName 不跟着变——归属展示本来就要显示父仓。
        cwd: s.cwd || cwd,
        workspaceName,
        worktree: s.worktree ?? null,
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

// 首页「最近活跃」这次合并有没有缺角。listMain 逐 workdir 发 session:list，单目录 4s 超时兜底
// done([])——超时目录与「该目录真的没有会话」在合并结果里完全同形，那个工作区连同它的未读会话
// 一起从首页静默消失，界面零痕迹。与目录头角标 null/0 同源的病：把「没拿到」呈现成「确定没有」。
// 本函数不改合并结果（拿到多少仍展示多少），只回答「要不要挂一行『部分工作区未能加载』」。
export function summarizeRecentsLoad(dirLists) {
  const failedDirs = [];
  for (const entry of Array.isArray(dirLists) ? dirLists : []) {
    if (!entry || typeof entry.cwd !== 'string' || !entry.cwd) continue;
    if (entry.timedOut) failedDirs.push(entry.cwd);
  }
  return { complete: failedDirs.length === 0, failedCount: failedDirs.length, failedDirs };
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

// 统一判定：会话待处理 → ok | attention（顶栏会话按钮角标 / 注意力信号）。
// 抽屉不再复述计数；状态落在需要你卡、工作区树角标、主聊天面。
// 服务健康不在这条轴上：needsYou 是「此刻按一下就能推进」，投递失败是背景状态，归抽屉「服务」与服务状态面板。
export function whatNeedsAttention({ instances, needsYou } = {}) {
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
  if (items.length) return { level: 'attention', items };
  return { level: 'ok', items: [] };
}

// 顶栏会话按钮右下角标：有事才出现。
// 优先级：已连过再断开 > 需要你 > 隐藏（服务告警不在此列，见 whatNeedsAttention 头注）。
// 首连中（从未连上）不点亮，避免每次打开闪一颗红点（与横幅延迟同因）。
export function resolveHeaderConnBadge({
  connected = false,
  everConnected = false,
  attentionLevel = 'ok',
  needsYouCount = 0,
} = {}) {
  const conn = connected ? 'online' : (everConnected ? 'offline' : 'connecting');
  if (conn === 'offline') {
    return { visible: true, tone: 'danger', conn, reason: 'offline', title: t('未连接') };
  }
  if (conn === 'online' && attentionLevel === 'attention') {
    return {
      visible: true,
      tone: 'warning',
      conn,
      reason: 'attention',
      title: `${t('需要你')} (${needsYouCount || '…'})`,
    };
  }
  return { visible: false, tone: null, conn, reason: 'ok', title: '' };
}

// 顶栏文字 chip：把会话按钮两颗角标（#connDot 纯色点 / #sessionsDot 状态图标）的含义写成人话——
// 手机没有 hover，它们的 title 等于不存在，用户只看到「一颗不知道什么意思的小红点」。
// 按优先级只显一条：未连接 > 需要你 N > 其他工作区（需要你/出错）> 隐藏。
// 前两级直接吃 resolveHeaderConnBadge 的 reason（点与字永远说同一件事，不各算一套）；
// 第三级来自 summarizeOtherWorkspaces（#sessionsDot 的数据源）。
//
// 顶栏位子只有一个，且这里的每一条都必须是「点开就能处理」的事。两条已按此出局：
//   · 推送失败（2026-09-02）——手机上无从处理，要去改网络/代理。
//   · 其他工作区 busy（2026-09-02）——「运行中」是状态不是事件，能持续几十分钟、多工作区并行时
//     接近常驻，长期亮着只会训练用户忽略这个位置，反过来拉低同槽位「需要你/出错」的信号强度；
//     点开抽屉也没有任何可执行动作。该信息由 #sessionsDot 图标承担（同一份 summarizeOtherWorkspaces
//     数据）——图标是低成本环境感知，不喊人，正合适。
// 下表因此既是色调表也是【准入表】：不在表里的状态一律不进顶栏。两者合一才不会出现
// 「有文案却没色调」的半亮态（曾经的写法以 DRAWER_STATUS_LABELS 命中为准，删色调不删文案会漏出）。
const OTHER_WORKSPACE_CHIP_TONE = { permission: 'warning', error: 'danger' };
export function resolveHeaderAttentionChip({ badgeReason = 'ok', needsYouCount = 0, otherWorkspaceStatus = null } = {}) {
  if (badgeReason === 'offline') return { visible: true, tone: 'danger', reason: 'offline', text: t('未连接') };
  if (badgeReason === 'attention') {
    const text = needsYouCount > 0 ? `${t('需要你')} ${needsYouCount}` : t('需要你');
    return { visible: true, tone: 'warning', reason: 'attention', text };
  }
  const tone = OTHER_WORKSPACE_CHIP_TONE[otherWorkspaceStatus];
  if (tone) {
    const label = DRAWER_STATUS_LABELS[otherWorkspaceStatus];
    return { visible: true, tone, reason: 'other-workspace', text: `${t('其他工作区')} · ${t(label)}` };
  }
  return { visible: false, tone: null, reason: 'ok', text: '' };
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

// session:list 响应回来后，判断内容是否真的变了再决定要不要重渲染该目录的会话行列表——避免"缓存已
// 秒开正确内容→响应回来后又无条件整段重渲"的多余闪烁/重排。hasPrevEntry=false（此前无缓存，正显示
// 骨架屏）时恒需要渲染：骨架屏必须被替换，哪怕真实数据恰好是空列表。粒度：id+title(前 40 字)+
// lastUsedAt 足以代表用户会感知到的变化，不做深度字段比对；hasMore 单独比较（决定"显示全部"按钮的
// 出现/消失，不影响每一行的签名本身）。
export function shouldRerenderSessionList({
  hasPrevEntry = false,
  prevSessions,
  prevHasMore = false,
  prevTotal = null,
  prevPinned,
  nextSessions,
  nextHasMore = false,
  nextTotal = null,
  nextPinned,
} = {}) {
  if (!hasPrevEntry) return true;
  if (!!prevHasMore !== !!nextHasMore) return true;
  // total 变化会影响「还有 N 个更早的会话」提示，即使行签名不变也要重渲。
  if ((prevTotal ?? null) !== (nextTotal ?? null)) return true;
  // terminal 进签名：CLI 进程 busy/alive 状态或副文本变化必须重渲，否则抽屉会陈旧。
  const signature = list => (Array.isArray(list) ? list : [])
    .map(s => `${s?.id || ''}:${(s?.title || '').slice(0, 40)}:${s?.lastUsedAt || ''}:${s?.terminal || ''}`)
    .join('|');
  // pinned（手动标「稍后再看」、被 limit 挤出本页而单独补回的那组）必须单独进判据：它的成员来自
  // read-state 而不是这一页，主列表签名一个字都不变时它照样会增删——用户在另一台设备上标一条、
  // 或在本机把某条标回已读，只有这里能察觉。漏掉就等于那一组永远停在首次渲染的内容上。
  if (signature(prevPinned) !== signature(nextPinned)) return true;
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
