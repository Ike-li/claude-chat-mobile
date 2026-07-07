// test/integration/cf-access-gate.test.mjs —— 公网 CF Access 鉴权判决集成测试
// 覆盖 auth-token.test.mjs 刻意禁用、从未验证过的公网分支（server.js httpAuth / io.use）：
// isPublicHost=true 时强制 Access JWT、验签失败 fail-closed、且禁 token 回退（堵"不发 JWT 头改走 token 路"后门）。
// 用无 JWT / 乱码 JWT 触发 verifyAccessJwt 早期 throw——不需真 CF 签名、不触发网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { request } from 'node:http';

const sleep = ms => new Promise(res => setTimeout(res, ms));
const PUBLIC_HOST = 'ccm.example.com';
let port, dataDir, httpServer, io;

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-cfgate-test-'));
  for (const k of ['PORT', 'AUTH_TOKEN', 'IDLE_TIMEOUT_MS', 'WORK_DIR', 'CCM_DATA_DIR', 'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) {
    delete process.env[k];
  }
  process.env.CCM_DATA_DIR = dataDir;
  process.env.PORT = String(30000 + Math.floor(Math.random() * 10000));
  process.env.IDLE_TIMEOUT_MS = '10000';
  process.env.WORK_DIR = dataDir;
  process.env.AUTH_TOKEN = 'secret-token';
  // 启用 CF Access（三项齐全 → enabled=true；与 auth-token.test.mjs 相反，它刻意删这三项）
  process.env.CF_ACCESS_HOSTNAME = PUBLIC_HOST;
  process.env.CF_ACCESS_TEAM = 'testteam';
  process.env.CF_ACCESS_AUD = 'test-aud-tag';

  const serverModule = await import('../../server.js');
  httpServer = serverModule.httpServer;
  io = serverModule.io;
  port = serverModule.port;

  // 确保 CF Access 以测试 env 初始化为 enabled（不依赖 import 时序/dotenv）
  const cfAccess = await import('../../cf-access.js');
  cfAccess.initCfAccess();
  assert.equal(cfAccess.isAccessEnabled(), true, 'CF Access 应已启用（三项 env 齐全）');

  await sleep(500);
}

// node:http 请求：headers.host 作为 Host 头发送（连接仍走 127.0.0.1），供 isPublicHost 判定公网。
function httpRequest(path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function cleanup() {
  if (httpServer) { httpServer.close(); httpServer = null; }
  if (io) { io.close(); io = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} dataDir = null; }
}

test.describe('公网 CF Access 鉴权判决', process.env.CI ? { skip: 'CI 无本机 claude CLI；集成测试仅本机跑' } : {}, () => {
  test.before(async () => { await startServer(); });
  test.after(async () => { await cleanup(); });

  test('公网 Host + 无 Access JWT → 401（fail-closed）', async () => {
    const res = await httpRequest('/health', { headers: { host: PUBLIC_HOST } });
    assert.equal(res.statusCode, 401);
  });

  test('公网 Host + 正确 AUTH_TOKEN 但无 JWT → 仍 401（禁 token 后门，核心不变量）', async () => {
    const viaQuery = await httpRequest('/health?token=secret-token', { headers: { host: PUBLIC_HOST } });
    assert.equal(viaQuery.statusCode, 401, 'query token 不应在公网放行');
    const viaHeader = await httpRequest('/health', { headers: { host: PUBLIC_HOST, 'x-auth-token': 'secret-token' } });
    assert.equal(viaHeader.statusCode, 401, 'x-auth-token 不应在公网放行');
  });

  test('公网 Host + 乱码 JWT → 401（验签失败 fail-closed）', async () => {
    const res = await httpRequest('/health', { headers: { host: PUBLIC_HOST, 'cf-access-jwt-assertion': 'not.a.valid.jwt' } });
    assert.equal(res.statusCode, 401);
  });

  test('非公网 Host（LAN）+ 正确 token → 200（token 路仅对非公网有效，对照）', async () => {
    const res = await httpRequest('/health?token=secret-token', { headers: { host: '127.0.0.1' } });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'ok');
  });

  test('非公网 Host（LAN）+ 错 token → 401（对照）', async () => {
    const res = await httpRequest('/health?token=wrong', { headers: { host: '127.0.0.1' } });
    assert.equal(res.statusCode, 401);
  });

  test('Socket 公网 Host + 正确 token 但无 JWT → 握手被拒（禁 token 后门）', async () => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: 'secret-token' },
      extraHeaders: { host: PUBLIC_HOST },
      transports: ['websocket'],
      reconnection: false,
    });
    try {
      const err = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('既未连上也未报错（socket Host 模拟可能未生效）')), 5000);
        socket.once('connect_error', e => { clearTimeout(t); resolve(e); });
        socket.once('connect', () => { clearTimeout(t); reject(new Error('公网无 JWT 不应握手成功')); });
      });
      assert.ok(err.message, '应收到握手拒绝');
    } finally {
      socket.disconnect();
    }
  });
});
