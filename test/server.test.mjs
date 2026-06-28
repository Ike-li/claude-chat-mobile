// test/server.test.mjs —— server.js 集成测试（零 token、零 agent 创建）
// 启动 server 子进程 → socket.io-client 连接 → 验证事件流与 HTTP 端点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io as ioc } from 'socket.io-client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

const PORT = 3199;
let serverProc;
let tmpDir;

// CI runner 无本机 claude CLI（server.js preflight 会 exit(1)），本文件起真 server 子进程、
// scout 等用例需真 claude 行为——CI 跳过整个文件，本机（有真 claude）照常全跑。
const CI_SKIP = process.env.CI ? { skip: 'CI 无本机 claude CLI；server 集成测试仅本机跑' } : {};

test.before(async () => {
  if (process.env.CI) return;
  tmpDir = await mkdtemp(join(tmpdir(), 'ccm-srv-test-'));
  serverProc = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), AUTH_TOKEN: '', WORK_DIR: tmpDir,
      HOME: process.env.HOME, PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd()
  });
  // 轮询 /health 直到 server ready（最多 10s）
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const body = await httpGet(`http://127.0.0.1:${PORT}/health`);
      if (body.includes('"status":"ok"')) return;
    } catch {}
  }
  throw new Error('Server startup timeout');
});

test.after(async () => {
  if (process.env.CI) return;
  if (serverProc) {
    serverProc.kill('SIGTERM');
    // 等待进程退出（最多 3s，超时则 SIGKILL）
    await Promise.race([
      new Promise(r => serverProc.on('exit', r)),
      new Promise(r => setTimeout(r, 3000))
    ]);
    try { serverProc.kill('SIGKILL'); } catch {}
  }
  try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
});

test.describe('HTTP 端点', CI_SKIP, () => {
  test('GET /health → 200 + JSON body', async () => {
    const body = await httpGet(`http://127.0.0.1:${PORT}/health`);
    const j = JSON.parse(body);
    assert.equal(j.status, 'ok');
    assert.ok(typeof j.timestamp === 'number');
    assert.ok(typeof j.versions === 'object');
  });

  test('GET / → 200 + HTML（index.html）', async () => {
    const body = await httpGet(`http://127.0.0.1:${PORT}/`);
    assert.ok(body.includes('<!DOCTYPE html>') || body.includes('<html'));
  });

  test('GET /nonexistent → 404', async () => {
    const { statusCode } = await httpGetRaw(`http://127.0.0.1:${PORT}/no-such-path`);
    assert.equal(statusCode, 404);
  });
});

test.describe('Socket.IO 连接与认证', CI_SKIP, () => {
  test('无 AUTH_TOKEN 时任何 token 都可通过（127.0.0.1 仅本地）', async () => {
    const s = ioc(`http://127.0.0.1:${PORT}`, { auth: { token: '' }, forceNew: true });
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    assert.ok(s.connected);
    s.disconnect();
  });
});

test.describe('事件流 — 新连接重放', CI_SKIP, () => {
  test('连接后收到合成事件（instances / device_status / pending_devices 至少其一）', async () => {
    const events = [];
    const s = ioc(`http://127.0.0.1:${PORT}`, { auth: { token: '' }, forceNew: true });
    s.on('agent:event', e => events.push(e));
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    // 等服务端 connection handler 同步 emit
    await new Promise(resolve => setTimeout(resolve, 800));
    const types = events.map(e => e.type);
    const expectedTypes = ['instances', 'device_status', 'pending_devices', 'permission_mode', 'effort_mode'];
    const hasExpected = expectedTypes.some(t => types.includes(t));
    assert.ok(hasExpected, `expected one of ${expectedTypes.join('/')}, got: ${types.join(', ')}`);
    s.disconnect();
  });
});

test.describe('session:list — 空工作目录', CI_SKIP, () => {
  test('session:list 返回空列表', async () => {
    const s = ioc(`http://127.0.0.1:${PORT}`, { auth: { token: '' }, forceNew: true });
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const ack = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 3000);
      s.emit('session:list', { cwd: tmpDir }, res => { clearTimeout(t); resolve(res); });
    });
    assert.ok(Array.isArray(ack.sessions));
    assert.equal(ack.sessions.length, 0); // 空工作目录无历史
    s.disconnect();
  });
});

test.describe('session:switch — 非法 sessionId 被拒', CI_SKIP, () => {
  test('含 ../ 的 sessionId → ack { ok: false }', async () => {
    const s = ioc(`http://127.0.0.1:${PORT}`, { auth: { token: '' }, forceNew: true });
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const ack = await new Promise((resolve) => {
      s.emit('session:switch', { sessionId: '../etc/passwd', cwd: tmpDir }, resolve);
    });
    assert.equal(ack.ok, false);
    assert.ok(ack.error);
    s.disconnect();
  });

  test('合法但不存在的 sessionId → ack { ok: false }', async () => {
    const s = ioc(`http://127.0.0.1:${PORT}`, { auth: { token: '' }, forceNew: true });
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const ack = await new Promise((resolve) => {
      s.emit('session:switch', { sessionId: 'nonexistent-12345', cwd: tmpDir }, resolve);
    });
    assert.equal(ack.ok, false);
    s.disconnect();
  });
});

test.describe('session:new — 创建新会话', CI_SKIP, () => {
  test('session:new → ack { ok: true }（懒创建，不发消息不 spawn agent）', async () => {
    const s = ioc(`http://127.0.0.1:${PORT}`, { auth: { token: '' }, forceNew: true });
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const ack = await new Promise((resolve) => {
      s.emit('session:new', { cwd: tmpDir }, resolve);
    });
    assert.equal(ack.ok, true);
    assert.equal(ack.instanceId, null); // 懒开，尚无实例
    assert.equal(ack.sessionId, null);
    s.disconnect();
  });
});

test.describe('session:new — scout 获取真实模型清单', CI_SKIP, () => {
  // session:new 时无活实例 → openScoutInstance 临时创建 AgentSession 调 supportedModels()，
  // 获取真实模型清单后推送前端 + 写入缓存 + 立即 dispose（不留幽灵会话）。
  // 不再依赖缓存猜测或上区旧模型——scout 保证确定性。
  test('session:new 后收到一条 models 事件（scout 获取真实模型）', async () => {
    const s = ioc(`http://127.0.0.1:${PORT}`, { auth: { token: '' }, forceNew: true });
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const modelsEv = await new Promise((resolve) => {
      s.on('agent:event', e => { if (e.type === 'models') resolve(e); });
      s.emit('session:new', { cwd: tmpDir });
      setTimeout(() => resolve(null), 15_000); // scout 可能需要 CLI 启动时间
    });
    assert.ok(modelsEv, 'scout 应推送一条 models 事件（真实模型清单）');
    assert.ok(Array.isArray(modelsEv.payload.models), 'payload.models 应为数组');
    // 真实模型清单可能非空（取决于测试环境的 CLI 配置），不做长度断言
    s.disconnect();
  });
});

test.describe('user:message 输入校验', CI_SKIP, () => {
  test('空消息 → system error', async () => {
    const s = ioc(`http://127.0.0.1:${PORT}`, { auth: { token: '' }, forceNew: true });
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const result = await new Promise((resolve) => {
      s.on('agent:event', e => { if (e.type === 'system' || e.type === 'error') resolve(e); });
      s.emit('user:message', { text: '' });
      setTimeout(() => resolve(null), 2000);
    });
    assert.ok(result, 'should get system/error response');
    assert.ok(result.payload.message.includes('空') || result.payload.message.includes('格式无效'));
    s.disconnect();
  });

  test('超长消息 → system error', async () => {
    const s = ioc(`http://127.0.0.1:${PORT}`, { auth: { token: '' }, forceNew: true });
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const result = await new Promise((resolve) => {
      s.on('agent:event', e => { if (e.type === 'system' || e.type === 'error') resolve(e); });
      s.emit('user:message', { text: 'x'.repeat(60000) });
      setTimeout(() => resolve(null), 2000);
    });
    assert.ok(result, 'should get system/error response');
    assert.ok(result.payload.message.includes('过长'));
    s.disconnect();
  });
});

test.describe('user:setPermissionMode — 档位校验', CI_SKIP, () => {
  test('未知权限档 → system error', async () => {
    const s = ioc(`http://127.0.0.1:${PORT}`, { auth: { token: '' }, forceNew: true });
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const ack = await new Promise((resolve) => {
      s.on('agent:event', e => { if (e.type === 'system') resolve(e); });
      s.emit('user:setPermissionMode', { mode: 'invalid_mode' });
      setTimeout(() => resolve(null), 2000);
    });
    assert.ok(ack, 'should get error response');
    assert.ok(ack.payload.message.includes('未知权限档'));
    s.disconnect();
  });

  test('有效权限档（无实例）→ permission_mode 回执', async () => {
    const s = ioc(`http://127.0.0.1:${PORT}`, { auth: { token: '' }, forceNew: true });
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const ack = await new Promise((resolve) => {
      s.on('agent:event', e => { if (e.type === 'permission_mode') resolve(e); });
      s.emit('user:setPermissionMode', { mode: 'plan' });
      setTimeout(() => resolve(null), 2000);
    });
    assert.ok(ack, 'should get permission_mode echo');
    assert.equal(ack.payload.mode, 'plan');
    s.disconnect();
  });
});

test.describe('user:setWorkdir — 白名单校验', CI_SKIP, () => {
  test('不在 WORK_DIRS 中的路径 → system error', async () => {
    const s = ioc(`http://127.0.0.1:${PORT}`, { auth: { token: '' }, forceNew: true });
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const ack = await new Promise((resolve) => {
      s.on('agent:event', e => { if (e.type === 'system') resolve(e); });
      s.emit('user:setWorkdir', { cwd: '/nonexistent/werk/dir' });
      setTimeout(() => resolve(null), 2000);
    });
    assert.ok(ack, 'should get error');
    assert.ok(ack.payload.message.includes('未知工作目录'));
    s.disconnect();
  });
});

// ---- helpers ----
function httpGet(url) {
  return new Promise((resolve, reject) => {
    request(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject).end();
  });
}

function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    request(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
      res.on('error', reject);
    }).on('error', reject).end();
  });
}
