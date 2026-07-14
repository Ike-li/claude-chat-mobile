// test/integration/file-upload.test.mjs —— 文件上传安全集成测试
// 覆盖：socket 上传端到端流程、附件校验、大小限制。
// symlink/落盘穿越防御的单测见 test/file-security.test.mjs 与 test/uploads.test.mjs
// 运行：npm test -- test/integration/file-upload.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { validateAttachments, saveAttachments, sanitizeName } from '../../uploads.js';

const sleep = ms => new Promise(res => setTimeout(res, ms));

let port, dataDir, httpServer, io;

// 启动测试服务器
async function startServer() {
  // 创建临时数据目录
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-upload-test-'));

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
  const cfAccess = await import('../../cf-access.js');
  cfAccess.initCfAccess();

  // 等待服务器就绪
  await sleep(500);

  return { port, dataDir };
}

// 创建 socket 客户端
function createClient() {
  // 从 .env 文件读取 AUTH_TOKEN（server.js 会在模块加载时读取它）
  const authToken = process.env.AUTH_TOKEN || '';
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token: authToken },  // 传递 AUTH_TOKEN
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
    waitForEvent(type, timeout = 10000) {
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
    sendMessage(text, attachments = []) {
      socket.emit('user:message', { text, attachments });
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

// 生成 base64 数据
function makeBase64(size) {
  return Buffer.alloc(size, 'A').toString('base64');
}

// 测试套件
test.describe('文件上传安全集成测试', process.env.CI ? { skip: 'CI 无本机 claude CLI；集成测试仅本机跑' } : {}, () => {
  test.before(async () => {
    await startServer();
  });

  test.after(async () => {
    await cleanup();
  });

  // ── sanitizeName 单元测试 ──
  test('sanitizeName: 正常文件名保留', () => {
    assert.equal(sanitizeName('test.txt'), 'test.txt');
    assert.equal(sanitizeName('image.png'), 'image.png');
  });

  test('sanitizeName: 路径分隔符被清除', () => {
    assert.equal(sanitizeName('/etc/passwd'), 'passwd');
    assert.equal(sanitizeName('../../../etc/passwd'), 'passwd');
    // Windows 反斜杠在 POSIX 上不被 basename 识别，但会被替换为下划线
    assert.equal(sanitizeName('..\\..\\windows\\system32'), '_.._windows_system32');
  });

  test('sanitizeName: 控制字符被清除', () => {
    assert.equal(sanitizeName('test\x00file.txt'), 'testfile.txt');
    assert.equal(sanitizeName('test\x1ffile.txt'), 'testfile.txt');
  });

  test('sanitizeName: 前导点被清除（防隐藏文件）', () => {
    assert.equal(sanitizeName('.hidden'), 'hidden');
    // 清除前导点后为空串时，回退为 'file'
    assert.equal(sanitizeName('..'), 'file');
    assert.equal(sanitizeName('.'), 'file');
  });

  test('sanitizeName: 危险字符替换为下划线', () => {
    assert.equal(sanitizeName('test:file.txt'), 'test_file.txt');
    assert.equal(sanitizeName('test*file.txt'), 'test_file.txt');
    assert.equal(sanitizeName('test?file.txt'), 'test_file.txt');
  });

  test('sanitizeName: 空名回退为 file', () => {
    assert.equal(sanitizeName(''), 'file');
    assert.equal(sanitizeName(null), 'file');
    assert.equal(sanitizeName(undefined), 'file');
  });

  // ── validateAttachments 单元测试 ──
  test('validateAttachments: 空数组返回 null', () => {
    assert.equal(validateAttachments([]), null);
  });

  test('validateAttachments: null/undefined 返回 null', () => {
    assert.equal(validateAttachments(null), null);
    assert.equal(validateAttachments(undefined), null);
  });

  test('validateAttachments: 超过 10 个附件返回错误', () => {
    const attachments = Array(11).fill({ data: 'dGVzdA==', name: 'test.txt', mimeType: 'text/plain' });
    const error = validateAttachments(attachments);
    assert.ok(error.includes('附件过多'));
  });

  test('validateAttachments: 单文件超过 10MB 返回错误', () => {
    const bigData = makeBase64(10 * 1024 * 1024 + 1);
    const attachments = [{ data: bigData, name: 'big.bin', mimeType: 'application/octet-stream' }];
    const error = validateAttachments(attachments);
    assert.ok(error.includes('过大'));
  });

  test('validateAttachments: 总量超过 20MB 返回错误', () => {
    const data = makeBase64(7 * 1024 * 1024);
    const attachments = [
      { data, name: 'a.bin', mimeType: 'application/octet-stream' },
      { data, name: 'b.bin', mimeType: 'application/octet-stream' },
      { data, name: 'c.bin', mimeType: 'application/octet-stream' },
    ];
    const error = validateAttachments(attachments);
    assert.ok(error.includes('总量过大'));
  });

  test('validateAttachments: 合法附件返回 null', () => {
    const attachments = [
      { data: 'dGVzdA==', name: 'test.txt', mimeType: 'text/plain' },
      { data: 'aW1hZ2U=', name: 'image.png', mimeType: 'image/png' },
    ];
    assert.equal(validateAttachments(attachments), null);
  });

  test('validateAttachments: 缺少 data 返回错误', () => {
    const attachments = [{ name: 'test.txt', mimeType: 'text/plain' }];
    const error = validateAttachments(attachments);
    assert.ok(error.includes('缺少数据'));
  });

  test('validateAttachments: 缺少 name/mimeType 返回错误', () => {
    const attachments = [{ data: 'dGVzdA==' }];
    const error = validateAttachments(attachments);
    assert.ok(error.includes('缺少 name/mimeType'));
  });

  // ── saveAttachments 集成测试 ──
  test('saveAttachments: 正常落盘', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ccm-save-test-'));
    try {
      const attachments = [
        { data: Buffer.from('hello').toString('base64'), name: 'test.txt', mimeType: 'text/plain' },
      ];
      const saved = await saveAttachments(workDir, attachments);

      assert.equal(saved.length, 1);
      assert.ok(saved[0].absPath.startsWith(join(workDir, '.ccm-uploads')));
      assert.equal(saved[0].name, 'test.txt');
      assert.equal(saved[0].size, 5);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('saveAttachments: 路径穿越被拦截', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ccm-save-test-'));
    try {
      const attachments = [
        { data: Buffer.from('hack').toString('base64'), name: '../../../etc/passwd', mimeType: 'text/plain' },
      ];
      // sanitizeName 会把 ../ 清除，所以文件名变成 passwd，不会逃出目录
      const saved = await saveAttachments(workDir, attachments);
      assert.ok(saved[0].absPath.includes('.ccm-uploads'));
      assert.ok(!saved[0].absPath.includes('etc'));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('saveAttachments: 文件权限为 0600', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ccm-save-test-'));
    try {
      const attachments = [
        { data: Buffer.from('secret').toString('base64'), name: 'secret.txt', mimeType: 'text/plain' },
      ];
      const saved = await saveAttachments(workDir, attachments);

      const { statSync } = await import('node:fs');
      const stat = statSync(saved[0].absPath);
      assert.equal(stat.mode & 0o777, 0o600, '文件权限应为 0600');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // ── Socket.IO 附件发送集成测试 ──
  // TC-005："发送合法附件成功" 这一个 case 移到下面的 RUN_CLAUDE_INTEGRATION 专用 describe 了——
  // 校验通过后 server.js 会走 resolveTarget → 懒建 AgentSession → a.send()，真实调用 Claude；
  // 下面两个"过大/过多"case 在 validateAttachments 校验失败时短路返回（server.js:1582-1587），
  // 从不创建 AgentSession，不触发真实 turn，留在默认 lane。
  test('Socket.IO: 发送过大附件被拒绝', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      // 不等待 init 和 instances 事件（测试环境没有真实 claude 子进程）

      const bigData = makeBase64(11 * 1024 * 1024); // 11MB
      const attachments = [
        { data: bigData, name: 'big.bin', mimeType: 'application/octet-stream' },
      ];
      client.sendMessage('请查看大文件', attachments);

      // 应该收到 system 消息拒绝
      const system = await client.waitForEvent('system', 10000);
      assert.ok(system.payload, '应该收到系统消息');
      console.log('大附件被拒绝:', system.payload);
    } finally {
      client.disconnect();
    }
  });

  test('Socket.IO: 发送过多附件被拒绝', async () => {
    const client = createClient();

    try {
      await client.waitForConnect();
      // 不等待 init 和 instances 事件（测试环境没有真实 claude 子进程）

      const attachments = Array(11).fill({
        data: Buffer.from('test').toString('base64'),
        name: 'test.txt',
        mimeType: 'text/plain',
      });
      client.sendMessage('请查看附件', attachments);

      // 应该收到 system 消息拒绝
      const system = await client.waitForEvent('system', 10000);
      assert.ok(system.payload, '应该收到系统消息');
      console.log('过多附件被拒绝:', system.payload);
    } finally {
      client.disconnect();
    }
  });
});

// TC-005：合法附件通过校验后，server.js 走 resolveTarget → 懒建 AgentSession → a.send()，真实调用
// Claude——此前这个 case 留在默认 lane（只受 CI-skip 门控，本机 npm test 会真实发一次 turn 耗 token），
// 且 waitForEvent('result') 超时/异常被 try/catch 全吞，什么都不断言，缺 result 也照样通过（假绿）。
// 改为门控进 RUN_CLAUDE_INTEGRATION 专用 describe（同 claude-lifecycle.test.mjs 等三件套的 opt-in
// 约定），且不再吞错误——超时/异常必须让用例 fail。
test.describe(
  '文件上传安全集成测试（需真实 Claude turn）',
  (process.env.CI || !process.env.RUN_CLAUDE_INTEGRATION)
    ? { skip: '默认/CI 跳过——需真 claude agent turn(慢/耗 token/不稳);本机设 RUN_CLAUDE_INTEGRATION=1 运行' }
    : {},
  () => {
    test.before(async () => {
      await startServer();
    });

    test.after(async () => {
      await cleanup();
    });

    test('Socket.IO: 发送合法附件成功（真实 Claude turn）', async () => {
      const client = createClient();

      try {
        await client.waitForConnect();

        const attachments = [
          { data: Buffer.from('hello').toString('base64'), name: 'test.txt', mimeType: 'text/plain' },
        ];
        client.sendMessage('请查看附件', attachments);

        // 不吞错误：超时/异常直接让用例 fail，不再无条件通过。
        const result = await client.waitForEvent('result', 20000);
        assert.ok(result.payload, '应该收到 result');
      } finally {
        client.disconnect();
      }
    });
  }
);
