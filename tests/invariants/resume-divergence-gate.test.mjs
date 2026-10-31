// tests/invariants/resume-divergence-gate.test.mjs —— 续接会丢掉最新那段对话时，Web 不得静默发送
// 守护：SESSION-04（CLI 这次会接上的链不含物理上最新的对话消息时，发送前必须先拒收、由用户选分叉或仍然发送；自动继续同样不得代发）
// 测什么：① 发送闸 gateResumeDivergence 的三种结局（无分叉放行 / 未确认拒收 / 确认的正是这一段才放行并清掉）
//   ② 前端两条 ack 决策路径对 resume_divergent 都不变成自动重发（在线不进 outbox、离线落 blocked），
//      不认 reason 的旧前端靠 permanent 停手
//   ③ 额度墙自动继续：实例带分叉结论时不代发、转 stale(diverged)；用户在这条横幅上点「继续」才照常发
//   ④ 判定挪到后台之后：到点时判定还在读盘就先等它落定；等到上限仍不落定按读不动放行（fail-open），迟到的结论作废
// 不测什么 + 为什么：① CLI 会接上哪条链的预测在 tests/unit/resume-anchor.test.mjs——它建模的是上游行为，
//   夹具出自零 token 真 CLI 实测，不是本仓红线 ② 真 server 组装根的接线（openResumeInstance 算结论、
//   user:message 过闸、拒收 ack 的键集）属 S2，见 tests/invariants/server/resume-divergence.test.mjs ③ 面板与分叉后
//   回填输入框属 S3，见 tests/e2e/specs/resume-divergence.spec.ts
// 槽位：S1（纯函数 + 编排，依赖全注入）
import test from 'node:test';
import assert from 'node:assert/strict';

import { gateResumeDivergence, RESUME_DIVERGENT, startResumeDivergence, awaitResumeDivergence } from '../../app/src/sessions/resume-anchor.js';
import { presentOnlineSendAck, presentOfflineResendAck } from '../../app/public/js/logic/outbox-send.js';
import { createAutoContinue } from '../../app/src/server/auto-continue.js';
import { AUTO_CONTINUE_JITTER_MIN_MS } from '../../app/src/agent/quota-auto-continue.js';

// resumeDivergence 对真机 c78e8b47 形态给出的结论（终端最后退出，手机最后那一问一答被丢）
const DIVERGENCE = Object.freeze({
  newestUuid: 'a-2', newestEntrypoint: 'sdk-ts', newestAt: '2026-09-03T12:34:01.953Z',
  droppedCount: 2, anchorEntrypoint: 'cli', anchorAt: '2026-09-03T12:26:43.779Z',
});

test('发送闸：没有分叉结论 → 照常发', () => {
  assert.deepEqual(gateResumeDivergence(null, undefined), { action: 'send', clear: false });
});

test('发送闸：有分叉结论且没确认 → 拒收，ack 带上结论供前端出面板', () => {
  const r = gateResumeDivergence(DIVERGENCE, undefined);
  assert.equal(r.action, 'reject', '静默发出去，模型就从终端那一轮接上，用户还以为它记得手机上说的');
  assert.equal(r.ack.ok, false);
  assert.equal(r.ack.reason, RESUME_DIVERGENT);
  assert.deepEqual(r.ack.divergence, DIVERGENCE);
  assert.ok(typeof r.ack.error === 'string' && r.ack.error.length > 0, '旧前端只会显示 error');
});

test('发送闸：确认的不是这一段（期间又续接了一次、结论换了）→ 仍拒收', () => {
  assert.equal(gateResumeDivergence(DIVERGENCE, 'a-older').action, 'reject');
  assert.equal(gateResumeDivergence(DIVERGENCE, true).action, 'reject', '布尔真值不算确认：必须指明确认的是哪一段');
});

test('发送闸：确认的正是这一段 → 发，并清掉结论（同一实例上不再拦）', () => {
  assert.deepEqual(gateResumeDivergence(DIVERGENCE, 'a-2'), { action: 'send', clear: true });
});

test('前端在线 ack：resume_divergent 不进 outbox 自动重发、撤乐观气泡、交给面板', () => {
  const { ack } = gateResumeDivergence(DIVERGENCE, undefined);
  const d = presentOnlineSendAck(ack);
  assert.equal(d.ok, false);
  assert.equal(d.requeue, false, '自动重发会一直撞同一道闸，或者被谁悄悄带上确认发出去');
  assert.equal(d.dropBubble, true, '这条没发出去');
  assert.equal(d.restoreDraft, true, '话先回到输入框：面板两个选项都作用于它，取消或面板没弹出来时也不丢');
  assert.deepEqual(d.divergence, DIVERGENCE, '面板要的事实');
  // 不认 reason 的旧前端（缓存的旧 PWA）：只能靠 permanent 停手，否则 retryable 缺省会把它塞进 outbox 反复重发
  const legacy = presentOnlineSendAck({ ...ack, reason: undefined });
  assert.equal(legacy.requeue, false);
  assert.equal(legacy.restoreDraft, true, '旧前端至少把字还回输入框');
});

test('前端离线重发 ack：resume_divergent 落 blocked、不自动重放，并带上结论（点「重发」再撞上时据它出面板）', () => {
  const { ack } = gateResumeDivergence(DIVERGENCE, undefined);
  const d = presentOfflineResendAck(null, ack);
  assert.equal(d.outcome, 'blocked');
  assert.equal(d.requeue, false);
  assert.deepEqual(d.divergence, DIVERGENCE, '不带的话「重发」只会一遍遍撞同一道闸，提示里许诺的选择永远出不来');
});

// ── 额度墙自动继续 ──
const SID = '6f0c2a55-1b7e-4a4e-9d0f-0a1b2c3d4e5f';
const CWD = '/Users/you/code/app';
const T0 = Date.UTC(2026, 8, 22, 17, 48, 20);
const RESET_S = Math.floor(T0 / 1000) + 3 * 3600;
const FIRE_AT = RESET_S * 1000 + AUTO_CONTINUE_JITTER_MIN_MS;
const QUOTA = { status: 'rejected', resetsAt: RESET_S, rateLimitType: 'five_hour', isUsingOverage: false };
const wallEntry = { type: 'assistant', uuid: 'wall-1', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, quotaLimits: QUOTA, entrypoint: 'sdk-ts', isSidechain: false, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 3pm" }] } };
const human = { type: 'user', uuid: 'u-1', entrypoint: 'sdk-ts', isSidechain: false, message: { role: 'user', content: '跑个长任务' } };

function makeScheduler({ live = true, divergence = DIVERGENCE, verdict = null, states = async () => new Map() } = {}) {
  let now = T0;
  const sent = [];
  const inst = {
    pendingTurns: 0, externalDirty: false, resumeDivergence: divergence,
    async send(text, model, opts) { sent.push({ text, opts }); return true; },
    emitNotice() {},
  };
  if (verdict) startResumeDivergence(inst, verdict); // 后台判定还在读盘（openResumeInstance 的回执已经回了）
  const ac = createAutoContinue({
    now: () => now,
    random: () => 0,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    isAutoEnabled: () => true,
    readTailEntries: async () => [human, wallEntry],
    listTerminalStates: states,
    getLiveInstance: () => (live ? inst : null),
    resumeInstance: async () => inst,
  });
  ac.onWall({ sessionId: SID, cwd: CWD, instance: inst, wall: { uuid: 'wall-1', quota: QUOTA, fallback: null, turnOrigin: 'human', turnHadOutput: true } });
  const fireNow = async () => {
    now = FIRE_AT - 10_000; await ac.tick();
    now = FIRE_AT + 1; await ac.tick();
    await ac.idle();
  };
  return { ac, inst, sent, fireNow };
}

test('自动继续正对照：没有分叉结论时到点确实发出（仪器看得见「发了」）', async () => {
  const { sent, fireNow } = makeScheduler({ divergence: null });
  await fireNow();
  assert.equal(sent.length, 1, '这条不绿，下面的「没发」就证明不了任何事');
});

test('自动继续：resume 出来的实例带分叉结论 → 不代发，转 stale(diverged) 让人看见', async () => {
  for (const live of [true, false]) {
    const { ac, sent, fireNow } = makeScheduler({ live });
    await fireNow();
    assert.equal(sent.length, 0, `${live ? '活实例' : '到点现 resume 的实例'}：代发的「继续」会接在终端那一轮上`);
    const row = ac.snapshot()[0];
    assert.equal(row?.phase, 'stale');
    assert.equal(row?.reason, 'diverged');
  }
});

test('自动继续：到点时判定还在后台读盘 → 先等它落定；落定是分叉就不代发、转 stale(diverged)', async () => {
  for (const live of [true, false]) {
    const verdict = new Promise(resolve => setTimeout(resolve, 30, DIVERGENCE));
    const { ac, sent, fireNow } = makeScheduler({ live, divergence: null, verdict });
    await fireNow();
    assert.equal(sent.length, 0, `${live ? '活实例' : '到点现 resume 的实例'}：抢在判定落定前代发，等于没有这道闸`);
    assert.equal(ac.snapshot()[0]?.reason, 'diverged');
  }
});

test('判定等到上限仍不落定 → 按读不动放行（fail-open），迟到的结论不再落到实例上', async () => {
  const inst = { resumeDivergence: null };
  let land;
  startResumeDivergence(inst, new Promise(resolve => { land = resolve; }));
  assert.equal(await awaitResumeDivergence(inst, { timeoutMs: 20 }), false, '等不到');
  assert.equal(await awaitResumeDivergence(inst, { timeoutMs: 1_000 }), true, '作废之后不再等：下一条发送不该再干等一个上限');
  land(DIVERGENCE);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inst.resumeDivergence, null, '放行的那条已经接在 CLI 选的那支上，再拦下一条只会对着过去的分叉问人');
});

test('自动继续：用户在 diverged 横幅上点「继续」= 知情选了「仍然发送」→ 发，并清掉结论', async () => {
  const { ac, inst, sent, fireNow } = makeScheduler();
  await fireNow();
  assert.equal(ac.act(SID, 'continueNow').ok, true);
  await ac.idle();
  assert.equal(sent.length, 1);
  assert.equal(inst.resumeDivergence, null);
});

test('自动继续：因别的原因 stale 后点「继续」、复核才发现分叉 → 改成 diverged 再问一次，不替人确认', async () => {
  const registry = { states: null }; // 第一次到点：注册表读不全 → stale(unverified)
  const { ac, inst, sent, fireNow } = makeScheduler({ divergence: null, states: async () => registry.states });
  await fireNow();
  assert.equal(ac.snapshot()[0]?.reason, 'unverified');
  registry.states = new Map();
  inst.resumeDivergence = DIVERGENCE;
  assert.equal(ac.act(SID, 'continueNow').ok, true);
  await ac.idle();
  assert.equal(sent.length, 0, '那一下点的是「可能有别的驾驶员也继续」，不是「丢掉手机那段也继续」');
  assert.equal(ac.snapshot()[0]?.reason, 'diverged');
});
