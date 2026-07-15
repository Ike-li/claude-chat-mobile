// tests/integration/auth-token.test.mjs —— AUTH_TOKEN 鉴权流程集成测试
// 覆盖：HTTP 端点鉴权 + Socket.IO 握手鉴权（LAN token 路）。公网 CF Access 判决见 cf-access-gate.test.mjs
// 运行：npm test -- tests/integration/auth-token.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { request } from 'node:http';

const sleep = ms => new Promise(res => setTimeout(res, ms));

let port, dataDir, httpServer, io;

// 启动测试服务器
async function startServer(options = {}) {
  const { authEnabled = true, authToken = 'test-token-123' } = options;

  // 创建临时数据目录
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-auth-test-'));

  // 第一步：清除所有可能被 .env 文件覆盖的环境变量
  delete process.env.PORT;
  delete process.env.AUTH_TOKEN;
  delete process.env.IDLE_TIMEOUT_MS;
  delete process.env.WORK_DIR;
  delete process.env.CCM_DATA_DIR;
  delete process.env.CF_ACCESS_HOSTNAME;
  delete process.env.CF_ACCESS_TEAM;
  delete process.env.CF_ACCESS_AUD;

  // 第二步：设置测试专用的环境变量
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;

  if (authEnabled) {
    process.env.AUTH_TOKEN = authToken;
  }

  // 第三步：动态导入 server 模块（这会触发 dotenv.config() 和 initCfAccess()）
  const serverModule = await import('../../server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  // 第四步：再次清除 CF Access 环境变量（覆盖 dotenv 加载的值）
  delete process.env.CF_ACCESS_HOSTNAME;
  delete process.env.CF_ACCESS_TEAM;
  delete process.env.CF_ACCESS_AUD;

  // 第五步：重新初始化 CF Access（现在应该返回 false）
  const cfAccess = await import('../../src/auth/cf-access.js');
  cfAccess.initCfAccess();

  // 等待服务器就绪
  await sleep(500);

  return { port, dataDir };
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
  const { auth = {}, autoConnect = true } = options;

  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth,
    transports: ['websocket'],
    reconnection: false,
  });

  const events = [];
  socket.on('agent:event', (envelope) => {
    events.push(envelope);
  });

  return {
    socket,
    events,
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
    waitForEvent(type, timeout = 10000) {
      return new Promise((resolve, reject) => {
        const existing = events.find(e => e.type === type);
        if (existing) return resolve(existing);

        const timer = setTimeout(() => {
          reject(new Error(`Timeout waiting for: ${type}`));
        }, timeout);

        const handler = (envelope) => {
          if (envelope.type === type) {
            clearTimeout(timer);
            socket.off('agent:event', handler);
            resolve(envelope);
          }
        };
        socket.on('agent:event', handler);
      });
    },
    disconnect() {
      socket.disconnect();
    }
  };
}

// 清理函数
async function cleanup() {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  if (io) {
    io.close();
    io = null;
  }
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('Cleanup failed:', e.message);
    }
    dataDir = null;
  }
}

// 测试套件
test.describe('AUTH_TOKEN 鉴权集成测试', process.env.CI ? { skip: 'CI 无本机 claude CLI；集成测试仅本机跑' } : {}, () => {
  test.before(async () => {
    // 只启动一次服务器，所有测试共享
    await startServer({ authEnabled: true, authToken: 'secret-token' });
  });

  test.after(async () => {
    await cleanup();
  });

  // 测试 1: 启用 AUTH_TOKEN 时，无 token 的 HTTP 请求被拒绝
  test('HTTP: 无 token 访问 /health 返回 401', async () => {
    try {
      const res = await httpRequest('/health');
      assert.equal(res.statusCode, 401, '应该返回 401');
      console.log('HTTP 401:', res.body);
    } finally {
      // cleanup 在 after 中执行
    }
  });

  // 测试 2: 启用 AUTH_TOKEN 时，带正确 token 的 HTTP 请求成功
  test('HTTP: 带正确 token 访问 /health 返回 200', async () => {
    try {
      const res = await httpRequest('/health?token=secret-token');
      assert.equal(res.statusCode, 200, '应该返回 200');
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
    } finally {
      // cleanup 在 after 中执行
    }
  });

  // 测试 3: 启用 AUTH_TOKEN 时，带错误 token 的 HTTP 请求被拒绝
  test('HTTP: 带错误 token 访问 /health 返回 401', async () => {
    try {
      const res = await httpRequest('/health?token=wrong-token');
      assert.equal(res.statusCode, 401, '应该返回 401');
    } finally {
      // cleanup 在 after 中执行
    }
  });

  // 测试 4: 启用 AUTH_TOKEN 时，通过 header 传递 token
  test('HTTP: 通过 x-auth-header 传递 token', async () => {
    try {
      const res = await httpRequest('/health', {
        headers: { 'x-auth-token': 'secret-token' }
      });
      assert.equal(res.statusCode, 200, '应该返回 200');
    } finally {
      // cleanup 在 after 中执行
    }
  });

  // 测试 5: 空 token 等同于未提供
  test('HTTP: 空 token 等同于未提供', async () => {
    try {
      const res = await httpRequest('/health?token=');
      assert.equal(res.statusCode, 401, '空 token 应该返回 401');
    } finally {
      // cleanup 在 after 中执行
    }
  });

  // 测试 6: Socket.IO 握手带正确 token 能连接
  test('Socket.IO: 带正确 token 握手成功', async () => {
    try {
      const client = createClient({ auth: { token: 'secret-token' } });

      // 等待连接建立（不需要等待 init 事件，因为测试环境没有真实 claude 子进程）
      await client.waitForConnect();

      // 验证连接成功（socket.connected 应该为 true）
      assert.ok(client.socket.connected, 'Socket 应该已连接');

      client.disconnect();
    } finally {
      // cleanup 在 after 中执行
    }
  });

  // 测试 7: Socket.IO 握手带错误 token 被拒绝
  test('Socket.IO: 带错误 token 握手失败', async () => {
    try {
      const client = createClient({ auth: { token: 'wrong-token' } });

      const error = await client.waitForConnectError();
      assert.ok(error.message, '应该收到连接错误');
      console.log('Socket.IO 握手被拒绝:', error.message);

      client.disconnect();
    } finally {
      // cleanup 在 after 中执行
    }
  });

  // 测试 8: Socket.IO 握手无 token 被拒绝
  test('Socket.IO: 无 token 握手失败', async () => {
    try {
      const client = createClient({ auth: {} });

      const error = await client.waitForConnectError();
      assert.ok(error.message, '应该收到连接错误');
      console.log('Socket.IO 无 token 被拒绝:', error.message);

      client.disconnect();
    } finally {
      // cleanup 在 after 中执行
    }
  });
});
