// tests/unit/history.test.mjs —— history.js 单测（tmpdir 注入，零网络/零真实 claude 目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, getSessionHistory, HISTORY_MAX_MESSAGES, catchUpStep, rebaselineAbsorbedExternal, classifyTranscriptTail, lastPermissionMode, readLastPermissionMode, lastAssistantModel, readLastAssistantModel } from '../../src/sessions/history.js';

const BASE = join(tmpdir(), `ccm-hist-${process.pid}`);
mkdirSync(BASE, { recursive: true });

function writeJSONL(dir, id, entries) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

test('classifyTranscriptTail: assistant 纯文本收尾 → settled（轮次完结）', async () => {
  const cwd = '/test/tail-settled';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'tsettled', [
    { type: 'user', message: { role: 'user', content: '提问' }, timestamp: '2026-07-12T10:00:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想' }] }, timestamp: '2026-07-12T10:00:05.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '答完了' }] }, timestamp: '2026-07-12T10:00:10.000Z' },
    { type: 'last-prompt' }, // 真实形态：链条目后跟非链条目（实验 2b）
  ]);
  const r = await classifyTranscriptTail('tsettled', cwd, { baseDir: BASE });
  assert.equal(r.verdict, 'settled');
  assert.equal(r.lastChainTs, Date.parse('2026-07-12T10:00:10.000Z'));
});

test('classifyTranscriptTail: assistant 发起 tool_use（结果未落盘）→ pending（正在执行工具）', async () => {
  const cwd = '/test/tail-tooluse';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'ttooluse', [
    { type: 'user', message: { role: 'user', content: '提问' }, timestamp: '2026-07-12T10:00:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, timestamp: '2026-07-12T10:00:05.000Z' },
  ]);
  const r = await classifyTranscriptTail('ttooluse', cwd, { baseDir: BASE });
  assert.equal(r.verdict, 'pending');
});

test('classifyTranscriptTail: user/tool_result 落盘、assistant 下一步未落 → pending（实验 2a 真实形态）', async () => {
  const cwd = '/test/tail-toolresult';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'ttoolres', [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, timestamp: '2026-07-12T10:00:00.000Z' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, timestamp: '2026-07-12T10:00:03.000Z' },
    // 实验 2a 实测：tool_result 后面跟一串非链条目，分类须跳过它们、按最后链条目判
    { type: 'last-prompt' }, { type: 'ai-title' }, { type: 'agent-name' }, { type: 'mode' }, { type: 'permission-mode' },
  ]);
  const r = await classifyTranscriptTail('ttoolres', cwd, { baseDir: BASE });
  assert.equal(r.verdict, 'pending');
  assert.equal(r.lastChainTs, Date.parse('2026-07-12T10:00:03.000Z'));
});

test('classifyTranscriptTail: user 文本未获回复 → pending；中断标记收尾 → settled', async () => {
  const cwd = '/test/tail-user';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'tuserwait', [
    { type: 'user', message: { role: 'user', content: '刚发出的提问' }, timestamp: '2026-07-12T10:00:00.000Z' },
  ]);
  assert.equal((await classifyTranscriptTail('tuserwait', cwd, { baseDir: BASE })).verdict, 'pending');
  writeJSONL(dir, 'tinterrupt', [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    { type: 'user', message: { role: 'user', content: '[Request interrupted by user for tool use]' }, timestamp: '2026-07-12T10:00:05.000Z' },
  ]);
  assert.equal((await classifyTranscriptTail('tinterrupt', cwd, { baseDir: BASE })).verdict, 'settled');
});

test('classifyTranscriptTail: assistant 只落了 thinking（text/tool_use 未落）→ pending（流式中间态）', async () => {
  const cwd = '/test/tail-thinking';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'tthink', [
    { type: 'user', message: { role: 'user', content: '提问' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '思考中' }] }, timestamp: '2026-07-12T10:00:02.000Z' },
  ]);
  assert.equal((await classifyTranscriptTail('tthink', cwd, { baseDir: BASE })).verdict, 'pending');
});

test('classifyTranscriptTail: 子 agent（isSidechain）不算链条目——跳过后按主链判', async () => {
  const cwd = '/test/tail-sidechain';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'tside', [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '主链答完' }] }, timestamp: '2026-07-12T10:00:00.000Z' },
    { type: 'user', isSidechain: true, message: { role: 'user', content: '子 agent 内部消息' }, timestamp: '2026-07-12T10:00:05.000Z' },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Read', input: {} }] }, timestamp: '2026-07-12T10:00:06.000Z' },
  ]);
  const r = await classifyTranscriptTail('tside', cwd, { baseDir: BASE });
  assert.equal(r.verdict, 'settled'); // 主链已收尾；子 agent 尾巴不改判
});

test('classifyTranscriptTail: 文件不存在 / 无任何链条目 → settled（不锁），lastChainTs=null', async () => {
  const cwd = '/test/tail-empty';
  const dir = join(BASE, getProjectDir(cwd));
  assert.deepEqual(await classifyTranscriptTail('nonexistent', cwd, { baseDir: BASE }), { verdict: 'settled', lastChainTs: null });
  writeJSONL(dir, 'tmetaonly', [{ type: 'entrypoint-marker' }, { type: 'queue-operation' }]);
  assert.deepEqual(await classifyTranscriptTail('tmetaonly', cwd, { baseDir: BASE }), { verdict: 'settled', lastChainTs: null });
});

// SS-002：settled 轮次后的 CLI 系统噪音（isMeta=false 的 local-command/bash）不得把 tail 改判 pending。
test('classifyTranscriptTail: settled 后接 <local-command-stdout> / isMeta user → 仍 settled（SS-002）', async () => {
  const cwd = '/test/tail-cli-noise';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'tnoise', [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, timestamp: '2026-07-01T00:00:00.000Z' },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' }, isMeta: false, timestamp: '2026-07-01T00:00:01.000Z' },
  ]);
  assert.equal((await classifyTranscriptTail('tnoise', cwd, { baseDir: BASE })).verdict, 'settled');
  writeJSONL(dir, 'tmeta', [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, timestamp: '2026-07-01T00:00:00.000Z' },
    { type: 'user', message: { role: 'user', content: 'sys' }, isMeta: true, timestamp: '2026-07-01T00:00:01.000Z' },
  ]);
  assert.equal((await classifyTranscriptTail('tmeta', cwd, { baseDir: BASE })).verdict, 'settled');
});

// 2026-07-16 真机：/config 等本地 slash 落盘为 command-name + local-command-stdout，无 assistant。
// 旧逻辑把 command-name 当「用户等回复」→ pending → quietTicks 永清零 → 镜像锁不释放。
test('classifyTranscriptTail: 本地 slash（/config）command-name + stdout 收尾 → settled', async () => {
  const cwd = '/test/tail-local-slash';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'tconfig', [
    { type: 'user', message: { role: 'user', content: '<local-command-caveat>Caveat…</local-command-caveat>' }, isMeta: true, timestamp: '2026-07-16T22:17:47.980Z' },
    { type: 'user', message: { role: 'user', content: '<command-name>/config</command-name>\n            <command-message>config</command-message>\n            <command-args></command-args>' }, isMeta: false, timestamp: '2026-07-16T22:17:47.980Z' },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to opus</local-command-stdout>' }, isMeta: false, timestamp: '2026-07-16T22:17:47.980Z' },
    { type: 'last-prompt' },
  ]);
  const r = await classifyTranscriptTail('tconfig', cwd, { baseDir: BASE });
  assert.equal(r.verdict, 'settled', '本地 slash 已 stdout 收尾，不得判 pending 锁死输入');
  assert.equal(r.lastChainTs, Date.parse('2026-07-16T22:17:47.980Z'));
});

// 自定义/项目 slash 注入后仍等 assistant：仅有 command-name、无 local-command-stdout → 仍 pending。
test('classifyTranscriptTail: 项目 slash 仅 command-name、尚无 assistant → pending', async () => {
  const cwd = '/test/tail-project-slash';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'tdeep', [
    { type: 'user', message: { role: 'user', content: '<command-message>deep-research</command-message>\n<command-name>/deep-research</command-name>\n<command-args>foo</command-args>' }, timestamp: '2026-07-16T22:00:00.000Z' },
  ]);
  assert.equal((await classifyTranscriptTail('tdeep', cwd, { baseDir: BASE })).verdict, 'pending');
});

// ── catchUpStep：只读「追平」状态机 ──────────────────────────────────────────

const M = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));

test('catchUpStep: 持续 idle + 外部增长 → 推超出 baseline 的尾巴', () => {
  const r = catchUpStep({ baseline: 2, wasBusy: false }, { messages: M(5), localBusy: false });
  assert.deepEqual(r.emit.map(m => m.content), ['m2', 'm3', 'm4']);
  assert.equal(r.state.baseline, 5);
  assert.equal(r.state.wasBusy, false);
  assert.equal(r.reload, false);
});

test('catchUpStep: 无增长 → 不推、baseline 不变', () => {
  const r = catchUpStep({ baseline: 5, wasBusy: false }, { messages: M(5), localBusy: false });
  assert.deepEqual(r.emit, []);
  assert.equal(r.state.baseline, 5);
  assert.equal(r.state.wasBusy, false);
  assert.equal(r.reload, false);
});

test('catchUpStep: 本地在跑 turn（localBusy）→ 抑制、记 wasBusy、不动 baseline', () => {
  const r = catchUpStep({ baseline: 2, wasBusy: false }, { messages: M(9), localBusy: true });
  assert.deepEqual(r.emit, []);
  assert.equal(r.state.baseline, 2);
  assert.equal(r.state.wasBusy, true);
});

test('catchUpStep: busy→idle → 吸收己方 turn 写盘（重置 baseline、不推）', () => {
  const r = catchUpStep({ baseline: 2, wasBusy: true }, { messages: M(9), localBusy: false });
  assert.deepEqual(r.emit, []);
  assert.equal(r.state.baseline, 9);
  assert.equal(r.state.wasBusy, false);
});

test('catchUpStep: 削头边界（len < baseline）→ 保守不推', () => {
  const r = catchUpStep({ baseline: 5, wasBusy: false }, { messages: M(3), localBusy: false });
  assert.deepEqual(r.emit, []);
  assert.equal(r.state.baseline, 5);
  assert.equal(r.state.wasBusy, false);
});

test('catchUpStep: 完整时序——外部增长推、己方 turn 不重复推、之后外部再推', () => {
  let st = { baseline: 2, wasBusy: false };            // seed：已有 2 条历史
  let r = catchUpStep(st, { messages: M(4), localBusy: false });   // 终端写到 4
  assert.deepEqual(r.emit.map(m => m.content), ['m2', 'm3']); st = r.state;
  r = catchUpStep(st, { messages: M(7), localBusy: true });        // 自己发消息、turn 中写到 7
  assert.deepEqual(r.emit, []); st = r.state;                      // 抑制
  r = catchUpStep(st, { messages: M(7), localBusy: false });       // turn 结束、idle
  assert.deepEqual(r.emit, []); assert.equal(st.wasBusy, true); st = r.state; // 吸收己方写入
  assert.equal(st.baseline, 7);
  r = catchUpStep(st, { messages: M(9), localBusy: false });       // 终端又写到 9
  assert.deepEqual(r.emit.map(m => m.content), ['m7', 'm8']);      // 只推外部新增，不重复己方
});

// SS-001：HISTORY_MAX_MESSAGES 滑动窗口下 len 恒等 baseline 时，尾部内容已换 → 须标 reload（不再 silent miss）。
test('catchUpStep: 满窗滑动（len===baseline 但 tail 内容变）→ emit 空 + reload（SS-001）', () => {
  const cap = 5; // 用小 cap 单测；生产 HISTORY_MAX_MESSAGES=2000
  // 滑窗：丢 old0，加 new；len 仍 5
  const slid = [
    { role: 'user', content: 'old1', timestamp: 't1' },
    { role: 'user', content: 'old2', timestamp: 't2' },
    { role: 'user', content: 'old3', timestamp: 't3' },
    { role: 'user', content: 'old4', timestamp: 't4' },
    { role: 'user', content: 'new5', timestamp: 't5' },
  ];
  const r = catchUpStep(
    { baseline: cap, wasBusy: false, lastTailKey: 't4|user|old4' },
    { messages: slid, localBusy: false, historyCap: cap },
  );
  assert.deepEqual(r.emit, [], '满窗不能 slice 增量（会把仍可见的中间条当「新尾巴」重推）');
  assert.equal(r.reload, true, '须请求全量重载 / 标 externalDirty');
  assert.equal(r.state.lastTailKey, 't5|user|new5');
  assert.equal(r.state.baseline, cap);
});

test('catchUpStep: 满窗但 tail 未变 → 不 reload', () => {
  const cap = 5;
  const msgs = Array.from({ length: cap }, (_, i) => ({ role: 'user', content: `m${i}`, timestamp: `t${i}` }));
  const r = catchUpStep(
    { baseline: cap, wasBusy: false, lastTailKey: 't4|user|m4' },
    { messages: msgs, localBusy: false, historyCap: cap },
  );
  assert.equal(r.reload, false);
  assert.deepEqual(r.emit, []);
});

// ── rebaselineAbsorbedExternal：重连重定基线是否吸收了未观察到的外部增长（BE-009 防分叉判据）──────
test.describe('rebaselineAbsorbedExternal（BE-009）', () => {
  test('同会话重连 + 磁盘长于上次 baseline → true（有被吸收的外部增长，须标 externalDirty）', () => {
    assert.equal(rebaselineAbsorbedExternal({ sameSession: true, curLen: 5, baseline: 2 }), true);
  });
  test('同会话重连 + 磁盘 == baseline（无未观察增长）→ false', () => {
    assert.equal(rebaselineAbsorbedExternal({ sameSession: true, curLen: 2, baseline: 2 }), false);
  });
  test('同会话重连 + 磁盘 < baseline（削头等）→ false（保守不标）', () => {
    assert.equal(rebaselineAbsorbedExternal({ sameSession: true, curLen: 1, baseline: 2 }), false);
  });
  test('真会话切换（非同会话）→ false（另一段会话的历史，无分叉语义）', () => {
    assert.equal(rebaselineAbsorbedExternal({ sameSession: false, curLen: 9, baseline: 2 }), false);
  });
  test('读长度失败（curLen=-1 / 非有限）→ false（不误标）', () => {
    assert.equal(rebaselineAbsorbedExternal({ sameSession: true, curLen: -1, baseline: 2 }), false);
    assert.equal(rebaselineAbsorbedExternal({ sameSession: true, curLen: NaN, baseline: 2 }), false);
  });
  // SS-NEW-002：满窗滑动 length 不变，靠 tailKey 检出被吸收的外部增长
  test('满窗 + 同长 + tail 变 → true（须标 externalDirty）', () => {
    const cap = 4;
    assert.equal(rebaselineAbsorbedExternal({
      sameSession: true, curLen: cap, baseline: cap, historyCap: cap,
      prevTailKey: 't1|user|old', curTailKey: 't2|assistant|new',
    }), true);
  });
  test('满窗 + 同长 + tail 同 → false', () => {
    const cap = 4;
    assert.equal(rebaselineAbsorbedExternal({
      sameSession: true, curLen: cap, baseline: cap, historyCap: cap,
      prevTailKey: 't1|user|same', curTailKey: 't1|user|same',
    }), false);
  });
  test('满窗但 prevTail 未知（null）→ false（对齐 catchUpStep 不误判）', () => {
    const cap = 4;
    assert.equal(rebaselineAbsorbedExternal({
      sameSession: true, curLen: cap, baseline: cap, historyCap: cap,
      prevTailKey: null, curTailKey: 't2|user|x',
    }), false);
  });
  // 2026-07-18 修复：BE-009 重连分支原先没检查 localBusy，磁盘变长可能是己方 turn/后台任务自己写出来的，
  // 不是终端外部写入，不该标 externalDirty。与 catchUpStep/mirrorReleaseStep 的 localBusy 早退对齐同一判据。
  test('localBusy=true + 磁盘确实变长 → false（己方在跑不算外部写入，不误标 externalDirty）', () => {
    assert.equal(rebaselineAbsorbedExternal({ sameSession: true, curLen: 5, baseline: 2, localBusy: true }), false);
  });
  test('localBusy=true + 满窗 tail 变（SS-NEW-002 判据）→ 同样 false（早退要挡住两条判定支路）', () => {
    const cap = 4;
    assert.equal(rebaselineAbsorbedExternal({
      sameSession: true, curLen: cap, baseline: cap, historyCap: cap, localBusy: true,
      prevTailKey: 't1|user|old', curTailKey: 't2|assistant|new',
    }), false);
  });
  test('localBusy=false（显式传入）+ 磁盘变长 → 仍 true（老行为不受影响，回归保护）', () => {
    assert.equal(rebaselineAbsorbedExternal({ sameSession: true, curLen: 5, baseline: 2, localBusy: false }), true);
  });
});

// ── 原始同步 bug 复现（web 额度耗尽 → CLI 外部 resume+compact 写入 → web 重开看不到 CLI 新输出）────────
// 忠实复刻 server catchUpTick（server.js:737-764）的决策链：它就是「切入时 baseline = getSessionHistory().length
// 做种、后续 tick 再喂 catchUpStep」。这里用【同一个】getSessionHistory（真实读临时 transcript）+【同一个】
// catchUpStep，只在数据流层复刻，不起 socket——造真实 viewing 实例需 claude turn/token（集成测试整块默认 skip）。
// 覆盖的是 server 侧盲区；前端「有缓存/活缓冲就跳过 loadHistory」（app.js:2144/2149）那半段属浏览器行为，不在此。
test('catchUpTick 盲区复现：web 离开期间的外部写入，切回后被切入 baseline 吞掉、永不追平', async () => {
  // 时间线：T0 web 显示 N=2 条 → T1 web 离开 → T2 CLI 外部写 M=3 条（磁盘 5）→ T3 web 切回。
  const cwd = '/test/mirror-blindspot';
  const dir = join(BASE, getProjectDir(cwd));
  const sid = 'blindspot';
  writeJSONL(dir, sid, [
    { type: 'user',      message: { role: 'user',      content: 'web-旧-1' } },
    { type: 'assistant', message: { role: 'assistant', content: 'web-旧-2' } },   // web 离开时显示到这（N=2）
    { type: 'user',      message: { role: 'user',      content: 'CLI-外部-3' } }, // ↓ web 离开期间 CLI 写入的 3 条
    { type: 'assistant', message: { role: 'assistant', content: 'CLI-外部-4' } },
    { type: 'assistant', message: { role: 'assistant', content: 'CLI-外部-5' } }, // 磁盘全长 = 5
  ]);

  // T3 web 切回：复刻 catchUpTick 切入分支（server.js:744-751）——key 变 → seedLen = getSessionHistory().length
  // （此刻磁盘已含 CLI 外部写入）→ baseline = seedLen、本 tick 不推。
  const diskOnEnter = await getSessionHistory(sid, cwd, HISTORY_MAX_MESSAGES, { baseDir: BASE });
  assert.equal(diskOnEnter.length, 5, '切回时磁盘已含 web 未显示的外部写入');
  const state = { baseline: diskOnEnter.length, wasBusy: false }; // ← server.js:749 现行 seeding：磁盘全长做种

  // 后续 catchUpTick tick（server.js:754-762）：磁盘无新增 → catchUpStep 判有无超出 baseline 的新消息。
  const diskLater = await getSessionHistory(sid, cwd, HISTORY_MAX_MESSAGES, { baseDir: BASE });
  const { emit } = catchUpStep(state, { messages: diskLater, localBusy: false });

  // 坐实盲区：CLI 外部写的 3 条落在 [前端位置 2, 磁盘 5) 之间，被切入 baseline(=5) 吞掉 → 永不 emit → 前端永远看不到。
  assert.deepEqual(emit, [], 'BUG 坐实：切入 baseline=磁盘全长，外部写入的 3 条永不经 history_append 追平');

  // 对照修复靶心：若切入 baseline 以「前端实际显示位置(N=2)」做种（而非磁盘全长），同一 catchUpStep 立刻把 3 条追平。
  const fixed = catchUpStep({ baseline: 2, wasBusy: false }, { messages: diskLater, localBusy: false });
  assert.deepEqual(fixed.emit.map(m => m.content), ['CLI-外部-3', 'CLI-外部-4', 'CLI-外部-5'],
    '病灶在 server.js:746/749 的 baseline 基准——用「磁盘全长」而非「前端已显示位置」做种');
});

// ── lastPermissionMode / readLastPermissionMode ──────────────────────────────
// 续接 CLI 原生会话时恢复权限档：CLI 把切档写进 transcript 的 `type:permission-mode` 记录，
// 但 web 的 sessions.json 没记（web 端增强），故续接前从 transcript 末条恢复。

test('lastPermissionMode: 取末条 permission-mode 记录（多条时后写覆盖）', () => {
  const mode = lastPermissionMode([
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'mode', mode: 'normal' },
    { type: 'permission-mode', permissionMode: 'bypassPermissions' },
  ]);
  assert.equal(mode, 'bypassPermissions');
});

test('lastPermissionMode: 无 permission-mode 记录返回 null', () => {
  assert.equal(lastPermissionMode([{ type: 'user', message: {} }, { type: 'mode', mode: 'normal' }]), null);
});

test('lastPermissionMode: 非法档值忽略（不外泄脏值给 SDK）', () => {
  assert.equal(lastPermissionMode([{ type: 'permission-mode', permissionMode: '恶意值' }]), null);
  assert.equal(lastPermissionMode([{ type: 'permission-mode', permissionMode: 123 }]), null);
});

test('lastPermissionMode: 非法末条不回退到前面的合法条（末条为准、拿不到就 null）', () => {
  assert.equal(lastPermissionMode([
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'permission-mode', permissionMode: '脏' },
  ]), null);
});

test('readLastPermissionMode: 从真实 transcript 尾部读回 CLI 权限档', async () => {
  const cwd = '/test/perm';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-perm', [
    { type: 'user', message: { role: 'user', content: '开始' } },
    { type: 'mode', mode: 'normal' },
    { type: 'permission-mode', permissionMode: 'bypassPermissions' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } },
  ]);
  assert.equal(await readLastPermissionMode('sess-perm', cwd, { baseDir: BASE }), 'bypassPermissions');
});

test('readLastPermissionMode: 无记录 / 文件不存在返回 null', async () => {
  const cwd = '/test/perm2';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-none', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  assert.equal(await readLastPermissionMode('sess-none', cwd, { baseDir: BASE }), null);
  assert.equal(await readLastPermissionMode('missing-id', cwd, { baseDir: BASE }), null);
});

// ── lastAssistantModel / readLastAssistantModel ──────────────────────────────
// 续接会话时 chip 显示该会话真实用过的模型：resume 后首轮 init 未到前 instances.model 为 null，
// 前端只能回落 cwd 默认名（可能与会话实际模型不符）。CLI 把每条 assistant 消息的 message.model
// 落 transcript，故 resume 时冷读末条 assistant 的模型作展示回落（init.model 到达后被权威值覆盖）。

test('lastAssistantModel: 取末条 assistant 的 message.model（多条时后写覆盖）', () => {
  const model = lastAssistantModel([
    { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' }] } },
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'b' }] } },
  ]);
  assert.equal(model, 'claude-opus-4-8');
});

test('lastAssistantModel: 跳过 sidechain / isMeta / <synthetic>（错误合成条不算真实模型）', () => {
  const model = lastAssistantModel([
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [] } },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', model: 'claude-haiku-4-5', content: [] } },
    { type: 'assistant', isMeta: true, message: { role: 'assistant', model: 'claude-haiku-4-5', content: [] } },
    { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [] } },
  ]);
  assert.equal(model, 'claude-opus-4-8');
});

test('lastAssistantModel: 无 assistant 模型记录 / 脏值返回 null', () => {
  assert.equal(lastAssistantModel([{ type: 'user', message: { role: 'user', content: 'hi' } }]), null);
  assert.equal(lastAssistantModel([{ type: 'assistant', message: { role: 'assistant', content: [] } }]), null);
  assert.equal(lastAssistantModel([{ type: 'assistant', message: { role: 'assistant', model: 123, content: [] } }]), null);
  assert.equal(lastAssistantModel([]), null);
});

test('readLastAssistantModel: 从真实 transcript 尾部读回会话模型', async () => {
  const cwd = '/test/model';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-model', [
    { type: 'user', message: { role: 'user', content: '开始' } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' }] } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'b' }] } },
  ]);
  assert.equal(await readLastAssistantModel('sess-model', cwd, { baseDir: BASE }), 'claude-opus-4-8');
});

test('readLastAssistantModel: 无记录 / 文件不存在 / 非法 sessionId（SS-003）返回 null', async () => {
  const cwd = '/test/model2';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-nomodel', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  assert.equal(await readLastAssistantModel('sess-nomodel', cwd, { baseDir: BASE }), null);
  assert.equal(await readLastAssistantModel('missing-id', cwd, { baseDir: BASE }), null);
  assert.equal(await readLastAssistantModel('../x', cwd, { baseDir: BASE }), null);
});

// ── 已知架构边界（test.skip 基线，别当新 bug 反复报）─────────────────────────────
// 三者同源：web 续接 = 独立 claude --resume 进程冷读磁盘 transcript，读不到终端里活着的 CLI 进程内存态
// （见记忆 web-resume-cannot-mirror-live-cli）。permission-mode 有磁盘记录可恢复（上方已修）；下两半无。

test.skip('[边界] CLI 原生会话的 pending AskUserQuestion 不落磁盘 → web 续接看不到弹窗', () => {
  // 症结：AskUserQuestion 是终端活 CLI 进程里一个进行中的 tool 调用（卡住等用户选），只存在于该进程内存，
  // 不以「待回答」形态落 transcript；web 续接另起进程读到最后一条完成消息即停，无此待答项。且架构上答不了——
  // tool_result 必须回发起 tool_use 的同一进程。web 原生发起的问题才走 handleQuestion→emit('question')→
  // pendingQuestions 快照重建（agent.js:400）。此为硬边界、无磁盘侧修法，仅留基线防误报。
});

test.skip('[边界] CLI 不把 effort/thinking 档落 transcript → web 续接回落「默认思考」', () => {
  // permission-mode 有 transcript 记录可恢复（见上 readLastPermissionMode），但 effort/thinking 档 CLI 完全不落盘：
  // transcript 里只有 assistant 的 thinking 内容块、无「档位」字段（low/med/high/xhigh/max）。故续接纯 CLI 会话
  // 「默认思考」是诚实回退、无从恢复；只有 web 侧驱动过该会话，updateSessionPrefs 才持久化 effort。留基线防误报。
});
