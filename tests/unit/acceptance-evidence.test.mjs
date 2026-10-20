// tests/unit/acceptance-evidence.test.mjs —— 验收的证据规则（tests/acceptance/lib/evidence.mjs）
// 规则：判 pass 而证据只有代码 / 纯函数 / 文档时，最多算 partial。
// 来历：首轮验收里 6 条用例界面上走不通，agent 换成拿纯函数或读代码当证据，照样判了 pass，
// 机主追问后才降成 partial——走不通时换一条更容易的证据路径是 agent 的自然倾向，且不一定主动说。
// 失败方向是「降档」：证据缺失、种类写错拼错，都按弱证据处理，不按强证据放行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EVIDENCE_KINDS, capVerdict } from '../../tests/acceptance/lib/evidence.mjs';

test('pass + 只有弱证据（code / pure-function / doc 及其组合）→ 降为 partial 并说明理由', () => {
  for (const evidence of [['code'], ['pure-function'], ['doc'], ['code', 'pure-function', 'doc']]) {
    const v = capVerdict({ status: 'pass', evidence });
    assert.equal(v.status, 'partial', `证据 ${evidence.join('+')} 不足以判 pass`);
    assert.match(v.reason, /partial/);
    assert.deepEqual(v.evidence, evidence, '降档不改证据本身');
  }
});

test('pass + 至少一种外部可观察证据 → 原样保留', () => {
  for (const kind of EVIDENCE_KINDS.filter(k => !['code', 'pure-function', 'doc'].includes(k))) {
    const input = { status: 'pass', evidence: ['code', kind], note: '保留其它字段' };
    assert.deepEqual(capVerdict(input), input, `${kind} 是外部可观察证据，pass 不该被降档`);
  }
});

test('pass 但没有证据、或证据种类拼错 → 同样降为 partial（不认识的种类不算强证据）', () => {
  assert.equal(capVerdict({ status: 'pass', evidence: [] }).status, 'partial');
  assert.equal(capVerdict({ status: 'pass' }).status, 'partial');
  const typo = capVerdict({ status: 'pass', evidence: ['code', 'screenshoot'] });
  assert.equal(typo.status, 'partial');
  assert.match(typo.reason, /screenshoot/, '理由里要点名不认识的种类，方便改正拼写');
});

test('非 pass 的结论原样返回，弱证据不会把 fail 改成别的', () => {
  for (const status of ['fail', 'partial', 'blocked', 'not-run']) {
    const input = { status, evidence: ['code'] };
    assert.deepEqual(capVerdict(input), input);
  }
});
