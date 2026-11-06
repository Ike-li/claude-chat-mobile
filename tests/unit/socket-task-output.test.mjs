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
import { makeSession } from '../helpers/agent-unit.mjs';

function harness({ outputFile = null, hasInstance = true, agent = null } = {}) {
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
    routeInstance: () => (hasInstance
      ? agent ?? { getTaskOutputFile: () => outputFile, readRunningTaskOutput: async () => ({ ok: false, reason: 'unavailable' }) }
      : null),
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

// 2.1.318 真 CLI 跑真后台 shell 抓到的原样输出（零 token 探针）：颜色、OSC 8 超链接、\r 重绘的进度条，
// 外加命令打印的 HTML 字面量。任务里说的「手机上转义序列要可读」就是这个形状。
const REAL_CLI_OUTPUT = '\u001b[31mRED_LINE\u001b[0m plain\nlink \u001b]8;;https://x.test\u001b\\label\u001b]8;;\u001b\\ end\n'
  + '\rprogress 10%\rprogress 20%\rprogress 30%\nline 1 <b>not html</b>\n';
const READABLE_OUTPUT = 'RED_LINE plain\nlink label end\nprogress 30%\nline 1 <b>not html</b>\n';

// 真 AgentSession + 假 q：路由判据（运行中 / 已结束）都在实例上，换成假 agent 就测不到两侧接没接上。
function runningSession(q, tasks = [{ task_id: 'bshell', task_type: 'local_bash', description: 'npm run dev' }]) {
  const { s, dispose } = makeSession();
  s.q = q;
  s.reconcileBgTasks(tasks);
  return { s, dispose, call: harness({ agent: s }).call };
}

test.describe('task:output —— 运行中的任务', () => {
  test('后台命令：拿到 CLI 给的末尾输出，truncated 与 size 照报', async () => {
    const { call, dispose } = runningSession({
      getTaskOutput: async () => ({ output: 'latest line\n', total_bytes: 20_000, truncated: true }),
    });
    const res = await call({ instanceId: 'i', taskId: 'bshell' });
    assert.deepEqual(res, { ok: true, text: 'latest line\n', truncated: true, size: 20_000 });
    dispose();
  });

  test('子代理：明确说不支持，不是笼统的「不可用」', async () => {
    const { call, dispose } = runningSession(
      { getTaskOutput: async () => { throw new Error('不该问 CLI'); } },
      [{ task_id: 'aagent', task_type: 'local_agent', description: 'review' }],
    );
    const res = await call({ instanceId: 'i', taskId: 'aagent' });
    assert.equal(res.ok, false);
    assert.match(res.error, /子代理/);
    assert.doesNotMatch(res.error, /任务未完成/, '子代理等多久都不会有，不能让人以为等它结束就行');
    dispose();
  });

  test('SDK 没有这个方法：回落现有文案', async () => {
    const { call, dispose } = runningSession({});
    const res = await call({ instanceId: 'i', taskId: 'bshell' });
    assert.equal(res.ok, false);
    assert.match(res.error, /输出不可用/);
    dispose();
  });

  test('CLI 报错：说出原因，不崩', async () => {
    const { call, dispose } = runningSession({ getTaskOutput: async () => { throw new Error('get_task_output_timeout'); } });
    const res = await call({ instanceId: 'i', taskId: 'bshell' });
    assert.equal(res.ok, false);
    assert.match(res.error, /读取失败：get_task_output_timeout/);
    dispose();
  });

  test('客户端传路径不起作用：运行中这条路同样只认 taskId', async () => {
    const asked = [];
    const { call, dispose } = runningSession({ getTaskOutput: async (id) => { asked.push(id); return { output: 'x', total_bytes: 1, truncated: false }; } });
    await call({ instanceId: 'i', taskId: 'bshell', file: '/etc/passwd', path: '/etc/passwd', outputFile: '/etc/passwd' });
    assert.deepEqual(asked, ['bshell']);
    dispose();
  });

  test('转义序列去掉、\\r 重绘只留最后一版，手机上是终端最后显示的样子', async () => {
    const { call, dispose } = runningSession({
      getTaskOutput: async () => ({ output: REAL_CLI_OUTPUT, total_bytes: REAL_CLI_OUTPUT.length, truncated: false }),
    });
    const res = await call({ instanceId: 'i', taskId: 'bshell' });
    assert.equal(res.text, READABLE_OUTPUT);
    assert.equal(res.size, REAL_CLI_OUTPUT.length, 'size 报的是 CLI 给的全量字节数，不是清理后的长度');
    dispose();
  });

  test('空行保留，CRLF 不多出空行，末尾还在重绘的进度也留得住', async () => {
    const { call, dispose } = runningSession({
      getTaskOutput: async () => ({ output: 'a\n\nb\r\nc\r\n50%\r60%\r', total_bytes: 1, truncated: false }),
    });
    const res = await call({ instanceId: 'i', taskId: 'bshell' });
    assert.equal(res.text, 'a\n\nb\nc\n60%');
    dispose();
  });
});

test.describe('task:output —— 任务结束后', () => {
  function endedSession(q, outputFile) {
    const session = runningSession(q);
    session.s.map({ type: 'system', subtype: 'task_notification', task_id: 'bshell', status: 'completed', output_file: outputFile });
    return session;
  }

  test('读 output_file（尾部 64KB），不改走 CLI 那 8 KiB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-taskout-'));
    let asked = 0;
    try {
      const f = join(dir, 'bshell.output');
      writeFileSync(f, 'H'.repeat(100 * 1024) + 'T'.repeat(30 * 1024) + 'END');
      const { call, dispose } = endedSession({ getTaskOutput: async () => { asked++; return { output: 'short', total_bytes: 5, truncated: false }; } }, f);
      const res = await call({ instanceId: 'i', taskId: 'bshell' });
      assert.equal(asked, 0, '已结束的任务继续读文件');
      assert.ok(res.text.endsWith('END'));
      assert.equal(res.text.length, 64 * 1024, '尾部 64KB 比 CLI 的 8 KiB 多，这是留着这条路的理由');
      assert.equal(res.truncated, true);
      dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true }); // safe-rm: 目录来自本用例的 mkdtemp
    }
  });

  test('读文件这条路同样还原成可读文本', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-taskout-'));
    try {
      const f = join(dir, 'bshell.output');
      writeFileSync(f, REAL_CLI_OUTPUT);
      const { call, dispose } = endedSession({}, f);
      assert.equal((await call({ instanceId: 'i', taskId: 'bshell' })).text, READABLE_OUTPUT);
      dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true }); // safe-rm: 目录来自本用例的 mkdtemp
    }
  });

  test('已结束且 CLI 没给文件：照旧报不可用，不去问 CLI', async () => {
    let asked = 0;
    const { call, dispose } = endedSession({ getTaskOutput: async () => { asked++; return { output: 'x' }; } }, '');
    const res = await call({ instanceId: 'i', taskId: 'bshell' });
    assert.equal(res.ok, false);
    assert.match(res.error, /输出不可用/);
    assert.equal(asked, 0);
    dispose();
  });
});
