// cli-settings-defaults.js —— 配置权威源纯函数：FRESH 会话/空首页（resolveFreshPrefs）+
// resume 场景 effort 一项的兜底（resolveResumeEffort，见下方"例外"说明）。
//
// 权威源分层（见会话设计结论）：
//   L0 用户此刻意图（pending by cwd）
//   L1 活进程（本模块不处理）
//   L2 会话持久化（resume 路径，本模块原则上不处理）
//   L3 CLI settings 合并结果（resolveSettings().effective）
//   L4 产品硬默认（mode=default, effort=null）
//
// 规则：FRESH 初值 = L0 ?? L3 ?? L4；resume 的 mode/model 禁止走本模块——L2（transcript 末档 /
// sessions.json 持久值）是比 L3 更权威的历史信号，用今天的全局 CLI settings 覆盖历史事实是错的
// （mode 见 readLastPermissionMode/ec93a2d；model 见 readLastAssistantModel）。
// 例外：resume 的 effort 允许走本模块（resolveResumeEffort）。CLI 从不把 effort 落 transcript
// （ec93a2d 记录的已知边界），sessions.json 里的 effort 又因 onSessionId 每次 init 无条件回写
// 而无法区分"用户曾显式选模型默认"与"从未有过任何信息"——resume 场景没有比 L3 更权威、可能被
// L3 误盖掉的历史事实，L3 兜底只是补全"历史事实本就不存在"时的展示/取值，风险与 mode/model
// 不对称，故单独放行。

/**
 * CCM / SDK 支持的权限档（与 @anthropic-ai/claude-agent-sdk PermissionMode 集合一致）。
 * 展示顺序：安全档在前，bypassPermissions 置底。集合由 tests/unit/permission-modes-sdk-sync 锁住。
 */
export const CCM_PERMISSION_MODES = Object.freeze([
  'default',
  'plan',
  'acceptEdits',
  'dontAsk',
  'auto',
  'bypassPermissions',
]);

/** CCM / SDK Options.effort 合法档（settings.effortLevel 通常无 max，但归一时放行） */
export const CCM_EFFORT_LEVELS = Object.freeze([
  'low', 'medium', 'high', 'xhigh', 'max',
]);

/**
 * UI 合法思考档 = SDK 五档 + ultracode。
 * ultracode 是 CLI /effort 菜单项，不是 Options.effort 字面量。
 */
export const UI_EFFORT_LEVELS = Object.freeze([
  ...CCM_EFFORT_LEVELS,
  'ultracode',
]);

/**
 * 把 settings / 入参里的权限档归一成 CCM 可识别值。
 * - 'manual' → 'default'（SDK 文档：manual 是 default 别名）
 * - 其余非白名单档 → null（调用方回落 L4）
 */
export function normalizePermissionMode(mode) {
  if (mode == null || mode === '') return null;
  if (mode === 'manual') return 'default';
  if (CCM_PERMISSION_MODES.includes(mode)) return mode;
  return null;
}

/**
 * 把 settings.effortLevel / 入参归一成 CCM effort 档。
 * null/undefined/'' → null（= 模型默认，合法）。
 * 非法字符串 → null（不当真值透传）。
 * 注意：不认 ultracode——那是 UI 档，见 normalizeEffortUiLevel。
 */
export function normalizeEffortLevel(level) {
  if (level == null || level === '') return null;
  if (CCM_EFFORT_LEVELS.includes(level)) return level;
  return null;
}

/**
 * UI → SDK effort 归一（user:setEffort / openInstance 入参）。
 * · null/'' → { ui:null, sdk:null, ultracode:false }（模型默认）
 * · ultracode → { ui:'ultracode', sdk:'xhigh', ultracode:true }（Settings.ultracode + xhigh）
 * · SDK 五档 → { ui, sdk 同值, ultracode:false }
 * · 非法 → null（调用方拒切/回落）
 *
 * 契约：docs/display-contracts.md §Effort；tests/unit/display-contracts.test.mjs 锁住。
 */
export function normalizeEffortUiLevel(level) {
  if (level === null || level === undefined || level === '') {
    return { ui: null, sdk: null, ultracode: false };
  }
  if (level === 'ultracode') {
    return { ui: 'ultracode', sdk: 'xhigh', ultracode: true };
  }
  if (CCM_EFFORT_LEVELS.includes(level)) {
    return { ui: level, sdk: level, ultracode: false };
  }
  return null;
}

/**
 * 从 resolveSettings().effective 抽出 L3 三字段（未归一前的原始意图 + 归一后的可用值）+ env 块。
 * 不抛；effective 缺失时返回硬默认形状。
 *
 * env 块：worktree 场景下 CLI 的 local source 解析到主 checkout（2.1.211+ 行为），
 * 但 SDK resolveSettings 按 cwd 正确读到 worktree 的 settings.local.json——所以这里拿到的是权威值。
 * 注意（2026-07-30 实证更正）：把它注入子进程环境**并不能**让 worktree 生效各自的网关映射，
 * CLI 的 settings.env 优先级更高。网关隔离走 buildWorktreeGatewayEnv + flag settings。
 */
export function defaultsFromEffectiveSettings(effective) {
  const rawMode = effective?.permissions?.defaultMode ?? null;
  const rawEffort = effective?.effortLevel ?? null;
  const rawModel = typeof effective?.model === 'string' && effective.model
    ? effective.model
    : undefined;
  // env 块：浅拷贝防外部修改污染缓存；非对象安全忽略
  const env = (effective?.env && typeof effective.env === 'object' && !Array.isArray(effective.env))
    ? { ...effective.env }
    : undefined;
  return {
    mode: normalizePermissionMode(rawMode) ?? 'default',
    effort: normalizeEffortLevel(rawEffort),
    // model：settings 有顶层 model 才 pin；多数环境无此键 → undefined（交给 CLI 自选 + scout/init）
    model: rawModel,
    env,
  };
}

/**
 * 从 linked worktree 的 `.git` 文件内容定位 canonical repo root（= CLI 会误读 settings.local.json 的目录）。
 * git 规范：linked worktree 的 .git 是文本文件，内容形如 `gitdir: <主仓库>/.git/worktrees/<名>`；
 * 主 checkout 的 .git 是目录，压根不会走到这里。submodule 指针（.git/modules/…）不是 worktree → null。
 *
 * @param {string|null|undefined} dotGitContent worktree 根下 .git 文件的文本内容
 * @returns {string|null} canonical repo root 绝对路径；不是 worktree 指针则 null
 */
export function parseWorktreeCanonicalRoot(dotGitContent) {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(String(dotGitContent ?? ''));
  if (!m) return null;
  const marker = '/.git/worktrees/';
  const i = m[1].indexOf(marker);
  return i > 0 ? m[1].slice(0, i) : null;
}

// 网关/模型类 env 的白名单前缀。与 agent.js filterSafeResolvedEnv 同一安全边界：
// 只碰 ANTHROPIC_*/CLAUDE_CODE_*，绝不触碰 PORT/AUTH_TOKEN/CCM_DATA_DIR 等服务端关键变量
// （中和一个服务端变量的破坏力，比放过一个网关变量更大）。
const GATEWAY_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_'];
const isGatewayEnvKey = (k) => GATEWAY_ENV_PREFIXES.some(p => k.startsWith(p));

// 已实证见过的「纯偏好」键：与网关/模型路由无关，中和它们只会让 worktree 会话平白丢掉
// 主 checkout 配的 CLI 偏好。为什么用排除清单而不是正向枚举网关键——两种错误代价不对称：
// 漏掉一个网关变量 = 污染照旧、503 复现；多清一个偏好只是小损失。故保留前缀（新网关变量自动
// 覆盖），只把确认无关的键摘出来。新键按需追加，别凭印象扩充清单。
const NON_ROUTING_ENV_KEYS = new Set([
  'CLAUDE_CODE_ATTRIBUTION_HEADER',           // commit 署名头
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', // 遥测开关
  'CLAUDE_CODE_EFFORT_LEVEL',                 // 思考档：ccm 自己经 Options.effort 传，不由 env 决定
]);
// 只用于「中和」侧：worktree 自己显式配的同名键仍照常下发（排除清单挡的是继承，不是本意）。
const shouldNeutralizeEnvKey = (k) => isGatewayEnvKey(k) && !NON_ROUTING_ENV_KEYS.has(k);

/**
 * worktree 网关隔离：产出 flag settings（SDK Options.settings）用的 env 块。
 *
 * 背景（2026-07-30 实证复现，非推断）：CLI 2.1.211+ 在 linked worktree 里把 local settings source
 * 解析到 **canonical repo root**（bundle 原文：「it resolves localSettings to the canonical repo
 * root」），于是主 checkout 的 .claude/settings.local.json 的 env 块会污染**所有** worktree 的会话——
 * worktree 自己的 settings.local.json 根本不被 CLI 读。真实症状：third-party 的会话打到主 checkout
 * 配的第三方网关，pin 的 claude-opus-5 在该网关分组无渠道 → 503 No available channel。
 *
 * 两条设计都由实证锁死，改动前先重跑对照：
 *  · **压不过**：往子进程注入 env 无效（CLI 的 settings.env 优先级高于继承环境），只能走 flag settings；
 *  · **擦不掉**：传空 env 块 `{env:{}}` 或空 settings `{}` 都无效，必须对「canonical 有而 worktree
 *    没有」的键**逐键显式写空串**中和。
 *
 * @param {object|undefined} worktreeEnv  SDK resolveSettings({cwd}) 按 worktree 正确读出的 env 块（权威）
 * @param {object|undefined} canonicalEnv canonical repo root 的 env 块（CLI 实际会误读到的那份）
 * @returns {object|undefined} flag settings 的 env；无需干预时 undefined（调用方据此不传 settings.env）
 */
export function buildWorktreeGatewayEnv(worktreeEnv, canonicalEnv) {
  const pick = (o) => (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  const out = {};
  // 先中和 canonical 的网关键（CLI 会误读这份）；纯偏好键不动，让 worktree 会话照常继承
  for (const k of Object.keys(pick(canonicalEnv))) {
    if (shouldNeutralizeEnvKey(k)) out[k] = '';
  }
  // 再让 worktree 自己显式配的网关覆盖回来——隔离不等于禁用，各 worktree 仍可各走各的网关
  for (const [k, v] of Object.entries(pick(worktreeEnv))) {
    if (isGatewayEnvKey(k)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * FRESH 会话最终采用的 mode/effort（+ 可选 model）。
 * L0 pending（has* 为真时，含 pendingEffort=null 合法）优先于 L3 cliDefaults，再回落 L4。
 *
 * @param {object} opts
 * @param {boolean} [opts.hasPendingMode]
 * @param {string|null|undefined} [opts.pendingMode]
 * @param {boolean} [opts.hasPendingEffort]
 * @param {string|null|undefined} [opts.pendingEffort]
 * @param {{ mode?: string, effort?: string|null, model?: string }} [opts.cliDefaults] L3 缓存
 */
export function resolveFreshPrefs({
  hasPendingMode = false,
  pendingMode,
  hasPendingEffort = false,
  pendingEffort,
  cliDefaults = null,
} = {}) {
  const baseMode = normalizePermissionMode(cliDefaults?.mode) ?? 'default';
  // cliDefaults.effort 显式 null 表示「settings 未设 / 模型默认」，与「缓存未命中」同形
  const baseEffort = cliDefaults && 'effort' in cliDefaults
    ? normalizeEffortLevel(cliDefaults.effort)
    : null;
  const baseModel = typeof cliDefaults?.model === 'string' && cliDefaults.model
    ? cliDefaults.model
    : undefined;

  const mode = hasPendingMode
    ? (normalizePermissionMode(pendingMode) ?? 'default')
    : baseMode;

  // pending 是 UI 档（可含 ultracode）；L3 base 仍是 SDK 五档（settings 不认 ultracode）。
  // 旧逻辑 normalizeEffortLevel(pendingEffort) 把 ultracode 剥成 null → FRESH 首条无 Settings.ultracode（H1）。
  let effort = baseEffort;
  let ultracode = false;
  if (hasPendingEffort) {
    const ui = normalizeEffortUiLevel(pendingEffort);
    if (ui) {
      effort = ui.sdk;
      ultracode = ui.ultracode;
    } else {
      effort = null;
      ultracode = false;
    }
  }

  return { mode, effort, ultracode, model: baseModel };
}

/**
 * RESUME 会话 effort 兜底链（resume 场景专用；FRESH 走 resolveFreshPrefs，不要混用）。
 * 权威源优先级：saved（sessions.json 持久值）> inherited（同 cwd 存活实例继承）> L3 CLI settings > null（L4）。
 *
 * 三层一律经 normalizeEffortLevel 归一——它把 null/undefined/''/非法档统一收作 null，这天然让
 * "显式记了 null"与"压根没记"在这条链里等价、一并继续往下兜底，不再被当成"已确定的终值"锁死。
 * 这是刻意选择：sessions.json 的 effort=null 从第一天起就有两种成因——用户在 user:setEffort 里
 * 显式选"模型默认"，或某次 resume 冷启动在真无信息时兜底写回的 null——两者落盘后字面完全同形，
 * 本函数也无意新增字段去区分。这不丢真实语义：null 在本产品里只表示"不强制覆盖，--effort 不传，
 * 交给 CLI 自己的 settings.effortLevel 决定"（agent.js this.effort 用法），CLI 自己决定的依据正是
 * L3；用户当下主动选"模型默认"的意图经 openInstance 的显式 effort 参数分支立即生效，不经过、
 * 也不依赖本函数——本函数只管"当下没有显式意图时，该按什么权威顺序找一个此刻值得展示/采用的档"。
 *
 * @param {object} opts
 * @param {string|null|undefined} [opts.savedEffort] sessions.json 持久值（saved?.effort，键不存在则 undefined）
 * @param {string|null|undefined} [opts.inheritedEffortValue] 同 cwd 存活实例继承档（inheritedEffort(cwd)）
 * @param {{ effort?: string|null }|null} [opts.cliDefaults] L3 缓存（cliDefaultsByCwd.get(cwd) || null）
 * @returns {string|null}
 */
export function resolveResumeEffort({ savedEffort, inheritedEffortValue, cliDefaults = null } = {}) {
  const saved = normalizeEffortLevel(savedEffort);
  const inherited = normalizeEffortLevel(inheritedEffortValue);
  const l3 = cliDefaults && 'effort' in cliDefaults ? normalizeEffortLevel(cliDefaults.effort) : null;
  return saved ?? inherited ?? l3 ?? null;
}
