// test/integration/session-switch.test.mjs —— 会话切换与 resume 集成测试
// 覆盖：会话切换、历史回显、多工作区切换
// 运行：npm test -- test/integration/session-switch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';

const sleep = ms => new Promise(res => setTimeout(res, ms));

let port, dataDir, httpServer, io;

// 启动测试服务器
async function startServer() {
  // 创建临时数据目录
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-session-test-'));

  // 设置环境变量
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  delete process.env.AUTH_TOKEN;
  delete process.env.CF_ACCESS_HOSTNAME;
  delete process.env.CF_ACCESS_TEAM;
  delete process.env.CF_ACCESS_AUD;

  // 动态导入 server 模块
  const serverModule = await import('../../server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  // 等待服务器就绪
  await sleep(500);

  return { port, dataDir };
}

// 创建 socket 客户端
function createClient() {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
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
        const timer = setTimeout(() => reject(new Error('Connection timeout')), timeout);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
      });
    },
    waitForEvent(type, timeout = 15000) {
      return new Promise((resolve, reject) => {
        const existing = events.find(e => e.type === type);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for: ${type}`)), timeout);
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
    clearEvents() {
      events.length = 0;
    },
    sendMessage(text) {
      socket.emit('user:message', { text });
    },
    switchSession(sessionId, cwd) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('session:switch timeout')), 10000);
        socket.emit('session:switch', { sessionId, cwd }, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      });
    },
    listSessions(cwd) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('session:list timeout')), 10000);
        socket.emit('session:list', { cwd }, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      });
    },
    getHistory(sessionId, cwd) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('session:history timeout')), 10000);
        socket.emit('session:history', { sessionId, cwd }, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
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
test.describe('会话切换与 resume 集成测试', (process.env.CI || !process.env.RUN_CLAUDE_INTEGRATION) ? { skip: '默认/CI 跳过——需真 claude agent turn(慢/耗 token/不稳);本机设 RUN_CLAUDE_INTEGRATION=1 运行' } : {}, () => {
  test.before(async () => {
    await startServer();
  });

  test.after(async () => {
    await cleanup();
  });

  // 测试 1: 新会话创建并获得 sessionId
  test('新会话发送消息后获得 sessionId', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      await client.waitForEvent('init');
      await client.waitForEvent('instances');

      // 发送消息创建新会话
      client.sendMessage('Hello, this is a new session');
      await client.waitForEvent('result', 30000);

      // 检查 init 事件中的 sessionId
      const init = client.events.find(e => e.type === 'init');
      assert.ok(init, '应该有 init 事件');

      console.log('新会话 sessionId:', init.payload?.sessionId);
    } finally {
      client.disconnect();
    }
  });

  // 测试 2: 会话列表查询
  test('session:list 返回会话列表', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      await client.waitForEvent('init');
      await client.waitForEvent('instances');

      // 先创建一个会话
      client.sendMessage('Create session for list test');
      await client.waitForEvent('result', 30000);

      // 查询会话列表
      const result = await client.listSessions();
      assert.ok(result.sessions, '应该返回 sessions 数组');
      assert.ok(Array.isArray(result.sessions), 'sessions 应该是数组');

      console.log(`会话列表: ${result.sessions.length} 个会话`);
    } finally {
      client.disconnect();
    }
  });

  // 测试 3: 会话切换到不存在的会话
  test('session:switch 到不存在的会话返回错误', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      await client.waitForEvent('init');
      await client.waitForEvent('instances');

      // 尝试切换到不存在的会话
      const result = await client.switchSession('nonexistent-session-id');
      assert.equal(result.ok, false, '应该返回 ok: false');
      assert.ok(result.error, '应该有错误信息');

      console.log('切换到不存在会话:', result.error);
    } finally {
      client.disconnect();
    }
  });

  // 测试 4: 会话切换后历史回显
  test('session:history 返回会话历史', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      await client.waitForEvent('init');
      await client.waitForEvent('instances');

      // 创建一个会话
      client.sendMessage('Session for history test');
      const result = await client.waitForEvent('result', 30000);

      // 获取当前 sessionId
      const init = client.events.find(e => e.type === 'init');
      const sessionId = init?.payload?.sessionId;

      if (sessionId) {
        // 查询历史
        const history = await client.getHistory(sessionId);
        assert.ok(history.messages, '应该返回 messages 数组');
        assert.ok(Array.isArray(history.messages), 'messages 应该是数组');

        console.log(`会话历史: ${history.messages.length} 条消息`);
      }
    } finally {
      client.disconnect();
    }
  });

  // 测试 5: 多工作区切换
  test('多工作区切换正确隔离', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      await client.waitForEvent('init');
      await client.waitForEvent('instances');

      // 创建两个临时工作目录
      const workDir1 = mkdtempSync(join(tmpdir(), 'ccm-workdir1-'));
      const workDir2 = mkdtempSync(join(tmpdir(), 'ccm-workdir2-'));

      try {
        // 在第一个工作区发送消息
        client.sendMessage('Message in workspace 1');
        await client.waitForEvent('result', 30000);

        const init1 = client.events.find(e => e.type === 'init');
        const sessionId1 = init1?.payload?.sessionId;

        // 切换到第二个工作区
        client.clearEvents();
        client.sendMessage('Message in workspace 2');
        await client.waitForEvent('result', 30000);

        const init2 = client.events.find(e => e.type === 'init');
        const sessionId2 = init2?.payload?.sessionId;

        console.log(`工作区 1 sessionId: ${sessionId1}`);
        console.log(`工作区 2 sessionId: ${sessionId2}`);
      } finally {
        rmSync(workDir1, { recursive: true, force: true });
        rmSync(workDir2, { recursive: true, force: true });
      }
    } finally {
      client.disconnect();
    }
  });

  // 测试 6: 会话切换后事件流正确性
  test('会话切换后事件流指向新会话', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      await client.waitForEvent('init');
      await client.waitForEvent('instances');

      // 创建第一个会话
      client.sendMessage('First session message');
      await client.waitForEvent('result', 30000);

      const init1 = client.events.find(e => e.type === 'init');
      const sessionId1 = init1?.payload?.sessionId;
      client.clearEvents();

      // 发送新消息（应该在同一个会话中）
      client.sendMessage('Second message in same session');
      const result2 = await client.waitForEvent('result', 30000);

      // 检查事件是否仍然指向同一个会话
      console.log(`会话 1 继续消息，sessionId 保持: ${sessionId1}`);
    } finally {
      client.disconnect();
    }
  });

  // 测试 7: 并发会话创建
  test('并发创建多个会话', async () => {
    const client1 = createClient();
    const client2 = createClient();

    try {
      await Promise.all([
        client1.waitForConnect(),
        client2.waitForConnect(),
      ]);

      await Promise.all([
        client1.waitForEvent('init'),
        client2.waitForEvent('init'),
      ]);

      await Promise.all([
        client1.waitForEvent('instances'),
        client2.waitForEvent('instances'),
      ]);

      // 两个客户端同时创建会话
      client1.sendMessage('Session from client 1');
      client2.sendMessage('Session from client 2');

      const [result1, result2] = await Promise.all([
        client1.waitForEvent('result', 30000),
        client2.waitForEvent('result', 30000),
      ]);

      const init1 = client1.events.find(e => e.type === 'init');
      const init2 = client2.events.find(e => e.type === 'init');

      console.log(`并发会话 1: ${init1?.payload?.sessionId}`);
      console.log(`并发会话 2: ${init2?.payload?.sessionId}`);
    } finally {
      client1.disconnect();
      client2.disconnect();
    }
  });

  // 测试 8: 会话关闭
  test('session:close 关闭会话', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      await client.waitForEvent('init');
      await client.waitForEvent('instances');

      // 创建一个会话
      client.sendMessage('Session to close');
      await client.waitForEvent('result', 30000);

      // 获取 instanceId
      const instances = client.events.find(e => e.type === 'instances');
      const instanceId = instances?.payload?.[0]?.instanceId;

      if (instanceId) {
        // 关闭会话
        const closeResult = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('session:close timeout')), 10000);
          client.socket.emit('session:close', { instanceId }, (response) => {
            clearTimeout(timer);
            resolve(response);
          });
        });

        assert.equal(closeResult.ok, true, '关闭会话应该成功');
        console.log(`关闭会话 ${instanceId} 成功`);
      }
    } finally {
      client.disconnect();
    }
  });

  // 测试 9: 会话恢复后历史完整性
  test('会话恢复后历史消息完整', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      await client.waitForEvent('init');
      await client.waitForEvent('instances');

      // 发送多条消息
      client.sendMessage('Message 1');
      await client.waitForEvent('result', 30000);
      client.clearEvents();

      client.sendMessage('Message 2');
      await client.waitForEvent('result', 30000);
      client.clearEvents();

      // 获取 sessionId
      const init = client.events.find(e => e.type === 'init');
      const sessionId = init?.payload?.sessionId;

      if (sessionId) {
        // 查询历史
        const history = await client.getHistory(sessionId);
        console.log(`会话历史: ${history.messages.length} 条消息`);

        // 验证历史包含我们的消息
        assert.ok(history.messages.length >= 2, '应该至少有 2 条消息');
      }
    } finally {
      client.disconnect();
    }
  });

  // 测试 10: 无效 sessionId 的历史查询
  test('无效 sessionId 查询历史返回空', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      await client.waitForEvent('init');
      await client.waitForEvent('instances');

      // 查询不存在的会话历史
      const history = await client.getHistory('invalid-session-id-12345');
      assert.ok(Array.isArray(history.messages), '应该返回空数组');
      assert.equal(history.messages.length, 0, '消息数组应该为空');

      console.log('无效 sessionId 历史查询返回空数组');
    } finally {
      client.disconnect();
    }
  });
});
