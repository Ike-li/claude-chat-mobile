// scratch-root.js —— 「无文件夹」会话的 scratch 根目录，唯一解析点。
//
// 【为什么不放在 CCM_DATA_DIR 下】数据目录缺省是 <仓库>/data，就在 CCM 自己的 git 仓库里。
// 会话 cwd 落在那里，CLI 会向上加载 CCM 仓库的 CLAUDE.md 与 .claude/settings，`git status` 也会报出
// CCM 仓库——模型以为自己在 CCM 仓库里干活。scratch 必须落在任何仓库之外。
//
// 【为什么是系统应用数据目录】与官方 Claude 桌面端同一做法（它放在 userData/scratch-workspaces，
// 2026-09-23 从安装包实证）；2026-09-24 机主选定。不开配置项：测试靠 mkdtemp 的 HOME / XDG_DATA_HOME
// 或直接传参隔离（与 claude-home.js 带 home 形参同一理由：为了可测，不是为了支持多个根）。
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIR = 'claude-chat-mobile';
const SCRATCH_DIR = 'scratch-workspaces';

export function scratchRoot({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR, SCRATCH_DIR);
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), APP_DIR, SCRATCH_DIR);
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), APP_DIR, SCRATCH_DIR);
}
