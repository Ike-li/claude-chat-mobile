// _spawn-server 的失败路径必须在把启动错误交回调用方前回收已 spawn 的 child。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServerSpawner, waitForCondition } from './_spawn-server.mjs';
import { SPAWN_ENV_BLOCKLIST } from '../helpers/spawn-env.mjs';

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

// waitForCondition 是 2026-08-02 从死掉的 tests/helpers/integration.mjs 里扶正过来的等待原语
// （现役集成测试此前用 33 处裸 sleep(N) 猜时序）。它自己是测试基建，得有自己的回归。
test('waitForCondition：条件转真即返回该真值，不空等满超时', async () => {
  let calls = 0;
  const started = Date.now();
  const value = await waitForCondition(() => (++calls >= 3 ? 'ready' : false), { intervalMs: 1, timeoutMs: 2000 });
  assert.equal(value, 'ready');
  assert.equal(calls, 3);
  assert.ok(Date.now() - started < 1000, '应在条件满足时立刻返回，而不是等到 timeoutMs');
});

test('waitForCondition：探测期抛错不算失败，超时才报，且带 label 与最后一次原因', async () => {
  await assert.rejects(
    () => waitForCondition(() => { throw new Error('ECONNREFUSED'); }, { intervalMs: 1, timeoutMs: 30, label: '/health' }),
    err => {
      assert.match(err.message, /等待「\/health」超时/);
      assert.match(err.message, /ECONNREFUSED/, '超时错误须带上最后一次探测失败原因，否则只剩泛型超时不好查');
      return true;
    },
  );
});

test('waitForCondition：条件恒假（不抛错）也会超时，错误里不硬塞原因', async () => {
  await assert.rejects(
    () => waitForCondition(() => false, { intervalMs: 1, timeoutMs: 30, label: '恒假条件' }),
    /等待「恒假条件」超时（30ms）$/u,
  );
});

// 端口选择：抽签换成向 OS 要空闲端口（见 _spawn-server.mjs reserveFreePort 的算术）。
// 调用方显式钉 PORT 的既有用法（WS-6「重启后端口不变」）不能被这个改动带偏。
test('不传 PORT 时向 OS 要空闲端口，而不是随机抽签', async () => {
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.kill = () => true;
  let spawnOptions;
  let pickCalls = 0;

  const spawnServer = createServerSpawner({
    spawnProcess: (_c, _a, options) => { spawnOptions = options; return child; },
    requestHealth: async () => JSON.stringify({ status: 'ok', buildNonce: spawnOptions.env.CCM_BUILD_NONCE }),
    sleep: async () => {},
    maxAttempts: 1,
    pickPort: async () => { pickCalls += 1; return 45678; },
  });

  const result = await spawnServer({ AUTH_TOKEN: '', WORK_DIR: '/tmp/ccm-test', CCM_DATA_DIR: '/tmp/ccm-test' });

  assert.equal(pickCalls, 1, '未指定 PORT 时必须问 OS 要，不能自己抽');
  assert.equal(result.port, 45678);
  assert.equal(spawnOptions.env.PORT, '45678');
});

test('显式传 PORT 时照用，不去问 OS（重启同端口的用法不能被带偏）', async () => {
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.kill = () => true;
  let spawnOptions;
  let pickCalls = 0;

  const spawnServer = createServerSpawner({
    spawnProcess: (_c, _a, options) => { spawnOptions = options; return child; },
    requestHealth: async () => JSON.stringify({ status: 'ok', buildNonce: spawnOptions.env.CCM_BUILD_NONCE }),
    sleep: async () => {},
    maxAttempts: 1,
    pickPort: async () => { pickCalls += 1; return 45678; },
  });

  const result = await spawnServer({ PORT: '31999', AUTH_TOKEN: '', WORK_DIR: '/tmp/ccm-test', CCM_DATA_DIR: '/tmp/ccm-test' });

  assert.equal(pickCalls, 0);
  assert.equal(result.port, 31999);
  assert.equal(spawnOptions.env.PORT, '31999');
});

test('reserveFreePort 真的给出可立即绑定的空闲端口（不是占着不放）', async () => {
  const spawnServer = createServerSpawner({
    spawnProcess: () => {
      const c = new EventEmitter();
      c.exitCode = null; c.signalCode = null;
      // 必须真的响应 SIGTERM：否则 killServer 会走满 3s+3s 两轮超时，这条用例白耗 6 秒。
      c.kill = () => { queueMicrotask(() => { c.exitCode = 0; c.emit('exit', 0, 'SIGTERM'); }); return true; };
      return c;
    },
    requestHealth: async () => { throw new Error('不探测'); },
    sleep: async () => {},
    maxAttempts: 0,
  });
  // maxAttempts=0 直接走超时分支，但端口已由真实 reserveFreePort 选出并写进错误信息
  await assert.rejects(
    spawnServer({ AUTH_TOKEN: '', WORK_DIR: '/tmp/ccm-test', CCM_DATA_DIR: '/tmp/ccm-test' }),
    err => {
      const port = Number(err.message.match(/端口 (\d+)/)?.[1]);
      assert.ok(Number.isInteger(port) && port > 1024, `应拿到合法端口，得到 ${port}`);
      return true;
    },
  );
});

// 同 LOG_TERMINAL 那条的动机，但覆盖面从「一个键」扩到「一批生产键」。
// 集成测用 {...process.env} 继承调用者环境，而调用者未必是干净 shell：2026-09-01 实测，从 CCM web 端
// 启动的 Claude Code 会话继承了生产 server 进程的整份环境（指纹 CCM_HOOKS_ORIGIN=web-sdk），于是
// CF_ACCESS_* 会让被测 server 真的启用 Access 并对外拉生产 team 的 JWKS，VAPID_* 则把推送密钥
// 一并带进测试进程。baseEnv 注入的是一个构造出来的「脏」环境——不能依赖宿主 env，否则在干净机器上恒绿。
test('spawn 摘掉继承来的生产键（CF_ACCESS_*/VAPID_* 等），但保留无关键', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  let spawnOptions;

  const spawnServer = createServerSpawner({
    baseEnv: {
      PATH: '/usr/bin', HOME: '/home/someone',          // 无关键：必须原样保留
      CF_ACCESS_HOSTNAME: 'ccm.example.com', CF_ACCESS_TEAM: 'prod-team', CF_ACCESS_AUD: 'aud',
      VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:a@b.c',
      PUBLIC_URL: 'https://prod.example.com', NTFY_URL: 'https://ntfy.sh', NTFY_TOPIC: 't',
      WORK_DIRS_FILE: '/etc/ccm/workdirs.json',
      CCM_HOOKS_ORIGIN: 'web-sdk', CCM_STATUSLINE_ORIGIN: 'web-sdk',
    },
    spawnProcess: (_command, _args, options) => { spawnOptions = options; return child; },
    requestHealth: async () => JSON.stringify({ status: 'ok', buildNonce: spawnOptions.env.CCM_BUILD_NONCE }),
    sleep: async () => {},
    maxAttempts: 1,
  });

  await spawnServer({ AUTH_TOKEN: 't', WORK_DIR: '/tmp/ccm-test', CCM_DATA_DIR: '/tmp/ccm-test' });

  for (const key of SPAWN_ENV_BLOCKLIST) {
    assert.equal(key in spawnOptions.env, false, `${key} 不该传给被测 server`);
  }
  assert.equal(spawnOptions.env.PATH, '/usr/bin', '无关键必须保留');
  assert.equal(spawnOptions.env.HOME, '/home/someone');
  assert.equal(spawnOptions.env.WORK_DIR, '/tmp/ccm-test', 'envOverrides 照常生效');
});

test('调用方显式传入的键不受 blocklist 影响（overrides 排在 strip 之后）', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  let spawnOptions;

  const spawnServer = createServerSpawner({
    baseEnv: { CF_ACCESS_TEAM: 'inherited-prod-team' },
    spawnProcess: (_command, _args, options) => { spawnOptions = options; return child; },
    requestHealth: async () => JSON.stringify({ status: 'ok', buildNonce: spawnOptions.env.CCM_BUILD_NONCE }),
    sleep: async () => {},
    maxAttempts: 1,
  });

  // cf-access-gate 那批用例要显式构造 CF 场景——摘的是「继承来的」，不是「显式要的」。
  await spawnServer({ CF_ACCESS_TEAM: 'test-team', AUTH_TOKEN: 't', WORK_DIR: '/tmp/x', CCM_DATA_DIR: '/tmp/x' });
  assert.equal(spawnOptions.env.CF_ACCESS_TEAM, 'test-team');
});
