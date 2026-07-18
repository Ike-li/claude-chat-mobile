// logic.js 客户端日志持久化/导出域纯函数单测：序列化(schema+截断)、反序列化(容错+restored)、
// 节流决策、复制文本拼接、恢复分隔判定。全部数据→数据，零 DOM/storage。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeClientLogs, deserializeClientLogs, shouldPersistLog, formatLogsForCopy, isRestoredBoundary,
} from '../../public/js/logic.js';

const mk = (over = {}) => ({ ts: 1000, type: 'client_conn', text: 'connected', instanceId: null, ...over });

test.describe('serializeClientLogs', () => {
  test('产出带 schema 版本的 JSON，可被 deserialize 往返', () => {
    const entries = [mk(), mk({ ts: 2000, type: 'client_send', text: 'sent', instanceId: 'inst_1' })];
    const raw = serializeClientLogs(entries);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.v, 1);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[1].text, 'sent');
  });
  test('超过 max 只保留最后 max 条（防 localStorage 超配额）', () => {
    const entries = Array.from({ length: 20 }, (_, i) => mk({ ts: i }));
    const parsed = JSON.parse(serializeClientLogs(entries, { max: 5 }));
    assert.equal(parsed.entries.length, 5);
    assert.deepEqual(parsed.entries.map(e => e.ts), [15, 16, 17, 18, 19]);
  });
});

test.describe('deserializeClientLogs', () => {
  test('正常往返：每条打 restored 标记（渲染层据此分隔上次会话）', () => {
    const raw = serializeClientLogs([mk(), mk({ ts: 2000 })]);
    const back = deserializeClientLogs(raw);
    assert.equal(back.length, 2);
    assert.equal(back[0].restored, true);
    assert.equal(back[0].text, 'connected');
  });
  test('坏输入一律 → []（不崩、不污染）', () => {
    assert.deepEqual(deserializeClientLogs(null), []);
    assert.deepEqual(deserializeClientLogs(''), []);
    assert.deepEqual(deserializeClientLogs('not json'), []);
    assert.deepEqual(deserializeClientLogs('{"v":1}'), []);        // 缺 entries
    assert.deepEqual(deserializeClientLogs('{"entries":[]}'), []); // 缺版本
  });
  test('schema 版本不符 → []（旧格式安全丢弃、不迁移）', () => {
    assert.deepEqual(deserializeClientLogs('{"v":99,"entries":[{"ts":1,"text":"x"}]}'), []);
  });
  test('entries 内非对象项被过滤', () => {
    const back = deserializeClientLogs('{"v":1,"entries":[{"ts":1,"type":"client_conn","text":"ok"},null,42,"str"]}');
    assert.equal(back.length, 1);
    assert.equal(back[0].text, 'ok');
  });
});

test.describe('shouldPersistLog：节流决策', () => {
  test('从未写过（lastTs 空）→ 立即写', () => {
    assert.equal(shouldPersistLog(null, 5000), true);
    assert.equal(shouldPersistLog(undefined, 5000), true);
  });
  test('间隔已到 → 写；未到 → 不写', () => {
    assert.equal(shouldPersistLog(1000, 3000, 2000), true);  // 差 2000 >= 2000
    assert.equal(shouldPersistLog(1000, 2999, 2000), false); // 差 1999 < 2000
  });
});

test.describe('formatLogsForCopy：导出多行文本', () => {
  test('每行 [本地时间] type text，按序拼接', () => {
    const out = formatLogsForCopy([
      mk({ ts: Date.UTC(2026, 6, 18, 3, 0, 0), type: 'client_conn', text: '连接成功' }),
      mk({ ts: Date.UTC(2026, 6, 18, 3, 1, 0), type: 'client_send', text: '发送 X' }),
    ]);
    const lines = out.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[.+\] conn 连接成功$/);
    assert.match(lines[1], /^\[.+\] send 发送 X$/);
  });
  test('空/非数组 → 空串', () => {
    assert.equal(formatLogsForCopy([]), '');
    assert.equal(formatLogsForCopy(null), '');
  });
});

test.describe('isRestoredBoundary：本次会话分隔线判定', () => {
  // 合并按 ts 升序：恢复段(上次会话，ts 早)在前、本次会话在后。分隔线画在交界处、标记「本次会话开始」。
  test('恢复段末尾→本次会话开头（prev restored、当前非 restored）→ true', () => {
    assert.equal(isRestoredBoundary(mk({ restored: true }), mk({ restored: false })), true);
    assert.equal(isRestoredBoundary(mk({ restored: true }), mk()), true);            // 本次条目无 restored 字段
    assert.equal(isRestoredBoundary(mk({ restored: true }), mk({ restored: true })), false); // 恢复段内部不画
    assert.equal(isRestoredBoundary(null, mk({ restored: true })), false);            // 顶部即恢复段、不画
    assert.equal(isRestoredBoundary(mk(), mk()), false);                             // 全本次、不画
  });
});
