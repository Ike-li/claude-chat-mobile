// tests/unit/message-dedup.test.mjs —— 客户端消息 ID 去重纯函数单测（承接 REL-01：离线输入幂等）
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndRecord, isProcessed, commitProcessed, DEDUP_CAP, isInFlight, claimInFlight, releaseInFlight } from '../../src/agent/message-dedup.js';

test.describe('checkAndRecord', () => {
  test('首次出现的 clientMessageId → 不重复，记录', () => {
    const r = checkAndRecord('msg-1', new Map());
    assert.equal(r.duplicate, false);
    assert.ok(r.next.has('msg-1'));
  });

  test('同一 clientMessageId 第二次 → 判定重复，不新增记录', () => {
    const r1 = checkAndRecord('msg-1', new Map());
    const r2 = checkAndRecord('msg-1', r1.next);
    assert.equal(r2.duplicate, true);
    assert.equal(r2.next, r1.next, '重复时应原样返回引用，不做变更');
  });

  test('不同 clientMessageId 互不影响', () => {
    const r1 = checkAndRecord('msg-1', new Map());
    const r2 = checkAndRecord('msg-2', r1.next);
    assert.equal(r2.duplicate, false);
    assert.ok(r2.next.has('msg-1'));
    assert.ok(r2.next.has('msg-2'));
  });

  test('缺失/空 clientMessageId（旧客户端未传）→ 不去重，原样放行', () => {
    assert.equal(checkAndRecord(undefined, new Map()).duplicate, false);
    assert.equal(checkAndRecord(null, new Map()).duplicate, false);
    assert.equal(checkAndRecord('', new Map()).duplicate, false);
  });

  test('超过上限 → 清除最旧的一条（有界窗口，防内存无限增长）', () => {
    let state = new Map();
    for (let i = 0; i < 3; i++) {
      state = checkAndRecord(`msg-${i}`, state, 3).next;
    }
    assert.equal(state.size, 3);
    const r = checkAndRecord('msg-3', state, 3); // 第 4 条，上限 3 → 应清最旧的 msg-0
    assert.equal(r.next.size, 3);
    assert.equal(r.next.has('msg-0'), false, '最旧的一条应被清除');
    assert.equal(r.next.has('msg-1'), true);
    assert.equal(r.next.has('msg-2'), true);
    assert.equal(r.next.has('msg-3'), true);
  });

  test('默认上限 DEDUP_CAP 导出为正整数（供调用方了解容量量级）', () => {
    assert.equal(typeof DEDUP_CAP, 'number');
    assert.ok(DEDUP_CAP > 0);
  });
});

// BE-002：拆分「查询」与「提交」——去重 ID 必须在消息成功入队后才提交，否则校验失败/队满失败
// 会把 ID 提前登记，第二次重发命中 dedup 被假成功丢弃（原 checkAndRecord 把两步耦合成一步是根因）。
test.describe('isProcessed / commitProcessed（BE-002：查询与提交分离）', () => {
  test('isProcessed 只查询、无副作用', () => {
    const state = new Map();
    assert.equal(isProcessed('m1', state), false);
    assert.equal(isProcessed('m1', state), false, '再查仍 false（isProcessed 不写入）');
    assert.equal(state.size, 0, 'isProcessed 不得修改 state');
  });

  test('commitProcessed 后 isProcessed 才为 true', () => {
    let state = new Map();
    assert.equal(isProcessed('m1', state), false);
    state = commitProcessed('m1', state);
    assert.equal(isProcessed('m1', state), true);
  });

  test('失败路径只 check 不 commit → 同 ID 重发不被判 duplicate（核心回归）', () => {
    let state = new Map();
    // 第一次：查（未处理）→ 假设处理失败（队满/超长）→ 不 commit
    assert.equal(isProcessed('m1', state), false);
    // 第二次重发：仍未 commit → 不得被判 duplicate（否则假成功丢消息）
    assert.equal(isProcessed('m1', state), false);
    // 只有成功后 commit，后续重发才判 duplicate
    state = commitProcessed('m1', state);
    assert.equal(isProcessed('m1', state), true);
  });

  test('commitProcessed 空/缺失 ID（旧客户端）→ 原样返回、永不判 processed', () => {
    const state = new Map();
    assert.equal(commitProcessed(undefined, state), state);
    assert.equal(commitProcessed('', state), state);
    assert.equal(isProcessed(undefined, state), false);
    assert.equal(isProcessed('', state), false);
  });

  test('commitProcessed 有界：超上限清最旧一条', () => {
    let state = new Map();
    for (let i = 0; i < 3; i++) state = commitProcessed(`m${i}`, state, 3);
    state = commitProcessed('m3', state, 3);
    assert.equal(state.size, 3);
    assert.equal(isProcessed('m0', state), false, '最旧一条应被清除');
    assert.equal(isProcessed('m3', state), true);
  });

  test('commitProcessed 幂等：已提交再提交返回原引用、不重复写', () => {
    const state = commitProcessed('m1', new Map());
    const again = commitProcessed('m1', state);
    assert.equal(again, state, '已存在应原样返回引用');
  });

  test('checkAndRecord 语义不变（现有调用方兼容，用新原语组合实现）', () => {
    const r1 = checkAndRecord('m1', new Map());
    assert.equal(r1.duplicate, false);
    assert.ok(r1.next.has('m1'));
    const r2 = checkAndRecord('m1', r1.next);
    assert.equal(r2.duplicate, true);
    assert.equal(r2.next, r1.next);
  });
});

// 回归：isProcessed/commitProcessed 之间（校验、resolveTarget、a.send 等多个 await）不是原子的——
// 断线重连重发可能让同一 clientMessageId 的第二个请求在第一个请求 commit 之前就跑到同一段代码，
// 两边都会各自调一次 a.send()，造成真实的重复发送（而不仅是重复 ack）。isInFlight/claimInFlight/
// releaseInFlight 补一层"眼下有没有人正处理这条、尚未落定成败"的临时占用，与 isProcessed/commitProcessed
// 的"已经处理完的永久记录"是两码事：处理失败也必须 release，否则失败重试会被误判为"仍在处理中"卡死
// （对称于 commitProcessed 的"失败不 commit"设计，此处是"失败也要 release"）。
test.describe('isInFlight / claimInFlight / releaseInFlight（并发去重：处理中占用，非永久记录）', () => {
  test('未声明占用 → isInFlight 为 false', () => {
    assert.equal(isInFlight('m1', new Set()), false);
  });

  test('claimInFlight 后 isInFlight 为 true', () => {
    let s = new Set();
    s = claimInFlight('m1', s);
    assert.equal(isInFlight('m1', s), true);
  });

  test('release 后 isInFlight 恢复 false（无论原处理成功还是失败都应能 release）', () => {
    let s = new Set();
    s = claimInFlight('m1', s);
    s = releaseInFlight('m1', s);
    assert.equal(isInFlight('m1', s), false);
  });

  test('claimInFlight 幂等：重复 claim 同一 id 不产生额外状态', () => {
    let s = claimInFlight('m1', new Set());
    const s2 = claimInFlight('m1', s);
    assert.equal(s2, s, '已占用应原样返回引用');
  });

  test('releaseInFlight 对未占用的 id 是 no-op（原样返回引用）', () => {
    const s = new Set();
    assert.equal(releaseInFlight('m1', s), s);
  });

  test('不同 clientMessageId 互不影响', () => {
    let s = claimInFlight('m1', new Set());
    s = claimInFlight('m2', s);
    assert.equal(isInFlight('m1', s), true);
    assert.equal(isInFlight('m2', s), true);
    s = releaseInFlight('m1', s);
    assert.equal(isInFlight('m1', s), false);
    assert.equal(isInFlight('m2', s), true, '释放一条不该连带释放另一条');
  });

  test('缺失/空 clientMessageId（旧客户端）→ 三个原语均不生效，恒 false/原样返回', () => {
    const s = new Set();
    assert.equal(isInFlight(undefined, s), false);
    assert.equal(isInFlight('', s), false);
    assert.equal(claimInFlight(undefined, s), s);
    assert.equal(claimInFlight('', s), s);
    assert.equal(releaseInFlight(undefined, s), s);
  });
});
