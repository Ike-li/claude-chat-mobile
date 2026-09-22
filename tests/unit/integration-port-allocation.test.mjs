// tests/unit/integration-port-allocation.test.mjs —— 集成测试起 server 必须向 OS 要空闲端口，不得抽签
//
// 【为什么要一条机械断言，而不是靠 review】同一个形态踩过两次：
//   · 2026-08-02 spawn 子进程路径——auth-token / cf-access-gate 改成「每用例一台 server」后启动数
//     从 ~6 涨到 ~25，生日问题下撞端口概率 ≈3%，实测 29 轮飘红 1 次。修法是 _spawn-server.mjs 的
//     reserveFreePort()。
//   · 2026-09-15 in-process 路径——device-revoke-symmetry 在 CI 上撞 33118，把 v1.10.0 的发版卡住。
//     上一次的修复只接进了 spawn 那条路，16 个 `await import('app/server.js')` 的文件各自抄着
//     `30000 + Math.random() * 10000` 没人动。
//
// 抽签的槽位（30000-40000）与 Linux 默认 ephemeral 段（net.ipv4.ip_local_port_range，32768-60999）
// 大面积重叠，所以它不只是「测试之间互撞」——任何一条 outbound 连接（socket.io 客户端自己就有）
// 占用的临时端口，都可能正是另一台 server 要 listen 的那个。并行度越高越容易踩。
//
// 【为什么是源码文本断言】这是架构守卫类（docs/testing.md §5），没有行为等价物：一个照样抽签、
// 只是这一次没撞上的实现，在行为层完全合格——而那恰恰是要挡的。失效形态又是「间歇红」，
// 最容易被当成 flaky 重跑掉（2026-09-15 当天就是先重跑绕过的），人工 review 指望不上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INTEGRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'integration');

// 判据锚在「PORT 的值从 Math.random 来」这个形态上，而不是某个具体数字区间——
// 换个区间抽签（40000 + random * 5000）是同一个缺陷，不能只挡住 30000 那一种写法。
const PORT_FROM_RANDOM = /process\.env\.PORT\s*=[^;\n]*Math\.random/;

test('tests/integration 下没有任何文件用抽签决定 server 端口', () => {
  const mjsFiles = readdirSync(INTEGRATION_DIR).filter(f => f.endsWith('.mjs'));
  // 扫描面塌了不是"没有违规"：目录改名/搬空时 offenders 天然是空数组，
  // 下面的 assert.deepEqual(offenders, []) 会误判成"全部合规"。
  assert.ok(mjsFiles.length > 0, `${INTEGRATION_DIR} 下扫不到任何 .mjs 文件，扫描面塌了`);
  const offenders = mjsFiles
    .filter(f => PORT_FROM_RANDOM.test(readFileSync(join(INTEGRATION_DIR, f), 'utf8')));

  assert.deepEqual(
    offenders,
    [],
    `这些文件在抽签选端口，会在并行跑时间歇性撞端口（表现为「端口 X 已被占用」的假红，` +
    `极易被当成 flaky 重跑掉）：${offenders.join(', ')}。` +
    `改用 _spawn-server.mjs 导出的 reserveFreePort()——它向 OS 要一个当前空闲的端口。`,
  );
});

test('reserveFreePort 已从 _spawn-server.mjs 导出，且真能拿到可用端口', async () => {
  const { reserveFreePort } = await import('../integration/_spawn-server.mjs');
  assert.equal(typeof reserveFreePort, 'function', 'reserveFreePort 必须导出，否则 in-process 的测试无从复用');

  const port = await reserveFreePort();
  assert.equal(Number.isInteger(port), true, `应拿到整数端口，实际 ${port}`);
  // 不断言具体区间：端口由 OS 的临时端口段决定，写死区间等于把测试钉在某个内核配置上。
  assert.ok(port > 0 && port < 65536, `端口应落在合法范围，实际 ${port}`);
});
