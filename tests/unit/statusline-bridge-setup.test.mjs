import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SETUP = join(ROOT, 'scripts', 'statusline-bridge-setup.js');

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'ccm-statusline-setup-'));
}

function settingsPath(home) {
  return join(home, '.claude', 'settings.json');
}

function manifestPath(home) {
  return join(home, '.claude', 'ccm', 'statusline-v1', 'install-manifest.json');
}

function writeSettings(home, statusLine) {
  const path = settingsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ theme: 'dark', statusLine }, null, 2), { mode: 0o600 });
  return path;
}

function runSetup(home, action, extraEnv = {}) {
  return spawnSync(process.execPath, [SETUP, action], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
  });
}

test('status：未安装时只读报告，不创建 manifest 或改写 settings', () => {
  const home = makeHome();
  try {
    const path = writeSettings(home, {
      type: 'command',
      command: 'bash /tmp/original-statusline.sh',
      refreshInterval: 60,
    });
    const before = readFileSync(path, 'utf8');

    const result = runSetup(home, 'status');

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      state: 'not-installed',
      currentCommand: 'bash /tmp/original-statusline.sh',
      manifestExists: false,
    });
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(existsSync(manifestPath(home)), false);
    assert.equal(existsSync(join(home, '.claude', 'ccm')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install：先以 0600 manifest 原子备份原命令/刷新周期，再安装透明 wrapper', {
  skip: process.platform === 'win32',
}, () => {
  const home = makeHome();
  try {
    const originalCommand = 'bash /tmp/original-statusline.sh --compact';
    const path = writeSettings(home, {
      type: 'command',
      command: originalCommand,
      refreshInterval: 60,
    });

    const result = runSetup(home, 'install');

    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.state, 'installed');
    assert.equal(response.idempotent, false);

    const manifestFile = manifestPath(home);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(manifest, {
      originalCommand,
      originalRefreshInterval: 60,
      installedCommand: manifest.installedCommand,
    });
    assert.equal(settings.theme, 'dark', '非 statusLine 设置必须保留');
    assert.equal(settings.statusLine.type, 'command');
    assert.equal(settings.statusLine.refreshInterval, 60);
    assert.equal(settings.statusLine.command, manifest.installedCommand);
    assert.notEqual(manifest.installedCommand, originalCommand);
    assert.match(manifest.installedCommand, /scripts\/statusline-bridge\.js/);
    assert.match(manifest.installedCommand, /--refresh-interval/);
    assert.match(manifest.installedCommand, /original-statusline\.sh/);
    assert.equal(statSync(manifestFile).mode & 0o777, 0o600);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dirname(manifestFile)), ['install-manifest.json']);
    assert.equal(readdirSync(dirname(path)).some(name => name.includes('.tmp')), false);

    const statusResult = runSetup(home, 'status');
    assert.equal(statusResult.status, 0, statusResult.stderr);
    assert.deepEqual(JSON.parse(statusResult.stdout), {
      state: 'installed',
      currentCommand: manifest.installedCommand,
      manifestExists: true,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// install 的 wrapper 封装依赖 POSIX shell（/bin/sh），在 win32 上不存在——原实现此前在 win32
// 下从未被跑过（上面的 install 测试整体 skip），装完看似成功、实际 CLI 每次渲染状态栏都会失败。
// 改为在装之前明确拒绝：不留半成品状态。CCM_TEST_PLATFORM 是仅测试用的覆盖开关（见 bridgeCommand），
// 跑在任何宿主 OS 上都能验证 win32 分支，不需要真机 Windows。
test('install：win32 下明确拒绝，不写入 manifest/settings', () => {
  const home = makeHome();
  try {
    const originalCommand = 'bash /tmp/original-statusline.sh --compact';
    const path = writeSettings(home, { type: 'command', command: originalCommand, refreshInterval: 60 });
    const before = readFileSync(path, 'utf8');

    const result = runSetup(home, 'install', { CCM_TEST_PLATFORM: 'win32' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Windows/);
    assert.equal(readFileSync(path, 'utf8'), before, 'settings.json 不应被改写');
    assert.equal(existsSync(manifestPath(home)), false, '不应写入 manifest');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install：重复执行幂等，不覆盖原始备份也不把 wrapper 再套一层', () => {
  const home = makeHome();
  try {
    const originalCommand = 'bash /tmp/idempotent-statusline.sh';
    const path = writeSettings(home, {
      type: 'command', command: originalCommand, refreshInterval: 30,
    });
    const first = runSetup(home, 'install');
    assert.equal(first.status, 0, first.stderr);
    const firstSettings = readFileSync(path, 'utf8');
    const firstManifest = readFileSync(manifestPath(home), 'utf8');

    const second = runSetup(home, 'install');

    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).idempotent, true);
    assert.equal(readFileSync(path, 'utf8'), firstSettings);
    assert.equal(readFileSync(manifestPath(home), 'utf8'), firstManifest);
    const installed = JSON.parse(firstManifest).installedCommand;
    assert.equal((installed.match(/scripts\/statusline-bridge\.js/g) || []).length, 1);
    assert.equal(JSON.parse(firstManifest).originalCommand, originalCommand);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install：检测到无 manifest 的既有 bridge wrapper 时拒绝套娃且零改写', () => {
  const home = makeHome();
  try {
    const orphanedWrapper = "'/usr/bin/node' '/other/repo/scripts/statusline-bridge.js' '--' '/bin/sh' '-lc' 'old-renderer'";
    const path = writeSettings(home, {
      type: 'command', command: orphanedWrapper, refreshInterval: 60,
    });
    const before = readFileSync(path, 'utf8');

    const result = runSetup(home, 'install');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /refused|wrapper/i);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(existsSync(manifestPath(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall：当前命令仍是已安装 wrapper 时恢复原命令/刷新周期并删除 manifest', () => {
  const home = makeHome();
  try {
    const originalCommand = 'bash /tmp/restore-me.sh';
    const path = writeSettings(home, {
      type: 'command', command: originalCommand, refreshInterval: 45,
    });
    const installed = runSetup(home, 'install');
    assert.equal(installed.status, 0, installed.stderr);

    const result = runSetup(home, 'uninstall');

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      state: 'uninstalled',
      restoredCommand: originalCommand,
    });
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(settings.statusLine.command, originalCommand);
    assert.equal(settings.statusLine.refreshInterval, 45);
    assert.equal(existsSync(manifestPath(home)), false);
    const statusResult = runSetup(home, 'status');
    assert.equal(statusResult.status, 0, statusResult.stderr);
    assert.equal(JSON.parse(statusResult.stdout).state, 'not-installed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall：用户安装后改过 command 时 CAS 拒绝覆盖，保留用户设置与 manifest', () => {
  const home = makeHome();
  try {
    const path = writeSettings(home, {
      type: 'command', command: 'bash /tmp/before-install.sh', refreshInterval: 60,
    });
    const installed = runSetup(home, 'install');
    assert.equal(installed.status, 0, installed.stderr);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    settings.statusLine.command = 'bash /tmp/user-changed-after-install.sh';
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
    const userVersion = readFileSync(path, 'utf8');
    const manifestVersion = readFileSync(manifestPath(home), 'utf8');

    const statusResult = runSetup(home, 'status');
    assert.equal(JSON.parse(statusResult.stdout).state, 'drifted');
    const result = runSetup(home, 'uninstall');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CAS|refused|current command/i);
    assert.equal(readFileSync(path, 'utf8'), userVersion);
    assert.equal(readFileSync(manifestPath(home), 'utf8'), manifestVersion);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall：用户安装后改过 refreshInterval 时同样视为 drift，CAS 拒绝覆盖', () => {
  const home = makeHome();
  try {
    const path = writeSettings(home, {
      type: 'command', command: 'bash /tmp/refresh-before.sh', refreshInterval: 60,
    });
    assert.equal(runSetup(home, 'install').status, 0);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    settings.statusLine.refreshInterval = 10;
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
    const userVersion = readFileSync(path, 'utf8');
    const manifestVersion = readFileSync(manifestPath(home), 'utf8');

    const statusResult = runSetup(home, 'status');
    assert.equal(JSON.parse(statusResult.stdout).state, 'drifted');
    const result = runSetup(home, 'uninstall');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CAS|refresh|drift/i);
    assert.equal(readFileSync(path, 'utf8'), userVersion);
    assert.equal(readFileSync(manifestPath(home), 'utf8'), manifestVersion);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install：settings.json 是 symlink 时 fail-closed，不静默替换 dotfiles 链接', {
  skip: process.platform === 'win32',
}, () => {
  const home = makeHome();
  try {
    const settings = settingsPath(home);
    mkdirSync(dirname(settings), { recursive: true });
    const target = join(home, 'managed-settings.json');
    const raw = JSON.stringify({ statusLine: { type: 'command', command: 'bash /tmp/managed.sh', refreshInterval: 60 } }, null, 2);
    writeFileSync(target, raw, { mode: 0o600 });
    symlinkSync(target, settings);

    const result = runSetup(home, 'install');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink|symbolic/i);
    assert.equal(lstatSync(settings).isSymbolicLink(), true);
    assert.equal(readFileSync(target, 'utf8'), raw);
    assert.equal(existsSync(manifestPath(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install：dangling settings/manifest symlink 同样 fail-closed，不被原子写替换', {
  skip: process.platform === 'win32',
}, () => {
  for (const managedPath of ['settings', 'manifest']) {
    const home = makeHome();
    try {
      const settings = settingsPath(home);
      if (managedPath === 'settings') {
        mkdirSync(dirname(settings), { recursive: true });
        symlinkSync(join(home, 'missing-settings-target.json'), settings);
      } else {
        writeSettings(home, {
          type: 'command', command: 'bash /tmp/original-statusline.sh', refreshInterval: 60,
        });
        const manifest = manifestPath(home);
        mkdirSync(dirname(manifest), { recursive: true });
        symlinkSync(join(home, 'missing-manifest-target.json'), manifest);
      }
      const beforeSettings = managedPath === 'manifest' ? readFileSync(settings, 'utf8') : null;
      const path = managedPath === 'settings' ? settings : manifestPath(home);

      const result = runSetup(home, 'install');

      assert.equal(result.status, 1, `${managedPath}: ${result.stderr}`);
      assert.match(result.stderr, /symlink|symbolic/i);
      assert.equal(lstatSync(path).isSymbolicLink(), true, `${managedPath} symlink 必须保留`);
      if (beforeSettings !== null) assert.equal(readFileSync(settings, 'utf8'), beforeSettings);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});
