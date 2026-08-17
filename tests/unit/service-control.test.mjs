// tests/unit/service-control.test.mjs —— scripts/service.js 的控制路径（start/stop/restart/health）
//
// 本文件里最重要的一组是 health 的「401 绝不重试」：
// src/server/http.js:94-105 对鉴权失败无条件计数、src/server/app.js:309 让 loopback 也进限速、
// src/auth/rate-limiter.js:9-13 阈值 8 锁 15 分钟。一个会重试的健康检查能在 40 秒内
// 把机主连同手机一起关在门外 15 分钟。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createServiceManager, launchctlTimeoutMs } from '../../scripts/service.js';

const HOME = '/Users/you';
const REPO = '/Users/you/code/claude-chat-mobile';
const SERVER_PLIST = `${HOME}/Library/LaunchAgents/com.ccm.server.plist`;

const SERVER_OBJ = {
  Label: 'com.ccm.server',
  ProgramArguments: ['/bin/zsh', '-lc', `cd ${REPO} && exec /opt/homebrew/bin/node server.js`],
  RunAtLoad: true,
  KeepAlive: true,
  StandardOutPath: `${HOME}/Library/Logs/ccm-server.log`,
  StandardErrorPath: `${HOME}/Library/Logs/ccm-server.log`,
};

const tsvWith = (pid) => ['PID\tStatus\tLabel', `${pid ?? '-'}\t0\tcom.ccm.server`].join('\n');

function setup({ pids = [26867], httpGet, launchctlFails = false, tcpProbe = () => true, env = { PORT: '3000', AUTH_TOKEN: 'tok' }, extraPlists = [], execLaunchctl } = {}) {
  const calls = [];
  const httpCalls = [];
  const present = new Set([SERVER_PLIST, ...extraPlists]);
  let tick = 0;

  const mgr = createServiceManager({
    platform: 'darwin',
    home: HOME,
    repo: REPO,
    node: '/opt/homebrew/bin/node',
    uid: 501,
    now: () => 1786000000000,
    execLaunchctl: execLaunchctl ?? ((args) => {
      calls.push(args);
      if (args[0] === 'list') {
        // 每次 list 推进一格，模拟 kickstart 后 PID 变化
        const pid = pids[Math.min(tick++, pids.length - 1)];
        return { status: 0, stdout: tsvWith(pid), stderr: '' };
      }
      return launchctlFails
        ? { status: 1, stdout: '', stderr: 'Could not find service' }
        : { status: 0, stdout: '', stderr: '' };
    }),
    readPlistFile: (p) => (p === SERVER_PLIST ? SERVER_OBJ : null),
    fileExists: (p) => present.has(p),
    readFileRaw: () => null,
    readManifest: () => null,
    readEnv: () => env,
    envFileExists: () => true,
    tcpProbe,
    lanIp: () => null,
    realpath: (p) => p,
    sleep: () => {},
    httpGet: httpGet ?? ((url) => { httpCalls.push(url); return { status: 200, body: '{"status":"ok"}' }; }),
  });

  return { mgr, calls, httpCalls };
}

test.describe('start / stop', () => {
  test('start 用 kickstart（unit 已加载时 bootstrap 会报 already loaded）', () => {
    const { mgr, calls } = setup();
    const r = mgr.start('server');
    assert.equal(r.ok, true);
    const kick = calls.find((a) => a[0] === 'kickstart');
    assert.ok(kick, '应调 kickstart');
    assert.equal(kick[1], 'gui/501/com.ccm.server', 'domain 要带 uid 与 label');
  });

  test('stop 用 bootout', () => {
    const { mgr, calls } = setup();
    const r = mgr.stop('server');
    assert.equal(r.ok, true);
    assert.deepEqual(calls.find((a) => a[0] === 'bootout'), ['bootout', 'gui/501/com.ccm.server']);
  });

  test('未安装的 unit 拒绝启停（否则 launchctl 报一句看不懂的错）', () => {
    const { mgr } = setup();
    const r = mgr.start('logrotate');
    assert.equal(r.ok, false);
    assert.match(r.error, /未安装/);
  });

  // 归属护栏管的是「写」：install/uninstall 会改盘上的 plist。启停不改任何配置，
  // 所以机主自建的 tunnel-watch 也该能从菜单栏开关 —— 否则「看得见管不着」。
  test('unknown unit（机主自建的 tunnel-watch）允许启停', () => {
    const { mgr, calls } = setup({ extraPlists: [`${HOME}/Library/LaunchAgents/com.ccm.tunnel-watch.plist`] });
    const r = mgr.start('tunnel-watch');
    assert.equal(r.ok, true, '前缀命中的 unit 应可启停，只是不能 install/uninstall');
    assert.ok(calls.some((a) => a[0] === 'kickstart' && a[1].includes('tunnel-watch')));
  });

  test('前缀都不命中的 label 拒绝操作（别人的 unit 不归我们管）', () => {
    const { mgr } = setup();
    const r = mgr.start('io.beszel.hub');
    assert.equal(r.ok, false);
  });

  test('launchctl 失败如实报错', () => {
    const { mgr } = setup({ launchctlFails: true });
    const r = mgr.stop('server');
    assert.equal(r.ok, false);
    assert.match(r.error, /Could not find service/);
  });
});

test.describe('restart --wait —— 用 PID 变化判就绪', () => {
  // 不打 /health 判就绪：那要带 token，而带错 token 会计入限速。launchd 直接告诉你 PID 换没换，
  // 这正是 tests/integration/_spawn-server.mjs 里 buildNonce 想解决的问题的零成本等价物。
  test('PID 变了即认为重启完成', () => {
    const { mgr, calls } = setup({ pids: [26867, 26867, 30001] });
    const r = mgr.restart('server', { wait: true });
    assert.equal(r.ok, true);
    assert.equal(r.oldPid, 26867);
    assert.equal(r.newPid, 30001);
    assert.ok(calls.some((a) => a[0] === 'kickstart' && a.includes('-k')), 'restart 要用 kickstart -k');
  });

  test('等待期间不发任何 HTTP 请求（这是不触发限速的全部依据）', () => {
    const { mgr, httpCalls } = setup({ pids: [26867, 30001] });
    mgr.restart('server', { wait: true });
    assert.deepEqual(httpCalls, [], 'restart 路径绝不能碰 HTTP');
  });

  test('PID 一直不变 → 超时并如实报告（不假装成功）', () => {
    const { mgr } = setup({ pids: [26867] });
    const r = mgr.restart('server', { wait: true, timeoutMs: 300, intervalMs: 100 });
    assert.equal(r.ok, false);
    assert.match(r.error, /超时|未能确认/);
  });

  test('新 PID 起来了但端口连不上 → 报出来（进程活着不等于服务可用）', () => {
    const { mgr } = setup({ pids: [26867, 30001], tcpProbe: () => false });
    const r = mgr.restart('server', { wait: true, timeoutMs: 300, intervalMs: 100 });
    assert.equal(r.ok, false);
    assert.match(r.error, /端口|监听/);
  });

  test('不带 --wait 时立刻返回，不轮询', () => {
    const { mgr, calls } = setup({ pids: [26867] });
    const r = mgr.restart('server');
    assert.equal(r.ok, true);
    assert.equal(calls.filter((a) => a[0] === 'list').length, 1, '只为拿旧 PID 查一次');
  });

  // spawnSync 超时 stderr 为空；必须显式说「超时」，不能落到「未知错误」。
  test('kickstart 超时必须说「超时」，不能翻译成「未知错误」', () => {
    const err = new Error('spawnSync launchctl ETIMEDOUT');
    err.code = 'ETIMEDOUT';
    const { mgr } = setup({
      execLaunchctl: (args) => {
        if (args[0] === 'list') return { status: 0, stdout: tsvWith(26867), stderr: '' };
        if (args[0] === 'kickstart') {
          return { status: null, stdout: '', stderr: '', error: err, signal: 'SIGTERM' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const r = mgr.restart('server');
    assert.equal(r.ok, false);
    assert.match(r.error, /超时/, `应告诉用户是超时，实际：${r.error}`);
    assert.doesNotMatch(r.error, /未知错误/, '空 stderr 的超时不能落到兜底文案');
  });
});

test.describe('launchctl 超时预算', () => {
  // 2026-08-17 本机实测：logrotate 刚跑完再 `kickstart -k` 堵约 20s 才返回 0。
  // 25s 是盖过这次观察的客户端预算；list/bootout 仍 5s，见下一条。
  test('kickstart 要比 launchd 默认节流窗口长（实测紧接着再 kickstart -k ≈ 20s）', () => {
    assert.ok(launchctlTimeoutMs(['kickstart', '-k', 'gui/501/com.ccm.logrotate']) >= 25_000);
    assert.ok(launchctlTimeoutMs(['kickstart', 'gui/501/com.ccm.server']) >= 25_000);
  });

  test('list / bootout 保持短超时（高频、不该被 kickstart 的长窗口拖累）', () => {
    assert.equal(launchctlTimeoutMs(['list']), 5_000);
    assert.equal(launchctlTimeoutMs(['bootout', 'gui/501/com.ccm.server']), 5_000);
  });
});

test.describe('health —— 唯一会碰 HTTP 的路径', () => {
  test('带 token 打 /health，200 → ok', () => {
    const { mgr, httpCalls } = setup();
    const r = mgr.health();
    assert.equal(r.ok, true);
    assert.equal(httpCalls.length, 1);
    assert.match(httpCalls[0], /token=tok/);
  });

  // ★ 这条测试直接锁住限速自锁那个坑
  test('401 绝不重试，且译成有用的诊断（不是「鉴权失败」四个字）', () => {
    let n = 0;
    const { mgr } = setup({ httpGet: () => { n += 1; return { status: 401, body: '{"status":"unauthorized"}' }; } });
    const r = mgr.health();
    assert.equal(n, 1, '收到 401 后一次都不能再试——8 次就锁 15 分钟');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'auth-mismatch');
    assert.match(r.error, /\.env|重启|不一致/);
  });

  test('429 也不重试（已经被锁了，再戳只会更久）', () => {
    let n = 0;
    const { mgr } = setup({ httpGet: () => { n += 1; return { status: 429, body: '{"status":"rate_limited"}' }; } });
    const r = mgr.health();
    assert.equal(n, 1);
    assert.equal(r.reason, 'rate-limited');
  });

  test('连不上 → 报服务没在跑，不误导成鉴权问题', () => {
    const { mgr } = setup({ httpGet: () => { throw new Error('ECONNREFUSED'); } });
    const r = mgr.health();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unreachable');
  });

  test('.env 没有 AUTH_TOKEN 时不带 token 参数（未设 token 的部署本就放行）', () => {
    const { mgr, httpCalls } = setup({ env: { PORT: '3000' } });
    mgr.health();
    assert.ok(!httpCalls[0].includes('token='), '没 token 就别拼一个空的上去');
  });

  test('health 结果里不回显 token', () => {
    const { mgr } = setup();
    assert.ok(!JSON.stringify(mgr.health()).includes('tok'));
  });
});

// ── 第三轮审查 #8：stop 之后 start 不起来 ────────────────────────────────
//
// `man launchctl`：bootout "**removes their definitions** [from] the domain"；
// kickstart "Instructs launchd to run **the specified service**"。被 bootout 掉的 unit 已经不在
// domain 里，kickstart 必然 `Could not find service`。而 guardControllable 只检查 plist 文件存在
// （bootout 不删文件），所以护栏放行、直接撞上失败。
//
// 这条以前没被抓到，是因为既有用例只断言 argv 形状（「start 用 kickstart」「stop 用 bootout」），
// 没有一条走 stop→start 往返。**这个 fake 会真的模拟 launchd 的 domain 语义**：
// bootout 把 label 从 list 里摘掉，对不在 domain 里的 label 做 kickstart 会失败。
function domainAwareSetup() {
  const calls = [];
  let loaded = true;   // domain 里有没有这条 service
  let pid = 26867;

  const mgr = createServiceManager({
    platform: 'darwin', home: HOME, repo: REPO, node: '/opt/homebrew/bin/node', uid: 501,
    now: () => 1786000000000,
    execLaunchctl: (args) => {
      calls.push(args);
      const [cmd] = args;
      if (cmd === 'list') {
        return { status: 0, stdout: loaded ? tsvWith(pid) : 'PID\tStatus\tLabel', stderr: '' };
      }
      if (cmd === 'bootout') {
        if (!loaded) return { status: 1, stdout: '', stderr: 'Could not find service' };
        loaded = false;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'bootstrap') {
        loaded = true; pid += 1;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'kickstart') {
        // ★ 关键：不在 domain 里就找不到——这正是真实 launchctl 的行为
        if (!loaded) return { status: 1, stdout: '', stderr: 'Could not find service "gui/501/com.ccm.server"' };
        pid += 1;
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    readPlistFile: (p) => (p === SERVER_PLIST ? SERVER_OBJ : null),
    fileExists: (p) => p === SERVER_PLIST,   // bootout 不删 plist 文件
    readFileRaw: () => null, readManifest: () => null,
    readEnv: () => ({ PORT: '3000', AUTH_TOKEN: 'tok' }), envFileExists: () => true,
    tcpProbe: () => true, lanIp: () => null, realpath: (p) => p, sleep: () => {},
    httpGet: () => ({ status: 200, body: '{"status":"ok"}' }),
  });
  return { mgr, calls, isLoaded: () => loaded };
}

test.describe('stop → start 往返（真实 domain 语义）', () => {
  test('★ stop 之后 start 必须成功（此前恒失败：bootout 移除定义、kickstart 找不到）', () => {
    const { mgr, isLoaded } = domainAwareSetup();
    assert.equal(mgr.stop('server').ok, true, 'stop 应成功');
    assert.equal(isLoaded(), false, 'bootout 之后 unit 已不在 domain 里');

    const r = mgr.start('server');
    assert.equal(r.ok, true, `start 应把它拉回来，实际错误：${r.error}`);
    assert.equal(isLoaded(), true, 'start 之后应重新在 domain 里');
  });

  test('unit 已加载时 start 仍走 kickstart（bootstrap 会报 already loaded）', () => {
    const { mgr, calls } = domainAwareSetup();
    assert.equal(mgr.start('server').ok, true);
    assert.ok(calls.some((a) => a[0] === 'kickstart'), '已加载时应用 kickstart');
    assert.ok(!calls.some((a) => a[0] === 'bootstrap'), '已加载时不该 bootstrap');
  });

  test('未加载时 start 用 bootstrap 把 plist 重新载入 domain', () => {
    const { mgr, calls } = domainAwareSetup();
    mgr.stop('server');
    calls.length = 0;
    assert.equal(mgr.start('server').ok, true);
    const boot = calls.find((a) => a[0] === 'bootstrap');
    assert.ok(boot, 'ered 未加载时应 bootstrap');
    assert.equal(boot[1], 'gui/501', 'bootstrap 的第一个参数是 domain');
    assert.equal(boot[2], SERVER_PLIST, '第二个参数是 plist 路径');
  });

  test('restart 对未加载的 unit 也能救回来（kickstart -k 同样找不到 service）', () => {
    const { mgr, isLoaded } = domainAwareSetup();
    mgr.stop('server');
    const r = mgr.restart('server');
    assert.equal(r.ok, true, `restart 应先把它载回 domain，实际错误：${r.error}`);
    assert.equal(isLoaded(), true);
  });
});
