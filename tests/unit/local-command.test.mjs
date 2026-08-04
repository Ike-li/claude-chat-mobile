// tests/unit/local-command.test.mjs —— 本地 slash 命令输出解析口径。
//
// 这个模块存在的全部理由是「live 与刷新后形态一致」，所以它的测试重心不是某一档的输出长什么样，
// 而是【同一段 content 在两个消费方得出同一结论】。2026-08-04 code review 实测到的反例：
// stdout 段后接 stderr 段时，锚定 + 反向引用的单段正则整体不匹配 —— history 侧返回 null 整条丢弃，
// live 侧把四个标签当正文原样上屏且 isError 误判为 false。同一条消息，刷新前后两个样。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalCommandOutput } from '../../src/shared/local-command.js';

const STDOUT = '<local-command-stdout>OUT</local-command-stdout>';
const STDERR = '<local-command-stderr>ERR</local-command-stderr>';

test('单段 stdout / stderr：正文剥包装，stderr 标失败', () => {
  const o = parseLocalCommandOutput(STDOUT);
  assert.deepEqual({ text: o.text, isError: o.isError, wrapped: o.wrapped }, { text: 'OUT', isError: false, wrapped: true });
  const e = parseLocalCommandOutput(STDERR);
  assert.deepEqual({ text: e.text, isError: e.isError, wrapped: e.wrapped }, { text: 'ERR', isError: true, wrapped: true });
});

// ★ 本次 review 抓到的分叉：两段包装拼在一个 content 里。
test('stdout+stderr 并存：识别为完整包装，正文拼接，任一段 stderr 即算失败', () => {
  const out = parseLocalCommandOutput(STDOUT + STDERR);
  assert.ok(out, '包装完整的多段形态不该被判成非包装');
  assert.equal(out.wrapped, true);
  assert.match(out.text, /OUT/);
  assert.match(out.text, /ERR/);
  assert.ok(!/<local-command-/.test(out.text), '包装标签不该留在正文里');
  assert.equal(out.isError, true, '任一段是 stderr 即算失败');
});

test('半截 / 混杂形态不算完整包装（wrapped=false，由调用方决定丢还是原样显示）', () => {
  // 开闭标签不同类
  const half = parseLocalCommandOutput('<local-command-stdout>x</local-command-stderr>');
  assert.equal(half.wrapped, false);
  // 包装段之外还有游离文本
  const mixed = parseLocalCommandOutput(STDOUT + '尾巴');
  assert.equal(mixed.wrapped, false);
  const lead = parseLocalCommandOutput('前言' + STDOUT);
  assert.equal(lead.wrapped, false);
});

// wrapped 字段取代了旧的 requireWrapper 布尔参数：解析器只有一种行为，
// 「严格档丢弃 / 宽松档原样显示」这个【策略】回到各自的调用点，成为可见可评审的一行。
test('裸文本：解析出正文但标记 wrapped=false', () => {
  const o = parseLocalCommandOutput('裸正文');
  assert.deepEqual({ text: o.text, isError: o.isError, wrapped: o.wrapped }, { text: '裸正文', isError: false, wrapped: false });
});

test('命令名回显 / 空正文 → null（不产空气泡）', () => {
  assert.equal(parseLocalCommandOutput('<command-name>/status</command-name>'), null);
  assert.equal(parseLocalCommandOutput('<command-message>x</command-message>'), null);
  assert.equal(parseLocalCommandOutput(''), null);
  assert.equal(parseLocalCommandOutput('   '), null);
  assert.equal(parseLocalCommandOutput('<local-command-stdout>   </local-command-stdout>'), null, '包装内为空 → 无正文可显示');
  assert.equal(parseLocalCommandOutput(null), null);
  assert.equal(parseLocalCommandOutput(42), null);
});
