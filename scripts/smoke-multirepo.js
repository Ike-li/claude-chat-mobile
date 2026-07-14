// scripts/smoke-multirepo.js —— 多 repo 切目录契约验收（零 token，台阶3 instances 契约）：
// 自起 server（WORK_DIR=dirA, WORK_DIRS=dirA,dirB 两临时目录），用 fixture spawn idle 实例（零 token）——
// 测 server 切目录契约管道（台阶3 用 instances 事件携 viewingCwd 取代台阶2 的 workdir 事件）：
//   instances 重放（viewingCwd+dirs）/ user:setWorkdir 切换广播 + session:list 列表隔离 / 非白名单拒绝+拨回 /
//   幂等 / 多设备同步。隔离用 dirA 放一个 marker 会话夹具验证（dirB 无、切过去看不到）。
// 落盘 e2e（真发消息建会话、验证 jsonl 落对目录）需 token，见 docs/design.md A13 验收清单。
//   用法：node scripts/smoke-multirepo.js   （无需预起 server / token / 网关；临时借用 data/ 并还原）
import { io } from 'socket.io-client';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { getProjectDir } from '../history.js';

const ROOT = join(import.meta.dirname, '..');
const APP_PORT = 3218;                        // 高位端口，避开 3000/3100/3217
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastWD = events => [...events].reverse().find(e => e.type === 'instances'); // 台阶3：instances 携 viewingCwd

// 两临时工作目录（realpath：macOS /var→/private/var，与 server 启动期规范化一致，断言才对得上）
const dirA = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-mr-a-')));
const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-mr-b-')));
// dirA 放一个 marker 会话夹具（验证 session:list 按 activeCwd 隔离）；dirB 保持无会话
const projA = join(homedir(), '.claude', 'projects', getProjectDir(dirA));
const projAcreated = !existsSync(projA);
const markerId = `ccm-mr-smoke-${Date.now()}`;
function placeFixture() {
  mkdirSync(projA, { recursive: true });
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'multirepo smoke marker' },
    timestamp: new Date().toISOString()
  });
  writeFileSync(join(projA, `${markerId}.jsonl`), line + '\n');
}

// WS-017：给 server 独占临时 CCM_DATA_DIR，隔离生产 data/。旧实现 renameSync 挪真实 sessions.json/
// init-cache.json 再还原（「路径硬编码不可配」注释已过时——CCM_DATA_DIR 早已支持）：无锁 rename + 不等
// 子进程退出就还原 + 子进程 SIGTERM flush 可覆盖回刚还原的生产文件，均可损坏生产状态。改临时数据根后免 stash。
const DATA_DIR = mkdtempSync(join(tmpdir(), 'ccm-smoke-multirepo-'));

let server = null, serverLog = '', cleaned = false;
function cleanup() {
  if (cleaned) return; cleaned = true;
  try { if (server && !server.killed) server.kill('SIGTERM'); } catch {}
  try { rmSync(join(projA, `${markerId}.jsonl`), { force: true }); } catch {}
  try { if (projAcreated) rmSync(projA, { recursive: true, force: true }); } catch {}
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
const listSessions = s => new Promise(resolve => s.emit('session:list', resolve));
async function setWorkdir(s, events, cwd) {
  const before = events.length;
  s.emit('user:setWorkdir', { cwd });
  await sleep(400);
  return events.slice(before); // 仅本次操作后新到的事件
}

async function run() {
  placeFixture();
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AUTH_TOKEN: '', PORT: String(APP_PORT), WORK_DIR: dirA, WORK_DIRS: `${dirA},${dirB}`, CCM_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', d => (serverLog += d));
  server.stderr.on('data', d => (serverLog += d));
  await waitHealth(15000);

  // 1) 新连接重放 instances（viewingCwd=dirA + dirs 白名单 + 合成事件惯例）。WORK_DIR=dirA 有 marker
  //    fixture → 启动预热开实例，viewingCwd=dirA。
  const { s: s1, events: e1 } = await connect();
  await sleep(500);
  const replay = lastWD(e1);
  check('新连接重放 instances，viewingCwd=dirA', replay?.payload.viewingCwd === dirA, JSON.stringify(replay?.payload?.viewingCwd));
  check('instances.dirs 含 dirA 与 dirB（白名单 realpath）',
    Array.isArray(replay?.payload.dirs) && replay.payload.dirs.includes(dirA) && replay.payload.dirs.includes(dirB),
    JSON.stringify(replay?.payload?.dirs));
  check('instances 为合成事件（epoch=server, seq=0, sessionId=null）',
    replay?.epoch === 'server' && replay?.seq === 0 && replay?.sessionId === null);

  // 2) session:list 隔离：viewingCwd=dirA 含 marker
  const listA = await listSessions(s1);
  check('viewingCwd=dirA：session:list 含 marker 会话',
    (listA?.sessions || []).some(x => x.id === markerId),
    `ids=${(listA?.sessions || []).map(x => x.id).join(',') || '空'}`);

  // 3) 切到 dirB（无会话）：广播 instances viewingCwd=dirB（合成事件）
  let got = await setWorkdir(s1, e1, dirB);
  const wd = got.find(e => e.type === 'instances');
  check('切 dirB 广播 instances.viewingCwd=dirB', wd?.payload.viewingCwd === dirB, JSON.stringify(wd?.payload?.viewingCwd));
  check('切换广播为合成事件（epoch=server, seq=0）', wd?.epoch === 'server' && wd?.seq === 0);

  // 4) session:list 隔离：viewingCwd=dirB 不含 dirA 的 marker
  const listB = await listSessions(s1);
  check('viewingCwd=dirB：session:list 不含 dirA 的 marker（隔离）',
    !(listB?.sessions || []).some(x => x.id === markerId),
    `ids=${(listB?.sessions || []).map(x => x.id).join(',') || '空'}`);

  // 5) 非白名单 cwd：不广播切换 + 单发当前 instances 拨回（viewingCwd 仍 dirB）
  got = await setWorkdir(s1, e1, '/etc');
  check('非白名单 /etc 不广播切换（拒绝）',
    !got.some(e => e.type === 'instances' && e.payload.viewingCwd === '/etc'),
    '收到: ' + (got.map(e => e.type).join(',') || '无'));
  check('非白名单拒绝后单发当前 instances 拨回（viewingCwd=dirB）', lastWD(e1)?.payload.viewingCwd === dirB);

  // 6) 幂等：再切当前 dirB → 仍回 viewingCwd=dirB（不报错）
  got = await setWorkdir(s1, e1, dirB);
  check('幂等切当前目录：仍回 viewingCwd=dirB', lastWD(e1)?.payload.viewingCwd === dirB);

  // 7) 多设备：新连接重放当前 viewingCwd=dirB（持久 + 同步）
  const { s: s2, events: e2 } = await connect();
  await sleep(500);
  check('多设备：新连接重放当前 viewingCwd=dirB', lastWD(e2)?.payload.viewingCwd === dirB, JSON.stringify(lastWD(e2)?.payload?.viewingCwd));

  s1.close(); s2.close();
}

run()
  .then(() => {
    const passed = results.filter(r => r.ok).length;
    console.log(`\n${passed}/${results.length} 通过`);
    cleanup();
    process.exit(passed === results.length ? 0 : 1);
  })
  .catch(e => { console.error('❌ 测试异常:', e.message); cleanup(); process.exit(1); });
