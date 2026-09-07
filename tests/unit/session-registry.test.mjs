// tests/unit/session-registry.test.mjs —— ~/.claude/sessions/<PID>.json 的读取与活性判定
// 这是判断「终端是不是正驾驶着这个会话」的权威来源（比尾部形态猜测强一档），镜像锁与 stale 文案都用它。
// 它读的是别人写的目录，因此全程 fail-open + 防御式解析：pid 验活、cwd/sessionId 双匹配、
// 损坏 JSON/symlink/非 json 一律跳过、目录不存在返回 null 而不抛。
// 覆盖：上述判据 + 同 sessionId 多 PID（sdk 与 cli 并存的实测形态）+ cliPresenceStep 的负证据推进
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readSessionRegistry,
  registryIndicatesTerminalBusy,
  registryIndicatesTerminalWaiting,
  listTerminalSessionStates,
  applyTerminalStatesToSessions,
  hasBusyTerminalSessionForCwd,
  hasWaitingTerminalSessionForCwd,
  terminalStateKey,
  cliPresenceStep,
  findBlockingLiveAgent,
} from '../../app/src/sessions/session-registry.js';

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
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-busy')), { state: 'busy', source: 'cli' });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-idle')), { state: 'alive', source: 'cli' });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-longrun')), { state: 'busy', source: 'cli' });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-shell')), { state: 'busy', source: 'cli' });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-nostatus')), { state: 'alive', source: 'cli' });
    assert.equal(map.has(terminalStateKey(CWD, 'sid-sdk')), false, 'sdk 系条目不进结果');
    assert.equal(map.has(terminalStateKey(CWD, 'sid-dead')), false, '陈尸 pid 不进结果');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listTerminalSessionStates：目录不存在 → 空 Map（fail-open，列表不受影响）', async () => {
  const map = await listTerminalSessionStates({ dir: join(tmpdir(), 'ccm-sreg-absent-2'), isAlive: () => true });
  assert.equal(map.size, 0);
});

// 2026-09-04：第三态 'waiting'。此前 status:"waiting"（终端卡在对话框上等人，含权限审批框）落进
// else 分支被标成 'alive'，于是抽屉里「CLI 正等你批准」与「终端开着但闲着」完全同形——最需要
// 注意的状态被归进了最不需要的那一档。
test('listTerminalSessionStates：status:"waiting" 单列第三态，不被折进 alive', async () => {
  const dir = tempDir();
  const put = (pid, sessionId, extra) => writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: CWD, entrypoint: 'cli', ...extra }),
  );
  try {
    put(1, 'sid-waiting', { status: 'waiting', waitingFor: 'permission prompt' });
    put(2, 'sid-idle', { status: 'idle' });
    const map = await listTerminalSessionStates({ dir, isAlive: () => true });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-waiting')), { state: 'waiting', source: 'cli' });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-idle')), { state: 'alive', source: 'cli' }, '闲着的终端仍是 alive，两者必须可区分');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 同一会话挂多个 PID 时的优先级（7/26 实测 sdk-ts 与 cli 并存；同会话也可能有多个 cli 进程）。
// busy > waiting > alive：在跑压过等人，等人压过闲着——信息量从高到低，绝不能被后来的低信息量条目覆盖。
test('listTerminalSessionStates：同会话多 PID 时 busy > waiting > alive，顺序无关', async () => {
  const dir = tempDir();
  const put = (pid, status) => writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: 'sid-multi', cwd: CWD, entrypoint: 'cli', ...(status ? { status } : {}) }),
  );
  try {
    put(1, 'idle');      // 先写低优先级的，确保后来的高优先级能覆盖
    put(2, 'waiting');
    let map = await listTerminalSessionStates({ dir, isAlive: () => true });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-multi')), { state: 'waiting', source: 'cli' }, 'waiting 压过 alive');
    put(3, 'busy');
    map = await listTerminalSessionStates({ dir, isAlive: () => true });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-multi')), { state: 'busy', source: 'cli' }, 'busy 压过 waiting');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 桌面端 Code 模式（2026-09-06） ───────────────────────────────────────────────
// Claude.app 的 Code 标签驱动的会话：跑的是【同一份 claude 二进制】（Claude.app 自带副本，
// --input-format stream-json headless 驱动），transcript 与注册表都自报 entrypoint='claude-desktop'。
// 实测（2.1.260）：它写活体条目、进程退出照样删文件，但【从不写 status】。
// 此前它和 sdk 系一起被 `entrypoint !== 'cli'` 挡在门外，后果是桌面端会话在列表里【没有任何运行
// 标识】——只剩一个未读点（未读走 transcript 增长那条轴，不看 entrypoint，所以一直是好的）。
// 缺的那半边证据靠磁盘补：注册表说"进程还在"，尾部形态说"轮次收没收尾"，两条拼起来 ≡ 缺失的 status。
test('listTerminalSessionStates：桌面端条目无 status → 尾部 pending 判 busy、settled 判 alive', async () => {
  const dir = tempDir();
  const put = (pid, sessionId, extra = {}) => writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: CWD, entrypoint: 'claude-desktop', kind: 'interactive', ...extra }),
  );
  try {
    put(1, 'sid-running');   // 尾部 pending = 回合没收尾 = 在跑
    put(2, 'sid-idleing');   // 尾部 settled = 窗口开着但闲着
    put(3, 'sid-dead');      // 陈尸条目：pid 验活挡掉，与 cli 同规矩
    const classifyTail = async (sessionId) => ({ verdict: sessionId === 'sid-running' ? 'pending' : 'settled' });
    const map = await listTerminalSessionStates({ dir, isAlive: pid => pid !== 3, classifyTail });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-running')), { state: 'busy', source: 'claude-desktop' });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-idleing')), { state: 'alive', source: 'claude-desktop' });
    assert.equal(map.has(terminalStateKey(CWD, 'sid-dead')), false, '陈尸 pid 不进结果');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 磁盘判据只能【补】自报，绝不能【压过】自报，也不能拖累 cli 那条路径多付一次读盘。
// 反过来写（无条件读盘）会让 cli 的 status:"busy" 被一次陈旧的尾部 settled 推翻——那是把这个仓库
// 7/29 好不容易实证出来的"陈旧 busy 仍可信"又丢一遍。
test('listTerminalSessionStates：有 status 自报的条目不读盘（cli 路径零回归）', async () => {
  const dir = tempDir();
  const calls = [];
  const classifyTail = async (sessionId) => { calls.push(sessionId); return { verdict: 'settled' }; };
  try {
    writeFileSync(join(dir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'sid-cli-busy', cwd: CWD, entrypoint: 'cli', status: 'busy' }));
    writeFileSync(join(dir, '2.json'), JSON.stringify({ pid: 2, sessionId: 'sid-cli-wait', cwd: CWD, entrypoint: 'cli', status: 'waiting' }));
    // idle 是最容易漏的一档：它落在 state==='alive' 分支上，若判据只看 state 不看 status，
    // 这一条会白付一次读盘，并且尾部 pending 时把 CLI 明确自报的 idle 【推翻】成 busy
    // ——那正是 7/29 实证"陈旧 busy 仍可信"的反面：自报永远压过磁盘推断。
    writeFileSync(join(dir, '4.json'), JSON.stringify({ pid: 4, sessionId: 'sid-cli-idle', cwd: CWD, entrypoint: 'cli', status: 'idle' }));
    // 面向未来：上游哪天给桌面端补上 status，自报立刻压过磁盘推断（也省掉这次读盘）
    writeFileSync(join(dir, '3.json'), JSON.stringify({ pid: 3, sessionId: 'sid-desk-busy', cwd: CWD, entrypoint: 'claude-desktop', status: 'shell' }));
    const map = await listTerminalSessionStates({ dir, isAlive: () => true, classifyTail });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-cli-busy')), { state: 'busy', source: 'cli' });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-cli-wait')), { state: 'waiting', source: 'cli' });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-desk-busy')), { state: 'busy', source: 'claude-desktop' },
      '桌面端一旦自报 status，按自报走，不再回落磁盘');
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-cli-idle')), { state: 'alive', source: 'cli' },
      'CLI 自报 idle 就是 idle，不得被磁盘尾部推断升成 busy');
    assert.deepEqual(calls, [], '有自报就不该读盘：既是省 IO，也是不让磁盘推断推翻权威自报');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// fail-open 的方向是【刻意选的】：读不动磁盘时说"开着"，绝不说"在跑"。
// 反方向（fail 成 busy）会让列表长期挂着假运行中——2026-09-06 实测本机就有 3 个 3.8~4.0 小时前
// 的桌面端会话尾部仍是 pending（进程早没了，注册表条目也没了）。谎报在跑比少报更坏：它会让人
// 以为电脑上还有东西在跑而不敢动手。
test('listTerminalSessionStates：classifyTail 缺失/抛错 → alive，绝不谎报 busy', async () => {
  const dir = tempDir();
  const put = (pid, sessionId) => writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: CWD, entrypoint: 'claude-desktop' }),
  );
  try {
    put(1, 'sid-a');
    // 未注入判据（调用方没给 / 老接线）：只知道进程活着
    let map = await listTerminalSessionStates({ dir, isAlive: () => true });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-a')), { state: 'alive', source: 'claude-desktop' });
    // 读盘抛错：同样落 alive，且不得让整次扫盘塌掉
    map = await listTerminalSessionStates({ dir, isAlive: () => true, classifyTail: async () => { throw new Error('EIO'); } });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-a')), { state: 'alive', source: 'claude-desktop' });
    // 判据返回畸形值：同样不得升成 busy
    map = await listTerminalSessionStates({ dir, isAlive: () => true, classifyTail: async () => null });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-a')), { state: 'alive', source: 'claude-desktop' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// sdk 系仍然排除：那是 ccm 自己（或别的 SDK 工具）驱动的会话，列表里已有 live 实例徽标，
// 标了会双份。放宽 entrypoint 白名单时最容易顺手把它们一起放进来。
test('listTerminalSessionStates：sdk-ts / sdk-cli 仍不进结果（即使给了 classifyTail）', async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'sid-sdk-ts', cwd: CWD, entrypoint: 'sdk-ts' }));
    writeFileSync(join(dir, '2.json'), JSON.stringify({ pid: 2, sessionId: 'sid-sdk-cli', cwd: CWD, entrypoint: 'sdk-cli' }));
    const map = await listTerminalSessionStates({ dir, isAlive: () => true, classifyTail: async () => ({ verdict: 'pending' }) });
    assert.equal(map.size, 0, 'sdk 系不参与终端标注');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// applyTerminalStatesToSessions 是 Map → 会话行的唯一注入面，它自带一层取值白名单。
// 只加 listTerminalSessionStates 的第三态而漏了这里，waiting 会在最后一米被静默丢掉。
test('applyTerminalStatesToSessions：waiting 能落到会话行上（注入面白名单不得漏）', () => {
  const states = new Map([
    [terminalStateKey(CWD, 's1'), { state: 'waiting', source: 'cli' }],
    [terminalStateKey(CWD, 's2'), { state: 'busy', source: 'cli' }],
    [terminalStateKey(CWD, 's3'), { state: 'alive', source: 'cli' }],
    [terminalStateKey(CWD, 's4'), { state: 'bogus', source: 'cli' }], // 未知状态仍要被挡掉
    [terminalStateKey(CWD, 's5'), { state: 'busy', source: 'claude-desktop' }],
    [terminalStateKey(CWD, 's6'), { state: 'busy', source: 'brand-new-frontend' }], // 未登记来源
  ]);
  const rows = applyTerminalStatesToSessions(
    CWD, [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }, { id: 's5' }, { id: 's6' }], states,
  );
  assert.equal(rows[0].terminal, 'waiting');
  assert.equal(rows[1].terminal, 'busy');
  assert.equal(rows[2].terminal, 'alive');
  assert.equal('terminal' in rows[3], false, '白名单外的取值不注入');
  assert.equal(rows[4].terminalSource, 'claude-desktop', '来源要能落到会话行上（前端据它选文案）');
  assert.equal(rows[1].terminalSource, 'cli');
  // 未登记来源：状态照常注入，只是不带来源 → 前端回落"终端"文案，不塌成无 chip
  assert.equal(rows[5].terminal, 'busy');
  assert.equal('terminalSource' in rows[5], false, '未登记来源不注入，但不得连状态一起丢');
});

test('applyTerminalStatesToSessions：克隆行、注入当前状态并清除旧 terminal，不污染缓存对象', () => {
  const sessions = [
    { id: 'sid-busy', title: 'Busy', terminal: 'alive' },
    { id: 'sid-alive', title: 'Alive' },
    { id: 'sid-gone', title: 'Gone', terminal: 'busy' },
    // 上一轮标过桌面端：状态与来源都必须被清掉，不能只清一半（残留 source 会让文案永远说"桌面端"）
    { id: 'sid-other-cwd', title: 'Other cwd', terminal: 'busy', terminalSource: 'claude-desktop' },
  ];
  const before = structuredClone(sessions);
  const states = new Map([
    [terminalStateKey(CWD, 'sid-busy'), { state: 'busy', source: 'cli' }],
    [terminalStateKey(CWD, 'sid-alive'), { state: 'alive', source: 'cli' }],
    [terminalStateKey('/Users/you/other', 'sid-other-cwd'), { state: 'busy', source: 'cli' }],
  ]);

  const result = applyTerminalStatesToSessions(CWD, sessions, states);

  assert.notEqual(result, sessions);
  result.forEach((row, i) => assert.notEqual(row, sessions[i]));
  assert.deepEqual(result, [
    { id: 'sid-busy', title: 'Busy', terminal: 'busy', terminalSource: 'cli' },
    { id: 'sid-alive', title: 'Alive', terminal: 'alive', terminalSource: 'cli' },
    { id: 'sid-gone', title: 'Gone' },
    { id: 'sid-other-cwd', title: 'Other cwd' },
  ]);
  assert.deepEqual(sessions, before, '输入行不得被原地写入，避免污染 listSessionsPage 缓存');
});

test('applyTerminalStatesToSessions：空状态/空输入安全，旧 terminal 仍会被清除', () => {
  assert.deepEqual(
    applyTerminalStatesToSessions(CWD, [{ id: SID, terminal: 'busy', terminalSource: 'cli' }], new Map()),
    [{ id: SID }],
  );
  assert.deepEqual(applyTerminalStatesToSessions(CWD, undefined, new Map()), []);
});

test('hasBusyTerminalSessionForCwd：独立于分页行判断整个 cwd 是否有 busy CLI', () => {
  const states = new Map([
    [terminalStateKey(CWD, 'older-session-outside-page'), { state: 'busy', source: 'cli' }],
    [terminalStateKey(CWD, 'idle-session'), { state: 'alive', source: 'cli' }],
    [terminalStateKey('/Users/you/other', 'other-busy'), { state: 'busy', source: 'claude-desktop' }],
  ]);
  assert.equal(hasBusyTerminalSessionForCwd(CWD, states), true);
  assert.equal(hasBusyTerminalSessionForCwd('/Users/you/other', states), true);
  assert.equal(hasBusyTerminalSessionForCwd('/Users/you/none', states), false);
  assert.equal(hasBusyTerminalSessionForCwd(CWD, undefined), false);
});

// 2026-09-04：目录级同样要认 waiting——抽屉折叠时用户只看得到目录行，会话行的 chip 再准也看不见。
// 与 busy 并列成两个布尔而不是合成一个三态：同一个 cwd 下完全可能一个会话在跑、另一个卡在审批上，
// 三态字符串必然丢掉其中一个。
test('hasWaitingTerminalSessionForCwd：独立于分页行判断整个 cwd 是否有终端在等人', () => {
  const states = new Map([
    [terminalStateKey(CWD, 'awaiting-approval'), { state: 'waiting', source: 'cli' }],
    [terminalStateKey(CWD, 'idle-session'), { state: 'alive', source: 'cli' }],
    [terminalStateKey('/Users/you/other', 'other-busy'), { state: 'busy', source: 'cli' }],
  ]);
  assert.equal(hasWaitingTerminalSessionForCwd(CWD, states), true);
  assert.equal(hasWaitingTerminalSessionForCwd('/Users/you/other', states), false, 'busy 不是 waiting');
  assert.equal(hasWaitingTerminalSessionForCwd('/Users/you/none', states), false);
  assert.equal(hasWaitingTerminalSessionForCwd(CWD, undefined), false);
  // 两条判据互不吞并：跑着的那个仍要被 busy 判据看见
  assert.equal(hasBusyTerminalSessionForCwd(CWD, states), false);
});

// 负证据（2026-07-28 真机 b06fb05d：杀掉 CLI 后 web 排队续接卡满 5 分钟）：注册表条目「曾观测到
// entrypoint=cli 的活条目 → 现在没有了」是终端进程已死/已退的强信号——被杀进程不会自己留遗言，
// 但它的注册表条目会消失（正常退出删文件；强杀留陈尸文件但 pid 验活过不了）。调用方逐 tick 喂
// 本次 readSessionRegistry 结果，vanished=true 时 mirrorStaleFlag 立即判 stale，不必干等 5 分钟。
test('cliPresenceStep：曾见 cli 条目→消失/仅剩 sdk = vanished；未曾见/仍在 → 非', () => {
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

// 2026-09-04：CLI 的 status 枚举其实有【四】个取值——二进制里就写着 `["busy","shell","idle","waiting"]`。
// 前两次补判据（只认 busy → 补 shell）都是"发现一个补一个"，没去把枚举读全，于是 waiting 一直漏着。
// waiting 的含义是「终端停下来等人」：CLI 侧任何 dialog 打开都会写它（zHe/dRo），其中就包括权限审批框
// ——审批框在 dialog 注册表里没有显式 waitingFor，走的是兜底字面量 `?? "permission prompt"`。
// pty 实证（CLI 2.1.260）：打开 /model 对话框后条目变成 status:"waiting" + waitingFor:"dialog open"。
test('registryIndicatesTerminalWaiting：cli+waiting（终端卡在对话框上等人）→ true', () => {
  assert.equal(registryIndicatesTerminalWaiting({ entrypoint: 'cli', status: 'waiting' }), true);
  // 在跑不是在等：两个判据互斥，各自表达一件事
  assert.equal(registryIndicatesTerminalWaiting({ entrypoint: 'cli', status: 'busy' }), false);
  assert.equal(registryIndicatesTerminalWaiting({ entrypoint: 'cli', status: 'shell' }), false);
  assert.equal(registryIndicatesTerminalWaiting({ entrypoint: 'cli', status: 'idle' }), false);
  // 非 cli / 空条目：同 busy 判据，sdk 系是 ccm 自己的实例
  assert.equal(registryIndicatesTerminalWaiting({ entrypoint: 'sdk-ts', status: 'waiting' }), false);
  assert.equal(registryIndicatesTerminalWaiting({ entrypoint: 'cli' }), false);
  assert.equal(registryIndicatesTerminalWaiting(null), false);
});

// 2026-09-06：两个 status 判定函数的 entrypoint 白名单参数化了（列表侧要认 claude-desktop），
// 而**默认值必须保持只认 cli**——这两个函数同时喂着镜像锁，那条路上的 registryBusy 有"无视尾部
// 形态直接上锁"的特权（mirrorEntryLock 第二行）。放宽默认值 = 悄悄改动 SESSION-01 的判据面：
// 桌面端会话会凭一个 status 字段就把手机侧锁成只读，而这个仓库从没为它论证过。
// 默认值是那道屏障的【唯一】实现，所以它需要一条自己的用例——否则改掉它不会让任何东西变红。
test('registryIndicatesTerminalBusy/Waiting：默认白名单只认 cli，放宽必须显式传参', () => {
  const desktopBusy = { entrypoint: 'claude-desktop', status: 'busy' };
  const desktopWaiting = { entrypoint: 'claude-desktop', status: 'waiting' };
  // 默认（镜像锁侧的调用形态）：不背书
  assert.equal(registryIndicatesTerminalBusy(desktopBusy), false, '默认不认 claude-desktop——镜像锁语义不得被顺手放宽');
  assert.equal(registryIndicatesTerminalWaiting(desktopWaiting), false);
  // 显式传入（列表标注侧的调用形态）：认
  const opts = { entrypoints: new Set(['cli', 'claude-desktop']) };
  assert.equal(registryIndicatesTerminalBusy(desktopBusy, opts), true);
  assert.equal(registryIndicatesTerminalWaiting(desktopWaiting, opts), true);
  // 传了白名单也不改 status 判据本体：idle 仍不是 busy，busy 仍不是 waiting
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'claude-desktop', status: 'idle' }, opts), false);
  assert.equal(registryIndicatesTerminalWaiting(desktopBusy, opts), false);
  // 历史调用形态（第二参传 { now }）不受影响：now 早已不参与判定，白名单仍取默认
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'cli', status: 'busy' }, { now: 1 }), true);
});

// 刻意【不】把 waiting 并进 busy：抽屉据 busy 显示"运行中"，而等审批的终端并没有在运行——
// 混进去就是在说错话。两个判据分开，让上层各取所需（镜像锁两个都要，抽屉文案只认 busy）。
test('registryIndicatesTerminalBusy：waiting 不算 busy——「等你」不是「在跑」', () => {
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'cli', status: 'waiting' }), false);
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

// ── 列表侧的「点了也打不开」预警（2026-09-06）─────────────────────────────────
// 起因：web 上点一个被 CLI bg agent 占用的会话，session:switch 被拒，而列表行在点之前
// 没有任何迹象。判据必须与 findBlockingLiveAgent 逐条同源——它才是真正的拒绝判据，
// 列表另立一套必然漂移成「标了却能开」或「没标却开不了」。
// blocked 只准影响自己那条轴：state 留 null 而不是新增一档，因为 hasBusy/hasWaiting 拿
// 同一张表喂镜像锁与单驾驶员判定（SESSION-01 的输入面），往状态轴塞取值＝悄悄改那条红线。

test('listTerminalSessionStates：bg 条目标 blocked，三个否定档（无 kind / interactive / 陈尸）一个都不标', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 1, { sessionId: 'sid-bg', kind: 'bg', status: 'idle' });
    writeEntry(dir, 2, { sessionId: 'sid-interactive', kind: 'interactive', status: 'idle' });
    writeEntry(dir, 3, { sessionId: 'sid-nokind', kind: undefined, status: 'idle' });
    writeEntry(dir, 4, { sessionId: 'sid-bg-dead', kind: 'bg', status: 'idle' });
    const map = await listTerminalSessionStates({ dir, isAlive: pid => pid !== 4 });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-bg')), { state: 'alive', source: 'cli', blocked: true },
      'bg 占用者：状态轴照旧 alive（它自报 idle），另加 blocked');
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-interactive')), { state: 'alive', source: 'cli' },
      'interactive 是 CLI 放行的一档，不得标 blocked（标了就是虚报「打不开」）');
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-nokind')), { state: 'alive', source: 'cli' },
      '无 kind 不背书，对齐 findBlockingLiveAgent 的 kind 存在性判据');
    assert.equal(map.has(terminalStateKey(CWD, 'sid-bg-dead')), false, '陈尸 pid 不进结果，更不该预警');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listTerminalSessionStates：sdk 系 bg 占用者也要预警，且不得混进 busy/waiting 汇总', async () => {
  const dir = tempDir();
  try {
    // entrypoint=sdk-ts 不在 TERMINAL_ENTRYPOINTS 里（列表不给它画运行徽标），但 CLI 的 resume
    // 前置检查不看 entrypoint——它照样会让 --resume 失败，所以照样要预警。
    writeEntry(dir, 1, { sessionId: 'sid-sdk-bg', kind: 'bg', entrypoint: 'sdk-ts' });
    const map = await listTerminalSessionStates({ dir, isAlive: () => true });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-sdk-bg')), { state: null, source: null, blocked: true },
      '没有状态可报就留 null，不得编一个状态值出来');
    assert.equal(hasBusyTerminalSessionForCwd(CWD, map), false, 'blocked 不是 busy：喂给镜像锁的那条轴必须原样');
    assert.equal(hasWaitingTerminalSessionForCwd(CWD, map), false, 'blocked 更不是 waiting');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listTerminalSessionStates：占用者同时在跑时 busy 与 blocked 并存，互不吞掉', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 1, { sessionId: 'sid-bg-busy', kind: 'bg', status: 'busy' });
    const map = await listTerminalSessionStates({ dir, isAlive: () => true });
    assert.deepEqual(map.get(terminalStateKey(CWD, 'sid-bg-busy')), { state: 'busy', source: 'cli', blocked: true });
    assert.equal(hasBusyTerminalSessionForCwd(CWD, map), true, 'blocked 合入不得把已有的 busy 抹掉');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('applyTerminalStatesToSessions：bgLocked 注入到行上，且不随缓存对象残留', async () => {
  const states = new Map([
    [terminalStateKey(CWD, 'sid-bg'), { state: 'alive', source: 'cli', blocked: true }],
    [terminalStateKey(CWD, 'sid-sdk-bg'), { state: null, source: null, blocked: true }],
    [terminalStateKey(CWD, 'sid-plain'), { state: 'alive', source: 'cli' }],
  ]);
  const rows = applyTerminalStatesToSessions(CWD, [
    { id: 'sid-bg', title: 'A' },
    { id: 'sid-sdk-bg', title: 'B' },
    { id: 'sid-plain', title: 'C' },
  ], states);
  assert.equal(rows[0].bgLocked, true);
  assert.equal(rows[1].bgLocked, true, '连状态都没有的占用者也要标——它是最容易漏的一类');
  assert.equal(rows[1].terminal, undefined, 'state 为 null 时不得注入 terminal（状态白名单仍然管用）');
  assert.equal(rows[2].bgLocked, undefined, '没被占用的行不得带这个字段');
  // listSessionsPage 可能返回缓存对象：占用者退出后再拉一次，标记必须消失
  const after = applyTerminalStatesToSessions(CWD, rows, new Map());
  assert.equal(after[0].bgLocked, undefined, '占用者已退出，预警必须跟着消失（残留＝永远打不开的假象）');
  assert.equal(rows[0].bgLocked, true, '禁止原地写入调用方传进来的行对象');
});
