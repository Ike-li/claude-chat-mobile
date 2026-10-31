// tests/unit/history-list-sdk-fastpath.test.mjs —— listSessionsPage 的 SDK 快路径
//
// 【为什么单独一个文件】快路径的判定是 `baseDir === CLAUDE_DIR`（history.js:567 的 useSdk），
// 而 CLAUDE_DIR 是 history.js 的【模块级常量】：`join(homedir(), '.claude', 'projects')`，
// 在 import 求值那一刻就定死了。所以想让快路径落在假目录上，必须【在 import history.js 之前】
// 就把 HOME 换掉——ESM 的 import 会提升，写在静态 import 后面的赋值来不及生效，
// 只能是「先设 HOME，再动态 import」，而这在原文件里做不到（那边顶部已经静态 import 过了）。
// node --test 每个测试文件跑在独立子进程里，模块注册表互不污染，拆文件就够了。
//
// 【为什么非拆不可】这段测试原先跑在【真实 ~/.claude/projects】上：它在那里建目录、写 jsonl、
// 再 rmSync 掉。2026-08-02 出过事——变异检查把 getProjectDir 改成恒返回 ''，
// `join(CLAUDE_DIR, '')` 塌成根目录本身，recursive+force 把70 个项目的 transcript 与
// memory 一次删光（靠 APFS 快照恢复）。当时以为"碰真实目录的只有集成测试"，其实这个单测也碰，
// 而且是每次 npm test 都碰。详见 [[ccm-mutate-deleted-real-data-2026-08-02]]。
//
// 换成假 HOME 之后，就算 getProjectDir 再塌成 ''，删的也只是本文件自己 mkdtemp 出来的空壳目录。
// 下面那个 rmProjectDir 护栏仍然保留：假 HOME 是"炸不到人"，护栏是"根本不许炸"，两层不冲突。
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// ★ 必须早于 history.js 的 import——用动态 import 保证顺序（静态 import 会被提升到这之前）。
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'ccm-hist-fastpath-home-'));
process.env.HOME = FAKE_HOME;

const test = (await import('node:test')).default;
const assert = (await import('node:assert/strict')).default;
const { getProjectDir, listSessionsPage, peekSessionListTitle, __setSdkListSessionsForTest, __setSdkGetSessionInfoForTest } =
  await import('../../app/src/sessions/history.js');
const { MAX_SESSION_LIMIT } = await import('../../app/src/sessions/workdirs.js');

const CLAUDE_DIR = join(homedir(), '.claude', 'projects');

// 自检：HOME 真的换掉了、且 history.js 内部算出的根与这里一致，否则本文件就是在真实目录上跑，
// 那正是要避免的事。断在最前面，不让后面的删除动作在错误的根上执行。
test('前置自检: CLAUDE_DIR 落在一次性 HOME 内，未指向真实目录', () => {
  assert.equal(process.env.HOME, FAKE_HOME);
  assert.ok(CLAUDE_DIR.startsWith(FAKE_HOME), `CLAUDE_DIR 应在假 HOME 内，实际=${CLAUDE_DIR}`);
});

// 删除目标 `join(CLAUDE_DIR, getProjectDir(cwd))` 是被测代码算出来的：getProjectDir 一旦返回 ''
// 就塌成 CLAUDE_DIR 本身。护栏放在执行删除的那一刻，不管路径为什么塌都拦得住。
function rmProjectDir(dir) {
  if (!dir || resolve(dir) === resolve(CLAUDE_DIR)) {
    throw new Error(`拒绝删除 CLAUDE_DIR 本身（getProjectDir 返回了空值？）: ${JSON.stringify(dir)}`);
  }
  // safe-rm: 双保险——① 本文件整体跑在 mkdtemp 出来的假 HOME 下，CLAUDE_DIR 根本不指向
  // 真实目录（文件头有前置自检断言）；② 上面那两行护栏挡住「塌成根」的形态。
  rmSync(dir, { recursive: true, force: true });
}

function writeJSONL(dir, id, entries) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

test('SDK 快路径: 字段映射 id/title/lastUsedAt，dir 传原始 cwd，不返回 model/entrypoint', async () => {
  const cwd = '/sdk/quick';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  // sid-1/sid-2 写真实 jsonl（归属本 cwd）；sid-ghost 不写——模拟 SDK 混入的别处会话（worktree 展开已关，过滤仍兜底）
  writeJSONL(dir, 'sid-1', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  writeJSONL(dir, 'sid-2', [{ type: 'user', message: { role: 'user', content: 'yo' } }]);
  let captured;
  __setSdkListSessionsForTest(async (opts) => {
    captured = opts;
    return [
      { sessionId: 'sid-1', summary: 'CLI /resume 同款标题', lastModified: 1784098212405 },
      { sessionId: 'sid-2', summary: '', lastModified: 1784098212400 },
      { sessionId: 'sid-ghost', summary: '祖先目录混入的幽灵', lastModified: 1784098212500 },
    ];
  });
  try {
    const { sessions } = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    // ① dir 传原始 cwd（铁证坑：传编码路径会让 SDK 返回空）
    assert.equal(captured.dir, cwd);
    // 小 limit 也按硬顶+1 取候选，便于按消息时间重排（默认 6 条时 resume 刷 mtime 的旧会话不占满窗口）
    assert.equal(captured.limit, MAX_SESSION_LIMIT + 1);
    // ③ 归属过滤：jsonl 不在本 cwd 项目目录的会话滤掉（兜底编码撞名等；worktree 展开混入已在源头关掉，见 #451；
    //    与 session:switch 的 sessionFileExists 归属校验同一语义，列表≡可切换）
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map(s => s.id).sort(), ['sid-1', 'sid-2']);
    const s1 = sessions.find(s => s.id === 'sid-1');
    assert.equal(s1.title, 'CLI /resume 同款标题');
    // 空 summary 回落该 jsonl 的 readHeadMeta（与搜索、通知横幅同口径），读不到才是占位（验收 O58）
    assert.equal(sessions.find(s => s.id === 'sid-2').title, 'yo');
    // deadweight 字段快路径不返回（前端不消费、SDK 也不给）
    assert.equal(s1.model, undefined);
    assert.equal(s1.entrypoint, undefined);
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

test('SDK 快路径: 重排后 hasMore——候选多于 limit 为 true；恰好等于则 false', async () => {
  const cwd = '/sdk/hasmore';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  for (let i = 0; i < 4; i++) writeJSONL(dir, `s${i}`, [{ type: 'user', message: { role: 'user', content: `m${i}` } }]);
  __setSdkListSessionsForTest(async (opts) => {
    const n = Math.min(opts.limit, 4); // 模拟磁盘共 4 条
    return Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, summary: `t${i}`, lastModified: 1000 + i }));
  });
  try {
    const a = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 2 });
    assert.equal(a.sessions.length, 2);
    assert.equal(a.hasMore, true);
    const b = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 4 });
    assert.equal(b.sessions.length, 4);
    assert.equal(b.hasMore, false);
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

test('SDK 快路径: 按消息时间重排——lastModified 更新但消息旧的不应压过真近会话', async () => {
  const cwd = '/sdk/reorder';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  const oldTs = '2020-06-01T12:00:00.000Z';
  const newTs = '2026-07-01T12:00:00.000Z';
  // touched：SDK 报的 lastModified 最新（模拟 resume 刷 mtime），但最后一条真实消息很旧
  writeJSONL(dir, 'touched', [
    { type: 'user', timestamp: oldTs, message: { role: 'user', content: '很久以前' } },
    { type: 'assistant', timestamp: oldTs, message: { role: 'assistant', content: '很久以前的回答' } },
  ]);
  writeJSONL(dir, 'recent', [
    { type: 'user', timestamp: newTs, message: { role: 'user', content: '最近' } },
    { type: 'assistant', timestamp: newTs, message: { role: 'assistant', content: '最近的回答' } },
  ]);
  __setSdkListSessionsForTest(async () => [
    { sessionId: 'touched', summary: '被刷了 mtime 的旧会话', lastModified: 9999999999999 },
    { sessionId: 'recent', summary: '真正最近的会话', lastModified: 1 },
  ]);
  try {
    const { sessions } = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    assert.equal(sessions[0].id, 'recent', '应按最后一条真实消息时间排序，而非 SDK 的 lastModified');
  } finally {
    __setSdkListSessionsForTest(undefined);
    try { rmProjectDir(dir); } catch { /* 清理失败不挡测 */ }
  }
});

test('SDK 快路径: SDK 抛错不走 fail-closed，回落兜底扫盘正常出列表', async () => {
  const cwd = '/sdk/throw';
  __setSdkListSessionsForTest(async () => { throw new Error('SDK boom'); });
  try {
    const { sessions } = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    // 兜底 readdir 真扫 <CLAUDE_DIR>/-sdk-throw（该目录不存在→[]）= 证明 try/catch 接住异常无崩溃
    // （真 fallback 到 readHeadMeta 路径而非抛出）。此断言锁的是"不抛、安静回落"契约，非数据多少。
    assert.ok(Array.isArray(sessions));
  } finally {
    __setSdkListSessionsForTest(undefined);
  }
});

test.after(() => { try { rmSync(FAKE_HOME, { recursive: true, force: true }); } catch { /* 尽力而为 */ } });

// 2026-08-05 真机：新会话首条发 /code-review，跑完后【整个会话从抽屉里消失】。
// 根因不在 ccm——SDK 的 listSessions/getSessionInfo 会跳过「无可提取 summary」的会话
// （sdk.d.ts 原话：Returns undefined if the session file is not found, is a sidechain
// session, or has no extractable summary）。而本地 slash 命令跑在 fork 上下文里，主链 transcript
// 只落 entrypoint-marker / queue-operation / mode，一条 user/assistant 都没有 ⇒ 提不出 summary。
// 实测：getSessionInfo('8f064e08…') → undefined，CLI 自己的 /resume 列表也只显示 "(session)"。
// 这是 UP-1 的第四处次生伤害，比前三处更彻底：会话在盘上活着，在列表里根本不存在。
test('SDK 漏报的会话（无 summary）仍须出现在列表里——本地 slash 命令跑完的会话就是这形态', async () => {
  const cwd = '/sdk/no-summary';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  // 正常会话：SDK 认得
  writeJSONL(dir, 'sid-normal', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  // /code-review 跑完的会话真实形态：零条 user/assistant，SDK 提不出 summary 故不返回
  writeJSONL(dir, 'sid-forked', [
    { type: 'entrypoint-marker', entrypoint: 'cli', sessionId: 'sid-forked' },
    { type: 'queue-operation', operation: 'enqueue', sessionId: 'sid-forked' },
    { type: 'mode', mode: 'normal', sessionId: 'sid-forked' },
  ]);
  __setSdkListSessionsForTest(async () => [
    { sessionId: 'sid-normal', summary: '正常会话', lastModified: 1784098212405 },
    // sid-forked 缺席——SDK 就是这么漏的
  ]);
  try {
    const { sessions } = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 10 });
    const ids = sessions.map(s => s.id);
    assert.ok(ids.includes('sid-normal'), '正常会话照常在');
    assert.ok(ids.includes('sid-forked'), 'SDK 漏报的会话必须补齐，否则用户在抽屉里找不到它');
    assert.equal(sessions.find(s => s.id === 'sid-forked').title, '(无标题)', '无 summary 回落占位标题');
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

// 验收 O58：首条消息以 HTML 标签开头的会话，SDK 提不出 summary、整条漏报；补齐时原来一律写占位，
// 抽屉里是「(无标题)」，搜索却能按原文搜到它——搜索用的就是 readHeadMeta。标题回落同一份。
test('SDK 漏报但有首条 user 文本的会话：补齐时标题回落 readHeadMeta，不写占位', async () => {
  const cwd = '/sdk/no-summary-html';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  writeJSONL(dir, 'sid-html', [{ type: 'user', message: { role: 'user', content: '<div>改一下这个页面的布局</div>' } }]);
  __setSdkListSessionsForTest(async () => []);
  try {
    const { sessions } = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 10 });
    assert.equal(sessions.find(s => s.id === 'sid-html')?.title, '<div>改一下这个页面的布局</div>');
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

test('补齐不改变既有归属过滤：SDK 报了但盘上没有的幽灵仍被滤掉', async () => {
  const cwd = '/sdk/no-summary-ghost';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  writeJSONL(dir, 'sid-real', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  __setSdkListSessionsForTest(async () => [
    { sessionId: 'sid-real', summary: '真会话', lastModified: 1784098212405 },
    { sessionId: 'sid-ghost', summary: '祖先目录混入', lastModified: 1784098212500 },
  ]);
  try {
    const { sessions } = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 10 });
    assert.deepEqual(sessions.map(s => s.id), ['sid-real'], '补齐只看本目录实际存在的 jsonl，不放行幽灵');
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

// 差集按 mtime 排序再截断，不能按 readdir 的文件名序：老目录里差集可达上百个（SDK 候选窗有上限，
// 窗外的老会话也进差集），按文件名截断会把刚跑完的新会话挡在窗外——2026-08-05 真机就是这么漏的
// （第一版修复在测试里绿、在 312 个 jsonl 的真实目录上仍缺失）。
test('SDK 漏报补齐: 差集超窗时按活动时间取最近的，不按文件名序', async () => {
  const cwd = '/sdk/no-summary-order';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  const noMsg = [{ type: 'queue-operation', operation: 'enqueue' }];
  // zzz-new 文件名排最后但最新；aaa-old-* 一大批占满窗口
  for (let i = 0; i < 60; i++) writeJSONL(dir, `aaa-old-${String(i).padStart(3, '0')}`, noMsg);
  writeJSONL(dir, 'zzz-new', noMsg);
  const past = new Date(Date.now() - 86400_000);
  for (let i = 0; i < 60; i++) utimesSync(join(dir, `aaa-old-${String(i).padStart(3, '0')}.jsonl`), past, past);
  __setSdkListSessionsForTest(async () => []); // SDK 一条都不认（全是无 summary 会话）
  try {
    const { sessions } = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 10 });
    assert.ok(sessions.some(s => s.id === 'zzz-new'), '最新的会话必须进列表，哪怕文件名排在最后');
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

// #6 回归（2026-08-05 第二轮 review）：gap-fill 只认后缀 .jsonl，不过 SS-003 字符集，于是备份/
// 手写文件（foo.bar.jsonl、带路径分隔符的名字）会变成抽屉里点不开的幽灵会话——点击时
// sessionFileExists/isSafeSessionId 才拒绝。补齐入口必须与其他读盘点同一口径。
test('SDK 快路径: 盘上总数已够、SDK 触顶全是幽灵时 hasMore 不得假报', async () => {
  const cwd = '/sdk/hasmore-ghosts';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  for (let i = 0; i < 4; i++) writeJSONL(dir, `s${i}`, [{ type: 'user', message: { role: 'user', content: `m${i}` } }]);
  __setSdkListSessionsForTest(async (opts) => {
    const real = Array.from({ length: 4 }, (_, i) => ({ sessionId: `s${i}`, summary: `t${i}`, lastModified: 1000 + i }));
    const ghosts = Array.from({ length: opts.limit }, (_, i) => ({
      sessionId: `ghost-${i}`, summary: `g${i}`, lastModified: 1,
    }));
    return [...real, ...ghosts];
  });
  try {
    const page = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 4 });
    assert.equal(page.total, 4);
    assert.equal(page.sessions.length, 4);
    assert.equal(page.hasMore, false, 'readdir 已给出准确 total 时，不得再用 SDK 触顶猜测 hasMore');
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

test('搜索: query 不把 SDK 窗当候选集——窗外旧会话仍能命中', async () => {
  const cwd = '/sdk/search-beyond-window';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  const nowSec = Date.now() / 1000;
  writeJSONL(dir, 'needle-old', [{
    type: 'user',
    timestamp: new Date(Date.now() - 999_000).toISOString(),
    message: { role: 'user', content: 'UniqueNeedleTitle' },
  }]);
  utimesSync(join(dir, 'needle-old.jsonl'), nowSec - 999, nowSec - 999);
  for (let i = 0; i < 12; i++) {
    const id = `n${String(i).padStart(3, '0')}`;
    writeJSONL(dir, id, [{
      type: 'user',
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      message: { role: 'user', content: `noise ${i}` },
    }]);
    utimesSync(join(dir, `${id}.jsonl`), nowSec - i, nowSec - i);
  }
  __setSdkListSessionsForTest(async () => Array.from({ length: 5 }, (_, i) => ({
    sessionId: `n${String(i).padStart(3, '0')}`,
    summary: `noise ${i}`,
    lastModified: Date.now() - i * 1000,
  })));
  try {
    const found = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 50, query: 'UniqueNeedle' });
    assert.equal(found.sessions.length, 1);
    assert.equal(found.sessions[0].id, 'needle-old');
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

// #451：SDK listSessions 的 includeWorktrees 缺省 true，会跑 git worktree list 再把每棵 worktree 的会话都返回。
// 成员目录的并入本模块自己做（listProjectMemberDirs），SDK 再展开一次只会让别棵树的会话占掉候选窗、随后被归属过滤丢掉。
test('SDK 快路径与搜索 overlay: 两处 listSessions 都关掉 worktree 展开', async () => {
  const cwd = '/sdk/no-worktree-expand';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  writeJSONL(dir, 'w-1', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  const calls = [];
  __setSdkListSessionsForTest(async (opts) => { calls.push(opts); return [{ sessionId: 'w-1', summary: 'hi', lastModified: Date.now() }]; });
  try {
    await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    const listCalls = calls.splice(0);
    await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5, query: 'hi' });
    const searchCalls = calls.splice(0);
    assert.ok(listCalls.length > 0 && searchCalls.length > 0, '列表和搜索都该走到 SDK listSessions，否则下面的断言是空过');
    for (const [where, got] of [['列表快路径', listCalls], ['搜索 overlay', searchCalls]]) {
      assert.ok(got.every(o => o.includeWorktrees === false),
        `${where}没关 includeWorktrees：别棵 worktree 的会话会挤占本目录的候选窗，实际传参 ${JSON.stringify(got)}`);
    }
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

// PR #333 review：抽屉「加载更多」到 500 时显示的是 SDK summary（/rename 后的标题）。搜索的 overlay 只要 51 条的话，
// 第 52 名以后改过名的会话在抽屉里看得到新标题、按它却搜不到。overlay 要覆盖到浏览窗的硬顶。
test('搜索: 排在 51 名以外、/rename 过的会话按抽屉显示的标题也搜得到', async () => {
  const cwd = '/sdk/search-overlay-beyond-51';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  const nowSec = Date.now() / 1000;
  const ids = [];
  for (let i = 0; i < 120; i++) {
    const id = `r${String(i).padStart(3, '0')}`;
    ids.push(id);
    writeJSONL(dir, id, [{ type: 'user', timestamp: new Date(Date.now() - i * 1000).toISOString(), message: { role: 'user', content: `prompt ${i}` } }]);
    utimesSync(join(dir, `${id}.jsonl`), nowSec - i, nowSec - i);
  }
  // 照 SDK 的行为：按新→旧最多给 limit 条
  __setSdkListSessionsForTest(async (opts) => ids.slice(0, opts.limit).map((id, i) => ({
    sessionId: id,
    summary: id === 'r100' ? 'Renamed Far Away' : `prompt ${i}`,
    lastModified: Date.now() - i * 1000,
  })));
  try {
    const found = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 50, query: 'Renamed Far' });
    assert.deepEqual(found.sessions.map(s => s.id), ['r100'], '抽屉里显示得出的新标题，搜索却搜不到');
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

test('搜索: 按抽屉可见的 SDK summary 能命中，firstUser 也能命中，展示用 summary', async () => {
  const cwd = '/sdk/search-summary-overlay';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  writeJSONL(dir, 'sid-renamed', [{
    type: 'user',
    message: { role: 'user', content: 'hello world from the first prompt' },
  }]);
  __setSdkListSessionsForTest(async () => [
    { sessionId: 'sid-renamed', summary: 'Renamed Visible Title', lastModified: Date.now() },
  ]);
  try {
    const byVisible = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 10, query: 'Renamed Visible' });
    assert.equal(byVisible.sessions.length, 1);
    assert.equal(byVisible.sessions[0].id, 'sid-renamed');
    assert.equal(byVisible.sessions[0].title, 'Renamed Visible Title', '搜索结果标题必须与浏览行同源');

    const byUser = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 10, query: 'hello world' });
    assert.equal(byUser.sessions.length, 1);
    assert.equal(byUser.sessions[0].id, 'sid-renamed');
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

test('SDK 漏报补齐: 非法 sessionId 形态的 jsonl 不得混进列表', async () => {
  const cwd = '/sdk/no-summary-unsafe';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  const noMsg = [{ type: 'queue-operation', operation: 'enqueue' }];
  writeJSONL(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', noMsg); // 合法形态
  writeJSONL(dir, 'backup.2026-08-05', noMsg);                     // 含点：非法
  writeJSONL(dir, 'note wtf', noMsg);                              // 含空格：非法
  __setSdkListSessionsForTest(async () => []);
  try {
    const { sessions } = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 10 });
    const ids = sessions.map(s => s.id);
    assert.ok(ids.includes('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), '合法会话照常补齐');
    assert.ok(!ids.some(id => id.includes('.') || id.includes(' ')), `非法形态不得进列表，实际: ${ids}`);
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

// 通知横幅对齐抽屉浏览行：getSessionInfo.summary 就是 listSessions 映射到 title 的那串。
test('peekSessionListTitle: 生产快路径用 getSessionInfo.summary，与抽屉 SDK title 同源', async () => {
  const cwd = '/sdk/peek-title';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  writeJSONL(dir, 'sid-peek', [{ type: 'user', message: { role: 'user', content: '第一句用户原话很长不该出现在横幅优先位' } }]);
  let captured;
  __setSdkGetSessionInfoForTest(async (id, opts) => {
    captured = { id, dir: opts?.dir };
    return { sessionId: id, summary: 'CLI /resume 同款标题', lastModified: Date.now() };
  });
  try {
    const title = await peekSessionListTitle(cwd, 'sid-peek');
    assert.equal(captured.id, 'sid-peek');
    assert.equal(captured.dir, cwd, 'dir 必须传原始 cwd，与 listSessions 同坑');
    assert.equal(title, 'CLI /resume 同款标题');
  } finally {
    __setSdkGetSessionInfoForTest(undefined);
    rmProjectDir(dir);
  }
});

test('peekSessionListTitle: getSessionInfo 无 summary → 回落 jsonl 的 ai-title（抽屉漏报补齐同口径）', async () => {
  const cwd = '/sdk/peek-fallback';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  writeJSONL(dir, 'sid-fb', [
    { type: 'user', message: { role: 'user', content: '普通问题' } },
    { type: 'ai-title', aiTitle: '头窗 AI 标题' },
  ]);
  __setSdkGetSessionInfoForTest(async () => undefined);
  try {
    assert.equal(await peekSessionListTitle(cwd, 'sid-fb'), '头窗 AI 标题');
  } finally {
    __setSdkGetSessionInfoForTest(undefined);
    rmProjectDir(dir);
  }
});

// 编码撞名（2026-10-10 review P1）：SDK 按目录列，同一个 project 目录里两个 cwd 的会话会一起回来。
// 只按「jsonl 在不在本目录」过滤挡不住——两边的 jsonl 都在这个目录里。
test('SDK 快路径: 编码撞名时只留 transcript 记的是本 cwd 的会话，total 也按自己的算', async () => {
  const cwd = '/sdk/a-b';
  const other = '/sdk/a/b';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  assert.equal(getProjectDir(other), getProjectDir(cwd), '夹具前提：两个 cwd 编码后同名');
  const ts = '2026-10-10T00:00:00Z';
  writeJSONL(dir, 'mine', [{ type: 'user', cwd, timestamp: ts, message: { role: 'user', content: 'hi' } }]);
  writeJSONL(dir, 'theirs', [{ type: 'user', cwd: other, timestamp: ts, message: { role: 'user', content: 'yo' } }]);
  __setSdkListSessionsForTest(async () => [
    { sessionId: 'mine', summary: '我的', lastModified: 1000 },
    { sessionId: 'theirs', summary: '别人的', lastModified: 2000 },
  ]);
  try {
    const { sessions, total } = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    assert.deepEqual(sessions.map(s => s.id), ['mine'], '别的文件夹的会话混进了列表，点开就在这里 resume');
    assert.equal(total, 1);
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

// ── 列表缓存：按目录内容判失效，不按年龄（2026-10-31 性能计划 2d）──────────────────────────
// 抽屉每 12s 对每个工作区重验一次 session:list。缓存原先按 4s 年龄失效，于是每次重验都整目录重扫
// （实测本机 13 个工作区一轮约 350ms），而这期间绝大多数目录一个字节都没变。反过来，4s 内又挡住了
// 刚落盘的新消息、新会话。下面四条：没变就不重扫；jsonl 名单、大小、mtime 一变，或只有旁路标题变，
// 下一次列表就是新的。后三条用真 SDK listSessions（不 stub），让「SDK 读了哪些文件」由 SDK 自己作答。

// 真 CLI transcript 行的最小形态：真 SDK 要 uuid / sessionId / 主链字段才认它是一条会话
const cliLine = (sessionId, type, text, timestamp) => ({
  type, uuid: `${sessionId}-${type}-${timestamp}`, parentUuid: null, isSidechain: false, sessionId, timestamp,
  message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
});

test('列表缓存: 目录没变时，过了 12s 的重验也不重扫', async (t) => {
  const cwd = '/cache/idle';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  writeJSONL(dir, 'idle-1', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  let scans = 0;
  __setSdkListSessionsForTest(async () => { scans++; return [{ sessionId: 'idle-1', summary: '闲置', lastModified: 1000 }]; });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const first = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    t.mock.timers.tick(13_000);
    const again = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    assert.equal(scans, 1, '目录一个字节没变，12s 后的重验又整目录重扫了一遍');
    assert.deepEqual(again, first);
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmProjectDir(dir);
  }
});

test('列表缓存: 会话里刚写进一条消息，下一次列表就是新的活动时间', async () => {
  const cwd = '/cache/append';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  const sid = '0a0a0a0a-1111-4222-8333-444444444444';
  const t0 = '2026-10-31T01:00:00.000Z';
  const t1 = '2026-10-31T01:05:00.000Z';
  writeJSONL(dir, sid, [cliLine(sid, 'user', '首条', t0)]);
  try {
    const before = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    assert.equal(before.sessions[0]?.lastUsedAt, Date.parse(t0), '夹具前提：真 SDK 列出了这条会话');
    appendFileSync(join(dir, `${sid}.jsonl`), `${JSON.stringify(cliLine(sid, 'assistant', '回复', t1))}\n`);
    const after = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    assert.equal(after.sessions[0]?.lastUsedAt, Date.parse(t1), '文件已经追加了新消息，列表还是缓存里的旧活动时间');
  } finally {
    rmProjectDir(dir);
  }
});

test('列表缓存: 终端里新开的会话，下一次列表就出现', async () => {
  const cwd = '/cache/new-session';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  const a = '0b0b0b0b-1111-4222-8333-444444444444';
  const b = '0c0c0c0c-1111-4222-8333-444444444444';
  writeJSONL(dir, a, [cliLine(a, 'user', '旧会话', '2026-10-31T01:00:00.000Z')]);
  try {
    const before = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    assert.deepEqual(before.sessions.map(s => s.id), [a]);
    writeJSONL(dir, b, [cliLine(b, 'user', '新会话', '2026-10-31T01:05:00.000Z')]);
    const after = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    assert.deepEqual(after.sessions.map(s => s.id), [b, a], '盘上已经有了新会话，列表还是缓存里的旧名单');
  } finally {
    rmProjectDir(dir);
  }
});

// 桌面端改名只写 `<项目目录>/<会话 id>/custom-title.json`，jsonl 一个字节不动；SDK 在 jsonl 尾部没有
// custom-title 时读它当标题（本机有 91 个这样的旁路文件）。只看 jsonl 的缓存会把旧标题一直留到别的会话写盘。
test('列表缓存: 桌面端只改了旁路标题，下一次列表就是新标题', async () => {
  const cwd = '/cache/sidecar-title';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  const sid = '0d0d0d0d-1111-4222-8333-444444444444';
  writeJSONL(dir, sid, [cliLine(sid, 'user', '首条提问', '2026-10-31T01:00:00.000Z')]);
  try {
    const before = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    assert.equal(before.sessions[0]?.title, '首条提问', '夹具前提：真 SDK 列出了这条会话');
    mkdirSync(join(dir, sid), { recursive: true });
    writeFileSync(join(dir, sid, 'custom-title.json'), JSON.stringify({ customTitle: '桌面端改的名' }));
    const after = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    assert.equal(after.sessions[0]?.title, '桌面端改的名', '旁路标题已经改了，列表还是缓存里的旧标题');
  } finally {
    rmProjectDir(dir);
  }
});
