// resume-anchor.js —— 预测 CLI `--resume` 会接上哪条链、最新那段对话会不会被丢出上下文。
//
// 夹具一一对应 2026-10-15/16 的零 token 实测（CLI 2.1.281 / 2.1.283 / 2.1.284 / 2.1.301，SDK 模式与交互式，
// 真 SDK 进程 + 真交互式终端），每条用例注明对应的实测场景；判据的出处见 app/src/sessions/resume-anchor.js 头注。
// 「CLI 实测结果」是这里唯一的真相源：夹具改形态之前先回去用真 CLI 重跑一遍，别让夹具和实现一起漂。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { predictResumeAnchor, resumeDivergence, readResumeEntries } from '../../app/src/sessions/resume-anchor.js';
import { getProjectDir } from '../../app/src/sessions/history.js';

let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 3, 12, 0, clock++)).toISOString();
const U = (uuid, parentUuid, entrypoint, content, extra = {}) => ({
  type: 'user', uuid, parentUuid, entrypoint, isSidechain: false, message: { role: 'user', content }, timestamp: at(), ...extra,
});
const A = (uuid, parentUuid, entrypoint, text = 'answer', extra = {}) => ({
  type: 'assistant', uuid, parentUuid, entrypoint, isSidechain: false,
  message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: at(), ...extra,
});
const S = (uuid, parentUuid, entrypoint, subtype, extra = {}) => ({
  type: 'system', subtype, uuid, parentUuid, entrypoint, isSidechain: false, isMeta: false, timestamp: at(), ...extra,
});
const LP = (leafUuid, extra = {}) => ({ type: 'last-prompt', lastPrompt: 'q', leafUuid, sessionId: 'sid', ...extra });
// 真机每轮 user 与 assistant 之间夹着 attachment 行（c78e8b47 的手机段 L2242→L2243→L2244→L2245 即是）
const AT = (uuid, parentUuid, entrypoint) => ({ type: 'attachment', uuid, parentUuid, entrypoint, isSidechain: false, attachment: { type: 'todo' }, timestamp: at() });

// 终端那一轮（T = s-2）
const terminalTurn = () => [
  U('u-1', null, 'cli', 'terminal question'),
  A('a-1', 'u-1', 'cli'),
  S('s-1', 'a-1', 'cli', 'stop_hook_summary'),
  S('s-2', 's-1', 'cli', 'turn_duration'),
];
// 真机 c78e8b47 的形态（#208 的 AWAY_SUMMARY_ENTRIES）：手机经 SDK 接着 T 往下写；闲置终端把 away_summary /
// informational 挂在它记得的旧叶子 T 下，物理上排在手机续聊之后。
const awayShape = () => [
  ...terminalTurn(),
  U('u-2', 's-2', 'sdk-ts', 'phone question'),
  S('s-3', 's-2', 'cli', 'away_summary'),
  AT('at-2', 'u-2', 'sdk-ts'),
  A('a-2', 'at-2', 'sdk-ts'),
  S('s-4', 's-3', 'cli', 'informational', { level: 'warning' }),
];

test('没有 last-prompt：锚物理最后一条消息——闲置终端挂在旧叶子下的 system 行把锚拉回终端那支（实测：away 变体，四个 CLI 版本都丢）', () => {
  const entries = awayShape();
  assert.deepEqual(predictResumeAnchor(entries), { anchorUuid: 's-4', via: 'last-message', explicit: false });
  const d = resumeDivergence(entries);
  assert.ok(d, '手机续聊那段不在 CLI 会接上的链上，必须报出来');
  assert.equal(d.newestUuid, 'a-2');
  assert.equal(d.newestEntrypoint, 'sdk-ts');
  assert.equal(d.anchorEntrypoint, 'cli', '会接上的是终端那一轮');
  assert.equal(d.droppedCount, 2, '丢的是手机那一问一答，attachment / system 行与终端那支不计');
  assert.equal(d.anchorOnlyCount, 0, '终端那支分叉之后只有 system 行：从手机末条分叉什么都不丢');
});

test('文件末尾 last-prompt 指向手机末条：锚它，手机那段在上下文里（实测：手机侧进程最后退出）', () => {
  const entries = [...awayShape(), LP('a-2')];
  assert.deepEqual(predictResumeAnchor(entries), { anchorUuid: 'a-2', via: 'last-prompt', explicit: false });
  assert.equal(resumeDivergence(entries), null);
});

test('真机 c78e8b47 的尾部：手机进程先重贴、终端后重贴 → 终端说了算，手机那段被丢（实测：终端最后退出）', () => {
  // L2262 last-prompt→手机末条（SDK 进程退出重贴）之后，L2264 last-prompt→终端 informational（终端退出重贴）
  const entries = [...awayShape(), LP('a-2'), LP('s-4')];
  assert.equal(predictResumeAnchor(entries).anchorUuid, 's-4', 'Kn 就是 In 本身 → 锚 In');
  const d = resumeDivergence(entries);
  assert.ok(d, '终端最后退出时手机那段不在链上');
  assert.equal(d.newestUuid, 'a-2');
  assert.equal(d.droppedCount, 2);
});

test('对照：没有闲置终端写的 system 行时手机那段在链上（实测：control 变体）', () => {
  const entries = [...terminalTurn(), U('u-2', 's-2', 'sdk-ts', 'phone question'), A('a-2', 'u-2', 'sdk-ts')];
  assert.equal(predictResumeAnchor(entries).anchorUuid, 'a-2');
  assert.equal(resumeDivergence(entries), null);
});

test('终端退出时若没在旧叶子下写过东西，它的重贴指向 T——T 是手机末条的祖先，无害', () => {
  const entries = [...terminalTurn(), U('u-2', 's-2', 'sdk-ts', 'phone question'), A('a-2', 'u-2', 'sdk-ts'), LP('s-2')];
  assert.deepEqual(predictResumeAnchor(entries), { anchorUuid: 'a-2', via: 'last-message', explicit: false });
  assert.equal(resumeDivergence(entries), null);
});

test('反方向：旧终端在 T 下又打了一轮（分叉），手机进程在置换时最后重贴 → 接上手机那支，终端那一轮被丢（实测：tturn-swap0）', () => {
  const entries = [
    ...terminalTurn(),
    U('u-2', 's-2', 'sdk-ts', 'phone question'), A('a-2', 'u-2', 'sdk-ts'),
    U('u-3', 's-2', 'cli', 'terminal second question'), A('a-3', 'u-3', 'cli'),
    LP('a-2'),
  ];
  assert.equal(predictResumeAnchor(entries).anchorUuid, 'a-2');
  const d = resumeDivergence(entries);
  assert.ok(d, '物理上最新的那一轮（终端的）不在会接上的链上');
  assert.equal(d.newestUuid, 'a-3');
  assert.equal(d.newestEntrypoint, 'cli');
  assert.equal(d.anchorEntrypoint, 'sdk-ts');
  assert.equal(d.droppedCount, 2);
  assert.equal(d.anchorOnlyCount, 2, '两支都有对方没有的对话：从终端末条分叉会少掉手机那一问一答，面板得照实说');
});

test('显式 last-prompt（/rewind 等用户刻意选分支时 CLI 写 explicit:true）不报；同一份文件的自动重贴照报', () => {
  // explicit 在加载器里有没有特殊待遇没有实测过（基础规则里 Kn 是 In 的祖先时锚 In），所以 predict 仍按
  // 基础规则给锚，只把「最后那次重贴是刻意的」带出来；判分叉时据它不报——自动重贴（进程退出）从不带 explicit。
  const deliberate = [...awayShape(), LP('s-4', { explicit: true, rewound: true })];
  assert.deepEqual(predictResumeAnchor(deliberate), { anchorUuid: 's-4', via: 'last-message', explicit: true });
  assert.equal(resumeDivergence(deliberate), null);
  const automatic = [...awayShape(), LP('s-4')];
  assert.equal(resumeDivergence(automatic)?.newestUuid, 'a-2', '去掉 explicit 就是某个旧进程退出时的重贴——正是要报的形态');
});

test('终端本地命令的回显不算对话：/export 三行（caveat 带 isMeta，另两行不带）挂在旧叶子下再退出，照样报手机那段（实测：真交互式终端 e2e）', () => {
  const entries = [
    ...terminalTurn(),
    U('u-2', 's-2', 'sdk-ts', 'phone question'), A('a-2', 'u-2', 'sdk-ts'),
    LP('a-2'), // 手机进程 dispose 时的重贴
    U('c-1', 's-2', 'cli', '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>', { isMeta: true }),
    U('c-2', 'c-1', 'cli', '<command-name>/export</command-name>\n            <command-message>export</command-message>\n            <command-args>t.txt</command-args>'),
    U('c-3', 'c-2', 'cli', '<local-command-stdout>Conversation exported to: t.txt</local-command-stdout>'),
    LP('c-3'), // 终端 /exit 时的重贴
  ];
  assert.equal(predictResumeAnchor(entries).anchorUuid, 'c-3');
  const d = resumeDivergence(entries);
  assert.ok(d, '命令回显不是新对话，最新的对话仍是手机那条');
  assert.equal(d.newestUuid, 'a-2');
  assert.equal(d.anchorEntrypoint, 'cli', '会接上的最近一条对话是终端的 a-1');
  assert.equal(d.anchorOnlyCount, 0, '命令回显不算对话，终端那支没有手机这边缺的内容');
});

test('sidechain 不参与选锚：物理最后一条是子 agent 的行时仍按主链算', () => {
  const entries = [
    ...terminalTurn(), U('u-2', 's-2', 'sdk-ts', 'phone question'), A('a-2', 'u-2', 'sdk-ts'),
    A('x-1', null, 'sdk-ts', 'subagent says', { isSidechain: true }),
  ];
  assert.equal(predictResumeAnchor(entries).anchorUuid, 'a-2');
  assert.equal(resumeDivergence(entries), null);
});

test('压缩边界：parentUuid 为 null、接续写在 logicalParentUuid 上——顺着它走，压缩后尚未续聊时不误报', () => {
  const entries = [
    U('u-1', null, 'cli', 'q1'), A('a-1', 'u-1', 'cli'),
    S('b-1', null, 'cli', 'compact_boundary', { logicalParentUuid: 'a-1', compactMetadata: { trigger: 'manual' } }),
    U('m-1', 'b-1', 'cli', 'This session is being continued from a previous conversation…', { isMeta: true, isCompactSummary: true }),
  ];
  assert.equal(predictResumeAnchor(entries).anchorUuid, 'm-1');
  assert.equal(resumeDivergence(entries), null, '最新的对话 a-1 经压缩边界仍在链上');
});

test('last-prompt 指向文件里不存在的 uuid：当作没有，按物理最后一条算', () => {
  const entries = [...terminalTurn(), U('u-2', 's-2', 'sdk-ts', 'q'), A('a-2', 'u-2', 'sdk-ts'), LP('00000000-0000-0000-0000-000000000000', { explicit: true })];
  assert.deepEqual(predictResumeAnchor(entries), { anchorUuid: 'a-2', via: 'last-message', explicit: false });
  assert.equal(resumeDivergence(entries), null);
});

test('空文件、只有元数据、畸形条目：不抛，判「没有可报的」', () => {
  assert.deepEqual(predictResumeAnchor([]), { anchorUuid: null, via: null, explicit: false });
  assert.equal(resumeDivergence([]), null);
  assert.equal(resumeDivergence([LP('x'), { type: 'cost-state' }]), null);
  assert.equal(resumeDivergence([null, 7, 'x', { type: 'user' }]), null);
  assert.equal(resumeDivergence(undefined), null);
});

test('父链成环（坏数据）不挂死', () => {
  const entries = [U('u-1', 'a-1', 'cli', 'q'), A('a-1', 'u-1', 'cli'), S('s-9', 's-9', 'cli', 'informational')];
  assert.doesNotThrow(() => resumeDivergence(entries));
});

// ── readResumeEntries：resume 每次都要读，按行流式读、只留判定要的字段 ──
const ROOTS = [];
test.after(() => { for (const d of ROOTS) rmSync(d, { recursive: true, force: true }); }); // ROOTS 全部来自 mkdtemp
const SID = '0c78e8b4-7ead-45e2-b6c2-32bc08f8c612';
const CWD = '/test/resume-anchor';
function writeTranscript(lines) {
  const base = mkdtempSync(join(tmpdir(), 'ccm-resume-anchor-'));
  ROOTS.push(base);
  const dir = join(base, getProjectDir(CWD));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), lines.join('\n'));
  return { base, file: join(dir, `${SID}.jsonl`) };
}

// 精简只留判定要用的字段：每种形态都写盘再读回，判定结果必须与全量解析逐字相同。
// 后两种只有 isMeta / teamName 分得出（漏了它们，最新对话会被认成那条 meta / teammate 行）。
const SCENARIOS = {
  away: () => awayShape(),
  phoneExitedLast: () => [...awayShape(), LP('a-2')],
  terminalExitedLast: () => [...awayShape(), LP('a-2'), LP('s-4')],
  forkedTerminalTurn: () => [...terminalTurn(), U('u-2', 's-2', 'sdk-ts', 'q'), A('a-2', 'u-2', 'sdk-ts'), U('u-3', 's-2', 'cli', 'q3'), A('a-3', 'u-3', 'cli'), LP('a-2')],
  explicit: () => [...awayShape(), LP('s-4', { explicit: true })],
  commandEcho: () => [...terminalTurn(), U('u-2', 's-2', 'sdk-ts', 'q'), A('a-2', 'u-2', 'sdk-ts'), U('c-1', 's-2', 'cli', '<local-command-caveat>x</local-command-caveat>', { isMeta: true }), U('c-2', 'c-1', 'cli', '<command-name>/export</command-name>'), LP('c-2')],
  sidechainLast: () => [...terminalTurn(), U('u-2', 's-2', 'sdk-ts', 'q'), A('a-2', 'u-2', 'sdk-ts'), A('x-1', null, 'sdk-ts', 'sub', { isSidechain: true })],
  compactBoundary: () => [U('u-1', null, 'cli', 'q1'), A('a-1', 'u-1', 'cli'), S('b-1', null, 'cli', 'compact_boundary', { logicalParentUuid: 'a-1' }), U('m-1', 'b-1', 'cli', 'summary', { isMeta: true })],
  metaTail: () => [...awayShape(), U('m-9', 's-4', 'cli', 'plain meta text', { isMeta: true })],
  teammateTail: () => [...awayShape(), A('t-1', 's-4', 'cli', 'teammate says', { teamName: 'crew' })],
};

test('readResumeEntries：各形态写盘再读回（夹着元数据行与写到一半的尾行），判定与全量解析逐字相同', async () => {
  const noise = [{ type: 'file-history-snapshot', messageId: 'u-2', snapshot: {} }, { type: 'queue-operation', operation: 'enqueue' }, { type: 'cost-state', totalCostUSD: 0 }];
  let reported = 0;
  for (const [name, build] of Object.entries(SCENARIOS)) {
    const full = build();
    const { base } = writeTranscript([...noise, ...full].map(e => JSON.stringify(e)).concat('{"type":"user","uuid":"half'));
    const slim = await readResumeEntries(CWD, SID, { baseDir: base });
    assert.deepEqual(predictResumeAnchor(slim), predictResumeAnchor(full), `${name}：锚点`);
    assert.deepEqual(resumeDivergence(slim), resumeDivergence(full), `${name}：分叉结论`);
    if (resumeDivergence(full)) reported++;
  }
  assert.ok(reported >= 5, '表里要有足够多「要报」的形态，否则两边都 null 的相等证明不了什么');
});

test('readResumeEntries：命令回显在精简后仍认得出（只留正文开头）', async () => {
  const echo = U('c-2', 's-2', 'cli', `<command-name>/export</command-name>${'x'.repeat(5000)}`);
  const full = [...terminalTurn(), U('u-2', 's-2', 'sdk-ts', 'phone q'), A('a-2', 'u-2', 'sdk-ts'), echo, LP('c-2')];
  const { base } = writeTranscript(full.map(e => JSON.stringify(e)));
  const slim = await readResumeEntries(CWD, SID, { baseDir: base });
  assert.equal(resumeDivergence(slim)?.newestUuid, 'a-2');
});

test('readResumeEntries：文件不存在 / 非法 id / FIFO → 空数组（调用方据此不报），不抛、不挂死', async () => {
  const { base, file } = writeTranscript([]);
  assert.deepEqual(await readResumeEntries(CWD, 'no-such-session', { baseDir: base }), []);
  assert.deepEqual(await readResumeEntries(CWD, '../escape', { baseDir: base }), []);
  rmSync(file);
  const made = spawnSync('mkfifo', [file]);
  if (made.status === 0) assert.deepEqual(await readResumeEntries(CWD, SID, { baseDir: base }), []);
});
