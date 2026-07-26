import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readSessionRegistry,
  registryIndicatesTerminalBusy,
  listTerminalSessionStates,
  terminalStateKey,
  REGISTRY_BUSY_FRESH_MS,
} from '../../src/sessions/session-registry.js';

const CWD = '/Users/you/code/demo';
const SID = '11111111-2222-3333-4444-555555555555';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ccm-sreg-'));
}

function writeEntry(dir, pid, extra = {}) {
  const entry = {
    pid,
    sessionId: SID,
    cwd: CWD,
    startedAt: 1_785_000_000_000,
    version: '2.1.220',
    kind: 'interactive',
    entrypoint: 'cli',
    ...extra,
  };
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify(entry));
  return entry;
}

test('readSessionRegistry：命中 sessionId+cwd 且 pid 活 → 返回规范化条目', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 15295, { status: 'busy', statusUpdatedAt: 1_785_000_100_000 });
    const got = await readSessionRegistry(SID, CWD, { dir, isAlive: () => true });
    assert.deepEqual(got, {
      pid: 15295,
      entrypoint: 'cli',
      kind: 'interactive',
      status: 'busy',
      statusUpdatedAt: 1_785_000_100_000,
      version: '2.1.220',
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSessionRegistry：pid 已死（崩溃陈尸文件）→ null', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 40404, { status: 'busy', statusUpdatedAt: 1_785_000_100_000 });
    const got = await readSessionRegistry(SID, CWD, { dir, isAlive: () => false });
    assert.equal(got, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSessionRegistry：cwd 不匹配 → null；sessionId 不匹配 → null', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 100, { status: 'busy' });
    assert.equal(await readSessionRegistry(SID, '/Users/you/other', { dir, isAlive: () => true }), null);
    assert.equal(await readSessionRegistry('99999999-0000-0000-0000-000000000000', CWD, { dir, isAlive: () => true }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSessionRegistry：损坏 JSON/字段缺失/symlink/非 json 文件被跳过，有效条目仍命中', async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, '7.json'), '{broken');
    writeFileSync(join(dir, '8.json'), JSON.stringify({ pid: 8 })); // 缺 sessionId/cwd
    writeFileSync(join(dir, 'note.txt'), 'not json');
    const real = join(dir, 'real-target.json');
    writeFileSync(real, JSON.stringify({ pid: 9, sessionId: SID, cwd: CWD, entrypoint: 'cli' }));
    symlinkSync(real, join(dir, '9.json'));
    writeEntry(dir, 200, { status: 'busy', statusUpdatedAt: 5 });
    const got = await readSessionRegistry(SID, CWD, { dir, isAlive: () => true });
    assert.equal(got?.pid, 200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSessionRegistry：目录不存在 → null（fail-open，不抛）', async () => {
  const got = await readSessionRegistry(SID, CWD, { dir: join(tmpdir(), 'ccm-sreg-definitely-absent'), isAlive: () => true });
  assert.equal(got, null);
});

test('readSessionRegistry：同 sessionId 多 PID（sdk+cli 并存实测形态）→ 优先 entrypoint=cli', async () => {
  const dir = tempDir();
  try {
    writeEntry(dir, 301, { entrypoint: 'sdk-ts' });
    writeEntry(dir, 302, { status: 'busy', statusUpdatedAt: 7 });
    const got = await readSessionRegistry(SID, CWD, { dir, isAlive: () => true });
    assert.equal(got?.pid, 302);
    assert.equal(got?.entrypoint, 'cli');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 列表侧批量读取：会话列表一次扫盘拿到全部活终端状态（不是每行一次 readdir）。
// 'busy' = cli 且 status:"busy" 新鲜；'alive' = cli 进程活着但未在跑；非 cli entrypoint 不进结果
// （sdk-ts/sdk-cli 是 ccm 自己或别的 SDK 工具驱动，列表里已有 live 实例徽标，重复标注会双份）。
test('listTerminalSessionStates：按 cwd+sessionId 归键返回 busy/alive，非 cli 与陈尸 pid 不进结果', async () => {
  const dir = tempDir();
  const now = 1_785_000_100_000;
  const put = (pid, sessionId, extra) => writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: CWD, entrypoint: 'cli', ...extra }),
  );
  try {
    put(1, 'sid-busy', { status: 'busy', statusUpdatedAt: now - 500 });
    put(2, 'sid-idle', { status: 'idle', statusUpdatedAt: now - 500 });
    // busy 但自报已过期 → 降级 alive（进程还活着，但"在跑"不再可信）
    put(3, 'sid-stale', { status: 'busy', statusUpdatedAt: now - REGISTRY_BUSY_FRESH_MS - 1 });
    put(4, 'sid-sdk', { entrypoint: 'sdk-ts' });
    put(5, 'sid-dead', { status: 'busy', statusUpdatedAt: now });
    const map = await listTerminalSessionStates({ dir, now, isAlive: pid => pid !== 5 });
    assert.equal(map.get(terminalStateKey(CWD, 'sid-busy')), 'busy');
    assert.equal(map.get(terminalStateKey(CWD, 'sid-idle')), 'alive');
    assert.equal(map.get(terminalStateKey(CWD, 'sid-stale')), 'alive');
    assert.equal(map.has(terminalStateKey(CWD, 'sid-sdk')), false, 'sdk 系条目不进结果');
    assert.equal(map.has(terminalStateKey(CWD, 'sid-dead')), false, '陈尸 pid 不进结果');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listTerminalSessionStates：目录不存在 → 空 Map（fail-open，列表不受影响）', async () => {
  const map = await listTerminalSessionStates({ dir: join(tmpdir(), 'ccm-sreg-absent-2'), isAlive: () => true });
  assert.equal(map.size, 0);
});

test('registryIndicatesTerminalBusy：cli+busy+新鲜 → true；其余组合 → false', () => {
  const now = 1_785_000_200_000;
  const fresh = { entrypoint: 'cli', status: 'busy', statusUpdatedAt: now - 1000 };
  assert.equal(registryIndicatesTerminalBusy(fresh, { now }), true);
  // 过期：超过 REGISTRY_BUSY_FRESH_MS 不再信任，回落尾部判定（宁可回落不可误锁）
  assert.equal(registryIndicatesTerminalBusy(
    { ...fresh, statusUpdatedAt: now - REGISTRY_BUSY_FRESH_MS - 1 }, { now }), false);
  // sdk-ts 条目（无 status 字段）：不构成终端 busy
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'sdk-ts', kind: 'interactive' }, { now }), false);
  // cli 但 idle
  assert.equal(registryIndicatesTerminalBusy({ entrypoint: 'cli', status: 'idle', statusUpdatedAt: now }, { now }), false);
  // null 条目
  assert.equal(registryIndicatesTerminalBusy(null, { now }), false);
});
