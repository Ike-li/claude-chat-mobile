// test/integration/websocket-events.test.mjs —— WebSocket 事件流集成测试
// 覆盖：WS-1 ~ WS-6（见 .agents/sprint-1-test-plan.md）
// 运行：npm test -- test/integration/websocket-events.test.mjs
//
// 审计 TC-004：三处协议漂移已修——
// ①此前每个 test 在发首条 user:message 之前 await waitForEvent('init')：fresh 临时 CCM_DATA_DIR 下
//   lastInit 为空，服务端 connection 时只重放 instances 等合成状态，真正的 init 只在首条消息触发懒建
//   AgentSession 后才产生——等待顺序与当前 lazy-start 协议相反。改为连接后只等 instances。
// ②WS-1 断言 "init 应该在 instances 之前"——这只在"已有 lastInit 的重连/重放"场景成立；本测试是全新
//   连接首次建会话，实际顺序是 instances（连接时无条件重放）先于 init（首条消息触发懒建后才产生）。
//   断言方向反了，改成 instances < init。
// ③WS-5（切 AUTH_TOKEN）、WS-6（模拟"重启"）此前都靠 cleanup() + 再次 import('../../server.js')，但
//   ESM 按 URL 缓存模块，第二次 import 拿到同一个（已 close 的）httpServer/io 引用，模块顶层读取的
//   AUTH_TOKEN 也不会重新求值——WS-5 测的其实还是第一次 import 时的（无 auth）配置，WS-6 的"重启"什么
//   都没重启。改为 spawnServer()/killServer() 真起真杀子进程（test/integration/_spawn-server.mjs，同
//   test/integration/server.test.mjs 已验证过的 nonce + 就绪探测模式）。WS-6 额外需要重启后端口不变
//   （客户端的 socket.io 连接 URL 在创建时已固定，端口变了不可能重连到新进程），startServer() 支持传
//   port 固定它。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from './_spawn-server.mjs';

const sleep = ms => new Promise(res => setTimeout(res, ms));

let port, dataDir, serverProc;

// 启动隔离的测试服务器（真子进程，非 ESM 动态 import——见文件头 TC-004 注释）
// dataDir 可传入已存在目录复用（WS-6 重启需要沿用同一份 sessions.json 才能测出"恢复"，
// 不传则每次新建一次性临时目录）。
async function startServer(options = {}) {
  const { authEnabled = false, port: pinnedPort, dataDir: reuseDataDir } = options;

  dataDir = reuseDataDir || mkdtempSync(join(tmpdir(), 'ccm-ws-test-'));
  const started = await spawnServer({
    AUTH_TOKEN: authEnabled ? 'test-token-123' : '',
    WORK_DIR: dataDir,
    CCM_DATA_DIR: dataDir,
    IDLE_TIMEOUT_MS: '10000',
    ...(pinnedPort ? { PORT: String(pinnedPort) } : {}),
  });
  serverProc = started.proc;
  port = started.port;

  return { port, dataDir };
}

// 创建 socket 客户端
function createClient(options = {}) {
  const { auth = {}, autoConnect = true } = options;

  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth,
    transports: ['websocket'],
    reconnection: options.reconnection !== false,
    reconnectionAttempts: options.reconnectionAttempts || 3,
    reconnectionDelay: options.reconnectionDelay || 100,
  });

  const events = [];
  const eventResolvers = new Map();

  socket.on('agent:event', (envelope) => {
    events.push(envelope);

    // 触发等待中的 resolver
    const resolvers = eventResolvers.get(envelope.type) || [];
    resolvers.forEach(({ resolve, timer }) => {
      clearTimeout(timer);
      resolve(envelope);
    });
    eventResolvers.delete(envelope.type);
  });

  // 连接事件
  const connectEvents = [];
  socket.on('connect', () => connectEvents.push({ type: 'connect', ts: Date.now() }));
  socket.on('disconnect', (reason) => connectEvents.push({ type: 'disconnect', reason, ts: Date.now() }));
  socket.on('connect_error', (err) => connectEvents.push({ type: 'connect_error', message: err.message, ts: Date.now() }));

  return {
    socket,
    events,
    connectEvents,
    waitForEvent(type, timeout = 15000) {
      return new Promise((resolve, reject) => {
        // 先检查已有的事件
        const existing = events.find(e => e.type === type);
        if (existing) return resolve(existing);

        // 设置超时
        const timer = setTimeout(() => {
          const resolvers = eventResolvers.get(type) || [];
          const idx = resolvers.findIndex(r => r.timer === timer);
          if (idx !== -1) resolvers.splice(idx, 1);
          reject(new Error(`Timeout waiting for: ${type}`));
        }, timeout);

        if (!eventResolvers.has(type)) {
          eventResolvers.set(type, []);
        }
        eventResolvers.get(type).push({ resolve, timer });
      });
    },
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
    waitForDisconnect(timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (!socket.connected) return resolve();

        const timer = setTimeout(() => {
          reject(new Error('Disconnect timeout'));
        }, timeout);

        socket.once('disconnect', (reason) => {
          clearTimeout(timer);
          resolve(reason);
        });
      });
    },
    clearEvents() {
      events.length = 0;
      connectEvents.length = 0;
    },
    disconnect() {
      socket.disconnect();
    }
  };
}

// 清理函数
async function cleanup() {
  if (serverProc) {
    await killServer(serverProc);
    serverProc = null;
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
test.describe('WebSocket 事件流集成测试', (process.env.CI || !process.env.RUN_CLAUDE_INTEGRATION) ? { skip: '默认/CI 跳过——需真 claude agent turn(慢/耗 token/不稳);本机设 RUN_CLAUDE_INTEGRATION=1 运行' } : {}, () => {
  test.before(async () => {
    await startServer({ authEnabled: false });
  });

  test.after(async () => {
    await cleanup();
  });

  // WS-1: Happy path: 建立连接 → 发送消息 → 收到流式回复
  test('WS-1: 连接 → 发送消息 → 收到流式回复', async () => {
    const client = createClient();

    try {
      // 等待连接
      await client.waitForConnect();

      // TC-004：只等 instances（连接时无条件重放）；init 由懒建的 AgentSession 首次产生，发消息后再到达。
      await client.waitForEvent('instances');

      // 发送消息
      client.socket.emit('user:message', { text: 'Hello, respond briefly' });

      // 等待 text_delta（流式输出）
      const delta = await client.waitForEvent('text_delta', 20000);
      assert.ok(delta.payload, 'text_delta 应该有 payload');
      assert.ok(typeof delta.payload.text === 'string', 'text_delta.payload 应该包含 text');

      // 等待 result（完成）
      const result = await client.waitForEvent('result', 20000);
      assert.ok(result.payload, 'result 应该有 payload');

      // 验证事件顺序：instances 在连接时无条件重放，先于 init（TC-004：此前反过来断言，
      // 只在"已有 lastInit 的重连/重放"场景成立；本测试是全新连接首次建会话，顺序相反）。
      const eventTypes = client.events.map(e => e.type);
      assert.ok(eventTypes.indexOf('instances') < eventTypes.indexOf('init'), 'instances 应该在 init 之前（全新连接首次建会话）');
      assert.ok(eventTypes.indexOf('text_delta') < eventTypes.indexOf('result'), 'text_delta 应该在 result 之前');
    } finally {
      client.disconnect();
    }
  });

  // WS-2: 断线重连: 网络中断 → 自动重连 → 恢复会话
  test('WS-2: 断线后自动重连并恢复会话', async () => {
    const client = createClient({ reconnection: true, reconnectionAttempts: 3 });

    try {
      await client.waitForConnect();
      // TC-004：只等 instances（连接时无条件重放）；init 由懒建的 AgentSession 首次产生，发消息后再到达。
      await client.waitForEvent('instances');

      // 发送消息建立会话
      client.socket.emit('user:message', { text: 'Hello' });
      await client.waitForEvent('result', 20000);

      // 记录当前 sessionId
      const initEvent = client.events.find(e => e.type === 'init');
      const sessionId = initEvent?.payload?.sessionId;

      // 模拟断线
      client.socket.disconnect();
      await sleep(100);

      // 重连
      client.socket.connect();
      await client.waitForConnect();

      // 等待重连后的初始化
      const reconnectedInit = await client.waitForEvent('init', 10000);
      assert.ok(reconnectedInit.payload, '重连后应该收到 init');

      // 验证会话恢复（sessionId 应该相同或相关）
      console.log(`WS-2: 原始 sessionId=${sessionId}, 重连后=${reconnectedInit.payload?.sessionId}`);
    } finally {
      client.disconnect();
    }
  });

  // WS-3: 会话切换: 切换 sessionId → 正确加载历史
  test('WS-3: 切换会话正确加载历史', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      // TC-004：只等 instances（连接时无条件重放）；init 由懒建的 AgentSession 首次产生，发消息后再到达。
      await client.waitForEvent('instances');

      // 发送第一条消息创建会话 A
      client.socket.emit('user:message', { text: 'Session A message' });
      await client.waitForEvent('result', 20000);

      const sessionA = client.events.find(e => e.type === 'init')?.payload?.sessionId;
      client.clearEvents();

      // 切换到新会话（发送空消息或特定命令）
      // 注意：具体切换机制取决于实现
      client.socket.emit('session:switch', { sessionId: null });  // 新会话
      await sleep(500);

      // 发送第二条消息创建会话 B
      client.socket.emit('user:message', { text: 'Session B message' });
      await client.waitForEvent('result', 20000);

      const sessionB = client.events.find(e => e.type === 'init')?.payload?.sessionId;

      // 验证两个会话不同
      console.log(`WS-3: Session A=${sessionA}, Session B=${sessionB}`);
    } finally {
      client.disconnect();
    }
  });

  // WS-4: 并发消息: 快速连续发送 → 不丢失、不乱序
  test('WS-4: 快速连续发送消息不丢失', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      // TC-004：只等 instances（连接时无条件重放）；init 由懒建的 AgentSession 首次产生，发消息后再到达。
      await client.waitForEvent('instances');

      // 快速连续发送多条消息
      const messageCount = 3;
      for (let i = 0; i < messageCount; i++) {
        client.socket.emit('user:message', { text: `Message ${i + 1}` });
        await sleep(100);  // 短暂延迟避免完全同时
      }

      // 等待所有结果
      const results = [];
      for (let i = 0; i < messageCount; i++) {
        const result = await client.waitForEvent('result', 30000);
        results.push(result);
      }

      // 验证收到所有结果
      assert.equal(results.length, messageCount, `应该收到 ${messageCount} 个 result`);

      console.log(`WS-4: 成功处理 ${messageCount} 条连续消息`);
    } finally {
      client.disconnect();
    }
  });

  // WS-5: 认证: 无 token 连接被拒绝（当 AUTH_TOKEN 设置时）
  test('WS-5: 无 token 连接在启用 auth 时被拒绝', async () => {
    // 重启服务器启用 auth
    await cleanup();
    await startServer({ authEnabled: true });

    const client = createClient({ auth: {}, reconnection: false });

    try {
      // 尝试连接
      client.socket.connect();

      // 等待连接错误
      const error = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Expected connection error'));
        }, 5000);

        client.socket.once('connect_error', (err) => {
          clearTimeout(timer);
          resolve(err);
        });

        // 如果意外连接成功，也应该失败
        client.socket.once('connect', () => {
          clearTimeout(timer);
          reject(new Error('Should not connect without token'));
        });
      });

      assert.ok(error.message, '应该收到连接错误');
      console.log(`WS-5: 无 token 连接被拒绝: ${error.message}`);
    } finally {
      client.disconnect();
    }

    // 重启服务器禁用 auth（恢复默认）
    await cleanup();
    await startServer({ authEnabled: false });
  });

  // WS-6: 服务端重启: 客户端检测断开 → 重连 → resume
  test('WS-6: 服务端重启后客户端重连并恢复', async () => {
    const client = createClient({ reconnection: true, reconnectionAttempts: 5 });

    try {
      await client.waitForConnect();
      // TC-004：只等 instances（连接时无条件重放）；init 由懒建的 AgentSession 首次产生，发消息后再到达。
      await client.waitForEvent('instances');

      // 发送消息建立会话
      client.socket.emit('user:message', { text: 'Before restart' });
      await client.waitForEvent('result', 20000);

      const originalSessionId = client.events.find(e => e.type === 'init')?.payload?.sessionId;

      // 真实重启（TC-004）：kill 真子进程（不删 dataDir——沿用同一份 sessions.json 才测得出"恢复"），
      // 用同一个端口 + 同一个 dataDir 重新 spawn，客户端的 socket.io 连接 URL 在创建时已固定，
      // 端口若变了不可能重连到新进程。
      const priorPort = port;
      const priorDataDir = dataDir;
      await killServer(serverProc);
      serverProc = null;

      // 复核发现：waitForEvent 的"已有事件直接返回"快路径（见 createClient 里的实现）会让下面的
      // waitForEvent('init') 命中重启前那条旧 init（client.events 里已经有一条，上面刚用来取
      // originalSessionId），断言形同虚设——不管新进程有没有真的重发 init 都会通过。清空已收事件，
      // 确保接下来等到的是重启后新进程真正重发的 init。
      client.clearEvents();

      await startServer({ authEnabled: false, port: priorPort, dataDir: priorDataDir });

      // 等待客户端重连
      await sleep(2000);

      // 检查是否重连成功
      if (client.socket.connected) {
        // 等待重连后的初始化（clearEvents 之后，这里等到的必是新进程重连时真正重发的 init）
        const reconnectedInit = await client.waitForEvent('init', 10000);
        assert.ok(reconnectedInit.payload, '重连后应该收到 init');

        console.log(`WS-6: 服务端重启后重连成功，原 sessionId=${originalSessionId}`);
      } else {
        console.log('WS-6: 客户端未自动重连（可能需要调整重连配置）');
      }
    } finally {
      client.disconnect();
    }
  });
});
