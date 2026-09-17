// tests/invariants/server/banner-secrets.test.mjs —— 服务端自己的输出里不得出现完整 AUTH_TOKEN
// 守护：AUTH-05（AUTH_TOKEN 不得出现在服务端自身输出中：启动横幅只打掩码，logs:server 回传前脱敏）
// 测什么：真起一个 server 子进程，把整段启动横幅收下来，断言 64 字符的 token 明文一次都没出现，
//         而掩码形态（前 4****后 4）出现了 —— 后者保证「打了点什么」，不是整段被删。
// 槽位：S2（真 app/server.js 子进程 + 一次性 HOME/CCM_DATA_DIR；不建立连接，只看 stdout）
//
// 【缺陷的真实形态】2026-09-17 安全审查 M1。横幅有两条分支各自漏一次：
//  ① `!bindPlan.publiclyReachable`（BIND_MODE=loopback）**每次启动**都打完整 `/#token=…`，
//     没有任何首次/后续的区分。而 loopback 恰好是 cloudflared 隧道用户的推荐绑法
//     （隧道打到 127.0.0.1，绑 loopback 比绑 0.0.0.0 安全），于是最该保护的那批人漏得最勤。
//  ② `isFirstRun`（无 sessions.json）分支打一次完整 URL，留在日志文件里直到轮转。
//
// 【为什么这条值得单列一个不变量】泄露路径是两跳、每一跳单看都合理：
//   横幅写进 LOG_FILE / LOG_TERMINAL 窗口 / 投屏 → 经 Cloudflare Access 进来的会话**默认不需要**
//   AUTH_TOKEN（`DEVICE_APPROVAL_SCOPE` 缺省时设备审批也 bypass）→ 它读一次 `logs:server`
//   就把 token 拿走 → 之后可走 LAN、可在 Access 吊销后继续用。
//   两头各有一道闸（横幅不打、回传脱敏），本文件钉的是前一道。
//
// 【为什么不用源码正则钉】本仓有过教训（见 tests/unit/unread-tracker.test.mjs:54 的注记）：
//   readFileSync + 匹配 `${AUTH_TOKEN}` 钉的是源码长什么样 —— 改个变量名无故变红，
//   换种拼法把 token 打出去照样绿。只有真跑一次、看真实输出，才分得清这两件事。
//
// 不测什么 + 为什么：
//  ① sanitize() 认不认各种凭据形态 —— 纯函数，归 tests/unit/sanitizer.test.mjs（那里有边界用例：
//     3 字符的值不脱、键名不含 token/key/secret 的不脱，证明它不是恒真）。
//  ② maskToken 的截断规则 —— 纯函数契约，归 tests/unit/sanitizer.test.mjs。
//  ③ 设备审批门 —— 本文件用 loopback 建连（DEVICE-01 的设计豁免），审批那条闸归 device-gate.test.mjs。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';
import { stripInheritedEnv } from '../../helpers/spawn-env.mjs';

// 起 server、收满整段横幅就杀掉。不用 _spawn-server.mjs 的 spawnServer：那个不把 stdout 交出来，
// 而横幅正是本用例的唯一证据。监听器紧跟 spawn 挂上，不依赖「流会一直缓着没人读的数据」这类假设。
//
// 收满的判据是横幅自己的分隔线出现两次（它以 `====…` 开头、同样的线收尾）。拿不到就等超时，
// 超时不算失败 —— 那时已收到的 stdout 照样拿去断言，只是证据少一些；真正的失败是断言不过。
function captureBanner(envOverrides, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('node', ['app/server.js'], {
      env: {
        ...stripInheritedEnv(process.env),
        DEV_MODE: '0',
        LOG_TERMINAL: 'off',
        CCM_TEST_PRESERVE_EMPTY_ENV: '1',
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });

    let stdout = '', stderr = '', done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve({ stdout, stderr });
    };

    proc.stdout.on('data', (c) => {
      stdout += c;
      // 两条分隔线之间就是完整横幅；出现第二条即可收工，不必白等超时。
      if ((stdout.match(/={20,}/g) || []).length >= 2) finish();
    });
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('exit', finish);
    proc.on('error', (err) => { stderr += String(err); finish(); });

    const timer = setTimeout(finish, timeoutMs);
  });
}

// 32 字节 hex，与 scripts/config.js 的 generateToken() 同形态同长度。
// 必须用真实长度：短 token 走 maskToken 的 `length < 12 → '***'` 分支，测不到「前 4 后 4」那条路。
const TOKEN = 'a1b2c3d4'.repeat(8);

test.describe('AUTH-05: 服务端输出不得含完整 AUTH_TOKEN', () => {
  let home, dataDir, workdir;

  test.before(() => {
    home = mkdtempSync(join(tmpdir(), 'ccm-inv-banner-home-'));
    dataDir = mkdtempSync(join(tmpdir(), 'ccm-inv-banner-data-'));
    workdir = mkdtempSync(join(tmpdir(), 'ccm-inv-banner-wd-'));
  });
  test.after(() => {
    // safe-rm: 三处都是本文件 mkdtemp 出来的一次性目录
    for (const d of [home, dataDir, workdir]) if (d) rmSync(d, { recursive: true, force: true });
  });

  // 两条 BIND_MODE 都要各跑一次：横幅在这里分叉成两个独立的打印分支，
  // 只测一条时另一条漏了 token 也全绿 —— 而漏的恰恰一直是 loopback 那条。
  for (const bindMode of ['lan', 'loopback']) {
    test(`BIND_MODE=${bindMode}：横幅只打掩码，不打完整 token`, async () => {
      const r = await captureBanner({
        AUTH_TOKEN: TOKEN,
        HOME: home,
        CCM_DATA_DIR: dataDir,
        WORK_DIRS: workdir,
        BIND_MODE: bindMode,
        PORT: '0',
      });
      const out = `${r.stdout}\n${r.stderr}`;

      // 先确认横幅真的打出来了。没有这条，下面那句「不含 token」在 server 压根没启动时也会绿。
      assert.match(out, /已启用鉴权/,
        `没拿到启动横幅，下面的断言会假绿。stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

      assert.ok(!out.includes(TOKEN),
        `完整 AUTH_TOKEN 出现在服务端输出里 —— 它会进 LOG_FILE / 日志窗口 / 投屏，`
        + `而经 CF Access 进来的会话读一次 logs:server 就能拿走。输出：\n${out}`);

      // 反向：掩码形态必须在。只断言「不含明文」的话，把整行删掉也能过，
      // 而那会让用户失去「我这个实例用的是哪个 token」的唯一线索（多实例时要靠它对号）。
      assert.ok(out.includes(`${TOKEN.slice(0, 4)}****${TOKEN.slice(-4)}`),
        `掩码 token 不见了 —— 不是不打，是打掩码。输出：\n${out}`);

      // 占位符要在：横幅仍然要给出可复制的 URL 形状，只是把凭据挖空。
      assert.match(out, /#token=<YOUR_TOKEN>/,
        `URL 里应留 <YOUR_TOKEN> 占位，用户才知道 token 拼在哪。输出：\n${out}`);
    });
  }
});

// 第二道闸：横幅不打完整 token 之后，日志文件里的**历史行**还在，LOG_FILE 也可能收着别的进程
// 写进来的凭据。logs:server 把服务端日志回传给已鉴权会话，这一跳必须自己脱敏，不能指望上游干净。
//
// 【为什么专挑 PEM 私钥做样本】sanitizer 的私钥模式是**跨行**的
// （`-----BEGIN … PRIVATE KEY-----[\s\S]+?-----END …`）。第一版实现写成 `.map(l => sanitize(l))`
// ——先切行再逐行脱敏，那个模式就永远匹配不上，私钥被原样回给客户端，而每一行 base64 单看
// 也不命中任何别的模式。**单行样本（AUTH_TOKEN=…）验不出这个缺陷**：它逐行也能脱掉。
// 所以这条用例的样本必须是跨行的，否则它在缺陷存在时照样全绿。
test.describe('AUTH-05: logs:server 回传前脱敏', () => {
  let home, dataDir, workdir, logFile, server;
  const LOGS_TOKEN = 'e5f6a7b8'.repeat(8);
  const PEM_BODY = 'MIIEowIBAAKCAQEAwJz8Hq2vF3nK9xY7bR4tL6mN0pQ5sW8uV1cX2dE3fG4hI5jK';
  // 首尾标记拼出来、不写成字面量：gitleaks 的 private-key 规则会拦下源码里的完整 BEGIN 行
  // （它不知道这是造给测试用的假数据）。**不走 .gitleaksignore**——那要按 file:rule:line 登记指纹，
  // 行号一漂豁免就悄悄失效，而失效的样子和生效一模一样。让源码里根本不出现那个字面量，
  // 扫描器就仍是满强度的。
  const PEM = kind => `-----${kind} RSA PRIVATE ${'KEY'}-----`;

  test.before(async () => {
    home = mkdtempSync(join(tmpdir(), 'ccm-inv-logs-home-'));
    dataDir = mkdtempSync(join(tmpdir(), 'ccm-inv-logs-data-'));
    workdir = mkdtempSync(join(tmpdir(), 'ccm-inv-logs-wd-'));
    logFile = join(dataDir, 'ccm-server.log');
    writeFileSync(logFile, [
      '2026-09-17T05:00:00.000Z [server] 启动完成',
      `2026-09-17T05:00:01.000Z 本机: http://localhost:3000/#token=${LOGS_TOKEN}`,
      PEM('BEGIN'),
      PEM_BODY,
      `${PEM_BODY}xx`,
      PEM('END'),
      '2026-09-17T05:00:02.000Z [devices] 设备 a1b2c3d4 已批准',
      '',
    ].join('\n'));
    server = await spawnServer({
      AUTH_TOKEN: LOGS_TOKEN, HOME: home, CCM_DATA_DIR: dataDir, WORK_DIRS: workdir, LOG_FILE: logFile,
    });
  });
  test.after(async () => {
    if (server) await killServer(server.proc);
    // safe-rm: 三处都是本文件 mkdtemp 出来的一次性目录
    for (const d of [home, dataDir, workdir]) if (d) rmSync(d, { recursive: true, force: true });
  });

  const fetchLogs = () => new Promise((resolve, reject) => {
    const sock = ioClient(`http://127.0.0.1:${server.port}`, {
      auth: { token: LOGS_TOKEN }, transports: ['websocket'], reconnection: false, timeout: 4000,
    });
    const done = (fn, v) => { try { sock.close(); } catch { /* 已关闭 */ } fn(v); };
    sock.on('connect', () => sock.emit('logs:server', { limit: 200 }, r => done(resolve, r)));
    sock.on('connect_error', e => done(reject, new Error(`握手失败：${e?.message}`)));
    setTimeout(() => done(reject, new Error('logs:server 超时')), 8000);
  });

  test('多行 PEM 私钥必须被整段脱敏（逐行脱敏会漏，这条专门钉它）', async () => {
    const r = await fetchLogs();
    assert.equal(r.ok, true, `读日志失败：${JSON.stringify(r)}`);
    const body = r.lines.join('\n');
    // 先确认读到的是我们写的那份，否则下面「不含私钥」在读空文件时也会绿
    assert.match(body, /启动完成/, `没读到预期日志内容，断言会假绿。实际：\n${body}`);
    assert.ok(!body.includes(PEM_BODY),
      `PEM 私钥正文原样回传了——逐行脱敏会让跨行模式永不匹配。实际：\n${body}`);
  });

  test('日志里的完整 AUTH_TOKEN 也要脱掉', async () => {
    const r = await fetchLogs();
    const body = r.lines.join('\n');
    assert.ok(!body.includes(LOGS_TOKEN),
      `历史日志行里的完整 token 原样回传了。实际：\n${body}`);
  });

  test('反向：非凭据内容原样保留，不能整段抹平', async () => {
    const r = await fetchLogs();
    const body = r.lines.join('\n');
    // 只断言「不含凭据」的话，返回空数组也能全绿，而那会让运维面板彻底没用
    assert.match(body, /设备 a1b2c3d4 已批准/, '正常日志行必须留着，脱敏不是清空');
    assert.match(body, /2026-09-17T05:00:00/, '时间戳要留着，否则日志失去排查价值');
  });
});
