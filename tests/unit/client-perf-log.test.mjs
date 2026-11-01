// tests/unit/client-perf-log.test.mjs —— 前端性能上报（logs:clientPerf）落服务端日志前的载荷清洗单测。
// 载荷是不可信客户端输入：只留形状对的数字、布尔、短字符串，键名、层数、条数、总长都有上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatClientPerfLine } from '../../app/src/ops/client-perf-log.js';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36';

test.describe('formatClientPerfLine', () => {
  test('正常一批 → 单行 JSON，带上连接号和 UA，数字、布尔、字符串原样', () => {
    const line = formatClientPerfLine({
      v: 1,
      ctx: { standalone: true, dpr: 2.625, net: { type: '4g', rtt: 450, down: 1.45 } },
      events: [{ k: 'startup', total: 3620, marks: { connect: 1250 }, discarded: false }],
    }, { socketId: 'abc', ua: UA });
    assert.ok(!line.includes('\n'));
    assert.deepEqual(JSON.parse(line), {
      sid: 'abc', ua: UA, v: 1,
      ctx: { standalone: true, dpr: 2.63, net: { type: '4g', rtt: 450, down: 1.45 } },
      events: [{ k: 'startup', total: 3620, marks: { connect: 1250 }, discarded: false }],
    });
  });

  test('形状不对 → null（调用方丢弃）；最小的合法一批照常出行', () => {
    for (const payload of [null, 'str', 42, [], {}, { v: 2, events: [] }, { v: 1 }, { v: 1, events: 'x' }]) {
      assert.equal(formatClientPerfLine(payload, { socketId: 's' }), null, JSON.stringify(payload));
    }
    assert.deepEqual(JSON.parse(formatClientPerfLine({ v: 1, events: [] }, { socketId: 's' })), { sid: 's', ua: null, v: 1, events: [] });
  });

  test('敌意载荷：怪键名、非有限数、函数丢掉；字符串截短、折叠换行、脱敏；层数和条数有上限', () => {
    let deep = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { d: deep };
    const payload = JSON.parse(JSON.stringify({
      v: 1,
      events: [{ k: 'frame', 'a b': 1, $x: 2, ok: 3, big: 1e99 }],
      deep,
      note: `第一行\n第二行 sk-ant_${'a'.repeat(30)} ${'长'.repeat(500)}`,
      many: Array.from({ length: 1000 }, (_, i) => i),
    }));
    payload.__proto__ = { polluted: true };
    payload.nan = NaN;
    payload.fn = () => 1;
    const out = JSON.parse(formatClientPerfLine(payload, { socketId: 's', ua: 'u'.repeat(1000) }));
    assert.deepEqual(out.events, [{ k: 'frame', ok: 3, big: 1e9 }]);
    assert.ok(!('nan' in out) && !('fn' in out) && !Object.hasOwn(out, '__proto__'));
    assert.ok(!out.note.includes('\n') && !out.note.includes('sk-ant_'), out.note);
    assert.ok(out.note.length <= 200, `字符串应截短，实际 ${out.note.length}`);
    assert.ok(out.ua.length <= 200);
    assert.ok(out.many.length <= 200);
    assert.ok(!JSON.stringify(out.deep).includes('leaf'), '超过层数上限的部分不该留下');
    assert.equal(({}).polluted, undefined);
  });

  test('清洗后仍超长 → null，不往日志里写半截；正常大小的一批照写', () => {
    const frames = n => Array.from({ length: n }, () => ({ k: 'frame', scripts: Array.from({ length: 3 }, () => ({ src: 'x'.repeat(100), fn: 'y'.repeat(60) })) }));
    assert.equal(formatClientPerfLine({ v: 1, events: frames(200) }, { socketId: 's' }), null);
    assert.equal(JSON.parse(formatClientPerfLine({ v: 1, events: frames(30) }, { socketId: 's' })).events.length, 30);
  });
});
