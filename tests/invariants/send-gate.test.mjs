// tests/invariants/send-gate.test.mjs —— 发送闸：消息交给 SDK 之前的判定与投递
// 守护：SESSION-01（终端仍在驾驶时 Web 不得向同一会话发新消息；无人值守时不得替用户接管）/ SESSION-04（续接分叉时不得静默发送）/ SRV-003（忙碌时禁止置换）/ MSG-01（commit 排在 send 成功之后、所有副作用之前）
// 测什么：① 交互路径的判定次序与负 ack 逐字不变（抽闸门不得改变 user:message 的外部行为）
//   ② 投递尾部：失败不 commit，成功先 commit 再做副作用
//   ③ 无人值守模式接上【真】注册表（一次性目录真 json）：有别的驾驶员、读不全、镜像锁、外部写入、分叉都不发，也不置换
// 不测什么 + 为什么：① ack 经 socket 的真键集、真置换、真分叉判定属 S2，见 tests/invariants/server/ 下的
//   message-ack、external-dirty、resume-divergence ② 排队条目的状态机不在这里，闸门只回答「能不能发」
//   ③ 注册表与终端竞争的残余窗口（读完到 a.send 之间）不可测，与额度墙自动继续同口径接受
// 槽位：S1（编排 + 一次性目录真 fs，依赖全注入）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSendGate } from '../../app/src/server/send-gate.js';
import { listTerminalSessionStatesOrNull } from '../../app/src/sessions/session-registry.js';

const SID = '6f0c2a55-1b7e-4a4e-9d0f-0a1b2c3d4e5f';
const CWD = '/Users/you/code/app';
const BUSY_ACK = { ok: false, error: '当前任务运行中，请等待完成后再发送', busy: true, retryable: false };
const DIVERGENCE = Object.freeze({
  newestUuid: 'a-2', newestEntrypoint: 'sdk-ts', newestAt: '2026-09-03T12:34:01.953Z',
  droppedCount: 2, anchorEntrypoint: 'cli', anchorAt: '2026-09-03T12:26:43.779Z',
});

function makeInstance(over = {}) {
  const inst = {
    instanceId: 'inst-1', sessionId: SID, cwd: CWD, authorizedRoot: CWD, permissionMode: 'default',
    pendingTurns: 0, externalDirty: false, resumeDivergence: null, resumeDivergencePending: null,
    bgTasks: new Map(), pendingPermissions: new Map(), pendingQuestions: new Map(), pendingElicitations: new Map(),
    sent: [], notices: [],
    isBusy() { return this.pendingTurns > 0 || this.bgTasks.size > 0; },
    logKey() { return this.sessionId; },
    async send(text, model, opts) { this.sent.push({ text, model, opts }); return true; },
    emitNotice(text, level) { this.notices.push({ text, level }); },
  };
  return Object.assign(inst, over);
}

function makeGate(over = {}) {
  const trace = [];
  const state = { viewing: 'inst-1', readonly: false, writesLost: null };
  const replacement = makeInstance({ instanceId: 'inst-2' });
  const deps = {
    recoverLocation: async () => ({ status: 'found' }),
    disposeForSwap: id => { trace.push(`dispose:${id}`); },
    resume: async (cwd, sid, extra) => { trace.push(`resume:${sid}:${extra.mode}`); return replacement; },
    effortOf: () => 'high',
    effortSourceOf: () => 'user',
    getViewingInstanceId: () => state.viewing,
    claimViewing: a => { trace.push(`claim:${a.instanceId}`); state.viewing = a.instanceId; },
    reselectViewingAfter: cwd => { trace.push(`reselect:${cwd}`); },
    broadcastInstances: () => { trace.push('broadcast'); },
    listTerminalStates: async () => new Map(),
    mirrorEngine: {
      isReadonly: () => state.readonly,
      takeOver: sid => { trace.push(`takeOver:${sid}`); },
    },
    saveAttachments: async () => [],
    commitProcessed: (id, a) => { trace.push(`commit:${id}:${a.instanceId}`); },
    onManualSend: sid => { trace.push(`manualSend:${sid}`); },
    noteLiveTerminalOnTakeover: () => { trace.push('noteTakeover'); },
    takeWritesLost: () => { const t = state.writesLost; state.writesLost = null; return t; },
    interactionLog: { addSessionLog: () => {}, userMessageIn: () => {} },
    diagLog: { record: () => { trace.push('diag'); } },
    ...over,
  };
  return { gate: createSendGate(deps), trace, state, replacement };
}

// ── 交互路径的判定 ──

test('交互：闸全过 → ok，实例不变，没有任何副作用', async () => {
  const { gate, trace } = makeGate();
  const a = makeInstance();
  const r = await gate.prepare(a);
  assert.deepEqual(r, { ok: true, instance: a });
  assert.deepEqual(trace, []);
});

test('交互：记录位置失效 → 负 ack；只有 stale 值得重试，其余客户端要停手', async () => {
  const notFound = await makeGate({ recoverLocation: async () => ({ status: 'not_found' }) }).gate.prepare(makeInstance());
  assert.equal(notFound.ok, false);
  assert.equal(notFound.code, 'location');
  assert.deepEqual(notFound.ack, { ok: false, error: '会话不存在', permanent: true });
  const stale = await makeGate({ recoverLocation: async () => ({ status: 'stale' }) }).gate.prepare(makeInstance());
  assert.deepEqual(stale.ack, { ok: false, error: '会话位置已变化，请重试', permanent: false });
});

test('交互：FRESH 首轮没有 sessionId → 不查记录位置（还没有记录可查）', async () => {
  let called = 0;
  const { gate } = makeGate({ recoverLocation: async () => { called += 1; return { status: 'not_found' }; } });
  const r = await gate.prepare(makeInstance({ sessionId: null }));
  assert.equal(r.ok, true);
  assert.equal(called, 0);
});

test('交互 SRV-003：外部写过且忙 → 不置换，负 ack 带具体忙因', async () => {
  const { gate, trace } = makeGate();
  const a = makeInstance({ externalDirty: true, bgTasks: new Map([['t1', {}]]) });
  const r = await gate.prepare(a);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'external_dirty_busy');
  assert.equal(r.instance, a);
  assert.deepEqual(r.ack, { ok: false, error: '需先吸收终端写入，但后台任务仍在运行，请完成后重试', busy: true, retryable: true, reason: 'bg_tasks' });
  assert.deepEqual(trace, [], '忙碌中置换会杀掉在途审批和后台任务');
});

test('交互 SESSION-01：外部写过且闲 → 先告知再置换，viewing 没被切走就接管', async () => {
  const seen = [];
  const { gate, trace, replacement } = makeGate();
  const a = makeInstance({ externalDirty: true, externalObserved: { permissionMode: 'plan' } });
  const r = await gate.prepare(a, { onResuming: info => { seen.push(info); trace.push('resuming'); } });
  assert.equal(r.ok, true);
  assert.equal(r.instance, replacement, '消息必须落在新实例上，旧实例内存里没有那些外部轮次');
  assert.deepEqual(seen, [{ sessionId: SID, instanceId: 'inst-1' }]);
  assert.deepEqual(trace, ['resuming', 'dispose:inst-1', `resume:${SID}:plan`, 'claim:inst-2', 'broadcast']);
});

test('交互：置换期间用户切走了 → 不抢回 viewing', async () => {
  const ctx = makeGate({
    resume: async () => { ctx.state.viewing = 'inst-9'; return ctx.replacement; },
  });
  await ctx.gate.prepare(makeInstance({ externalDirty: true }));
  assert.equal(ctx.state.viewing, 'inst-9');
  assert.deepEqual(ctx.trace, ['dispose:inst-1', 'broadcast']);
});

test('交互：置换的 resume 失败 → 收拾死指针、广播，再把错误抛给调用方', async () => {
  const { gate, trace } = makeGate({ resume: async () => { throw new Error('spawn 失败'); } });
  await assert.rejects(gate.prepare(makeInstance({ externalDirty: true })), /spawn 失败/);
  assert.deepEqual(trace, ['dispose:inst-1', `reselect:${CWD}`, 'broadcast']);
});

test('交互 SESSION-04：有分叉结论且没带确认 → 拒收，结论留着等用户选', async () => {
  const { gate } = makeGate();
  const a = makeInstance({ resumeDivergence: DIVERGENCE });
  const r = await gate.prepare(a);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'diverged');
  assert.equal(r.ack.reason, 'resume_divergent');
  assert.equal(a.resumeDivergence, DIVERGENCE);
});

test('交互 SESSION-04：确认的正是这一段 → 放行并清掉结论', async () => {
  const { gate } = makeGate();
  const a = makeInstance({ resumeDivergence: DIVERGENCE });
  const r = await gate.prepare(a, { ackDivergence: 'a-2' });
  assert.equal(r.ok, true);
  assert.equal(a.resumeDivergence, null);
});

test('交互：在途轮 → busy 负 ack 逐字不变，且带上实例（排队要用）', async () => {
  const { gate } = makeGate();
  const a = makeInstance({ pendingTurns: 1 });
  const r = await gate.prepare(a);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'turn_running');
  assert.equal(r.instance, a);
  assert.deepEqual(r.ack, BUSY_ACK);
});

test('交互：后台任务挂着但没有在途轮 → 放行（判据只认在途轮）', async () => {
  const { gate } = makeGate();
  const r = await gate.prepare(makeInstance({ bgTasks: new Map([['t1', {}]]) }));
  assert.equal(r.ok, true);
});

// ── 投递尾部 ──

const MSG = { text: '跑测试', model: 'opus', clientMessageId: 'c1', startedAt: 1 };

test('投递：纯文本 → 原样交给 send，成功 ack 带实例号', async () => {
  const { gate, trace } = makeGate();
  const a = makeInstance();
  const out = await gate.deliver(a, MSG);
  assert.deepEqual(a.sent, [{ text: '跑测试', model: 'opus', opts: { clientMessageId: 'c1' } }]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.ack, { ok: true, instanceId: 'inst-1' });
  assert.ok(trace.includes('commit:c1:inst-1'));
  assert.ok(trace.includes('broadcast'), '开跑要立刻广播，多端靠它禁发送');
});

test('投递：无人值守传的 shouldSend 交给 send，由它在入队那一刻判断；交互路径不传', async () => {
  const { gate } = makeGate();
  const shouldSend = () => false;
  const plain = makeInstance();
  await gate.deliver(plain, { ...MSG, shouldSend });
  assert.equal(plain.sent[0].opts.shouldSend, shouldSend);
  const withAtt = makeInstance();
  await gate.deliver(withAtt, { ...MSG, attachments: [{ name: 'a', data: 'x' }], shouldSend });
  assert.equal(withAtt.sent[0].opts.shouldSend, shouldSend);
});

test('投递：带附件 → 落盘后把绝对路径写进 prompt，气泡只用原文和元数据', async () => {
  const saved = [{ absPath: '/data/uploads/a.png', name: 'a.png', mimeType: 'image/png', size: 3, thumb: 't' }];
  let savedTo = null;
  const { gate } = makeGate({ saveAttachments: async (cwd, atts) => { savedTo = { cwd, atts }; return saved; } });
  const a = makeInstance();
  const attachments = [{ name: 'a.png', data: 'x' }];
  const out = await gate.deliver(a, { ...MSG, attachments });
  assert.deepEqual(savedTo, { cwd: CWD, atts: attachments });
  assert.equal(a.sent[0].text, '跑测试\n\n[附件] 已上传，可用 FileRead / Read 读取：\n/data/uploads/a.png');
  assert.equal(a.sent[0].opts.displayText, '跑测试');
  assert.deepEqual(a.sent[0].opts.attachments, [{ name: 'a.png', mimeType: 'image/png', size: 3, thumb: 't', storedName: 'a.png' }]);
  assert.equal(a.sent[0].opts.clientMessageId, 'c1');
  assert.equal(out.ok, true);
});

test('投递：附件落盘失败 → 永久失败，不 commit，给发送方一句提示', async () => {
  const { gate, trace } = makeGate({ saveAttachments: async () => { throw new Error('磁盘满'); } });
  const a = makeInstance();
  const out = await gate.deliver(a, { ...MSG, attachments: [{ name: 'a', data: 'x' }] });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'attachment_failed');
  assert.equal(out.notice, '附件保存失败：磁盘满');
  assert.deepEqual(out.ack, { ok: false, error: '磁盘满', permanent: true, retryable: false });
  assert.deepEqual(a.sent, []);
  assert.deepEqual(trace, []);
});

test('投递：send 抛错 → 可重试，不 commit', async () => {
  const { gate, trace } = makeGate();
  const a = makeInstance({ send: async () => { throw new Error('setModel 失败'); } });
  const out = await gate.deliver(a, MSG);
  assert.equal(out.reason, 'send_failed');
  assert.equal(out.notice, '发送失败：setModel 失败');
  assert.deepEqual(out.ack, { ok: false, error: 'setModel 失败', permanent: false, retryable: true });
  assert.deepEqual(trace, []);
});

test('投递 MSG-01：send 返回 false → 可重试，不 commit（commit 了重发会被假成功吞掉）', async () => {
  const { gate, trace } = makeGate();
  const a = makeInstance({ send: async () => false });
  const out = await gate.deliver(a, MSG);
  assert.equal(out.ok, false, '无人值守调用方靠这个字段判断发没发出去');
  assert.equal(out.reason, 'send_failed');
  assert.equal(out.notice, undefined);
  assert.deepEqual(out.ack, { ok: false, error: '发送失败，请重试', retryable: true });
  assert.deepEqual(trace, []);
});

test('投递 MSG-01：send 成功后第一件事是 commit，后面任何一步抛错都不会让消息被重投', async () => {
  const { gate, trace } = makeGate({ onManualSend: () => { throw new Error('下游炸了'); } });
  await assert.rejects(gate.deliver(makeInstance(), MSG), /下游炸了/);
  assert.deepEqual(trace, ['commit:c1:inst-1'], 'commit 必须排在第一个可能抛错的副作用之前');
});

test('投递：副作用都落在 commit 之后，且广播是最后一步（ack 在广播之后才回）', async () => {
  const { gate, trace, state } = makeGate();
  state.readonly = true;
  await gate.deliver(makeInstance(), MSG);
  assert.deepEqual(trace, ['commit:c1:inst-1', `manualSend:${SID}`, 'noteTakeover', 'diag', `takeOver:${SID}`, 'broadcast']);
});

test('投递：只有发在当前查看实例上才清镜像锁，失败入队不清', async () => {
  const other = makeGate();
  other.state.readonly = true;
  other.state.viewing = 'inst-9';
  await other.gate.deliver(makeInstance(), MSG);
  assert.ok(!other.trace.some(t => t.startsWith('takeOver')), '发在别的实例上不代表终端交出了当前会话');

  const failed = makeGate();
  failed.state.readonly = true;
  await failed.gate.deliver(makeInstance({ send: async () => false }), MSG);
  assert.ok(!failed.trace.some(t => t.startsWith('takeOver')), '没进队列不算接管');
});

test('投递：上一个 CLI 退出时报的写丢，在这里说一次', async () => {
  const { gate, state } = makeGate();
  state.writesLost = '上一个 CLI 有写入丢失';
  const a = makeInstance();
  await gate.deliver(a, MSG);
  await gate.deliver(a, { ...MSG, clientMessageId: 'c2' });
  assert.deepEqual(a.notices, [{ text: '上一个 CLI 有写入丢失', level: 'warning' }]);
});

// ── 无人值守模式：用户不在跟前，闸门比交互路径严 ──

const ROOTS = [];
test.after(() => {
  for (const dir of ROOTS) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ } }
});

// 用本进程 pid：注册表消费者会 pid 验活。绝不写进真实 ~/.claude/sessions，活 pid 的条目会让正在跑的 server 看到幻影终端。
function registryWith(entry) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-send-gate-reg-'));
  ROOTS.push(dir);
  if (entry) {
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: SID, cwd: CWD, kind: 'interactive', startedAt: 1, version: '2.1.318', ...entry,
    }));
  }
  return dir;
}

function unattendedGate(dir, over = {}) {
  return makeGate({ listTerminalStates: () => listTerminalSessionStatesOrNull({ dir }), ...over });
}

test('无人值守 正对照：注册表没有别的驾驶员 → 放行（证明下面几条「不发」是闸在起作用）', async () => {
  const { gate } = unattendedGate(registryWith(null));
  const a = makeInstance();
  assert.deepEqual(await gate.prepare(a, { unattended: true }), { ok: true, instance: a });
});

for (const [name, entry] of [
  ['终端在跑', { entrypoint: 'cli', status: 'busy' }],
  ['终端等审批', { entrypoint: 'cli', status: 'waiting' }],
  ['桌面端在跑（新版自报）', { entrypoint: 'claude-desktop', status: 'busy' }],
  // 2026-11-08：VS Code 扩展此前不在外部驾驶员名单上，排队消息会被代发进它正在跑的会话
  ['VS Code 在跑', { entrypoint: 'claude-vscode', status: 'busy' }],
  ['VS Code 等审批', { entrypoint: 'claude-vscode', status: 'waiting' }],
  ['上游新加的运行形式在跑', { entrypoint: 'brand-new-frontend', status: 'busy' }],
  ['后台 agent 占用', { entrypoint: 'sdk-cli', kind: 'bg' }],
  ['别的目录下的进程开着同一会话', { entrypoint: 'cli', status: 'busy', cwd: `${CWD}/.claude/worktrees/x` }],
]) {
  test(`无人值守 SESSION-01：${name} → other_driver，不进后面任何一道闸`, async () => {
    let recovered = 0;
    const { gate, trace } = unattendedGate(registryWith(entry), {
      recoverLocation: async () => { recovered += 1; return { status: 'found' }; },
    });
    const a = makeInstance({ externalDirty: true });
    const r = await gate.prepare(a, { unattended: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'other_driver');
    assert.equal(r.instance, a);
    assert.equal(recovered, 0);
    assert.deepEqual(trace, [], '两端同时写时不得碰实例');
  });
}

test('无人值守：终端开着但闲着 → 放行（机主决定，与手动发送同口径）', async () => {
  const { gate } = unattendedGate(registryWith({ entrypoint: 'cli', status: 'idle' }));
  assert.equal((await gate.prepare(makeInstance(), { unattended: true })).ok, true);
});

test('无人值守 SESSION-01：注册表读不全 → unverified（否定证据必须 fail-closed）', async () => {
  const dir = registryWith(null);
  writeFileSync(join(dir, '99999.json'), '{"pid":99');   // 写到一半的条目可能正是开着本会话的终端
  const { gate } = unattendedGate(dir);
  const r = await gate.prepare(makeInstance(), { unattended: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unverified');
});

test('无人值守 SESSION-01：当前查看实例上镜像锁着 → other_driver；看着别的实例时不受这把全局锁影响', async () => {
  const locked = makeGate();
  locked.state.readonly = true;
  assert.equal((await locked.gate.prepare(makeInstance(), { unattended: true })).code, 'other_driver');

  const elsewhere = makeGate();
  elsewhere.state.readonly = true;
  elsewhere.state.viewing = 'inst-9';
  assert.equal((await elsewhere.gate.prepare(makeInstance(), { unattended: true })).ok, true);
});

test('无人值守：记录位置失效 → location', async () => {
  const { gate } = makeGate({ recoverLocation: async () => ({ status: 'not_found' }) });
  const r = await gate.prepare(makeInstance(), { unattended: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'location');
});

test('无人值守 SRV-003：外部写过 → other_driver，绝不置换（置换会杀掉后台任务，且用户不在跟前）', async () => {
  const { gate, trace } = makeGate();
  const a = makeInstance({ externalDirty: true });
  let resuming = 0;
  const r = await gate.prepare(a, { unattended: true, onResuming: () => { resuming += 1; } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'other_driver');
  assert.equal(r.instance, a);
  assert.equal(resuming, 0);
  assert.deepEqual(trace, []);
});

test('无人值守 SESSION-04：有分叉结论 → diverged，不清结论（确认只能来自用户当面点的那一下）', async () => {
  const { gate } = makeGate();
  const a = makeInstance({ resumeDivergence: DIVERGENCE });
  const r = await gate.prepare(a, { unattended: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'diverged');
  assert.equal(a.resumeDivergence, DIVERGENCE);
});

test('无人值守：判定期间又开了一轮 → turn_running，交给调用方等下一个 result', async () => {
  const a = makeInstance();
  const { gate } = makeGate({ recoverLocation: async () => { a.pendingTurns = 1; return { status: 'found' }; } });
  const r = await gate.prepare(a, { unattended: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'turn_running');
});

test('交互路径不查注册表：手动发送的驾驶闸在前端，点发送算显式接管', async () => {
  let listed = 0;
  const { gate } = makeGate({ listTerminalStates: async () => { listed += 1; return null; } });
  assert.equal((await gate.prepare(makeInstance())).ok, true);
  assert.equal(listed, 0);
});
