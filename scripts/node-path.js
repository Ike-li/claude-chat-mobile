// 写进**外部配置**的 node 路径的唯一真相源（launchd plist、~/.claude/settings.json）。
//
// `process.execPath` 是解析过 symlink 的**真身**（Homebrew 下形如
// `/opt/homebrew/Cellar/node/<版本>/bin/node`，nvm 下形如 `~/.nvm/versions/node/<版本>/bin/node`）。
// 写进外部配置后，版本号一变就指向不存在的二进制。登录 shell 的 `command -v node` 给的是
// 稳定 symlink（`/opt/homebrew/bin/node`），跨升级存活。
//
// 这个坑在本仓踩过三次，前两次的教训只落成了注释和各自的局部函数，第三处照样踩：
//   ① service.js 写 plist（2026-08-13 修，`zsh -lc` 与 plist 自身的启动方式同源）
//   ② app-build.js 写 bundle（已修）
//   ③ 两个 bridge 安装器写 settings.json（2026-09-07 修——安装当时 node 25.9.0_3，
//      而 26.8.1 已在等升级；升级后 Stop/Notification hook 与 statusline 会**静默**失效，
//      表现为手机端再也收不到推送，无任何报错）
// 注释拦不住第三次，所以收敛到这一处：谁要往外部配置写 node 路径，就 import 这里。
//
// 失败方向：登录 shell 拿不到可用路径时**回落 `process.execPath`**（不拒绝安装）——
// 一个可能随升级失效的路径，总比没有路径强。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * 从登录 shell 的输出里挑出可用的 node 路径，挑不出就回落 execPath。
 * 纯函数（`exists` 注入）——真实文件系统留给调用方，便于逐分支测试。
 */
export function pickNodePath(loginShellOut, execPath, exists) {
  const first = String(loginShellOut || '').trim().split('\n')[0].trim();
  return first && exists(first) ? first : execPath;
}

/**
 * 解析出该写进外部配置的 node 路径。
 *
 * **只在写路径调用**（install / adopt）——起一个登录 shell 约 100ms，status 那种高频轮询
 * 不该付这个成本（漂移比对另有 realpath 归一，用 execPath 也能正确判等）。
 *
 * `CCM_TEST_NODE_PATH`：仅测试用的覆盖开关，避免用例为每次 install 付登录 shell 的开销、
 * 也避免断言随跑测试的机器上装了什么 node 而漂移。与 `CCM_TEST_PLATFORM` 同一类。
 */
export function resolveStableNodePath() {
  if (process.env.CCM_TEST_NODE_PATH) return process.env.CCM_TEST_NODE_PATH;
  let out = '';
  try {
    out = String(spawnSync('/bin/zsh', ['-lc', 'command -v node'], { encoding: 'utf8', timeout: 5000 })?.stdout || '');
  } catch { /* 回落 execPath */ }
  return pickNodePath(out, process.execPath, existsSync);
}
