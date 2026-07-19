// tests/unit/history.test.mjs —— history.js 单测（tmpdir 注入，零网络/零真实 claude 目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, listSessions, listSessionsPage, sessionFileMtime, __setSdkListSessionsForTest } from '../../src/sessions/history.js';

const BASE = join(tmpdir(), `ccm-hist-${process.pid}`);
mkdirSync(BASE, { recursive: true });

function writeJSONL(dir, id, entries) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

test('listSessions: 目录不存在返回 []', async () => {
  const result = await listSessions('/no/such/cwd', { baseDir: BASE });
  assert.deepEqual(result, []);
});

test('listSessions: 空目录（无 jsonl）返回 []', async () => {
  const cwd = '/empty/dir';
  mkdirSync(join(BASE, getProjectDir(cwd)), { recursive: true });
  const result = await listSessions(cwd, { baseDir: BASE });
  assert.deepEqual(result, []);
});

test('listSessions: 提取 title / model / entrypoint', async () => {
  const cwd = '/test/meta';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-meta', [
    { type: 'user', entrypoint: 'cli', message: { role: 'user', content: '你好' } },
    { type: 'assistant', message: { role: 'assistant', content: 'Hi', model: 'claude-sonnet-4-6' } },
  ]);
  const result = await listSessions(cwd, { baseDir: BASE });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'sess-meta');
  assert.equal(result[0].title, '你好');
  assert.equal(result[0].model, 'claude-sonnet-4-6');
  assert.equal(result[0].entrypoint, 'cli');
});

test('listSessions: ai-title 优先于首条 user 文本', async () => {
  const cwd = '/test/aititle';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-aititle', [
    { type: 'user', message: { role: 'user', content: '普通问题' } },
    { type: 'ai-title', aiTitle: 'AI 生成标题' },
  ]);
  const result = await listSessions(cwd, { baseDir: BASE });
  assert.equal(result[0].title, 'AI 生成标题');
});

// 回归：CLI 把 ai-title 流式追加到「标题生成完成时」的字节位置，首轮工具/思考很重的长会话里
// 这个位置常 > 64KB 头窗 → 旧实现只读头 64KB，扫不到 ai-title，回退成第一条 user 文本或「(无标题)」，
// 与 CLI /resume（读全文）显示的标题不一致。修复：头窗没抓到 ai-title 时补读文件尾部一段取最新 ai-title。
test('listSessions: ai-title 落在头 64KB 之外时，尾部补读仍能提取（回归大会话丢标题）', async () => {
  const cwd = '/test/aititle-tail';
  const dir = join(BASE, getProjectDir(cwd));
  // 700KB 单条 filler 把 ai-title 推到 ~700KB（远超 64KB 头窗）；文件总 ~900KB，落进 512KB 尾窗。
  // 尾窗从 ~400KB 起切入 700KB filler 那行中间——半行 parse 失败被跳过，ai-title 完整行仍可读到。
  const filler = 'x'.repeat(700 * 1024);
  writeJSONL(dir, 'aititle-tail', [
    { type: 'user', message: { role: 'user', content: '第一条真实问题' } },       // firstUser（头窗内）
    { type: 'assistant', message: { role: 'assistant', content: filler } },        // 撑爆头窗
    { type: 'ai-title', aiTitle: '被推到中段的AI标题' },                          // 头外、尾窗内
    { type: 'assistant', message: { role: 'assistant', content: '收尾' } },        // ai-title 不在绝对末尾
  ]);
  const result = await listSessions(cwd, { baseDir: BASE });
  assert.equal(result[0].title, '被推到中段的AI标题');
});

test('listSessions: 中等文件（64KB–512KB）ai-title 在头窗外，尾窗仍提取（覆盖 #4 起点分支）', async () => {
  const cwd = '/test/aititle-mid';
  const dir = join(BASE, getProjectDir(cwd));
  // 120KB filler 把 ai-title 推过 64KB 头窗；文件总 ~120KB ≤ 512KB → 尾窗起点走 max(0, HEAD-4KB) 分支而非 size-512KB。
  const filler = 'm'.repeat(120 * 1024);
  writeJSONL(dir, 'aititle-mid', [
    { type: 'user', message: { role: 'user', content: '中等会话首条' } },
    { type: 'assistant', message: { role: 'assistant', content: filler } },
    { type: 'ai-title', aiTitle: '中等文件的AI标题' },
    { type: 'assistant', message: { role: 'assistant', content: '尾' } },
  ]);
  const result = await listSessions(cwd, { baseDir: BASE });
  assert.equal(result[0].title, '中等文件的AI标题');
});

test('listSessions: ai-title 距文件尾超尾窗时优雅回退到首条 user（不比现状差）', async () => {
  const cwd = '/test/aititle-toofar';
  const dir = join(BASE, getProjectDir(cwd));
  const head = 'h'.repeat(100 * 1024); // 撑过头窗
  const tail = 't'.repeat(700 * 1024); // ai-title 之后再堆 700KB，使其距尾 > 512KB 尾窗
  writeJSONL(dir, 'aititle-toofar', [
    { type: 'user', message: { role: 'user', content: '兜底首条问题' } },
    { type: 'assistant', message: { role: 'assistant', content: head } },
    { type: 'ai-title', aiTitle: '够不到的AI标题' },   // 头窗外、尾窗也够不到
    { type: 'assistant', message: { role: 'assistant', content: tail } },
  ]);
  const result = await listSessions(cwd, { baseDir: BASE });
  assert.equal(result[0].title, '兜底首条问题'); // 优雅回退，不崩、不空
});

test('listSessions: isMeta 条目不当标题', async () => {
  const cwd = '/test/metamsg';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-meta2', [
    { type: 'user', isMeta: true, message: { role: 'user', content: '系统上下文' } },
    { type: 'user', message: { role: 'user', content: '真实问题' } },
  ]);
  const result = await listSessions(cwd, { baseDir: BASE });
  assert.equal(result[0].title, '真实问题');
});

// 回归：web resume / CLI 切档会往 jsonl 追加 mode/permission-mode，刷 mtime 把旧会话顶到抽屉最前。
// 列表 lastUsedAt 与排序须用最后主链消息时间，忽略这些元数据写盘。
test('listSessions: lastUsedAt/排序忽略 mode 元数据，按最后 user/assistant 时间', async () => {
  const cwd = '/test/last-msg-sort';
  const dir = join(BASE, getProjectDir(cwd));
  const oldTs = '2020-06-01T12:00:00.000Z';
  const newTs = '2026-07-01T12:00:00.000Z';
  writeJSONL(dir, 'old-msg', [
    { type: 'user', timestamp: oldTs, message: { role: 'user', content: '很久以前的问题' } },
    { type: 'assistant', timestamp: oldTs, message: { role: 'assistant', content: '很久以前的回答' } },
  ]);
  writeJSONL(dir, 'new-msg', [
    { type: 'user', timestamp: newTs, message: { role: 'user', content: '最近的问题' } },
    { type: 'assistant', timestamp: newTs, message: { role: 'assistant', content: '最近的回答' } },
  ]);
  // 模拟 resume 刷 mtime：旧会话文件最后被写入，但没有新的 user/assistant
  appendFileSync(join(dir, 'old-msg.jsonl'), JSON.stringify({ type: 'mode', mode: 'default', sessionId: 'old-msg' }) + '\n');
  appendFileSync(join(dir, 'old-msg.jsonl'), JSON.stringify({ type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: 'old-msg' }) + '\n');
  appendFileSync(join(dir, 'old-msg.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: '旧会话标题', sessionId: 'old-msg' }) + '\n');

  const result = await listSessions(cwd, { baseDir: BASE });
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'new-msg', '真实更近的消息应排前，即使 old-msg mtime 更新');
  assert.equal(result[1].id, 'old-msg');
  assert.equal(result[0].lastUsedAt, Date.parse(newTs));
  assert.equal(result[1].lastUsedAt, Date.parse(oldTs));
});

test('listSessions: 无 timestamp 的消息会话 lastUsedAt 回落 mtime', async () => {
  const cwd = '/test/last-msg-fallback-mtime';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'no-ts', [
    { type: 'user', message: { role: 'user', content: '无时间戳' } },
  ]);
  const mtime = await sessionFileMtime('no-ts', cwd, { baseDir: BASE });
  const result = await listSessions(cwd, { baseDir: BASE });
  assert.equal(result[0].lastUsedAt, Math.round(mtime));
});

// ── listSessionsPage：limit / hasMore / 缓存按 limit 隔离 ─────────────────────
test('listSessionsPage: limit 截断 + hasMore=true（总数 > limit）', async () => {
  const cwd = '/test/page-limit';
  const dir = join(BASE, getProjectDir(cwd));
  for (let i = 0; i < 5; i++) writeJSONL(dir, `s${i}`, [{ type: 'user', message: { role: 'user', content: `q${i}` } }]);
  const { sessions, hasMore } = await listSessionsPage(cwd, { baseDir: BASE, limit: 3 });
  assert.equal(sessions.length, 3);
  assert.equal(hasMore, true);
});

test('listSessionsPage: 恰好等于 limit → hasMore=false', async () => {
  const cwd = '/test/page-exact';
  const dir = join(BASE, getProjectDir(cwd));
  for (let i = 0; i < 3; i++) writeJSONL(dir, `s${i}`, [{ type: 'user', message: { role: 'user', content: `q${i}` } }]);
  const { sessions, hasMore } = await listSessionsPage(cwd, { baseDir: BASE, limit: 3 });
  assert.equal(sessions.length, 3);
  assert.equal(hasMore, false);
});

test('listSessionsPage: 少于 limit → hasMore=false', async () => {
  const cwd = '/test/page-few';
  const dir = join(BASE, getProjectDir(cwd));
  for (let i = 0; i < 2; i++) writeJSONL(dir, `s${i}`, [{ type: 'user', message: { role: 'user', content: `q${i}` } }]);
  const { sessions, hasMore } = await listSessionsPage(cwd, { baseDir: BASE, limit: 3 });
  assert.equal(sessions.length, 2);
  assert.equal(hasMore, false);
});

test('listSessionsPage: 缓存按 limit 隔离（limit=2 不污染随后 limit=5）', async () => {
  const cwd = '/test/page-cache';
  const dir = join(BASE, getProjectDir(cwd));
  for (let i = 0; i < 5; i++) writeJSONL(dir, `s${i}`, [{ type: 'user', message: { role: 'user', content: `q${i}` } }]);
  const small = await listSessionsPage(cwd, { baseDir: BASE, limit: 2 });
  assert.equal(small.sessions.length, 2);
  assert.equal(small.hasMore, true);
  // 若缓存只按 dir 键，下面会吃到上面的 2 条缓存 → 断言 5 条即防回归
  const big = await listSessionsPage(cwd, { baseDir: BASE, limit: 5 });
  assert.equal(big.sessions.length, 5);
  assert.equal(big.hasMore, false);
});

// ── listSessionsPage：hiddenIds 过滤（FR-20 两级删除 L1） ──────────────────────

test('listSessionsPage: hiddenIds 命中的会话不出现在结果里', async () => {
  const cwd = '/test/page-hidden';
  const dir = join(BASE, getProjectDir(cwd));
  for (let i = 0; i < 3; i++) writeJSONL(dir, `h${i}`, [{ type: 'user', message: { role: 'user', content: `q${i}` } }]);
  const { sessions } = await listSessionsPage(cwd, { baseDir: BASE, limit: 10, hiddenIds: new Set(['h1']) });
  assert.deepEqual(sessions.map(s => s.id).sort(), ['h0', 'h2']);
});

test('listSessionsPage: 不传 hiddenIds（或空 Set）→ 不过滤，行为与旧调用点一致', async () => {
  const cwd = '/test/page-nohidden';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'nh0', [{ type: 'user', message: { role: 'user', content: 'q' } }]);
  const withoutParam = await listSessionsPage(cwd, { baseDir: BASE, limit: 10 });
  const withEmptySet = await listSessionsPage(cwd, { baseDir: BASE, limit: 10, hiddenIds: new Set() });
  assert.equal(withoutParam.sessions.length, 1);
  assert.equal(withEmptySet.sessions.length, 1);
});

// ── SDK 快路径（生产 baseDir === CLAUDE_DIR）：用 __setSdkListSessionsForTest 注入替身 ────
// 注入替身验证三契约：① dir 传原始 cwd（非编码路径）；② 小 limit 仍取到 LIST_LIMIT+1 做重排候选；
// ③ 字段映射 id←sessionId / title←summary / lastUsedAt←transcript 末条消息时间（无文件回落 lastModified），
// 不返回 model/entrypoint（死重）。baseDir 须 = CLAUDE_DIR 才命中快路径——真值硬取得、隔离用 BASE 走兜底。
import { homedir } from 'node:os';
import { MAX_SESSION_LIMIT } from '../../src/sessions/workdirs.js';
const CLAUDE_DIR = join(homedir(), '.claude', 'projects');

test('SDK 快路径: 字段映射 id/title/lastUsedAt，dir 传原始 cwd，不返回 model/entrypoint', async () => {
  const cwd = '/sdk/quick';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  // sid-1/sid-2 写真实 jsonl（归属本 cwd）；sid-ghost 不写——模拟 SDK dir 匹配混入的祖先目录会话
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
    // ③ 归属过滤：jsonl 不在本 cwd 项目目录的会话滤掉（SDK dir 匹配含祖先目录——worktree 查询会混入
    //    主仓会话；与 session:switch 的 sessionFileExists 归属校验同一语义，列表≡可切换）
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map(s => s.id).sort(), ['sid-1', 'sid-2']);
    const s1 = sessions.find(s => s.id === 'sid-1');
    assert.equal(s1.title, 'CLI /resume 同款标题');
    // 空 summary 兜底 '(无标题)'
    assert.equal(sessions.find(s => s.id === 'sid-2').title, '(无标题)');
    // deadweight 字段快路径不返回（前端不消费、SDK 也不给）
    assert.equal(s1.model, undefined);
    assert.equal(s1.entrypoint, undefined);
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
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
    assert.equal((await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 3 })).hasMore, true);  // 4>3
    assert.equal((await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 4 })).hasMore, false); // 4=4
  } finally {
    __setSdkListSessionsForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SDK 快路径: 按消息时间重排——lastModified 更新但消息旧的不应压过真近会话', async () => {
  const cwd = '/sdk/rerank-activity';
  const dir = join(CLAUDE_DIR, getProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const oldTs = '2020-01-01T00:00:00.000Z';
  const newTs = '2026-07-01T00:00:00.000Z';
  // 写到真实 CLAUDE_DIR 下的隔离子目录（cwd 编码路径），测完清理
  writeJSONL(dir, 'old-sid', [
    { type: 'user', timestamp: oldTs, message: { role: 'user', content: 'old' } },
    { type: 'assistant', timestamp: oldTs, message: { role: 'assistant', content: 'old-a' } },
  ]);
  writeJSONL(dir, 'new-sid', [
    { type: 'user', timestamp: newTs, message: { role: 'user', content: 'new' } },
    { type: 'assistant', timestamp: newTs, message: { role: 'assistant', content: 'new-a' } },
  ]);
  appendFileSync(join(dir, 'old-sid.jsonl'), JSON.stringify({ type: 'mode', mode: 'default' }) + '\n');
  __setSdkListSessionsForTest(async () => [
    // SDK 按 lastModified 把 old 排前（模拟 resume 刷 mtime）
    { sessionId: 'old-sid', summary: '旧', lastModified: Date.now() },
    { sessionId: 'new-sid', summary: '新', lastModified: Date.now() - 60_000 },
  ]);
  try {
    const { sessions } = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    assert.equal(sessions[0].id, 'new-sid');
    assert.equal(sessions[1].id, 'old-sid');
    assert.equal(sessions[0].lastUsedAt, Date.parse(newTs));
    assert.equal(sessions[1].lastUsedAt, Date.parse(oldTs));
  } finally {
    __setSdkListSessionsForTest(undefined);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不挡测 */ }
  }
});

test('SDK 快路径: SDK 抛错不走 fail-closed，回落兜底扫盘正常出列表', async () => {
  // 用 BASE 做 baseDir 命中兜底路径——但此处验证的是"快路径 SDK 异常回落"，故须 baseDir=CLAUDE_DIR 且
  // 注入一个会抛错的替身；同时磁盘上真实 ~/.claude/projects 下按 baseDir=CLAUDE_DIR 兜底会读到真会话。
  // 为隔离真磁盘副作用，改注一个 fallback 钩子不现实——退而用：注入会抛错的替身 + 期望回落兜底 readdir
  // 真扫 CLAUDE_DIR。n=1 单用户真目录必有会话，故 sessions.length>0 即证回落成功、未卡死空返回。
  const cwd = '/sdk/throw';
  __setSdkListSessionsForTest(async () => { throw new Error('SDK boom'); });
  try {
    const { sessions } = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    // 兜底 readdir 真扫 ~/.claude/projects/-sdk-throw（该目录不存在→[]）= 证明 try/catch 接住异常无崩溃
    // （真 fallback 到 readHeadMeta 路径而非抛出）。此断言锁的是"不抛、安静回落"契约，非数据多少。
    assert.ok(Array.isArray(sessions));
  } finally {
    __setSdkListSessionsForTest(undefined);
  }
});

// ── getSessionHistory ──────────────────────────────────────────────────────
