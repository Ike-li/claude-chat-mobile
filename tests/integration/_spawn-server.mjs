// tests/integration/_spawn-server.mjs —— 集成测试共用：起真实 app/server.js 子进程（非 ESM 动态 import）。
//
// 审计 TC-004：claude-lifecycle.test.mjs（CL-2 需要用不同 IDLE_TIMEOUT_MS 重配置）与
// websocket-events.test.mjs（WS-5 需要切换 AUTH_TOKEN、WS-6 需要真实"重启"）此前都靠
// cleanup() + 再次 import('../../app/server.js') 模拟"重启/重配置"，但 ESM 按 URL 缓存模块——
// 第二次 import 拿到的是同一个（已 close 的）httpServer/io 引用，模块顶层读取的 env
// （IDLE_TIMEOUT_MS/AUTH_TOKEN 等）也不会重新求值，不会真的重启或应用新配置。
//
// 改为真起子进程（同 tests/integration/server.test.mjs 已验证过的 nonce + 就绪探测模式）：
// kill 掉旧进程、spawn 新进程即为真重启/真重配置，无需依赖 ESM 模块缓存行为。
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { stripInheritedEnv } from '../helpers/spawn-env.mjs';

// 端口选择：向 OS 要一个当前空闲的端口（listen(0) 拿到后立刻释放），而不是从 30000-40000 里随机抽签。
//
// 抽签在启动数少时够用，但 2026-08-02 把 auth-token / cf-access-gate 改成「每用例一台 server」后，
// 一次 test:integration 的启动数从 ~6 台涨到 ~25 台。生日问题：25 台在 10000 个槽里至少撞一次的
// 概率 ≈ 1 - exp(-25×24/20000) ≈ 3%，而实测就是 29 轮里飘红 1 次（≈3.4%）——量级对得上。
// listen(0) 之后仍有 TOCTOU 窗口（拿到端口到子进程 bind 之间），但窗口是微秒级，且 OS 在临时端口
// 段内是递增分配、不会把同一个端口同时发给两个并发请求者——比抽签低几个数量级。
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    request(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject).end();
  });
}

// envOverrides 覆盖/追加子进程环境变量（如 AUTH_TOKEN/IDLE_TIMEOUT_MS/CCM_DATA_DIR/WORK_DIR/PORT）。
// 传 PORT 可固定端口（如 WS-6 需要重启后端口不变）；不传则随机取高位端口。
// 返回 { proc, port, buildNonce }；成功后调用方负责最终 killServer(proc)，启动失败则本 helper 自行回收 child。
// 可选 hooks 只供本 helper 的回归测试注入进程/HTTP/时间外部边界；正常调用永远使用 Node 实现。
export function createServerSpawner({
  spawnProcess = spawn,
  requestHealth = httpGet,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxAttempts = 40,
  pickPort = reserveFreePort,
  baseEnv = process.env,   // 注入点仅供本 helper 的回归测试构造「脏」环境；正常调用永远是 process.env
} = {}) {
  return async function spawnServer(envOverrides = {}) {
    // 调用方显式传 PORT 时一律照用（如 WS-6 要求「重启后端口不变」），只有不传时才向 OS 要空闲端口。
    const port = envOverrides.PORT ? Number(envOverrides.PORT) : await pickPort();
    const buildNonce = `inttest-${randomUUID()}`;
    const proc = spawnProcess('node', ['app/server.js'], {
      env: {
        // 摘掉继承来的生产键（CF_ACCESS_*/VAPID_* 等，见 tests/helpers/spawn-env.mjs）。
        // 排在 envOverrides 之前：摘的是「继承来的」，不是「调用方显式要的」——cf-access-gate
        // 那批用例正要自己构造 CF 场景。
        ...stripInheritedEnv(baseEnv),
        DEV_MODE: '0', // 同 server.test.mjs：隔离机主 .env 里的 DEV_MODE，防 dev:restart 误触发
        ...envOverrides,
        PORT: String(port),        // 覆盖 envOverrides 里可能的 PORT，确保和上面算出的 port 一致
        CCM_BUILD_NONCE: buildNonce,
        // 让 config 保留调用方明确传入的空 AUTH/CF 值直到 dotenv 结束，防主 .env 回填测试认证配置。
        CCM_TEST_PRESERVE_EMPTY_ENV: '1',
        // 桌面日志窗（osascript→Terminal.app）：测试永不启。机主 .env 的 LOG_TERMINAL=on 会经
        // ...process.env 继承；关窗依赖优雅退出，SIGKILL/zsh job 确认框下常留窗。放在 overrides 之后，
        // 调用方也不能误开。用非空 'off'（只认 'on' 才启用）——空串在 dotenv 规整路径可能被清掉后回填。
        LOG_TERMINAL: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd()
    });

    let earlyExit = null;
    proc.on('exit', (code, sig) => { earlyExit = { code, sig }; });
    proc.on('error', err => { earlyExit = { error: err.message }; });

    // /health 挂在 httpAuth 之后（设了 AUTH_TOKEN 时需要 ?token=，否则 401）——探测必须带上同一个
    // token，否则 AUTH_TOKEN 场景（如 WS-5 鉴权测试）会一直收到 401、被下面的 catch 吞掉，误判超时。
    const authToken = envOverrides.AUTH_TOKEN;
    const healthUrl = `http://127.0.0.1:${port}/health${authToken ? `?token=${encodeURIComponent(authToken)}` : ''}`;
    try {
      for (let i = 0; i < maxAttempts; i++) {
        if (earlyExit) throw new Error(`server 子进程提前退出，启动失败：${JSON.stringify(earlyExit)}`);
        await sleep(250);
        try {
          const h = JSON.parse(await requestHealth(healthUrl));
          if (h.status === 'ok' && h.buildNonce === buildNonce) return { proc, port, buildNonce };
          // status:ok 但 nonce 不符 = 端口上是别的进程（旧 checkout / 未退实例）——继续轮询直至超时报错。
        } catch { /* 尚未起来 / 401 / 非 JSON */ }
      }
      throw new Error(`Server startup timeout（端口 ${port} 未出现本轮 nonce 的 /health${earlyExit ? '；子进程已退出' : ''}）`);
    } catch (err) {
      try { await killServer(proc); } catch { /* child 已退出或回收失败时仍保留原启动错误 */ }
      throw err;
    }
  };
}

export const spawnServer = createServerSpawner();

function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const onExit = () => finish(true);
    const finish = exited => {
      clearTimeout(timer);
      proc.off('exit', onExit);
      resolve(exited);
    };
    proc.once('exit', onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// 通用条件等待。原本活在 tests/helpers/integration.mjs 里，但那个文件自 9cd8a21 起【零 import 者】
// —— 于是现役集成测试一直在用裸 sleep(N) 猜时序（2026-08-02 盘点：33 处 / 16 个文件）。删死文件时把这个
// 正确的原语搬过来扶正。fn 可同步可异步；真值即通过，超时抛带 label 的错（比 node:test 的泛型超时好查）。
export async function waitForCondition(fn, { timeoutMs = 5000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err; // 探测期的瞬时失败（连接被拒等）不算失败，超时才报最后一次原因
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待「${label}」超时（${timeoutMs}ms）${lastError ? `：${lastError.message}` : ''}`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

// in-process 起 server 的测试文件（await import('../../app/server.js')）此前一律用 `await sleep(500)` 当就绪
// 信号——既是猜（慢机器上可能不够）又是浪费（快机器上白等）。改成探真 /health：设了 AUTH_TOKEN 时必须
// 带上，否则一路 401 被当成「还没起来」空等到超时。
export async function waitForServerReady(port, token = null, { timeoutMs = 10_000 } = {}) {
  const url = `http://127.0.0.1:${port}/health${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  return waitForCondition(
    async () => JSON.parse(await httpGet(url)).status === 'ok',
    { timeoutMs, label: `server ${port} /health` },
  );
}

export async function killServer(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try { proc.kill('SIGTERM'); } catch { return; }
  if (await waitForExit(proc, 3000)) return;
  try { proc.kill('SIGKILL'); } catch { return; }
  await waitForExit(proc, 3000);
}
