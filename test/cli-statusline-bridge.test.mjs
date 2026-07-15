import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  cliStatuslineTtlMs,
  normalizeCliStatusInput,
  readCliStatusSnapshot,
  selectStatusReplay,
  selectStatusOwner,
  selectStatusSource,
  snapshotFilePath,
  writeCliStatusSnapshot,
} from '../cli-statusline-bridge.js';

test('normalizeCliStatusInput：把 CLI statusline JSON 规范化为版本化白名单快照', () => {
  const capturedAt = 1_784_102_400_000;
  const snapshot = normalizeCliStatusInput(JSON.stringify({
    session_id: 'session-123',
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    workspace: { current_dir: '/Users/test/repo' },
    version: '2.1.210',
    effort: { level: 'max' },
    thinking: { enabled: true },
    context_window: {
      total_input_tokens: 150,
      context_window_size: 1_000,
      used_percentage: 15,
      current_usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 120,
      },
    },
    cost: {
      total_cost_usd: 1.25,
      total_duration_ms: 2_000,
      total_api_duration_ms: 1_500,
      total_lines_added: 12,
      total_lines_removed: 3,
    },
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: 1_784_106_000 },
      seven_day: { used_percentage: 11, resets_at: 1_784_707_200 },
    },
  }), { capturedAt, refreshIntervalSec: 60 });

  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    source: 'claude-cli',
    capturedAt,
    refreshIntervalSec: 60,
    sessionId: 'session-123',
    cwd: '/Users/test/repo',
    model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    effort: 'max',
    thinking: { enabled: true },
    ctx: {
      tokens: 150,
      in: 10,
      out: 2,
      w: 20,
      r: 120,
      currentTotal: 150,
      cacheHitPct: 80,
      windowSize: 1_000,
      usedPercent: 15,
    },
    cost: 1.25,
    duration: { wallMs: 2_000, apiMs: 1_500 },
    lines: { added: 12, removed: 3 },
    rate: {
      fiveHour: { usedPercent: 42, resetsAt: 1_784_106_000 },
      sevenDay: { usedPercent: 11, resetsAt: 1_784_707_200 },
    },
    cliVersion: '2.1.210',
  });
});

test('normalizeCliStatusInput：丢弃未知敏感字段和越界遥测，不把原始 JSON 原样持久化', () => {
  const snapshot = normalizeCliStatusInput({
    session_id: 'session-safe',
    workspace: { current_dir: '/repo', secret: 'workspace-secret' },
    transcript_path: '/secret/transcript.jsonl',
    prompt_id: 'prompt-secret',
    api_key: 'sk-ant-secret',
    model: { id: 'model-id', display_name: 'Model', credential: 'model-secret' },
    effort: { level: 'ultracode' },
    context_window: {
      total_input_tokens: -1,
      context_window_size: -200,
      used_percentage: 101,
      current_usage: {
        input_tokens: -2,
        output_tokens: 3,
        cache_creation_input_tokens: -4,
        cache_read_input_tokens: 7,
      },
    },
    cost: {
      total_cost_usd: -1,
      total_duration_ms: -2,
      total_api_duration_ms: 5,
      total_lines_added: -3,
      total_lines_removed: 4,
    },
    rate_limits: {
      five_hour: { used_percentage: 150, resets_at: -1, behaviors: ['secret'] },
    },
  }, { capturedAt: 100 });

  assert.equal(snapshot.effort, undefined);
  // cache 分母对齐现有 CLI renderer：input + cache_creation + cache_read，不含 output。
  assert.deepEqual(snapshot.ctx, { out: 3, r: 7, currentTotal: 7, cacheHitPct: 100 });
  assert.equal(snapshot.cost, undefined);
  assert.deepEqual(snapshot.duration, { apiMs: 5 });
  assert.deepEqual(snapshot.lines, { removed: 4 });
  assert.equal(snapshot.rate, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|transcript|prompt|api_key|credential|behaviors/);
});

test('writeCliStatusSnapshot：session 哈希命名，0700 目录内原子落 0600 完整快照', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-'));
  try {
    chmodSync(dir, 0o755); // 模拟已有但权限过宽的目录，writer 应主动收紧。
    const snapshot = normalizeCliStatusInput({
      session_id: '../session/with/path',
      workspace: { current_dir: '/repo' },
      model: { id: 'model' },
    }, { capturedAt: 100 });

    const expectedPath = snapshotFilePath(dir, snapshot.sessionId);
    assert.match(basename(expectedPath), /^[a-f0-9]{64}\.json$/);
    assert.doesNotMatch(expectedPath, /session|\.\./);
    assert.equal(writeCliStatusSnapshot(snapshot, { dir }), expectedPath);

    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(expectedPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(expectedPath, 'utf8')), snapshot);
    assert.deepEqual(readdirSync(dir), [basename(expectedPath)]); // 无残留半截 tmp。
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCliStatusSnapshot：session/cwd 匹配且 TTL 内返回 fresh 快照', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-read-'));
  try {
    const snapshot = normalizeCliStatusInput({
      session_id: 'session-fresh',
      workspace: { current_dir: '/repo/./project' },
      model: { id: 'model' },
    }, { capturedAt: 1_000 });
    writeCliStatusSnapshot(snapshot, { dir });

    assert.deepEqual(readCliStatusSnapshot('session-fresh', {
      dir,
      cwd: '/repo/project',
      now: 1_500,
      ttlMs: 1_000,
    }), { state: 'fresh', ageMs: 500, snapshot });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCliStatusSnapshot：超过 TTL 返回 stale 与年龄，不把陈旧快照冒充当前状态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-stale-'));
  try {
    const snapshot = normalizeCliStatusInput({
      session_id: 'session-stale',
      workspace: { current_dir: '/repo' },
    }, { capturedAt: 1_000 });
    writeCliStatusSnapshot(snapshot, { dir });

    assert.deepEqual(readCliStatusSnapshot('session-stale', {
      dir, cwd: '/repo', now: 2_001, ttlMs: 1_000,
    }), { state: 'stale', ageMs: 1_001 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCliStatusSnapshot：快照同时绑定 session 与规范化 cwd，错配时拒绝返回内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-identity-'));
  try {
    const snapshot = normalizeCliStatusInput({
      session_id: 'session-real',
      workspace: { current_dir: '/repo/a' },
    }, { capturedAt: 1_000 });
    const realPath = writeCliStatusSnapshot(snapshot, { dir });

    assert.deepEqual(readCliStatusSnapshot('session-real', {
      dir, cwd: '/repo/b', now: 1_100, ttlMs: 1_000,
    }), { state: 'cwd-mismatch' });

    renameSync(realPath, snapshotFilePath(dir, 'session-other'));
    assert.deepEqual(readCliStatusSnapshot('session-other', {
      dir, cwd: '/repo/a', now: 1_100, ttlMs: 1_000,
    }), { state: 'session-mismatch' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCliStatusSnapshot：目录或文件权限过宽时返回 insecure', {
  skip: process.platform === 'win32',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-mode-'));
  try {
    const snapshot = normalizeCliStatusInput({
      session_id: 'session-mode',
      workspace: { current_dir: '/repo' },
    }, { capturedAt: 1_000 });
    const path = writeCliStatusSnapshot(snapshot, { dir });

    chmodSync(path, 0o644);
    assert.deepEqual(readCliStatusSnapshot('session-mode', {
      dir, cwd: '/repo', now: 1_100, ttlMs: 1_000,
    }), { state: 'insecure' });

    chmodSync(path, 0o600);
    chmodSync(dir, 0o755);
    assert.deepEqual(readCliStatusSnapshot('session-mode', {
      dir, cwd: '/repo', now: 1_100, ttlMs: 1_000,
    }), { state: 'insecure' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selectStatusOwner：仅 mirrorReadonly（终端真在驾驶）切 CLI；externalDirty 不参与', () => {
  // externalDirty = SDK 内存滞后、下次发送前须置换，≠ CLI 此刻仍在驾驶。
  // 若 externalDirty 也切 CLI，mirror 自动解锁后 Web 已能输入，却会因无 CLI 快照长期显示
  // 「CLI 状态暂不可用 (missing)」（真机截图 2026-07-15 复现路径）。
  assert.equal(selectStatusOwner({ mirrorReadonly: false, externalDirty: false }), 'sdk');
  assert.equal(selectStatusOwner({ mirrorReadonly: true, externalDirty: false }), 'cli');
  assert.equal(selectStatusOwner({ mirrorReadonly: false, externalDirty: true }), 'sdk');
  assert.equal(selectStatusOwner({ mirrorReadonly: true, externalDirty: true }), 'cli');
  assert.equal(selectStatusOwner({}), 'sdk');
});

test('selectStatusSource：单一来源选择，CLI 不可用时绝不混入 SDK 陈值', () => {
  const cliSnapshot = { source: 'claude-cli', sessionId: 's', model: { id: 'cli-model' } };
  const sdkPayload = { model: 'sdk-model', effort: 'low' };

  assert.deepEqual(selectStatusSource({
    owner: 'cli',
    cliRead: { state: 'fresh', ageMs: 25, snapshot: cliSnapshot },
    sdkPayload,
  }), { kind: 'cli', ageMs: 25, value: cliSnapshot });

  assert.deepEqual(selectStatusSource({
    owner: 'cli',
    cliRead: { state: 'stale', ageMs: 2_000 },
    sdkPayload,
  }), { kind: 'cli-unavailable', reason: 'stale', ageMs: 2_000, value: null });

  assert.deepEqual(selectStatusSource({
    owner: 'sdk',
    cliRead: { state: 'fresh', ageMs: 25, snapshot: cliSnapshot },
    sdkPayload,
  }), { kind: 'sdk', value: sdkPayload });
});

test('selectStatusReplay：只重放同 owner、instance、session、cwd 的缓存，并补齐 instanceId', () => {
  const sdkCache = {
    owner: 'sdk',
    instanceId: 'inst-a',
    sessionId: 'session-a',
    cwd: '/repo/a',
    payload: { model: 'sdk-model', source: { kind: 'sdk' } },
  };
  const current = {
    owner: 'sdk', instanceId: 'inst-a', sessionId: 'session-a', cwd: '/repo/a',
  };

  assert.deepEqual(selectStatusReplay(sdkCache, current), {
    model: 'sdk-model', source: { kind: 'sdk' }, instanceId: 'inst-a',
  });
  assert.equal(selectStatusReplay(sdkCache, { ...current, owner: 'cli' }), null);
  assert.equal(selectStatusReplay({
    ...sdkCache, owner: 'cli', payload: { source: { kind: 'cli' } },
  }, current), null);
  assert.equal(selectStatusReplay(sdkCache, { ...current, instanceId: 'inst-b' }), null);
  assert.equal(selectStatusReplay(sdkCache, { ...current, sessionId: 'session-b' }), null);
  assert.equal(selectStatusReplay(sdkCache, { ...current, cwd: '/repo/b' }), null);
});

test('cliStatuslineTtlMs：2×刷新周期+5s，并限制在 30s～180s', () => {
  assert.equal(cliStatuslineTtlMs(10), 30_000);   // 25s → 下限 30s
  assert.equal(cliStatuslineTtlMs(60), 125_000); // 当前机器配置
  assert.equal(cliStatuslineTtlMs(120), 180_000);// 245s → 上限 180s
  assert.equal(cliStatuslineTtlMs(), 125_000);   // 无值默认按 60s
  assert.equal(cliStatuslineTtlMs(-1), 125_000); // 非法值同样回安全默认
});

test('readCliStatusSnapshot：拒绝超过 64 KiB 的快照与 symlink 文件', {
  skip: process.platform === 'win32',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-hostile-'));
  try {
    const snapshot = normalizeCliStatusInput({
      session_id: 'session-hostile',
      workspace: { current_dir: '/repo' },
    }, { capturedAt: 1_000 });
    const path = writeCliStatusSnapshot(snapshot, { dir });

    writeFileSync(path, JSON.stringify({ ...snapshot, padding: 'x'.repeat(70_000) }), { mode: 0o600 });
    assert.deepEqual(readCliStatusSnapshot('session-hostile', {
      dir, cwd: '/repo', now: 1_100, ttlMs: 1_000,
    }), { state: 'oversized' });

    unlinkSync(path);
    const target = join(dir, 'attacker-controlled.json');
    writeFileSync(target, JSON.stringify(snapshot), { mode: 0o600 });
    symlinkSync(target, path);
    assert.deepEqual(readCliStatusSnapshot('session-hostile', {
      dir, cwd: '/repo', now: 1_100, ttlMs: 1_000,
    }), { state: 'insecure' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCliStatusSnapshot：未显式传 TTL 时按快照刷新周期套用默认公式', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-default-ttl-'));
  try {
    const snapshot = normalizeCliStatusInput({
      session_id: 'session-default-ttl',
      workspace: { current_dir: '/repo' },
    }, { capturedAt: 1_000, refreshIntervalSec: 10 });
    writeCliStatusSnapshot(snapshot, { dir });

    assert.equal(readCliStatusSnapshot('session-default-ttl', {
      dir, cwd: '/repo', now: 31_000,
    }).state, 'fresh'); // age=30s，恰在下限 TTL 边界内
    assert.deepEqual(readCliStatusSnapshot('session-default-ttl', {
      dir, cwd: '/repo', now: 31_001,
    }), { state: 'stale', ageMs: 30_001 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCliStatusSnapshot：rename 前失败也清理唯一 tmp，不留下半截文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-write-fail-'));
  try {
    const snapshot = normalizeCliStatusInput({
      session_id: 'session-circular',
      workspace: { current_dir: '/repo' },
    }, { capturedAt: 1_000 });
    snapshot.circular = snapshot; // 让 JSON.stringify 在打开 tmp 后稳定失败。

    assert.throws(() => writeCliStatusSnapshot(snapshot, { dir }), /circular/i);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCliStatusSnapshot：多进程同 session 争写后仍只有一个完整快照', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-statusline-concurrent-'));
  const moduleUrl = pathToFileURL(join(process.cwd(), 'cli-statusline-bridge.js')).href;
  const worker = `
    import { writeCliStatusSnapshot } from ${JSON.stringify(moduleUrl)};
    const dir = process.argv[1];
    const n = Number(process.argv[2]);
    writeCliStatusSnapshot({
      schemaVersion: 1,
      source: 'claude-cli',
      capturedAt: n,
      sessionId: 'same-session',
      cwd: '/repo',
      writer: n,
    }, { dir });
  `;
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolveWorker, rejectWorker) => {
      const child = spawn(process.execPath, [
        '--input-type=module', '-e', worker, dir, String(index + 1),
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', rejectWorker);
      child.on('close', code => {
        if (code === 0) resolveWorker();
        else rejectWorker(new Error(`worker exited ${code}: ${stderr}`));
      });
    })));

    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{64}\.json$/);
    const snapshot = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    assert.equal(snapshot.sessionId, 'same-session');
    assert.ok(snapshot.writer >= 1 && snapshot.writer <= 8);
    assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
