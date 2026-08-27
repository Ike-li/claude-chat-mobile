#!/usr/bin/env node

// CLI hooks 桥的显式安装器（status / install / uninstall / verify）。
// 仅 import 本文件或跑 status 绝不改用户配置——与 statusline-bridge-setup.js 同一套纪律：
// symlink fail-closed、原子写、先写 manifest 再改 settings（中断可恢复）、幂等、CAS 卸载。
//
// 与 statusline 安装器的**结构差异**：那边是"替换一个字符串字段"，这边是"往数组追加一个条目"。
// 因此 manifest 额外记录我们创建了哪些容器（hooks 对象 / 各事件数组），卸载时才能精确还原：
// 只摘掉自己那条，用户既有条目一字不动，只有我们自己创建且清空后的容器才回收。

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfigFileValues } from '../src/ops/config-file.js';

import {
  HOOK_EVENT_LIST,
  HOOK_TIMEOUT_SEC,
  HOOK_VERIFY_PREFIX,
  hooksInstalledStateMatches,
  hooksPathsForHome,
  matchingHookIndexes,
  readClaudeSettings,
  readHookVerifyAck,
  readHooksManifest,
  resolveHookDirs,
  scanHookEvents,
} from '../src/ops/cli-hooks-bridge.js';
import { claudeHome, ccmUnderClaudeHome } from '../src/shared/claude-home.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNNER = join(ROOT, 'scripts', 'hooks-bridge.js');
const VERIFY_FILE_TIMEOUT_MS = 5000;
const VERIFY_ACK_TIMEOUT_MS = 3000;
const VERIFY_POLL_MS = 50;

// 路径与安装态判定全部复用 src/ops/cli-hooks-bridge.js——server 侧（启动日志 / UI 按钮）也要判
// 同一件事，两处各写一份迟早分叉。
const pathsForHome = hooksPathsForHome;

// 与 server inbox / runner 共用同一份路径解析
const eventsDir = () => resolveHookDirs(process.env).eventsDir;
const acksDir = () => resolveHookDirs(process.env).acksDir;

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertNoInstallerSymlinks(home, paths) {
  const candidates = [
    claudeHome(home),
    ccmUnderClaudeHome(home),
    ccmUnderClaudeHome(home, 'hooks-v1'),
    paths.settings,
    paths.manifest,
  ];
  for (const path of candidates) {
    if (lstatIfPresent(path)?.isSymbolicLink()) {
      throw new Error(`hooks bridge refused symbolic link path: ${path}`);
    }
  }
}



function atomicWriteJson(path, value, { privateParent = false } = {}) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: privateParent ? 0o700 : 0o755 });
  if (privateParent && process.platform !== 'win32') chmodSync(parent, 0o700);
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  let renamed = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    renamed = true;
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve original error */ }
    }
    if (!renamed) {
      try { unlinkSync(temporary); } catch { /* absent or already cleaned */ }
    }
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

// CCM_TEST_PLATFORM：仅测试用的平台覆盖开关，任何宿主 OS 上都能验证 win32 分支。
function currentPlatform() {
  return process.env.CCM_TEST_PLATFORM || process.platform;
}

function bridgeHookCommand() {
  if (currentPlatform() === 'win32') {
    throw new Error('CLI hooks 桥尚不支持 Windows（命令形态依赖 POSIX 路径与引号规则），暂不可安装。');
  }
  return [process.execPath, RUNNER].map(shellQuote).join(' ');
}

function hookEntryFor(command) {
  return { hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SEC }] };
}

function looksLikeHooksBridge(command) {
  return typeof command === 'string' && /(?:^|[\\/])hooks-bridge\.js(?=['"\s]|$)/.test(command);
}

function entriesOf(settings, event) {
  const list = settings?.hooks?.[event];
  return Array.isArray(list) ? list : null;
}



function status(home = homedir()) {
  const paths = pathsForHome(home);
  assertNoInstallerSymlinks(home, paths);
  const settings = readClaudeSettings(paths.settings);
  const manifest = readHooksManifest(paths.manifest);
  return {
    state: manifest && hooksInstalledStateMatches(settings, manifest) ? 'installed'
      : manifest ? 'drifted'
        : 'not-installed',
    manifestExists: manifest !== null,
  };
}

function applyInstall(settings, installedCommand, events) {
  const createdHooksObject = !settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks);
  if (createdHooksObject) settings.hooks = {};
  const createdArray = {};
  for (const event of events) {
    const existing = settings.hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`install refused: settings.hooks.${event} exists but is not an array`);
    }
    createdArray[event] = existing === undefined;
    if (createdArray[event]) settings.hooks[event] = [];
    // 追加而非覆盖：用户既有 hook 条目原样保留
    if (!matchingHookIndexes(settings, event, installedCommand).length) {
      settings.hooks[event].push(hookEntryFor(installedCommand));
    }
  }
  return { createdHooksObject, createdArray };
}

function install(home = homedir()) {
  const paths = pathsForHome(home);
  assertNoInstallerSymlinks(home, paths);
  const settings = readClaudeSettings(paths.settings);
  const existingManifest = readHooksManifest(paths.manifest);

  if (existingManifest) {
    if (hooksInstalledStateMatches(settings, existingManifest)) {
      return { state: 'installed', idempotent: true, installedCommand: existingManifest.installedCommand };
    }
    // manifest 在、settings 里却没有（或不完整）——中断的安装，按 manifest 补完。
    // 若用户是自己动过我们的条目（drifted），补完同样是把它恢复成 manifest 记录的形态。
    const containers = applyInstall(settings, existingManifest.installedCommand, existingManifest.events);
    atomicWriteJson(paths.manifest, { ...existingManifest, ...containers }, { privateParent: true });
    atomicWriteJson(paths.settings, settings);
    return { state: 'installed', idempotent: false, recovered: true, installedCommand: existingManifest.installedCommand };
  }

  const installedCommand = bridgeHookCommand();
  for (const event of HOOK_EVENT_LIST) {
    const list = entriesOf(settings, event) || [];
    if (list.some(entry => (entry?.hooks || []).some(h => looksLikeHooksBridge(h?.command)))) {
      throw new Error('install refused: a hooks-bridge entry already exists without its manifest');
    }
  }
  // 先在内存里套用（非法形态在此抛出，settings/manifest 都还没落盘 → 零改写）
  const draft = JSON.parse(JSON.stringify(settings));
  const containers = applyInstall(draft, installedCommand, HOOK_EVENT_LIST);
  // 写序：manifest 先落盘。中断在此 → 下次 install 走上面的 recovered 分支补完；
  // 反序（先改 settings）中断会留下一条无主 hook，卸载无从下手。
  atomicWriteJson(paths.manifest, { installedCommand, events: HOOK_EVENT_LIST, ...containers }, { privateParent: true });
  atomicWriteJson(paths.settings, draft);
  return { state: 'installed', idempotent: false, installedCommand };
}

function uninstall(home = homedir()) {
  const paths = pathsForHome(home);
  assertNoInstallerSymlinks(home, paths);
  const manifest = readHooksManifest(paths.manifest);
  if (!manifest) throw new Error('uninstall refused: hooks bridge manifest is missing');
  const settings = readClaudeSettings(paths.settings);
  if (!hooksInstalledStateMatches(settings, manifest)) {
    throw new Error('uninstall CAS refused: hooks entries no longer match the installed state');
  }
  for (const event of manifest.events) {
    const list = entriesOf(settings, event);
    if (!list) continue;
    const [index] = matchingHookIndexes(settings, event, manifest.installedCommand);
    list.splice(index, 1);
    // 只回收我们自己创建的空容器；用户原本就有的空数组保持原样
    if (!list.length && manifest.createdArray?.[event]) delete settings.hooks[event];
  }
  if (manifest.createdHooksObject && settings.hooks && !Object.keys(settings.hooks).length) {
    delete settings.hooks;
  }
  atomicWriteJson(paths.settings, settings);
  unlinkSync(paths.manifest);
  return { state: 'uninstalled' };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// L2 探活：任何 HTTP 响应（含 401）都证明 server 在跑——刻意不带 token，安装器因此完全不需要
// 知道 AUTH_TOKEN，也就不必去读 .env 里的密钥。
function probeServerAlive(port) {
  const result = spawnSync(process.execPath, ['-e', `
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    fetch('http://127.0.0.1:${port}/health', { signal: ctrl.signal })
      .then(() => { clearTimeout(timer); process.exit(0); })
      .catch(() => { clearTimeout(timer); process.exit(1); });
  `], { timeout: 3000 });
  return result.status === 0;
}

function resolvePort() {
  const fromEnv = Number(process.env.PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  // 走统一配置层而不是手写正则抠 .env 的 PORT 行：那段正则对 ccm.config.json 完全失明，
  // 会让改过端口的用户静默拿到 3000 —— 而 hooks 桥拿这个端口去做回环验证，
  // 结果是「装好了但验证连不上」，最难排查的那类症状。
  const { values } = readConfigFileValues(ROOT);
  const fromFile = Number(values.PORT);
  if (Number.isFinite(fromFile) && fromFile > 0) return fromFile;
  return 3000;
}

// 回环验证：用合成 stdin 真执行一遍刚写进 settings 的那条命令。验的是 CLI 将来会走的完整链路
// （node 路径、脚本路径、目录可建可写、权限正确），不是"我们以为写对了"。
function verify(home = homedir()) {
  const paths = pathsForHome(home);
  const manifest = readHooksManifest(paths.manifest);
  if (!manifest) throw new Error('尚未安装（没有 install-manifest.json）——先跑 npm run hooks:install');
  const settings = readClaudeSettings(paths.settings);
  if (!hooksInstalledStateMatches(settings, manifest)) {
    throw new Error('安装状态已漂移：settings.json 里的 hook 条目与安装记录不一致，先跑 npm run hooks:status 检查');
  }

  const verifyId = `${HOOK_VERIFY_PREFIX}${randomUUID()}`;
  const input = JSON.stringify({ hook_event_name: 'Stop', session_id: verifyId, cwd: ROOT });
  // 必须显式清掉 CCM_HOOKS_ORIGIN：本步是**模拟一次真实终端触发**，而安装器自己可能正跑在 ccm 的
  // SDK 子进程里（用户让 web 端的 claude 执行 npm run hooks:install 就是这种情形），继承下来会让
  // runner 按抑制规则静默退出，验证于是恒报"文件级失败"——把好功能误判成坏的。实测踩到。
  const verifyEnv = { ...process.env, CCM_HOOKS_ORIGIN: '' };
  const run = spawnSync('/bin/sh', ['-c', manifest.installedCommand], {
    input, encoding: 'utf8', timeout: VERIFY_FILE_TIMEOUT_MS, env: verifyEnv,
  });

  // L1 文件级：事件文件是否真的落盘（server 不在也能验）
  let fileLevel = 'failed';
  const deadline = Date.now() + VERIFY_FILE_TIMEOUT_MS;
  let seen = null;
  while (Date.now() < deadline) {
    const { events } = scanHookEvents({ dir: eventsDir(), now: Date.now(), maxFiles: 200 });
    seen = events.find(e => e.sessionId === verifyId) || seen;
    if (seen) { fileLevel = 'ok'; break; }
    sleepSync(VERIFY_POLL_MS);
  }
  if (fileLevel !== 'ok') {
    return {
      verify: {
        fileLevel, serviceLevel: 'skipped', verifyId,
        command: manifest.installedCommand,
        stderr: String(run.stderr || '').trim().split('\n').pop() || '',
      },
    };
  }

  // L2 服务级：server 在线时它会消费掉 verify 事件并写 ack 回执。
  // 注意 L1 已经把事件从投递箱里读走了——这里补写一次给 server 消费。
  let serviceLevel = 'skipped';
  const port = resolvePort();
  if (probeServerAlive(port)) {
    spawnSync('/bin/sh', ['-c', manifest.installedCommand], { input, encoding: 'utf8', timeout: VERIFY_FILE_TIMEOUT_MS, env: verifyEnv });
    serviceLevel = 'unconsumed';
    const ackDeadline = Date.now() + VERIFY_ACK_TIMEOUT_MS;
    while (Date.now() < ackDeadline) {
      if (readHookVerifyAck(verifyId, { dir: acksDir() })) { serviceLevel = 'ok'; break; }
      sleepSync(VERIFY_POLL_MS);
    }
  }
  return { verify: { fileLevel, serviceLevel, verifyId, port } };
}

function reportVerify(v) {
  const lines = ['', '回环验证'];
  if (v.fileLevel === 'ok') lines.push(`✓ 文件级：模拟执行 hook 命令 → 事件已落盘 ${eventsDir()}`);
  else {
    lines.push('✗ 文件级验证失败：执行 hook 命令未产出事件文件。');
    lines.push(`  命令：${v.command}`);
    if (v.stderr) lines.push(`  stderr：${v.stderr}`);
    lines.push('安装未回滚；排查后 npm run hooks:verify 重试，或 npm run hooks:uninstall 干净移除。');
    return lines.join('\n');
  }
  if (v.serviceLevel === 'ok') {
    lines.push(`✓ 服务级：server（127.0.0.1:${v.port}）在线并已即时消费该事件`);
    lines.push('', '✅ 安装成功，端到端验证通过。');
  } else if (v.serviceLevel === 'skipped') {
    lines.push('- 服务级：server 未运行，跳过消费验证');
    lines.push('', '✅ 安装成功（文件级验证通过）。启动 server 后即完整生效；可随时 npm run hooks:verify 补跑端到端验证。');
  } else {
    lines.push(`⚠ 服务级：server 在线但 ${VERIFY_ACK_TIMEOUT_MS / 1000} 秒内未消费。可能原因：`);
    lines.push('  · server 是旧版本（不含 hooks 支持）→ 重启它（桌面端菜单里 server 一行点「重启」，headless 在原终端）');
    lines.push('  · 配置里设了 CLI_HOOKS_BRIDGE=off');
    lines.push('  · ~/.claude/ccm/hooks-v1/ 目录状态异常 → node scripts/doctor.js');
    lines.push('安装本身已完成；修复后 npm run hooks:verify 重验。');
  }
  lines.push('提示：已在跑的 claude 终端会话需重开才会加载 hooks；卸载 npm run hooks:uninstall。');
  return lines.join('\n');
}

function main() {
  const action = process.argv[2];
  if (!['status', 'install', 'uninstall', 'verify'].includes(action)) {
    process.stderr.write('usage: hooks-bridge-setup.js <status|install|uninstall|verify>\n');
    process.exitCode = 64;
    return;
  }
  try {
    if (action === 'status') {
      process.stdout.write(`${JSON.stringify(status())}\n`);
      return;
    }
    if (action === 'uninstall') {
      process.stdout.write(`${JSON.stringify(uninstall())}\n`);
      return;
    }
    if (action === 'verify') {
      const result = verify();
      process.stdout.write(`${reportVerify(result.verify)}\n`);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.verify.fileLevel === 'ok' ? 0 : 1;
      return;
    }
    const installed = install();
    process.stdout.write('CLI hooks 桥安装\n');
    process.stdout.write(`✓ 备份清单已写入 ${pathsForHome().manifest}\n`);
    process.stdout.write('✓ 已在 ~/.claude/settings.json 注册 Stop / Notification 两个 hook（你已有的 hooks 原样保留）\n');
    const result = verify();
    process.stdout.write(`${reportVerify(result.verify)}\n`);
    process.stdout.write(`${JSON.stringify({ ...installed, ...result })}\n`);
    process.exitCode = result.verify.fileLevel === 'ok' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

main();
