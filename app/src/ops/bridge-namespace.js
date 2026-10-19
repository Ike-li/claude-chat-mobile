// bridge-namespace.js —— 卸载一座 CLI 桥时，清掉它在 ~/.claude/ccm 下自己的命名空间（验收 O35）
//
// 两座桥各自在 ~/.claude/ccm/<桥>-v1 下放安装清单与运行期产物（hooks：默认 events / acks 与 verify 回执；
// statusline：快照）。单独卸载桥此前只恢复 settings.json、删 manifest，这些目录原样留着，只有整体
// `npm run uninstall` 才清（scripts/uninstall.js 的 residue 步骤）。
//
// 只认两座桥的字面量目录名：路径各段都不来自外部输入。用户把 CLI_HOOKS_DIR 指到命名空间外的自定义目录，
// 那不是我们建的，绝不碰。~/.claude/ccm 只剩空目录（或 macOS 的 .DS_Store）时一并移除，有别的东西就留着。

import { readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ccmUnderClaudeHome } from '../shared/claude-home.js';

const BRIDGE_NAMESPACES = new Set(['hooks-v1', 'statusline-v1']);

export function removeBridgeNamespace(home, name) {
  if (!BRIDGE_NAMESPACES.has(name)) throw new Error(`unknown bridge namespace: ${name}`);
  // safe-rm: name 只能是上面两个字面量之一，路径是调用方注入的 home（生产为 homedir()）+ '.claude/ccm/<name>'，
  // 各段都不来自外部输入；两个调用方（桥的 uninstall）只在 settings 已按 manifest 恢复、manifest 已删之后才调用
  rmSync(ccmUnderClaudeHome(home, name), { recursive: true, force: true });

  const ccmDir = ccmUnderClaudeHome(home);
  let entries;
  try { entries = readdirSync(ccmDir); } catch { return; }
  if (entries.length === 1 && entries[0] === '.DS_Store') {
    unlinkSync(join(ccmDir, '.DS_Store')); // safe-path: 字面量文件名，目录为 ccmUnderClaudeHome(home)
    entries = [];
  }
  if (!entries.length) rmdirSync(ccmDir); // safe-path: 非递归 rmdir，只删空目录，路径各段为字面量 + 注入 home
}
