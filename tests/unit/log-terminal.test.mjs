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

// 实测（2026-07-28）：server 关停时 stopLogTerminalSync 立刻调 close window，而窗口里的看门狗
// 是 `while kill -0 $pid; do sleep 1; done` 轮询，最多有近 1 秒还卡在前台的 sleep/tail 上——
// 直接 close 撞上 Terminal「是否终止正在运行的进程（sleep, tail）」系统确认框，只能鼠标点掉。
// 修法一版：close 前发 Ctrl-C（ASCII 3，走 pty 驱动层直接送 SIGINT，不依赖 shell 正在等输入，
// 前台卡在 sleep 里一样能打断）+ kill 掉后台 tail + exit。真机复测仍会弹框，但内容变了——
// 这次是 zsh 自己的「you have running jobs.」拦截：kill 信号刚发出、zsh job table 还没来得及
// 收到子进程死亡的 SIGCHLD 就跑到了 exit，zsh 见 job 表里 tail 还"在"，第一次 exit 只警告不退出
// （zsh 对未处理完的 job 退出保护是「警告一次，紧接着再退一次就强制退」，这是 zsh 交互 shell
// 的既定行为，不是我们能从外部一次性绕开的竞态）。修法二版：注入串尾巴再加一个 exit——
// 第一个 exit 吃掉警告，第二个 exit 无视残留 job 强制退出。shell 退出后 Terminal 才不会再问。
test('buildCloseScript：close 前发 Ctrl-C 打断看门狗 + 杀 tail + 退出两次（吃掉 zsh 的 running-jobs 警告）', () => {
  const script = buildCloseScript(5220);
  assert.match(script, /ASCII character 3/, '必须真发 Ctrl-C（SIGINT）才能打断前台卡在 sleep 里的看门狗循环');
  assert.match(script, /do script[\s\S]*kill \$TP 2>\/dev\/null; exit; exit[\s\S]*in window id 5220/,
    'exit 两次：zsh 对刚杀掉、job table 还没收到 SIGCHLD 的残留 job 会在第一次 exit 时只警告不退出');
  assert.match(script, /close window id 5220/, '仍保留 close 兜底——万一 Terminal 没有自动收掉空 shell 窗口');
  // windowId 消毒规则不能因为新增内容而失守
  assert.match(buildCloseScript('5220; do shell script "rm -rf /"'), /in window id 0/);
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
