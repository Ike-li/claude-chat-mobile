#!/usr/bin/env node

// Explicit opt-in installer for the transparent CLI statusline bridge.
// Merely importing this file or running `status` never mutates user settings.

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'statusline-bridge.js');

function pathsForHome(home = homedir()) {
  return {
    settings: join(home, '.claude', 'settings.json'),
    manifest: join(home, '.claude', 'ccm', 'statusline-v1', 'install-manifest.json'),
  };
}

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
    join(home, '.claude'),
    join(home, '.claude', 'ccm'),
    join(home, '.claude', 'ccm', 'statusline-v1'),
    paths.settings,
    paths.manifest,
  ];
  for (const path of candidates) {
    if (lstatIfPresent(path)?.isSymbolicLink()) {
      throw new Error(`statusline bridge refused symbolic link path: ${path}`);
    }
  }
}

function readSettings(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claude settings must be a JSON object');
  }
  return parsed;
}

function readManifest(path) {
  const stat = lstatIfPresent(path);
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    throw new Error(`statusline bridge refused symbolic link path: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.originalCommand !== 'string'
      || typeof parsed.installedCommand !== 'string') {
    throw new Error('statusline bridge manifest is invalid');
  }
  return parsed;
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
  const argv = [process.execPath, RUNNER];
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

function refreshIntervalOf(settings) {
  return Object.hasOwn(settings?.statusLine || {}, 'refreshInterval')
    ? settings.statusLine.refreshInterval
    : null;
}

function installedStateMatches(settings, manifest) {
  return settings.statusLine?.command === manifest.installedCommand
    && Object.is(refreshIntervalOf(settings), manifest.originalRefreshInterval);
}

function status(home = homedir()) {
  const paths = pathsForHome(home);
  assertNoInstallerSymlinks(home, paths);
  const settings = readSettings(paths.settings);
  const currentCommand = typeof settings.statusLine?.command === 'string'
    ? settings.statusLine.command
    : null;
  const manifest = readManifest(paths.manifest);
  return {
    state: manifest && installedStateMatches(settings, manifest) ? 'installed'
      : manifest ? 'drifted'
        : 'not-installed',
    currentCommand,
    manifestExists: manifest !== null,
  };
}

function install(home = homedir()) {
  const paths = pathsForHome(home);
  assertNoInstallerSymlinks(home, paths);
  const settings = readSettings(paths.settings);
  if (!settings.statusLine || typeof settings.statusLine !== 'object' || Array.isArray(settings.statusLine)) {
    throw new Error('settings.statusLine must be configured before install');
  }
  const originalCommand = settings.statusLine.command;
  if (typeof originalCommand !== 'string' || !originalCommand.trim()) {
    throw new Error('settings.statusLine.command must be a non-empty string');
  }
  const existingManifest = readManifest(paths.manifest);
  if (existingManifest) {
    const refreshMatches = Object.is(refreshIntervalOf(settings), existingManifest.originalRefreshInterval);
    if (originalCommand === existingManifest.installedCommand && refreshMatches) {
      return {
        state: 'installed',
        idempotent: true,
        installedCommand: existingManifest.installedCommand,
      };
    }
    if (originalCommand !== existingManifest.originalCommand || !refreshMatches) {
      throw new Error('install refused: current statusLine command/refreshInterval drifted from the manifest');
    }
    // A manifest written before settings is a recoverable interrupted install.
    settings.statusLine.command = existingManifest.installedCommand;
    atomicWriteJson(paths.settings, settings);
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
  const originalRefreshInterval = refreshIntervalOf(settings);
  const installedCommand = bridgeCommand(originalCommand, originalRefreshInterval);
  const manifest = { originalCommand, originalRefreshInterval, installedCommand };

  atomicWriteJson(paths.manifest, manifest, { privateParent: true });
  settings.statusLine.command = installedCommand;
  atomicWriteJson(paths.settings, settings);
  return { state: 'installed', idempotent: false, installedCommand };
}

function uninstall(home = homedir()) {
  const paths = pathsForHome(home);
  assertNoInstallerSymlinks(home, paths);
  const manifest = readManifest(paths.manifest);
  if (!manifest) throw new Error('uninstall refused: statusline bridge manifest is missing');
  const settings = readSettings(paths.settings);
  if (!settings.statusLine || typeof settings.statusLine !== 'object' || Array.isArray(settings.statusLine)) {
    throw new Error('uninstall refused: settings.statusLine is missing');
  }
  if (!installedStateMatches(settings, manifest)) {
    throw new Error('uninstall CAS refused: current command/refreshInterval no longer matches installed state');
  }

  settings.statusLine.command = manifest.originalCommand;
  if (manifest.originalRefreshInterval === null) delete settings.statusLine.refreshInterval;
  else settings.statusLine.refreshInterval = manifest.originalRefreshInterval;
  atomicWriteJson(paths.settings, settings);
  unlinkSync(paths.manifest);
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
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

main();
