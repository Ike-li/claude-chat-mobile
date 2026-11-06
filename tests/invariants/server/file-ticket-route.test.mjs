// tests/invariants/server/file-ticket-route.test.mjs —— 文件票据在真组装根上的接线
// 守护：FILE-04（用户文件不得以可执行形态同源内联）、SCOPE-01（断开文件夹后票据立即失效）、
//       DEVICE-01（未审批设备拿不到票据，吊销后取不到文件）
// 测什么：socket 签发 → GET /f/:ticket 全链路；公网 Host 只认 Access JWT；全局 compression、安全头与路由的真实组合
// 不测什么 + 为什么：① 票据过期淘汰、Range 各形态、FIFO、symlink、fd 泄漏的判据在 S1
//   （file-tickets.test.mjs、server-file-handlers.test.mjs），这里只证明真 server 走的是那条路
//   ② 手机上的播放、拖动、下载属真机项
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR 与配置文件；Access 公钥预置进本地缓存，
//       TEAM 用保留域名 .invalid，联网拉证书必失败，缓存原样保留）
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer, waitForCondition } from '../../integration/_spawn-server.mjs';

const TOKEN = 'e5f6a7b8'.repeat(8);
const PUBLIC_HOST = 'ccm.example.com';
const LAN_HOST = 'lan.example.com';
const TEAM_DOMAIN = 'ccm-test.invalid';
const AUD = 'ccm-test-aud';
const KID = 'ccm-test-k1';

const VIDEO = randomBytes(64 * 1024);
// 够大、可压缩：compression 默认阈值 1KB，小文件测不出它碰没碰响应
const NOTES = Buffer.from('compressible line\n'.repeat(4096));

let root, repo, other, server, accessJwt;
const openSockets = [];

function connect({ host = 'localhost', headers = {} } = {}) {
  const deviceToken = randomBytes(16).toString('hex');
  const events = [];
  const sock = ioClient(`http://127.0.0.1:${server.port}`, {
    auth: { token: TOKEN, deviceToken },
    transports: ['websocket'], reconnection: false, timeout: 4000,
    extraHeaders: { Host: host, ...headers },
  });
  openSockets.push(sock);
  sock.on('agent:event', event => events.push(event));
  const ready = new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('connect_error', error => reject(new Error(`握手失败：${error?.message}`)));
  });
  return { sock, events, ready, deviceToken };
}

async function connectLocal() {
  const client = connect();
  await client.ready;
  return client;
}

const emit = (sock, event, payload) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时：事件没到 handler`)), 8000);
  sock.emit(event, payload, reply => { clearTimeout(timer); resolve(reply); });
});

async function openFile(client, path, cwd = repo) {
  const opened = await emit(client.sock, 'file:open', { cwd, path });
  assert.equal(opened.ok, true, `file:open 失败，下面的取文件断言全是空转：${JSON.stringify(opened)}`);
  return opened;
}

// fetch 设不了 Host 头，而 Host 正是这里要区分的东西
const get = (path, { host = 'localhost', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: server.port, path, headers: { Host: host, ...headers } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on('error', reject);
  });
  req.on('error', reject);
  req.end();
});

const deviceStatus = (client, status) => client.events.some(event => event.type === 'device_status' && event.payload?.status === status);
const shortId = token => `${token.slice(0, 8)}…${token.slice(-4)}`;

test.before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-inv-file-ticket-')));
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  repo = join(root, 'repo');
  other = join(root, 'other');
  mkdirSync(join(repo, 'final'), { recursive: true });
  mkdirSync(home);
  mkdirSync(dataDir);
  mkdirSync(other);
  writeFileSync(join(repo, 'final', 'video.mp4'), VIDEO);
  writeFileSync(join(repo, 'notes.txt'), NOTES);
  writeFileSync(join(repo, 'page.html'), '<script>localStorage.clear()</script>');
  writeFileSync(join(repo, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(join(other, 'a.txt'), 'still connected\n');

  const configPath = join(root, 'ccm.config.json');
  writeFileSync(configPath, JSON.stringify({ WORKDIRS: [{ path: repo, sessionLimit: 9 }, { path: other, sessionLimit: 9 }] }));

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  writeFileSync(join(dataDir, 'cf-access-certs.json'), JSON.stringify({ keys: [jwk] }));
  accessJwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(`https://${TEAM_DOMAIN}`)
    .setAudience(AUD)
    .setSubject('ccm-test-user')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);

  server = await spawnServer({
    AUTH_TOKEN: TOKEN, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'),
    CCM_DATA_DIR: dataDir, CCM_CONFIG_FILE_PATH: configPath, WORK_DIRS: '', WORK_DIRS_FILE: '',
    CCM_TRUSTED_DEVICES_FILE: join(dataDir, 'trusted-devices.json'),
    CCM_PENDING_DEVICES_FILE: join(dataDir, 'pending-devices.json'),
    CF_ACCESS_HOSTNAME: PUBLIC_HOST, CF_ACCESS_TEAM: TEAM_DOMAIN, CF_ACCESS_AUD: AUD,
  });
});

test.afterEach(() => {
  for (const sock of openSockets.splice(0)) sock.close();
});

test.after(async () => {
  if (server) await killServer(server.proc);
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

test('已批准连接：票据取回的字节与磁盘一致，安全头全部到位', async () => {
  const client = await connectLocal();
  const opened = await openFile(client, 'final/video.mp4');
  assert.equal(opened.media, 'video', '前端靠 media 决定渲染播放器');

  const res = await get(opened.url);
  assert.equal(res.status, 200, `这就是手机上要播的那个视频：${res.status}`);
  assert.deepEqual(res.body, VIDEO, '取回的字节和磁盘不一致');
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.equal(res.headers['accept-ranges'], 'bytes', '缺了它 <video> 不发 Range，拖不动进度条');
  assert.equal(res.headers['x-content-type-options'], 'nosniff', '全局 nosniff 没覆盖到，浏览器会改判类型');
  assert.equal(res.headers['content-security-policy'], 'sandbox', '要盖掉全局 CSP，否则直接打开 URL 时文件跑在 CCM 的源里');
  assert.match(res.headers['cache-control'], /no-store/, '票据内容进了缓存，吊销后还能从缓存取');
});

test('FILE-04：html、svg 只能下载，不以 CCM 的源内联', async () => {
  const client = await connectLocal();
  for (const name of ['page.html', 'pic.svg']) {
    const opened = await openFile(client, name);
    assert.equal(opened.media, null, `${name} 不该进预览分支`);
    const res = await get(opened.url);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers['content-type'], 'application/octet-stream', `${name} 按原类型发出去，脚本就能读走令牌`);
    assert.match(res.headers['content-disposition'], /^attachment/, `${name} 必须是附件`);
    assert.equal(res.headers['content-security-policy'], 'sandbox', name);
  }
});

test('全局 compression 不碰文件响应：Content-Length 和 Range 都还在', async () => {
  const client = await connectLocal();
  const gzip = { 'Accept-Encoding': 'gzip' };
  const page = await get('/', { headers: gzip });
  assert.equal(page.headers['content-encoding'], 'gzip', '对照：这台 server 的 compression 没开，下面的断言测不出东西');

  const { url } = await openFile(client, 'notes.txt');
  const whole = await get(url, { headers: gzip });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers['content-encoding'], undefined, '下载被压缩后 Content-Length 失效，手机上看不到下载进度');
  assert.equal(whole.headers['content-length'], String(NOTES.length));
  assert.deepEqual(whole.body, NOTES);

  const part = await get(url, { headers: { ...gzip, Range: 'bytes=100-199' } });
  assert.equal(part.status, 206, '全局中间件吞掉了 Range，<video> 拖动时只能从头重下');
  assert.equal(part.headers['content-encoding'], undefined);
  assert.equal(part.headers['content-range'], `bytes 100-199/${NOTES.length}`);
  assert.deepEqual(part.body, NOTES.subarray(100, 200));
});

test('公网 Host：票据不顶替 Access JWT', async () => {
  const client = await connectLocal();
  const { url } = await openFile(client, 'final/video.mp4');
  const assertion = { 'cf-access-jwt-assertion': accessJwt };

  assert.equal((await get(url, { host: PUBLIC_HOST })).status, 401, '公网入口上单靠 URL 取到了文件');
  assert.equal((await get(url, { host: PUBLIC_HOST, headers: { 'cf-access-jwt-assertion': 'garbage' } })).status, 401, '乱写的 JWT 被放行');
  const res = await get(url, { host: PUBLIC_HOST, headers: assertion });
  assert.equal(res.status, 200, '正向对照：带合法 JWT 也取不到，上面的 401 就证明不了什么');
  assert.deepEqual(res.body, VIDEO);
});

test('公网 Host：经 Access 进来的手机签发的票据能用', async () => {
  // Access 连接不在设备信任表里，票据不能因为查不到设备就被拒
  const phone = connect({
    host: PUBLIC_HOST,
    headers: { origin: `https://${PUBLIC_HOST}`, 'cf-access-jwt-assertion': accessJwt },
  });
  await phone.ready;
  const { url } = await openFile(phone, 'final/video.mp4');
  const res = await get(url, { host: PUBLIC_HOST, headers: { 'cf-access-jwt-assertion': accessJwt } });
  assert.equal(res.status, 200, 'Access 手机打不开自己签发的票据');
  assert.deepEqual(res.body, VIDEO);
});

test('未审批设备拿不到票据；批准后能取，吊销后立刻取不到', async () => {
  const admin = await connectLocal();
  const device = connect({ host: LAN_HOST });
  await device.ready;

  const denied = await emit(device.sock, 'file:open', { cwd: repo, path: 'final/video.mp4' });
  assert.equal(denied.ok, false, `待审设备拿到了票据：${JSON.stringify(denied)}`);
  assert.equal(denied.error, 'device_not_approved');
  assert.equal(denied.url, undefined);

  const id = shortId(device.deviceToken);
  admin.sock.emit('user:approveDevice', { shortId: id });
  await waitForCondition(() => deviceStatus(device, 'approved'), { label: '设备被批准' });
  const { url } = await openFile(device, 'final/video.mp4');
  assert.equal((await get(url, { host: LAN_HOST })).status, 200, '对照：批准后取不到，下面的 403 就证明不了吊销生效');

  admin.sock.emit('user:revokeTrustedDevice', { shortId: id });
  await waitForCondition(() => deviceStatus(device, 'denied'), { label: '设备被吊销' });
  assert.equal((await get(url, { host: LAN_HOST })).status, 403, '被吊销的手机拿旧票据还能取文件');
});

test('断开文件夹后，已签发的票据立刻失效', async () => {
  const client = await connectLocal();
  const { url } = await openFile(client, 'a.txt', other);
  assert.equal((await get(url)).status, 200, '对照：断开前就取不到，下面的 404 证明不了什么');

  const removed = await emit(client.sock, 'folders:remove', { path: other });
  assert.equal(removed.ok, true, `断开失败：${JSON.stringify(removed)}`);
  assert.equal((await get(url)).status, 404, '文件夹断开了，票据还能取到里面的文件');
});

test('伪造的票据取不到东西', async () => {
  assert.equal((await get(`/f/${randomBytes(32).toString('base64url')}`)).status, 404);
});
