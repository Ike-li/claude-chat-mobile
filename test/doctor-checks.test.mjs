import test from 'node:test';
import assert from 'node:assert/strict';
import { statuslineConfigDiagnostic, classifyPermissionRule, summarizeDangerous, classifyAuthToken, computeReadiness } from '../scripts/doctor-checks.js';

test('statuslineConfigDiagnostic treats web statusline as self-contained', () => {
  const result = statuslineConfigDiagnostic();

  assert.equal(result.status, 'ok');
  assert.match(result.detail, /SDK/);
  assert.doesNotMatch(result.detail, /settings\.json/);
  assert.doesNotMatch(result.detail, /E16.*禁用/);
});

// ④ 安全体检核心：危险白名单判定 —— 公网暴露前审查 permissions.allow 里哪些规则过宽。
test.describe('classifyPermissionRule：危险规则判定', () => {
  const sev = r => classifyPermissionRule(r).severity;
  test('无限定 Bash → danger（等于放开 shell）', () => {
    assert.equal(sev('Bash'), 'danger');
    assert.equal(sev('Bash(*)'), 'danger');
    assert.equal(sev('Bash(:*)'), 'danger');
  });
  test('破坏性 / 提权命令 → danger', () => {
    assert.equal(sev('Bash(sudo apt*)'), 'danger');
    assert.equal(sev('Bash(rm -rf /*)'), 'danger');
    assert.equal(sev('Bash(chmod 777*)'), 'danger');
  });
  test('外联 / 外泄命令 → danger', () => {
    assert.equal(sev('Bash(curl*)'), 'danger');
    assert.equal(sev('Bash(wget http*)'), 'danger');
    assert.equal(sev('Bash(ssh*)'), 'danger');
  });
  test('裸写类工具（无路径限定）→ danger', () => {
    assert.equal(sev('Write'), 'danger');
    assert.equal(sev('Edit'), 'danger');
    assert.equal(sev('MultiEdit'), 'danger');
  });
  test('窄限定 → ok', () => {
    assert.equal(sev('Bash(npm run test:*)'), 'ok');
    assert.equal(sev('Write(//repo/**)'), 'ok');
    assert.equal(sev('Read(//repo/src/**)'), 'ok');
  });
  test('宽通配 / 读全盘 / 外部抓取 → warn', () => {
    assert.equal(sev('Read'), 'warn');
    assert.equal(sev('WebFetch'), 'warn');
    assert.equal(sev('Bash(git*)'), 'warn');
  });
  test('未知工具 / mcp 不误报 danger', () => {
    assert.equal(sev('mcp__server__tool'), 'ok');
    assert.notEqual(sev('SomeWeirdTool'), 'danger');
  });
  test('每条带 reason，且空/垃圾输入不抛', () => {
    assert.match(classifyPermissionRule('Bash(*)').reason, /.+/);
    assert.doesNotThrow(() => classifyPermissionRule(''));
    assert.doesNotThrow(() => classifyPermissionRule(null));
  });
});

test.describe('summarizeDangerous', () => {
  test('混合规则 → ruleCount 全量 + dangerous 仅危险条（带 rule/reason）', () => {
    const s = summarizeDangerous(['Bash(*)', 'Read', 'Write(//r/**)', 'Bash(curl*)']);
    assert.equal(s.ruleCount, 4);
    assert.equal(s.dangerous.length, 2);
    assert.ok(s.dangerous.every(d => d.rule && d.reason));
  });
  test('空白名单 → ruleCount 0, dangerous []', () => {
    assert.deepEqual(summarizeDangerous([]), { ruleCount: 0, dangerous: [] });
  });
});

test.describe('classifyAuthToken：绝不回显明文', () => {
  test('undefined → warn(isSet false)', () => {
    assert.deepEqual(classifyAuthToken(undefined), { status: 'warn', isSet: false });
  });
  test('空串 → fail', () => {
    assert.equal(classifyAuthToken('').status, 'fail');
  });
  test('短 token → warn，返回 length 但无明文', () => {
    const r = classifyAuthToken('abc');
    assert.equal(r.status, 'warn');
    assert.equal(r.length, 3);
    assert.equal(JSON.stringify(r).includes('abc'), false);
  });
  test('正常 token → ok，不回显明文', () => {
    const r = classifyAuthToken('x'.repeat(32));
    assert.equal(r.status, 'ok');
    assert.equal(JSON.stringify(r).includes('x'.repeat(32)), false);
  });
});

test.describe('computeReadiness：公网暴露就绪度', () => {
  const chk = (id, status, safe) => ({ id, status, safe });
  test('任一 fail → blocked', () => {
    assert.equal(computeReadiness([chk('CLAUDE_BIN', 'fail')]).level, 'blocked');
  });
  test('危险白名单 + 无 CF + 弱 token → blocked', () => {
    assert.equal(computeReadiness([
      chk('AUTH_TOKEN', 'warn'), chk('CF_ACCESS', 'ok', { enabled: false }),
      chk('WHITELIST', 'warn', { dangerous: [{ rule: 'Bash(*)' }] }),
    ]).level, 'blocked');
  });
  test('危险白名单 + 有 CF Access → caution（有兜底）', () => {
    assert.equal(computeReadiness([
      chk('AUTH_TOKEN', 'ok'), chk('CF_ACCESS', 'ok', { enabled: true }),
      chk('WHITELIST', 'warn', { dangerous: [{ rule: 'Bash(*)' }] }),
    ]).level, 'caution');
  });
  test('全净 → ready', () => {
    assert.equal(computeReadiness([chk('AUTH_TOKEN', 'ok'), chk('WHITELIST', 'ok', { dangerous: [] })]).level, 'ready');
  });
});
