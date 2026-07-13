// test/message-dedup.test.mjs —— 客户端消息 ID 去重纯函数单测（承接 REL-01：离线输入幂等）
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndRecord, isProcessed, commitProcessed, DEDUP_CAP } from '../message-dedup.js';

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
