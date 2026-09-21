// tests/unit/history-sync.test.mjs —— 磁盘 transcript 的【尾部形态判定与外部增长追平】
// classifyTranscriptTail 从尾部条目读出「轮次完结没有」，镜像锁据此决定手机能不能写——
// 判错两个方向都伤：该锁不锁 → 两端并发写、会话分叉；该解不解 → 手机输入框永久只读。
// 覆盖：tail 的 settled/pending 六种形态（含只落 thinking、子 agent 开着 tool_use）
//       · rebaselineAbsorbedExternal（BE-009）· 等审批期间的终端写入必须标脏 · scanSubagents
// 文件里两条 test.skip 是【有意保留的已知边界基线】，不是待修 bug。
// 这份从原 history.test.mjs 拆出，同源的还有 -files、-list、-messages。
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, getSessionHistory, HISTORY_MAX_MESSAGES, catchUpStep, rebaselineAbsorbedExternal, classifyTranscriptTail, lastPermissionMode, readLastPermissionMode, lastAssistantModel, readLastAssistantModel, externalGrowthWhilePaused, scanSubagents, readSubagentFlow } from '../../app/src/sessions/history.js';

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

test('classifyTranscriptTail: 子 agent（isSidechain）开着 tool_use → pending（防主链 settled 后过早解锁）', async () => {
  const cwd = '/test/tail-sidechain';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'tside', [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '主链答完' }] }, timestamp: '2026-07-12T10:00:00.000Z' },
    { type: 'user', isSidechain: true, message: { role: 'user', content: '子 agent 内部消息' }, timestamp: '2026-07-12T10:00:05.000Z' },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Read', input: {} }] }, timestamp: '2026-07-12T10:00:06.000Z' },
  ]);
  const r = await classifyTranscriptTail('tside', cwd, { baseDir: BASE });
  // 主链已 settled，但 sidechain 仍有未收口 tool_use → 须 pending，避免 12.5s 镜像误解锁
  assert.equal(r.verdict, 'pending');
  assert.equal(r.lastChainTs, Date.parse('2026-07-12T10:00:06.000Z'));
});

test('classifyTranscriptTail: 子 agent 已纯文本收尾 + 主链 settled → settled（sidechain 不永久锁死）', async () => {
  const cwd = '/test/tail-sidechain-done';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'tsidedone', [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '主链答完' }] }, timestamp: '2026-07-12T10:00:00.000Z' },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Read', input: {} }] }, timestamp: '2026-07-12T10:00:05.000Z' },
    { type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'ok' }] }, timestamp: '2026-07-12T10:00:06.000Z' },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '子 agent 收工' }] }, timestamp: '2026-07-12T10:00:07.000Z' },
  ]);
  const r = await classifyTranscriptTail('tsidedone', cwd, { baseDir: BASE });
  assert.equal(r.verdict, 'settled');
});

test('classifyTranscriptTail: 文件不存在 / 无任何链条目 → settled（不锁），lastChainTs=null', async () => {
  const cwd = '/test/tail-empty';
  const dir = join(BASE, getProjectDir(cwd));
  assert.deepEqual(await classifyTranscriptTail('nonexistent', cwd, { baseDir: BASE }), { verdict: 'settled', lastChainTs: null, lastChainEntrypoint: null, autonomous: false });
  writeJSONL(dir, 'tmetaonly', [{ type: 'entrypoint-marker' }, { type: 'queue-operation' }]);
  assert.deepEqual(await classifyTranscriptTail('tmetaonly', cwd, { baseDir: BASE }), { verdict: 'settled', lastChainTs: null, lastChainEntrypoint: null, autonomous: false });
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

// 7/24 真机复现：ScheduleWakeup <<autonomous-loop-dynamic>> / CronCreate <<autonomous-loop>> 定时唤起本会话时，
// harness 在主链插一条 isMeta:true、文本以 "# Autonomous loop check" 开头的系统行，随后自己继续跑。
// 尾部形态与「终端接管」在磁盘上完全同构（都是 tool_use 未落 tool_result），但驱动方其实是本会话自己被
// 定时唤起——autonomous 字段把这种"可确定来源"的情形与"真不知道是谁"的情形分开，供上层选择不同文案。
test('classifyTranscriptTail: 尾窗内有自主循环 marker + 仍 pending → autonomous:true', async () => {
  const cwd = '/test/tail-autonomous';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'tauto', [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '之前一轮已收尾' }] }, timestamp: '2026-07-24T14:17:05.000Z' },
    { type: 'queue-operation' },
    { type: 'user', isMeta: true, message: { role: 'user', content: '# Autonomous loop check\n\nYou are being invoked on a timer while the user is away or occupied.' }, timestamp: '2026-07-24T14:17:06.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '继续干活' }] }, timestamp: '2026-07-24T14:18:27.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, timestamp: '2026-07-24T14:18:28.000Z' },
  ]);
  const r = await classifyTranscriptTail('tauto', cwd, { baseDir: BASE });
  assert.equal(r.verdict, 'pending');
  assert.equal(r.autonomous, true, '尾窗内有 harness 自主循环 marker → 标记为自主驱动，而非未知来源');
});

test('classifyTranscriptTail: 无自主循环 marker 的 pending → autonomous:false（既有"未知驱动/大概率终端"判定不变）', async () => {
  const cwd = '/test/tail-tooluse';
  const r = await classifyTranscriptTail('ttooluse', cwd, { baseDir: BASE }); // 复用上面「assistant 发起 tool_use」场景已写好的文件
  assert.equal(r.verdict, 'pending');
  assert.equal(r.autonomous, false);
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

// ── 己方写盘不得被判成终端写入（2026-09-21 真机）──────────────────────────────
// 现象：手机上秒回的短轮次结束后，同一问一答被渲染两遍，底部弹出「只读镜像：终端会话运行中」。
// transcript 里那条消息【只有一条】，终端全程没参与（主链全是 sdk-ts）。
//
// 成因是判据错了轴：己方写盘本来有两道防线——localBusy 时抑制追平、wasBusy 时整段吸收，
// 两道都依赖「tick 至少撞见一次 busy」。而 catchUpTick 常态 2.5s 一跳，实测那轮从发出到收尾
// 只有 2s（截图上写着 Worked for 1s），整轮落在两次 tick 之间，busy 一次都没被观察到。
// 于是下一 tick 只看到「磁盘比 baseline 长了」，判为外部写入：既把己方刚写的推回前端（重复气泡），
// 又喂给 mirrorReleaseStep 的 externalWrite —— 那里第一行就是无条件上锁。
//
// 「磁盘变长」回答不了「是谁写的」。transcript 每条自带 entrypoint（sdk-ts=己方 / cli=终端），
// 那是磁盘自报的事实、不依赖任何时序，判据改用它。白名单只认 sdk-ts，与 isOwnSdkTail 同一口径：
// 取值不认识就保守当外部写入 —— 误锁用户点「续接」能化解，漏锁造成的两端并发写分叉不可逆。
const OWN = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, entrypoint: 'sdk-ts' }));

test('catchUpStep: 增量全是己方 SDK 写的 → 吸收，不推气泡也不算外部写入', () => {
  const r = catchUpStep({ baseline: 2, wasBusy: false }, { messages: OWN(5), localBusy: false });
  assert.deepEqual(r.emit, [], '推回去就是重复气泡：live 流已经渲染过这几条了');
  assert.equal(r.reload, false);
  assert.equal(r.state.baseline, 5, 'baseline 必须推进，否则下一 tick 还会重判一次');
});

test('catchUpStep: 增量里有终端写的 → 照常推，锁照常上', () => {
  const messages = [...OWN(2), { role: 'user', content: '终端里说的', entrypoint: 'cli' }];
  const r = catchUpStep({ baseline: 2, wasBusy: false }, { messages, localBusy: false });
  assert.deepEqual(r.emit.map(m => m.content), ['终端里说的']);
});

test('catchUpStep: 增量缺 entrypoint（老 transcript）→ 保守当外部写入，不得静默吞掉', () => {
  // 白名单口径：不认识的来源一律回落既有行为。漏推历史是静默的，多推一条是看得见的。
  const r = catchUpStep({ baseline: 2, wasBusy: false }, { messages: M(4), localBusy: false });
  assert.deepEqual(r.emit.map(m => m.content), ['m2', 'm3']);
});

test('catchUpStep: 己方增量里混进一条终端写的 → 整段按外部处理', () => {
  // 两端交错写同一会话时必须上锁，这正是单驾驶员模型要防的；按「多数是己方」放行会漏掉它。
  const messages = [...OWN(2), { role: 'user', content: '终端插了一条', entrypoint: 'cli' }, { role: 'assistant', content: '己方续写', entrypoint: 'sdk-ts' }];
  const r = catchUpStep({ baseline: 2, wasBusy: false }, { messages, localBusy: false });
  assert.equal(r.emit.length, 2, '混合增量不拆分：只要有一条是终端写的，整段都按外部走');
});

// ── rewind 的前缀重写（PR #98 review，2026-09-19）────────────────────────────
// 上面那条收缩判据只罩住「撤销后没补回来」。真实用法里用户 rewind 完往往立刻接着聊，
// 于是长度可能回到原值、甚至超过原值，而【已经推给前端的那一段】早被换掉了：
//   · 等长：撤销 3 条又补 3 条 → len === baseline，落进兜底分支，手机停在废弃气泡上；
//   · 变长：撤销 3 条又补 5 条 → 走增长分支 emit slice(baseline)，只推新增的 2 条，
//     前面被替换的 3 条再也没有机会更新。
// 判据不能只看长度。rewind 的变更模式是「截断到点 P 再续写」，所以盯 messages[baseline-1]
// 这一条就够：撤销点在 baseline 之前 → 它必然被换掉；在之后 → 前端已显示的那段本就没变。
const withTail = (n, tailContent) => { const m = M(n); m[n - 1] = { role: 'assistant', content: tailContent }; return m; };

test('catchUpStep: rewind 等长替换（撤销 N 条又补 N 条）→ reload，不能停在废弃气泡上', () => {
  const seed = catchUpStep({ baseline: 0, wasBusy: false }, { messages: M(6), localBusy: false });
  assert.equal(seed.state.baseline, 6);
  // 长度回到 6，但末条内容已换成新分支的
  const r = catchUpStep(seed.state, { messages: withTail(6, '新分支的回答'), localBusy: false });
  assert.equal(r.reload, true, '等长但内容已被重写，必须全量重推');
  assert.deepEqual(r.emit, []);
  assert.equal(r.state.baseline, 6);
});

test('catchUpStep: rewind 后补得更多（撤销 N 条补 N+2 条）→ reload，不能只 slice 尾巴', () => {
  const seed = catchUpStep({ baseline: 0, wasBusy: false }, { messages: M(6), localBusy: false });
  // 长度涨到 8，但第 6 条（baseline-1 那条）已被新分支替换
  const grown = M(8); grown[5] = { role: 'assistant', content: '新分支替换掉的那条' };
  const r = catchUpStep(seed.state, { messages: grown, localBusy: false });
  assert.equal(r.reload, true, '前缀被重写时只 slice 尾巴会让被替换的那几条永远留在手机上');
  assert.deepEqual(r.emit, [], 'reload 与 emit 二选一');
  assert.equal(r.state.baseline, 8);
});

test('catchUpStep: 纯追加（前缀原样不动）→ 照常增量推，不得误触发 reload', () => {
  const seed = catchUpStep({ baseline: 0, wasBusy: false }, { messages: M(6), localBusy: false });
  const r = catchUpStep(seed.state, { messages: M(9), localBusy: false });
  assert.equal(r.reload, false, '正常追加必须走增量，否则每次终端写盘都全量重推');
  assert.deepEqual(r.emit.map(m => m.content), ['m6', 'm7', 'm8']);
  assert.equal(r.state.baseline, 9);
});

// CLI /rewind 之后有效历史会【变短】。旧实现只认「变长」，收缩落进最后那条兜底分支：不推、
// baseline 原地不动 —— 正开着这个会话的手机端于是永远停在 rewind 前的样子，切走再切回也一样
// （重进走的是另一条路，但只要停着不动就再没有任何信号）。收缩必须当成一次外部重写：全量重推
// + 标脏，走的是与滑窗同一条 reload 通道（mirror-engine 收到 reload 就 history_append replace）。
test('catchUpStep: 有效历史收缩（CLI rewind）→ reload 全量重推、baseline 跟着缩', () => {
  const r = catchUpStep({ baseline: 9, wasBusy: false }, { messages: M(4), localBusy: false });
  assert.equal(r.reload, true, '收缩必须触发全量重推，否则手机端停在 rewind 前');
  assert.deepEqual(r.emit, [], 'reload 路径不 slice：emit 与 reload 二选一');
  assert.equal(r.state.baseline, 4);
  assert.equal(r.state.wasBusy, false);
});

// 护栏：getSessionHistory 读盘失败返回 []，那不是收缩。按收缩处理会 reload 一个空数组，
// 前端 replace:true 收到后直接清屏 —— 一次瞬时读失败就把整屏历史擦了。
test('catchUpStep: 历史读成空数组不算收缩（读盘失败不得清屏）', () => {
  const r = catchUpStep({ baseline: 9, wasBusy: false }, { messages: [], localBusy: false });
  assert.equal(r.reload, false);
  assert.deepEqual(r.emit, []);
  assert.equal(r.state.baseline, 9, '基线必须原地不动，等下一 tick 重读');
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

// 【2026-09-18 替换】这里原有一条「削头边界（len < baseline）→ 保守不推」。它描述的场景不成立：
// getSessionHistory 返回 slice(-2000)、内部也封顶 2000，而 baseline 取自上一次的 len，同样 ≤ 2000
// ——削头推不出 len < baseline（滑窗的真实形态是 len 恒等于 cap，由 SS-001 那条靠 tailKey 覆盖）。
// 它实际固化的是兜底分支「收缩就不推」，而那正是 CLI rewind 后手机端停在旧样子的原因。
// 该分支的两个真实方向改由上面两条覆盖：len>0 收缩 → reload；len===0 读盘失败 → 不动。

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
  // 【2026-09-18 反转】原为「磁盘 < baseline（削头等）→ false（保守不标）」。收缩不是削头（削头后
  // len 恒等于 cap），而是 CLI /rewind 撤销了一段。这时【更要】标脏：SDK 子进程的内存上下文还停在
  // rewind 前的叶子上，不置换实例就发消息 = 从一条已被撤销的链上继续写，正是 BE-009 要防的分叉。
  test('同会话重连 + 磁盘短于 baseline（CLI rewind 撤销了一段）→ true（必须标脏，否则从废弃叶子分叉）', () => {
    assert.equal(rebaselineAbsorbedExternal({ sameSession: true, curLen: 1, baseline: 2 }), true);
  });
  // rewind 撤销 N 条又补上 N 条时长度回到原值，而链已经换了一条。原判据把「指纹变了」这条
  // 门控在 atCap（满窗滑动）里，于是普通会话等长重写一律不标脏 —— SDK 子进程继续停在废弃叶子上，
  // 下一条手机消息就从那里分叉，正是 BE-009 要防的东西。（PR #98 review 指出）
  test('同会话重连 + 等长但尾部指纹已变（rewind 等长替换）→ true（非满窗也要标脏）', () => {
    assert.equal(rebaselineAbsorbedExternal({
      sameSession: true, curLen: 5, baseline: 5, prevTailKey: 'old-tail', curTailKey: 'new-tail',
    }), true);
  });
  // 反向护栏：稳态下每次重连都标脏会平白触发 dispose+resume 冷启动。
  test('同会话重连 + 等长且指纹未变 → false（稳态不得误标）', () => {
    assert.equal(rebaselineAbsorbedExternal({
      sameSession: true, curLen: 5, baseline: 5, prevTailKey: 'same-tail', curTailKey: 'same-tail',
    }), false);
  });
  // 护栏：0 与 -1 都不是收缩，是读长度失败的回落值。误判成收缩会在每次读盘抖动时平白置换实例
  // （dispose+resume 冷启动），比漏标更吵。
  test('同会话重连 + curLen 为 0 → false（读盘失败不得当成 rewind 收缩）', () => {
    assert.equal(rebaselineAbsorbedExternal({ sameSession: true, curLen: 0, baseline: 2 }), false);
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
  // 2026-08-10：localBusy 只罩住「重连当下仍在跑」，罩不住「刚跑完」。己方 turn 期间 catchUpTick 走
  // localBusy 分支【冻结 baseline】，baseline 要等下一个 tick 的吸收才推进；而 turn 一结束 state 即 idle。
  // 重连落进 turn 结束前后各约一个 tick 周期的窗口（rebaseline flag 由【下一个】tick 消费，故连接发生在
  // turn 结束【之前】同样会命中），rebaseline 就拿【冻结的旧 baseline】比【含己方刚写那一轮的磁盘长度】，
  // 判成外部增长标 externalDirty——「发消息→锁屏→解锁看结果」正是移动端最典型的模式。实证会话 39da384a：
  // 主链全部 sdk-ts、零真实 cli 写入（唯一 cli 条目是自家 entrypoint-marker 假行），全程 web 驱动却反复
  // 弹「正在续接会话（吸收终端写入）…」。修法=补 wasOwnTurn 维度，与 catchUpStep 的吸收窗口同源。
  test('wasOwnTurn=true（己方 turn 上一 tick 还在写盘）+ 现已 idle + 磁盘变长 → false（己方刚写完，不是终端写入）', () => {
    assert.equal(rebaselineAbsorbedExternal({
      sameSession: true, curLen: 130, baseline: 100, localBusy: false, wasOwnTurn: true,
    }), false);
  });
  test('wasOwnTurn=true + 满窗 tail 变（SS-NEW-002 判据）→ 同样 false（早退要挡住两条判定支路）', () => {
    const cap = 4;
    assert.equal(rebaselineAbsorbedExternal({
      sameSession: true, curLen: cap, baseline: cap, historyCap: cap, localBusy: false, wasOwnTurn: true,
      prevTailKey: 't1|user|old', curTailKey: 't2|assistant|new',
    }), false);
  });
  test('wasOwnTurn=false + 磁盘变长 → true（终端真写入这条主路不受影响，防修过头）', () => {
    assert.equal(rebaselineAbsorbedExternal({
      sameSession: true, curLen: 130, baseline: 100, localBusy: false, wasOwnTurn: false,
    }), true);
  });
  // 等审批(permission)不等于己方在写盘：那段增长可能真来自终端，豁免它会漏标致 transcript 分叉。
  // 调用方据此只在 st==='busy' 时传 wasOwnTurn:true（mirror-engine 的 seed 与 localBusy 两个写入点）。
  test('wasOwnTurn=false 但上一 tick 是等审批 + 磁盘变长 → true（审批窗里的终端写入不得被吞）', () => {
    assert.equal(rebaselineAbsorbedExternal({
      sameSession: true, curLen: 130, baseline: 100, localBusy: false, wasOwnTurn: false,
    }), true);
  });
});

// ── 原始同步 bug 复现（web 额度耗尽 → CLI 外部 resume+compact 写入 → web 重开看不到 CLI 新输出）────────
// 忠实复刻 server catchUpTick（app/server.js:737-764）的决策链：它就是「切入时 baseline = getSessionHistory().length
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

  // T3 web 切回：复刻 catchUpTick 切入分支（app/server.js:744-751）——key 变 → seedLen = getSessionHistory().length
  // （此刻磁盘已含 CLI 外部写入）→ baseline = seedLen、本 tick 不推。
  const diskOnEnter = await getSessionHistory(sid, cwd, HISTORY_MAX_MESSAGES, { baseDir: BASE });
  assert.equal(diskOnEnter.length, 5, '切回时磁盘已含 web 未显示的外部写入');
  const state = { baseline: diskOnEnter.length, wasBusy: false }; // ← app/server.js:749 现行 seeding：磁盘全长做种

  // 后续 catchUpTick tick（app/server.js:754-762）：磁盘无新增 → catchUpStep 判有无超出 baseline 的新消息。
  const diskLater = await getSessionHistory(sid, cwd, HISTORY_MAX_MESSAGES, { baseDir: BASE });
  const { emit } = catchUpStep(state, { messages: diskLater, localBusy: false });

  // 坐实盲区：CLI 外部写的 3 条落在 [前端位置 2, 磁盘 5) 之间，被切入 baseline(=5) 吞掉 → 永不 emit → 前端永远看不到。
  assert.deepEqual(emit, [], 'BUG 坐实：切入 baseline=磁盘全长，外部写入的 3 条永不经 history_append 追平');

  // 对照修复靶心：若切入 baseline 以「前端实际显示位置(N=2)」做种（而非磁盘全长），同一 catchUpStep 立刻把 3 条追平。
  const fixed = catchUpStep({ baseline: 2, wasBusy: false }, { messages: diskLater, localBusy: false });
  assert.deepEqual(fixed.emit.map(m => m.content), ['CLI-外部-3', 'CLI-外部-4', 'CLI-外部-5'],
    '病灶在 app/server.js:746/749 的 baseline 基准——用「磁盘全长」而非「前端已显示位置」做种');
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

test.describe('externalGrowthWhilePaused：等审批期间的终端写入必须被标脏', () => {
  test('permission 态 + 磁盘变长 → 判为外部写入', () => {
    assert.equal(externalGrowthWhilePaused({ state: 'permission', prevSize: 100, curSize: 240 }), true);
  });
  test('permission 态但磁盘没变 → 不标', () => {
    assert.equal(externalGrowthWhilePaused({ state: 'permission', prevSize: 240, curSize: 240 }), false);
  });
  test('busy 态不适用：己方 turn 也在写盘，size 增长不能归给终端', () => {
    assert.equal(externalGrowthWhilePaused({ state: 'busy', prevSize: 100, curSize: 240 }), false);
  });
  test('基线未建立（-1）或读取失败 → 保守不标', () => {
    assert.equal(externalGrowthWhilePaused({ state: 'permission', prevSize: -1, curSize: 240 }), false);
    assert.equal(externalGrowthWhilePaused({ state: 'permission', prevSize: 100, curSize: -1 }), false);
  });
  test('缺参不抛', () => {
    assert.doesNotThrow(() => externalGrowthWhilePaused());
    assert.equal(externalGrowthWhilePaused(), false);
  });
});

// ---- scanSubagents：本地 slash 命令期间「命令跑到哪了」的唯一可观测来源 ----
// 主链 transcript 零条目、SDK 流零消息（2026-08-05 探针实测 stream_event = 0），执行过程只落在
// <sessionId>/subagents/ 下。真机实测 xhigh 档 762KB 单文件 6ms、max 档 11 文件 27ms。
test.describe('scanSubagents', () => {
  function writeSubagent(cwd, sid, agentId, { meta, entries }) {
    const dir = join(BASE, getProjectDir(cwd), sid, 'subagents');
    mkdirSync(dir, { recursive: true });
    if (meta !== undefined) writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
    writeFileSync(join(dir, `agent-${agentId}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  }

  test('读出身份与最近动作：agentType/description/lastToolName', async () => {
    const cwd = '/test/subagents-basic';
    writeSubagent(cwd, 'sa-basic', 'a00b4eae6', {
      meta: { agentType: 'general-purpose', description: 'Angle A: line-by-line diff scan' },
      entries: [
        { type: 'user', isSidechain: true, message: { role: 'user', content: 'Review target: ...' } },
        { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
        { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Grep', input: {} }] } },
      ],
    });
    const r = await scanSubagents('sa-basic', cwd, { baseDir: BASE });
    assert.equal(r.length, 1);
    assert.equal(r[0].agentId, 'a00b4eae6');
    assert.equal(r[0].agentType, 'general-purpose');
    assert.equal(r[0].description, 'Angle A: line-by-line diff scan');
    assert.equal(r[0].lastToolName, 'Grep', '取最后一条 tool_use，不是第一条');
  });

  test('同一条 assistant 含多个 tool_use → 取最后一个', async () => {
    const cwd = '/test/subagents-multi';
    writeSubagent(cwd, 'sa-multi', 'amulti', {
      meta: { agentType: 'general-purpose' },
      entries: [{ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [
        { type: 'text', text: '并行跑三个' },
        { type: 'tool_use', name: 'Read', input: {} },
        { type: 'tool_use', name: 'Bash', input: {} },
      ] } }],
    });
    const r = await scanSubagents('sa-multi', cwd, { baseDir: BASE });
    assert.equal(r[0].lastToolName, 'Bash');
  });

  test('多个子代理 → 按最近活动排序（正在动的排前面）', async () => {
    const cwd = '/test/subagents-order';
    for (const id of ['aold', 'anew']) {
      writeSubagent(cwd, 'sa-order', id, {
        meta: { agentType: 'general-purpose', description: `desc-${id}` },
        entries: [{ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } }],
      });
    }
    // 把 aold 的 mtime 拨旧
    const f = join(BASE, getProjectDir(cwd), 'sa-order', 'subagents', 'agent-aold.jsonl');
    const old = new Date(Date.now() - 60_000);
    utimesSync(f, old, old);
    const r = await scanSubagents('sa-order', cwd, { baseDir: BASE });
    assert.equal(r.length, 2);
    assert.equal(r[0].agentId, 'anew', '最近活动的排前面');
  });

  test('meta.json 缺失 → 仍报出该子代理（不整条丢弃）', async () => {
    const cwd = '/test/subagents-nometa';
    writeSubagent(cwd, 'sa-nometa', 'anometa', {
      meta: undefined,
      entries: [{ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }],
    });
    const r = await scanSubagents('sa-nometa', cwd, { baseDir: BASE });
    assert.equal(r.length, 1);
    assert.equal(r[0].agentType, null);
    assert.equal(r[0].lastToolName, 'Bash', 'meta 缺失不影响 jsonl 解析');
  });

  test('半行/损坏 JSON 跳过，不整条失败（写入中的文件是常态）', async () => {
    const cwd = '/test/subagents-partial';
    const dir = join(BASE, getProjectDir(cwd), 'sa-partial', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-apart.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));
    writeFileSync(join(dir, 'agent-apart.jsonl'),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } })
      + '\n{"type":"assistant","message":{"role":"assist');  // 写到一半的尾行
    const r = await scanSubagents('sa-partial', cwd, { baseDir: BASE });
    assert.equal(r[0].lastToolName, 'Read', '半行跳过，已解析的仍生效');
  });

  test('无 subagents 目录（绝大多数普通轮次）→ 空数组，不是错误', async () => {
    const r = await scanSubagents('sa-absent', '/test/subagents-none', { baseDir: BASE });
    assert.deepEqual(r, []);
  });

  // 穿越目标必须【真实存在且有内容】，否则「不存在 → []」会让断言恒真、守卫删掉也全绿（实测空过）。
  // 靶子放在另一个 project 目录下：从 A 目录用 '../<projB>/victim' 正好落到 B 的真实子代理目录。
  test('非法 sessionId 不落盘读（路径穿越同 SS-003 口径）', async () => {
    const from = '/test/escape-from';
    const to = '/test/escape-to';
    const projTo = getProjectDir(to);
    const target = join(BASE, projTo, 'victim', 'subagents');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'agent-aleak.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));
    writeFileSync(join(target, 'agent-aleak.jsonl'),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }));
    // 自证靶子确实可读（否则下面的穿越断言又成恒真）
    const legit = await scanSubagents('victim', to, { baseDir: BASE });
    assert.equal(legit[0]?.agentId, 'aleak', '前提：靶目录本身可被合法读到，穿越断言才有意义');

    // 同一份数据，换成从 from 目录穿越过去——守卫必须挡住
    assert.deepEqual(await scanSubagents(`../${projTo}/victim`, from, { baseDir: BASE }), [], '守卫须挡住跨 project 目录穿越');
    assert.deepEqual(await scanSubagents('../../../etc', '/test/x', { baseDir: BASE }), []);
    assert.deepEqual(await scanSubagents('', '/test/x', { baseDir: BASE }), []);
  });

  test('只认 agent-<id>.jsonl：meta.json 与异物不被当成子代理', async () => {
    const cwd = '/test/subagents-filter';
    const dir = join(BASE, getProjectDir(cwd), 'sa-filter', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-areal.jsonl'), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }));
    writeFileSync(join(dir, 'agent-areal.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));
    writeFileSync(join(dir, 'README.txt'), 'noise');
    writeFileSync(join(dir, 'agent-bad.jsonl.tmp'), 'noise');
    const r = await scanSubagents('sa-filter', cwd, { baseDir: BASE });
    assert.equal(r.length, 1);
    assert.equal(r[0].agentId, 'areal');
  });
});

// ---- readSubagentFlow：历史回放时把子代理干过什么读回来（第 3 批 3a）----
// 【为什么必须单独读】主 transcript 里【没有】子代理的执行内容——2026-09-10 全库实证：
// isSidechain:true 只出现在 subagents/agent-*.jsonl 内，主链只有那次 tool_use 与最终 tool_result。
// 于是刷新后，前端从主链 spawn 工具预建的那张子代理卡是【空壳】：卡在、body 空。
// 【为什么按需读而不随历史一起推】实测本机 179 个 agent 文件：中位 360KB、最大 1.2MB、总 69MB。
// 随 session:history 一起推等于把整轮历史放大一个数量级。故按 toolUseId 单个拉、行数封顶。
test.describe('readSubagentFlow', () => {
  function writeFlowAgent(cwd, sid, agentId, { meta, entries }) {
    const dir = join(BASE, getProjectDir(cwd), sid, 'subagents');
    mkdirSync(dir, { recursive: true });
    if (meta !== undefined) writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
    writeFileSync(join(dir, `agent-${agentId}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  }

  test('按 meta.toolUseId 定位 agent，展开成与主历史同构的条目', async () => {
    const cwd = '/test/saflow-basic';
    writeFlowAgent(cwd, 'saf-basic', 'aflow1', {
      meta: { agentType: 'code-reviewer', description: 'Review auth module', toolUseId: 'toolu_parent_1', spawnDepth: 1 },
      entries: [
        { type: 'assistant', isSidechain: true, timestamp: '2026-09-10T01:00:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: '开始审查' }] } },
        { type: 'assistant', isSidechain: true, timestamp: '2026-09-10T01:00:05.000Z',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } }] } },
        { type: 'user', isSidechain: true, timestamp: '2026-09-10T01:00:06.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export function login() {}' }] } },
      ],
    });
    const r = await readSubagentFlow('saf-basic', cwd, 'toolu_parent_1', { baseDir: BASE });
    assert.equal(r.ok, true);
    assert.equal(r.agentType, 'code-reviewer');
    assert.equal(r.description, 'Review auth module');
    // 形状与主历史 expandHistoryEntry 逐项同构，前端才能复用同一套渲染（否则又是两套平行实现）。
    // 注意 text 条目按该契约【不带 kind】（只有 thinking/tool_use/tool_result 带），
    // 断成 kind==='text' 会红——这一条就是照着猜的形状写、被实现打回来的。
    assert.equal(r.items[0].kind, undefined, 'text 走 {role,content,timestamp} 形态，无 kind');
    assert.equal(r.items[0].content, '开始审查');
    assert.equal(r.items[1].kind, 'tool_use');
    assert.equal(r.items[1].name, 'Read');
    assert.equal(r.items[1].toolUseId, 't1');
    assert.equal(r.items[2].kind, 'tool_result');
    // 每条都归属这张卡：前端据此把它们塞进对应的 .sa-body，不会漏到主流去
    assert.equal(r.items.every(i => i.parentToolUseId === 'toolu_parent_1'), true);
  });

  test('toolUseId 对不上任何 agent → ok:false，不抛也不返回别人的流水', async () => {
    const cwd = '/test/saflow-miss';
    writeFlowAgent(cwd, 'saf-miss', 'aflow2', {
      meta: { agentType: 'general-purpose', toolUseId: 'toolu_other' },
      entries: [{ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '别人的' }] } }],
    });
    const r = await readSubagentFlow('saf-miss', cwd, 'toolu_parent_1', { baseDir: BASE });
    assert.equal(r.ok, false);
    assert.equal(r.items, undefined, '不得回落成「随便给一个 agent」——那会把别的子代理内容显示在这张卡上');
  });

  test('超上限 → 保留【尾部】并标 truncated（同 getSessionHistory 的 pushCapped 口径）', async () => {
    const cwd = '/test/saflow-cap';
    const entries = [];
    for (let i = 0; i < 30; i++) {
      entries.push({ type: 'assistant', isSidechain: true, timestamp: '2026-09-10T01:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: `第 ${i} 条` }] } });
    }
    writeFlowAgent(cwd, 'saf-cap', 'aflow3', { meta: { agentType: 'x', toolUseId: 'toolu_cap' }, entries });
    const r = await readSubagentFlow('saf-cap', cwd, 'toolu_cap', { baseDir: BASE, limit: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 5);
    assert.equal(r.truncated, true);
    assert.equal(r.total, 30, '省了多少要说得出来，否则用户不知道自己在看一个截断视图');
    assert.equal(r.items.at(-1).content, '第 29 条', '保尾部：子代理的结论在末尾，砍尾等于砍掉答案');
  });

  test('无 subagents 目录 → ok:false，不抛（绝大多数普通轮次都没有）', async () => {
    const r = await readSubagentFlow('saf-none', '/test/saflow-none', 'toolu_x', { baseDir: BASE });
    assert.equal(r.ok, false);
  });

  // 穿越靶子必须真实存在且可被合法读到，否则「不存在 → ok:false」会让断言恒真、守卫删掉也全绿。
  test('非法 sessionId 不落盘读（路径穿越同 SS-003 口径）', async () => {
    const from = '/test/saflow-escape-from';
    const to = '/test/saflow-escape-to';
    const projTo = getProjectDir(to);
    const dir = join(BASE, projTo, 'safvictim', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-aleak2.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_leak' }));
    writeFileSync(join(dir, 'agent-aleak2.jsonl'),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '机密' }] } }) + '\n');
    const legit = await readSubagentFlow('safvictim', to, 'toolu_leak', { baseDir: BASE });
    assert.equal(legit.ok, true, '前提：靶目录本身可被合法读到，穿越断言才有意义');
    const escaped = await readSubagentFlow(`../${projTo}/safvictim`, from, 'toolu_leak', { baseDir: BASE });
    assert.equal(escaped.ok, false, '非法 sessionId 必须在拼路径之前就被挡下');
  });
});
