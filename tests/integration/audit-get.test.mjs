// tests/integration/audit-get.test.mjs —— 服务面板读审计：连续重复折成一行，刷屏盖不住更早的设备记录
//
// 测什么：真 server 上，盘上已经有一段刷屏时，面板那次 audit:get（limit 20）仍能看到刷屏之前的设备记录；
//   折叠之后出口截断照样生效（设备类 target 只给短 ID，DEVICE-03）。
// 不测什么 + 为什么：① 折叠判据（间隔边界、次数求和）在 tests/unit/audit.test.mjs，那里能精确构造时间
//   ② ×N 的文案在 tests/unit/logic-service-status.test.mjs ③ 面板排版属 S3
// 槽位：集成（真 app/server.js 子进程 + 假 CLI，零 token）。只在容器 / CI 跑。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from './_spawn-server.mjs';

const TOKEN = 'audit-get-token';
const DEVICE = 'aabbccddeeff00112233445566778899'; // 盘上是全量 deviceToken，出口只能给短 ID
const MIN = 60_000;

// 与生产文件同形（2026-10-17 那段刷屏）：actor 全空、两个目标轮流、合并之后每分钟各留一条
function seedRecords(base) {
  let seq = 0;
  const entry = (ts, fields) => ({ id: `audit_${ts}_${++seq}`, ts, actor: { deviceId: null, via: null }, ...fields });
  const records = [entry(base, { action: 'device_revoked', target: DEVICE, outcome: 'denied', meta: { via: 'web' } })];
  for (let i = 1; i <= 40; i++) {
    for (const target of ['/gone-a', '/gone-b']) {
      records.push(entry(base + i * MIN, { action: 'scope_violation', target, outcome: 'denied', meta: { via: 'routeCwd' } }));
    }
  }
  return records;
}

let root, server, sock;

test.before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-audit-get-')));
  const workdir = join(root, 'work');
  mkdirSync(workdir);
  const configPath = join(root, 'ccm.config.json');
  writeFileSync(configPath, JSON.stringify({ WORKDIRS: [workdir] }));
  const auditFile = join(root, 'audit-records.json');
  writeFileSync(auditFile, JSON.stringify({ records: seedRecords(Date.now() - 2 * 60 * MIN) }));
  server = await spawnServer({
    AUTH_TOKEN: TOKEN, CCM_CONFIG_FILE_PATH: configPath, CCM_DATA_DIR: join(root, 'data'), CCM_AUDIT_FILE: auditFile,
  });
  sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken: 'audit-get-device' },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: 'localhost' },
  });
  await new Promise((resolve, reject) => {
    sock.on('connect', resolve);
    sock.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket 未能在 5s 内连上')), 5000);
  });
});

test.after(async () => {
  try { sock?.close(); } catch { /* 已关闭 */ }
  if (server) await killServer(server.proc);
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

const auditGet = limit => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('audit:get 的 ack 超时')), 5000);
  sock.emit('audit:get', { limit }, res => { clearTimeout(timer); resolve(res); });
});

test('盘上有一段刷屏时，面板这一屏仍看得到刷屏之前的设备记录', async () => {
  const { records } = await auditGet(20);
  const revoked = records.find(r => r.action === 'device_revoked');
  assert.ok(revoked, `设备吊销被刷屏挤出了面板：${JSON.stringify(records.map(r => r.action))}`);
  assert.deepEqual(
    records.filter(r => r.action === 'scope_violation').map(r => [r.target, r.repeat]),
    [['/gone-b', 40], ['/gone-a', 40]],
    '刷屏应折成每个目标一行，次数求和',
  );
  assert.ok(!JSON.stringify(records).includes(DEVICE), '全量 deviceToken 是准入凭据，折叠后不能绕过出口截断');
});
