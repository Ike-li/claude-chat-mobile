// scripts/smoke-concurrent.js —— 多 repo **跨 cwd 实例隔离**契约验收（台阶3 instances 契约）。
// 台阶3 后并发单位是「会话/tab」（instanceId）——本测专注**跨 cwd 维度**（同 cwd 并发见 smoke-stage3-concurrent.js）：
//   1) 契约部分（零 token，默认跑）：自起 server（WORK_DIR=dirA, WORK_DIRS=dirA,dirB），用 fixture spawn
//      idle 实例——测跨 cwd 实例隔离的服务端契约：
//        · instances 重放 shape（viewingCwd/dirs/合成事件惯例）+ 预热实例（dirA）
//        · 跨 cwd 两实例并存（dirA 实例 + dirB 实例，各带本 cwd、不同 instanceId）
//        · session:list 按 cwd 隔离（dirA↔markerA、dirB↔markerB 不串）
//        · 多设备重放 tab 栏（两实例 + viewingInstanceId）
//        · 一实例 close 不影响另一
//   2) 跨 cwd 并行 e2e（需 token，`--e2e`，机主网关跑）：dirA、dirB 各发消息（fresh 会话）——断言两 result
//      各带本 cwd、互不打断（docs/design.md A14；同 cwd 并发见 smoke-stage3 A15）。
//      用法：ANTHROPIC_* 已 export 后 `node scripts/smoke-concurrent.js --e2e [--model=<名>]`
//   用法（契约）：node scripts/smoke-concurrent.js   （无需预起 server / token / 网关；临时借用 data/ 并还原）
import { io } from 'socket.io-client';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { getProjectDir } from '../history.js';

const ROOT = join(import.meta.dirname, '..');
const APP_PORT = 3219;                        // 高位端口，避开 3000/3100/3217/3218
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
const dirA = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-cc-a-')));
const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-cc-b-')));
// 各放一个 marker 会话夹具（验证 session:list 按 cwd 路由/隔离）
const projA = join(homedir(), '.claude', 'projects', getProjectDir(dirA));
const projB = join(homedir(), '.claude', 'projects', getProjectDir(dirB));
const projAcreated = !existsSync(projA), projBcreated = !existsSync(projB);
const markerA = `ccm-cc-smoke-a-${Date.now()}`;
const markerB = `ccm-cc-smoke-b-${Date.now()}`;
function placeFixtures() {
  for (const [proj, id, tag] of [[projA, markerA, 'A'], [projB, markerB, 'B']]) {
    mkdirSync(proj, { recursive: true });
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `concurrent smoke marker ${tag}` },
      timestamp: new Date().toISOString()
    });
    writeFileSync(join(proj, `${id}.jsonl`), line + '\n');
  }
}

// WS-017：给 server 独占临时 CCM_DATA_DIR，隔离生产 data/。旧实现用 renameSync 把真实 sessions.json/
// init-cache.json 挪到 .ccbak 再还原（注释「路径硬编码不可配」已过时——sessions.js/server.js 早已支持
// CCM_DATA_DIR、集成测试都在用）：无锁 rename + 不等子进程退出就还原 + 子进程 SIGTERM flush 可覆盖回刚还原
// 的生产文件，任一都可损坏生产状态。改临时数据根后无需任何 stash/restore，结束整目录删除即可。
const DATA_DIR = mkdtempSync(join(tmpdir(), 'ccm-smoke-concurrent-'));

let server = null, serverLog = '', cleaned = false;
function cleanup() {
  if (cleaned) return; cleaned = true;
  try { if (server && !server.killed) server.kill('SIGTERM'); } catch {}
  try { rmSync(join(projA, `${markerA}.jsonl`), { force: true }); } catch {}
  try { rmSync(join(projB, `${markerB}.jsonl`), { force: true }); } catch {}
  try { if (projAcreated) rmSync(projA, { recursive: true, force: true }); } catch {}
  try { if (projBcreated) rmSync(projB, { recursive: true, force: true }); } catch {}
  try { rmSync(dirA, { recursive: true, force: true }); } catch {}
  try { rmSync(dirB, { recursive: true, force: true }); } catch {}
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} // WS-017：删临时数据根（隔离生产 data/）
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
const listSessions = (s, cwd) => new Promise(resolve => cwd ? s.emit('session:list', { cwd }, resolve) : s.emit('session:list', resolve));
const emitAck = (s, event, payload) => new Promise(resolve => s.emit(event, payload, resolve));

// ---- 契约部分（零 token，台阶3 跨 cwd 实例隔离）----
async function runContract() {
  const { s: s1, events: e1 } = await connect();
  await sleep(500);

  // 1) instances 重放 shape：viewingCwd=dirA（WORK_DIR）、无实例（临时数据根为空、无预热指针）+ dirs 白名单
  const inst0 = lastOf(e1, 'instances');
  check('instances 重放 viewingCwd=dirA + dirs 含 dirA/dirB（合成事件 epoch=server seq=0）',
    inst0?.payload?.viewingCwd === dirA && inst0.payload.dirs.includes(dirA) && inst0.payload.dirs.includes(dirB) &&
    inst0.epoch === 'server' && inst0.seq === 0, JSON.stringify(inst0?.payload?.viewingCwd));

  // 2) 跨 cwd：显式开 dirA 实例（switch markerA）+ dirB 实例（switch markerB）→ 两实例并存，各带本 cwd
  const swA = await emitAck(s1, 'session:switch', { sessionId: markerA, cwd: dirA });
  const iA = swA?.instanceId;
  check('session:switch markerA（cwd dirA）→ ack {ok, instanceId: inst_*}',
    swA?.ok === true && typeof iA === 'string' && iA.startsWith('inst_'), JSON.stringify(swA));
  const swB = await emitAck(s1, 'session:switch', { sessionId: markerB, cwd: dirB });
  const iB = swB?.instanceId;
  check('session:switch markerB（cwd dirB）→ ack 新 instanceId（≠ dirA 实例）',
    swB?.ok === true && iB && iB !== iA, JSON.stringify({ iA, iB }));
  await sleep(400);
  const instAB = lastOf(e1, 'instances');
  const byId = Object.fromEntries((instAB?.payload?.instances || []).map(x => [x.instanceId, x]));
  check('instances 同列 dirA 实例与 dirB 实例、各带本 cwd（跨 cwd 并存隔离）',
    byId[iA]?.cwd === dirA && byId[iB]?.cwd === dirB, `A.cwd=${byId[iA]?.cwd} B.cwd=${byId[iB]?.cwd}`);

  // 3) session:list 按 cwd 隔离：dirA 取 markerA、dirB 取 markerB，互不串
  const listA = await listSessions(s1, dirA);
  check('session:list {cwd:dirA} 含 markerA、不含 markerB（cwd 隔离）',
    (listA?.sessions || []).some(x => x.id === markerA) && !(listA?.sessions || []).some(x => x.id === markerB),
    `ids=${(listA?.sessions || []).map(x => x.id).join(',') || '空'}`);
  const listB = await listSessions(s1, dirB);
  check('session:list {cwd:dirB} 含 markerB、不含 markerA（cwd 隔离）',
    (listB?.sessions || []).some(x => x.id === markerB) && !(listB?.sessions || []).some(x => x.id === markerA),
    `ids=${(listB?.sessions || []).map(x => x.id).join(',') || '空'}`);

  // 4) 多设备：新连接重放 tab 栏含两实例 + viewingInstanceId=iB（switch 后查看 dirB 实例，持久同步）
  const { s: s2, events: e2 } = await connect();
  await sleep(500);
  const inst2 = lastOf(e2, 'instances');
  check('多设备：新连接重放 instances 含两实例 + viewingInstanceId=iB',
    inst2?.payload?.viewingInstanceId === iB &&
    (inst2?.payload?.instances || []).some(x => x.instanceId === iA) &&
    (inst2?.payload?.instances || []).some(x => x.instanceId === iB), JSON.stringify(inst2?.payload?.viewingInstanceId));

  // 5) session:close dirB 实例 → instances 去除它、dirA 实例不受影响（一实例关闭不影响另一）
  const closeB = await emitAck(s1, 'session:close', { instanceId: iB });
  await sleep(300);
  const idsAfter = (lastOf(e1, 'instances')?.payload?.instances || []).map(x => x.instanceId);
  check('session:close dirB 实例 → instances 去除它、保留 dirA 实例（互不影响）',
    closeB?.ok === true && !idsAfter.includes(iB) && idsAfter.includes(iA), `after=${idsAfter.join(',')}`);

  s1.close(); s2.close();
}

// ---- 跨 cwd 并行 e2e（需 token，--e2e）：dirA、dirB 各发消息（fresh 会话），断言两 result 各带本 cwd、互不打断 ----
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

  // dirA 发任务（首条懒开实例 iA） → session:new{cwd:dirB} 清查看 tab（不中断 iA）→ dirB 发任务（懒开 iB）
  s.emit('user:message', { text: '只回复一个词：ALPHA。不要调用任何工具。', cwd: dirA, model: MODEL });
  const initA = await waitFor(events, e => e.type === 'init' && e.cwd === dirA, 60000, 'dirA init').catch(() => null);
  const iA = initA?.instanceId;
  await sleep(200);
  s.emit('session:new', { cwd: dirB });
  await sleep(200);
  s.emit('user:message', { text: '只回复一个词：BETA。不要调用任何工具。', cwd: dirB, model: MODEL });

  const rA = await waitFor(events, e => e.type === 'result' && e.instanceId === iA, 120000, 'dirA result').catch(() => null);
  const rB = await waitFor(events, e => e.type === 'result' && e.cwd === dirB && e.instanceId !== iA, 120000, 'dirB result').catch(() => null);
  check('dirA 实例 result 到达且 cwd=dirA（开 dirB 会话未中断 dirA——跨 cwd 并行）', rA?.cwd === dirA);
  check('dirB 实例 result 到达且 cwd=dirB、instanceId≠iA（两 cwd 各自实例并行完成）', rB?.cwd === dirB && rB?.instanceId !== iA);

  s.close();
}

async function run() {
  placeFixtures();
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AUTH_TOKEN: '', PORT: String(APP_PORT), WORK_DIR: dirA, WORK_DIRS: `${dirA},${dirB}`, CCM_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', d => (serverLog += d));
  server.stderr.on('data', d => (serverLog += d));
  await waitHealth(15000);

  await runContract();
  if (E2E) {
    console.log('\n--- 并行 e2e（消耗 token）---');
    await runE2E();
  } else {
    console.log('\n（跳过并行 e2e；加 --e2e 且 export ANTHROPIC_* 后跑真实并行非中断断言）');
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
