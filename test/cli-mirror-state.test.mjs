import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { extractCliObservedState, readCliObservedState } from '../cli-mirror-state.js';

const BASE = join(tmpdir(), `ccm-cli-mirror-${process.pid}`);
test.after(async () => { await rm(BASE, { recursive: true, force: true }); });

async function writeTranscript(cwd, sessionId, raw) {
  const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = join(BASE, projectDir);
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
