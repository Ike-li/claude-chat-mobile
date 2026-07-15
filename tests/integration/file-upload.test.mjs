// tests/integration/file-upload.test.mjs —— 文件上传安全集成测试
// 覆盖：socket 上传端到端流程、附件校验、大小限制。
// symlink/落盘穿越防御的单测见 tests/unit/file-security.test.mjs 与 tests/unit/uploads.test.mjs
// 运行：npm test -- tests/integration/file-upload.test.mjs
//
// 审计 TC-005 复核修正：本文件曾在同一进程内先后起两个 test.describe（默认 lane + 新增的
// RUN_CLAUDE_INTEGRATION 专用 lane），各自 test.before(startServer)/test.after(cleanup)，但
// startServer() 用的是 ESM 动态 import('../../server.js')——同 claude-lifecycle.test.mjs/
// websocket-events.test.mjs 修复前的病灶：第一个 describe 的 cleanup() 关掉真实 httpServer/io 后，
// 第二个 describe 的 startServer() 再次 import 同一 URL，ESM 模块缓存只会返回同一个（已关闭的）
// 引用，第二个 describe 的用例永远连不上、必超时。改用 tests/integration/_spawn-server.mjs 真起
// 真杀子进程（同另外两个文件的修复），每次 startServer() 都是全新进程，彻底不受 ESM 缓存影响；
// CF Access 隔离也不再需要"清 env → import → 再清 env → 重新 initCfAccess()"的进程内二次处理，
// 直接在 spawn 的子进程 env 里显式传空字符串即可（dotenv 默认不覆盖已存在的 env key，即便是空串）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { validateAttachments, saveAttachments, sanitizeName } from '../../src/files/uploads.js';
import { spawnServer, killServer } from './_spawn-server.mjs';

let port, dataDir, serverProc;

// 启动测试服务器（真子进程，非 ESM 动态 import——见文件头 TC-005 注释）
async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-upload-test-'));
  const started = await spawnServer({
    AUTH_TOKEN: '',
    WORK_DIR: dataDir,
    CCM_DATA_DIR: dataDir,
    IDLE_TIMEOUT_MS: '10000',
    // 空串而非 delete：dotenv 默认不覆盖已存在（即便是空串）的 env key，确保不受机主真实 .env 里
    // CF_ACCESS_* 配置影响，本文件的用例不需要 CF Access。
    CF_ACCESS_HOSTNAME: '',
    CF_ACCESS_TEAM: '',
    CF_ACCESS_AUD: '',
  });
  serverProc = started.proc;
  port = started.port;

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
