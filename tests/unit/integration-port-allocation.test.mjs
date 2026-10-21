// tests/unit/integration-port-allocation.test.mjs —— 起 server 的测试不得替 server 选端口
//
// 【为什么要一条机械断言，而不是靠 review】同一个形态踩过三次，每次都只修掉了当时看见的那一种写法：
//   · 2026-08-02 spawn 子进程路径——auth-token / cf-access-gate 改成「每用例一台 server」后启动数
//     从 ~6 涨到 ~25，抽签（30000-40000 随机）在生日问题下撞端口概率 ≈3%，实测 29 轮飘红 1 次。
//     修法是 reserveFreePort()：listen(0) 拿到端口就释放，再交给 server。
//   · 2026-09-15 in-process 路径——device-revoke-symmetry 在 CI 上撞 33118，把 v1.10.0 的发版卡住。
//     上一次的修复只接进了 spawn 那条路，16 个 `await import('app/server.js')` 的文件各自抄着抽签没人动。
//   · 2026-10-21 PR #289——config-refresh 整份文件红在「端口 43443 已被占用」。reserveFreePort() 本身
//     就是「先选好再交过去」：从释放端口到 server 加载完模块图再 listen 有几百毫秒，并行的别的进程
//     （它自己的 listen(0)、或一条出向连接占的临时端口）随时能先拿走。现在由 server 自己 listen(0)
//     （CCM_TEST_EPHEMERAL_PORT，见 app/src/server/app.js「监听」一节），测试这边不再碰端口号。
//
// 【为什么是源码文本断言】这是架构守卫类（docs/testing.md §5），没有行为等价物：一个照样先选端口、
// 只是这一次没撞上的写法，在行为层完全合格——而那恰恰是要挡的。失效形态又是「间歇红」，
// 最容易被当成 flaky 重跑掉（2026-09-15 当天就是先重跑绕过的），人工 review 指望不上。
// 行为层那一半在 tests/integration/_spawn-server.test.mjs「端口抢占」那组（容器里跑）。
//
// 不管的：显式钉 PORT 的 spawnServer 调用（WS-6「重启后端口不变」是用法本身要求同一个端口），
// 以及 service-self-start-record 故意先占住一个端口、验证 server 起不来的那条——两者都不是「替 server 选端口」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 会起真 server 的两棵树：S2 子进程（invariants/server）与集成层（integration）。
const SCANNED_DIRS = ['integration', join('invariants', 'server')];
const HELPER = join('integration', '_spawn-server.mjs');

function scannedFiles() {
  const files = SCANNED_DIRS.flatMap(dir =>
    readdirSync(join(TESTS_ROOT, dir))
      .filter(f => f.endsWith('.mjs'))
      .map(f => join(dir, f)));
  // 扫描面塌了不是"没有违规"：目录改名/搬空时 offenders 天然是空数组，
  // 下面的 assert.deepEqual(offenders, []) 会误判成"全部合规"。
  for (const dir of SCANNED_DIRS) {
    assert.ok(files.some(f => f.startsWith(dir + '/') || f.startsWith(dir + '\\')),
      `${join(TESTS_ROOT, dir)} 下扫不到任何 .mjs 文件，扫描面塌了`);
  }
  // 只看代码不看注释：好几个文件的注释正是在讲「以前 import('../../app/server.js') 那样写为什么不行」。
  // 前一字符排除冒号与引号，免得把 'http://127.0.0.1…' 当注释剥掉。
  const stripLineComments = src => src.replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  return files.map(rel => ({ rel, src: stripLineComments(readFileSync(join(TESTS_ROOT, rel), 'utf8')) }));
}

const offendersOf = re => scannedFiles().filter(({ rel, src }) => rel !== HELPER && re.test(src)).map(f => f.rel);

test('in-process 起 server 前不得给 process.env.PORT 赋值（抽签、预留空闲端口都算）', () => {
  // 判据锚在「给 PORT 赋值」这个动作上，不锚在值从哪来：抽签与 reserveFreePort() 是同一个缺陷，
  // 换个来源（别的 helper、算出来的数）也还是。`(?!=)` 放过 === 比较。
  const offenders = offendersOf(/process\.env\.PORT\s*=(?!=)/);
  assert.deepEqual(
    offenders,
    [],
    `这些文件先替 in-process server 选好端口再 import：从选定到 server listen 之间有几百毫秒，` +
    `并行的别的进程能先拿走，server 的 EADDRINUSE 处理是 process.exit(1)，整份文件当场红在 :1:1。` +
    `改用 _spawn-server.mjs 的 importServerInProcess()（server 自己 listen(0)）：${offenders.join(', ')}`,
  );
});

test('in-process 起 server 一律经 importServerInProcess()，不直接 import app/server.js', () => {
  // 直接 import 而不设 CCM_TEST_EPHEMERAL_PORT，server 会绑配置里的端口（缺省 3000）——
  // 并行的两个这样的文件必然互撞，比抽签还糟。
  const offenders = offendersOf(/import\(\s*['"][^'"]*app\/server\.js['"]\s*\)/);
  assert.deepEqual(
    offenders,
    [],
    `这些文件直接 import app/server.js：没有临时端口开关，server 会绑配置端口（缺省 3000），` +
    `并行时互撞。改用 _spawn-server.mjs 的 importServerInProcess()：${offenders.join(', ')}`,
  );
});

test("不用 PORT: '0' 表示「随便一个空闲端口」", () => {
  // 配置层把 PORT=0 当无效值回落到 3000（app/src/ops/config.js 的 positiveNumber），
  // 写的人以为是临时端口，实际所有这么写的文件都在抢 3000。banner-secrets / workdir-source 曾经就是。
  const offenders = offendersOf(/\bPORT\s*:\s*['"`]0['"`]/);
  assert.deepEqual(
    offenders,
    [],
    `这些文件给 server 传 PORT: '0'，它在配置层等于 3000，不是临时端口；` +
    `要临时端口传 CCM_TEST_EPHEMERAL_PORT: '1'：${offenders.join(', ')}`,
  );
});
