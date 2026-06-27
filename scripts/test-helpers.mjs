// scripts/test-helpers.mjs —— smoke 脚本共享工具（零 npm 依赖，仅 node: 内置 + socket.io-client）
// 用途：消除 14 个 smoke 脚本中重复的 check/sleep/waitHealth/connectSocket/spawnServer 等模式。
//
// 用法示例：
//   import { makeChecker, sleep, waitHealth, connectSocket, spawnServer, makeWorkDir } from './test-helpers.mjs';
//   const { check, exitOnFailure } = makeChecker();
//   const workDir = makeWorkDir('ccm-test-');
//   const server = spawnServer(port, workDir);
//   await waitHealth(port);
//   const { socket, events } = await connectSocket(port);
//   // ... 测试逻辑 ...
//   socket.close(); killServer(server); rmWorkDir(workDir);
//   exitOnFailure();

import { io } from 'socket.io-client';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- 1. 断言收集器 ----
// 返回 { check, results, summary, exitOnFailure }
export function makeChecker() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  };
  const summary = () => {
    const passed = results.filter(r => r.ok).length;
    console.log(`\n${passed}/${results.length} 通过`);
    return { passed, total: results.length, results };
  };
  const exitOnFailure = () => {
    const { passed, total } = summary();
    process.exit(passed === total ? 0 : 1);
  };
  return { check, results, summary, exitOnFailure };
}

// ---- 2. 休眠 ----
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 3. 轮询 /health 等待 server ready ----
// 默认超时 15s，轮询间隔 200ms。
export function waitHealth(port, ms = 15000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/health`, r => {
        r.resume();
        if (r.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      function retry() {
        if (Date.now() > deadline) return reject(new Error(`server 健康检查超时 (port=${port})`));
        setTimeout(tick, 200);
      }
    };
    tick();
  });
}

// ---- 4. Socket.IO 连接（带超时 + 事件收集） ----
// 返回 { socket, events }。events 会收集所有 agent:event。
// opts: { auth, label, timeoutMs, port } —— auth 默认 { token: '' }
export function connectSocket(port, opts = {}) {
  const { auth = { token: '' }, label = '', timeoutMs = 6000 } = opts;
  const url = `http://127.0.0.1:${port}`;
  const events = [];
  const socket = io(url, { auth, reconnection: false, timeout: 5000 });
  socket.on('agent:event', ev => events.push(ev));
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve({ socket, events }));
    socket.on('connect_error', e => reject(new Error(`connect_error${label ? ' (' + label + ')' : ''}: ${e.message}`)));
    setTimeout(() => reject(new Error(`connect 超时${label ? ' (' + label + ')' : ''}`)), timeoutMs);
  });
}

// ---- 5. 临时工作目录 ----
export function makeWorkDir(prefix = 'ccm-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}
export function rmWorkDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---- 6. Server 子进程生命周期 ----
// 启动 server.js 子进程，返回 ChildProcess。
// 用法：const server = spawnServer(port, workDir, { CLAUDE_BIN: '/usr/local/bin/claude' });
export function spawnServer(port, workDir, extraEnv = {}) {
  const ROOT = join(import.meta.dirname, '..');
  const env = {
    ...process.env,
    AUTH_TOKEN: '',
    PORT: String(port),
    WORK_DIR: workDir,
    ...extraEnv,
  };
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 消费 stdout/stderr 防止背压
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  return server;
}

export function killServer(server) {
  try { if (server && !server.killed) server.kill('SIGTERM'); } catch {}
}

// ---- 7. 注册安全退出（SIGINT/SIGTERM → cleanup → exit） ----
// 返回 unregister 函数（可选）。
export function onSignal(cleanup) {
  const handler = () => { cleanup(); process.exit(130); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, handler);
  return () => { for (const sig of ['SIGINT', 'SIGTERM']) process.off(sig, handler); };
}

// ---- 8. 事件辅助 ----
// 反向查找最后一个指定类型事件（常见模式：lastPM / lastEffort / lastPermissionMode）
export const lastEventOf = (events, type) => [...events].reverse().find(e => e.type === type);

// 等待事件（轮询），返回匹配的事件；超时抛错。
export function waitEvent(events, pred, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待事件超时 ${ms}ms`)), ms);
    const iv = setInterval(() => {
      const hit = events.find(pred);
      if (hit) { clearTimeout(t); clearInterval(iv); resolve(hit); }
    }, 100);
  });
}

// mark/since 模式：mark() 返回当前事件数，since(i) 返回 i 之后的新事件。
export function eventCursor(events) {
  return {
    mark: () => events.length,
    since: i => events.slice(i),
  };
}
