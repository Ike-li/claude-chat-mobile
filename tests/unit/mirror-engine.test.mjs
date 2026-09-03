// tests/unit/mirror-engine.test.mjs —— 只读镜像 / catchUp 编排引擎单测（临时夹具根，零真实 ~/.claude）
//
// 【为什么补这份】app/src/server/mirror-engine.js 是 P0–P4 重构专门从 app.js 抽出来的「状态与编排的唯一
// 所有者」（416 行 / 15 个状态量 / 工厂 + 全注入），可测性是刻意做出来的——但抽出来之后没有任何测试
// 跟进：2026-08-02 实测它【根本不出现在覆盖率报告里】，即没有任何单测加载过它。唯一 import 者
// app/src/server/app.js 同样零单测覆盖，而 E2E 打的是 mock server 不是真 server。
//
// 判定规则的纯函数（mirrorEntryLock / mirrorStaleFlag / mirrorReleaseStep / catchUpStep）本就在
// history.js 里被充分覆盖（98%+），本文件【不重复测它们】。这里只测编排层自己的行为：
//   · 归属守卫（forInstanceId）—— 2026-07-16「跨工作区镜像锁误挂」的根因就在这一行
//   · serviceStartedAt 参与 stale 判定 —— 2026-07-28「server 重启腰斩后误显终端会话运行中」
//   · autonomous 被注册表压制 —— 2026-07-24「自主循环唤起被误说成终端会话运行中」
//   · 切会话重建基线、外部写入追平与 externalDirty 标脏
//   · setMirror 的抑重早退与解锁归零、单飞、定时器启停
//
// 磁盘夹具走 createMirrorEngine 的 transcriptBaseDir / sessionRegistryDir（生产恒 null）。绝不碰真实
// ~/.claude/projects 与 ~/.claude/sessions：前者是用户的会话记录，后者塞进带活 pid 的条目会让用户
// 正在跑的 server 看到幻影「终端会话」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMirrorEngine } from '../../app/src/server/mirror-engine.js';
import { getProjectDir, MIRROR_STALE_PENDING_MS } from '../../app/src/sessions/history.js';

// ── 夹具 ────────────────────────────────────────────────────────────────────

const ROOTS = [];
function makeRoots() {
  const transcriptBaseDir = mkdtempSync(join(tmpdir(), 'ccm-mirror-tx-'));
  const sessionRegistryDir = mkdtempSync(join(tmpdir(), 'ccm-mirror-reg-'));
  ROOTS.push(transcriptBaseDir, sessionRegistryDir);
  return { transcriptBaseDir, sessionRegistryDir };
}
test.after(() => {
  for (const dir of ROOTS) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ } }
});

function writeTranscript(baseDir, cwd, sessionId, entries) {
  const dir = join(baseDir, getProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// 注册表条目用 process.pid：readSessionRegistry 会 pid 验活，用自己的 pid 保证「活着」而无需注入 isAlive。
function writeRegistry(dir, { sessionId, cwd, entrypoint = 'cli', status = 'busy' }) {
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd, entrypoint, status,
    statusUpdatedAt: Date.now(), startedAt: Date.now(), version: '2.1.220',
  }));
}

const iso = ms => new Date(ms).toISOString();

// 尾部 pending（assistant 发起 tool_use、结果未落盘 = 有人正在驱动这个会话）
const pendingTail = (ts, text = '提问') => ([
  { type: 'user', message: { role: 'user', content: text }, timestamp: iso(ts - 1000) },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, timestamp: iso(ts) },
]);
// 尾部 settled（assistant 纯文本收尾 = 轮次完结）
const settledTail = (ts, text = '答完了') => ([
  { type: 'user', message: { role: 'user', content: '提问' }, timestamp: iso(ts - 1000) },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: iso(ts) },
]);

// 引擎 + 全部注入面的可控替身。构造后立刻 stop()：createMirrorEngine 在构造期就 rescheduleCatchUp()
// 起了定时器，测试要自己驱动 catchUpTick，不能让后台 tick 插进来改状态。
function makeEngine({
  cwd = '/tmp/ccm-mirror-ws',
  serviceStartedAt = Date.now(),
  roots = makeRoots(),
  // 默认「读不到 CLI 快照」——多数用例不关心 statusline 桥。要测 mergeCliObserved 的 fresh 路径就传进来。
  cliSnapshot = { state: 'missing', snapshot: null },
  statusBridgeOff = false,
  // tick 内探针：instanceState 是每个 tick 必调、且在第一个 await 之【前】的注入点，故被它调用
  // 的那一刻 = 「tick 已开始、尚未结束」。测 stop() 与在飞 tick 的竞态需要精确卡在这个时刻。
  // 收 getEngine 而非 engine：探针在 createMirrorEngine 返回之前就可能被调到（构造期 tick）。
  onTickProbe = null,
} = {}) {
  const emitted = [];
  const agents = new Map();
  const states = new Map();
  let viewing = null;
  let viewingCwd = cwd;
  let statusRefreshes = 0;

  const engine = createMirrorEngine({
    io: { to: room => ({ emit: (event, envelope) => emitted.push({ room, event, ...envelope }) }) },
    agents,
    instanceState: id => {
      onTickProbe?.(() => engine);
      return states.get(id) ?? 'idle';
    },
    getViewingInstanceId: () => viewing,
    viewingCwdOf: () => viewingCwd,
    serviceStartedAt,
    scheduleStatusRefresh: () => { statusRefreshes += 1; },
    readCliSnapshotForSession: () => cliSnapshot,
    statusBridgeOff,
    ...roots,
  });
  engine.stop();

  return {
    engine, emitted, agents, roots, cwd,
    get statusRefreshes() { return statusRefreshes; },
    setViewing(id) { viewing = id; },
    setState(id, s) { states.set(id, s); },
    setViewingCwd(c) { viewingCwd = c; },
    // 登记一个实例并让它成为当前查看目标
    view(id, sessionId, instCwd = cwd) {
      const agent = { sessionId, cwd: instCwd, externalDirty: false };
      agents.set(id, agent);
      viewing = id;
      viewingCwd = instCwd;
      return agent;
    },
    mirrorStates() { return emitted.filter(e => e.type === 'mirror_state'); },
    lastMirror() { return this.mirrorStates().at(-1); },
    historyAppends() { return emitted.filter(e => e.type === 'history_append'); },
  };
}

// ── 无会话 / 视图复位（不读盘的分支）────────────────────────────────────────

test('无查看实例时 tick 广播解锁态，且只发给 approved 房间（SEC-01）', async () => {
  const h = makeEngine();
  await h.engine.catchUpTick();

  const m = h.lastMirror();
  assert.ok(m, '应广播一条 mirror_state');
  assert.equal(m.room, 'approved', '会话态只能发给已批准设备');
  assert.equal(m.payload.readonly, false);
  assert.equal(h.engine.isReadonly(), false);
});

test('clearMirrorOnViewChange 即使已是解锁态也强推一条权威快照（force）', async () => {
  const h = makeEngine();
  await h.engine.catchUpTick();
  const before = h.mirrorStates().length;

  h.engine.clearMirrorOnViewChange();

  assert.equal(h.mirrorStates().length, before + 1, 'force=true 必须推，重连/迟到事件靠它兜底');
  assert.equal(h.lastMirror().payload.readonly, false);
});

test('稳态重复 tick 不重复广播（抑重早退），避免每 2.5s 刷一条同样的 mirror_state', async () => {
  const h = makeEngine();
  await h.engine.catchUpTick();
  const after1 = h.mirrorStates().length;
  await h.engine.catchUpTick();
  await h.engine.catchUpTick();

  assert.equal(h.mirrorStates().length, after1, '状态未变化时不应再广播');
});

// ── 切入预锁（entry_lock）────────────────────────────────────────────────────

test('切入尾部 pending 的会话 → 立即预锁，并把锁归属钉在该 (sessionId, instanceId)', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-a');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-a', pendingTail(Date.now() - 5_000));

  await h.engine.catchUpTick();

  assert.equal(h.engine.isReadonly(), true, '尾部未收尾 = 有人正驱动，切入即预锁');
  assert.equal(h.lastMirror().payload.readonly, true);
  assert.equal(h.engine.mirrorOwnedBy('sess-a', 'inst-A'), true);
  assert.equal(h.engine.mirrorOwnedBy('sess-a', 'inst-B'), false, '归属必须同时匹配实例');
});

test('切入尾部 settled 的会话 → 不预锁（轮次已完结，写权归手机侧）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-done');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-done', settledTail(Date.now() - 5_000));

  await h.engine.catchUpTick();

  assert.equal(h.engine.isReadonly(), false);
  assert.equal(h.lastMirror().payload.readonly, false);
});

test('切入陈旧 pending（超 5 分钟无写入）→ 不预锁：那是没人管的挂起会话，不是活终端', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-stale');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-stale', pendingTail(Date.now() - MIRROR_STALE_PENDING_MS - 60_000));

  await h.engine.catchUpTick();

  assert.equal(h.engine.isReadonly(), false, '陈旧豁免：隔天打开的旧会话不得误锁死手机输入');
});

// ── 归属守卫：2026-07-16「跨工作区镜像锁误挂」──────────────────────────────

// 打的是 catchUpTickOnce 各分支里【每个 await 之后】那道 tick 级归属守卫
// （`getViewingInstanceId() !== id || agents.get(id) !== a || key 变了` → return），
// 不是 setMirror 内部那道 forInstanceId 守卫——后者是第二道防线，tick 走不到它（实测：
// 单独删掉 setMirror 那道守卫，本用例仍绿；删掉这道 tick 守卫才变红）。
test('tick 期间视图切走 → 旧 tick 的观察结果不得把锁贴到新会话上（跨工作区误锁根因）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-a');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-a', pendingTail(Date.now() - 5_000));

  // 起 tick 后立刻切到另一个工作区的实例：tick 内部每个 await 之后都要重判视图归属。
  const inflight = h.engine.catchUpTick();
  h.view('inst-B', 'sess-b', '/tmp/ccm-mirror-other-ws');
  await inflight;

  assert.equal(h.engine.mirrorOwnedBy('sess-a', 'inst-A'), false, 'A 的锁不得在切走后建立');
  assert.equal(h.engine.mirrorOwnedBy('sess-b', 'inst-B'), false, 'A 的观察结果更不得改贴到 B 头上');
  assert.equal(h.engine.isReadonly(), false);
});

// ── stale 判定：2026-07-28「server 重启腰斩后误显终端会话运行中」───────────

test('pending 尾部落盘于本进程启动之前 → stale=true（被重启腰斩的残留，没有活驾驶员）', async () => {
  const now = Date.now();
  // 服务 10 秒前刚起来；尾部是 1 分钟前落的盘 —— 早于本进程，且还没到 5 分钟陈旧阈值。
  const h = makeEngine({ serviceStartedAt: now - 10_000 });
  const a = h.view('inst-A', 'sess-cut');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-cut', pendingTail(now - 60_000));

  await h.engine.catchUpTick();

  const m = h.lastMirror();
  assert.equal(m.payload.readonly, true, '锁态不变，只改文案');
  assert.equal(m.payload.stale, true, '前端据此出「可续接」而不是「终端会话运行中」');
  assert.equal(h.engine.snapshot().stale, true);
});

test('pending 尾部落盘于本进程启动之后 → stale=false（是本进程期间的活动）', async () => {
  const now = Date.now();
  const h = makeEngine({ serviceStartedAt: now - 60_000 });
  const a = h.view('inst-A', 'sess-live');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-live', pendingTail(now - 5_000));

  await h.engine.catchUpTick();

  const m = h.lastMirror();
  assert.equal(m.payload.readonly, true);
  assert.equal(m.payload.stale, false);
});

// ── autonomous：2026-07-24「自主循环唤起被误说成终端会话运行中」───────────

test('尾窗有自主循环 marker 且注册表无终端 → autonomous=true（横幅换措辞，锁不变）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-auto');
  const ts = Date.now() - 5_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-auto', [
    { type: 'user', isMeta: true, message: { role: 'user', content: '# Autonomous loop check' }, timestamp: iso(ts - 2000) },
    ...pendingTail(ts),
  ]);

  await h.engine.catchUpTick();

  const m = h.lastMirror();
  assert.equal(m.payload.readonly, true, 'autonomous 只改措辞，仍要防两端并发写');
  assert.equal(m.payload.autonomous, true);
  assert.equal(h.engine.snapshot().autonomous, true);
});

test('注册表自报活终端在跑 → 压制 autonomous 标记（活证据强过 marker 启发式）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-auto2');
  const ts = Date.now() - 5_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-auto2', [
    { type: 'user', isMeta: true, message: { role: 'user', content: '# Autonomous loop check' }, timestamp: iso(ts - 2000) },
    ...pendingTail(ts),
  ]);
  writeRegistry(h.roots.sessionRegistryDir, { sessionId: 'sess-auto2', cwd: a.cwd, entrypoint: 'cli', status: 'busy' });

  await h.engine.catchUpTick();

  const m = h.lastMirror();
  assert.equal(m.payload.readonly, true);
  assert.equal(m.payload.autonomous, false, '注册表证实是真终端 → 不能说成自主循环');
  assert.equal(m.payload.cliSeen, true, '本次观察见到了 entrypoint=cli 的活条目');
});

// ── 追平：外部写入 → history_append + externalDirty ─────────────────────────

test('切入后终端又落了新消息 → 推 history_append(external) 并把实例标脏防分叉', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-catch');
  const base = Date.now() - 20_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-catch', settledTail(base));

  await h.engine.catchUpTick();          // 切入：以现有长度定基线，本 tick 不推
  assert.equal(h.historyAppends().length, 0, '切入 tick 不得把既有历史当外部增量推');
  assert.equal(a.externalDirty, false);

  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-catch', [
    ...settledTail(base),
    { type: 'user', message: { role: 'user', content: '终端里又问了一句' }, timestamp: iso(base + 5_000) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '终端侧的回答' }] }, timestamp: iso(base + 6_000) },
  ]);
  await h.engine.catchUpTick();          // 正常 tick：观察到外部增量

  const appends = h.historyAppends();
  assert.equal(appends.length, 1, '外部增量应推一条 history_append');
  assert.equal(appends[0].payload.external, true);
  assert.ok(appends[0].payload.messages.length > 0);
  assert.equal(a.externalDirty, true, 'SDK 内存上下文已落后于磁盘，下次发送前必须置换实例');
  assert.equal(h.engine.isReadonly(), true, '观察到外部真落定新消息 = 终端活跃 → 上锁');
});

test('己方 busy 期间抑制追平：不推 history_append（免读大文件、不把自己的写盘当外部增量）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-busy');
  const base = Date.now() - 20_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-busy', settledTail(base));
  await h.engine.catchUpTick();          // 切入定基线

  h.setState('inst-A', 'busy');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-busy', [
    ...settledTail(base),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '己方 turn 写的' }] }, timestamp: iso(base + 5_000) },
  ]);
  await h.engine.catchUpTick();

  assert.equal(h.historyAppends().length, 0, 'localBusy 分支必须整体跳过追平');
});

// ── 接管 / 切视图 / 单飞 / 定时器 ───────────────────────────────────────────

test('takeOver 后立即解锁，并把归属与 CLI 观察值一并归零', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-take');
  const ts = Date.now() - 5_000;
  // 尾窗里带上 CLI 已落盘的模型/权限档：不这样喂，observedCli 本来就全 null，
  // 「解锁归零」那条断言无论归零与否都成立 = 空过（变异检查抓到过）。
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-take', [
    { type: 'permission-mode', permissionMode: 'plan', timestamp: iso(ts - 3000) },
    { type: 'user', message: { role: 'user', content: '提问' }, timestamp: iso(ts - 1000) },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, timestamp: iso(ts) },
  ]);
  await h.engine.catchUpTick();

  assert.equal(h.engine.isReadonly(), true);
  assert.deepEqual(h.engine.snapshot().observedCli, { model: 'claude-opus-4-5', permissionMode: 'plan', effort: null },
    '锁着时须把 CLI 侧观察到的模型/权限档带给前端');

  h.engine.takeOver('sess-take');

  assert.equal(h.engine.isReadonly(), false);
  assert.equal(h.engine.mirrorOwnedBy('sess-take', 'inst-A'), false, '解锁后归属必须清空');
  assert.equal(h.engine.snapshot().autonomous, false);
  assert.deepEqual(h.engine.snapshot().observedCli, { model: null, permissionMode: null, effort: null },
    '解锁态下 CLI 观察值没有意义，须归零');
});

test('clearMirrorOnViewChange 清掉上个会话的锁：空窗内不得把 A 的锁套到 B', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-a');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-a', pendingTail(Date.now() - 5_000));
  await h.engine.catchUpTick();
  assert.equal(h.engine.isReadonly(), true);

  h.engine.clearMirrorOnViewChange();

  assert.equal(h.engine.isReadonly(), false);
  assert.equal(h.engine.mirrorOwnedBy('sess-a', 'inst-A'), false);
});

test('catchUpTick 单飞：并发调用复用同一次在途执行，防旧观察晚到覆盖新状态', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-solo');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-solo', pendingTail(Date.now() - 5_000));

  const first = h.engine.catchUpTick();
  const second = h.engine.catchUpTick();
  assert.equal(second, first, '在途时必须返回同一个 promise，而不是再跑一遍');
  await first;

  // 结算之后才允许开新的一轮
  const third = h.engine.catchUpTick();
  assert.notEqual(third, first);
  await third;
});

test('stop() 后定时器不再自驱；start() 能重新起来', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-timer');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-timer', settledTail(Date.now() - 5_000));
  await h.engine.catchUpTick();
  const settled = h.mirrorStates().length;

  h.engine.stop();
  // 只读锁未挂 → 追平间隔 2.5s；等 300ms 足以证明「没有被立刻重排的定时器」，
  // 且远短于任一档间隔，不会因为等太久而变成靠运气的断言。
  await new Promise(r => setTimeout(r, 300));
  assert.equal(h.mirrorStates().length, settled, 'stop 后不应再有自驱 tick 产生广播');

  h.engine.start();
  h.engine.stop(); // 立刻停掉，避免把定时器泄漏给后续用例
});

test('stop() 在 in-flight tick 期间也要停住：tick 收尾不得把定时器重排回来', async () => {
  // 上一个用例手动调 catchUpTick()，走不到「定时器回调 → tick → 收尾重排」那条链，
  // 因而漏掉了这个竞态：shutdown 恰好撞上一个在飞的 tick 时，stop() 会被它的收尾覆盖掉。
  let ticks = 0;
  let stopRequested = false;
  const h = makeEngine({
    onTickProbe: getEngine => {
      ticks += 1;
      if (!stopRequested) { stopRequested = true; getEngine().stop(); } // 卡在 tick 飞行中停
    },
  });
  const a = h.view('inst-A', 'sess-stop-inflight');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-stop-inflight', settledTail(Date.now() - 5_000));

  h.engine.start();
  // 常态追平间隔 2.5s：先等它驱动出首个 tick（探针在其中 stop），再多等一个完整间隔——
  // 若 stop() 被 tick 收尾重排回来，第二个 tick 会在这个窗口内发生。
  await new Promise(r => setTimeout(r, 5_600));
  h.engine.stop();

  assert.equal(ticks, 1, 'stop() 之后不应再有自驱 tick');
});

test('requestRebaseline 后同会话重连不重复推历史（只重定基线，不当外部增量）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-reconn');
  const base = Date.now() - 20_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-reconn', settledTail(base));
  await h.engine.catchUpTick();

  h.engine.requestRebaseline();
  await h.engine.catchUpTick();

  assert.equal(h.historyAppends().length, 0, '重连重定基线不得把既有历史重推成外部增量');
  assert.equal(a.externalDirty, false, '磁盘没长 → 没有被吸收的外部增长，不该标脏');
});

test('requestRebaseline 时磁盘已被终端写长 → 标脏（BE-009 防分叉），但不重推历史', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-absorb');
  const base = Date.now() - 20_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-absorb', settledTail(base));
  await h.engine.catchUpTick();

  // 断线期间终端写入，重连时 catchUpTick 尚未观察到 → 必须在重定基线【之前】比对长度
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-absorb', [
    ...settledTail(base),
    { type: 'user', message: { role: 'user', content: '断线期间终端问的' }, timestamp: iso(base + 5_000) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '断线期间终端答的' }] }, timestamp: iso(base + 6_000) },
  ]);
  h.engine.requestRebaseline();
  await h.engine.catchUpTick();

  assert.equal(a.externalDirty, true, '被 rebaseline 吸收的外部增长必须标脏，否则下条手机消息从旧位置分叉');
});

// 上一条的镜像对照（2026-08-10）：磁盘同样变长、同样在重连时比对，但写它的是【己方】刚跑完的 turn。
// localBusy 分支冻结 baseline，baseline 要等下一 tick 的吸收才推进；而 turn 一结束 state 立刻是 idle。
// 重连落进 turn 结束前后各约一个 tick 周期的窗口（rebaseline flag 由【下一个】tick 消费，故连接发生在
// turn 结束【之前】同样会命中；周期常态 2500ms、只读镜像态 1000ms），旧实现就拿冻结的 baseline 比含己方
// 新写入的磁盘长度，把自己写的判成终端写入 → 纯 web 驱动的会话也弹「正在续接会话（吸收终端写入）…」
// 并白白 dispose+resume 冷启动一次（实证会话 39da384a：主链全部 sdk-ts、零真实 cli 写入）。
// 判据靠 wasOwnTurn 与 catchUpStep 的吸收窗口同源——但只认己方 turn，见下一条用例。
test('己方 turn 刚跑完（wasOwnTurn）时重连 → 不标脏：那段增长是自己写的，不是终端写入', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-own-turn');
  const base = Date.now() - 20_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-own-turn', settledTail(base));
  await h.engine.catchUpTick();          // 切入定基线（idle）

  // 己方 turn 在跑：写盘的是自己，此 tick 走 localBusy 分支 → baseline 冻结、只记 wasBusy=true
  h.setState('inst-A', 'busy');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-own-turn', [
    ...settledTail(base),
    { type: 'user', message: { role: 'user', content: '手机上发的问题' }, timestamp: iso(base + 5_000) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '己方 turn 写的回答' }] }, timestamp: iso(base + 6_000) },
  ]);
  await h.engine.catchUpTick();

  // turn 结束（pendingTurns→0 即 idle），下一 tick 的 wasBusy 吸收尚未跑；此刻手机解锁重连
  h.setState('inst-A', 'idle');
  h.engine.requestRebaseline();
  await h.engine.catchUpTick();

  assert.equal(a.externalDirty, false, '己方刚写完的那一轮不是终端写入，不得触发 dispose+resume 置换');
});

// 上一条的边界守卫（2026-08-10 独立审查发现）：localBusy 把 busy 与 permission 压成同一个布尔，但两者
// 语义不同——busy=己方确定在写盘；permission=己方在等审批（最长 30min），磁盘增长【可能是终端写的】，
// 那正是 externalGrowthWhilePaused 存在的理由。若拿 localBusy 口径的 wasBusy 去豁免，就会连审批窗里的
// 终端写入一起吞掉：permission 建立 size 基线 → 终端写入 → 轮次收尾使 state 翻 idle（写入之后再没有第二个
// permission tick，externalGrowthWhilePaused 兜不住）→ 重连 rebaseline 漏标 → 下条手机消息进陈旧 SDK
// 子进程 → transcript 分叉。漏标(分叉)远重于误标(多一次冷启动)，故这一维只豁免己方 turn。
test('等审批期间终端写入、随后 state 翻 idle 时重连 → 仍须标脏（豁免只给己方 turn，不给审批窗）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-perm-ext');
  const base = Date.now() - 20_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-perm-ext', settledTail(base));
  await h.engine.catchUpTick();          // 切入定基线（idle）

  h.setState('inst-A', 'permission');    // 等审批：己方不写盘（此 tick 建 size 基线）
  await h.engine.catchUpTick();

  // 审批挂起期间终端写入同一会话
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-perm-ext', [
    ...settledTail(base),
    { type: 'user', message: { role: 'user', content: '终端在审批窗里问的' }, timestamp: iso(base + 5_000) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '终端在审批窗里答的' }] }, timestamp: iso(base + 6_000) },
  ]);

  // 审批被拒/轮次收尾 → state 翻 idle，写入之后再没有第二个 permission tick；此刻手机重连
  h.setState('inst-A', 'idle');
  h.engine.requestRebaseline();
  await h.engine.catchUpTick();

  assert.equal(a.externalDirty, true, '审批窗里的终端写入必须标脏，否则下条手机消息从旧位置分叉');
});

// ══════════════════════════════════════════════════════════════════════════════
// 以下用例由 `npm run mutate -- app/src/server/mirror-engine.js` 反推补齐（2026-08-02）。
// 上面那批用例首轮全绿，但变异检查显示 129 个变异体里存活 67 个——存活的意思是「这行被
// 执行到了，改掉之后却没有任何测试变红」。下面只挑其中**行为上真有意义**的那些补，
// 不追求把等价变异（默认参数、立刻被覆盖的初值、值本就是 null 的 ??）也清零：为杀变异体
// 而写的断言就是我们一开始想避免的那种测试。
// ══════════════════════════════════════════════════════════════════════════════

// ── 归属守卫的另外两个析取项 ────────────────────────────────────────────────
// 守卫是 `viewing 变了 || 实例对象被换了 || 该实例的 cwd\0sessionId 变了` 三选一。
// 上面那条只触发第一项，于是把 `||` 整体翻成 `&&` 照样全绿（要三个同时成立才 return）。
// 后两项都是真实路径：dispose+resume 会换掉实例对象；CLI 迟到的 init 会让 sessionId 变。

test('归属守卫②：tick 期间实例对象被换掉（dispose+resume）→ 旧观察不得提交', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-a');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-a', pendingTail(Date.now() - 5_000));

  const inflight = h.engine.catchUpTick();
  // viewing 不变，但实例被换成新对象（web 发送前 dispose 旧 SDK 子进程再 resume 吸收外部写入）
  h.agents.set('inst-A', { sessionId: 'sess-a', cwd: a.cwd, externalDirty: false });
  await inflight;

  assert.equal(h.engine.isReadonly(), false, '观察结果属于已被替换掉的那个实例，不得落到新实例上');
  assert.equal(h.engine.mirrorOwnedBy('sess-a', 'inst-A'), false);
});

test('归属守卫③：tick 期间同一实例的 sessionId 变了 → 旧会话的增量不得推给新会话', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-old');
  const base = Date.now() - 20_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-old', settledTail(base));
  await h.engine.catchUpTick();                       // 切入定基线

  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-old', [
    ...settledTail(base),
    { type: 'user', message: { role: 'user', content: '旧会话的外部增量' }, timestamp: iso(base + 5_000) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OLD_SESSION_CONTENT' }] }, timestamp: iso(base + 6_000) },
  ]);
  const inflight = h.engine.catchUpTick();
  a.sessionId = 'sess-new';                           // CLI 迟到的 init / 会话切换：同一实例换了会话
  await inflight;

  assert.equal(h.historyAppends().length, 0,
    '这一 tick 观察的是 sess-old，提交时已经是 sess-new —— 内容不得跨会话串台');
  assert.equal(a.externalDirty, false);
});

// ── localBusy 分支：此前只有一条「不推 history_append」的否定断言 ───────────
// 否定断言在分支【提前 return】时同样成立，所以整片 localBusy 逻辑其实没被检查。

test('permission 挂起期间磁盘长大 → 必然是终端写的，标脏防分叉（30 分钟审批窗）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-perm');
  const base = Date.now() - 20_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-perm', settledTail(base));
  await h.engine.catchUpTick();                       // 切入

  h.setState('inst-A', 'permission');                 // 手机上弹着审批卡片，web 侧根本不写盘
  await h.engine.catchUpTick();                       // 这一 tick 只记 size，不判增长
  assert.equal(a.externalDirty, false, '基线刚建立，不该凭空标脏');

  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-perm', [
    ...settledTail(base),
    { type: 'user', message: { role: 'user', content: '人走到电脑前用终端继续了' }, timestamp: iso(base + 5_000) },
  ]);
  await h.engine.catchUpTick();

  assert.equal(a.externalDirty, true,
    '不标脏的话，下一条手机消息会送进停在 30 分钟前的 SDK 子进程、从旧 parentUuid 分叉');
});

test('busy 期间磁盘长大是己方 turn 写的 → 不得标脏（与 permission 相反）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-busy2');
  const base = Date.now() - 20_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-busy2', settledTail(base));
  await h.engine.catchUpTick();

  h.setState('inst-A', 'busy');
  await h.engine.catchUpTick();
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-busy2', [
    ...settledTail(base),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '己方 turn 的输出' }] }, timestamp: iso(base + 5_000) },
  ]);
  await h.engine.catchUpTick();

  assert.equal(a.externalDirty, false, 'busy = 自己也在写盘，size 增长不能归给终端');
});

test('busy 期间主链久无写入且尾部未收尾 → 仍要重算 stale（不能因为 web 忙就掩盖终端疑似中断）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-busystale');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-busystale',
    pendingTail(Date.now() - MIRROR_STALE_PENDING_MS - 60_000));
  await h.engine.catchUpTick();                       // 陈旧 pending → 切入不预锁

  h.setState('inst-A', 'busy');
  await h.engine.catchUpTick();

  const m = h.lastMirror();
  assert.equal(m.payload.readonly, false, '陈旧 pending 本就没锁，busy 分支不得凭空造锁');
  assert.equal(m.payload.stale, false, 'stale 只在锁着时才有意义');
});

// ── keepAlive 与自动解锁 ────────────────────────────────────────────────────
// keepAlive = 「文件还在长」的弱判据，只延缓解锁、不造锁。原实现上锁后【没有任何自动释放
// 路径】，终端写一次就把移动端输入锁死到手动接管为止——这两条钉住释放这条命脉。

test('终端仍在写盘（文件在长但没有新文本落定）→ 维持只读锁，不解锁', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-keepalive');
  const ts = Date.now() - 5_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-keepalive', pendingTail(ts));
  await h.engine.catchUpTick();                       // 切入预锁
  assert.equal(h.engine.isReadonly(), true);

  await h.engine.catchUpTick();                       // 建立 size 基线
  for (let i = 0; i < 15; i += 1) {
    // 追加不进主链文本的条目（tool_use/tool_result 往返）：文件在长，但 catchUpStep 不会 emit
    writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-keepalive', [
      ...pendingTail(ts),
      ...Array.from({ length: i + 1 }, (_, k) => (
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${k}`, content: 'ok' }] }, timestamp: iso(ts + k) }
      )),
    ]);
    await h.engine.catchUpTick();
  }

  assert.equal(h.engine.isReadonly(), true,
    '文件一直在长 = 终端还在跑（卡在长工具上），静默窗不得把锁解掉');
});

test('终端真静默够久 → 自动解锁，把写权交回手机侧（原实现锁死到手动接管为止）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-release');
  const ts = Date.now() - 5_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-release', pendingTail(ts));
  await h.engine.catchUpTick();
  assert.equal(h.engine.isReadonly(), true, '前置：先真的锁上');

  // 终端收工：尾部转为已收尾，此后文件不再变化
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-release', settledTail(ts + 1_000));
  for (let i = 0; i < 20 && h.engine.isReadonly(); i += 1) await h.engine.catchUpTick();

  assert.equal(h.engine.isReadonly(), false, '静默累计到阈值必须自动解锁');
  assert.equal(h.lastMirror().payload.readonly, false, '解锁要广播出去，前端才会恢复输入');
});

// ── statusline 桥：mergeCliObserved 的 fresh 路径 ───────────────────────────
// 此前 readCliSnapshotForSession 恒返回 missing，整条分支从没被执行判定过。

test('CLI 快照 fresh → model 取快照、effort 走 statusline 桥（transcript 只给 permissionMode）', async () => {
  const h = makeEngine({ cliSnapshot: { state: 'fresh', snapshot: { model: { id: 'claude-opus-4-5' }, effort: 'high' } } });
  const a = h.view('inst-A', 'sess-bridge');
  const ts = Date.now() - 5_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-bridge', [
    { type: 'permission-mode', permissionMode: 'acceptEdits', timestamp: iso(ts - 3000) },
    ...pendingTail(ts),
  ]);

  await h.engine.catchUpTick();

  assert.deepEqual(h.engine.snapshot().observedCli,
    { model: 'claude-opus-4-5', permissionMode: 'acceptEdits', effort: 'high' });
});

test('statusBridgeOff → effort 恒 null，只用 transcript 观察值（桥没装时不许瞎报）', async () => {
  const h = makeEngine({
    statusBridgeOff: true,
    cliSnapshot: { state: 'fresh', snapshot: { model: { id: 'claude-opus-4-5' }, effort: 'high' } },
  });
  const a = h.view('inst-A', 'sess-nobridge');
  const ts = Date.now() - 5_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-nobridge', [
    { type: 'permission-mode', permissionMode: 'plan', timestamp: iso(ts - 3000) },
    { type: 'user', message: { role: 'user', content: '提问' }, timestamp: iso(ts - 1000) },
    { type: 'assistant', message: { role: 'assistant', model: 'transcript-model', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, timestamp: iso(ts) },
  ]);

  await h.engine.catchUpTick();

  assert.deepEqual(h.engine.snapshot().observedCli,
    { model: 'transcript-model', permissionMode: 'plan', effort: null },
    '桥关掉时 model 回落 transcript、effort 必须是 null 而不是快照里的值');
});

// ── 正常 tick 的抑重 ────────────────────────────────────────────────────────

test('未上锁的稳态下反复 tick 不重复广播（正常分支的 force=false）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-quiet');
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-quiet', settledTail(Date.now() - 20_000));
  await h.engine.catchUpTick();                       // 切入（settled → 不锁）
  await h.engine.catchUpTick();                       // 第一个正常 tick
  const settled = h.mirrorStates().length;

  await h.engine.catchUpTick();
  await h.engine.catchUpTick();

  assert.equal(h.mirrorStates().length, settled,
    '状态没变还每 2.5s 推一条 mirror_state，等于把广播通道当心跳用');
});

// 归属守卫共三处（切入 / localBusy / 正常），代码相同但保护的东西不同。上面两条各打了一处，
// 变异检查显示另两处的「实例被换掉」这一析取项仍未被触发过——补齐，因为 dispose+resume 在
// 任何一个 tick 中途都可能发生，而正常分支那处一旦失守就是把旧会话内容推进新视图。

test('归属守卫：正常追平 tick 中途实例被换掉 → 旧会话的增量不得推给新实例', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-swap');
  const base = Date.now() - 20_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-swap', settledTail(base));
  await h.engine.catchUpTick();                       // 切入定基线

  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-swap', [
    ...settledTail(base),
    { type: 'user', message: { role: 'user', content: '终端写的' }, timestamp: iso(base + 5_000) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SWAPPED_AWAY' }] }, timestamp: iso(base + 6_000) },
  ]);
  const inflight = h.engine.catchUpTick();
  h.agents.set('inst-A', { sessionId: 'sess-swap', cwd: a.cwd, externalDirty: false });
  await inflight;

  assert.equal(h.historyAppends().length, 0, '观察归属的实例已被替换，这一 tick 整体作废');
  assert.equal(a.externalDirty, false, '已被 dispose 的旧实例不该再被写状态');
});

test('归属守卫：localBusy tick 中途实例被换掉 → 不得把观察结果记到旧实例上', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-busyswap');
  const base = Date.now() - 20_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-busyswap', settledTail(base));
  await h.engine.catchUpTick();

  h.setState('inst-A', 'permission');
  await h.engine.catchUpTick();                       // 建立 size 基线
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-busyswap', [
    ...settledTail(base),
    { type: 'user', message: { role: 'user', content: '审批挂起期间终端写的' }, timestamp: iso(base + 5_000) },
  ]);

  const inflight = h.engine.catchUpTick();            // 这一 tick 本会把 a 标脏
  h.agents.set('inst-A', { sessionId: 'sess-busyswap', cwd: a.cwd, externalDirty: false });
  await inflight;

  assert.equal(a.externalDirty, false, '守卫应在提交前 return，旧实例上不留这一 tick 的痕迹');
});

// ── 接管 fencing：R2（2026-08-06 BUG hunting review）─────────────────────────
// takeOver() 是用户显式接管后的权威解锁（前端 override → 发消息成功入队 → 服务端切换驾驶方）。
// tick 的三重提交守卫只比对 viewing / 实例引用 / cwd+sessionId——接管【不改变其中任何一项】，
// 于是一个在 takeOver 之前开始读盘、之后才 resolve 的 tick 会带着接管前的观察走完提交段：
// 重新 a.externalDirty=true + 广播 history_append + mirrorReleaseStep(externalWrite) → 重新上锁。
// 用户刚拿到输入权就被夺走，且随后本方轮次开跑（localBusy）会让 mirrorReleaseStep 维持锁、
// quietTicks 清零，要再攒满 12.5s 静默才解锁。对照：clearMirrorOnViewChange 能被 viewing 守卫兜住，
// takeOver 兜不住——这是一处不对称，须给接管一个 fencing token。
test('R2：tick 在飞期间用户接管 → 旧观察不得把刚接管的会话重新上锁', async () => {
  let takenOver = false;
  const h = makeEngine({
    // 探针在每个 tick 的第一个 await 之前触发：在此调 takeOver，模拟「tick 已开始读盘、
    // 用户此刻完成接管」——读盘拿到的是接管前的世界，提交时接管已生效。
    onTickProbe: getEngine => {
      if (!takenOver) return;
      takenOver = 'done';
      getEngine().takeOver('sess-takeover');
    },
  });
  const a = h.view('inst-A', 'sess-takeover');
  const base = Date.now() - 20_000;
  // 先建立基线（切入分支，本 tick 不推）
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-takeover', settledTail(base, '第一轮'));
  await h.engine.catchUpTick();

  // 终端又写了一轮：下个 tick 会观察到外部增长 → 正常情况该上锁
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-takeover', [
    ...settledTail(base, '第一轮'),
    ...settledTail(Date.now() - 1_000, '终端写的第二轮'),
  ]);
  a.externalDirty = false;
  takenOver = true; // 武装：下个 tick 一开始就接管
  await h.engine.catchUpTick();

  assert.equal(takenOver, 'done', '前置：接管确实发生在 tick 飞行中');
  assert.equal(h.engine.isReadonly(), false, '接管后的会话不得被在飞旧 tick 重新上锁');
  assert.equal(a.externalDirty, false, '接管已 dispose+resume 吸收过磁盘，旧观察不得重新标脏');
});

test('R2b：无接管时同样的外部增长仍必须正常上锁（防上一条测成恒不上锁的假绿）', async () => {
  const h = makeEngine();
  const a = h.view('inst-A', 'sess-normal-lock');
  const base = Date.now() - 20_000;
  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-normal-lock', settledTail(base, '第一轮'));
  await h.engine.catchUpTick();

  writeTranscript(h.roots.transcriptBaseDir, a.cwd, 'sess-normal-lock', [
    ...settledTail(base, '第一轮'),
    ...settledTail(Date.now() - 1_000, '终端写的第二轮'),
  ]);
  await h.engine.catchUpTick();

  assert.equal(h.engine.isReadonly(), true, '外部写入照常上锁');
  assert.equal(a.externalDirty, true, '照常标脏');
});
