// logic/permissions.js —— 权限档枚举与 tile 规格（与 SDK PermissionMode 对齐）
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

// ---- 权限档：与 @anthropic-ai/claude-agent-sdk PermissionMode 枚举对齐 ----
// SDK 仅类型层有枚举、无运行时 list；本数组 = 前端显示/校验的权威源，由
// tests/unit/permission-modes-sdk-sync.test.mjs 与 sdk.d.ts + 后端 CCM_PERMISSION_MODES 锁集合。
// 展示顺序：安全档在前，bypassPermissions 置底（危险档）。
//
// 文案不走 i18n：与 CLI / 桌面端菜单同源英文（Manual / Accept edits / Plan / …），
// 协议值仍是 default|acceptEdits|…（manual 是 default 的 CLI 别名）。
export const SDK_PERMISSION_MODES = Object.freeze([
  'default',
  'plan',
  'acceptEdits',
  'dontAsk',
  'auto',
  'bypassPermissions',
]);

export function isSdkPermissionMode(mode) {
  return SDK_PERMISSION_MODES.includes(mode);
}

/**
 * CLI / 桌面端展示名 + SDK 注释级说明（固定英文，禁止 t()/中文本地化）。
 * title/pill/bar 对齐桌面菜单：Manual · Accept edits · Plan · Auto · Bypass permissions
 * （dontAsk 桌面菜单常不露出，用 SDK 语义 Don't ask）。
 */
const PERMISSION_MODE_TILE_META = Object.freeze({
  default: {
    title: 'Manual',
    desc: 'Prompts for dangerous operations',
    selectLabel: 'Manual',
    pill: 'Manual',
    bar: 'Manual',
    danger: false,
  },
  plan: {
    title: 'Plan',
    desc: 'Planning mode, no tool execution',
    selectLabel: 'Plan',
    pill: 'Plan',
    bar: 'Plan',
    danger: false,
  },
  acceptEdits: {
    title: 'Accept edits',
    desc: 'Auto-accept file edit operations',
    selectLabel: 'Accept edits',
    pill: 'Accept edits',
    bar: 'Accept edits',
    danger: false,
  },
  dontAsk: {
    title: "Don't ask",
    desc: 'Deny if not pre-approved, no prompts',
    selectLabel: "Don't ask",
    pill: "Don't ask",
    bar: "Don't ask",
    danger: false,
  },
  auto: {
    title: 'Auto',
    desc: 'Model classifier approves or denies',
    selectLabel: 'Auto',
    pill: 'Auto',
    bar: 'Auto',
    danger: false,
  },
  bypassPermissions: {
    title: 'Bypass permissions',
    desc: 'Bypass all permission checks',
    selectLabel: 'Bypass permissions',
    pill: 'Bypass',
    bar: 'Bypass permissions',
    danger: true,
  },
});

/**
 * 按 SDK 清单生成权限磁贴规格（只数据，不碰 DOM；文案固定英文，调用方勿再 t()）。
 * @param {readonly string[]} [modes=SDK_PERMISSION_MODES]
 * @returns {{ id: string, title: string, desc: string, selectLabel: string, pill: string, bar: string, danger: boolean }[]}
 */
export function permissionModeTileSpecs(modes = SDK_PERMISSION_MODES) {
  const list = Array.isArray(modes) ? modes : SDK_PERMISSION_MODES;
  return list.filter(isSdkPermissionMode).map((id) => {
    const meta = PERMISSION_MODE_TILE_META[id];
    return {
      id,
      title: meta?.title || id,
      desc: meta?.desc || '',
      selectLabel: meta?.selectLabel || id,
      pill: meta?.pill || id,
      bar: meta?.bar || id,
      danger: Boolean(meta?.danger),
    };
  });
}
