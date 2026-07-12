// test/integration/approval-integrity.test.mjs —— 审批完整性绑定端到端集成测试（LLD §5.5，承接 AD-7/NFR-17）
// 单测（test/fingerprint.test.mjs + test/agent.test.mjs「审批完整性绑定」）已覆盖 askPermission/
// resolvePermission 的纯逻辑分支，但那些测试直接调用 AgentSession 方法、绕开了真实 SDK canUseTool
// 回调与真实 socket.io 传输层——协议改动（permission_request 新增 fp / user:approve 新增 op）真正的
// 风险点在这两层，故需一次真实端到端验证：真 claude 子进程触发 canUseTool → 真实 socket 收发。
// 要真 claude agent turn（慢/耗 token/不稳），同 claude-lifecycle.test.mjs 默认/CI 跳过。
//
// 两处实测撞见、单靠读代码不会想到的真实行为，记录下来避免后来者重踩：
// ①用 Write 工具而非 Bash——`echo` 这类只读/无副作用命令，当前 claude CLI 有内置"安全命令"启发式，
//   直接跳过 canUseTool、根本不触发 permission_request（与本项目 settings 白名单无关，是 SDK 内部行为）。
// ②两条用例分处两个 WORK_DIRS 白名单目录（dirA/dirB）、各自独立 AgentSession——同一 cwd 内 Write 一旦
//   被批准，SDK 会隐含下发 setMode→acceptEdits suggestion（resolvePermission 对 modeUpdate 无条件应用，
//   见 agent.js 注释），导致同会话后续 Write 调用直接跳过 canUseTool；若两个用例共用一个会话，第二个
//   永远等不到 permission_request。用两个 cwd 而非重启 server：server.js 用动态 import()，同进程二次
//   import 会命中 ESM 模块缓存、不会真正重新执行 preflight/listen（实测验证过，故不用「重启」方案）。
//   ③user:message 的 payload.cwd 只在「当前无可路由实例」时才生效（routeInstance(undefined) 优先回落到
//   viewingInstanceId，实测第一版直接在第二条消息带 cwd:dirB 仍复用了第一条消息留下的 dirA 实例）——
//   须先 emit('session:new', {cwd}) 显式清空 viewingInstanceId，下一条 user:message 才会为新 cwd 懒开新实例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';

const sleep = ms => new Promise(res => setTimeout(res, ms));
let port, dataDir, dirA, dirB, httpServer, io;

async function startServer(authToken = 'nfr17-test-token') {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-approval-integrity-test-'));
  dirA = join(dataDir, 'proj-a'); mkdirSync(dirA);
  dirB = join(dataDir, 'proj-b'); mkdirSync(dirB);
  dirA = realpathSync(dirA); dirB = realpathSync(dirB); // 与 server.js 内部 realpathSync 归一化的路径对齐

  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'WORK_DIRS', 'CCM_DATA_DIR',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '60000'; // 真实 SDK 轮次较慢，宽松空闲超时防误杀
  process.env.WORK_DIR = dirA; // 两个全新空目录：均无 .claude/settings.json，Write 不会被项目层白名单自动放行
  process.env.WORK_DIRS = dirB;
  process.env.AUTH_TOKEN = authToken;

  const serverModule = await import('../../server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../cf-access.js');
  cfAccess.initCfAccess();
  await sleep(500);
}

function createClient(token) {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token }, transports: ['websocket'], reconnection: false,
  });
  const events = [];
  socket.on('agent:event', envelope => events.push(envelope));
  return {
    socket, events,
    // sinceLen：只在 events[sinceLen..] 范围内找，避免匹配到上一轮遗留的同类型事件（如上一次的 result）
    waitForType(type, sinceLen = 0, timeout = 45000) {
      return new Promise((resolve, reject) => {
        const existing = events.slice(sinceLen).find(e => e.type === type);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => {
          socket.off('agent:event', handler);
          reject(new Error(`超时未收到事件类型：${type}（已收到：${JSON.stringify(events.slice(sinceLen).map(e => e.type))}）`));
        }, timeout);
        const handler = envelope => {
          if (envelope.type === type && events.indexOf(envelope) >= sinceLen) {
            clearTimeout(timer); socket.off('agent:event', handler); resolve(envelope);
          }
        };
        socket.on('agent:event', handler);
      });
    },
    disconnect() { socket.disconnect(); },
    emitWithAck(event, payload, timeout = 10000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`超时未收到 ${event} 的 ack`)), timeout);
        socket.emit(event, payload, ack => { clearTimeout(timer); resolve(ack); });
      });
    },
  };
}

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
}

test.describe(
  '审批完整性绑定端到端（NFR-17）',
  (process.env.CI || !process.env.RUN_CLAUDE_INTEGRATION)
    ? { skip: '默认/CI 跳过——需真 claude agent turn(慢/耗 token/不稳);本机设 RUN_CLAUDE_INTEGRATION=1 运行' }
    : {},
  () => {
    test.before(async () => { await startServer(); });
    test.after(async () => { await cleanup(); });

    test('正常审批链路：permission_request 携带 fp → 回传匹配 op → allow 放行 → SDK 收到正确 updatedInput 并真实执行', async () => {
      const client = createClient('nfr17-test-token');
      await client.waitForType('instances'); // 连接即到；'init' 要等首轮 SDK 握手才会出现，此处不等它

      const marker = `ccm-nfr17-ok-${Date.now()}`;
      const fileName = 'nfr17-ok.txt';
      client.socket.emit('user:message', {
        cwd: dirA,
        text: `请用 Write 工具在当前工作目录创建文件 ${fileName}，内容仅为：${marker}（不含引号/换行），只做这一个操作，不要解释。`
      });

      const permBase = client.events.length;
      const perm = await client.waitForType('permission_request', permBase);
      assert.match(perm.payload.fp, /^[0-9a-f]{64}$/, 'permission_request 应携带 64 位十六进制 fp，卡片渲染前的完整性逻辑未报错');
      assert.equal(perm.payload.name, 'Write', `期望真实触发 Write 工具的 canUseTool，实际工具：${perm.payload.name}`);
      assert.ok(perm.payload.input?.content?.includes(marker), '卡片应显示包含 marker 的真实写入内容');

      const approveBase = client.events.length;
      // 手搓 op：与卡片渲染所见完全一致（复刻 app.js answerPerm 的回传形态）
      client.socket.emit('user:approve', {
        requestId: perm.payload.requestId,
        decision: 'allow',
        alwaysThisSession: false,
        op: { tool: perm.payload.name, args: perm.payload.input, cwd: perm.payload.cwd }
      });

      const resolved = await client.waitForType('request_resolved', approveBase);
      assert.equal(resolved.payload.outcome, 'allow');

      const toolResult = await client.waitForType('tool_result', approveBase);
      assert.equal(toolResult.payload.ok, true, 'SDK 应真实执行了该操作（未被完整性校验误伤）');

      const writtenPath = join(dirA, fileName);
      assert.ok(existsSync(writtenPath), 'SDK 应已真实落盘该文件——证明 updatedInput 确实送达并执行');
      assert.equal(readFileSync(writtenPath, 'utf8').trim(), marker, 'SDK 收到的 updatedInput 应是原始正确内容，磁盘文件内容应与卡片所见一致');

      await client.waitForType('result', approveBase); // 等本轮彻底收尾
      client.disconnect();
    });

    test('篡改链路：user:approve 回传的 op 与服务端锚定 fp 不符 → fail-closed 拒绝，outcome=integrity_mismatch，工具未执行', async () => {
      const client = createClient('nfr17-test-token');
      await client.waitForType('instances'); // 连接即到；'init' 要等首轮 SDK 握手才会出现，此处不等它

      // 显式切到 dirB 并清空 viewingInstanceId：否则 user:message 缺省 instanceId 会直接复用上一用例
      // 留在 dirA 的实例（routeInstance(undefined) 优先回落到 viewingInstanceId，见上方注释③）。
      await client.emitWithAck('session:new', { cwd: dirB });

      const marker = `ccm-nfr17-tampered-${Date.now()}`;
      const fileName = 'nfr17-tampered.txt';
      client.socket.emit('user:message', {
        cwd: dirB,
        text: `请用 Write 工具在当前工作目录创建文件 ${fileName}，内容仅为：${marker}（不含引号/换行），只做这一个操作，不要解释。`
      });

      const permBase = client.events.length;
      const perm = await client.waitForType('permission_request', permBase);
      assert.match(perm.payload.fp, /^[0-9a-f]{64}$/);
      assert.equal(perm.payload.name, 'Write');

      const approveBase = client.events.length;
      // 故意篡改写入内容——与 askPermission 时锚定的 fp 不符，模拟传输层被改动
      client.socket.emit('user:approve', {
        requestId: perm.payload.requestId,
        decision: 'allow',
        alwaysThisSession: false,
        op: { tool: perm.payload.name, args: { ...perm.payload.input, content: 'tampered-should-not-be-written' }, cwd: perm.payload.cwd }
      });

      const resolved = await client.waitForType('request_resolved', approveBase);
      assert.equal(resolved.payload.outcome, 'integrity_mismatch', '服务端须 fail-closed 识别 op 与锚定 fp 不符');

      const toolResult = await client.waitForType('tool_result', approveBase);
      assert.equal(toolResult.payload.ok, false, '完整性校验失败后工具不应真实执行');

      const writtenPath = join(dirB, fileName);
      assert.ok(!existsSync(writtenPath), '完整性校验失败后不应有任何文件被真实写入磁盘');

      await client.waitForType('result', approveBase);
      client.disconnect();
    });
  },
);
