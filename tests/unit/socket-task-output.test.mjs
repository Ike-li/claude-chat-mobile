// tests/unit/socket-task-output.test.mjs —— task:output handler 的安全边界与读取行为（B2）
// 【为什么必须有这个文件】E2E 打的是 tests/e2e/mock/server.js —— 一份零 import app/src 的独立实现。
// 把本 handler 整个删掉，E2E 的 P0-17p 依旧全绿（它验的是前端契约）。真实现的三条防线
// （未记录的 taskId 拒绝 / 非常规文件拒读 / 只读尾部）只有这里能证。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerFileSocketHandlers } from '../../app/src/server/socket-files.js';
import { createSocketEventRegistrar } from '../../app/src/server/socket.js';

function harness({ outputFile = null, hasInstance = true } = {}) {
  const handlers = new Map();
  const socket = {
    deviceApproved: true,
    handshake: { auth: { deviceToken: 'd1' } },
    on: (event, handler) => handlers.set(event, handler),
    emit: () => {},
  };
  const noop = () => {};
  registerFileSocketHandlers({
    socket,
    on: createSocketEventRegistrar({ logger: { warn: noop, error: noop } }),
    routeCwd: noop, getWorkDirs: () => [], listDir: noop, browseReadFile: noop,
    locateStoredAttachment: noop, listGitChanges: noop, readGitDiff: noop, searchFiles: noop,
    writeFileInScope: noop, audit: noop, actorFromSocket: noop,
    routeInstance: () => (hasInstance ? { getTaskOutputFile: () => outputFile } : null),
    attributePath: noop, rejectableSymlinkComponent: () => false, buildDiff: noop, readPreview: noop,
    logger: { warn: noop, error: noop },
  });
  const call = (payload) => new Promise(resolve => {
    handlers.get('task:output')(payload, resolve);
  });
  return { call };
}

test.describe('task:output —— 安全边界', () => {
  test('实例不存在 → 拒绝', async () => {
    const { call } = harness({ hasInstance: false });
    const res = await call({ instanceId: 'x', taskId: 't' });
    assert.equal(res.ok, false);
  });

  test('taskId 未被记录 → 拒绝，且【不吐任何路径】', async () => {
    const { call } = harness({ outputFile: null });
    const res = await call({ instanceId: 'i', taskId: 'ghost' });
    assert.equal(res.ok, false);
    // 主防线：路径只从服务端记录取。ack 里不该出现任何文件系统信息
    assert.equal(JSON.stringify(res).includes('/'), false, 'ack 不得泄漏路径');
  });

  test('客户端【无法】通过入参指定路径——多传的字段一律被忽略', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-taskout-'));
    try {
      const secret = join(dir, 'secret.txt');
      writeFileSync(secret, 'TOP_SECRET');
      // routeInstance 记录的是 null（该任务没有输出），客户端却试图自带路径
      const { call } = harness({ outputFile: null });
      const res = await call({ instanceId: 'i', taskId: 't', file: secret, path: secret, outputFile: secret });
      assert.equal(res.ok, false, '客户端传的路径必须完全不起作用');
      assert.equal(JSON.stringify(res).includes('TOP_SECRET'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true }); // safe-rm: 目录来自本用例的 mkdtemp
    }
  });

  test('非常规文件（目录）拒读——/dev/zero 之类会无限读', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-taskout-'));
    try {
      const sub = join(dir, 'adir');
      mkdirSync(sub);
      const { call } = harness({ outputFile: sub });
      const res = await call({ instanceId: 'i', taskId: 't' });
      assert.equal(res.ok, false);
      assert.match(res.error, /常规文件/);
    } finally {
      rmSync(dir, { recursive: true, force: true }); // safe-rm: 目录来自本用例的 mkdtemp
    }
  });
});

test.describe('task:output —— 读取行为', () => {
  test('小文件整读，truncated=false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-taskout-'));
    try {
      const f = join(dir, 'small.output');
      writeFileSync(f, 'hello output\nline2');
      const { call } = harness({ outputFile: f });
      const res = await call({ instanceId: 'i', taskId: 't' });
      assert.equal(res.ok, true);
      assert.equal(res.text, 'hello output\nline2');
      assert.equal(res.truncated, false);
    } finally {
      rmSync(dir, { recursive: true, force: true }); // safe-rm: 目录来自本用例的 mkdtemp
    }
  });

  test('大文件只读尾部并标 truncated——错误与结论总在末尾', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-taskout-'));
    try {
      const f = join(dir, 'big.output');
      // 128KB 填充 + 尾部标记：超过 64KB 上限，头部必须被丢掉
      writeFileSync(f, 'A'.repeat(128 * 1024) + 'TAIL_MARKER_END');
      const { call } = harness({ outputFile: f });
      const res = await call({ instanceId: 'i', taskId: 't' });
      assert.equal(res.ok, true);
      assert.equal(res.truncated, true);
      assert.ok(res.text.endsWith('TAIL_MARKER_END'), '尾部必须保留');
      assert.ok(res.text.length <= 64 * 1024, `实际 ${res.text.length}，不得超过尾部上限`);
      assert.equal(res.size, 128 * 1024 + 'TAIL_MARKER_END'.length, 'size 报的是全量大小');
    } finally {
      rmSync(dir, { recursive: true, force: true }); // safe-rm: 目录来自本用例的 mkdtemp
    }
  });

  test('空文件 → ok 且空串（不报错、不伪造内容）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-taskout-'));
    try {
      const f = join(dir, 'empty.output');
      writeFileSync(f, '');
      const { call } = harness({ outputFile: f });
      const res = await call({ instanceId: 'i', taskId: 't' });
      assert.equal(res.ok, true);
      assert.equal(res.text, '');
    } finally {
      rmSync(dir, { recursive: true, force: true }); // safe-rm: 目录来自本用例的 mkdtemp
    }
  });

  test('文件已被清理 → 读取失败而非崩溃', async () => {
    const { call } = harness({ outputFile: join(tmpdir(), 'ccm-nonexistent-' + Date.now() + '.output') });
    const res = await call({ instanceId: 'i', taskId: 't' });
    assert.equal(res.ok, false);
    assert.match(res.error, /读取失败/);
  });
});
