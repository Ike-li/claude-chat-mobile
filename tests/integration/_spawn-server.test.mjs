// _spawn-server 的失败路径必须在把启动错误交回调用方前回收已 spawn 的 child。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServerSpawner, killServer, waitForCondition } from './_spawn-server.mjs';
import { SPAWN_ENV_BLOCKLIST } from '../helpers/spawn-env.mjs';

// 假 child：helper 会从 stdout 读 server 绑定后打的 CCM_TEST_LISTENING_PORT 行，假的也得有这条流。
// before 是端口行之前的输出（横幅之类），用来验证调用方事后挂监听仍收得到它。
const REPORTED_PORT = 45678;
function fakeChild({ before = '' } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  child.stdout = new PassThrough();
  child.stdout.write(`${before}CCM_TEST_LISTENING_PORT=${REPORTED_PORT}\n`);
  return child;
}
// helper 挂上 stdout 监听后，流要到下一个 tick 才开始吐数据；`async () => {}` 只让出一个微任务，
// 轮不到它。真实 sleep 是 250ms，这里让出一轮事件循环即可。
const yieldTick = () => new Promise(resolve => setImmediate(resolve));

test('readiness 超时：先终止已 spawn 的 server，再抛启动错误', async () => {
  const child = fakeChild();
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
    sleep: yieldTick,
    maxAttempts: 1,
  });

  await assert.rejects(
    spawnServer({ AUTH_TOKEN: '', WORK_DIRS: '/tmp/ccm-test', CCM_DATA_DIR: '/tmp/ccm-test' }),
    /Server startup timeout/
  );

  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(child.exitCode, 0);
});

test('readiness 成功：保留调用方对 child 的收尾责任', async () => {
  const child = fakeChild();
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
    sleep: yieldTick,
    maxAttempts: 1,
  });

  const result = await spawnServer({
    AUTH_TOKEN: '',
    WORK_DIRS: '/tmp/ccm-test',
    CCM_DATA_DIR: '/tmp/ccm-test',
    CCM_TEST_PRESERVE_EMPTY_ENV: '0',
  });

  assert.equal(result.proc, child);
  assert.equal(result.port, REPORTED_PORT, '返回的端口必须是 server 自己报告的监听端口');
  assert.equal(result.buildNonce, spawnOptions.env.CCM_BUILD_NONCE);
  assert.equal(spawnOptions.env.CCM_TEST_PRESERVE_EMPTY_ENV, '1');
  assert.deepEqual(signals, []);
});

// 本机 .env 常开 LOG_TERMINAL=on（生产桌面日志窗）。集成测每起一个 server 子进程若继承它，
// 就会 osascript 开 Terminal.app 窗口；kill 时 zsh/tail 又常弹「是否终止进程」确认框，窗口堆满桌面。
// 必须在 spawn 侧强制关掉——关窗路径（stopLogTerminalSync）依赖优雅退出，SIGKILL/竞态下不可靠。
test('spawn 强制 LOG_TERMINAL=off：隔离本机 .env，且忽略 envOverrides 试图重新打开', async () => {
  const child = fakeChild();
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
      sleep: yieldTick,
      maxAttempts: 1,
    });
    await spawnServer({
      AUTH_TOKEN: '',
      WORK_DIRS: '/tmp/ccm-test',
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

// 调用方显式钉 PORT 的既有用法（WS-6「重启后端口不变」）不能被「让 server 自己 listen(0)」带偏。
test('显式传 PORT 时照用，不改成临时端口（重启同端口的用法不能被带偏）', async () => {
  const child = fakeChild();
  let spawnOptions;

  const spawnServer = createServerSpawner({
    spawnProcess: (_c, _a, options) => { spawnOptions = options; return child; },
    requestHealth: async () => JSON.stringify({ status: 'ok', buildNonce: spawnOptions.env.CCM_BUILD_NONCE }),
    sleep: yieldTick,
    maxAttempts: 1,
  });

  const result = await spawnServer({ PORT: '31999', AUTH_TOKEN: '', WORK_DIRS: '/tmp/ccm-test', CCM_DATA_DIR: '/tmp/ccm-test' });

  assert.equal(result.port, 31999);
  assert.equal(spawnOptions.env.PORT, '31999');
  assert.notEqual(spawnOptions.env.CCM_TEST_EPHEMERAL_PORT, '1', '钉了端口还让 server 随机绑，重启后就连不回原端口');
});

// 读端口要消费 stdout。device-gate / device-token-wire / workdir-source 都是拿到返回值之后才挂
// stdout 监听，并指望收到从启动起的全部输出（device-gate 文件头写明了这个依赖）——读端口不能把它吃掉。
test('拿到返回值后再挂 stdout 监听，仍收得到端口行之前的输出', async () => {
  const child = fakeChild({ before: '==== 启动横幅 ====\n' });
  let spawnOptions;
  const spawnServer = createServerSpawner({
    spawnProcess: (_c, _a, options) => { spawnOptions = options; return child; },
    requestHealth: async () => JSON.stringify({ status: 'ok', buildNonce: spawnOptions.env.CCM_BUILD_NONCE }),
    sleep: yieldTick,
    maxAttempts: 1,
  });

  const { proc } = await spawnServer({ AUTH_TOKEN: '', WORK_DIRS: '/tmp/ccm-test', CCM_DATA_DIR: '/tmp/ccm-test' });
  await yieldTick(); // 调用方不是立刻挂监听的，中间这段时间里 helper 那边的流照样在吐数据
  let seen = '';
  proc.stdout.on('data', c => { seen += c; });
  child.stdout.end();
  await new Promise(resolve => proc.stdout.on('end', resolve));

  assert.match(seen, /启动横幅/, `调用方漏掉了启动早期的输出，实际只收到：${JSON.stringify(seen)}`);
});

// 同 LOG_TERMINAL 那条的动机，但覆盖面从「一个键」扩到「一批生产键」。
// 集成测用 {...process.env} 继承调用者环境，而调用者未必是干净 shell：2026-09-01 实测，从 CCM web 端
// 启动的 Claude Code 会话继承了生产 server 进程的整份环境（指纹 CCM_HOOKS_ORIGIN=web-sdk），于是
// CF_ACCESS_* 会让被测 server 真的启用 Access 并对外拉生产 team 的 JWKS，VAPID_* 则把推送密钥
// 一并带进测试进程。baseEnv 注入的是一个构造出来的「脏」环境——不能依赖宿主 env，否则在干净机器上恒绿。
test('spawn 摘掉继承来的生产键（CF_ACCESS_*/VAPID_* 等），但保留无关键', async () => {
  const child = fakeChild();
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
    sleep: yieldTick,
    maxAttempts: 1,
  });

  await spawnServer({ AUTH_TOKEN: 't', WORK_DIRS: '/tmp/ccm-test', CCM_DATA_DIR: '/tmp/ccm-test' });

  for (const key of SPAWN_ENV_BLOCKLIST) {
    assert.equal(key in spawnOptions.env, false, `${key} 不该传给被测 server`);
  }
  assert.equal(spawnOptions.env.PATH, '/usr/bin', '无关键必须保留');
  assert.equal(spawnOptions.env.HOME, '/home/someone');
  assert.equal(spawnOptions.env.WORK_DIRS, '/tmp/ccm-test', 'envOverrides 照常生效');
});

test('调用方显式传入的键不受 blocklist 影响（overrides 排在 strip 之后）', async () => {
  const child = fakeChild();
  child.kill = () => true;
  let spawnOptions;

  const spawnServer = createServerSpawner({
    baseEnv: { CF_ACCESS_TEAM: 'inherited-prod-team' },
    spawnProcess: (_command, _args, options) => { spawnOptions = options; return child; },
    requestHealth: async () => JSON.stringify({ status: 'ok', buildNonce: spawnOptions.env.CCM_BUILD_NONCE }),
    sleep: yieldTick,
    maxAttempts: 1,
  });

  // cf-access-gate 那批用例要显式构造 CF 场景——摘的是「继承来的」，不是「显式要的」。
  await spawnServer({ CF_ACCESS_TEAM: 'test-team', AUTH_TOKEN: 't', WORK_DIRS: '/tmp/x', CCM_DATA_DIR: '/tmp/x' });
  assert.equal(spawnOptions.env.CF_ACCESS_TEAM, 'test-team');
});

// 端口抢占（TOCTOU）。2026-10-21 PR #289 的 CI（run 39592963626，unit-test (24)）里 config-refresh
// 整份文件红在「启动失败：端口 43443 已被占用」，被测 PR 根本没碰它。只要端口是测试这边先选好、
// 再交给 server 去 listen，中间就隔着子进程启动 + 加载整棵模块图（几百毫秒），并行的另一个测试进程
// （它自己的 listen(0)，或一条出向连接占的临时端口）随时可能先拿到同一个端口。
//
// 这里把那段窗口的最坏情况做成确定性的：spawn 的那一刻，交给子进程的端口号【已经被别人占着】。
// 对手是同步 bind 的——listen 不带 host 时 Node 在调用栈里就完成 bind，只有 'listening' 事件延到
// 下一 tick——所以子进程连 fork 都还没开始，端口已经没了，不赌时序。
function stealHandedOutPort(thieves) {
  return (command, args, options) => {
    const handedOut = Number(options.env.PORT);
    if (Number.isInteger(handedOut) && handedOut > 0 && handedOut < 65536) {
      // 接了就断：真实的抢占者要么是别的测试起的 server（/health 带的是别人的 nonce），要么是出向连接
      // 占的源端口（连过去直接被拒），都不会吊着连接不应答——那会让就绪探测一直挂在这条连接上。
      const thief = createServer(socket => socket.destroy());
      thief.on('error', () => {}); // 端口若已被第三方占着，bind 失败也无妨：子进程照样拿不到它
      thief.listen(handedOut);
      thieves.push(thief);
    }
    return spawn(command, args, options);
  };
}

test.describe('端口抢占：交给 server 的端口在它 listen 之前被别人占走', () => {
  let dataDir;
  const thieves = [];
  test.before(() => { dataDir = mkdtempSync(join(tmpdir(), 'ccm-spawn-toctou-')); });
  test.after(() => {
    for (const t of thieves) t.close();
    rmSync(dataDir, { recursive: true, force: true }); // safe-rm: 本文件 mkdtemp 的一次性目录
  });

  // 正对照：仪器先证明自己咬得住。显式钉 PORT 是「重启后端口不变」（WS-6）的既有用法，
  // 那个端口被占时 server 必须起不来——这条不红，说明对手没占上，下面那条的绿就不算数。
  test('对照：显式钉的端口被占，server 起不来', async () => {
    const probe = createServer();
    await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const pinned = probe.address().port;
    await new Promise(r => probe.close(r));

    const spawnServer = createServerSpawner({ spawnProcess: stealHandedOutPort(thieves) });
    await assert.rejects(
      spawnServer({ PORT: String(pinned), AUTH_TOKEN: 'toctou-token', WORK_DIRS: dataDir, CCM_DATA_DIR: dataDir }),
      /提前退出/,
      '钉死的端口已被占，server 却「起来了」——对手没占上，这组用例测不到端口抢占',
    );
  });

  test('不钉端口时，任何交给子进程的端口号都被抢走，server 照样起得来', async () => {
    const spawnServer = createServerSpawner({ spawnProcess: stealHandedOutPort(thieves) });
    let started;
    try {
      started = await spawnServer({ AUTH_TOKEN: 'toctou-token', WORK_DIRS: dataDir, CCM_DATA_DIR: dataDir });
    } catch (err) {
      assert.fail(
        `端口在交给 server 之后、它 listen 之前被别人占走，启动就失败了（${err.message}）。` +
        '这正是并行跑集成测试时偶发的「端口 X 已被占用」：端口必须由 server 自己 listen(0) 当场向 OS 要，' +
        '不能由测试先选好再交过去。',
      );
    }
    try {
      assert.ok(started.port > 0, `应拿到 server 实际监听的端口，实际 ${started.port}`);
    } finally {
      await killServer(started.proc);
    }
  });
});
