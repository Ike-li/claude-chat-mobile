import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { extractCliObservedState, readCliObservedState } from '../../src/agent/cli-mirror-state.js';
import { encodeProjectDir } from '../../src/shared/project-dir.js';

const BASE = join(tmpdir(), `ccm-cli-mirror-${process.pid}`);
test.after(async () => { await rm(BASE, { recursive: true, force: true }); });

async function writeTranscript(cwd, sessionId, raw) {
  // 与被测实现同走 shared 的唯一编码：fixture 若自己复制一份，两边一起漂时测试反而恒绿
  const dir = join(BASE, encodeProjectDir(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${sessionId}.jsonl`), raw);
}

test('extractCliObservedState: 取最新主链真实 assistant 模型，忽略 sidechain、parent_tool_use_id 与 <synthetic>', () => {
  const observed = extractCliObservedState([
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8' } },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', model: 'claude-sonnet-4-6' } },
    { type: 'assistant', parent_tool_use_id: 'toolu_parent', message: { role: 'assistant', model: 'claude-haiku-4-5' } },
    { type: 'assistant', message: { role: 'assistant', model: '<synthetic>' } },
    { type: 'assistant', message: { role: 'assistant', model: 'z-ai/glm-5.2' } },
  ]);

  assert.deepEqual(observed, { model: 'z-ai/glm-5.2', permissionMode: null });
});

test('extractCliObservedState: permission-mode 复用产品合法档并支持 auto', () => {
  const observed = extractCliObservedState([
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-6' } },
    { type: 'permission-mode', permissionMode: 'auto' },
  ]);

  assert.deepEqual(observed, { model: 'claude-sonnet-4-6', permissionMode: 'auto' });
});

test('extractCliObservedState: 末条 permission-mode 非法时返回未知，不回退旧合法值', () => {
  const observed = extractCliObservedState([
    { type: 'permission-mode', permissionMode: 'auto' },
    { type: 'permission-mode', permissionMode: 'untrusted-mode' },
  ]);

  assert.deepEqual(observed, { model: null, permissionMode: null });
});

test('extractCliObservedState: sidechain 与 parent_tool_use_id 的 permission-mode 不污染主链观察态', () => {
  const observed = extractCliObservedState([
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'permission-mode', isSidechain: true, permissionMode: 'auto' },
    { type: 'permission-mode', parent_tool_use_id: 'toolu_parent', permissionMode: 'bypassPermissions' },
  ]);

  assert.deepEqual(observed, { model: null, permissionMode: 'plan' });
});

test('readCliObservedState: transcript 不存在时安全返回未知', async () => {
  const observed = await readCliObservedState('missing-session', '/missing/project', {
    baseDir: join(tmpdir(), `ccm-cli-mirror-missing-${process.pid}`),
  });

  assert.deepEqual(observed, { model: null, permissionMode: null });
});

test('readCliObservedState: size 注入限定本次观察边界，不读取边界后的新记录', async () => {
  const cwd = '/mirror/size';
  const sessionId = 'size-session';
  const atSnapshot = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8' } }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'auto' }),
    '',
  ].join('\n');
  const appendedLater = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-6' } }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions' }),
    '',
  ].join('\n');
  await writeTranscript(cwd, sessionId, atSnapshot + appendedLater);

  const observed = await readCliObservedState(sessionId, cwd, {
    baseDir: BASE,
    size: Buffer.byteLength(atSnapshot),
  });

  assert.deepEqual(observed, { model: 'claude-opus-4-8', permissionMode: 'auto' });
});

test('readCliObservedState: 只观察 512KB 尾窗并跳过首尾半行', async () => {
  const cwd = '/mirror/tail';
  const sessionId = 'tail-session';
  const oldOutsideWindow = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model: 'outside-window-model' },
  });
  const oversizedLine = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'x'.repeat(512 * 1024 + 4096) },
  });
  const syntheticInWindow = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model: '<synthetic>' },
  });
  const autoInWindow = JSON.stringify({ type: 'permission-mode', permissionMode: 'auto' });
  const incompleteTail = '{"type":"assistant","message":{"model":"truncated-model"}';
  const raw = [oldOutsideWindow, oversizedLine, syntheticInWindow, autoInWindow, incompleteTail].join('\n');
  await writeTranscript(cwd, sessionId, raw);

  const observed = await readCliObservedState(sessionId, cwd, {
    baseDir: BASE,
    size: Buffer.byteLength(raw),
  });

  assert.deepEqual(observed, { model: null, permissionMode: 'auto' });
});

// F1（2026-08-09 审查）：本文件曾自带第三份 project 目录名编码（`cwd.replace(/[^a-zA-Z0-9]/g,'-')`），
// 与 history/workdirs 收敛到 src/shared/project-dir.js 的口径分叉——那份没有 CLI 的 200 字符截断 + hash 后缀。
// 后果不是报错而是**不对称的静默失效**：同一个超长 workdir 下，会话历史能正常同步（history 侧已按 CLI 口径
// 定位），而镜像观察态因为拼错目录名读不到文件、被 catch 吞成 {model:null,permissionMode:null}，
// 表现为「消息在更新，但 CLI 当前模型/权限模式永久未知」。收敛前两边一起坏，反而看不出来。
test('readCliObservedState: 超长 cwd 也按 CLI 口径定位 transcript（本文件不得自带编码实现）', async () => {
  const cwd = '/' + 'w'.repeat(120) + '/' + 'x'.repeat(120);
  assert.ok(cwd.replace(/[^a-zA-Z0-9]/g, '-').length > 200, '前提：fixture 必须触发 200 截断阈值');
  const sessionId = 'sess-longpath';
  // fixture 按 CLI 真实落盘口径写（encodeProjectDir 已对着 sdk.mjs 与 CLI 二进制逐字节核对）
  const dir = join(BASE, encodeProjectDir(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5' } }) + '\n',
  );
  const observed = await readCliObservedState(sessionId, cwd, { baseDir: BASE });
  assert.equal(observed.model, 'claude-opus-5', '按 CLI 编码找不到 transcript → 镜像观察态静默为空');
});
