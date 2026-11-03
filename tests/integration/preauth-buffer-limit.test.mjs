// tests/integration/preauth-buffer-limit.test.mjs —— 未鉴权连接的单包上限（验收 O84 / AC-22-15）
//
// 附件随 user:message 走 socket，所以 engine.io 的单包上限是 32MB。但这个上限此前对所有连接一视同仁：
// 任何人不带凭据就能拿到 sid、往轮询 POST 里塞 32MB，或直连 websocket 发一个 30MB 的帧——在被 413 拒掉
// 或被 socket.io 判成非法之前，整包已经缓冲、占过内存。容器实测 8 路并发之后 RSS 从 115MB 涨到 870MB，
// 静置 20 秒不回落。部署给了内存上限时，这是一条鉴权前就可达的 OOM 路径。
//
// 现在：握手鉴权通过之前，单包上限是 PREAUTH_MAX_BUFFER_BYTES；鉴权通过的那一刻再把这条连接抬回 32MB，
// 之后升级到 websocket 时也一样。本文件两头都钉：未鉴权的大包必须被拒，已鉴权的大包必须照常收（三种传输形态）。
// 执行位守卫：必须是第一条 import（它一旦放行晚了，下面那些模块的顶层代码已经跑过了）。
import '../setup/require-disposable-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { WebSocket } from 'ws';
import { spawnServer, killServer } from './_spawn-server.mjs';

const TOKEN = 'ccm-preauth-buffer-test-token';
// 远大于未鉴权上限、远小于已鉴权上限：两头的判定都不靠边界值碰运气
const OVERSIZE = 512 * 1024;
const AUTHED_PAYLOAD = 2 * 1024 * 1024;

let port, dataDir, serverProc;

test.before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-preauth-buffer-'));
  const started = await spawnServer({
    AUTH_TOKEN: TOKEN,
    WORK_DIRS: dataDir,
    CCM_DATA_DIR: dataDir,
    IDLE_TIMEOUT_MS: '10000',
    CF_ACCESS_HOSTNAME: '',
    CF_ACCESS_TEAM: '',
    CF_ACCESS_AUD: '',
  });
  serverProc = started.proc;
  port = started.port;
});

test.after(async () => {
  await killServer(serverProc);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function pollingHandshake() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(JSON.parse(body.slice(1)).sid));
    }).on('error', reject);
  });
}

function postToSid(sid, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST',
      path: `/socket.io/?EIO=4&transport=polling&sid=${sid}`,
      headers: { 'content-type': 'text/plain;charset=UTF-8', 'content-length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    // 服务端回 413 后可能不再读剩下的 body，写端会遇到 EPIPE / ECONNRESET——那是被拒的正常形态
    req.on('error', err => (['EPIPE', 'ECONNRESET'].includes(err.code) ? resolve(err.code) : reject(err)));
    req.end(body);
  });
}

// 已鉴权客户端：发一个大包后，连接仍在、还能正常 ack 一次探活
async function authedClientSurvivesBigPacket(opts, { waitUpgrade = false } = {}) {
  const socket = ioClient(`http://127.0.0.1:${port}`, { auth: { token: TOKEN }, reconnection: false, ...opts });
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', err => reject(new Error(`握手被拒：${err.message}`)));
    });
    if (waitUpgrade) {
      await new Promise((resolve, reject) => {
        if (socket.io.engine.transport.name === 'websocket') return resolve();
        const timer = setTimeout(() => reject(new Error('5s 内没升级到 websocket')), 5000);
        socket.io.engine.once('upgrade', () => { clearTimeout(timer); resolve(); });
      });
    }
    const transport = socket.io.engine.transport.name;
    let disconnectReason = null;
    socket.once('disconnect', reason => { disconnectReason = reason; });
    socket.emit('zz:oversize-probe', 'x'.repeat(AUTHED_PAYLOAD));
    const ack = await socket.timeout(5000).emitWithAck('conn:ping', {}).catch(err => ({ error: err.message }));
    return { transport, ack, disconnectReason };
  } finally {
    socket.disconnect();
  }
}

test('未鉴权：轮询 POST 超过鉴权前上限 → 413，不再吃满 32MB', async () => {
  const sid = await pollingHandshake();
  const status = await postToSid(sid, '4' + 'x'.repeat(OVERSIZE));
  assert.ok(status === 413 || status === 'EPIPE' || status === 'ECONNRESET', `应被拒，实际 ${status}`);
});

test('未鉴权：直连 websocket 发超过鉴权前上限的帧 → 1009 关闭', async () => {
  const code = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    const timer = setTimeout(() => { ws.terminate(); resolve('timeout'); }, 5000);
    ws.on('open', () => ws.send('4' + 'x'.repeat(OVERSIZE)));
    ws.on('close', c => { clearTimeout(timer); resolve(c); });
    ws.on('error', () => {});
  });
  assert.equal(code, 1009, '应按 Message Too Big 关闭');
});

test('已鉴权：直连 websocket 照常收 2MB 的包', async () => {
  const r = await authedClientSurvivesBigPacket({ transports: ['websocket'] });
  assert.equal(r.transport, 'websocket');
  assert.equal(r.ack?.ok, true, `探活没回：${JSON.stringify(r.ack)}`);
  assert.equal(r.disconnectReason, null);
});

test('已鉴权：只走轮询照常收 2MB 的包', async () => {
  const r = await authedClientSurvivesBigPacket({ transports: ['polling'] });
  assert.equal(r.transport, 'polling');
  assert.equal(r.ack?.ok, true, `探活没回：${JSON.stringify(r.ack)}`);
  assert.equal(r.disconnectReason, null);
});

// 浏览器的默认形态：先轮询握手、鉴权，再升级到 websocket。升级出来的新传输层也得是已鉴权的上限。
test('已鉴权：轮询升级到 websocket 之后照常收 2MB 的包', async () => {
  const r = await authedClientSurvivesBigPacket({}, { waitUpgrade: true });
  assert.equal(r.transport, 'websocket');
  assert.equal(r.ack?.ok, true, `探活没回：${JSON.stringify(r.ack)}`);
  assert.equal(r.disconnectReason, null);
});
