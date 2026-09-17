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
//  ② logs:server 回传那一跳 —— 需要建连 + 读真实日志文件，另一道闸，不与横幅混在一条用例里。
//  ③ maskToken 的截断规则 —— 纯函数契约，归 tests/unit/sanitizer.test.mjs。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
