// tests/unit/mirror-engine.test.mjs —— 只读镜像 / catchUp 编排引擎单测（临时夹具根，零真实 ~/.claude）
//
// 【为什么补这份】src/server/mirror-engine.js 是 P0–P4 重构专门从 app.js 抽出来的「状态与编排的唯一
// 所有者」（416 行 / 15 个状态量 / 工厂 + 全注入），可测性是刻意做出来的——但抽出来之后没有任何测试
// 跟进：2026-08-02 实测它【根本不出现在覆盖率报告里】，即没有任何单测加载过它。唯一 import 者
// src/server/app.js 同样零单测覆盖，而 E2E 打的是 mock server 不是真 server。
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
// ~/.claude/projects 与 ~/.claude/sessions：前者是机主的会话记录，后者塞进带活 pid 的条目会让机主
// 正在跑的 server 看到幻影「终端会话」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMirrorEngine } from '../../src/server/mirror-engine.js';
import { getProjectDir, MIRROR_STALE_PENDING_MS } from '../../src/sessions/history.js';

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
function makeEngine({ cwd = '/tmp/ccm-mirror-ws', serviceStartedAt = Date.now(), roots = makeRoots() } = {}) {
  const emitted = [];
  const agents = new Map();
  const states = new Map();
  let viewing = null;
  let viewingCwd = cwd;
  let statusRefreshes = 0;

  const engine = createMirrorEngine({
    io: { to: room => ({ emit: (event, envelope) => emitted.push({ room, event, ...envelope }) }) },
    agents,
    instanceState: id => states.get(id) ?? 'idle',
    getViewingInstanceId: () => viewing,
    viewingCwdOf: () => viewingCwd,
    serviceStartedAt,
    scheduleStatusRefresh: () => { statusRefreshes += 1; },
    readCliSnapshotForSession: () => ({ state: 'missing', snapshot: null }),
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
