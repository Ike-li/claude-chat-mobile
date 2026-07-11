// test/message-dedup.test.mjs —— 客户端消息 ID 去重纯函数单测（承接 REL-01：离线输入幂等）
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAndRecord, DEDUP_CAP } from '../message-dedup.js';

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
