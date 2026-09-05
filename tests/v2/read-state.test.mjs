// tests/v2/read-state.test.mjs —— 未读位点跨设备单调合并与防整屏复亮
// 守护：READ-01（LWW 单调递增；手动标未读不用「删条目」表达已读，否则会被别的设备复活）
// 覆盖：多设备增量归并（LWW 单调递增）+ baselineTs 免疫污染 + 手动标已读记 seen 阻断旧 manual 复活 + 乱序上报不整屏复亮
// 槽位：S1（纯函数 + 一次性目录状态机）
// 不测什么 + 为什么：不测浏览器 localStorage 与真实 DOM 渲染（属于 S3 UI/E2E 槽）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createReadStateStore } from '../../app/src/sessions/read-state.js';
import { isSessionUnread, isManualUnreadNow } from '../../app/public/js/logic/unread.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

let TMP_DIR;
let fileSeq = 0;

function createStore(opts = {}) {
  return createReadStateStore({
    file: join(TMP_DIR, `read-state-${++fileSeq}.json`),
    ...opts,
  });
}

test.before(() => {
  TMP_DIR = mkdtempSync(join(tmpdir(), 'ccm-v2-read-state-'));
});
test.after(() => {
  if (TMP_DIR) rmSync(TMP_DIR, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

test.describe('READ-01: 服务端共享已读位点单调合并与基线保护', () => {

  test('首次读取即建档，baselineTs 钉在此时此刻', () => {
    const s = createStore({ now: () => T0 });
    assert.deepEqual(s.getState(), { baselineTs: T0, seen: {}, manual: {} });
  });

  test('baselineTs 建档后永不改变：客户端上报的任何基线一律忽略，防整屏复亮放大器', () => {
    const s = createStore({ now: () => T0 });
    s.getState();

    // 较老设备的旧基线尝试回传
    s.applyClientState({ baselineTs: T0 - 100 * MIN, seen: {}, manual: {} });
    assert.equal(s.getState().baselineTs, T0, '客户端更老的基线不得回传染');

    // 更新设备的基线尝试覆盖
    s.applyClientState({ baselineTs: T0 + 100 * MIN, seen: {}, manual: {} });
    assert.equal(s.getState().baselineTs, T0, '更新的基线也不得覆盖');
  });

  test('seen 位点按会话取最新时间戳，单调不回退（乱序到达旧 ack 不拨旧位点）', () => {
    const s = createStore({ now: () => T0 });
    s.markRead('session-1', T0 + 5 * MIN);
    s.markRead('session-1', T0 + 1 * MIN); // 较旧的晚到达
    assert.equal(s.getState().seen['session-1'], T0 + 5 * MIN, '必须保留较晚时间戳');
  });

  test('applyClientState 增量归并：逐会话取 max 时间戳', () => {
    const s = createStore({ now: () => T0 });
    s.markRead('s-a', T0 + 10 * MIN);
    s.markRead('s-b', T0 + 20 * MIN);

    const merged = s.applyClientState({
      seen: {
        's-a': T0 + 5 * MIN,  // 客户端较旧 -> 被服务端保留
        's-b': T0 + 25 * MIN, // 客户端较新 -> 更新为较新
        's-c': T0 + 15 * MIN, // 客户端新增 -> 补入
      },
    });

    assert.equal(merged.seen['s-a'], T0 + 10 * MIN);
    assert.equal(merged.seen['s-b'], T0 + 25 * MIN);
    assert.equal(merged.seen['s-c'], T0 + 15 * MIN);
  });
});

test.describe('READ-01: 手动标已读写 seen 阻断旧 manual 复活（防整屏复亮核心）', () => {
  test('setManual(false) 必须同时记 seen，阻止另一台离线设备把旧 manual 同步回来后复活', () => {
    const s = createStore({ now: () => T0 });

    // 设备 A：在 T0+10MIN 手动标未读
    s.setManual('sess-target', true, T0 + 10 * MIN);
    assert.equal(s.getState().manual['sess-target'], T0 + 10 * MIN);

    // 设备 A：在 T0+20MIN 打开会话看完了，标为已读（setManual off）
    s.setManual('sess-target', false, T0 + 20 * MIN);
    assert.equal(s.getState().manual['sess-target'], undefined, '服务端已移除 manual 标记');
    assert.equal(s.getState().seen['sess-target'], T0 + 20 * MIN, '★ 必须记录 seen=T0+20MIN');

    // 模拟离线设备 B 此时上线，带着它本地缓存的旧 manual（T0+10MIN 的手动未读标记）进行增量归并
    const clientBState = {
      manual: { 'sess-target': T0 + 10 * MIN },
      seen: {},
    };
    const authoritative = s.applyClientState(clientBState);

    // 验证：即使 manual 里合并进了设备 B 上报的旧条目，seen['sess-target'] 仍然大于 manual['sess-target']
    assert.equal(authoritative.seen['sess-target'], T0 + 20 * MIN);
    assert.equal(authoritative.manual['sess-target'], T0 + 10 * MIN);

    // 配合前端 isManualUnreadNow 判定：因为 seen >= manual，该会话绝不点亮！
    const isUnread = isManualUnreadNow(authoritative.manual, authoritative.seen, 'sess-target');
    assert.equal(isUnread, false, '旧 manual 条目不得导致会话整屏复亮！');
  });

  test('多设备乱序交织上报：最终状态收敛且判定幂等', () => {
    const s = createStore({ now: () => T0 });

    // 设备 1 和设备 2 交叉上报位点
    s.applyClientState({
      seen: { s1: T0 + 5 * MIN, s2: T0 + 2 * MIN },
      manual: { s3: T0 + 3 * MIN },
    });

    s.applyClientState({
      seen: { s1: T0 + 2 * MIN, s2: T0 + 8 * MIN },
      manual: { s3: T0 + 7 * MIN },
    });

    const state = s.getState();
    assert.equal(state.seen.s1, T0 + 5 * MIN);
    assert.equal(state.seen.s2, T0 + 8 * MIN);
    assert.equal(state.manual.s3, T0 + 7 * MIN);

    // 校验未读判定纯函数在多设备会话下的正确性
    assert.equal(isSessionUnread({ lastUsedAt: T0 + 4 * MIN, seenAt: state.seen.s1 }), false);
    assert.equal(isSessionUnread({ lastUsedAt: T0 + 6 * MIN, seenAt: state.seen.s1 }), true);
    assert.equal(isSessionUnread({ lastUsedAt: T0 + 10 * MIN, seenAt: state.seen.s2 }), true);
    assert.equal(isSessionUnread({ isViewing: true, lastUsedAt: T0 + 100 * MIN }), false, '当前正在查看的会话恒不亮');
  });
});

test.describe('READ-01: 容量限制与持久化健壮性', () => {
  test('超出 seenCap / manualCap 时按时间戳淘汰最旧记录', () => {
    const s = createStore({ now: () => T0, seenCap: 2, manualCap: 2 });
    s.markRead('s-old', T0 + 1 * MIN);
    s.markRead('s-mid', T0 + 2 * MIN);
    s.markRead('s-new', T0 + 3 * MIN);

    assert.deepEqual(Object.keys(s.getState().seen).sort(), ['s-mid', 's-new']);

    s.setManual('m-old', true, T0 + 1 * MIN);
    s.setManual('m-mid', true, T0 + 2 * MIN);
    s.setManual('m-new', true, T0 + 3 * MIN);

    assert.deepEqual(Object.keys(s.getState().manual).sort(), ['m-mid', 'm-new']);
  });

  test('脏输入防御：非字符串 sessionId / NaN 时间戳直接忽略，不抛异常', () => {
    const s = createStore({ now: () => T0 });
    s.markRead(null, T0);
    s.markRead(undefined, T0);
    s.markRead('', T0);
    s.markRead('valid', NaN);
    s.markRead('valid', 'invalid-ts');

    assert.deepEqual(s.getState().seen, {});
    assert.doesNotThrow(() => s.applyClientState({ seen: null, manual: 'bad' }));
  });

  test('文件损坏自动恢复：读到损坏 JSON 退化为空状态重新建档', () => {
    const file = join(TMP_DIR, 'corrupted-read-state.json');
    writeFileSync(file, '{ corrupt broken json !!!');

    const s = createReadStateStore({ file, now: () => T0 });
    assert.deepEqual(s.getState(), { baselineTs: T0, seen: {}, manual: {} });
  });

  test('落盘权限 0600 并保证原子写', () => {
    const file = join(TMP_DIR, 'secure-read-state.json');
    const s = createReadStateStore({ file, now: () => T0 });
    s.markRead('s-sec', T0 + MIN);
    s.flushSaveSync();

    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
    const content = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(content.seen['s-sec'], T0 + MIN);
  });
});
