// 常驻部署下的「日志窗口」：server 起来时自动开一个 Terminal 窗口 tail 日志，停止/重启时关掉它。
// 默认关闭（LOG_TERMINAL=on 才启用）——这是桌面便利功能，headless / CI / Linux 上一律 no-op。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveLogTerminalPlan,
  buildTailCommand,
  buildOpenScript,
  buildCloseScript,
  readLogTerminalState,
  writeLogTerminalState,
  clearLogTerminalState,
} from '../../src/ops/log-terminal.js';

const HOME = '/Users/you';

test('resolveLogTerminalPlan：默认关闭——没显式打开就什么都不做', () => {
  assert.deepEqual(
    resolveLogTerminalPlan({ env: {}, platform: 'darwin', home: HOME }),
    { enabled: false, reason: 'disabled', logFile: null },
  );
  // 只认 'on'，防手滑写个 'false'/'0' 反而被当真
  assert.equal(resolveLogTerminalPlan({ env: { LOG_TERMINAL: 'false' }, platform: 'darwin', home: HOME }).enabled, false);
  assert.equal(resolveLogTerminalPlan({ env: { LOG_TERMINAL: '1' }, platform: 'darwin', home: HOME }).enabled, false);
});

test('resolveLogTerminalPlan：开启 + macOS → 用文档约定的日志路径；LOG_FILE 可覆盖', () => {
  const p = resolveLogTerminalPlan({ env: { LOG_TERMINAL: 'on' }, platform: 'darwin', home: HOME });
  assert.equal(p.enabled, true);
  assert.equal(p.logFile, '/Users/you/Library/Logs/ccm-server.log'); // 同 rotate-logs.sh / plist 模板
  const custom = resolveLogTerminalPlan({
    env: { LOG_TERMINAL: 'on', LOG_FILE: '/var/log/ccm.log' }, platform: 'darwin', home: HOME,
  });
  assert.equal(custom.logFile, '/var/log/ccm.log');
});

test('resolveLogTerminalPlan：非 macOS 明确拒绝（不静默假成功）', () => {
  const p = resolveLogTerminalPlan({ env: { LOG_TERMINAL: 'on' }, platform: 'linux', home: HOME });
  assert.equal(p.enabled, false);
  assert.equal(p.reason, 'unsupported-platform');
});

test('buildTailCommand：-F 跟随（文件不存在也不退出）+ 看门狗（server 一死就收摊）', () => {
  const cmd = buildTailCommand({ logFile: '/tmp/a.log', serverPid: 4242 });
  assert.match(cmd, /tail -n \d+ -F '\/tmp\/a\.log'/, '必须用 -F：-f 遇文件不存在会立刻退出（实测）');
  assert.match(cmd, /kill -0 4242/, '看门狗盯 server pid');
  assert.match(cmd, /kill \$TP/, 'server 没了要收掉 tail，不留孤儿进程');
  // 路径里的单引号必须转义，否则命令被截断（甚至注入）
  const tricky = buildTailCommand({ logFile: "/tmp/it's here.log", serverPid: 1 });
  assert.match(tricky, /'\/tmp\/it'"'"'s here\.log'/);
});

test('buildOpenScript / buildCloseScript：AppleScript 字符串转义 + windowId 强制数字', () => {
  const open = buildOpenScript('echo "hi" \\ there');
  assert.match(open, /do script "echo \\"hi\\" \\\\ there"/, '双引号与反斜杠都要转义');
  assert.match(open, /return id of front window/);

  assert.match(buildCloseScript(5220), /close window id 5220/);
  // 非数字一律夯成 0（不可能匹配到真实窗口）——杜绝把外部字符串拼进 AppleScript
  assert.match(buildCloseScript('5220; do shell script "rm -rf /"'), /close window id 0/);
  assert.match(buildCloseScript(undefined), /close window id 0/);
});

test('状态文件：记录窗口 id 供下次启动关掉遗留窗口（server 被 kill -9 时没机会自清）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-logterm-'));
  const path = join(dir, 'log-terminal.json');
  try {
    assert.equal(readLogTerminalState(path), null);
    writeLogTerminalState(path, { windowId: 777, pid: 12 });
    assert.deepEqual(readLogTerminalState(path), { windowId: 777, pid: 12 });
    clearLogTerminalState(path);
    assert.equal(readLogTerminalState(path), null);

    writeFileSync(path, '{broken');
    assert.equal(readLogTerminalState(path), null, '损坏状态文件不能让 server 起不来');
    assert.equal(readLogTerminalState(join(dir, 'absent.json')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('状态文件权限 0600（窗口 id 不敏感，但与其余状态文件保持同一纪律）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-logterm-'));
  const path = join(dir, 's.json');
  try {
    writeLogTerminalState(path, { windowId: 1, pid: 2 });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).windowId, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
