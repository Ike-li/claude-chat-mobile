// test/history.test.mjs —— history.js 单测（tmpdir 注入，零网络/零真实 claude 目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, listSessions, sessionFileExists, getSessionHistory } from '../history.js';

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
