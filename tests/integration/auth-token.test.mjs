// tests/integration/auth-token.test.mjs —— AUTH_TOKEN 鉴权流程集成测试
// 覆盖：HTTP 端点鉴权 + Socket.IO 握手鉴权（LAN token 路）。公网 CF Access 判决见 cf-access-gate.test.mjs
// 运行：npm test -- tests/integration/auth-token.test.mjs
//
// ★ 为什么是「每个用例一台全新 server 子进程」而不是共享一台（2026-08-02 修）
// 此前本文件 8 个用例共用一台 in-process 起的 server，实测 5 个确定性红、actual 全是 429。
// 根因不是环境、不是 .env：src/auth/rate-limiter.js 的指数退避是【强制短锁】（经 lockUntil 生效，
// 非仅 Retry-After 建议头），baseBackoffMs=500。第一个「失败鉴权」用例把 127.0.0.1 锁 500ms，
// 同文件后续所有 HTTP 断言（含正向对照的 200）在窗口内一律拿 429 —— 于是整份鉴权测试零信号：
// 被测行为对或错都是红的，测试区分不了。不是 8 次阈值长锁，是第 1 次失败就触发。
//
// 限速状态 rlStates 是 server 进程内的 Map（见 src/server/app.js），换进程即清零，所以隔离必须做在
// 进程级。改用 _spawn-server.mjs 的 spawnServer 起真子进程，顺带甩掉 in-process `await import
// ('../../server.js')` —— 那个写法因 ESM 按 URL 缓存本就无法真重启/真重配置（见 _spawn-server.mjs 文件头）。
//
// ★ 每个用例只允许产生【一次】失败鉴权。第二次会落进上一次的 500ms 退避窗口拿 429。要断言两条
//   失败路径就拆成两个用例（各自一台 server），别在同一个用例里连发。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { request } from 'node:http';
import { spawnServer, killServer } from './_spawn-server.mjs';

const AUTH_TOKEN = 'secret-token';

let port, proc, dataDir;

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-auth-test-'));
  const spawned = await spawnServer({
    AUTH_TOKEN,
    CCM_DATA_DIR: dataDir,
    WORK_DIR: dataDir,
    IDLE_TIMEOUT_MS: '10000',
    // 本文件测的是 LAN token 路，CF Access 必须关闭。空串 + _spawn-server 已设的
    // CCM_TEST_PRESERVE_EMPTY_ENV=1 组合：空值保留到 dotenv 结束（挡住机主 .env 回填真实
    // CF 配置），随后 normalizeLoadedEnvironment 删空串 → 进程当「未设置」跑。见 config.js:39。
    CF_ACCESS_HOSTNAME: '',
    CF_ACCESS_TEAM: '',
    CF_ACCESS_AUD: '',
  });
  proc = spawned.proc;
  port = spawned.port;
}

async function stopServer() {
  if (proc) { await killServer(proc); proc = null; }
  if (dataDir) {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 已被清理 */ }
    dataDir = null;
  }
}

// HTTP 请求辅助函数
function httpRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

// 创建 socket 客户端
function createClient(options = {}) {
  const { auth = {} } = options;

  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth,
    transports: ['websocket'],
    reconnection: false,
  });

  return {
    socket,
    waitForConnect(timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (socket.connected) return resolve();

        const timer = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, timeout);

        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    waitForConnectError(timeout = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Expected connection error'));
        }, timeout);

        socket.once('connect_error', (err) => {
          clearTimeout(timer);
          resolve(err);
        });

        socket.once('connect', () => {
          clearTimeout(timer);
          reject(new Error('Should not connect'));
        });
      });
    },
    disconnect() {
      socket.disconnect();
    }
  };
}

test.describe('AUTH_TOKEN 鉴权集成测试', () => {
  test.beforeEach(async () => { await startServer(); });
  test.afterEach(async () => { await stopServer(); });

  // 测试 1: 启用 AUTH_TOKEN 时，无 token 的 HTTP 请求被拒绝
  test('HTTP: 无 token 访问 /health 返回 401', async () => {
    const res = await httpRequest('/health');
    assert.equal(res.statusCode, 401, '应该返回 401');
  });

  // 测试 2: 启用 AUTH_TOKEN 时，带正确 token 的 HTTP 请求成功
  test('HTTP: 带正确 token 访问 /health 返回 200', async () => {
    const res = await httpRequest(`/health?token=${AUTH_TOKEN}`);
    assert.equal(res.statusCode, 200, '应该返回 200');
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
  });

  // 测试 3: 启用 AUTH_TOKEN 时，带错误 token 的 HTTP 请求被拒绝
  test('HTTP: 带错误 token 访问 /health 返回 401', async () => {
    const res = await httpRequest('/health?token=wrong-token');
    assert.equal(res.statusCode, 401, '应该返回 401');
  });

  // 测试 4: 启用 AUTH_TOKEN 时，通过 header 传递 token
  test('HTTP: 通过 x-auth-header 传递 token', async () => {
    const res = await httpRequest('/health', {
      headers: { 'x-auth-token': AUTH_TOKEN }
    });
    assert.equal(res.statusCode, 200, '应该返回 200');
  });

  // 测试 5: 空 token 等同于未提供
  test('HTTP: 空 token 等同于未提供', async () => {
    const res = await httpRequest('/health?token=');
    assert.equal(res.statusCode, 401, '空 token 应该返回 401');
  });

  // 测试 6: Socket.IO 握手带正确 token 能连接
  test('Socket.IO: 带正确 token 握手成功', async () => {
    const client = createClient({ auth: { token: AUTH_TOKEN } });
    try {
      // 等待连接建立（不需要等待 init 事件，因为测试环境没有真实 claude 子进程）
      await client.waitForConnect();
      assert.ok(client.socket.connected, 'Socket 应该已连接');
    } finally {
      client.disconnect();
    }
  });

  // 测试 7: Socket.IO 握手带错误 token 被拒绝
  test('Socket.IO: 带错误 token 握手失败', async () => {
    const client = createClient({ auth: { token: 'wrong-token' } });
    try {
      const error = await client.waitForConnectError();
      assert.ok(error.message, '应该收到连接错误');
    } finally {
      client.disconnect();
    }
  });

  // 测试 8: Socket.IO 握手无 token 被拒绝
  test('Socket.IO: 无 token 握手失败', async () => {
    const client = createClient({ auth: {} });
    try {
      const error = await client.waitForConnectError();
      assert.ok(error.message, '应该收到连接错误');
    } finally {
      client.disconnect();
    }
  });
});
