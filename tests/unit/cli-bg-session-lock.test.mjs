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
  prepareResumeInParallel,
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

test.describe('prepareResumeInParallel（性能优化：resume 前置三路从串行改并行，语义不变）', () => {
  test('三路在同一批微任务里发起，不等前一路 resolve 才调下一路', async () => {
    const invoked = [];
    const deferred = {};
    const makeDeferred = (name) => () => {
      invoked.push(name);
      return new Promise((resolve) => { deferred[name] = resolve; });
    };
    const resultPromise = prepareResumeInParallel({
      prepare: makeDeferred('prepare'),
      readMode: makeDeferred('readMode'),
      readModel: makeDeferred('readModel'),
    });
    // 让微任务队列跑完当前这几批：三路都应该已经被调用过，但都还没被 resolve。
    // 若实现退化成「先 await prepare 再顺序调用另外两路」，prepare 的 deferred 还没被我们手动
    // resolve，readMode/readModel 永远不会被调用到，下面的断言会缺项而失败（不是靠计时赌竞态）。
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual([...invoked].sort(), ['prepare', 'readMode', 'readModel']);
    // 交错 resolve 顺序：先 resolve 后两路，最后才 resolve prepare，验证返回值字段对应关系不受
    // resolve 顺序影响（Promise.all 保证按位置映射，不是按完成顺序）。
    deferred.readModel('model-x');
    deferred.readMode('mode-y');
    deferred.prepare({ attempted: true, log: 'L' });
    const result = await resultPromise;
    assert.deepEqual(result, {
      prep: { attempted: true, log: 'L' },
      transcriptMode: 'mode-y',
      transcriptModel: 'model-x',
    });
  });

  test('prepare 失败（reject）不阻塞另外两路，返回 {attempted:false,error} 而不是让整体 reject', async () => {
    const result = await prepareResumeInParallel({
      prepare: () => Promise.reject(new Error('spawn boom')),
      readMode: () => Promise.resolve('mode-a'),
      readModel: () => Promise.resolve('model-b'),
    });
    assert.equal(result.prep.attempted, false);
    assert.ok(result.prep.error instanceof Error);
    assert.equal(result.transcriptMode, 'mode-a');
    assert.equal(result.transcriptModel, 'model-b');
  });

  test('prepare 同步抛错（而非返回 rejected promise）同样被吞掉，不影响另外两路', async () => {
    const result = await prepareResumeInParallel({
      prepare: () => { throw new Error('sync boom'); },
      readMode: () => Promise.resolve('mode-a'),
      readModel: () => Promise.resolve('model-b'),
    });
    assert.equal(result.prep.attempted, false);
    assert.equal(result.transcriptMode, 'mode-a');
    assert.equal(result.transcriptModel, 'model-b');
  });

  test('三路都正常 resolve → 返回值原样透传', async () => {
    const result = await prepareResumeInParallel({
      prepare: () => Promise.resolve({ attempted: true, log: 'released', result: { locks: [1] } }),
      readMode: () => Promise.resolve('acceptEdits'),
      readModel: () => Promise.resolve('claude-sonnet-5'),
    });
    assert.deepEqual(result, {
      prep: { attempted: true, log: 'released', result: { locks: [1] } },
      transcriptMode: 'acceptEdits',
      transcriptModel: 'claude-sonnet-5',
    });
  });
});
