// cli-settings-defaults.js —— FRESH 会话 / 空首页的配置权威源（L3 CLI settings）纯函数。
//
// 权威源分层（见会话设计结论）：
//   L0 用户此刻意图（pending by cwd）
//   L1 活进程（本模块不处理）
//   L2 会话持久化（resume 路径，本模块不处理）
//   L3 CLI settings 合并结果（resolveSettings().effective）
//   L4 产品硬默认（mode=default, effort=null）
//
// 规则：FRESH 初值 = L0 ?? L3 ?? L4；resume 禁止走本模块。

/** CCM 支持的权限档（与 server user:setPermissionMode / 前端 select 对齐；含 SDK 的 auto） */
export const CCM_PERMISSION_MODES = Object.freeze([
  'default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto',
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
