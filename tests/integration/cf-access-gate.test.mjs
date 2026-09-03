// tests/integration/cf-access-gate.test.mjs —— 公网 CF Access 鉴权判决集成测试
// 覆盖 auth-token.test.mjs 刻意禁用、从未验证过的公网分支（app/src/server/app.js httpAuth / io.use）：
// isPublicHost=true 时强制 Access JWT、验签失败 fail-closed、且禁 token 回退（堵"不发 JWT 头改走 token 路"后门）。
// 用无 JWT / 乱码 JWT 触发 verifyAccessJwt 早期 throw——不需真 CF 签名、不触发网络。
//
// ★ 为什么是「每个用例一台全新 server 子进程」（2026-08-02 修）：见 auth-token.test.mjs 同段注释。
//   简述：rate-limiter 的 500ms 指数退避是强制短锁，第一次失败鉴权就把 127.0.0.1 锁住，同文件后续
//   断言（含正向对照的 200）全拿 429 —— 此前本文件 4/6 红且零信号。限速状态是 server 进程内 Map，
//   隔离必须做在进程级。
// ★ 每个用例只允许产生【一次】失败鉴权；要断言两条失败路径就拆成两个用例（下面 query / header
//   两个"禁 token 后门"用例就是为此拆开的，此前它们挤在一个用例里，第二条必吃 429）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { request } from 'node:http';
import { spawnServer, killServer } from './_spawn-server.mjs';

const PUBLIC_HOST = 'ccm.example.com';
const AUTH_TOKEN = 'secret-token';

let port, proc, dataDir;

async function startServer() {
  dataDir = mkdtempSync(join(tmpdir(), 'ccm-cfgate-test-'));
  const spawned = await spawnServer({
    AUTH_TOKEN,
    CCM_DATA_DIR: dataDir,
    WORK_DIR: dataDir,
    IDLE_TIMEOUT_MS: '10000',
    // 启用 CF Access（三项齐全 → enabled=true；与 auth-token.test.mjs 相反，它刻意传空串关掉）。
    // 「三项真的生效了」由下面「公网 Host + 正确 token → 仍 401」那两个用例行为性地证明：若 CF 配置
    // 没到子进程，isPublicHost 对 ccm.example.com 判 false → 回落 token 路 → 那两个用例会拿到 200 而
    // 立刻变红。比此前 in-process 调 initCfAccess() + 断言 isAccessEnabled() 更贴近真实判决链。
    CF_ACCESS_HOSTNAME: PUBLIC_HOST,
    CF_ACCESS_TEAM: 'testteam',
    CF_ACCESS_AUD: 'test-aud-tag',
  });
  proc = spawned.proc;
  port = spawned.port;
}

async function stopServer() {
  if (proc) { await killServer(proc); proc = null; }
  if (dataDir) {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 已被清理 */ }
    dataDir = null;
  }
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

test.describe('公网 CF Access 鉴权判决', () => {
  test.beforeEach(async () => { await startServer(); });
  test.afterEach(async () => { await stopServer(); });

  test('公网 Host + 无 Access JWT → 401（fail-closed）', async () => {
    const res = await httpRequest('/health', { headers: { host: PUBLIC_HOST } });
    assert.equal(res.statusCode, 401);
  });

  test('公网 Host + query 里正确 AUTH_TOKEN 但无 JWT → 仍 401（禁 token 后门，核心不变量）', async () => {
    const res = await httpRequest(`/health?token=${AUTH_TOKEN}`, { headers: { host: PUBLIC_HOST } });
    assert.equal(res.statusCode, 401, 'query token 不应在公网放行');
  });

  test('公网 Host + x-auth-token 头里正确 AUTH_TOKEN 但无 JWT → 仍 401（禁 token 后门，核心不变量）', async () => {
    const res = await httpRequest('/health', { headers: { host: PUBLIC_HOST, 'x-auth-token': AUTH_TOKEN } });
    assert.equal(res.statusCode, 401, 'x-auth-token 不应在公网放行');
  });

  test('公网 Host + 乱码 JWT → 401（验签失败 fail-closed）', async () => {
    const res = await httpRequest('/health', { headers: { host: PUBLIC_HOST, 'cf-access-jwt-assertion': 'not.a.valid.jwt' } });
    assert.equal(res.statusCode, 401);
  });

  test('非公网 Host（LAN）+ 正确 token → 200（token 路仅对非公网有效，对照）', async () => {
    const res = await httpRequest(`/health?token=${AUTH_TOKEN}`, { headers: { host: '127.0.0.1' } });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'ok');
  });

  test('非公网 Host（LAN）+ 错 token → 401（对照）', async () => {
    const res = await httpRequest('/health?token=wrong', { headers: { host: '127.0.0.1' } });
    assert.equal(res.statusCode, 401);
  });

  test('Socket 公网 Host + 正确 token 但无 JWT → 握手被拒（禁 token 后门）', async () => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: AUTH_TOKEN },
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
