#!/usr/bin/env node

// claude CLI hook runner（由用户全局 ~/.claude/settings.json 的 hooks 段调用）。
//
// 契约红线：
//  1. **stdout 恒空**——Stop hook 的 stdout 会被 CLI 当决策 JSON 解析（可返回 {decision:'block'}
//     阻断行为）。诊断一律走 stderr，且只在 CCM_HOOKS_DEBUG=1 时输出。
//  2. **恒 exit 0 / 吞掉一切异常**——ccm 不在、目录不可写、磁盘满……都不能让用户的 claude 会话受影响。
//  3. **CCM_HOOKS_ORIGIN=web-sdk 直接退出**——web 驱动的 SDK 子进程同样加载用户全局 hooks
//     （settingSources 含 user），不抑制则同一轮会经 SDK result 与 hook 两条路重复推送。

import {
  normalizeCliHookInput,
  resolveHookDirs,
  writeCliHookEvent,
} from '../app/src/ops/cli-hooks-bridge.js';

const DEBUG = process.env.CCM_HOOKS_DEBUG === '1';
// 看门狗：正常路径 <100ms 就结束；stdin 永不 EOF 之类的异常不能把 hook 挂住拖慢用户的回合。
const WATCHDOG_MS = 2000;

function debug(message) {
  if (DEBUG) process.stderr.write(`[ccm-hooks] ${message}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
    // 输入是一小段事件 JSON；超量即视为异常输入，不再吃
    if (chunks.reduce((n, c) => n + c.length, 0) > 1024 * 1024) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function run() {
  if (process.env.CCM_HOOKS_ORIGIN === 'web-sdk') return;
  const raw = await readStdin();
  const event = normalizeCliHookInput(raw, { capturedAt: Date.now() });
  if (!event) { debug('input ignored (unparsable or not a watched event)'); return; }
  const { eventsDir } = resolveHookDirs(process.env); // 与 server/安装器共用解析
  const written = writeCliHookEvent(event, { dir: eventsDir });
  debug(written ? `wrote ${written}` : 'inbox full — event dropped');
}

const watchdog = setTimeout(() => {
  debug('watchdog fired');
  process.exit(0);
}, WATCHDOG_MS);
watchdog.unref?.();

try {
  await run();
} catch (error) {
  debug(`failed: ${error?.message || error}`);
} finally {
  clearTimeout(watchdog);
  process.exitCode = 0;
}
