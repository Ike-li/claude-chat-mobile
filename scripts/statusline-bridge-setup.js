#!/usr/bin/env node

// Explicit opt-in installer for the transparent CLI statusline bridge.
// Merely importing this file or running `status` never mutates user settings.

import { unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeSettingsPath, ccmUnderClaudeHome } from '../app/src/shared/claude-home.js';
import {
  assertNoInstallerSymlinks,
  atomicWriteInstallerJson,
  removeBridgeNamespace,
} from '../app/src/ops/bridge-namespace.js';
import { readClaudeSettings } from '../app/src/ops/cli-hooks-bridge.js';
import {
  readStatuslineManifest,
  statuslineInstalledStateMatches,
  statuslineRefreshInterval,
  statuslineRefreshMatches,
} from '../app/src/ops/cli-statusline-bridge.js';
import { shellQuote } from '../app/src/ops/log-terminal.js';
import { resolveStableNodePath } from './node-path.js';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'statusline-bridge.js');

function pathsForHome(home = homedir()) {
  return {
    settings: claudeSettingsPath(home),
    manifest: ccmUnderClaudeHome(home, 'statusline-v1', 'install-manifest.json'),
  };
}

const assertNoSymlinks = (home, paths) => assertNoInstallerSymlinks(home, paths, 'statusline-v1', 'statusline bridge');

// CCM_TEST_PLATFORM：仅测试用的平台覆盖开关，任何宿主 OS 上都能验证 win32 分支，不需要真机 Windows。
function currentPlatform() {
  return process.env.CCM_TEST_PLATFORM || process.platform;
}

function bridgeCommand(originalCommand, originalRefreshInterval) {
  if (currentPlatform() === 'win32') {
    // wrapper 封装依赖 POSIX shell（/bin/sh）转发原命令，Windows 上不存在。装完看似成功、
    // 实际 CLI 每次渲染状态栏都会失败——不如在装之前明确拒绝，不留半成品状态。
    throw new Error('CLI statusline bridge 尚不支持 Windows（原始命令封装依赖 POSIX shell），暂不可安装。');
  }
  // node 路径必须是稳定 symlink，不能是 process.execPath——写进 settings.json 的命令要跨
  // `brew upgrade node` 存活，否则状态栏渲染静默失效（见 ./node-path.js 头注）。
  const argv = [resolveStableNodePath(), RUNNER];
  if (typeof originalRefreshInterval === 'number'
      && Number.isFinite(originalRefreshInterval)
      && originalRefreshInterval > 0) {
    argv.push('--refresh-interval', String(originalRefreshInterval));
  }
  argv.push('--', '/bin/sh', '-lc', originalCommand);
  return argv.map(shellQuote).join(' ');
}

function looksLikeBridgeWrapper(command) {
  return typeof command === 'string'
    && /(?:^|[\\/])statusline-bridge\.js(?=['"\s]|$)/.test(command);
}

function status(home = homedir()) {
  const paths = pathsForHome(home);
  assertNoSymlinks(home, paths);
  // settings.json 还不存在是新装 claude 的合法起点：确定没装（与 ops 层 readStatuslineInstallState 同判）。
  // install 把这种情况当成还没配 statusLine，走 notConfigured 拒装。
  const settings = readClaudeSettings(paths.settings);
  const currentCommand = typeof settings.statusLine?.command === 'string'
    ? settings.statusLine.command
    : null;
  const manifest = readStatuslineManifest(paths.manifest);
  return {
    state: manifest && statuslineInstalledStateMatches(settings, manifest) ? 'installed'
      : manifest ? 'drifted'
        : 'not-installed',
    currentCommand,
    manifestExists: manifest !== null,
  };
}

// 用户还没配 statusLine：拒装是对的（桥只包一层用户自己的命令），但要说人话（验收 O105 / O125）。reason 由 main()
// 以 JSON 写到 stdout，server 透传给面板按码出文案；message 走 stderr，给敲 npm run statusline:install 的人看。
function notConfigured(settingsPath) {
  return Object.assign(
    new Error(`statusLine is not configured yet: set statusLine.command in ${settingsPath} (Claude Code's own status line) first, then install`),
    { reason: 'statusline_not_configured' },
  );
}

function install(home = homedir()) {
  const paths = pathsForHome(home);
  assertNoSymlinks(home, paths);
  // settings.json 还不存在＝新装 claude、肯定没配（同 status 的判法）；此前这里直接抛 fs 的 ENOENT
  const settings = readClaudeSettings(paths.settings);
  if (!settings.statusLine || typeof settings.statusLine !== 'object' || Array.isArray(settings.statusLine)) {
    throw notConfigured(paths.settings);
  }
  const originalCommand = settings.statusLine.command;
  if (typeof originalCommand !== 'string' || !originalCommand.trim()) {
    throw notConfigured(paths.settings);
  }
  const existingManifest = readStatuslineManifest(paths.manifest);
  if (existingManifest) {
    if (statuslineInstalledStateMatches(settings, existingManifest)) {
      return {
        state: 'installed',
        idempotent: true,
        installedCommand: existingManifest.installedCommand,
      };
    }
    if (originalCommand !== existingManifest.originalCommand || !statuslineRefreshMatches(settings, existingManifest)) {
      throw new Error('install refused: current statusLine command/refreshInterval drifted from the manifest');
    }
    // A manifest written before settings is a recoverable interrupted install.
    settings.statusLine.command = existingManifest.installedCommand;
    atomicWriteInstallerJson(paths.settings, settings);
    return {
      state: 'installed',
      idempotent: false,
      recovered: true,
      installedCommand: existingManifest.installedCommand,
    };
  }
  if (looksLikeBridgeWrapper(originalCommand)) {
    throw new Error('install refused: statusLine.command is already a bridge wrapper without its manifest');
  }
  const originalRefreshInterval = statuslineRefreshInterval(settings);
  const installedCommand = bridgeCommand(originalCommand, originalRefreshInterval);
  const manifest = { originalCommand, originalRefreshInterval, installedCommand };

  atomicWriteInstallerJson(paths.manifest, manifest, { privateParent: true });
  settings.statusLine.command = installedCommand;
  atomicWriteInstallerJson(paths.settings, settings);
  return { state: 'installed', idempotent: false, installedCommand };
}

function uninstall(home = homedir()) {
  const paths = pathsForHome(home);
  assertNoSymlinks(home, paths);
  const manifest = readStatuslineManifest(paths.manifest);
  if (!manifest) throw new Error('uninstall refused: statusline bridge manifest is missing');
  const settings = readClaudeSettings(paths.settings);
  if (!settings.statusLine || typeof settings.statusLine !== 'object' || Array.isArray(settings.statusLine)) {
    throw new Error('uninstall refused: settings.statusLine is missing');
  }
  if (!statuslineInstalledStateMatches(settings, manifest)) {
    throw new Error('uninstall CAS refused: current command/refreshInterval no longer matches installed state');
  }

  settings.statusLine.command = manifest.originalCommand;
  const originalRefreshInterval = manifest.originalRefreshInterval ?? null;
  if (originalRefreshInterval === null) delete settings.statusLine.refreshInterval;
  else settings.statusLine.refreshInterval = originalRefreshInterval;
  atomicWriteInstallerJson(paths.settings, settings);
  unlinkSync(paths.manifest);
  // 自己的命名空间（快照）一并清掉；此前要等整体 npm run uninstall（验收 O35）
  removeBridgeNamespace(home, 'statusline-v1');
  return { state: 'uninstalled', restoredCommand: manifest.originalCommand };
}

function main() {
  const action = process.argv[2];
  if (!['status', 'install', 'uninstall'].includes(action)) {
    process.stderr.write('usage: statusline-bridge-setup.js <status|install|uninstall>\n');
    process.exitCode = 64;
    return;
  }
  try {
    const result = action === 'install' ? install()
      : action === 'uninstall' ? uninstall()
        : status();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (error?.reason) process.stdout.write(`${JSON.stringify({ error: error.reason })}\n`);
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

main();
