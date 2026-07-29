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
