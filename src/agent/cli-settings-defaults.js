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
 */
export function normalizeEffortLevel(level) {
  if (level == null || level === '') return null;
  if (CCM_EFFORT_LEVELS.includes(level)) return level;
  return null;
}

/**
 * 从 resolveSettings().effective 抽出 L3 三字段（未归一前的原始意图 + 归一后的可用值）。
 * 不抛；effective 缺失时返回硬默认形状。
 */
export function defaultsFromEffectiveSettings(effective) {
  const rawMode = effective?.permissions?.defaultMode ?? null;
  const rawEffort = effective?.effortLevel ?? null;
  const rawModel = typeof effective?.model === 'string' && effective.model
    ? effective.model
    : undefined;
  return {
    mode: normalizePermissionMode(rawMode) ?? 'default',
    effort: normalizeEffortLevel(rawEffort),
    // model：settings 有顶层 model 才 pin；多数环境无此键 → undefined（交给 CLI 自选 + scout/init）
    model: rawModel,
  };
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

  const effort = hasPendingEffort
    ? normalizeEffortLevel(pendingEffort)
    : baseEffort;

  return { mode, effort, model: baseModel };
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
