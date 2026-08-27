// claude-home.js —— Claude Code CLI 自己那套目录的路径拼装，唯一一处。
//
// 【为什么收敛】`~/.claude` 与 `~/.claude/projects` 此前在仓里有近十处独立字面量
// （history.js、cli-mirror-state.js、app.js 两处、两个桥的 setup、uninstall、doctor-runtime…）。
// 值当然都一样，问题是**没有任何东西保证它们一起变**：哪天要跟随 CLI 调整这个约定，
// 就得靠人把十处找全，而漏掉的那处会静默读到空目录 —— 历史为空、镜像态为空，都不报错。
//
// 【为什么不读 CLAUDE_CONFIG_DIR】CLI 与 SDK 都认那个 env（projects 根 =
// `(CLAUDE_CONFIG_DIR ?? ~/.claude)/projects`），本仓有意不认，理由在 src/sessions/history.js
// 的 CLAUDE_DIR 注释里：L2 删除走 SDK 官方 deleteSession，它只认真实根、没有自定义根的口子；
// 这边单独支持只能隔离"读"、隔离不了 SDK 的"删"，反而造出读写目录分叉。
// 这个取舍由 doctor 的 CLAUDE_CONFIG_DIR 检查项负责告知用户（见 doctor-checks.js）。
// 收敛到本文件不改变这个决定，只是让它有唯一一个可改的落点。

import { homedir } from 'node:os';
import { join } from 'node:path';

/** CLI 配置目录名。单独导出是因为有些调用点要自己拼（如 `<workdir>/.claude/settings.json`）。 */
export const CLAUDE_DIR_NAME = '.claude';

/** transcript 根目录。CLI /resume 与本仓历史/镜像读的是同一处。 */
export const CLAUDE_PROJECTS_DIR = join(homedir(), CLAUDE_DIR_NAME, 'projects');

/**
 * 指定 home 下的 CLI 配置目录。
 * 带参数是为了可测（单测传 mkdtemp 出来的一次性目录），不是为了支持多 home。
 */
export function claudeHome(home = homedir()) {
  return join(home, CLAUDE_DIR_NAME);
}

/** 指定 home 下的 CLI 全局 settings.json。两个桥的安装/卸载与 doctor 都读它。 */
export function claudeSettingsPath(home = homedir()) {
  return join(claudeHome(home), 'settings.json');
}

/** 本产品写进 CLI 目录的东西全部收在这一层下（两个桥的投递箱/快照/manifest）。一键卸载据此对称移除。 */
export function ccmUnderClaudeHome(home = homedir(), ...segments) {
  return join(claudeHome(home), 'ccm', ...segments);
}
