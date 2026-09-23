// tests/invariants/server/device-token-wire.test.mjs —— 完整设备令牌不经网络响应下发
// 守护：DEVICE-03（网络响应里的设备 ID 一律是短 ID：待审列表、审计记录、服务端日志回传都不带完整设备令牌）
// 测什么：真起 server，让几台设备真的走一遍「请求接入 → 批准 → 吊销」，再从一台已批准的本机会话
//         看三个出口：pending_devices 广播、audit:get、logs:server。每个出口都先确认对应设备确实
//         以短 ID 形态出现在里面，再断言完整令牌一次都没出现——否则「不含令牌」在出口压根是空的
//         时候也会绿。批准走短 ID 寻址，顺带钉住「按短 ID 批准那台设备真的进得来」。
// 槽位：S2（真 app/server.js 子进程 + 一次性 HOME/CCM_DATA_DIR）
//
// 【缺陷的真实形态】2026-09-22 review P1。trusted_devices 早就只下发 shortId（device-gate.js 的
//   trustedDevicesPayload 头注写明了理由：让吊销真的能吊销），另外三个出口却一直带着完整令牌：
//   pending_devices 的 deviceId、审计记录的 actor.deviceId 与设备类 target、server 日志里的
//   「设备 ID: …」与给操作员复制的 approve 命令。任何已批准会话都读得到——一台日后被吊销的设备
//   手里仍攥着别台的令牌，换上就能冒充进来，吊销形同虚设。
//
// 不测什么 + 为什么：
//  ① 推送正文不含设备 ID —— notifications 的 body 构造，属 S1。
//  ② device_status 事件带 deviceId —— 那是服务端告诉这台设备它自己的状态，本来就该带。
//  ③ 已吊销 / 已拒绝的令牌在日志回传里不脱敏 —— 它们不再是凭据。脱敏按「此刻的信任表 ∪ 待审列表」
//     做，因为令牌格式不固定（isValidDeviceToken 只挡危险字符），按模式认不全。

// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from '../../integration/_spawn-server.mjs';

const TOKEN = 'inv-device-wire-token';
const ROOT = join(import.meta.dirname, '..', '..', '..');
// 浏览器生成的形态：16 字节随机数的十六进制（app/public/js/app.js 生成 device_token 那段）。
// 必须长于 16 位——不超过 16 位的 ID 截断后就是它自己，测不出「给的是不是短 ID」。
const newDeviceToken = () => randomBytes(16).toString('hex');
// 用户在界面上核对的那一串：前 8…后 4（三份实现由 tests/unit/logic-device-id.test.mjs 钉成一致）。
const short = t => `${t.slice(0, 8)}…${t.slice(-4)}`;

let dir, home, logFile, server;

// preload 把 CCM_*_DEVICES_FILE 指向它自己的临时目录，子进程会原样继承；而 server 的文件监听只盯
// CCM_DATA_DIR（device-gate.js）。不显式对齐的话，CLI 批准写进了 preload 那份，监听永远不触发。
// server 与 CLI 必须拿同一对路径（device-approval-grants-access.test.mjs 踩过同一个坑）。
const deviceFiles = () => ({
  CCM_TRUSTED_DEVICES_FILE: join(dir, 'trusted-devices.json'),
  CCM_PENDING_DEVICES_FILE: join(dir, 'pending-devices.json'),
});

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ccm-inv-devwire-'));
  home = mkdtempSync(join(tmpdir(), 'ccm-inv-devwire-home-'));
  logFile = join(dir, 'ccm-server.log');
  writeFileSync(logFile, '');
  server = await spawnServer({
    AUTH_TOKEN: TOKEN, WORK_DIRS: dir, CCM_DATA_DIR: dir, HOME: home, LOG_FILE: logFile, ...deviceFiles(),
  });
  // 生产上 LOG_FILE 是 launchd 把 stdout 重定向过去的（server 自己只读不写）。这里照同样的方式
  // 落盘，logs:server 读到的就是 server 真实打印过的行，而不是测试预先编好的样本。
  server.proc.stdout.on('data', c => appendFileSync(logFile, c));
});
test.after(async () => {
  if (server) await killServer(server.proc);
  // safe-rm: 两处都是本文件 mkdtemp 出来的一次性目录
  for (const d of [dir, home]) if (d) rmSync(d, { recursive: true, force: true });
});

// host 决定走不走设备审批：localhost 是本机 bypass（已批准），别的 Host 落待审（DEVICE-01）。
function connect({ host, deviceToken }) {
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: host },
  });
  sock.on('agent:event', e => events.push(e));
  const ready = new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('connect_error', e => reject(new Error(`握手失败：${e?.message}`)));
  });
  return { sock, events, ready };
}
const withAck = (sock, event, payload) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`${event} 没有回执`)), 5000);
  sock.emit(event, payload, r => { clearTimeout(t); resolve(r); });
});
const deviceStatus = (dev, status) => dev.events.some(e => e.type === 'device_status' && e.payload?.status === status);

// 产品自己的 headless 审批入口：它读写的就是这台 server 的 CCM_DATA_DIR，server 靠文件监听感知。
const cliDevice = (...args) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'device.js'), ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, CCM_DATA_DIR: dir, ...deviceFiles() },
  });
  assert.equal(r.status, 0, `device.js ${args.join(' ')} 失败：${r.stderr}${r.stdout}`);
  return r.stdout;
};
const pendingTokens = () => JSON.parse(cliDevice('list', '--json')).pending.map(p => p.deviceId);

// 让一台设备以「CLI 批准过的受信任设备」身份在线（trustBasis=device-token，能发 web 侧设备操作）。
async function connectTrusted() {
  const token = newDeviceToken();
  const dev = connect({ host: 'chat.example.com', deviceToken: token });
  await dev.ready;
  await waitForCondition(() => pendingTokens().includes(token), { label: '设备落进待审列表' });
  cliDevice('approve', token);
  await waitForCondition(() => deviceStatus(dev, 'approved'), { timeoutMs: 8000, label: 'CLI 批准后在线连接被解锁' });
  return { token, dev };
}

test('pending_devices 只带短 ID；按短 ID 批准，那台设备真的进得来', async () => {
  const admin = connect({ host: 'localhost' });
  await admin.ready;
  const token = newDeviceToken();
  const phone = connect({ host: 'chat.example.com', deviceToken: token });
  await phone.ready;
  try {
    const listed = () => admin.events.filter(e => e.type === 'pending_devices').at(-1)?.payload;
    await waitForCondition(() => JSON.stringify(listed() ?? {}).includes(token.slice(0, 8)),
      { label: '已批准会话收到含这台设备的待审广播' });
    const payload = listed();
    assert.ok(!JSON.stringify(payload).includes(token),
      `待审广播带出了完整设备令牌：${JSON.stringify(payload)}`);
    assert.ok(payload.devices.some(d => d.shortId === short(token)),
      `待审广播里应以短 ID 列出这台设备：${JSON.stringify(payload)}`);

    admin.sock.emit('user:approveDevice', { shortId: short(token) });
    await waitForCondition(() => deviceStatus(phone, 'approved'), { label: '按短 ID 批准后那台设备被解锁' });
  } finally {
    admin.sock.close();
    phone.sock.close();
  }
});

test('audit:get 的 actor 与设备类 target 只给短 ID', async () => {
  // 一台受信任设备在 web 上吊销另一台：这条记录的 actor 是一台【仍受信任】的设备，target 是被吊销
  // 的那台——两个位置各带一个令牌。前面 CLI 批准两台时监听器还会各记一条 device_approved。
  const actor = await connectTrusted();
  const victim = await connectTrusted();
  const admin = connect({ host: 'localhost' });
  await admin.ready;
  try {
    actor.dev.sock.emit('user:revokeTrustedDevice', { shortId: short(victim.token) });
    await waitForCondition(() => deviceStatus(victim.dev, 'denied'), { label: '被吊销设备收到 denied' });

    const r = await withAck(admin.sock, 'audit:get', { limit: 200 });
    const revoked = r.records.find(x => x.action === 'device_revoked' && x.meta?.via === 'web');
    assert.ok(revoked, `没找到这次 web 吊销的审计记录，下面「不含令牌」会假绿：${JSON.stringify(r.records)}`);
    const body = JSON.stringify(r.records);
    assert.ok(!body.includes(actor.token), `审计回传带出了一台仍受信任设备的完整令牌：${body}`);
    assert.ok(!body.includes(victim.token), `审计回传带出了被吊销设备的完整令牌：${body}`);
    assert.equal(revoked.actor.deviceId, short(actor.token));
    assert.equal(revoked.target, short(victim.token));
  } finally {
    admin.sock.close();
    actor.dev.sock.close();
    victim.dev.sock.close();
  }
});

test('logs:server 回传前把待审与受信任设备的令牌换成短 ID', async () => {
  const trusted = await connectTrusted();
  const pendingToken = newDeviceToken();
  const pending = connect({ host: 'chat.example.com', deviceToken: pendingToken });
  await pending.ready;
  const admin = connect({ host: 'localhost' });
  await admin.ready;
  try {
    // 前提：server 真的把完整令牌打进了日志（「设备 ID: …」与给操作员复制的 approve 命令）
    await waitForCondition(() => {
      const raw = readFileSync(logFile, 'utf8');
      return raw.includes(trusted.token) && raw.includes(pendingToken);
    }, { label: '日志文件里出现两台设备的完整令牌' });

    const r = await withAck(admin.sock, 'logs:server', { limit: 500 });
    assert.equal(r.ok, true, `读日志失败：${JSON.stringify(r)}`);
    const body = r.lines.join('\n');
    for (const [label, token] of [['待审', pendingToken], ['受信任', trusted.token]]) {
      // 前 8 位在脱敏前后都在：先确认读到的就是那段日志，否则下面「不含令牌」会假绿
      assert.ok(body.includes(token.slice(0, 8)),
        `日志回传里根本没有${label}设备那几行——读到的不是那段日志：\n${body}`);
      assert.ok(!body.includes(token), `日志回传带出了${label}设备的完整令牌：\n${body}`);
      assert.ok(body.includes(short(token)), `${label}设备应以短 ID 形态留在日志回传里：\n${body}`);
    }
  } finally {
    admin.sock.close();
    pending.sock.close();
    trusted.dev.sock.close();
  }
});
