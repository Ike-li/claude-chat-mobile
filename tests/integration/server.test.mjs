// tests/integration/server.test.mjs —— app/server.js 集成测试（零 token、零 agent 创建）
// 启动 server 子进程 → socket.io-client 连接 → 验证事件流与 HTTP 端点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io as ioc } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = 3199;
// 显式测试专用 token：不能 AUTH_TOKEN:''——config.js SH-001 会删空串再 dotenv 回填本机 .env，
// 致 /health 401、socket 握手失败（session-delete/aborted-state 同款注释）。
const AUTH_TOKEN = 'srvtest-token';
// 仓库根那份 package.json —— /health 的 versions.server 必须报出同一个值。
const PKG_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
let serverProc;
let tmpDir;

// 本文件起真 server 子进程。CI 上 CLAUDE_BIN 指向 tests/fixtures/fake-claude.sh（见 workflow），
// preflight 因此过关，HTTP/socket 接线用例照常跑——这是 CI 里唯一执行真实 app/src/server/app.js 的路径。
// 唯一例外是 scout：它要真 claude 才能拉到模型清单，stub 给不了，单独用 REAL_CLI_ONLY 挡住。
const REAL_CLI_ONLY = process.env.CI
  ? { skip: 'scout 需真 claude CLI 拉模型清单；CI 用的是 tests/fixtures/fake-claude.sh stub' }
  : {};

function url(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `http://127.0.0.1:${PORT}${path}${sep}token=${encodeURIComponent(AUTH_TOKEN)}`;
}

function connectSocket(opts = {}) {
  return ioc(`http://127.0.0.1:${PORT}`, {
    auth: { token: AUTH_TOKEN },
    forceNew: true,
    ...opts,
  });
}

test.before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ccm-srv-test-'));
  // TC-008：本轮启动身份 nonce——防连到固定端口 3199 上残留的【旧 checkout / 其它 server】。就绪判定不再只看
  // status:ok，还要求 /health 回显本 nonce（确认是本轮 spawn 的 server）；并监听子进程 early exit（bind 失败等）
  // 立即失败，不空等满 10s、也绝不对错误进程发有状态事件。
  const buildNonce = `srvtest-${randomUUID()}`;
  serverProc = spawn('node', ['app/server.js'], {
    env: { ...process.env, PORT: String(PORT), AUTH_TOKEN, WORK_DIRS: tmpDir,
      // CCM_DATA_DIR 隔离（同其余 tests/integration/*.test.mjs 惯例）：此前本文件唯独漏设，子进程
      // sessions.js/devices.js/approval-store.js/audit.js 全部落到真实 data/ 目录——sessions.js 的
      // 写入此前一直静默污染，只是没人注意；Phase 4 新增的 approval-store.js/audit.js 让污染第一次
      // 以"多出两个陌生文件"的形式变得肉眼可见，才揪出这个既有缺口。
      CCM_DATA_DIR: tmpDir,
      CCM_BUILD_NONCE: buildNonce, // TC-008：本轮启动身份，/health 回显以确认连的是本轮 server
      // 显式关 DEV_MODE：本机 .env 里 DEV_MODE=1(dogfooding)会被子进程 dotenv 读到,
      // 致 dev:restart 测试真的触发重启、裸进程直接死→后续测试级联崩。钉 '0' 隔离之。
      DEV_MODE: '0',
      // 同理钉掉 systemd 监管信号：GitHub Actions runner 由 systemd 启动，INVOCATION_ID/
      // JOURNAL_STREAM 会层层继承进被测 server，isSupervised() 误判「被监管」→ dev:restart
      // 放行，「未设 DEV_MODE → 拒绝」用例在 CI Linux 上红。空串在 isSupervised 的
      // trim().length>0 判据下必为否，与本地行为对齐。
      INVOCATION_ID: '', JOURNAL_STREAM: '',
      // 同 _spawn-server：禁桌面日志窗，防集成测堆 Terminal.app（本机 .env 常 LOG_TERMINAL=on）。
      LOG_TERMINAL: 'off',
      HOME: process.env.HOME, PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd()
  });
  // TC-008：监听子进程 early exit——bind 失败/preflight 退出时不再空等，立即抛错。
  let earlyExit = null;
  serverProc.on('exit', (code, sig) => { earlyExit = { code, sig }; });
  serverProc.on('error', err => { earlyExit = { error: err.message }; });
  // 轮询 /health 直到【本轮】server ready（最多 10s）；带 token，避免 401 被 catch 吞成“未起来”。
  for (let i = 0; i < 40; i++) {
    if (earlyExit) throw new Error(`server 子进程提前退出，启动失败：${JSON.stringify(earlyExit)}`);
    await new Promise(r => setTimeout(r, 250));
    try {
      const h = JSON.parse(await httpGet(url('/health')));
      if (h.status === 'ok' && h.buildNonce === buildNonce) return; // 确认是本轮 spawn 的 server
      // status:ok 但 nonce 不符 = 端口上是别的 server（旧 checkout / 未退实例）——它不会变成我们的，
      // 继续轮询直至超时报错，绝不误连它跑测试。
    } catch { /* 尚未起来 / 非 JSON */ }
  }
  throw new Error(`Server startup timeout（端口 ${PORT} 未出现本轮 nonce 的 /health${earlyExit ? '；子进程已退出' : ''}）`);
});

test.after(async () => {
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

test.describe('HTTP 端点', () => {
  test('GET /health → 200 + JSON body', async () => {
    const body = await httpGet(url('/health'));
    const j = JSON.parse(body);
    assert.equal(j.status, 'ok');
    assert.ok(typeof j.timestamp === 'number');
    assert.ok(typeof j.versions === 'object');
    // 原先只到上一行为止 —— 三个字段全是 'unknown' 也照样绿，而 versions.server 恰好从来就是
    // 'unknown'：采集处 require('../../package.json') 少一层（app/package.json 不存在），
    // 抛出的 MODULE_NOT_FOUND 被那里的 catch 静默吞掉。这条断言把「采集真的成功了」钉死。
    assert.equal(j.versions.server, PKG_VERSION,
      `versions.server 应为仓库根 package.json 的 ${PKG_VERSION}，实际 ${j.versions.server}`);
  });

  test('GET / → 200 + HTML（index.html）', async () => {
    const body = await httpGet(url('/'));
    assert.ok(body.includes('<!DOCTYPE html>') || body.includes('<html'));
  });

  test('GET /nonexistent → 404', async () => {
    const { statusCode } = await httpGetRaw(url('/no-such-path'));
    assert.equal(statusCode, 404);
  });
});

test.describe('Socket.IO 连接与认证', () => {
  test('正确 AUTH_TOKEN 握手成功', async () => {
    const s = connectSocket();
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    assert.ok(s.connected);
    s.disconnect();
  });
});

test.describe('事件流 — 新连接重放', () => {
  test('连接时总是收到权威 mirror_state，空闲态明确 readonly=false', async (t) => {
    const events = [];
    const s = connectSocket();
    t.after(() => s.disconnect());
    s.on('agent:event', e => events.push(e));
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    await new Promise(resolve => setTimeout(resolve, 800));
    const mirrorState = events.find(e => e.type === 'mirror_state');
    assert.ok(mirrorState, `expected mirror_state, got: ${events.map(e => e.type).join(', ')}`);
    assert.equal(mirrorState.payload.readonly, false);
    assert.equal(mirrorState.payload.stale, false);
  });

  test('连接后收到合成事件（instances / device_status / pending_devices 至少其一）', async () => {
    const events = [];
    const s = connectSocket();
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

test.describe('session:list — 空工作目录', () => {
  test('session:list 返回空列表', async () => {
    const s = connectSocket();
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

  // terminalBusy / terminalWaiting 是 annotateTerminalStates 算出的一对 cwd 级汇总，存在的唯一理由是
  // 「默认分页只回 6 行，页外条目的终端状态否则完全看不见」。真 server 曾只把 terminalBusy 放上 ack，
  // waiting 半边算了却没上线（2026-09-06 修复）——前端对两个字段各自判 `typeof === 'boolean'`，
  // 缺的那个静默回落成只扫本页返回行，且漏传与「连的是旧服务端」在客户端完全不可区分，无任何报错。
  //
  // 这一层只有这里能守：E2E 打的是 tests/e2e/mock/server.js（独立实现、零 import app/src），删掉真
  // server 的字段它照样全绿；而 hasWaitingTerminalSessionForCwd 的单测只管判定本身，管不到上不上得了线。
  // 因此断言故意只问「在不在 ack 上」（空目录下两者都必然是 false，问值等于什么都没问）。
  test('session:list ack 必须【成对】带上 cwd 级终端汇总（漏一个 → 前端静默退化成只看本页行）', async () => {
    const s = connectSocket();
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const ack = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 3000);
      s.emit('session:list', { cwd: tmpDir }, res => { clearTimeout(t); resolve(res); });
    });
    assert.equal(typeof ack.terminalBusy, 'boolean', 'terminalBusy 未上 ack：页外「终端在跑」将只能靠本页行判定');
    assert.equal(typeof ack.terminalWaiting, 'boolean', 'terminalWaiting 未上 ack：页外「终端卡在审批框上」将只能靠本页行判定');
    s.disconnect();
  });
});

// 跨设备已读位点（2026-09-03）。此前位点只存各设备的 localStorage，换台设备 seen 表为空、全部回落到
// 「本设备首次打开时刻」这个很老的基线 → 在另一台读过的会话整屏复亮。判定仍在前端纯函数里（有单测），
// 这里验的是真 server 那两个 handler 的接线与归并语义——E2E 打的是 mock server，走不到这段代码。
test.describe('read:sync / read:mark — 跨设备已读位点', () => {
  const emitAck = (s, event, payload) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timeout`)), 3000);
    s.emit(event, payload, res => { clearTimeout(t); resolve(res); });
  });
  const connect = async () => {
    const s = connectSocket();
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    return s;
  };

  test('read:sync 归并客户端上报并回权威态；客户端基线一律被忽略', async () => {
    const s = await connect();
    const first = await emitAck(s, 'read:sync', { baselineTs: 1, seen: { 'sess-a': 1000 }, manual: {} });
    assert.equal(first.ok, true);
    assert.equal(first.state.seen['sess-a'], 1000);
    assert.ok(first.state.baselineTs > 1, '服务端建档的基线不得被客户端上报的值覆盖');

    // 另一台设备上报更晚的位点 → 取较晚的那个（LWW）；更早的上报不得把位点拨旧
    const second = await emitAck(s, 'read:sync', { baselineTs: 9e12, seen: { 'sess-a': 2000 }, manual: {} });
    assert.equal(second.state.seen['sess-a'], 2000);
    assert.equal(second.state.baselineTs, first.state.baselineTs);
    const third = await emitAck(s, 'read:sync', { seen: { 'sess-a': 500 }, manual: {} });
    assert.equal(third.state.seen['sess-a'], 2000);
    s.disconnect();
  });

  test('read:mark 的单条增量对后来的连接可见（这就是「换设备」那一跳）', async () => {
    const writer = await connect();
    writer.emit('read:mark', { sessionId: 'sess-b', seenAt: 4000 });
    writer.emit('read:mark', { sessionId: 'sess-c', manual: true, at: 5000 });
    // 无 ack 的 fire-and-forget：用一次带 ack 的往返给它排序，确保上面两条已被处理
    await emitAck(writer, 'read:sync', {});
    writer.disconnect();

    const reader = await connect(); // 扮演第二台设备：本地什么都没有
    const state = (await emitAck(reader, 'read:sync', {})).state;
    assert.equal(state.seen['sess-b'], 4000);
    assert.equal(state.manual['sess-c'], 5000);
    reader.disconnect();
  });

  test('session:list 搭车回该页行的位点（渲染时列表数据与未读判定必须同帧）', async () => {
    const s = await connect();
    const ack = await emitAck(s, 'session:list', { cwd: tmpDir });
    assert.equal(typeof ack.readState?.baselineTs, 'number');
    assert.deepEqual(ack.readState.seen, {}, '空列表 → 裁剪后不带任何行位点');
    s.disconnect();
  });

  test('脏入参不写表也不断连（sessionId 非字符串 / 时间戳非数字）', async () => {
    const s = await connect();
    for (const bad of [null, 42, {}, '']) s.emit('read:mark', { sessionId: bad, seenAt: 1000 });
    s.emit('read:mark', { sessionId: 'sess-d', seenAt: 'later' });
    const state = (await emitAck(s, 'read:sync', {})).state;
    assert.equal(state.seen['sess-d'], undefined);
    assert.equal(s.connected, true);
    s.disconnect();
  });
});

test.describe('session:switch — 非法 sessionId 被拒', () => {
  test('含 ../ 的 sessionId → ack { ok: false }', async () => {
    const s = connectSocket();
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
    const s = connectSocket();
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

test.describe('session:new — 创建新会话', () => {
  test('session:new → ack { ok: true }（懒创建，不发消息不 spawn agent）', async () => {
    const s = connectSocket();
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

test.describe('dev:restart — DEV_MODE 关闭时拒绝', () => {
  test('未设 DEV_MODE（测试子进程默认）→ ack { ok: false }，不重启', async () => {
    const s = connectSocket();
    await new Promise((resolve, reject) => {
      s.on('connect', resolve);
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const ack = await new Promise((resolve) => {
      s.emit('dev:restart', {}, resolve);
    });
    assert.equal(ack.ok, false);
    assert.ok(ack.error);
    s.disconnect();
  });
});

test.describe('session:new — scout 获取真实模型清单', REAL_CLI_ONLY, () => {
  // session:new 时无活实例 → openScoutInstance 临时创建 AgentSession 调 supportedModels()，
  // 获取真实模型清单后推送前端 + 写入缓存 + 立即 dispose（不留幽灵会话）。
  // 不再依赖缓存猜测或上区旧模型——scout 保证确定性。
  test('session:new 后收到一条 models 事件（scout 获取真实模型）', async () => {
    const s = connectSocket();
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

test.describe('user:message 输入校验', () => {
  test('空消息 → system error', async () => {
    const s = connectSocket();
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
    const s = connectSocket();
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

test.describe('user:setPermissionMode — 档位校验', () => {
  test('未知权限档 → system error', async () => {
    const s = connectSocket();
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
    const s = connectSocket();
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

// ack 形状守卫（2026-09-07 试点）。守的是 ack 的【键集】，不是键值。
//
// 为什么守键集：逐字段断言的默认答案是「绿」——它要求每个改 ack 的人都记得回来补一条断言，而
// 「记得」正是 2026-09-06 失败的那一步：terminalWaiting 在 annotateTerminalStates 里算出来了却没上
// session:list 的 ack，npm run check 全链 11 道门禁无一变红，E2E 三条相关用例照样全绿（E2E 打的
// tests/e2e/mock/server.js 是零 import app/src 的独立实现，它自己另算了一份），缺陷只在「等人的那个
// 终端恰好在分页窗口外」时现形。键集断言把默认答案反转成「红」：动了 ack 就必须回到这张表，例外要
// 显式写进 optional。与「跑测试用白名单而不是危险命令清单」是同一个反转（见 CLAUDE.md 那节）。
//
// 为什么在这一层：ack 在 app/src/server/app.js 这个组装根里拼出来，单测够不到（要起真 server）；
// E2E 也够不到（mock 是平行实现）。本文件跑在 CI 的 test:integration（.github/workflows/test.yml:80）。
//
// 判据双向：required 缺一即红（有人删了字段），出现 required ∪ optional 之外的键也红（有人加了字段
// 没登记）。声明是【按分支】的——同一个事件的成功支与失败支键集不同，各自登记。
// 声明表。每一行是【实测观察】而非静态推断——写法是先跑一次 dump 出 Object.keys(ack) 再登记，
// 因为 ack 在 app/src/server/app.js 与 socket-files.js 里跨域聚合（15 处变量展开 + 2 处函数调用展开），
// 静态提取解不出来。运行时拿到的已经是塌好的具体键集，对重构、条件分支、聚合全免疫。
//
// payload 固定 ⇒ 形状确定。绝大多数登记的是【拒绝支】——那正是前端必须处理、却最容易在 mock 里
// 被漏掉的一半（E2E 的 mock 是零 import app/src 的平行实现，删掉真 server 的字段它照样全绿）。
// 成功支要驱动往往得先造实例/会话文件/git 仓库，成本另计，逐条在 branch 里标明。
const ACK_SHAPES = [
  { event: 'task:stop', branch: '无实例', payload: () => ({}), required: ['ok'],
    check: ack => assert.equal(typeof ack.ok, 'boolean', 'ok 必须是布尔——前端判的是 `res?.ok === true`，非布尔会静默落到「停止未生效」支') },

  { event: 'session:history', branch: '失败支', payload: () => ({ sessionId: 'no-such-session-for-shape-guard', cwd: tmpDir }),
    required: ['messages', 'error'],
    check: ack => assert.ok(Array.isArray(ack.messages), 'messages 必须是数组——前端无条件对它做 .length/遍历') },

  { event: 'sync:since', branch: '冷连接', payload: () => ({}),
    required: ['found', 'gap', 'replayed', 'diskLen', 'pending', 'unreadOnEntry'],
    // diskLen 是历史教训：mock 从不返回它，于是 shouldReloadOnEnter 的「磁盘 ahead → 全量 reload」
    // 整条分支在 E2E 里够不着，2026-08-27 的「同一条消息两颗气泡」就漏在那里。
    check: ack => assert.equal(typeof ack.found, 'boolean') },

  { event: 'session:switch', branch: '拒绝支', payload: () => ({ sessionId: 'nope', cwd: tmpDir }), required: ['ok', 'error'] },
  { event: 'session:close', branch: '实例不存在', payload: () => ({ instanceId: 'nope' }), required: ['ok', 'error'] },
  { event: 'session:fork', branch: '会话不存在', payload: () => ({ sessionId: 'nope', cwd: tmpDir }), required: ['ok', 'error'] },

  // 抽屉的主数据源。成功支免夹具（空工作区照样返回完整键集），所以这里能覆盖到——本表里少数
  // 不是拒绝支的一条。pinned（手动标「稍后再看」但被 limit 挤出本页的会话）尤其需要它：E2E 的 mock
  // 是平行实现，真 server 把这个字段删掉，抽屉那一组只是静默变空，E2E 与前端单测都不会红。
  { event: 'session:list', branch: '空工作区', payload: () => ({ cwd: tmpDir }),
    required: ['currentSessionId', 'sessions', 'pinned', 'terminalBusy', 'terminalWaiting', 'hasMore', 'total', 'readState'],
    check: ack => {
      assert.ok(Array.isArray(ack.pinned), 'pinned 必须是数组——前端无条件对它做 .length/展开');
      assert.ok(Array.isArray(ack.sessions), 'sessions 必须是数组');
    } },
  { event: 'read:sync', payload: () => ({ seen: {}, manual: {} }), required: ['ok', 'state'] },
  { event: 'env:get', payload: () => ({}), required: ['ok', 'groups', 'configFile', 'envFileExists', 'readonlyDiagnostics'] },
  { event: 'env:set', branch: '缺 changes', payload: () => ({}), required: ['ok', 'results'] },
  { event: 'logs:get', payload: () => ({}), required: ['logs', 'diagLogs'] },
  { event: 'audit:get', payload: () => ({}), required: ['ok', 'records', 'capacity'] },
  { event: 'service:status', payload: () => ({}),
    required: ['ok', 'timestamp', 'startedAt', 'restarts', 'deliveryFailure', 'rateLimitLockout', 'clientError', 'hooksBridge', 'logging', 'versions'] },

  { event: 'browse:list', branch: '空目录', payload: () => ({ cwd: tmpDir, path: '.' }), required: ['ok', 'entries', 'totalCount', 'truncated'] },
  { event: 'browse:read', branch: '文件不存在', payload: () => ({ cwd: tmpDir, path: 'nope.txt' }), required: ['ok', 'error'] },
  { event: 'files:search', payload: () => ({ cwd: tmpDir, query: 'x' }), required: ['ok', 'paths'] },
  { event: 'git:status', branch: '非 git 仓库', payload: () => ({ cwd: tmpDir }), required: ['ok', 'error', 'code'] },
  { event: 'git:diff', branch: '非 git 仓库', payload: () => ({ cwd: tmpDir, path: 'x' }), required: ['ok', 'error', 'code'] },

  { event: 'tool:full', branch: '实例不存在', payload: () => ({ instanceId: 'nope', toolUseId: 't' }), required: ['ok', 'error'] },
  { event: 'tool:preview', branch: '实例不存在', payload: () => ({ instanceId: 'nope', toolUseId: 't' }), required: ['ok', 'error'] },
  { event: 'task:output', branch: '实例不存在', payload: () => ({ instanceId: 'nope', taskId: 't' }), required: ['ok', 'error'] },
  { event: 'attachment:read', branch: '预览不可用', payload: () => ({}), required: ['ok', 'error'] },
  // 回退预览：这里走「会话不存在」支（免夹具那一档）。成功支的字段
  // { canRewind, filesChanged, insertions, deletions, keepUuid } 由 E2E mock 与真 server 各自实现，
  // 改真 server 的成功支 ack 时【必须同时改 tests/e2e/mock/server.js】——两边是平行实现，
  // 静态门禁只守事件名不守字段，删一个字段这里和 E2E 都不会红。
  { event: 'session:rewind:preview', branch: '会话不存在', payload: () => ({ cwd: tmpDir, sessionId: 'no-such-session', promptUuid: 'u1' }), required: ['ok', 'error'] },
  // confirm 同样只覆盖免夹具的「会话不存在」支。成功支 { forkedSessionId, prefill, filesChanged,
  // skippedLinks, unrestored, warning } + finishOpenFocus 的 { instanceId, sessionId }
  // 会真回滚文件并分叉会话，不适合放进这张一次性形状表。
  { event: 'session:rewind:confirm', branch: '会话不存在', payload: () => ({ cwd: tmpDir, sessionId: 'no-such-session', promptUuid: 'u1' }), required: ['ok', 'error'] },
  // action 非法时在 spawn 安装器【之前】就返回——这是本仓唯一会写 ~/.claude/settings.json 的路径，
  // 只驱动这一支，绝不用合法 action 触发真安装。
  { event: 'hooks:setup', branch: '非法 action', payload: () => ({ action: '__bogus__' }), required: ['ok', 'error'] },
];

// 未纳入（各有理由，不是遗漏）：
//   dev:restart —— 本文件另有专测（DEV_MODE=0 拒绝支）；合法路径会杀掉被测 server。
//   files:write —— 会真写文件；push:test —— 会真发推送；doctor:run / config:refresh —— 会 spawn，慢且与形状无关。
//   各事件的【成功支】—— 要先造实例 / 会话 jsonl / git 仓库，成本另计；本表只覆盖免夹具那一档。
test.describe('ack 形状守卫 —— 守键集而非键值', () => {
  for (const spec of ACK_SHAPES) {
    const label = `${spec.event}${spec.branch ? `（${spec.branch}）` : ''}`;
    test(`${label} ack 形状 = { ${spec.required.join(', ')} }`, async () => {
      const s = connectSocket();
      await new Promise((resolve, reject) => {
        s.on('connect', resolve);
        s.on('connect_error', reject);
        setTimeout(() => reject(new Error('connect timeout')), 3000);
      });
      const ack = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label}: ack 超时（3s）`)), 3000);
        s.emit(spec.event, spec.payload(), res => { clearTimeout(t); resolve(res); });
      });
      assertAckShape(ack, { required: spec.required, optional: spec.optional || [] }, label);
      spec.check?.(ack);
      s.disconnect();
    });
  }
});

// ---- helpers ----
function assertAckShape(ack, { required = [], optional = [] }, label) {
  assert.equal(typeof ack, 'object', `${label}: ack 不是对象`);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter(k => !(k in ack));
  const unexpected = Object.keys(ack).filter(k => !allowed.has(k)).sort();
  assert.deepEqual(missing, [],
    `${label}: ack 少了已登记字段 —— 前端消费它的那条分支会静默退化（缺: ${missing.join(', ')}）`);
  assert.deepEqual(unexpected, [],
    `${label}: ack 出现未登记字段 —— 新增字段必须同时登记进这张表，否则 mock 与真 server 就此分叉（多: ${unexpected.join(', ')}）`);
}

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
