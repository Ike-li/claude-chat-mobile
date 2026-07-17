// CLI background session lock — pure helpers + release orchestration (injected kill/list).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findBgLocksForSession,
  shouldReleaseBgLock,
  formatSessionLockError,
  parseAgentsJson,
  releaseBgLocksForSession,
  prepareSessionForWebResume,
} from '../../src/ops/cli-bg-session-lock.js';

const SID = '2c55ae09-1672-4d7a-9fa7-885a726ad4ab';

test.describe('findBgLocksForSession', () => {
  test('只匹配 kind=background 且 sessionId 命中', () => {
    const agents = [
      { kind: 'background', sessionId: SID, pid: 1531, name: 'top-right plus logic' },
      { kind: 'interactive', sessionId: SID, pid: 99, name: 'should-not-match' },
      { kind: 'background', sessionId: 'other', pid: 1, name: 'other' },
    ];
    const locks = findBgLocksForSession(agents, SID);
    assert.equal(locks.length, 1);
    assert.equal(locks[0].pid, 1531);
  });

  test('空/畸形输入 → []', () => {
    assert.deepEqual(findBgLocksForSession(null, SID), []);
    assert.deepEqual(findBgLocksForSession([], SID), []);
    assert.deepEqual(findBgLocksForSession([{ kind: 'background' }], null), []);
  });
});

test.describe('shouldReleaseBgLock', () => {
  test('background + 有效 pid → true', () => {
    assert.equal(shouldReleaseBgLock({ kind: 'background', pid: 1531 }), true);
  });
  test('interactive / 无 pid → false', () => {
    assert.equal(shouldReleaseBgLock({ kind: 'interactive', pid: 1 }), false);
    assert.equal(shouldReleaseBgLock({ kind: 'background' }), false);
    assert.equal(shouldReleaseBgLock({ kind: 'background', pid: 0 }), false);
  });
});

test.describe('formatSessionLockError', () => {
  test('background / interactive 文案可区分，且不含「历史被清理」', () => {
    const bg = formatSessionLockError({ kind: 'background', name: 'top-right', pid: 1 });
    assert.match(bg, /后台 agent/);
    assert.doesNotMatch(bg, /历史可能已被清理/);
    const inter = formatSessionLockError({ kind: 'interactive', name: 'cli', pid: 2 });
    assert.match(inter, /终端 CLI|驾驶/);
    const raw = formatSessionLockError({ rawMessage: 'Session x is currently running as a background agent (bg).' });
    assert.match(raw, /后台 agent|自动尝试释放/);
  });
});

test.describe('parseAgentsJson', () => {
  test('纯数组 / 前缀噪音', () => {
    assert.equal(parseAgentsJson(JSON.stringify([{ a: 1 }])).length, 1);
    assert.equal(parseAgentsJson('warn\n[{"id":"x"}]\n').length, 1);
    assert.deepEqual(parseAgentsJson('not json'), []);
  });
});

test.describe('releaseBgLocksForSession（注入 kill，不碰真进程）', () => {
  test('对 background 发 SIGTERM，跳过 interactive', async () => {
    const signals = [];
    const agents = [
      { kind: 'background', sessionId: SID, pid: 111, name: 'bg' },
      { kind: 'interactive', sessionId: SID, pid: 222, name: 'cli' },
    ];
    const r = await releaseBgLocksForSession(SID, {
      agents,
      waitMs: 0,
      kill: (pid, sig) => { signals.push([pid, sig]); },
      isAlive: () => false,
    });
    assert.equal(r.locks.length, 1);
    assert.deepEqual(r.released, [111]);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(signals, [[111, 'SIGTERM']]);
  });

  test('SIGTERM 后仍存活 → SIGKILL', async () => {
    const signals = [];
    let alive = true;
    const r = await releaseBgLocksForSession(SID, {
      agents: [{ kind: 'background', sessionId: SID, pid: 333 }],
      waitMs: 0,
      kill: (pid, sig) => { signals.push([pid, sig]); if (sig === 'SIGKILL') alive = false; },
      isAlive: () => alive,
    });
    assert.deepEqual(signals, [[333, 'SIGTERM'], [333, 'SIGKILL']]);
    assert.deepEqual(r.released, [333]);
  });
});

test.describe('prepareSessionForWebResume', () => {
  test('无锁 → attempted=false', async () => {
    const out = await prepareSessionForWebResume(SID, {
      agents: [],
      waitMs: 0,
    });
    assert.equal(out.attempted, false);
    assert.equal(out.log, '');
  });

  test('有 bg 锁 → attempted + log 含 session 与 released', async () => {
    const out = await prepareSessionForWebResume(SID, {
      agents: [{ kind: 'background', sessionId: SID, pid: 444, name: 'top-right' }],
      waitMs: 0,
      kill: () => {},
      isAlive: () => false,
    });
    assert.equal(out.attempted, true);
    assert.match(out.log, /web resume 前释放 CLI 后台锁/);
    assert.match(out.log, new RegExp(SID));
    assert.match(out.log, /released=444/);
  });
});
