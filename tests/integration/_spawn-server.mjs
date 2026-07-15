// tests/integration/_spawn-server.mjs —— 集成测试共用：起真实 server.js 子进程（非 ESM 动态 import）。
//
// 审计 TC-004：claude-lifecycle.test.mjs（CL-2 需要用不同 IDLE_TIMEOUT_MS 重配置）与
// websocket-events.test.mjs（WS-5 需要切换 AUTH_TOKEN、WS-6 需要真实"重启"）此前都靠
// cleanup() + 再次 import('../../server.js') 模拟"重启/重配置"，但 ESM 按 URL 缓存模块——
// 第二次 import 拿到的是同一个（已 close 的）httpServer/io 引用，模块顶层读取的 env
// （IDLE_TIMEOUT_MS/AUTH_TOKEN 等）也不会重新求值，不会真的重启或应用新配置。
//
// 改为真起子进程（同 tests/integration/server.test.mjs 已验证过的 nonce + 就绪探测模式）：
// kill 掉旧进程、spawn 新进程即为真重启/真重配置，无需依赖 ESM 模块缓存行为。
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';

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
// 返回 { proc, port, buildNonce }；调用方负责最终 killServer(proc)。
export async function spawnServer(envOverrides = {}) {
  const port = envOverrides.PORT ? Number(envOverrides.PORT) : 30000 + Math.floor(Math.random() * 10000);
  const buildNonce = `inttest-${randomUUID()}`;
  const proc = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      DEV_MODE: '0', // 同 server.test.mjs：隔离机主 .env 里的 DEV_MODE，防 dev:restart 误触发
      ...envOverrides,
      PORT: String(port),        // 覆盖 envOverrides 里可能的 PORT，确保和上面算出的 port 一致
      CCM_BUILD_NONCE: buildNonce,
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
  for (let i = 0; i < 40; i++) {
    if (earlyExit) throw new Error(`server 子进程提前退出，启动失败：${JSON.stringify(earlyExit)}`);
    await new Promise(r => setTimeout(r, 250));
    try {
      const h = JSON.parse(await httpGet(healthUrl));
      if (h.status === 'ok' && h.buildNonce === buildNonce) return { proc, port, buildNonce };
      // status:ok 但 nonce 不符 = 端口上是别的进程（旧 checkout / 未退实例）——继续轮询直至超时报错。
    } catch { /* 尚未起来 / 401 / 非 JSON */ }
  }
  throw new Error(`Server startup timeout（端口 ${port} 未出现本轮 nonce 的 /health${earlyExit ? '；子进程已退出' : ''}）`);
}

export async function killServer(proc) {
  if (!proc) return;
  proc.kill('SIGTERM');
  await Promise.race([
    new Promise(r => proc.on('exit', r)),
    new Promise(r => setTimeout(r, 3000))
  ]);
  try { proc.kill('SIGKILL'); } catch {}
}
