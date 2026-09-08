// tests/invariants/server/workdir-source.test.mjs —— 工作区白名单的来源必须显式，空则拒绝启动
// 守护：SCOPE-03（授权工作区列表必须来自显式配置；一个都解析不出时拒绝启动，绝不回落家目录）
// 测什么：配置里的工作区全部解析不出来（路径被删 / 外置盘没挂载 / 手滑写错）时，server 必须
//         非 0 退出并说明原因，而不是悄悄把 $HOME 当成唯一工作区继续服务。
// 槽位：S2（真 app/server.js 子进程 + 一次性 HOME/CCM_DATA_DIR；不建立连接，只看退出码与 stderr）
//
// 【这条为什么不是 SCOPE-01 的一部分】SCOPE-01 管「用户可控路径 realpath 后必须落在授权工作区内」。
// 白名单本身等于 [家目录] 时 SCOPE-01 每一条都是绿的 —— 每个路径确实都落在「授权工作区」内，
// 而那个工作区是整个家目录。它是 SCOPE-01 的上游，两条都要钉。
//
// 【缺陷的真实形态】2026-09-08 实测：parseServerConfig 里 `workDir: env.WORK_DIR || home`，
// 而 applyWorkdirs 又无条件把 WORK_DIR 放进白名单首位。于是「WORKDIRS 里的目录一个都不存在」
// + 「没写 WORK_DIR」两件事一撞，白名单就恰好塌成 [$HOME] —— 全程零报错，启动日志还打印
// 「工作目录: /Users/xxx」，看起来一切正常。README 明写「不要把整个 Home 目录加入工作区」，
// 装机向导也有 work_dir_is_home 专门拒绝这种输入，只有这条静默路径绕开了两者。
//
// 【为什么用「路径不存在」而不是「配置为空」】CONFIG_FILE_PATH 写死在仓库根（app.js:124 的
// join(HERE, ...)），子进程必然读到真实 ccm.config.json，构造不出「配置里没有 WORKDIRS」。
// 而 workdirs.js 有意规定 `WORK_DIRS=` 空串视为「没设」而非「设成空」，也堵死了这条路。
// 指向不存在的目录反而是更真实的场景，且走的是同一个塌陷分支（resolveWorkdirs 全部 warn-skip）。
//
// 不测什么 + 为什么：
//  ① 部分目录有效时的行为 —— 那是 warn-skip 的既有语义，归 tests/unit/workdirs.test.mjs。
//     这里只钉「一个都不剩」这一档，因为只有它会塌到家目录。
//  ② WORK_DIR env 的折叠告警 —— 纯函数契约，归 tests/unit/workdirs.test.mjs 的 foldPrimaryWorkdir。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripInheritedEnv } from '../../helpers/spawn-env.mjs';

// 起一个 server 子进程并等它自行退出（或超时判定为「起来了」）。
// 不用 _spawn-server.mjs 的 spawnServer：那个在启动失败时抛错，而本用例要断言的正是失败本身
// —— 退出码与 stderr 内容都得看得见。
function runServer(envOverrides, { timeoutMs = 15_000 } = {}) {
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

    let stdout = '', stderr = '';
    proc.stdout.on('data', c => { stdout += c; });
    proc.stderr.on('data', c => { stderr += c; });

    // 超时 = 它没有拒绝启动。这是缺陷存在时走的分支，必须能干净地收场并把证据带回去，
    // 否则用例会挂死在这里而不是给出可读的失败。
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);
    let timedOut = false;

    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: String(err), timedOut });
    });
  });
}

test.describe('SCOPE-03: 工作区白名单来源', () => {
  let home, dataDir;

  test.before(() => {
    home = mkdtempSync(join(tmpdir(), 'ccm-inv-wdsrc-home-'));
    dataDir = mkdtempSync(join(tmpdir(), 'ccm-inv-wdsrc-data-'));
  });
  test.after(() => {
    // safe-rm: 两处都是本文件 mkdtemp 出来的一次性目录
    if (home) rmSync(home, { recursive: true, force: true });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('配置的工作区一个都解析不出来 → 拒绝启动，不得回落家目录', async () => {
    const missing = join(dataDir, 'no-such-workspace-here');
    const r = await runServer({
      AUTH_TOKEN: 'inv-scope03-token',
      HOME: home,               // homedir() 在 POSIX 上读 $HOME —— 塌陷时白名单会变成它
      CCM_DATA_DIR: dataDir,
      WORK_DIRS: missing,       // env 压过配置文件里的内联 WORKDIRS（pickWorkdirSource 的优先级）
      PORT: '0',                // 真起监听时让 OS 随便给个端口，避免撞上开发实例的 3000
    });

    assert.equal(r.timedOut, false,
      `server 没有拒绝启动 —— 工作区全部无效时它仍然起来了。stdout:\n${r.stdout}`);
    assert.notEqual(r.code, 0,
      `退出码必须非 0（实际 ${r.code}）。stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    // 光看退出码不够：EADDRINUSE 之类也会非 0 退出。必须确认它是因为「没有工作区」而死的。
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /工作区/,
      `拒绝理由必须指向工作区配置，否则用户无从下手。实际输出：\n${out}`);

    // 最关键的一条：家目录不得出现在任何「这是你的工作区」类输出里。
    // 塌陷时启动日志会打印 `  工作目录: <home>`，这条断言直指那一行。
    assert.doesNotMatch(out, new RegExp(`工作目录:\\s*${home}`),
      `家目录被当成工作目录了 —— 这正是 SCOPE-03 要堵的塌陷。实际输出：\n${out}`);
  });
});
