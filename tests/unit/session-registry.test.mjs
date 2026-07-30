import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readSessionRegistry,
  registryIndicatesTerminalBusy,
  listTerminalSessionStates,
  applyTerminalStatesToSessions,
  hasBusyTerminalSessionForCwd,
  terminalStateKey,
  cliPresenceStep,
  findBlockingLiveAgent,
} from '../../src/sessions/session-registry.js';

const CWD = '/Users/you/code/demo';
const SID = '11111111-2222-3333-4444-555555555555';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ccm-sreg-'));
}

function writeEntry(dir, pid, extra = {}) {
  const entry = {
    pid,
    sessionId: SID,
    cwd: CWD,
    startedAt: 1_785_000_000_000,
    version: '2.1.220',
    kind: 'interactive',
    entrypoint: 'cli',
    ...extra,
  };
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify(entry));
  return entry;
}

test('readSessionRegistry：命中 sessionId+cwd 且 pid 活 → 返回规范化条目', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 15295, { status: 'busy', statusUpdatedAt: 1_785_000_100_000 });
    const got = await readSessionRegistry(SID, CWD, { dir, isAlive: () => true });
    assert.deepEqual(got, {
      pid: 15295,
      entrypoint: 'cli',
      kind: 'interactive',
      status: 'busy',
      statusUpdatedAt: 1_785_000_100_000,
      version: '2.1.220',
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSessionRegistry：pid 已死（崩溃陈尸文件）→ null', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 40404, { status: 'busy', statusUpdatedAt: 1_785_000_100_000 });
    const got = await readSessionRegistry(SID, CWD, { dir, isAlive: () => false });
    assert.equal(got, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSessionRegistry：cwd 不匹配 → null；sessionId 不匹配 → null', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 100, { status: 'busy' });
    assert.equal(await readSessionRegistry(SID, '/Users/you/other', { dir, isAlive: () => true }), null);
    assert.equal(await readSessionRegistry('99999999-0000-0000-0000-000000000000', CWD, { dir, isAlive: () => true }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSessionRegistry：损坏 JSON/字段缺失/symlink/非 json 文件被跳过，有效条目仍命中', async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, '7.json'), '{broken');
    writeFileSync(join(dir, '8.json'), JSON.stringify({ pid: 8 })); // 缺 sessionId/cwd
    writeFileSync(join(dir, 'note.txt'), 'not json');
    const real = join(dir, 'real-target.json');
    writeFileSync(real, JSON.stringify({ pid: 9, sessionId: SID, cwd: CWD, entrypoint: 'cli' }));
    symlinkSync(real, join(dir, '9.json'));
    writeEntry(dir, 200, { status: 'busy', statusUpdatedAt: 5 });
    const got = await readSessionRegistry(SID, CWD, { dir, isAlive: () => true });
    assert.equal(got?.pid, 200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSessionRegistry：目录不存在 → null（fail-open，不抛）', async () => {
  const got = await readSessionRegistry(SID, CWD, { dir: join(tmpdir(), 'ccm-sreg-definitely-absent'), isAlive: () => true });
  assert.equal(got, null);
});

test('readSessionRegistry：同 sessionId 多 PID（sdk+cli 并存实测形态）→ 优先 entrypoint=cli', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 301, { entrypoint: 'sdk-ts' });
    writeEntry(dir, 302, { status: 'busy', statusUpdatedAt: 7 });
    const got = await readSessionRegistry(SID, CWD, { dir, isAlive: () => true });
    assert.equal(got?.pid, 302);
    assert.equal(got?.entrypoint, 'cli');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 列表侧批量读取：会话列表一次扫盘拿到全部活终端状态（不是每行一次 readdir）。
// 'busy' = cli 且 status:"busy" 新鲜；'alive' = cli 进程活着但未在跑；非 cli entrypoint 不进结果
// （sdk-ts/sdk-cli 是 ccm 自己或别的 SDK 工具驱动，列表里已有 live 实例徽标，重复标注会双份）。
test('listTerminalSessionStates：按 cwd+sessionId 归键返回 busy/alive，非 cli 与陈尸 pid 不进结果', async () => {
  const dir = tempDir();
  const now = 1_785_000_100_000;
  const put = (pid, sessionId, extra) => writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: CWD, entrypoint: 'cli', ...extra }),
  );
  try {
    put(1, 'sid-busy', { status: 'busy', statusUpdatedAt: now - 500 });
    put(2, 'sid-idle', { status: 'idle', statusUpdatedAt: now - 500 });
    // 陈旧的 busy 仍算 busy：statusUpdatedAt 不是心跳，长回合期间它本就不会刷新（7/29 实证）
    put(3, 'sid-longrun', { status: 'busy', statusUpdatedAt: now - 20 * 60_000 });
    put(4, 'sid-sdk', { entrypoint: 'sdk-ts' });
    put(5, 'sid-dead', { status: 'busy', statusUpdatedAt: now });
    put(6, 'sid-shell', { status: 'shell', statusUpdatedAt: now - 500 }); // 跑命令中
    put(7, 'sid-nostatus', {});                                          // cli 活着但无自报
    const map = await listTerminalSessionStates({ dir, isAlive: pid => pid !== 5 });
    assert.equal(map.get(terminalStateKey(CWD, 'sid-busy')), 'busy');
    assert.equal(map.get(terminalStateKey(CWD, 'sid-idle')), 'alive');
    assert.equal(map.get(terminalStateKey(CWD, 'sid-longrun')), 'busy');
    assert.equal(map.get(terminalStateKey(CWD, 'sid-shell')), 'busy');
    assert.equal(map.get(terminalStateKey(CWD, 'sid-nostatus')), 'alive');
    assert.equal(map.has(terminalStateKey(CWD, 'sid-sdk')), false, 'sdk 系条目不进结果');
    assert.equal(map.has(terminalStateKey(CWD, 'sid-dead')), false, '陈尸 pid 不进结果');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listTerminalSessionStates：目录不存在 → 空 Map（fail-open，列表不受影响）', async () => {
  const map = await listTerminalSessionStates({ dir: join(tmpdir(), 'ccm-sreg-absent-2'), isAlive: () => true });
  assert.equal(map.size, 0);
});

test('applyTerminalStatesToSessions：克隆行、注入当前状态并清除旧 terminal，不污染缓存对象', () => {
  const sessions = [
    { id: 'sid-busy', title: 'Busy', terminal: 'alive' },
    { id: 'sid-alive', title: 'Alive' },
    { id: 'sid-gone', title: 'Gone', terminal: 'busy' },
    { id: 'sid-other-cwd', title: 'Other cwd', terminal: 'busy' },
  ];
  const before = structuredClone(sessions);
  const states = new Map([
    [terminalStateKey(CWD, 'sid-busy'), 'busy'],
    [terminalStateKey(CWD, 'sid-alive'), 'alive'],
    [terminalStateKey('/Users/you/other', 'sid-other-cwd'), 'busy'],
  ]);

  const result = applyTerminalStatesToSessions(CWD, sessions, states);

  assert.notEqual(result, sessions);
  result.forEach((row, i) => assert.notEqual(row, sessions[i]));
  assert.deepEqual(result, [
    { id: 'sid-busy', title: 'Busy', terminal: 'busy' },
    { id: 'sid-alive', title: 'Alive', terminal: 'alive' },
    { id: 'sid-gone', title: 'Gone' },
    { id: 'sid-other-cwd', title: 'Other cwd' },
  ]);
  assert.deepEqual(sessions, before, '输入行不得被原地写入，避免污染 listSessionsPage 缓存');
});

test('applyTerminalStatesToSessions：空状态/空输入安全，旧 terminal 仍会被清除', () => {
  assert.deepEqual(
    applyTerminalStatesToSessions(CWD, [{ id: SID, terminal: 'busy' }], new Map()),
    [{ id: SID }],
  );
  assert.deepEqual(applyTerminalStatesToSessions(CWD, undefined, new Map()), []);
});

test('hasBusyTerminalSessionForCwd：独立于分页行判断整个 cwd 是否有 busy CLI', () => {
  const states = new Map([
    [terminalStateKey(CWD, 'older-session-outside-page'), 'busy'],
    [terminalStateKey(CWD, 'idle-session'), 'alive'],
    [terminalStateKey('/Users/you/other', 'other-busy'), 'busy'],
  ]);
  assert.equal(hasBusyTerminalSessionForCwd(CWD, states), true);
  assert.equal(hasBusyTerminalSessionForCwd('/Users/you/other', states), true);
  assert.equal(hasBusyTerminalSessionForCwd('/Users/you/none', states), false);
  assert.equal(hasBusyTerminalSessionForCwd(CWD, undefined), false);
});

// 负证据（2026-07-28 真机 b06fb05d：杀掉 CLI 后 web 排队续接卡满 5 分钟）：注册表条目「曾观测到
// entrypoint=cli 的活条目 → 现在没有了」是终端进程已死/已退的强信号——被杀进程不会自己留遗言，
// 但它的注册表条目会消失（正常退出删文件；强杀留陈尸文件但 pid 验活过不了）。调用方逐 tick 喂
// 本次 readSessionRegistry 结果，vanished=true 时 mirrorStaleFlag 立即判 stale，不必干等 5 分钟。
test('cliPresenceStep：曾见 cli 条目→消失/仅剩 sdk = vanished；未曾见/仍在 → 非', () => {
  assert.equal(typeof cliPresenceStep, 'function', '待实现：cliPresenceStep');
  assert.deepEqual(cliPresenceStep(false, null), { seen: false, vanished: false }, '从未见过 → 无证据');
  assert.deepEqual(cliPresenceStep(false, { entrypoint: 'cli' }), { seen: true, vanished: false }, '首次观测 cli → 记住');
  assert.deepEqual(cliPresenceStep(true, null), { seen: true, vanished: true }, '曾见→条目没了 = 死亡强证据');
  assert.deepEqual(cliPresenceStep(true, { entrypoint: 'sdk-ts' }), { seen: true, vanished: true }, '只剩 ccm 自己的 sdk 条目 = cli 已死');
  assert.deepEqual(cliPresenceStep(true, { entrypoint: 'cli' }), { seen: true, vanished: false }, 'cli 还在 → 无负证据');
  assert.deepEqual(cliPresenceStep(false, { entrypoint: 'sdk-ts' }), { seen: false, vanished: false }, 'sdk 条目不算 seen');
});

// 2026-07-29 pty 实证（CLI 2.1.220，四轮）：终端跑 Bash / 等后台子代理期间 CLI 自报的是
// status:"shell" 而不是 "busy"（TUI 侧 `eu==="idle" && 有 shell 活动 ? "shell" : eu`）。只认
// "busy" 会让整段「终端正在跑长命令/后台子代理」的窗口 registryBusy 恒假——那正是主链 transcript
// 零增长、尾部形态又已 settled 的窗口，四条判据同时失效 → 只读镜像不上锁、手机侧可写、有分叉风险。
test('registryIndicatesTerminalBusy：status:"shell"（终端在跑命令）同样构成终端 busy', () => {
  const now = 1_785_000_200_000;
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'cli', status: 'shell', statusUpdatedAt: now - 1000 }, { now }), true);
  // 仍不放过非 cli 条目：sdk 系是 ccm 自己的实例，生灭与终端无关
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'sdk-ts', status: 'shell', statusUpdatedAt: now }, { now }), false);
});

// 同一轮实证：CLI 只在 status【值变化】时写一次 statusUpdatedAt（源码侧 useEffect 依赖数组只有
// [status, waitingFor]），跑 sleep 75 期间 age 从 0.7s 单调涨到 72s 从不复位——它不是心跳。原先的
// 30s 新鲜度窗因此把【任何超过 30 秒的回合】判成"自报过期"，这条本该最权威的通道对长回合恒假。
// 改判据为「pid 存活（调用方已验）+ status ∈ {busy, shell}」：CLI 回合结束时一定会写 idle
// （四轮实证均如此），所以陈旧的 busy/shell 是可信的；进程崩溃由 pid 验活挡掉。
test('registryIndicatesTerminalBusy：陈旧的 busy/shell 仍可信——statusUpdatedAt 不是心跳', () => {
  const now = 1_785_000_200_000;
  const old = now - 20 * 60_000; // 20 分钟前写下的 busy：长回合的常态，不是"过期"
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'cli', status: 'busy', statusUpdatedAt: old }, { now }), true);
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'cli', status: 'shell', statusUpdatedAt: old }, { now }), true);
  // statusUpdatedAt 缺失也不再是否决理由（判据已不依赖它）
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'cli', status: 'busy' }, { now }), true);
  // idle 仍然是 idle：CLI 收尾时会主动写它，这是解锁的正路
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'cli', status: 'idle', statusUpdatedAt: now }, { now }), false);
});

test('registryIndicatesTerminalBusy：cli+busy → true；非 cli / idle / 空条目 → false', () => {
  const now = 1_785_000_200_000;
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'cli', status: 'busy', statusUpdatedAt: now - 1000 }), true);
  // sdk-ts 条目（无 status 字段）：不构成终端 busy
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'sdk-ts', kind: 'interactive' }), false);
  // cli 但 idle
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'cli', status: 'idle', statusUpdatedAt: now }), false);
  // cli 活着但完全无自报（老版本 / 尚未写过 status）：不背书，回落尾部判定
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'cli' }), false);
  // null 条目
  assert.equal(registryIndicatesTerminalBusy(null), false);
});

// ── findBlockingLiveAgent：resume 会被 CLI 拒绝的占用者 ────────────────────────
// 判据逐条对齐 CLI 2.1.220 内部的 `_Pe`（resume 前置检查）：
//   listAllLiveSessions() 里 sessionId 相同 && pid 非自己 && kind 存在 && kind !== 'interactive'
// 命中即 CLI 报 "Session X is currently running as a background agent (kind)" 并拒绝 resume。

test('findBlockingLiveAgent：同 sessionId 上 bg 与 interactive 并存 → 仍认出 bg 占用者', async () => {
  const dir = tempDir();
  try {
    // 7/30 实测形态：一个 sessionId 同时挂着 CLI 后台任务与 interactive 条目
    writeEntry(dir, 89876, { kind: 'interactive', entrypoint: 'sdk-ts' });
    writeEntry(dir, 57573, { kind: 'bg', jobId: '4f485e1c', name: '排查模型网关超时问题' });
    const got = await findBlockingLiveAgent(SID, { dir, isAlive: () => true });
    assert.deepEqual(got, { pid: 57573, kind: 'bg', jobId: '4f485e1c', name: '排查模型网关超时问题' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findBlockingLiveAgent：只有 interactive 驾驶者 → null（CLI 不拒 resume，只读镜像照常）', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 91622, { kind: 'interactive', status: 'busy' });
    assert.equal(await findBlockingLiveAgent(SID, { dir, isAlive: () => true }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findBlockingLiveAgent：bg 条目 pid 已死（陈尸文件）→ null', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 57573, { kind: 'bg' });
    assert.equal(await findBlockingLiveAgent(SID, { dir, isAlive: () => false }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findBlockingLiveAgent：不按 cwd 过滤——CLI 侧 _Pe 全量扫，筛 cwd 会漏判致白 spawn', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 57573, { kind: 'bg', cwd: '/some/other/worktree' });
    const got = await findBlockingLiveAgent(SID, { dir, isAlive: () => true });
    assert.equal(got?.pid, 57573);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findBlockingLiveAgent：无 kind 字段的条目不背书（对齐 _Pe 的 r.kind 存在性判据）', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 57573, { kind: undefined });
    assert.equal(await findBlockingLiveAgent(SID, { dir, isAlive: () => true }), null);
    assert.equal(await findBlockingLiveAgent('', { dir, isAlive: () => true }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
