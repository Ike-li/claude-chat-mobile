// tests/unit/read-state.test.mjs —— 跨设备共享已读位点的服务端存储（2026-09-03）
//
// 起因：抽屉未读全存 localStorage，换设备后 seen 表为空、全部回落到「本设备首次打开时刻」这个很老的
// 基线，于是在另一台设备上读过的会话整屏复亮。已读位点搬到服务端共享，本地降级为离线缓存。
//
// 本模块只做「多客户端增量归并 + 落盘」，判定仍在前端 logic/unread.js（前后端不得互相 import，
// 合并语义在两侧各写一份，见该文件头注）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReadStateStore } from '../../app/src/sessions/read-state.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

let TMP_DIR;
let fileSeq = 0;

// 每个用例一个独立文件：模块级单例的落盘路径在 import 时锁定，工厂形态才测得动多份状态。
function newStore(opts = {}) {
  return createReadStateStore({ file: join(TMP_DIR, `read-state-${++fileSeq}.json`), ...opts });
}

test.describe('read-state.js：服务端共享已读位点', () => {
  test.before(() => { TMP_DIR = mkdtempSync(join(tmpdir(), 'ccm-read-state-test-')); });
  test.after(() => { if (TMP_DIR) rmSync(TMP_DIR, { recursive: true, force: true }); }); // safe-rm: mkdtemp 一次性目录

  test('首次读取即建档：baselineTs 钉在此刻，seen/manual 空', () => {
    const s = newStore({ now: () => T0 });
    assert.deepEqual(s.getState(), { baselineTs: T0, seen: {}, manual: {} });
  });

  test('★ baselineTs 建档后永不改变——客户端上报的基线一律忽略（全局单一基线是这次修复的根）', () => {
    const s = newStore({ now: () => T0 });
    s.getState();
    s.applyClientState({ baselineTs: T0 - 99 * MIN, seen: {}, manual: {} });
    assert.equal(s.getState().baselineTs, T0, '客户端更老的基线不得回传染');
    s.applyClientState({ baselineTs: T0 + 99 * MIN, seen: {}, manual: {} });
    assert.equal(s.getState().baselineTs, T0, '更新的也不行');
  });

  test('applyClientState 合并客户端表并返回权威态（升级时本地已读表由此迁移上来）', () => {
    const s = newStore({ now: () => T0 });
    const merged = s.applyClientState({ seen: { a: T0 + MIN }, manual: { b: T0 + 2 * MIN } });
    assert.equal(merged.baselineTs, T0);
    assert.equal(merged.seen.a, T0 + MIN);
    assert.equal(merged.manual.b, T0 + 2 * MIN);
  });

  test('seen 逐会话取较晚时间戳，不回退（乱序到达的旧 ack 不得把位点拨旧）', () => {
    const s = newStore({ now: () => T0 });
    s.markRead('a', T0 + 5 * MIN);
    s.markRead('a', T0 + MIN);
    assert.equal(s.getState().seen.a, T0 + 5 * MIN);
  });

  test('markRead 缺省时间 = now', () => {
    const s = newStore({ now: () => T0 });
    s.markRead('a');
    assert.equal(s.getState().seen.a, T0);
  });

  test('setManual(on) 记标记时刻；setManual(off) 记 seen 并移除标记（与前端 tracker 对称）', () => {
    const s = newStore({ now: () => T0 });
    s.setManual('a', true, T0 + MIN);
    assert.equal(s.getState().manual.a, T0 + MIN);
    s.setManual('a', false, T0 + 2 * MIN);
    assert.equal(s.getState().manual.a, undefined, '标记条目移除');
    assert.equal(s.getState().seen.a, T0 + 2 * MIN, '★ 必须同时记 seen——只删标记的话别的设备合并回来又亮');
  });

  test('脏 sessionId / 脏时间戳一律忽略，不写进表也不抛', () => {
    const s = newStore({ now: () => T0 });
    for (const bad of [null, undefined, '', 42, {}]) s.markRead(bad, T0);
    s.markRead('a', NaN);
    s.markRead('b', 'later');
    assert.deepEqual(s.getState().seen, {});
    assert.doesNotThrow(() => s.applyClientState(null));
    assert.doesNotThrow(() => s.applyClientState({ seen: 'x', manual: [1] }));
  });

  test('客户端上报里的非数字值被丢弃（多设备里可能有被手改的 localStorage）', () => {
    const s = newStore({ now: () => T0 });
    const merged = s.applyClientState({ seen: { a: 'x', b: T0 }, manual: { c: null, d: T0 } });
    assert.deepEqual(merged.seen, { b: T0 });
    assert.deepEqual(merged.manual, { d: T0 });
  });

  test('容量上限：超出按 ts 淘汰最旧', () => {
    const s = newStore({ now: () => T0, seenCap: 2 });
    s.markRead('old', T0);
    s.markRead('mid', T0 + MIN);
    s.markRead('new', T0 + 2 * MIN);
    assert.deepEqual(Object.keys(s.getState().seen).sort(), ['mid', 'new']);
  });

  test('返回的是快照，调用方改不动内部状态', () => {
    const s = newStore({ now: () => T0 });
    const snap = s.getState();
    snap.seen.hacked = T0;
    snap.baselineTs = 0;
    assert.deepEqual(s.getState().seen, {});
    assert.equal(s.getState().baselineTs, T0);
  });

  test('落盘往返：flush 后另开一个 store 读同一文件，状态一致', () => {
    const file = join(TMP_DIR, 'roundtrip.json');
    const a = createReadStateStore({ file, now: () => T0 });
    a.markRead('s1', T0 + MIN);
    a.setManual('s2', true, T0 + 2 * MIN);
    a.flushSaveSync();
    const b = createReadStateStore({ file, now: () => T0 + 999 * MIN });
    assert.deepEqual(b.getState(), { baselineTs: T0, seen: { s1: T0 + MIN }, manual: { s2: T0 + 2 * MIN } });
  });

  test('★ 损坏/形状不对的文件当作没有，重新建档而不是崩——这是缓存类状态，随时可删', () => {
    for (const bad of ['{not json', '[]', '42', '{"baselineTs":"x"}']) {
      const file = join(TMP_DIR, `bad-${++fileSeq}.json`);
      writeFileSync(file, bad);
      const s = createReadStateStore({ file, now: () => T0 });
      assert.deepEqual(s.getState(), { baselineTs: T0, seen: {}, manual: {} }, bad);
    }
  });

  test('文件权限 0600（表里是会话 id 清单，与 sessions.json / approval-store 同档）', () => {
    const file = join(TMP_DIR, 'perm.json');
    const s = createReadStateStore({ file, now: () => T0 });
    s.markRead('s1', T0);
    s.flushSaveSync();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).seen.s1, T0);
  });
});
