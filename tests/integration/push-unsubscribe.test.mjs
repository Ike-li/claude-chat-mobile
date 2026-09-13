// tests/integration/push-unsubscribe.test.mjs —— 推送订阅的完整生命周期（真 server + 真落盘）
// 为什么非要在集成层做一遍：server-http 的单测用的是**假 push 对象**（`removeSubscription: endpoint => …`），
// 它证明得了路由的判据（403 / 400 / 删哪条），却证明不了 app/src/server/app.js 里那一行接线
// （`removeSubscription: removePushSubscription`）真的接上了。名字写错、忘了从 notify 里解构出来，
// 单测一条都不会红，运行时才 `push.removeSubscription is not a function` → 500。
// 这个仓库里「server 接线洞只有真起一次 server 才抓得到」已经发生过不止一次。
// 零 token（不起真 claude turn），走「可靠集成」档。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import webpush from 'web-push';
import { waitForServerReady } from './_spawn-server.mjs';

const TOKEN = 'push-unsub-test-token';
const PHONE = { endpoint: 'https://push.example/phone', keys: { p256dh: 'p-phone', auth: 'a-phone' } };
const IPAD = { endpoint: 'https://push.example/ipad', keys: { p256dh: 'p-ipad', auth: 'a-ipad' } };

let port, dataDir, httpServer, io;

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-push-unsub-'));
  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR',
    'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  process.env.AUTH_TOKEN = TOKEN;
  // 真密钥对（本地生成，不联网）：VAPID 缺一项 push.enabled 就是 false，两条路由全部 503，
  // 那样测到的只是「服务没配推送」，接线照样没被碰过。
  const vapid = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:test@example.com';

  const serverModule = await import('../../app/server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  for (const k of ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  const cfAccess = await import('../../app/src/auth/cf-access.js');
  cfAccess.initCfAccess();
  await waitForServerReady(port, TOKEN);
}

// 127.0.0.1 直连 + Host 为 127.0.0.1 → shouldBypassDeviceApproval 判为「真本机直连」，
// 过得了 /push/(un)subscribe 的第二因子，不必先造一台受信设备。
async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
}

const onDisk = () => JSON.parse(readFileSync(join(dataDir, 'push-subscription.json'), 'utf8')).map(s => s.endpoint);

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) delete process.env[k];
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
}

test.describe('/push/unsubscribe 生命周期', () => {
  test.before(async () => { await startServer(); });
  test.after(async () => { await cleanup(); });

  test('订阅两台 → 退订其中一台：真 server 真落盘，另一台照留', async () => {
    assert.equal((await post('/push/subscribe', PHONE)).status, 200);
    assert.equal((await post('/push/subscribe', IPAD)).status, 200);
    assert.deepEqual(onDisk().sort(), [IPAD.endpoint, PHONE.endpoint].sort());

    const out = await post('/push/unsubscribe', { endpoint: PHONE.endpoint });
    assert.equal(out.status, 200, `路由没挂上或接线断了：${out.status} ${JSON.stringify(out.body)}`);
    assert.equal(out.body?.removed, true, 'removed=true 才说明 removeSubscription 真被调到了');
    assert.deepEqual(onDisk(), [IPAD.endpoint], '手机退订不该掐掉 iPad，且必须落盘');
  });

  test('重复退订 → 仍 200 但 removed=false（幂等，不谎报成功）', async () => {
    const out = await post('/push/unsubscribe', { endpoint: PHONE.endpoint });
    assert.equal(out.status, 200);
    assert.equal(out.body?.removed, false);
    assert.deepEqual(onDisk(), [IPAD.endpoint]);
  });

  test('不给 endpoint → 400，绝不当成「清空全部」', async () => {
    assert.equal((await post('/push/unsubscribe', {})).status, 400);
    assert.deepEqual(onDisk(), [IPAD.endpoint], '400 之后名单必须一条不少');
  });
});
