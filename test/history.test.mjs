// test/history.test.mjs —— history.js 单测（tmpdir 注入，零网络/零真实 claude 目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, listSessions, listSessionsPage, sessionFileExists, sessionFileSize, sessionFileMtime, getSessionHistory, HISTORY_MAX_MESSAGES, catchUpStep, rebaselineAbsorbedExternal, classifyTranscriptTail, lastPermissionMode, readLastPermissionMode, __setSdkListSessionsForTest } from '../history.js';

const BASE = join(tmpdir(), `ccm-hist-${process.pid}`);
mkdirSync(BASE, { recursive: true });

function writeJSONL(dir, id, entries) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// ── getProjectDir ──────────────────────────────────────────────────────────

test('getProjectDir: 斜杠与点替换为 -', () => {
  assert.equal(getProjectDir('/Users/you/code'), '-Users-you-code');
  assert.equal(getProjectDir('/tmp/foo.bar'), '-tmp-foo-bar');
});

test('getProjectDir: 下划线也替换为 -（仅保留字母数字）', () => {
  assert.equal(getProjectDir('/a/b_c'), '-a-b-c');
});

test('getProjectDir: 纯字母数字路径原样', () => {
  assert.equal(getProjectDir('abc123'), 'abc123');
});

// ── sessionFileExists ──────────────────────────────────────────────────────

test('sessionFileExists: 含 . 的路径穿越被拒', async () => {
  assert.equal(await sessionFileExists('/cwd', '../etc/passwd', { baseDir: BASE }), false);
  assert.equal(await sessionFileExists('/cwd', '../../foo', { baseDir: BASE }), false);
  assert.equal(await sessionFileExists('/cwd', 'foo.jsonl', { baseDir: BASE }), false);
});

test('sessionFileExists: 含 / 的路径穿越被拒', async () => {
  assert.equal(await sessionFileExists('/cwd', 'foo/bar', { baseDir: BASE }), false);
  assert.equal(await sessionFileExists('/cwd', '/absolute/path', { baseDir: BASE }), false);
});

test('sessionFileExists: 空串被拒', async () => {
  assert.equal(await sessionFileExists('/cwd', '', { baseDir: BASE }), false);
});

test('sessionFileExists: 合法 id 但文件不存在返回 false', async () => {
  assert.equal(await sessionFileExists('/cwd', 'no-such-session', { baseDir: BASE }), false);
});

test('sessionFileExists: 文件存在时返回 true', async () => {
  const cwd = '/test/exists';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'session-abc', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  assert.equal(await sessionFileExists(cwd, 'session-abc', { baseDir: BASE }), true);
});

// ── sessionFileSize（只读镜像锁 keep-alive 判活用；注意参数序 (sessionId, cwd) 与 sessionFileExists 相反）──

test('sessionFileSize: 非法 id（路径穿越 / 空串）→ -1', async () => {
  assert.equal(await sessionFileSize('../etc/passwd', '/cwd', { baseDir: BASE }), -1);
  assert.equal(await sessionFileSize('foo/bar', '/cwd', { baseDir: BASE }), -1);
  assert.equal(await sessionFileSize('foo.jsonl', '/cwd', { baseDir: BASE }), -1);
  assert.equal(await sessionFileSize('', '/cwd', { baseDir: BASE }), -1);
});

test('sessionFileSize: 合法 id 但文件不存在 → -1', async () => {
  assert.equal(await sessionFileSize('no-such-session', '/cwd', { baseDir: BASE }), -1);
});

test('sessionFileSize: 文件存在 → 正字节数；追加后变大（keep-alive 判活的依据）', async () => {
  const cwd = '/test/size';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-1', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  const s1 = await sessionFileSize('sess-1', cwd, { baseDir: BASE });
  assert.ok(s1 > 0, '存在的文件应返回正字节数');
  // 追加一条【纯 tool_use】（不进 getSessionHistory 的 text-only len）→ 文件仍变大：
  // 这正是治本的核心前提——终端跑工具时历史 len 不动、但 size 在长。
  writeJSONL(dir, 'sess-1', [
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
  ]);
  const s2 = await sessionFileSize('sess-1', cwd, { baseDir: BASE });
  assert.ok(s2 > s1, '追加 tool_use 条目后 size 应变大（终端跑工具期间 keep-alive 据此判活）');
});

// ── sessionFileMtime（L2 删除活跃保护②用，FR-20） ──────────────────────────────

test('sessionFileMtime: 非法 id（路径穿越 / 空串）→ -1', async () => {
  assert.equal(await sessionFileMtime('../etc/passwd', '/cwd', { baseDir: BASE }), -1);
  assert.equal(await sessionFileMtime('', '/cwd', { baseDir: BASE }), -1);
});

test('sessionFileMtime: 合法 id 但文件不存在 → -1', async () => {
  assert.equal(await sessionFileMtime('no-such-session', '/cwd', { baseDir: BASE }), -1);
});

test('sessionFileMtime: 文件存在 → 正数 mtimeMs', async () => {
  const cwd = '/test/mtime';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-mtime', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  const m = await sessionFileMtime('sess-mtime', cwd, { baseDir: BASE });
  assert.ok(m > 0);
});

// ── listSessions ───────────────────────────────────────────────────────────

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
// 注入替身验证三契约：① dir 传原始 cwd（非编码路径）；② limit 传 limit+1（判 hasMore）；③ 字段映射
// id←sessionId / title←summary / lastUsedAt←Math.round(lastModified)，不返回 model/entrypoint（死重）。
// baseDir 须 = CLAUDE_DIR（~/.claude/projects）才命中快路径——真值硬取得、隔离用 BASE 走兜底（上面已覆盖）。
import { homedir } from 'node:os';
const CLAUDE_DIR = join(homedir(), '.claude', 'projects');

test('SDK 快路径: 字段映射 id/title/lastUsedAt，dir 传原始 cwd，不返回 model/entrypoint', async () => {
  const cwd = '/sdk/quick';
  let captured;
  __setSdkListSessionsForTest(async (opts) => {
    captured = opts;
    return [
      { sessionId: 'sid-1', summary: 'CLI /resume 同款标题', lastModified: 1784098212405 },
      { sessionId: 'sid-2', summary: '', lastModified: 1784098212400 },
    ];
  });
  try {
    const { sessions } = await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 5 });
    // ① dir 传原始 cwd（铁证坑：传编码路径会让 SDK 返回空）
    assert.equal(captured.dir, cwd);
    assert.equal(captured.limit, 6); // limit+1 判 hasMore
    // ③ 字段映射
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].id, 'sid-1');
    assert.equal(sessions[0].title, 'CLI /resume 同款标题');
    assert.equal(sessions[0].lastUsedAt, 1784098212405);
    // 空 summary 兜底 '(无标题)'
    assert.equal(sessions[1].title, '(无标题)');
    // deadweight 字段快路径不返回（前端不消费、SDK 也不给）
    assert.equal(sessions[0].model, undefined);
    assert.equal(sessions[0].entrypoint, undefined);
  } finally {
    __setSdkListSessionsForTest(undefined);
  }
});

test('SDK 快路径: limit+1 多取一条 → hasMore=true；恰好等于则 false', async () => {
  const cwd = '/sdk/hasmore';
  __setSdkListSessionsForTest(async (opts) => {
    const n = Math.min(opts.limit, 4); // 模拟磁盘共 4 条
    return Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, summary: `t${i}`, lastModified: 1000 + i }));
  });
  try {
    assert.equal((await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 3 })).hasMore, true);  // 取 4>3
    assert.equal((await listSessionsPage(cwd, { baseDir: CLAUDE_DIR, limit: 4 })).hasMore, false); // 取 4=4
  } finally {
    __setSdkListSessionsForTest(undefined);
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

test('getSessionHistory: 文件不存在返回 []', async () => {
  const result = await getSessionHistory('no-such-id', '/no/cwd', 50, { baseDir: BASE });
  assert.deepEqual(result, []);
});

test('getSessionHistory: 空文件返回 []', async () => {
  const cwd = '/test/empty-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'empty-sess', []);
  const result = await getSessionHistory('empty-sess', cwd, 50, { baseDir: BASE });
  assert.deepEqual(result, []);
});

test('getSessionHistory: 提取 user / assistant 消息', async () => {
  const cwd = '/test/basic-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'basic', [
    { type: 'user', message: { role: 'user', content: '你好' }, timestamp: '2024-01-01T00:00:00Z' },
    { type: 'assistant', message: { role: 'assistant', content: '你好！' }, timestamp: '2024-01-01T00:00:01Z' },
  ]);
  const msgs = await getSessionHistory('basic', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, '你好');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content, '你好！');
});

test('getSessionHistory: isMeta 条目被过滤', async () => {
  const cwd = '/test/meta-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'metahist', [
    { type: 'user', isMeta: true, message: { role: 'user', content: '系统注入' } },
    { type: 'user', message: { role: 'user', content: '真实消息' } },
  ]);
  const msgs = await getSessionHistory('metahist', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, '真实消息');
});

test('getSessionHistory: type:mode 记录（claude --resume 写入）被过滤、不当消息', async () => {
  // 回归护栏：web 端 resume 会话时 claude --resume 会向 transcript 追加一条 {type:'mode'} 权限模式记录
  // 并刷新 mtime。该记录不得进入历史消息流——否则会改变消息长度、令只读追平 catchUpStep 把「己方 resume
  // 的写盘」误判成外部（终端）新消息而误锁只读。这是本轮「纯 web 打开会话被误锁」修复所依赖的不变式。
  const cwd = '/test/mode-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'modehist', [
    { type: 'user', message: { role: 'user', content: '真实消息' } },
    { type: 'mode', mode: 'default' },  // claude --resume 启动时写入
  ]);
  const msgs = await getSessionHistory('modehist', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, '真实消息');
});

test('getSessionHistory: 纯工具调用输出为 tool_use / tool_result 结构化条目（冷路径可重建卡片）', async () => {
  const cwd = '/test/tool-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'toolhist', [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] }, timestamp: '2026-07-13T10:00:00.000Z' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok\n', is_error: false }] }, timestamp: '2026-07-13T10:00:01.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: '真实回复' }, timestamp: '2026-07-13T10:00:02.000Z' },
  ]);
  const msgs = await getSessionHistory('toolhist', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].kind, 'tool_use');
  assert.equal(msgs[0].name, 'Bash');
  assert.equal(msgs[0].toolUseId, 'x');
  assert.ok(String(msgs[0].inputSummary || '').includes('ls'));
  assert.equal(msgs[1].kind, 'tool_result');
  assert.equal(msgs[1].toolUseId, 'x');
  assert.equal(msgs[1].ok, true);
  assert.ok(String(msgs[1].outputSummary || '').includes('ok'));
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[2].content, '真实回复');
  assert.equal(msgs[2].kind, undefined);
});

test('getSessionHistory: 同一 assistant 消息内 text + tool_use 按块序拆成多条', async () => {
  const cwd = '/test/tool-mixed';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'mixed', [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '先说明一下' },
          { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
          { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/tmp/b.ts' } },
        ],
      },
      timestamp: '2026-07-13T11:00:00.000Z',
    },
  ]);
  const msgs = await getSessionHistory('mixed', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].content, '先说明一下');
  assert.equal(msgs[1].kind, 'tool_use');
  assert.equal(msgs[1].toolUseId, 'r1');
  assert.equal(msgs[2].kind, 'tool_use');
  assert.equal(msgs[2].toolUseId, 'r2');
});

test('getSessionHistory: tool_result is_error=true → ok:false；thinking 块不进历史', async () => {
  const cwd = '/test/tool-err';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'toolerr', [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '很长的思考……' },
          { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/x' } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'Error: denied', is_error: true }],
      },
    },
  ]);
  const msgs = await getSessionHistory('toolerr', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].kind, 'tool_use');
  assert.equal(msgs[0].name, 'Edit');
  assert.equal(msgs[1].kind, 'tool_result');
  assert.equal(msgs[1].ok, false);
  assert.ok(!msgs.some(m => m.kind === 'thinking' || (m.content && String(m.content).includes('很长的思考'))));
});

test('getSessionHistory: <task-notification> 注入条目被过滤（不回显成 XML 气泡）', async () => {
  const cwd = '/test/tasknotif-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'tasknotif', [
    { type: 'user', message: { role: 'user', content: '跑个后台任务' } },
    { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>w60</task-id>\n</task-notification>' } },
    { type: 'assistant', message: { role: 'assistant', content: '后台任务结果汇报如下' } },
  ]);
  const msgs = await getSessionHistory('tasknotif', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].content, '跑个后台任务');
  assert.equal(msgs[1].content, '后台任务结果汇报如下');
});

test('getSessionHistory: 以 <task-notification> 开头但无闭合标签的普通消息不被过滤（收紧误伤）', async () => {
  const cwd = '/test/tasknotif-bare';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'bare', [
    { type: 'user', message: { role: 'user', content: '<task-notification> 这个标签是什么意思？帮我看看' } }, // 无 </task-notification>
  ]);
  const msgs = await getSessionHistory('bare', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 1, '无闭合标签=真实用户消息，应保留');
  assert.ok(msgs[0].content.includes('这个标签是什么意思'));
});

test('getSessionHistory: CLI 系统行（isMeta=false 的 interrupt / 空 turn / 命令输出）被过滤', async () => {
  // 回归护栏：<local-command-stdout>（本地命令的执行输出，非用户输入）、[Request interrupted by user]
  // （打断标记）、assistant 的 'No response requested.'（Continue/继续 触发的 resume 空 turn）均
  // isMeta=false，会漏过上面的 isMeta 闸、被当成 user/assistant 气泡回显。这些都不是对话内容，必须过滤。
  // 注：<command-name>/<command-message>/<command-args>（slash 命令本身的调用块）不在此列——见下方
  // 「slash 命令块重建」测试：那才是用户实际打出的那一行，磁盘上唯一留存处，不该被当噪音丢弃。
  // fixture 全部不带 isMeta，复刻 CLI 真实形态——否则测试会像旧版一样自带 isMeta=true 而测不出该 bug。
  const cwd = '/test/cli-noise-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'clinoise', [
    { type: 'user', message: { role: 'user', content: '真实提问' } },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to Opus 4.8 (default)</local-command-stdout>' } },
    { type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } },
    { type: 'user', message: { role: 'user', content: '[Request interrupted by user for tool use]' } },
    { type: 'assistant', message: { role: 'assistant', content: 'No response requested.' } },
    { type: 'assistant', message: { role: 'assistant', content: '真实回答' } },
  ]);
  const msgs = await getSessionHistory('clinoise', cwd, 50, { baseDir: BASE });
  assert.deepEqual(msgs.map(m => m.content), ['真实提问', '真实回答'], 'CLI 系统噪音行不得回显成气泡');
});

test('getSessionHistory: slash 命令块（<command-name>/<command-args>）重建成 "/命令名 参数" 文本，不再整体丢弃', async () => {
  // 7/12 真实事故：自定义项目命令（如 /deep-research <query>）落盘时用的是和内置命令（/model /effort）
  // 完全相同的 <command-message>/<command-name>/<command-args> 标签块——此前 isCliSystemLine 把这整块
  // 当"CLI 噪音"一律丢弃，而对自定义命令，这个标签块是磁盘上唯一留存用户原话的地方，一丢就是把用户
  // 那一整个回合连根拔掉（切会话再切回/刷新页面走磁盘回放路径时整体消失，只剩 assistant 气泡）。
  // 终端等价性要求：无论内置命令还是自定义命令，都该像终端里那样显示成一行 "/command-name args"，
  // 而非被当噪音丢弃、也非原样吐出裸 XML 标签。
  // 配对的 isMeta=true 展开条目（完整 prompt 模板）依然应被 isMeta 闸过滤——那条是合成内容，不是用户输入，
  // 显示出来只会是更多噪音（一大坨 workflow 模板），不在本次修复范围内。
  const cwd = '/test/slash-command-rebuild';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'slashcmd', [
    // 真实磁盘样本的标签顺序（<command-message> 在前）——自定义项目命令，带参数
    { type: 'user', message: { role: 'user', content: '<command-message>deep-research</command-message>\n<command-name>/deep-research</command-name>\n<command-args>判定一个软件是否在提审服泄露所需要数据都有哪些</command-args>' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'Run the "deep-research" workflow...\n\nInvoke: Workflow({...})' } },
    { type: 'assistant', message: { role: 'assistant', content: '深度研究工作流已启动' } },
    // 旧测试 fixture 的标签顺序（<command-name> 在前）——内置命令，空参数：验证重建不依赖标签顺序、空参数不留多余空格
    { type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>' } },
    { type: 'assistant', message: { role: 'assistant', content: '真实回答' } },
  ]);
  const msgs = await getSessionHistory('slashcmd', cwd, 50, { baseDir: BASE });
  assert.deepEqual(msgs.map(m => m.content), [
    '/deep-research 判定一个软件是否在提审服泄露所需要数据都有哪些',
    '深度研究工作流已启动',
    '/model',
    '真实回答',
  ], 'slash 命令块应重建为可读文本并保留；配对的 isMeta 展开条目仍应被过滤');
});

test('getSessionHistory: 形似系统行的真实消息不被误伤；API Error 作为运行事件保留', async () => {
  // 收紧误伤：只有「以标签开头且闭合」/「整条精确等于标记」才算系统行。用户以这些词开头的真实讨论、
  // 或随口提到，必须保留。API Error（上游/网络错误）是真实运行事件、有诊断价值、性质不同于命令噪音，
  // 明确保留——如需过滤是独立的产品决策，别顺手滤掉。
  const cwd = '/test/cli-noise-safe';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'safe', [
    { type: 'user', message: { role: 'user', content: '帮我解释下 <command-name> 这个标签是干嘛的' } }, // 不以标签开头
    { type: 'assistant', message: { role: 'assistant', content: 'No response requested. 这句在 resume 时代表空 turn' } }, // 非精确整条
    { type: 'assistant', message: { role: 'assistant', content: 'API Error: Unable to connect to API (ECONNRESET)' } }, // 运行事件，保留
  ]);
  const msgs = await getSessionHistory('safe', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 3, '两条真实对话 + 一条 API Error 运行事件，都应保留');
  assert.ok(msgs[0].content.includes('这个标签是干嘛的'));
  assert.ok(msgs[2].content.startsWith('API Error:'));
});

test('getSessionHistory: IDE 集成 / bash 模式注入行（isMeta 缺失）被过滤（实证 code-review #4 漏网）', async () => {
  // 实证：真实 transcript（234 会话）里 CLI 的 IDE 集成注入 <ide_opened_file>/<ide_selection> 与 `!` bash
  // 模式注入 <bash-input>/<bash-stdout>(常内嵌 <bash-stderr>) 共漏 21 条——均 role=user、isMeta 缺失(undefined)、
  // 闭合成对、内容是注入原文（"The user opened the file…" / "sudo bash -c…"），漏过 isMeta 闸当 user 气泡回显。
  // 与 7/10 的 <command-*>/<local-command-*> 同类，当初未覆盖此两族。fixture 复刻真实形态（不带 isMeta）。
  const cwd = '/test/ide-bash-noise';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'idebash', [
    { type: 'user', message: { role: 'user', content: '真实提问' } },
    { type: 'user', message: { role: 'user', content: '<ide_opened_file>The user opened the file /a/b.md</ide_opened_file>' } },
    { type: 'user', message: { role: 'user', content: '<ide_selection>The user selected the lines 1 to 1 from /a/b.md</ide_selection>' } },
    { type: 'user', message: { role: 'user', content: "<bash-input>sudo bash -c 'x'</bash-input>" } },
    { type: 'user', message: { role: 'user', content: '<bash-stdout></bash-stdout><bash-stderr>sudo: a terminal is required</bash-stderr>' } },
    { type: 'assistant', message: { role: 'assistant', content: '真实回答' } },
  ]);
  const msgs = await getSessionHistory('idebash', cwd, 50, { baseDir: BASE });
  assert.deepEqual(msgs.map(m => m.content), ['真实提问', '真实回答'], 'IDE/bash 注入不得回显成气泡');
});

test('getSessionHistory: 形似 ide/bash 标签的真实消息不被误伤（非开头 / 未闭合）', async () => {
  const cwd = '/test/ide-bash-safe';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'idebashsafe', [
    { type: 'user', message: { role: 'user', content: '帮我解释 <ide_opened_file> 这个标签是什么' } }, // 非以标签开头
    { type: 'user', message: { role: 'user', content: '<bash-input> 但我故意不闭合它，这是我随口打的一句话' } }, // 无闭合标签
  ]);
  const msgs = await getSessionHistory('idebashsafe', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 2, '非开头 / 未闭合 = 真实消息，应保留');
});

test('getSessionHistory: 同 uuid 重复落盘去重（interrupt+queue 竞态重复写 → 不显重复气泡）', async () => {
  // 实证 code-review：真实 transcript（234 会话）扫出 1 个会话有 8 条同 uuid 重复落盘（interrupt+queue 竞态），
  // getSessionHistory 无 uuid 去重 → 渲染成重复气泡。uuid 是每条唯一标识：同 uuid = 同一逻辑消息写了两次
  // （非合法重复），按 uuid 去重安全——合法重复内容（如两次「继续」）是不同 uuid、不误删。
  const cwd = '/test/dup-uuid';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'dupuuid', [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: '第一句' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: '回答' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: '回答' } }, // 同 uuid 重复落盘
    { type: 'user', uuid: 'u2', message: { role: 'user', content: '继续' } },
    { type: 'user', uuid: 'u3', message: { role: 'user', content: '继续' } }, // 合法重复内容、不同 uuid → 保留
  ]);
  const msgs = await getSessionHistory('dupuuid', cwd, 50, { baseDir: BASE });
  assert.deepEqual(msgs.map(m => m.content), ['第一句', '回答', '继续', '继续'],
    '同 uuid 去重（「回答」只一次）；不同 uuid 的合法重复保留（「继续」两次）');
});

test('getSessionHistory: 无 uuid 的条目不因 undefined 相撞而互相去重', async () => {
  // 防御：部分旧条目可能无 uuid；不得把它们全当「同 undefined」去重掉。
  const cwd = '/test/no-uuid';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'nouuid', [
    { type: 'user', message: { role: 'user', content: 'A' } },
    { type: 'assistant', message: { role: 'assistant', content: 'B' } },
    { type: 'user', message: { role: 'user', content: 'C' } },
  ]);
  const msgs = await getSessionHistory('nouuid', cwd, 50, { baseDir: BASE });
  assert.deepEqual(msgs.map(m => m.content), ['A', 'B', 'C'], '无 uuid 条目全保留');
});

test('getSessionHistory: 子 agent（isSidechain）记录被过滤，即使带正文（与运行期一致）', async () => {
  const cwd = '/test/sidechain-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sidehist', [
    { type: 'user', message: { role: 'user', content: '主线问题' } },
    // 子 agent 内部消息：磁盘用 isSidechain 标记（parent_tool_use_id 是运行时 SDK 流字段、不落盘）。
    // 带正文的子 agent assistant 若不滤会被当主线回显——与运行期 agent.js 的 parent_tool_use_id 守卫不一致。
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '子 agent 内部输出' }] } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'Warmup' } },
    { type: 'assistant', message: { role: 'assistant', content: '主线回答' } },
  ]);
  const msgs = await getSessionHistory('sidehist', cwd, 50, { baseDir: BASE });
  assert.deepEqual(msgs.map(m => m.content), ['主线问题', '主线回答']);
});

test('getSessionHistory: content 为数组时拼接 text 块', async () => {
  const cwd = '/test/arr-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'arrhist', [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } },
  ]);
  const msgs = await getSessionHistory('arrhist', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, '第一段\n第二段');
});

test('getSessionHistory: limit 参数截取尾部 N 条', async () => {
  const cwd = '/test/limit-hist';
  const dir = join(BASE, getProjectDir(cwd));
  const entries = Array.from({ length: 10 }, (_, i) => ({
    type: 'user', message: { role: 'user', content: `消息 ${i}` }
  }));
  writeJSONL(dir, 'limithist', entries);
  const msgs = await getSessionHistory('limithist', cwd, 3, { baseDir: BASE });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].content, '消息 7');
  assert.equal(msgs[2].content, '消息 9');
});

// ── 完整加载（回归：曾因 1MB 尾部读 + 默认 50 双截断，导致大会话 Web 端只显示尾部，
//    与 CLI /resume 的全量历史不同步）─────────────────────────────────────────

test('getSessionHistory: 文件超 1MB 仍读到最开头的消息（头部不被截断）', async () => {
  const cwd = '/test/big-head-hist';
  const dir = join(BASE, getProjectDir(cwd));
  // 首条放可识别标记，随后用 ~50KB/条填充把文件撑过 1MB——旧实现只读尾部 1MB，会丢掉首条
  const filler = 'x'.repeat(50 * 1024);
  const entries = [{ type: 'user', message: { role: 'user', content: '最开头的消息' } }];
  for (let i = 0; i < 30; i++) {
    entries.push({ type: 'assistant', message: { role: 'assistant', content: `${filler}${i}` } });
  }
  writeJSONL(dir, 'bighead', entries);
  const msgs = await getSessionHistory('bighead', cwd, undefined, { baseDir: BASE });
  assert.equal(msgs.length, 31);
  assert.equal(msgs[0].content, '最开头的消息'); // 头部未被 1MB 截断
});

test('getSessionHistory: 默认 limit 下 >50 条消息全部返回（不砍到 50）', async () => {
  const cwd = '/test/many-hist';
  const dir = join(BASE, getProjectDir(cwd));
  const entries = Array.from({ length: 120 }, (_, i) => ({
    type: 'user', message: { role: 'user', content: `消息 ${i}` }
  }));
  writeJSONL(dir, 'manyhist', entries);
  const msgs = await getSessionHistory('manyhist', cwd, undefined, { baseDir: BASE });
  assert.equal(msgs.length, 120);
  assert.equal(msgs[0].content, '消息 0');
  assert.equal(msgs[119].content, '消息 119');
});

// 超 HISTORY_MAX_MESSAGES 条时削顶到上限——流式阶段封顶（返回上限=内存上限），防超大会话
// 全量常驻 always-on 进程（P2 review）。锁住「削头留尾」的契约：未来若有人改回累积全量或削错方向即红。
test('getSessionHistory: 超上限会话削顶到 HISTORY_MAX_MESSAGES，保留尾部', async () => {
  const cwd = '/test/cap-hist';
  const dir = join(BASE, getProjectDir(cwd));
  const total = HISTORY_MAX_MESSAGES * 2 + 5; // 跨过 2× 批量裁剪阈值，覆盖循环内 + 循环后两段裁剪
  const entries = Array.from({ length: total }, (_, i) => ({
    type: 'user', message: { role: 'user', content: `消息 ${i}` }
  }));
  writeJSONL(dir, 'caphist', entries);
  const msgs = await getSessionHistory('caphist', cwd, undefined, { baseDir: BASE });
  assert.equal(msgs.length, HISTORY_MAX_MESSAGES);                       // 削顶到上限
  assert.equal(msgs[0].content, `消息 ${total - HISTORY_MAX_MESSAGES}`); // 头部被削，首条=倒数第 N 条
  assert.equal(msgs[msgs.length - 1].content, `消息 ${total - 1}`);      // 尾部（最新）保留
});

// ── classifyTranscriptTail：尾部形态判定（单驾驶员模型的核心判据，2026-07-12 实验实证）──────────
// 依据：CLI 每个动作即时落盘——assistant 发起 tool_use 先落、tool_result 回来再落、最终文本收尾落。
// 于是消息链最后一条的形态可直接读出「轮次是否完结」，不依赖磁盘静默时间窗猜测（修「长工具调用
// 期间零写入 >12.5s 被误判成终端停了」）。实测双样本：正在跑的会话判 pending、已结束的判 settled。

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

// ── catchUpStep：只读「追平」状态机 ──────────────────────────────────────────

const M = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));

test('catchUpStep: 持续 idle + 外部增长 → 推超出 baseline 的尾巴', () => {
  const r = catchUpStep({ baseline: 2, wasBusy: false }, { messages: M(5), localBusy: false });
  assert.deepEqual(r.emit.map(m => m.content), ['m2', 'm3', 'm4']);
  assert.deepEqual(r.state, { baseline: 5, wasBusy: false });
});

test('catchUpStep: 无增长 → 不推、baseline 不变', () => {
  const r = catchUpStep({ baseline: 5, wasBusy: false }, { messages: M(5), localBusy: false });
  assert.deepEqual(r.emit, []);
  assert.deepEqual(r.state, { baseline: 5, wasBusy: false });
});

test('catchUpStep: 本地在跑 turn（localBusy）→ 抑制、记 wasBusy、不动 baseline', () => {
  const r = catchUpStep({ baseline: 2, wasBusy: false }, { messages: M(9), localBusy: true });
  assert.deepEqual(r.emit, []);
  assert.deepEqual(r.state, { baseline: 2, wasBusy: true });
});

test('catchUpStep: busy→idle → 吸收己方 turn 写盘（重置 baseline、不推）', () => {
  const r = catchUpStep({ baseline: 2, wasBusy: true }, { messages: M(9), localBusy: false });
  assert.deepEqual(r.emit, []);
  assert.deepEqual(r.state, { baseline: 9, wasBusy: false });
});

test('catchUpStep: 削头边界（len < baseline）→ 保守不推', () => {
  const r = catchUpStep({ baseline: 5, wasBusy: false }, { messages: M(3), localBusy: false });
  assert.deepEqual(r.emit, []);
  assert.deepEqual(r.state, { baseline: 5, wasBusy: false });
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
