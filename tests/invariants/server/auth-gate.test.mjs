// tests/invariants/server/auth-gate.test.mjs —— 真组装根上的门：数据面拒绝、静态壳放行
// 守护：AUTH-01（未持令牌不得进入数据面与操作面，静态壳除外；HTTP 与 Socket 握手共用拒绝语义）
// 覆盖：/health 与 /metrics 的令牌校验 + 静态壳未登录可取 + Socket 握手拒绝 + 空/错令牌同等对待
// 槽位：S2（真 app/server.js 子进程 + 一次性 CCM_DATA_DIR）
//
// 不测什么 + 为什么：
//  ① tokenMatches 的常数时间比较、限速状态机 —— 纯函数，属 S1（tests/invariants/rate-limiter.test.mjs）。
//  ② CF Access JWT 验签 —— 策略层纯函数已在 tests/invariants/auth-strategy.test.mjs；
//     真 CF 环境需要外部服务，不进 PR。
//  ③ 设备审批门 —— 另一道闸，见 tests/invariants/server/device-gate.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { spawnServer, killServer } from '../../integration/_spawn-server.mjs';

const TOKEN = 'inv-auth-gate-token';
const WRONG = 'inv-auth-gate-wrong';

let dir, server;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ccm-inv-auth-'));
  server = await spawnServer({ AUTH_TOKEN: TOKEN, WORK_DIR: dir, CCM_DATA_DIR: dir });
});
test.after(async () => {
  if (server) await killServer(server.proc);
  if (dir) rmSync(dir, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

const url = (path, token) => `http://127.0.0.1:${server.port}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;

// 握手结果归一成 'connected' / 'rejected'，避免用例里各写一遍超时处理。
function handshake(token) {
  return new Promise(resolve => {
    const sock = ioClient(`http://127.0.0.1:${server.port}`, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
      timeout: 4000,
    });
    const done = r => { try { sock.close(); } catch { /* 已关闭 */ } resolve(r); };
    sock.on('connect', () => done('connected'));
    sock.on('connect_error', () => done('rejected'));
    setTimeout(() => done('timeout'), 6000);
  });
}

// ⚠ 用例顺序不是随意的：鉴权失败会累积并触发限速退避，锁定期内【正确令牌也会被 401】。
// 所以成功路径必须先验，失败路径与「连续失败导致锁定」放最后。
// 这不是测试脆弱，而是产品行为——把它写成显式断言，好过留一个会随顺序变化的隐藏依赖。
test.describe('① 正确令牌先验（后面的失败用例会把桶打满）', () => {
  test('/health 正确令牌 → 200 且回本轮进程的健康态', async () => {
    const res = await fetch(url('/health', TOKEN));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.buildNonce, server.buildNonce, '打到的必须是本轮起的进程，不是端口上的残留实例');
  });

  test('Socket 正确令牌握手成功', async () => {
    assert.equal(await handshake(TOKEN), 'connected');
  });
});

test.describe('② 静态壳：未登录必须可取，否则登录页自己都打不开', () => {
  test('index.html 无令牌 → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(res.status, 200, '取不到壳就没有地方输入令牌');
    const html = await res.text();
    assert.match(html, /<html/i);
  });

  test('前端 JS 无令牌 → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/js/app.js`);
    assert.equal(res.status, 200);
  });

  test('静态壳里不得内嵌真实令牌', async () => {
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    assert.ok(!html.includes(TOKEN), '壳是公开可取的，内嵌令牌等于把门钥匙贴在门上');
  });

  test('静态壳不受鉴权失败累积影响（限速只打鉴权口）', async () => {
    // 先打几次失败鉴权，再取壳：壳必须照常可取，否则用户输错一次密码就再也打不开登录页。
    for (let i = 0; i < 3; i++) await fetch(url('/health', WRONG));
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(res.status, 200, '静态资源不经 httpAuth，不该被限速牵连');
  });
});

test.describe('③ 数据面：无令牌一律拒绝', () => {
  test('/health 无令牌 → 401', async () => {
    const res = await fetch(url('/health'));
    assert.equal(res.status, 401, '健康端点也在门内——不开无鉴权的 HTTP 数据端点');
  });

  test('/metrics 无令牌 → 401（指标会泄漏会话与工作区信息）', async () => {
    const res = await fetch(url('/metrics'));
    assert.equal(res.status, 401);
  });

  test('错误令牌与无令牌同等拒绝', async () => {
    const wrong = await fetch(url('/health', WRONG));
    assert.equal(wrong.status, 401);
  });

  test('空令牌不得被当成「没带就放行」', async () => {
    const empty = await fetch(`http://127.0.0.1:${server.port}/health?token=`);
    assert.equal(empty.status, 401, '空串与缺失同等拒绝，不能因为参数存在就放行');
  });
});

test.describe('静态壳：未登录必须可取，否则登录页自己都打不开', () => {
  test('index.html 无令牌 → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(res.status, 200, '取不到壳就没有地方输入令牌');
    const html = await res.text();
    assert.match(html, /<html/i);
  });

  test('前端 JS 无令牌 → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/js/app.js`);
    assert.equal(res.status, 200);
  });

  test('静态壳里不得内嵌真实令牌', async () => {
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    assert.ok(!html.includes(TOKEN), '壳是公开可取的，内嵌令牌等于把门钥匙贴在门上');
  });
});

test.describe('④ Socket 握手与 HTTP 共用同一套拒绝语义', () => {
  test('无令牌握手被拒', async () => {
    assert.equal(await handshake(null), 'rejected');
  });

  test('错误令牌握手被拒', async () => {
    assert.equal(await handshake(WRONG), 'rejected');
  });
});

test('⑤ 连续鉴权失败会锁定，此后正确令牌同样被拒（限速确实在工作）', async () => {
  // 这条把上面那个「顺序依赖」变成显式行为：桶被打满后，正确令牌也进不来。
  // 它同时是 AUTH-03 的正向证据——限速打的是鉴权口，而不是某个业务路径。
  for (let i = 0; i < 8; i++) await fetch(url('/health', WRONG));
  const res = await fetch(url('/health', TOKEN));
  assert.equal(res.status, 401,
    '锁定期内正确令牌也应被拒；若这里是 200，说明失败计数没生效，暴力尝试就没有代价');
});
