// tests/unit/logic-status-icon.test.mjs —— 状态图标（工具卡 / 抽屉角标）的 kind → { path, tone } 单表。
// 覆盖 statusIconSpec：图标与语义色必须由同一次查表产出。这两维分过一次家——2026-09-09 发现
// 历史回放路径只换图标不换色，模板里表示「进行中」的 text-warning 原样留着，于是同一张成功卡
// 实时看是绿 ✓、刷新后变成棕色的 ✓。同域拆分惯例：新行为域另起文件，不塞进 logic-session-panel。
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_ICONS, statusIconSpec } from '../../app/public/js/logic.js';

test('statusIconSpec: 每个 kind 都同时给出图标与语义色', () => {
  const kinds = Object.keys(STATUS_ICONS);
  assert.ok(kinds.length > 0, '状态图标表为空——所有调用点都会回落，等于没有状态标');
  for (const kind of kinds) {
    const spec = statusIconSpec(kind);
    assert.match(spec.html, /<svg/, `${kind} 没有图标：状态标渲染成空白`);
    assert.match(spec.tone, /^text-/,
      `${kind} 没有语义色：调用点会留着上一个状态的颜色——成功的 ✓ 画成进行中的棕色就是这么来的`);
  }
});

test('statusIconSpec: 色与语义一致——成功绿、出错与拒绝红、进行中警示色', () => {
  assert.equal(statusIconSpec('ok').tone, 'text-success');
  assert.equal(statusIconSpec('error').tone, 'text-danger');
  assert.equal(statusIconSpec('denied').tone, 'text-danger');
  assert.equal(statusIconSpec('pending').tone, 'text-warning');
  // answered = 审批「已回答」，既非报错也非工具成功：不占用红/绿的注意力预算（同 app.js 的 deny 通道注释）
  assert.equal(statusIconSpec('answered').tone, 'text-ink-soft');
});

test('statusIconSpec: 未知 kind 整份回落 pending，不只回落图标', () => {
  const fallback = statusIconSpec('no-such-kind');
  const pending = statusIconSpec('pending');
  assert.equal(fallback.kind, 'pending');
  assert.equal(fallback.html, pending.html);
  assert.equal(fallback.tone, pending.tone, '只回落图标不回落色 = 未知状态穿着上一个状态的颜色');
});
