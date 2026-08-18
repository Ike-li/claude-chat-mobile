// tests/unit/history.test.mjs —— history.js 单测（tmpdir 注入，零网络/零真实 claude 目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, realpathSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectDir, sessionFileExists, sessionFileSize, sessionFileMtime, lastMessageActivityMs, isSafeSessionId, getSessionHistory, classifyTranscriptTail, readLastPermissionMode } from '../../src/sessions/history.js';

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

// CLI/SDK 对 sanitize 后超过 200 字符的结果会截断并接一段 hash 后缀（sdk.mjs 的 Co()）。那个 200
// 不是美观阈值，是贴着文件系统单段 255 字节上限设的：本仓若原样返回全长，算出的名字根本建不出目录，
// join(CLAUDE_DIR, getProjectDir(cwd)) 的 stat/read 一律 ENAMETOOLONG，且 history.js 里那些
// `catch { return null }` 会把异常吞成「没有会话」——表现为该 workdir 会话列表恒空、镜像同步失效，
// 而 CLI 自己完全正常。
//
// ★ 本用例能保住什么、不能保住什么（2026-08-09 审查修正——原注释宣称它验证了整个编码，是错的）：
// 保住「截断确实发生」（全长 314 字符会撞 assert 的 255 上限）与「前 200 字符正确」。
// **保不住 hash 后缀**：SDK 的候选目录函数 It() 在名字被截断时会做前缀扫描，凡以 `前200字符-` 开头的
// 目录都算候选——实测把后缀换成 `-ZZZZZZZZ` 它照样找得到。而本仓 join(CLAUDE_DIR, ...) 是精确拼接、
// 没有这层兜底，hash 错了就直接找不到。hash 的正确性由下面那条钉死期望值的用例负责。
test('getProjectDir: 超长路径按 CLI 口径截断+hash（真实 SDK 能据此定位会话）', async () => {
  const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
  const deep = join(BASE, 'x'.repeat(90), 'y'.repeat(90), 'z'.repeat(60));
  mkdirSync(deep, { recursive: true });
  const real = realpathSync(deep); // SDK 编码前会 realpath，必须用同一起点比对
  assert.ok(real.replace(/[^a-zA-Z0-9]/g, '-').length > 200, 'fixture 没触发截断阈值，用例失去意义');

  const encoded = getProjectDir(real);
  assert.ok(encoded.length <= 255, `编码后目录名 ${encoded.length} 字符，超过文件系统单段上限，建不出来`);

  const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const cfg = join(BASE, 'cfg-longpath');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg; // SDK 的 projects 根走它（memoize 以该 env 为 cache key）
  try {
    writeJSONL(join(cfg, 'projects', encoded), SID, [
      {
        type: 'user', sessionId: SID, cwd: real, timestamp: new Date(0).toISOString(),
        message: { role: 'user', content: 'hi' },
      },
    ]);
    const found = await listSessions({ dir: deep });
    assert.ok(
      Array.isArray(found) && found.some(s => s.sessionId === SID),
      'SDK 没能按 getProjectDir 的编码找到会话 —— 两边的 project 目录编码已漂移',
    );
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

// Unicode 归一必须**无条件**做，不能只在 darwin 做。
// 上游这两者本身不一致（2026-08-09 分别对着两个产物读出来的）：
//   SDK 0.3.201  Pr(e) = process.platform === "darwin" ? e.normalize("NFC") : e   ← 平台门控
//   CLI 2.1.225  xp(e) = e.normalize("NFC")                                        ← 无条件
// 写 transcript 的是 CLI，所以要对齐的是后者。
// 失败场景：Linux 上 headless 跑（npm start）+ workdir 含 NFD 形式的非 ASCII（例如从 macOS
// 拷来的 `café`，磁盘上是 `café`）→ CLI 编出 `-caf-`（é 一个字符→一个 '-'），本仓编出 `-cafe-`
// （e 保留 + 组合符→'-'）→ 目录名不同 → 该 workdir 会话列表恒空，而 CLI 自己一切正常。
// ★ 本用例在 macOS 上恒绿（两条分支都会归一），只有 Linux 容器（npm run test:docker）能真正鉴别它。
test('getProjectDir: NFD 与 NFC 形式的同一路径编码相同（对齐 CLI 的无条件归一）', () => {
  const nfc = '/Users/you/café';   // é 单码点
  const nfd = '/Users/you/café';  // e + 组合尖音符
  assert.notEqual(nfd, nfc, '前提：两个原始串确实不同');
  assert.equal(nfd.normalize('NFC'), nfc, '前提：NFC 归一后等价');
  assert.equal(
    getProjectDir(nfd), getProjectDir(nfc),
    '同一目录被编成两个名字 → 该 workdir 的会话历史与镜像在非 macOS 上全部读不到',
  );
});

// hash 后缀的正确性判据：钉死两个已知路径的**完整**期望值。
// 期望值不是我们自己算的——是把 sdk.mjs 里的 Co()/EZ()/v_() 三个函数原文抽出来 new Function 实例化后
// 跑出来的（2026-08-09，SDK 0.3.201，与 CLI 2.1.225 二进制里的 gw()/T$g() 同规则），两边逐字节相同。
// 之所以钉死字面量而不是在测试里动态抽 SDK 函数：那些函数在 minified 产物里是 Co/EZ/v_ 这种短名，
// 每次发版都会被 minifier 重排，动态抽取的正则一升级就断——脆到不如一个会红的字面量。
// 两个样本都含 `/`，所以 raw 与 sanitize 后的串不同 ⇒ 若把 hash 输入错写成 sanitize 后的结果，本用例会红。
test('getProjectDir: 截断后的 hash 后缀与 CLI 逐字节一致（钉死已知期望值）', () => {
  assert.equal(
    getProjectDir('/' + 'a'.repeat(210)),
    '-' + 'a'.repeat(199) + '-djaaup',
  );
  assert.equal(
    getProjectDir('/Users/you/' + 'z'.repeat(200)),
    '-Users-you-' + 'z'.repeat(189) + '-5mty3e',
  );
});

// ── sessionFileExists ──────────────────────────────────────────────────────

test('sessionFileExists: 含 . 的路径穿越被拒', async () => {
  assert.equal(await sessionFileExists('/cwd', '../etc/passwd', { baseDir: BASE }), false);
  assert.equal(await sessionFileExists('/cwd', '../../foo', { baseDir: BASE }), false);
  assert.equal(await sessionFileExists('/cwd', 'foo.jsonl', { baseDir: BASE }), false);
});

// SS-003：getSessionHistory / classifyTranscriptTail / readLastPermissionMode 同字符集守卫
test('isSafeSessionId + 路径构建函数对穿越 id 安全（SS-003）', async () => {
  assert.equal(isSafeSessionId('../x'), false);
  assert.equal(isSafeSessionId('good-id_01'), true);
  assert.deepEqual(await getSessionHistory('../etc/passwd', '/cwd', 10, { baseDir: BASE }), []);
  assert.deepEqual(await classifyTranscriptTail('../x', '/cwd', { baseDir: BASE }), { verdict: 'settled', lastChainTs: null, lastChainEntrypoint: null, autonomous: false });
  assert.equal(await readLastPermissionMode('../x', '/cwd', { baseDir: BASE }), null);
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

// ── _histCache 失效判据 ────────────────────────────────────────────────────
//
// 缓存曾**只认 mtimeMs**：同一毫秒内的两次写入会被判成「内容未变」而返回陈旧消息。
// 后果不在历史回显本身，而在单驾驶员模型——catchUpStep 拿到的是旧 messages，看不到终端刚写的一轮，
// externalWrite 判 false ⇒ 该上锁的会话没上锁。真机 tick 间隔 1–2.5s 撞同毫秒概率低，但容器里
// mirror-engine 的 R2b 用例连着写两轮再连着 tick，实测偶发翻车（宿主机慢，反而躲过）。
//
// 用 utimesSync 把 mtime 强行按回首次的值，把那个时序 flaky 变成确定性复现——不再依赖「跑得够快」。
test('getSessionHistory: mtime 没变但内容变了 → 必须重读（缓存判据不能只有 mtime）', async () => {
  const cwd = '/test/cache-staleness';
  const dir = join(BASE, getProjectDir(cwd));
  const file = join(dir, 'sess-cache.jsonl');
  const firstEntry = { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: '第一条' } };
  // 整毫秒的固定时刻：utimesSync 收 Date 会有亚毫秒舍入，用「当下的 mtime」按回去两次值并不相等，
  // 反而测不到缓存命中那条路径。钉死同一个整毫秒值，两次 stat 的 mtimeMs 才逐位相同。
  const FIXED = new Date('2026-01-01T00:00:00.000Z');

  writeJSONL(dir, 'sess-cache', [firstEntry]);
  utimesSync(file, FIXED, FIXED);
  const st = statSync(file);
  assert.equal((await getSessionHistory('sess-cache', cwd, 10, { baseDir: BASE })).length, 1, '前提：首读进缓存');

  writeJSONL(dir, 'sess-cache', [
    firstEntry,
    { type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: '第二条' } },
  ]);
  utimesSync(file, FIXED, FIXED);
  assert.equal(statSync(file).mtimeMs, st.mtimeMs, '前提：mtime 确实被按回去了');

  const second = await getSessionHistory('sess-cache', cwd, 10, { baseDir: BASE });
  assert.equal(second.length, 2, 'mtime 相同但文件变长 → 必须重读，否则终端的写入对 catchUp 不可见');
});

// ── listSessions ───────────────────────────────────────────────────────────
