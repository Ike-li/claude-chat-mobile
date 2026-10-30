// tests/unit/logic-elicitation.test.mjs —— MCP elicitation 卡片（#460）的前端纯函数（app/public/js/logic/elicitation.js）
// 字段描述由服务端下发、校验也只在服务端；这里只管「表单控件里的原始值 → 交给服务端的 content」与卡片文案。
// 不测：DOM 接线、按钮、等待完成（S3，tests/e2e/specs/elicitation.spec.ts）
import test from 'node:test';
import assert from 'node:assert/strict';
import { dateTimeLocalValue, elicitationContentFromInputs, elicitationHeading, isHostLocalOrigin } from '../../app/public/js/logic/elicitation.js';

const fields = [
  { name: 'name', type: 'string', required: true },
  { name: 'note', type: 'string', required: false },
  { name: 'age', type: 'integer', required: false },
  { name: 'ratio', type: 'number', required: false },
  { name: 'agree', type: 'boolean', required: false },
  { name: 'color', type: 'enum', required: false, options: [{ value: 'r', label: '红' }] },
  { name: 'at', type: 'string', format: 'date-time', required: false },
];

test('控件原始值 → content：数字转成 number，复选框照实给 true/false，没填的可选项不出现', () => {
  assert.deepEqual(
    elicitationContentFromInputs(fields, { name: '周报', note: '', age: '30', ratio: '0.5', agree: false, color: '', at: '' }),
    { name: '周报', age: 30, ratio: 0.5, agree: false },
  );
});

test('数字框里填了解析不了的东西：原样交上去让服务端说清楚哪里不对，不悄悄丢掉', () => {
  assert.deepEqual(elicitationContentFromInputs([fields[2]], { age: '3x' }), { age: '3x' });
});

test('date-time：datetime-local 的本地时刻转成带时区的 ISO（服务端要 Z / 偏移）', () => {
  const out = elicitationContentFromInputs([fields[6]], { at: '2026-10-29T08:30' });
  assert.equal(out.at, new Date('2026-10-29T08:30').toISOString());
});

test('date-time 默认值 → datetime-local 控件值：不带时区后缀，交回去还是同一时刻（与本机时区无关）', () => {
  // 控件不收 Z / 偏移：带着赋值会被清空，没动过的表单就丢了默认值
  for (const iso of ['2026-10-29T08:30:00Z', '2026-10-29T08:30:00+08:00', '2026-10-29T08:30:15Z', '2026-10-29T08:30:15.250Z']) {
    const local = dateTimeLocalValue(iso);
    assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?$/, iso);
    assert.equal(elicitationContentFromInputs([fields[6]], { at: local }).at, new Date(iso).toISOString(), iso);
  }
  assert.doesNotMatch(dateTimeLocalValue('2026-10-29T08:30:00Z'), /:\d{2}:\d{2}/, '秒为零就不带秒：控件默认按分钟显示');
});

test('date-time 默认值解析不了：给空串，不把乱码塞进控件', () => {
  for (const bad of ['not a date', '', null, undefined, 42]) assert.equal(dateTimeLocalValue(bad), '', String(bad));
});

test('标题：permissionDisplay 的 title 优先，其次 displayName，最后服务器名', () => {
  assert.equal(elicitationHeading({ serverName: 's', displayName: 'D', title: 'T' }), 'T');
  assert.equal(elicitationHeading({ serverName: 's', displayName: 'D' }), 'D');
  assert.equal(elicitationHeading({ serverName: 's' }), 's');
});

test('链接指向主机本地（OAuth 回调常见）：手机上打开回调落不到主机，要提示', () => {
  for (const o of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:9000', 'http://app.localhost']) {
    assert.equal(isHostLocalOrigin(o), true, o);
  }
  for (const o of ['https://github.com', 'https://localhost.example.com', '', undefined]) {
    assert.equal(isHostLocalOrigin(o), false, String(o));
  }
});
