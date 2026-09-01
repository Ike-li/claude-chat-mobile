// smoke runner `concurrency` —— 同仓库会话并发真实验收。
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
//        npm run test:smoke -- --scenario concurrency
//     3. （可选）运行并行 e2e（~$0.02，约 2 分钟）：
//        runner 自动传入 --e2e
//
//   用法：ANTHROPIC_* 已 export 后 npm run test:smoke -- --scenario concurrency [--model <名>]
//
//   注意事项：
//     - 测试会自起独立 server 进程，使用临时目录，不影响现有数据
//     - 测试结束后会自动清理（临时目录、server 进程、备份的 data/ 文件）
//     - 测试用独占临时 CCM_DATA_DIR（WS-017），完全隔离生产 data/、结束整目录删除
import { io } from 'socket.io-client';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, mkdtempSync, realpathSync } from 'node:fs';
// managesServer 的 scenario 自己 spawn server，也就自己担「别把生产环境带进去」的责任。
// runner.js 的 main() 有 process.argv[1] 守卫，被 import 时不会执行。
import { stripInheritedEnv } from '../runner.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const APP_PORT = Number(process.env.PORT || 3220);
const E2E = process.argv.includes('--e2e');
const MODEL = (process.argv.find(a => a.startsWith('--model=')) || '').slice('--model='.length) || undefined;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const lastOf = (events, type) => [...events].reverse().find(e => e.type === type);

// 两临时工作目录（realpath：macOS /var→/private/var，与 server 启动期规范化一致，断言才对得上）
const dirA = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-s3-a-')));
const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'ccm-s3-b-')));

// WS-017：给 server 独占临时 CCM_DATA_DIR，隔离生产 data/。旧实现 renameSync 挪真实 sessions.json/
// init-cache.json 再还原（「路径硬编码不可配」注释已过时——CCM_DATA_DIR 早已支持）：无锁 rename + 不等
// 子进程退出就还原 + 子进程 SIGTERM flush 可覆盖回刚还原的生产文件，均可损坏生产状态。改临时数据根后免 stash。
const DATA_DIR = mkdtempSync(join(tmpdir(), 'ccm-smoke-stage3-'));

let server = null, serverLog = '', cleaned = false;

// 停 server：发 SIGTERM 后【等它真的退出】，超时才 SIGKILL。
// 旧写法是 `kill('SIGTERM')` 后立刻 rmSync + process.exit()，一个都不等——父进程一退，正在
// graceful shutdown 的子进程就被 init 收养成孤儿，端口和内存一直占着。2026-09-01 在本机抓到
// 一个这样的残留：PPID=1、已活 2 小时、两个临时目录早被 rmSync 删光，进程还在监听。
// runner.js 的 stopServer 从一开始就是对的（kill → await waitForExit → 超时 SIGKILL），
// 这里是漏抄了「等」的那一半。managesServer 的 scenario 自己 spawn server，也就自己担这个责任。
function stopServer(graceMs = 5000) {
  return new Promise(resolve => {
    if (!server || server.exitCode !== null || server.signalCode !== null) return resolve();
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      try { server.kill('SIGKILL'); } catch { /* 已经没了 */ }
      setTimeout(finish, 500); // SIGKILL 后给一点收尸时间；再不退就放弃等待，不挂住脚本
    }, graceMs);
    server.once('exit', finish);
    try { server.kill('SIGTERM'); } catch { finish(); }
  });
}

async function cleanup() {
  if (cleaned) return; cleaned = true;
  // 顺序不可颠倒：子进程收到 SIGTERM 后要把状态 flush 进 CCM_DATA_DIR，先删目录会让它写进一个
  // 刚被删掉的路径——轻则重建出残留目录，重则 flush 报错拖长退出、更容易演变成上面那种孤儿。
  await stopServer();
  for (const dir of [dirA, dirB, DATA_DIR]) {   // WS-017：DATA_DIR 是临时数据根（隔离生产 data/）
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已删/不存在 */ }
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanup().finally(() => process.exit(130)); });
}

function waitHealth(ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      // 带 token：§1.9 起 /health 一定要鉴权，不带会恒 401 把探针拖到超时。
      const req = http.get(`http://127.0.0.1:${APP_PORT}/health?token=${encodeURIComponent(process.env.AUTH_TOKEN || '')}`, r => {
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
  const s = io(`http://127.0.0.1:${APP_PORT}`, { auth: { token: process.env.AUTH_TOKEN || '' }, reconnection: false, timeout: 5000 });
  s.on('agent:event', ev => events.push(ev));
  return new Promise((res, rej) => {
    s.on('connect', () => res({ s, events }));
    s.on('connect_error', e => rej(new Error(`connect_error: ${e.message}`)));
    setTimeout(() => rej(new Error('connect 超时')), 6000);
  });
}
// emit 带 ack 的 promise 包装
const emitAck = (s, event, payload) => new Promise(resolve => s.emit(event, payload, resolve));

// 等条件成立，而不是睡固定时长。
// 旧写法散落着 `await sleep(3000)` 再去 slice 里捞事件——真实 turn 的耗时不可预测（本机实测 3263ms），
// 睡得比它短就捞不到目标事件，并让所有依赖该事件的后续断言连锁假红（一次 sleep 短 263ms ⇒ 4 项红）。
// 睡得比它长则纯属浪费墙钟。条件等待两头都对：命中即返回，超时才报错，且错误信息直接指出等的是什么。
// from：只在指定下标之后的事件里找（同类型事件会重复出现时必须限定窗口，例如第二个 init）。
function waitFor(events, pred, ms, label, from = 0) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = events.slice(from).find(pred);
      if (hit) return resolve(hit);
      if (Date.now() > deadline) return reject(new Error(`等待超时：${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}
// 等不到就返回 null，让调用方自己出断言失败信息（比抛异常掀翻整个 scenario 更有诊断价值）
const waitForOrNull = (...args) => waitFor(...args).catch(() => null);

// 注：曾有一个 `afterEmit(s, events, event, payload, type)` helper，语义是「emit 后等下一条该
// type 的事件」。它被删掉了——那个语义本身就是陷阱：同类型事件可能有多条，上一步操作的余波会
// 排在前面被当成本次的回执（实测 session:close 的 permission_mode 余波就顶掉了 setPermissionMode
// 的回执）。调用点改为直接 waitForOrNull 并写明「要等哪一条」。

// ---- 契约部分（零 token，借 session:switch fixture spawn 出 idle 实例）----
async function runContract() {
  const { s: s1, events: e1 } = await connect();

  // 1) instances 事件 shape（初始无实例）——等重放到达，不睡固定 500ms。
  // 等的条件必须是【断言依赖的那个条件】（dirs 已含两个工作区），不能只等「出现一条 instances」：
  // 连接初期可能先广播一条 dirs 尚未填全的帧，等到它就会拿着不完整的数据去断言。旧写法
  // sleep(500)+lastOf 反而因为取最后一条而躲开了这点——换成等条件时把这层语义丢了。
  const inst0 = (await waitForOrNull(e1,
    ev => ev.type === 'instances' && ev.payload?.dirs?.includes(dirA) && ev.payload?.dirs?.includes(dirB),
    10000, 'instances 重放（dirs 含 dirA+dirB）')) ?? lastOf(e1, 'instances');
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
  // 等 init 真的到达（冷启 + resume 的耗时不可预测，任何写死的 sleep 都是在赌）
  const initA1 = await waitForOrNull(e1, ev => ev.type === 'init' && ev.cwd === dirA, 60000, 'A1 init', beforeA1);
  const iA1 = initA1?.instanceId;
  check('消息懒创建实例 A1 → init 带 instanceId',
    !!iA1 && typeof iA1 === 'string' && iA1.startsWith('inst_'),
    JSON.stringify(iA1));

  // 6) 同 cwd 开新会话 → 消息懒创建实例 A2（台阶3 核心：同 cwd 两实例）
  await emitAck(s1, 'session:new', { cwd: dirA }); // 有 ack，等它回来即可，不必 sleep
  const beforeA2 = e1.length;
  s1.emit('user:message', { text: 'ping A2', cwd: dirA });
  const initA2 = await waitForOrNull(e1,
    ev => ev.type === 'init' && ev.cwd === dirA && ev.instanceId !== iA1,
    60000, 'A2 init（instanceId 须不同于 A1）', beforeA2);
  const iA2 = initA2?.instanceId;
  check('同 cwd 开第二会话 A2 → 不同 instanceId（同 cwd 两实例并存）',
    !!iA2 && iA2 !== iA1, JSON.stringify({ iA1, iA2 }));

  // 等一条【同时】列出 A1、A2 的 instances 广播：旧写法 sleep(1000) 后取 lastOf，广播晚到就会取到
  // 只含 A1 的旧帧。等不到则回落 lastOf，让下面的断言仍能打印出实际收到的实例列表作诊断。
  const instAB = (await waitForOrNull(e1,
    ev => ev.type === 'instances' &&
      [iA1, iA2].every(id => id && (ev.payload?.instances || []).some(x => x.instanceId === id)),
    15000, 'instances 同时含 A1+A2')) ?? lastOf(e1, 'instances');
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
  const beforeClose = e1.length;
  const closeA2 = await emitAck(s1, 'session:close', { instanceId: iA2 });
  // 只在 close 之后的窗口里找不含 A2 的广播——close 之前的帧（如最初那条空 instances）本来就不含 A2，
  // 从头找会立刻"命中"一条与本次释放无关的旧帧，把断言变成恒真。
  const instAfterClose = (await waitForOrNull(e1,
    ev => ev.type === 'instances'
      && !(ev.payload?.instances || []).some(x => x.instanceId === iA2)
      && (ev.payload?.instances || []).some(x => x.instanceId === iA1),   // 断言的两维都要等到
    10000, 'instances 去除 A2 且保留 A1', beforeClose)) ?? lastOf(e1, 'instances');
  const idsAfter = (instAfterClose?.payload?.instances || []).map(x => x.instanceId);
  check('session:close A2 → instances 去除 A2、保留 A1（关 tab 释放、不影响另一实例）',
    closeA2?.ok === true && !idsAfter.includes(iA2) && idsAfter.includes(iA1), `after=${idsAfter.join(',')}`);

  // 9) 显式传一个【不存在的】instanceId 时不切档、也不误伤 viewing 实例。
  //    `resolveInstanceId` 对 stale id 返回 null（src/server/app.js「显式 stale → null，不再回退
  //    viewing」），handler 于是走 echo 拨回分支：回一条当前档的 permission_mode，不做任何修改。
  //    这条性质是安全相关的——旧行为会把 stale id 落回 viewing，那样前端拿着一个过期 id 切档，
  //    就会改到另一个会话的权限档上去。
  //    ⚠️ 本断言此前写的正是那条旧语义（「缺省落 viewingInstanceId」+ 期望 mode 变成 acceptEdits），
  //    产品换了行为而断言没跟上，于是恒红。2026-09-01 真机三连跑复现后改成按现行语义断言。

  const a1ModeOf = () => ((lastOf(e1, 'instances')?.payload?.instances) || [])
    .find(x => x.instanceId === iA1)?.permissionMode;
  const modeBefore = a1ModeOf();
  const beforePm = e1.length;
  s1.emit('user:setPermissionMode', { mode: 'acceptEdits', instanceId: 'inst_bogus' });
  const pm = await waitForOrNull(e1, ev => ev.type === 'permission_mode', 10000, 'permission_mode echo', beforePm);
  check('显式 stale instanceId 不切档、echo 拨回当前档（不误伤 viewing 实例）',
    !!pm && pm.payload?.mode !== 'acceptEdits' && a1ModeOf() === modeBefore,
    JSON.stringify({ echo: pm?.payload?.mode, a1Before: modeBefore, a1After: a1ModeOf() }));

  // 交接给 e2e 阶段前，等 A1 的轮次真正落地。
  // A1 实例不会随 s1.close() 消失，viewingInstanceId 也还指着它——下面 runE2E 新连一条 socket
  // 直接发消息时复用的就是它。若此刻 A1 仍 busy，那条消息会撞上「一轮一条」被挡下，不产生新的
  // init，于是 I1 的 init 等 60s 等不到、连带 I1 result 一起红（2026-09-01 实测复现：我一度把这个
  // 等待当成只服务于上面那条断言的冗余优化删掉，e2e 段立刻挂两项）。
  await waitForOrNull(e1, ev => ev.type === 'result' && ev.instanceId === iA1, 90000, 'A1 轮次落地（交接给 e2e 前）');

  s1.close();
}

// ---- 并行 e2e（需 token，--e2e）：同一 cwd 两会话各发消息，断言会话1 result 不被开会话2 影响 ----
async function runE2E() {
  const { s, events } = await connect();
  await waitForOrNull(events, e => e.type === 'instances', 10000, '连接后 instances 重放');

  // 会话1：首条消息懒开实例 I1（cwd=dirA）
  s.emit('user:message', { text: '只回复一个词：ALPHA。不要调用任何工具。', cwd: dirA, model: MODEL });
  const initI1 = await waitForOrNull(events, e => e.type === 'init' && e.cwd === dirA, 60000, 'I1 init');
  const i1 = initI1?.instanceId;
  check('会话1 懒开实例 I1（init 带 instanceId/cwd=dirA）', !!i1, JSON.stringify(i1));

  // 同 cwd 开会话2：session:new 清查看 tab → 首条消息懒开 I2（不打断 I1）
  await emitAck(s, 'session:new', { cwd: dirA }); // ack 回来即视为已清 tab，无需 sleep 赌时序
  s.emit('user:message', { text: '只回复一个词：BETA。不要调用任何工具。', cwd: dirA, model: MODEL });
  const initI2 = await waitForOrNull(events, e => e.type === 'init' && e.cwd === dirA && e.instanceId !== i1, 60000, 'I2 init');
  const i2 = initI2?.instanceId;
  check('同 cwd 开会话2 懒开不同实例 I2（init.instanceId !== I1，同 cwd 两实例并发）', !!i2 && i2 !== i1, JSON.stringify({ i1, i2 }));

  // 断言：I1 与 I2 的 result 都到达且各带本 instanceId（I1 没被开 I2 中断——台阶3 地基语义）
  const rI1 = await waitForOrNull(events, e => e.type === 'result' && e.instanceId === i1, 120000, 'I1 result');
  const rI2 = await waitForOrNull(events, e => e.type === 'result' && e.instanceId === i2, 120000, 'I2 result');
  check('I1 的 result 到达且 instanceId===I1（同 cwd 开 I2 未中断 I1——台阶3 地基）', !!rI1);
  check('I2 的 result 到达且 instanceId===I2（两实例同 cwd 并行各自完成）', !!rI2);

  s.close();
}

async function run() {
  server = spawn(process.execPath, [join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...stripInheritedEnv(process.env),   // 摘掉 CF_ACCESS_*/VAPID_* 等生产键（见 runner.js 的 SMOKE_ENV_BLOCKLIST）
      AUTH_TOKEN: 'ccm-smoke-test-token',
      PORT: String(APP_PORT),
      WORK_DIR: dirA,
      WORK_DIRS: `${dirA},${dirB}`,
      CCM_DATA_DIR: DATA_DIR,
      LOG_TERMINAL: 'off', // 禁桌面日志窗，防 smoke 堆 Terminal.app
    },
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
  .then(async () => {
    const passed = results.filter(r => r.ok).length;
    console.log(`\n${passed}/${results.length} 通过`);
    await cleanup();   // 必须 await：不等就 exit 正是孤儿的成因（见 stopServer 上方）
    process.exit(passed === results.length ? 0 : 1);
  })
  .catch(async e => { console.error('❌ 测试异常:', e.message); await cleanup(); process.exit(1); });
