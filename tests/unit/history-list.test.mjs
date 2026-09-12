// tests/unit/history-list.test.mjs —— 会话列表的扫描与元数据提取
// listSessions 决定抽屉里看到哪些会话、每条显示什么标题/模型/驱动方，读的是 CLI 写的 JSONL 目录。
// 覆盖：目录不存在/无 jsonl 的空数组回落 · title/model/entrypoint 提取
//       · entrypoint-marker 假行不得冒充真实 entrypoint（判错驱动方会打穿单驾驶员模型）
//       · ai-title 优先于首条 user 文本 · peekSessionListTitle 与 listSessions 同源
// 这份从原 history.test.mjs 拆出，同源的还有 -files（路径编码）、-messages、-sync。
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, listSessions, listSessionsPage, listSessionsByIds, sessionFileMtime, peekSessionListTitle, peekSessionListTitleTimed } from '../../app/src/sessions/history.js';

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

// entrypoint-marker 是本仓自己写的假行（伪装 entrypoint:'cli' 骗 CLI /resume 选择器显示 web 会话，
// 见 app/src/server/app.js writeSessionEntrypoint），恒在文件头、早于真实消息行。readHeadMeta 不该把它
// 当成真实来源——否则所有 web 会话的 entrypoint 全部被误判成 cli（数据层面判错，即使当前无 UI 消费）。
test('listSessions: entrypoint-marker 假行不冒充真实 entrypoint（真实行 sdk-ts 不被 marker 的 cli 抢先）', async () => {
  const cwd = '/test/marker-shadow';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-marker', [
    { type: 'entrypoint-marker', entrypoint: 'cli' },
    { type: 'queue-operation' },
    { type: 'user', entrypoint: 'sdk-ts', message: { role: 'user', content: '你好' } },
    { type: 'assistant', entrypoint: 'sdk-ts', message: { role: 'assistant', content: 'Hi', model: 'claude-sonnet-4-6' } },
  ]);
  const result = await listSessions(cwd, { baseDir: BASE });
  assert.equal(result.length, 1);
  assert.equal(result[0].entrypoint, 'sdk-ts');
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

// 通知横幅对齐抽屉：单会话取标题，不扫整个列表。扫盘路径（测试隔离 baseDir）= readHeadMeta，
// 与 listSessions 同文件的 title 一致（ai-title > firstUser）。
test('peekSessionListTitle: 与 listSessions 同一条会话的 title 一致（ai-title 优先）', async () => {
  const cwd = '/test/peek-drawer-title';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-peek', [
    { type: 'user', message: { role: 'user', content: '普通问题这是第一句' } },
    { type: 'ai-title', aiTitle: '抽屉可见的 AI 标题' },
  ]);
  const listed = await listSessions(cwd, { baseDir: BASE });
  const peeked = await peekSessionListTitle(cwd, 'sess-peek', { baseDir: BASE });
  assert.equal(listed[0].title, '抽屉可见的 AI 标题');
  assert.equal(peeked, listed[0].title);
});

test('peekSessionListTitle: 无 ai-title 时回落首条 user，与抽屉一致', async () => {
  const cwd = '/test/peek-firstuser';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-fu', [
    { type: 'user', message: { role: 'user', content: '帮我修登录页' } },
  ]);
  assert.equal(await peekSessionListTitle(cwd, 'sess-fu', { baseDir: BASE }), '帮我修登录页');
});

test('peekSessionListTitle: 非法 id / 无文件 → 空串，不抛', async () => {
  assert.equal(await peekSessionListTitle('/x', '../etc/passwd', { baseDir: BASE }), '');
  assert.equal(await peekSessionListTitle('/x', 'no-such-sess', { baseDir: BASE }), '');
  assert.equal(await peekSessionListTitle('', 'abc', { baseDir: BASE }), '');
});

test('peekSessionListTitleTimed: peek 永不 settle 时超时返回空串，不挂起', async () => {
  const peek = () => new Promise(() => {});
  const t0 = Date.now();
  const title = await peekSessionListTitleTimed('/a', 'sid', { peek, timeoutMs: 40 });
  assert.equal(title, '');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 40, `应等到超时，实际 ${elapsed}ms`);
  assert.ok(elapsed < 400, `超时后应立刻返回，实际 ${elapsed}ms`);
});

test('peekSessionListTitleTimed: peek 成功返回抽屉标题', async () => {
  const peek = async () => '抽屉可见的 AI 标题';
  assert.equal(await peekSessionListTitleTimed('/a', 'sid', { peek, timeoutMs: 1000 }), '抽屉可见的 AI 标题');
});

test('peekSessionListTitleTimed: peek 抛错返回空串（调用方回落 firstMessage）', async () => {
  const peek = async () => { throw new Error('SDK boom'); };
  assert.equal(await peekSessionListTitleTimed('/a', 'sid', { peek, timeoutMs: 1000 }), '');
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

// 回归：裸 null 恰好是合法 JSON，JSON.parse 成功但 entry 为 null，若不判空直接访问 entry.entrypoint 会
// TypeError 逃逸到最外层 catch，把这一行之前已提取的 title/model 全部清空成「(无标题)」。
test('listSessions: 头窗混入裸 null 行不清空已提取的 title/model', async () => {
  const cwd = '/test/nullline';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'sess-nullline', [
    { type: 'user', message: { role: 'user', content: '真实问题' } },
    null,
    { type: 'assistant', message: { role: 'assistant', content: 'Hi', model: 'claude-sonnet-4-6' } },
  ]);
  const result = await listSessions(cwd, { baseDir: BASE });
  assert.equal(result[0].title, '真实问题');
  assert.equal(result[0].model, 'claude-sonnet-4-6');
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

// ── listSessionsPage：excludeIds（删文件窗口临时过滤）+ total + query ──────────

test('listSessionsPage: excludeIds 命中的会话不出现在结果里', async () => {
  const cwd = '/test/page-exclude';
  const dir = join(BASE, getProjectDir(cwd));
  for (let i = 0; i < 3; i++) writeJSONL(dir, `h${i}`, [{ type: 'user', message: { role: 'user', content: `q${i}` } }]);
  const { sessions } = await listSessionsPage(cwd, { baseDir: BASE, limit: 10, excludeIds: new Set(['h1']) });
  assert.deepEqual(sessions.map(s => s.id).sort(), ['h0', 'h2']);
});

test('listSessionsPage: 不传 excludeIds（或空 Set）→ 不过滤', async () => {
  const cwd = '/test/page-noexclude';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'nh0', [{ type: 'user', message: { role: 'user', content: 'q' } }]);
  const withoutParam = await listSessionsPage(cwd, { baseDir: BASE, limit: 10 });
  const withEmptySet = await listSessionsPage(cwd, { baseDir: BASE, limit: 10, excludeIds: new Set() });
  assert.equal(withoutParam.sessions.length, 1);
  assert.equal(withEmptySet.sessions.length, 1);
});

test('listSessionsPage: 返回 total=目录会话总数（与 limit 截断无关）', async () => {
  const cwd = '/test/page-total';
  const dir = join(BASE, getProjectDir(cwd));
  for (let i = 0; i < 5; i++) writeJSONL(dir, `t${i}`, [{ type: 'user', message: { role: 'user', content: `q${i}` } }]);
  const page = await listSessionsPage(cwd, { baseDir: BASE, limit: 2 });
  assert.equal(page.sessions.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.total, 5);
});

test('listSessionsPage: query 按标题大小写不敏感匹配', async () => {
  const cwd = '/test/page-query';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'qa', [{ type: 'user', message: { role: 'user', content: 'Alpha Plan' } }]);
  writeJSONL(dir, 'qb', [{ type: 'user', message: { role: 'user', content: 'beta review' } }]);
  writeJSONL(dir, 'qc', [{ type: 'user', message: { role: 'user', content: 'ALPHA notes' } }]);
  const { sessions, total } = await listSessionsPage(cwd, { baseDir: BASE, limit: 10, query: 'alpha' });
  assert.equal(total, 3);
  assert.deepEqual(sessions.map(s => s.id).sort(), ['qa', 'qc']);
});

test('listSessionsPage: query 能命中排在 limit=50 窗外的旧会话', async () => {
  const cwd = '/test/page-query-deep';
  const dir = join(BASE, getProjectDir(cwd));
  const { utimesSync } = await import('node:fs');
  const nowSec = Date.now() / 1000;
  // 先写最旧的目标，再写 59 条噪声并抬高 mtime——保证 needle 落在浏览 50 窗外
  writeJSONL(dir, 'needle-old', [
    { type: 'user', timestamp: new Date(Date.now() - 999_000).toISOString(), message: { role: 'user', content: 'UniqueNeedleTitle' } },
  ]);
  utimesSync(join(dir, 'needle-old.jsonl'), nowSec - 999, nowSec - 999);
  for (let i = 0; i < 59; i++) {
    const id = `n${String(i).padStart(3, '0')}`;
    writeJSONL(dir, id, [{
      type: 'user',
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      message: { role: 'user', content: `noise ${i}` },
    }]);
    utimesSync(join(dir, `${id}.jsonl`), nowSec - i, nowSec - i);
  }
  const browse = await listSessionsPage(cwd, { baseDir: BASE, limit: 50 });
  assert.equal(browse.sessions.length, 50);
  assert.equal(browse.hasMore, true);
  assert.equal(browse.total, 60);
  assert.ok(!browse.sessions.some(s => s.id === 'needle-old'), '浏览窗不应包含最旧的 needle');

  const found = await listSessionsPage(cwd, { baseDir: BASE, limit: 50, query: 'UniqueNeedle' });
  assert.equal(found.total, 60);
  assert.equal(found.sessions.length, 1);
  assert.equal(found.sessions[0].id, 'needle-old');
  assert.equal(found.hasMore, false);
});

test('listSessionsPage: query 能命中 firstUser 超过展示 60 字的尾部', async () => {
  const cwd = '/test/page-query-long';
  const dir = join(BASE, getProjectDir(cwd));
  const firstUser = `${'x'.repeat(80)}UniqueTailToken`;
  writeJSONL(dir, 'long-user', [{ type: 'user', message: { role: 'user', content: firstUser } }]);
  const found = await listSessionsPage(cwd, { baseDir: BASE, limit: 10, query: 'UniqueTailToken' });
  assert.equal(found.sessions.length, 1);
  assert.equal(found.sessions[0].id, 'long-user');
  // 展示标题仍截断，匹配不得先截断再搜
  assert.equal(found.sessions[0].title, firstUser.slice(0, 60));
});

test('listSessionsPage: 空 query / 空白 query 等同不过滤', async () => {
  const cwd = '/test/page-query-blank';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'qb0', [{ type: 'user', message: { role: 'user', content: 'hello' } }]);
  const a = await listSessionsPage(cwd, { baseDir: BASE, limit: 10, query: '' });
  const b = await listSessionsPage(cwd, { baseDir: BASE, limit: 10, query: '   ' });
  const c = await listSessionsPage(cwd, { baseDir: BASE, limit: 10 });
  assert.equal(a.sessions.length, 1);
  assert.equal(b.sessions.length, 1);
  assert.equal(c.sessions.length, 1);
});


// ── getSessionHistory ──────────────────────────────────────────────────────

// 2026-08-03 review：readHeadMeta 的尾窗循环缺 `if (!entry) continue`（头窗有）——JSON.parse("null")
// 合法返回 null、不进 catch，下一行 entry.type 抛 TypeError，被外层「尾窗补读失败」catch 吞掉，
// 该文件的 ai-title 静默降级回退 firstUser。transcript 里混入字面 null 行即触发。
test('listSessions: 尾窗内混入字面 null 行不吞掉其后的 ai-title', async () => {
  const cwd = '/test/aititle-null-line';
  const dir = join(BASE, getProjectDir(cwd));
  const filler = 'n'.repeat(120 * 1024);
  writeJSONL(dir, 'aititle-null', [
    { type: 'user', message: { role: 'user', content: '首条问题' } },
    { type: 'assistant', message: { role: 'assistant', content: filler } }, // 撑出 64KB 头窗
    null,                                                                   // 字面 "null" 行（JSON 合法、parse 为 null）
    { type: 'ai-title', aiTitle: 'null行之后的AI标题' },
    { type: 'assistant', message: { role: 'assistant', content: '尾' } },
  ]);
  const result = await listSessions(cwd, { baseDir: BASE });
  assert.equal(result[0].title, 'null行之后的AI标题');
});


// ── listSessionsByIds ──────────────────────────────────────────────────────
// 手动标「稍后再看」的会话被 limit 挤出本页后，服务端靠它把那几条单独补回来（session:list 的
// pinned 字段）。这里守的是「补回来的行长得和列表主体一样」——字段少一个，前端 sessionRow 就在
// 那几行上缺东西，而它们恰恰是用户特意标出来要看的。

test('listSessionsByIds: 取到 limit 窗口之外的会话，字段与列表主体同形', async () => {
  const cwd = '/test/by-ids/basic';
  const dir = join(BASE, getProjectDir(cwd));
  for (let i = 0; i < 5; i += 1) {
    writeJSONL(dir, `s${i}`, [
      { type: 'user', message: { role: 'user', content: `问题 ${i}` }, timestamp: new Date(2026, 0, 1 + i).toISOString() },
      { type: 'assistant', message: { role: 'assistant', content: 'ok', model: 'claude-3-5-sonnet' }, timestamp: new Date(2026, 0, 1 + i).toISOString() },
    ]);
  }
  // 时间序最旧的那条：limit=2 的页里绝对没有它
  const page = await listSessionsPage(cwd, { limit: 2, baseDir: BASE });
  assert.equal(page.sessions.some(s => s.id === 's0'), false, '前置条件：s0 必须在页外，否则这条用例什么都没证明');

  const rows = await listSessionsByIds(cwd, ['s0'], { baseDir: BASE });
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['entrypoint', 'id', 'lastUsedAt', 'model', 'title'],
    '字段集必须与 scanViaReaddir 的行一致——少一个前端就在这几行上缺显示');
  assert.equal(rows[0].id, 's0');
  assert.equal(rows[0].title, '问题 0');
  assert.equal(typeof rows[0].lastUsedAt, 'number');
});

test('listSessionsByIds: 不存在 / 空 id 静默跳过，不抛', async () => {
  const cwd = '/test/by-ids/skip';
  writeJSONL(join(BASE, getProjectDir(cwd)), 'real-one', [
    { type: 'user', message: { role: 'user', content: '在的' } },
  ]);
  const rows = await listSessionsByIds(cwd, ['real-one', 'no-such-session', '', null], { baseDir: BASE });
  assert.deepEqual(rows.map(r => r.id), ['real-one']);
});

// 穿越目标必须【真实存在】：第一版用 '../escape'（指向不存在的文件），把 isSafeSessionId 整个删掉
// 测试也照样绿——它守的其实是「文件不存在会被跳过」，与路径校验毫无关系。
// read-state.json 里的 id 是磁盘上的数据，这条路径把它直接拼进 join()，校验是唯一的闸。
test('listSessionsByIds: 路径穿越 id 够不到别的工作区的真实会话文件', async () => {
  const cwd = '/test/by-ids/traverse-from';
  const victim = '/test/by-ids/traverse-victim';
  mkdirSync(join(BASE, getProjectDir(cwd)), { recursive: true });
  writeJSONL(join(BASE, getProjectDir(victim)), 'secret', [
    { type: 'user', message: { role: 'user', content: '别的工作区的内容' } },
  ]);
  const traversal = `../${getProjectDir(victim)}/secret`;
  // 前置条件：这个 id 若不被挡，join() 后确实指向 victim 那个真实文件（否则本用例又退化成假绿）
  assert.equal(existsSync(join(BASE, getProjectDir(cwd), `${traversal}.jsonl`)), true);
  assert.deepEqual(await listSessionsByIds(cwd, [traversal], { baseDir: BASE }), []);
});

test('listSessionsByIds: 会话属于别的工作区时返回空（manual 表只有 id，归属靠这里判）', async () => {
  const owner = '/test/by-ids/owner';
  const other = '/test/by-ids/other';
  writeJSONL(join(BASE, getProjectDir(owner)), 'owned', [{ type: 'user', message: { role: 'user', content: 'x' } }]);
  mkdirSync(join(BASE, getProjectDir(other)), { recursive: true });
  assert.deepEqual(await listSessionsByIds(other, ['owned'], { baseDir: BASE }), []);
  assert.equal((await listSessionsByIds(owner, ['owned'], { baseDir: BASE })).length, 1);
});

test('listSessionsByIds: 按 lastUsedAt 降序（与列表主体同序，两次调用不抖动）', async () => {
  const cwd = '/test/by-ids/order';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'old', [{ type: 'user', message: { role: 'user', content: 'a' }, timestamp: '2026-01-01T00:00:00.000Z' }]);
  writeJSONL(dir, 'new', [{ type: 'user', message: { role: 'user', content: 'b' }, timestamp: '2026-03-01T00:00:00.000Z' }]);
  writeJSONL(dir, 'mid', [{ type: 'user', message: { role: 'user', content: 'c' }, timestamp: '2026-02-01T00:00:00.000Z' }]);
  const rows = await listSessionsByIds(cwd, ['old', 'new', 'mid'], { baseDir: BASE });
  assert.deepEqual(rows.map(r => r.id), ['new', 'mid', 'old']);
});

test('listSessionsByIds: 空/无效入参不读盘，直接返回 []', async () => {
  assert.deepEqual(await listSessionsByIds('/no/such/cwd', [], { baseDir: BASE }), []);
  assert.deepEqual(await listSessionsByIds('/no/such/cwd', null, { baseDir: BASE }), []);
});
