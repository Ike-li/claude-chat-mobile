// _spawn-server 的失败路径必须在把启动错误交回调用方前回收已 spawn 的 child。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServerSpawner } from './_spawn-server.mjs';

test('readiness 超时：先终止已 spawn 的 server，再抛启动错误', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGTERM') {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, signal);
      });
    }
    return true;
  };

  const spawnServer = createServerSpawner({
    spawnProcess: () => child,
    requestHealth: async () => JSON.stringify({ status: 'ok', buildNonce: 'other-server' }),
    sleep: async () => {},
    maxAttempts: 1,
  });

  await assert.rejects(
    spawnServer({ AUTH_TOKEN: '', WORK_DIR: '/tmp/ccm-test', CCM_DATA_DIR: '/tmp/ccm-test' }),
    /Server startup timeout/
  );

  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(child.exitCode, 0);
});

test('readiness 成功：保留调用方对 child 的收尾责任', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = signal => { signals.push(signal); return true; };
  let spawnOptions;

  const spawnServer = createServerSpawner({
    spawnProcess: (_command, _args, options) => {
      spawnOptions = options;
      return child;
    },
    requestHealth: async () => JSON.stringify({
      status: 'ok',
      buildNonce: spawnOptions.env.CCM_BUILD_NONCE,
    }),
    sleep: async () => {},
    maxAttempts: 1,
  });

  const result = await spawnServer({
    AUTH_TOKEN: '',
    WORK_DIR: '/tmp/ccm-test',
    CCM_DATA_DIR: '/tmp/ccm-test',
    CCM_TEST_PRESERVE_EMPTY_ENV: '0',
  });

  assert.equal(result.proc, child);
  assert.equal(result.port, Number(spawnOptions.env.PORT));
  assert.equal(result.buildNonce, spawnOptions.env.CCM_BUILD_NONCE);
  assert.equal(spawnOptions.env.CCM_TEST_PRESERVE_EMPTY_ENV, '1');
  assert.deepEqual(signals, []);
});

// 机主 .env 常开 LOG_TERMINAL=on（生产桌面日志窗）。集成测每起一个 server 子进程若继承它，
// 就会 osascript 开 Terminal.app 窗口；kill 时 zsh/tail 又常弹「是否终止进程」确认框，窗口堆满桌面。
// 必须在 spawn 侧强制关掉——关窗路径（stopLogTerminalSync）依赖优雅退出，SIGKILL/竞态下不可靠。
test('spawn 强制 LOG_TERMINAL=off：隔离机主 .env，且忽略 envOverrides 试图重新打开', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  let spawnOptions;
  const prev = process.env.LOG_TERMINAL;
  process.env.LOG_TERMINAL = 'on';
  try {
    const spawnServer = createServerSpawner({
      spawnProcess: (_command, _args, options) => {
        spawnOptions = options;
        return child;
      },
      requestHealth: async () => JSON.stringify({
        status: 'ok',
        buildNonce: spawnOptions.env.CCM_BUILD_NONCE,
      }),
      sleep: async () => {},
      maxAttempts: 1,
    });
    await spawnServer({
      AUTH_TOKEN: '',
      WORK_DIR: '/tmp/ccm-test',
      CCM_DATA_DIR: '/tmp/ccm-test',
      LOG_TERMINAL: 'on', // 调用方误传也不得放行
    });
  } finally {
    if (prev === undefined) delete process.env.LOG_TERMINAL;
    else process.env.LOG_TERMINAL = prev;
  }
  // 非空非 on：挡住 dotenv 回填（空串在非 PRESERVE 路径会被清掉，.env 的 on 会灌回来）
  assert.equal(spawnOptions.env.LOG_TERMINAL, 'off');
});
