// tests/unit/history.test.mjs —— history.js 单测（tmpdir 注入，零网络/零真实 claude 目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, sessionFileExists, sessionFileSize, sessionFileMtime, lastMessageActivityMs } from '../../src/sessions/history.js';

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

// ── lastMessageActivityMs / listSessions lastUsedAt 口径 ───────────────────
// 列表时间与排序以「最后一条主链 user/assistant 消息时间」为准，忽略 mode/permission-mode/
// ai-title/last-prompt 等元数据写盘（web resume / CLI 切档会刷 mtime，否则会话会莫名顶前）。

test('lastMessageActivityMs: 取最后一条主链 user/assistant 的 timestamp', () => {
  const ms = lastMessageActivityMs([
    { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'a' } },
    { type: 'assistant', timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'assistant', content: 'b' } },
    { type: 'mode', mode: 'default' },
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'ai-title', aiTitle: '标题' },
    { type: 'last-prompt', lastPrompt: 'a' },
  ]);
  assert.equal(ms, Date.parse('2026-01-01T00:01:00.000Z'));
});

test('lastMessageActivityMs: 跳过 isSidechain / isMeta / 无 timestamp / 非法时间', () => {
  const ms = lastMessageActivityMs([
    { type: 'user', timestamp: '2026-02-01T00:00:00.000Z', message: { role: 'user', content: '真消息' } },
    { type: 'assistant', isSidechain: true, timestamp: '2026-03-01T00:00:00.000Z', message: { role: 'assistant', content: '子代理' } },
    { type: 'user', isMeta: true, timestamp: '2026-04-01T00:00:00.000Z', message: { role: 'user', content: '系统' } },
    { type: 'assistant', timestamp: 'not-a-date', message: { role: 'assistant', content: '坏时间' } },
    { type: 'user', message: { role: 'user', content: '无时间戳' } },
  ]);
  assert.equal(ms, Date.parse('2026-02-01T00:00:00.000Z'));
});

test('lastMessageActivityMs: 无主链消息 → null', () => {
  assert.equal(lastMessageActivityMs([{ type: 'mode', mode: 'default' }]), null);
  assert.equal(lastMessageActivityMs([]), null);
  assert.equal(lastMessageActivityMs(null), null);
});

// ── listSessions ───────────────────────────────────────────────────────────
