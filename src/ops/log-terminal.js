// log-terminal.js —— 常驻部署的「日志窗口」：server 启动时自动开一个 Terminal 窗口 tail 日志，
// 停止/重启时把它关掉。默认关闭，`LOG_TERMINAL=on` 才启用。
//
// 定位：这是**桌面便利功能**，不是运行时依赖。任何一步失败都只打一行日志继续跑——server 绝不能
// 因为开不出窗口而起不来。headless / CI / Linux 一律 no-op（明确 reason，不静默假成功）。
//
// 只支持 macOS：靠 osascript 驱动 Terminal.app。Linux 的终端模拟器没有统一入口
// （gnome-terminal / konsole / xterm 各说各话，还得先有 X/Wayland 会话），与其瞎猜不如不做。
//
// 实测踩到的两个点（2026-07-26，本机 Terminal.app）：
//   · `tail -f` 对不存在的文件会立刻退出 → 必须用 `-F`（按名字跟随、文件没出现就等着）。
//   · `close window id N` 生效，但紧接着枚举 `windows` 仍可能列出该窗口（Terminal 的集合里留了个
//     取不到 selected tab 的僵尸条目）。别据此判定"关失败"而重试。
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 与 scripts/rotate-logs.sh 默认值、deploy/server.plist.template 示例同一约定
const DEFAULT_LOG_FILE_SUFFIX = ['Library', 'Logs', 'ccm-server.log'];
const TAIL_LINES = 200;
const OSASCRIPT_TIMEOUT_MS = 5000;

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function appleScriptQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// 只认显式的 'on'：写成 'false'/'0'/'no' 反而被当"真值"启用是经典脚枪。
export function resolveLogTerminalPlan({ env = process.env, platform = process.platform, home = '' } = {}) {
  if (env.LOG_TERMINAL !== 'on') return { enabled: false, reason: 'disabled', logFile: null };
  if (platform !== 'darwin') return { enabled: false, reason: 'unsupported-platform', logFile: null };
  const logFile = env.LOG_FILE || join(home, ...DEFAULT_LOG_FILE_SUFFIX);
  return { enabled: true, reason: 'ok', logFile };
}

// 窗口里跑的命令：后台 tail + 盯 server pid 的看门狗。
// 看门狗的意义在"非优雅退出"：server 被 kill -9 / 崩了的时候没人来关窗口，至少让 tail 自己收摊、
// 窗口留一行说明，而不是留一个永远转下去、看着像还活着的假象。
export function buildTailCommand({ logFile, serverPid, title = 'ccm-server log' }) {
  return [
    `printf '\\033]0;${title}\\007'`,
    `tail -n ${TAIL_LINES} -F ${shellQuote(logFile)} & TP=$!`,
    `while kill -0 ${Number(serverPid) || 0} 2>/dev/null; do sleep 1; done`,
    'kill $TP 2>/dev/null',
    `echo; echo '[ccm] server 已停止，此窗口可关闭'`,
  ].join('; ');
}

export function buildOpenScript(command) {
  return [
    'tell application "Terminal"',
    `  do script ${appleScriptQuote(command)}`,
    '  return id of front window',
    'end tell',
  ].join('\n');
}

// windowId 强制转数字：这个值来自状态文件（磁盘），绝不能原样拼进 AppleScript。
export function buildCloseScript(windowId) {
  return [
    'tell application "Terminal"',
    '  try',
    `    close window id ${Number(windowId) || 0}`,
    '  end try',
    'end tell',
  ].join('\n');
}

export function logTerminalStatePath(dataDir) {
  return join(dataDir, 'log-terminal.json');
}

export function readLogTerminalState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Number.isFinite(parsed.windowId)) return null;
    return parsed;
  } catch {
    return null; // 缺失/损坏一律当没有：绝不让一个便利功能的状态文件挡住启动
  }
}

export function writeLogTerminalState(path, state) {
  try {
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  } catch { /* 写不了就下次启动少关一个窗口，不值得打断启动 */ }
}

export function clearLogTerminalState(path) {
  try { unlinkSync(path); } catch { /* 本就不存在 */ }
}

function runOsascript(script, { timeout = OSASCRIPT_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    execFile('osascript', ['-e', script], { timeout }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim());
    });
  });
}

// 启动：先关掉上次遗留的窗口（server 被强杀时没机会自清），再开新的并记下 id。
export async function startLogTerminal({
  env = process.env, platform = process.platform, home = '', dataDir, pid = process.pid,
  log = console,
} = {}) {
  const plan = resolveLogTerminalPlan({ env, platform, home });
  if (!plan.enabled) {
    if (plan.reason === 'unsupported-platform') {
      log.log?.('[log-terminal] LOG_TERMINAL=on 仅支持 macOS，已跳过');
    }
    return null;
  }
  const statePath = logTerminalStatePath(dataDir);
  const stale = readLogTerminalState(statePath);
  if (stale) await runOsascript(buildCloseScript(stale.windowId));
  const raw = await runOsascript(buildOpenScript(buildTailCommand({ logFile: plan.logFile, serverPid: pid })));
  const windowId = Number(raw);
  if (!Number.isFinite(windowId) || !windowId) {
    // 最典型的原因是没给「自动化」权限（首次会弹系统授权框）——说清楚，别让人以为功能坏了
    log.warn?.('[log-terminal] 打开日志窗口失败（若首次使用，请在系统设置→隐私与安全性→自动化里允许控制「终端」）');
    clearLogTerminalState(statePath);
    return null;
  }
  writeLogTerminalState(statePath, { windowId, pid });
  log.log?.(`[log-terminal] 已打开日志窗口（${plan.logFile}）`);
  return windowId;
}

// 同步版，专给退出路径用：shutdown() 紧接着就 process.exit，异步 osascript 根本来不及跑完。
// 关不掉也无所谓——窗口里的看门狗最多 1 秒后就会收掉 tail 并留一行"server 已停止"，不会假装还活着。
export function stopLogTerminalSync({ dataDir, log = console } = {}) {
  const statePath = logTerminalStatePath(dataDir);
  const state = readLogTerminalState(statePath);
  if (!state) return false;
  clearLogTerminalState(statePath);
  try {
    execFileSync('osascript', ['-e', buildCloseScript(state.windowId)], {
      timeout: OSASCRIPT_TIMEOUT_MS, stdio: 'ignore',
    });
    log.log?.('[log-terminal] 已关闭日志窗口');
    return true;
  } catch {
    return false;
  }
}

// 停止/重启：关掉自己开的那个窗口。只认状态文件里记的 id——绝不去猜、更不碰用户自己的窗口。
export async function stopLogTerminal({ dataDir, log = console } = {}) {
  const statePath = logTerminalStatePath(dataDir);
  const state = readLogTerminalState(statePath);
  if (!state) return false;
  clearLogTerminalState(statePath);
  await runOsascript(buildCloseScript(state.windowId));
  log.log?.('[log-terminal] 已关闭日志窗口');
  return true;
}
