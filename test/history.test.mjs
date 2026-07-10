// test/history.test.mjs —— history.js 单测（tmpdir 注入，零网络/零真实 claude 目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, listSessions, listSessionsPage, sessionFileExists, getSessionHistory, HISTORY_MAX_MESSAGES, catchUpStep } from '../history.js';

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

test('getSessionHistory: 纯工具调用（空 content）被过滤', async () => {
  const cwd = '/test/tool-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'toolhist', [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'bash', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    { type: 'assistant', message: { role: 'assistant', content: '真实回复' } },
  ]);
  const msgs = await getSessionHistory('toolhist', cwd, 50, { baseDir: BASE });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, '真实回复');
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

test('getSessionHistory: CLI 系统行（isMeta=false 的 slash 命令注入 / interrupt / 空 turn）被过滤', async () => {
  // 回归护栏：真实 CLI 写盘里，一次 /model、/effort 等 slash 命令被拆成多行，只有 <local-command-caveat>
  // 行带 isMeta=true，而 <command-name>/<command-message>/<command-args> 与 <local-command-stdout> 行
  // 都是 isMeta=false —— 会漏过上面的 isMeta 闸、被当成 user 气泡回显（实测某会话 46 条回显里 14 条是这类
  // 噪音，占 30%）。同理 [Request interrupted by user]（打断标记）与 assistant 的 'No response requested.'
  // （Continue/继续 触发的 resume 空 turn）也 isMeta=false。这些都不是对话内容，必须过滤。
  // fixture 全部不带 isMeta，复刻 CLI 真实形态——否则测试会像旧版一样自带 isMeta=true 而测不出该 bug。
  const cwd = '/test/cli-noise-hist';
  const dir = join(BASE, getProjectDir(cwd));
  writeJSONL(dir, 'clinoise', [
    { type: 'user', message: { role: 'user', content: '真实提问' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>' } },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to Opus 4.8 (default)</local-command-stdout>' } },
    { type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } },
    { type: 'user', message: { role: 'user', content: '[Request interrupted by user for tool use]' } },
    { type: 'assistant', message: { role: 'assistant', content: 'No response requested.' } },
    { type: 'assistant', message: { role: 'assistant', content: '真实回答' } },
  ]);
  const msgs = await getSessionHistory('clinoise', cwd, 50, { baseDir: BASE });
  assert.deepEqual(msgs.map(m => m.content), ['真实提问', '真实回答'], 'CLI 系统噪音行不得回显成气泡');
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
