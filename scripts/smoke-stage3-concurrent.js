// scripts/smoke-stage3-concurrent.js —— 台阶3（同仓库会话并发）契约验收。
// 两部分：
//   1) 契约部分（默认跑，需少量 token ~$0.01）：自起 server（WORK_DIR=dirA, WORK_DIRS=dirA,dirB），用
//      user:message 懒创建实例（原设计用 fixture resume 零 token，但 CLI 对 jsonl 格式要求严格、
//      最小 fixture 仍 resume 失败，改用真实消息确保实例存活），验证台阶3 的实例内核契约：
//        · instances 事件 shape（viewingInstanceId/dirs/instances:[{instanceId,cwd,sessionId,title,state}]）
//        · session:new ack {instanceId:null}（清查看 tab，**不 dispose 任何实例**）
//        · user:message 懒创建实例；**同 cwd 两消息 → 两不同实例并存**
//        · session:switch 对已 live 会话 **聚焦不重开**（返回同 instanceId，去重）
//        · session:close 关该实例 → instances 不再列它（释放）
//        · 非法 instanceId 路由缺省落 viewingInstanceId（setPermissionMode 广播作用于 viewing）
//        · 事件信封带 instanceId（permission_mode 合成事件 + 实例事件）
//   2) 并行 e2e（需 token，`--e2e`）：**同一 cwd** 两会话各发消息 spawn 两实例，断言会话1 result 不被
//      开会话2 影响（同 cwd 互不打断的语义级断言，docs/design.md A15）。
//
//   快速上手：
//     1. 确保已设置 ANTHROPIC_API_KEY（或 ANTHROPIC_AUTH_TOKEN）：
//        export ANTHROPIC_API_KEY=sk-xxx
//     2. 运行契约测试（~$0.01，约 30 秒）：
//        node scripts/smoke-stage3-concurrent.js
//     3. （可选）运行并行 e2e（~$0.02，约 2 分钟）：
//        node scripts/smoke-stage3-concurrent.js --e2e
//
//   用法（契约）：ANTHROPIC_* 已 export 后 node scripts/smoke-stage3-concurrent.js
//   用法（e2e）：  ANTHROPIC_* 已 export 后 node scripts/smoke-stage3-concurrent.js --e2e [--model=<名>]
//
//   注意事项：
//     - 测试会自起独立 server 进程，使用临时目录，不影响现有数据
//     - 测试结束后会自动清理（临时目录、server 进程、备份的 data/ 文件）
//     - 测试前会自动备份 data/sessions.json 和 data/init-cache.json 到 .s3bak，结束后还原
import { io } from 'socket.io-client';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, renameSync, rmSync, mkdtempSync, realpathSync } from 'node:fs';

const ROOT = join(import.meta.dirname, '..');
const APP_PORT = 3220;                        // 高位端口，避开 3000/3100/3219
const E2E = process.argv.includes('--e2e');
const MODEL = (process.argv.find(a => a.startsWith('--model=')) || '').slice('--model='.length) || undefined;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastOf = (events, type) => [...events].reverse().find(e => e.type === type);

// 两临时工作目录（realpath：macOS /var→/private/var，与 server 启动期规范化一致，断言才对得上）
const dirA = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-s3-a-')));
const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-s3-b-')));

// 借用真实 data/（server 写 sessions.json/init-cache.json，路径硬编码 join(HERE,'data',...)）：挪开、结束还原
const STATE = ['sessions.json', 'init-cache.json'].map(f => {
  const p = join(ROOT, 'data', f);
  return { p, bak: p + '.s3bak' };
});
function stashState() { for (const { p, bak } of STATE) if (existsSync(p)) renameSync(p, bak); }
function restoreState() {
  for (const { p, bak } of STATE) {
    if (existsSync(p)) rmSync(p, { force: true });
    if (existsSync(bak)) renameSync(bak, p);
  }
}

let server = null, serverLog = '', cleaned = false;
function cleanup() {
  if (cleaned) return; cleaned = true;
  try { if (server && !server.killed) server.kill('SIGTERM'); } catch {}
  try { rmSync(dirA, { recursive: true, force: true }); } catch {}
  try { rmSync(dirB, { recursive: true, force: true }); } catch {}
  restoreState();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

function waitHealth(ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${APP_PORT}/health`, r => {
        r.resume();
        if (r.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
    };
    const retry = () => {
      if (server && server.exitCode !== null) return reject(new Error(`server 提前退出（code ${server.exitCode}）：\n${serverLog.slice(-600)}`));
      if (Date.now() > deadline) return reject(new Error(`server 健康检查超时\n${serverLog.slice(-600)}`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

function connect() {
  const events = [];
  const s = io(`http://127.0.0.1:${APP_PORT}`, { auth: { token: '' }, reconnection: false, timeout: 5000 });
  s.on('agent:event', ev => events.push(ev));
  return new Promise((res, rej) => {
    s.on('connect', () => res({ s, events }));
    s.on('connect_error', e => rej(new Error(`connect_error: ${e.message}`)));
    setTimeout(() => rej(new Error('connect 超时')), 6000);
  });
}
// emit 带 ack 的 promise 包装
const emitAck = (s, event, payload) => new Promise(resolve => s.emit(event, payload, resolve));
// emit 后等某 type 的新事件
async function afterEmit(s, events, event, payload, type, wait = 400) {
  const before = events.length;
  s.emit(event, payload);
  await sleep(wait);
  return events.slice(before).find(e => e.type === type);
}

// ---- 契约部分（零 token，借 session:switch fixture spawn 出 idle 实例）----
async function runContract() {
  const { s: s1, events: e1 } = await connect();
  await sleep(500);

  // 1) instances 事件 shape（初始无实例）
  const inst0 = lastOf(e1, 'instances');
  check('instances 重放 shape（viewingInstanceId:null + dirs 含 dirA/dirB + instances:[]）',
    inst0 && inst0.payload.viewingInstanceId === null &&
    inst0.payload.dirs.includes(dirA) && inst0.payload.dirs.includes(dirB) &&
    Array.isArray(inst0.payload.instances) && inst0.payload.instances.length === 0,
    JSON.stringify({ v: inst0?.payload?.viewingInstanceId, n: inst0?.payload?.instances?.length }));

  // 2) session:new：清查看 tab（instanceId:null），不 dispose 任何实例
  const newAck = await emitAck(s1, 'session:new', { cwd: dirA });
  check('session:new ack {ok, instanceId:null, sessionId:null}（清查看 tab、不 spawn 幽灵会话）',
    newAck?.ok === true && newAck.instanceId === null && newAck.sessionId === null, JSON.stringify(newAck));

  // 3) session:switch 非法/不存在会话 → {ok:false}
  const badSwitch = await emitAck(s1, 'session:switch', { sessionId: 'no-such-session', cwd: dirA });
  check('session:switch 不存在会话 → {ok:false}', badSwitch?.ok === false, JSON.stringify(badSwitch));
  // 路径穿越 id 守卫
  const traversal = await emitAck(s1, 'session:switch', { sessionId: '../evil', cwd: dirA });
  check('session:switch 穿越 id 被拒（字符集守卫）', traversal?.ok === false, JSON.stringify(traversal));

  // 4) session:close 不存在实例 → {ok:false}
  const badClose = await emitAck(s1, 'session:close', { instanceId: 'inst_nope' });
  check('session:close 不存在实例 → {ok:false}', badClose?.ok === false, JSON.stringify(badClose));

  // 5) 用真实消息懒创建实例 A1（cwd=dirA）——fixture resume 失败率高，改用消息创建确保实例存活
  const beforeA1 = e1.length;
  s1.emit('user:message', { text: 'ping A1', cwd: dirA });
  // 等待新的 init（在 beforeA1 之后）
  await sleep(3000);
  const initA1 = e1.slice(beforeA1).find(ev => ev.type === 'init' && ev.cwd === dirA);
  const iA1 = initA1?.instanceId;
  check('消息懒创建实例 A1 → init 带 instanceId',
    !!iA1 && typeof iA1 === 'string' && iA1.startsWith('inst_'),
    JSON.stringify(iA1));

  // 6) 同 cwd 开新会话 → 消息懒创建实例 A2（台阶3 核心：同 cwd 两实例）
  s1.emit('session:new', { cwd: dirA });
  await sleep(300);
  const beforeA2 = e1.length;
  s1.emit('user:message', { text: 'ping A2', cwd: dirA });
  // 等待新的 init，且 instanceId 不是 iA1
  await sleep(3000);
  const initA2 = e1.slice(beforeA2).find(ev => ev.type === 'init' && ev.cwd === dirA && ev.instanceId !== iA1);
  const iA2 = initA2?.instanceId;
  check('同 cwd 开第二会话 A2 → 不同 instanceId（同 cwd 两实例并存）',
    !!iA2 && iA2 !== iA1, JSON.stringify({ iA1, iA2 }));
  await sleep(1000); // 等 A2 init 到达

  const instAB = lastOf(e1, 'instances');
  const liveIds = (instAB?.payload?.instances || []).map(x => x.instanceId);
  check('instances 同时列出 A1 与 A2 两实例、均 cwd=dirA',
    liveIds.includes(iA1) && liveIds.includes(iA2) &&
    (instAB.payload.instances.filter(x => x.cwd === dirA).length >= 2),
    `live=${liveIds.join(',')}`);
  // per-instance state 字段（busy，消息在途）
  const a1entry = (instAB?.payload?.instances || []).find(x => x.instanceId === iA1);
  check('instances 条目带 per-instance state（A1 state）+ sessionId/cwd',
    ['idle', 'busy'].includes(a1entry?.state) && a1entry?.cwd === dirA && typeof a1entry?.sessionId === 'string',
    JSON.stringify(a1entry));

  // 7) session:switch 回 A1（已 live，用 sessionId）→ 聚焦不重开（同 instanceId，去重）
  const sidA1 = initA1?.payload?.session_id || initA1?.sessionId;
  if (!sidA1) {
    check('session:switch 已 live 会话 A1 → 聚焦同 instanceId（去重不重开）', false, `A1 sessionId 缺失，initA1=${JSON.stringify(initA1)}`);
  } else {
    const swA1again = await emitAck(s1, 'session:switch', { sessionId: sidA1, cwd: dirA });
    check('session:switch 已 live 会话 A1 → 聚焦同 instanceId（去重不重开）',
      swA1again?.ok === true && swA1again.instanceId === iA1, JSON.stringify({ got: swA1again?.instanceId, want: iA1 }));
  }

  // 8) session:close A2 → instances 不再列 A2（释放）；A1 仍在（关 tab 不影响另一实例）
  const closeA2 = await emitAck(s1, 'session:close', { instanceId: iA2 });
  await sleep(300);
  const instAfterClose = lastOf(e1, 'instances');
  const idsAfter = (instAfterClose?.payload?.instances || []).map(x => x.instanceId);
  check('session:close A2 → instances 去除 A2、保留 A1（关 tab 释放、不影响另一实例）',
    closeA2?.ok === true && !idsAfter.includes(iA2) && idsAfter.includes(iA1), `after=${idsAfter.join(',')}`);

  // 9) 非法 instanceId 路由缺省落 viewingInstanceId（此刻 viewing=iA1）。用 setPermissionMode 验证
  //    （无 busy 限制，任何时候都能切）：bogus instanceId 落回 iA1 → permission_mode 广播且 instanceId=iA1。
  const pm = await afterEmit(s1, e1, 'user:setPermissionMode', { mode: 'acceptEdits', instanceId: 'inst_bogus' }, 'permission_mode', 1000);
  check('非法 instanceId 切档缺省落 viewingInstanceId（permission_mode 作用于 viewing 实例）',
    pm?.payload?.mode === 'acceptEdits' && pm?.instanceId === iA1,
    JSON.stringify({ mode: pm?.payload?.mode, instanceId: pm?.instanceId, want: iA1 }));

  s1.close();
}

// ---- 并行 e2e（需 token，--e2e）：同一 cwd 两会话各发消息，断言会话1 result 不被开会话2 影响 ----
async function runE2E() {
  const waitFor = (events, pred, ms, label) => new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      const hit = [...events].reverse().find(pred);
      if (hit) return resolve(hit);
      if (Date.now() > deadline) return reject(new Error(`等待超时：${label}`));
      setTimeout(tick, 200);
    };
    tick();
  });
  const { s, events } = await connect();
  await sleep(500);

  // 会话1：首条消息懒开实例 I1（cwd=dirA）
  s.emit('user:message', { text: '只回复一个词：ALPHA。不要调用任何工具。', cwd: dirA, model: MODEL });
  const initI1 = await waitFor(events, e => e.type === 'init' && e.cwd === dirA, 60000, 'I1 init').catch(() => null);
  const i1 = initI1?.instanceId;
  check('会话1 懒开实例 I1（init 带 instanceId/cwd=dirA）', !!i1, JSON.stringify(i1));

  // 同 cwd 开会话2：session:new 清查看 tab → 首条消息懒开 I2（不打断 I1）
  await sleep(200);
  s.emit('session:new', { cwd: dirA });
  await sleep(200);
  s.emit('user:message', { text: '只回复一个词：BETA。不要调用任何工具。', cwd: dirA, model: MODEL });
  const initI2 = await waitFor(events, e => e.type === 'init' && e.cwd === dirA && e.instanceId !== i1, 60000, 'I2 init').catch(() => null);
  const i2 = initI2?.instanceId;
  check('同 cwd 开会话2 懒开不同实例 I2（init.instanceId !== I1，同 cwd 两实例并发）', !!i2 && i2 !== i1, JSON.stringify({ i1, i2 }));

  // 断言：I1 与 I2 的 result 都到达且各带本 instanceId（I1 没被开 I2 中断——台阶3 地基语义）
  const rI1 = await waitFor(events, e => e.type === 'result' && e.instanceId === i1, 120000, 'I1 result').catch(() => null);
  const rI2 = await waitFor(events, e => e.type === 'result' && e.instanceId === i2, 120000, 'I2 result').catch(() => null);
  check('I1 的 result 到达且 instanceId===I1（同 cwd 开 I2 未中断 I1——台阶3 地基）', !!rI1);
  check('I2 的 result 到达且 instanceId===I2（两实例同 cwd 并行各自完成）', !!rI2);

  s.close();
}

async function run() {
  stashState();
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AUTH_TOKEN: '', PORT: String(APP_PORT), WORK_DIR: dirA, WORK_DIRS: `${dirA},${dirB}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', d => { serverLog += d; if (process.env.DEBUG_SERVER) process.stdout.write(d); });
  server.stderr.on('data', d => { serverLog += d; if (process.env.DEBUG_SERVER) process.stderr.write(d); });
  server.stderr.on('data', d => (serverLog += d));
  await waitHealth(15000);

  await runContract();
  if (E2E) {
    console.log('\n--- 并行 e2e（消耗 token）---');
    await runE2E();
  } else {
    console.log('\n（跳过并行 e2e；加 --e2e 且 export ANTHROPIC_* 后跑同 cwd 真实并行非中断断言）');
  }
}

run()
  .then(() => {
    const passed = results.filter(r => r.ok).length;
    console.log(`\n${passed}/${results.length} 通过`);
    cleanup();
    process.exit(passed === results.length ? 0 : 1);
  })
  .catch(e => { console.error('❌ 测试异常:', e.message); cleanup(); process.exit(1); });
