// tests/helpers/integration.mjs —— 集成测试基础设施
// 提供服务器启动、socket.io 客户端连接、测试隔离等辅助函数
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';

const sleep = ms => new Promise(res => setTimeout(res, ms));

/**
 * 启动隔离的测试服务器
 * - 使用临时 CCM_DATA_DIR 隔离数据
 * - 使用随机端口避免冲突
 * - 返回 { server, port, dataDir, cleanup }
 */
export async function startTestServer(options = {}) {
  const {
    idleTimeoutMs = 5000,  // 测试用短超时
    authEnabled = false,    // 默认不启用 auth
  } = options;

  // 创建临时数据目录
  const dataDir = mkdtempSync(join(tmpdir(), 'ccm-integration-'));

  // 设置环境变量
  const originalEnv = { ...process.env };
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = '0';  // 随机端口
  process.env.IDLE_TIMEOUT_MS = String(idleTimeoutMs);
  process.env.WORK_DIR = dataDir;
  if (!authEnabled) {
    delete process.env.AUTH_TOKEN;
  }

  // 动态导入 server.js（需要在 env 设置后）
  // 注意：server.js 在模块加载时会读取 env，所以需要在设置 env 后再 import
  const serverModule = await import('../../server.js');

  // 等待服务器启动
  await sleep(500);

  // 获取实际端口（从 server 或 httpServer）
  const port = serverModule.port || 0;

  // 恢复环境变量
  process.env = originalEnv;

  return {
    server: serverModule,
    port,
    dataDir,
    cleanup: async () => {
      // 关闭服务器
      if (serverModule.httpServer) {
        serverModule.httpServer.close();
      }
      if (serverModule.io) {
        serverModule.io.close();
      }
      // 清理临时目录
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch (e) {
        console.warn('Cleanup failed:', e.message);
      }
    }
  };
}

/**
 * 创建 socket.io 客户端连接
 * - 自动处理连接事件
 * - 提供事件收集器
 * - 返回 { socket, events, cleanup }
 */
export function createTestClient(port, options = {}) {
  const {
    auth = {},  // 认证信息
    timeout = 5000,
  } = options;

  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth,
    transports: ['websocket'],
    reconnection: false,
  });

  const events = [];
  const eventHandlers = new Map();

  // 收集所有 agent:event
  socket.on('agent:event', (envelope) => {
    events.push(envelope);
    // 触发特定类型的处理器
    const handlers = eventHandlers.get(envelope.type) || [];
    handlers.forEach(handler => handler(envelope));
  });

  return {
    socket,
    events,
    /**
     * 等待特定类型的事件
     * @param {string} type - 事件类型
     * @param {number} [timeoutMs=5000] - 超时时间
     * @returns {Promise<object>} 事件信封
     */
    waitForEvent(type, timeoutMs = timeout) {
      return new Promise((resolve, reject) => {
        // 先检查已有的事件
        const existing = events.find(e => e.type === type);
        if (existing) {
          return resolve(existing);
        }

        // 设置超时
        const timer = setTimeout(() => {
          reject(new Error(`Timeout waiting for event: ${type}`));
        }, timeoutMs);

        // 注册处理器
        const handler = (envelope) => {
          if (envelope.type === type) {
            clearTimeout(timer);
            // 移除处理器
            const handlers = eventHandlers.get(type) || [];
            const idx = handlers.indexOf(handler);
            if (idx !== -1) handlers.splice(idx, 1);
            resolve(envelope);
          }
        };

        if (!eventHandlers.has(type)) {
          eventHandlers.set(type, []);
        }
        eventHandlers.get(type).push(handler);
      });
    },

    /**
     * 等待多个事件（按顺序）
     * @param {string[]} types - 事件类型列表
     * @param {number} [timeoutMs=10000] - 超时时间
     * @returns {Promise<object[]>} 事件信封数组
     */
    async waitForEvents(types, timeoutMs = 10000) {
      const results = [];
      const start = Date.now();

      for (const type of types) {
        const remaining = timeoutMs - (Date.now() - start);
        if (remaining <= 0) {
          throw new Error(`Timeout waiting for events: ${types.join(', ')}`);
        }
        const event = await this.waitForEvent(type, remaining);
        results.push(event);
      }

      return results;
    },

    /**
     * 发送用户消息
     * @param {string} text - 消息文本
     */
    sendMessage(text) {
      socket.emit('user:message', { text });
    },

    /**
     * 清空事件收集器
     */
    clearEvents() {
      events.length = 0;
    },

    /**
     * 断开连接
     */
    disconnect() {
      socket.disconnect();
    }
  };
}

/**
 * 等待条件满足
 * @param {Function} condition - 返回 boolean 的函数
 * @param {number} [timeoutMs=5000] - 超时时间
 * @param {number} [intervalMs=100] - 检查间隔
 * @returns {Promise<void>}
 */
export async function waitForCondition(condition, timeoutMs = 5000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/**
 * 创建临时工作目录
 * @returns {string} 临时目录路径
 */
export function createTempWorkDir() {
  return mkdtempSync(join(tmpdir(), 'ccm-workdir-'));
}

/**
 * 清理临时目录
 * @param {string} dir - 目录路径
 */
export function cleanupTempDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`Failed to cleanup ${dir}:`, e.message);
  }
}

export { sleep };
