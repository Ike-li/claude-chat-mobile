// tests/unit/cli-settings-defaults.test.mjs —— FRESH/空首页配置权威源纯函数（零 token）。
// 契约：新会话 L0 pending > L3 CLI settings > L4 硬默认；resume 的 mode/model 不走本模块，
// effort 例外（resolveResumeEffort：saved > inherited > L3，见该函数注释）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePermissionMode,
  normalizeEffortLevel,
  defaultsFromEffectiveSettings,
  resolveFreshPrefs,
  resolveResumeEffort,
  buildWorktreeGatewayEnv,
  countNeutralizableGatewayKeys,
  decideWorktreeSettingsAction,
  parseWorktreeCanonicalRoot,
  CCM_PERMISSION_MODES,
} from '../../app/src/agent/cli-settings-defaults.js';

test.describe('normalizePermissionMode', () => {
  test('合法 CCM 档原样通过', () => {
    for (const m of CCM_PERMISSION_MODES) {
      assert.equal(normalizePermissionMode(m), m);
    }
  });
  test("SDK 别名 'manual' → 'default'", () => {
    assert.equal(normalizePermissionMode('manual'), 'default');
  });
  test("'auto' 是合法档（与 CLI / SDK 对齐）", () => {
    assert.equal(normalizePermissionMode('auto'), 'auto');
  });
  test("垃圾 / 空 → null（回落 L4）", () => {
    assert.equal(normalizePermissionMode('nope'), null);
    assert.equal(normalizePermissionMode(''), null);
    assert.equal(normalizePermissionMode(null), null);
    assert.equal(normalizePermissionMode(undefined), null);
  });
});

test.describe('normalizeEffortLevel', () => {
  test('合法档原样；空 → null（模型默认）', () => {
    assert.equal(normalizeEffortLevel('low'), 'low');
    assert.equal(normalizeEffortLevel('xhigh'), 'xhigh');
    assert.equal(normalizeEffortLevel('max'), 'max');
    assert.equal(normalizeEffortLevel(null), null);
    assert.equal(normalizeEffortLevel(undefined), null);
    assert.equal(normalizeEffortLevel(''), null);
  });
  test('非法 → null', () => {
    assert.equal(normalizeEffortLevel('ultracode'), null);
    assert.equal(normalizeEffortLevel(3), null);
  });
});

test.describe('defaultsFromEffectiveSettings（L3 抽取）', () => {
  test('本机常见形状：defaultMode + effortLevel=low', () => {
    assert.deepEqual(
      defaultsFromEffectiveSettings({
        permissions: { defaultMode: 'default' },
        effortLevel: 'low',
      }),
      { mode: 'default', effort: 'low', model: undefined, env: undefined },
    );
  });
  test('缺字段 → L4 形状（mode=default, effort=null）', () => {
    assert.deepEqual(defaultsFromEffectiveSettings(undefined), {
      mode: 'default', effort: null, model: undefined, env: undefined,
    });
    assert.deepEqual(defaultsFromEffectiveSettings({}), {
      mode: 'default', effort: null, model: undefined, env: undefined,
    });
  });
  test('顶层 model 有值才 pin', () => {
    assert.equal(
      defaultsFromEffectiveSettings({ model: 'claude-opus-4-8' }).model,
      'claude-opus-4-8',
    );
    assert.equal(defaultsFromEffectiveSettings({ model: '' }).model, undefined);
  });
  test('auto defaultMode → 透传 auto（CLI 设 auto 时新会话继承）', () => {
    assert.equal(
      defaultsFromEffectiveSettings({ permissions: { defaultMode: 'auto' } }).mode,
      'auto',
    );
  });
  test('env 块有值时缓存（浅拷贝）', () => {
    const envIn = { ANTHROPIC_BASE_URL: 'https://gateway.example.com', ANTHROPIC_MODEL: 'opus' };
    const d = defaultsFromEffectiveSettings({ env: envIn });
    assert.deepEqual(d.env, envIn);
    assert.notEqual(d.env, envIn, '应浅拷贝，不直接引用原对象');
  });
  test('env 块缺失/非对象 → undefined', () => {
    assert.equal(defaultsFromEffectiveSettings({}).env, undefined);
    assert.equal(defaultsFromEffectiveSettings({ env: null }).env, undefined);
    assert.equal(defaultsFromEffectiveSettings({ env: 'string' }).env, undefined);
    assert.equal(defaultsFromEffectiveSettings({ env: [1, 2] }).env, undefined);
  });
});

test.describe('resolveFreshPrefs（L0 > L3 > L4）', () => {
  const cliLow = { mode: 'acceptEdits', effort: 'low', model: undefined };

  test('无 pending、无 cli → L4 硬默认', () => {
    assert.deepEqual(resolveFreshPrefs({}), {
      mode: 'default', effort: null, ultracode: false, model: undefined,
    });
  });

  test('无 pending、有 cli → 用 L3', () => {
    assert.deepEqual(resolveFreshPrefs({ cliDefaults: cliLow }), {
      mode: 'acceptEdits', effort: 'low', ultracode: false, model: undefined,
    });
  });

  test('pending mode 覆盖 L3', () => {
    assert.deepEqual(
      resolveFreshPrefs({
        hasPendingMode: true,
        pendingMode: 'plan',
        cliDefaults: cliLow,
      }),
      { mode: 'plan', effort: 'low', ultracode: false, model: undefined },
    );
  });

  test('pending effort=null 合法覆盖 L3 的 low（用户显式选「模型默认」）', () => {
    assert.deepEqual(
      resolveFreshPrefs({
        hasPendingEffort: true,
        pendingEffort: null,
        cliDefaults: cliLow,
      }),
      { mode: 'acceptEdits', effort: null, ultracode: false, model: undefined },
    );
  });

  test('pending 非法 mode → 回落 default，不沿用脏值', () => {
    assert.equal(
      resolveFreshPrefs({
        hasPendingMode: true,
        pendingMode: 'garbage',
        cliDefaults: cliLow,
      }).mode,
      'default',
    );
  });

  test('cliDefaults.effort 缺省键 → null，不把 undefined 当有值', () => {
    assert.deepEqual(
      resolveFreshPrefs({ cliDefaults: { mode: 'default' } }),
      { mode: 'default', effort: null, ultracode: false, model: undefined },
    );
  });

  test('pending ultracode → sdk xhigh + ultracode flag（H1，不得被 normalizeEffortLevel 剥掉）', () => {
    assert.deepEqual(
      resolveFreshPrefs({
        hasPendingEffort: true,
        pendingEffort: 'ultracode',
        cliDefaults: cliLow,
      }),
      { mode: 'acceptEdits', effort: 'xhigh', ultracode: true, model: undefined },
    );
  });

    test('cli model 透传（仅当字符串非空）', () => {
    assert.equal(
      resolveFreshPrefs({ cliDefaults: { mode: 'default', effort: null, model: 'sonnet' } }).model,
      'sonnet',
    );
  });
});

test.describe('resolveResumeEffort（resume 专用：saved > inherited > L3，全部按归一后 ?? 语义折叠）', () => {
  const cliHigh = { mode: 'default', effort: 'high', model: undefined };

  test('saved 有非空值 → 直接采用，不看后两层', () => {
    assert.equal(
      resolveResumeEffort({ savedEffort: 'low', inheritedEffortValue: 'max', cliDefaults: cliHigh }),
      'low',
    );
  });

  test('saved 缺失（undefined，从未在 web 端记录过）→ 落到 inherited', () => {
    assert.equal(
      resolveResumeEffort({ savedEffort: undefined, inheritedEffortValue: 'max', cliDefaults: cliHigh }),
      'max',
    );
  });

  test('saved 显式 null（陷阱：可能是用户选过模型默认，也可能只是上次冷启动兜底写入）→ 仍继续往下兜底，不当终值', () => {
    assert.equal(
      resolveResumeEffort({ savedEffort: null, inheritedEffortValue: 'max', cliDefaults: cliHigh }),
      'max',
    );
  });

  test('saved / inherited 都空 → 落到 L3 CLI settings（本次修复的核心场景：从未碰过 web 的旧会话）', () => {
    assert.equal(
      resolveResumeEffort({ savedEffort: null, inheritedEffortValue: null, cliDefaults: cliHigh }),
      'high',
    );
    assert.equal(
      resolveResumeEffort({ savedEffort: undefined, inheritedEffortValue: undefined, cliDefaults: cliHigh }),
      'high',
    );
  });

  test('inherited 显式 null（该 cwd 末活实例本身也是模型默认）→ 同样继续往下兜底到 L3', () => {
    assert.equal(
      resolveResumeEffort({ savedEffort: undefined, inheritedEffortValue: null, cliDefaults: cliHigh }),
      'high',
    );
  });

  test('三层全空、L3 也未配置 effortLevel → 落回 null（诚实边界，非 bug）', () => {
    assert.equal(resolveResumeEffort({}), null);
    assert.equal(
      resolveResumeEffort({ savedEffort: null, inheritedEffortValue: null, cliDefaults: null }),
      null,
    );
  });

  test('cliDefaults.effort 缺省键 → 视为 null，不把 undefined 当有值', () => {
    assert.equal(resolveResumeEffort({ cliDefaults: { mode: 'default' } }), null);
  });

  test('非法档一律归一为 null 再继续兜底', () => {
    assert.equal(
      resolveResumeEffort({ savedEffort: 'garbage', inheritedEffortValue: null, cliDefaults: cliHigh }),
      'high',
    );
  });
});

// ── worktree 网关隔离（2026-07-30 实证复现） ─────────────────────────────────────
// CLI 2.1.211+ 在 linked worktree 里把 local settings source 解析到 canonical repo root，
// 于是主 checkout 的 .claude/settings.local.json 的 env 块污染所有 worktree 会话
// （真实症状：third-party 的会话打到主 checkout 配的 amux 网关 → 503 No available channel）。
// 实证结论决定本函数的两条设计：
//   · 该污染压不过——子进程 env 注入无效（CLI 的 settings.env 优先级更高），只能走 flag settings；
//   · 空 env 块擦不掉——必须对「canonical 有而 worktree 没有」的键显式写空串中和。
test.describe('buildWorktreeGatewayEnv（worktree 网关隔离）', () => {
  test('worktree 无 env、canonical 配了网关 → 逐键显式空串中和', () => {
    const out = buildWorktreeGatewayEnv(undefined, {
      ANTHROPIC_BASE_URL: 'https://api.amux.ai',
      ANTHROPIC_AUTH_TOKEN: 'sk-xxx',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'grok-4.5',
    });
    assert.deepEqual(out, {
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_OPUS_MODEL: '',
    });
  });

  test('worktree 有自己的网关 → 原样生效；canonical 独有的键仍被中和', () => {
    const out = buildWorktreeGatewayEnv(
      { ANTHROPIC_BASE_URL: 'https://own.example.com' },
      { ANTHROPIC_BASE_URL: 'https://api.amux.ai', ANTHROPIC_DEFAULT_OPUS_MODEL: 'grok-4.5' },
    );
    assert.equal(out.ANTHROPIC_BASE_URL, 'https://own.example.com');
    assert.equal(out.ANTHROPIC_DEFAULT_OPUS_MODEL, '', 'canonical 独有的模型映射必须中和，否则别名仍被改写');
  });

  test('canonical 无 env 且 worktree 无 env → undefined（无需干预，保持现状不传 settings）', () => {
    assert.equal(buildWorktreeGatewayEnv(undefined, undefined), undefined);
    assert.equal(buildWorktreeGatewayEnv({}, {}), undefined);
  });

  test('canonical 无 env、worktree 有 env → 原样下发（worktree 自己的映射要生效）', () => {
    const out = buildWorktreeGatewayEnv({ ANTHROPIC_BASE_URL: 'https://own.example.com' }, undefined);
    assert.deepEqual(out, { ANTHROPIC_BASE_URL: 'https://own.example.com' });
  });

  test('非白名单 key 一律不进结果（不中和 PORT/AUTH_TOKEN，安全边界同 filterSafeResolvedEnv）', () => {
    const out = buildWorktreeGatewayEnv(
      { PORT: '9999' },
      { PORT: '3000', AUTH_TOKEN: 'real', CCM_DATA_DIR: '/real', ANTHROPIC_BASE_URL: 'https://api.amux.ai' },
    );
    assert.equal('PORT' in out, false, 'PORT 不该被中和——那会打断服务端/子进程的正常变量');
    assert.equal('AUTH_TOKEN' in out, false);
    assert.equal('CCM_DATA_DIR' in out, false);
    assert.equal(out.ANTHROPIC_BASE_URL, '');
  });

  test('小写同名 key 不认（与白名单大小写敏感一致）', () => {
    const out = buildWorktreeGatewayEnv(undefined, { anthropic_base_url: 'https://evil.example.com' });
    assert.equal(out, undefined);
  });

  test('__proto__ 不污染原型', () => {
    const canonical = JSON.parse('{"__proto__": {"polluted": "yes"}, "ANTHROPIC_BASE_URL": "https://api.amux.ai"}');
    const out = buildWorktreeGatewayEnv(undefined, canonical);
    assert.equal({}.polluted, undefined);
    assert.equal(out.ANTHROPIC_BASE_URL, '');
  });
});

// linked worktree 的 .git 是文本文件（`gitdir: <主仓库>/.git/worktrees/<名>`），据此定位 canonical
// repo root——就是 CLI 会误读 settings.local.json 的那个目录。主 checkout 的 .git 是目录，不走这里。
test.describe('parseWorktreeCanonicalRoot（从 .git 指针定位 canonical repo root）', () => {
  test('标准 worktree 指针 → 主 checkout 路径', () => {
    assert.equal(
      parseWorktreeCanonicalRoot('gitdir: /Users/you/code/proj/.git/worktrees/feat\n'),
      '/Users/you/code/proj',
    );
  });

  test('容忍多余空白与无结尾换行', () => {
    assert.equal(
      parseWorktreeCanonicalRoot('gitdir:   /Users/you/code/proj/.git/worktrees/feat  '),
      '/Users/you/code/proj',
    );
  });

  test('submodule 指针（.git/modules/…）不是 worktree → null', () => {
    assert.equal(parseWorktreeCanonicalRoot('gitdir: /Users/you/code/proj/.git/modules/sub'), null);
  });

  test('空/非字符串/无 gitdir 前缀 → null（不抛）', () => {
    assert.equal(parseWorktreeCanonicalRoot(''), null);
    assert.equal(parseWorktreeCanonicalRoot(null), null);
    assert.equal(parseWorktreeCanonicalRoot(undefined), null);
    assert.equal(parseWorktreeCanonicalRoot('ref: refs/heads/main'), null);
  });
});

// 白名单收窄（review #5/#6）：前缀通配会连带中和纯偏好类键，令 worktree 会话丢失主 checkout 里
// 与网关无关的 CLI 偏好。取舍：漏掉一个网关变量 = 污染照旧 + 503 复现，多清一个偏好只是小损失，
// 两种错误代价不对称——故保留前缀（新网关变量自动覆盖），只显式排除已实证见过的非路由键。
test.describe('buildWorktreeGatewayEnv — 非路由类偏好不中和', () => {
  test('CLAUDE_CODE_ATTRIBUTION_HEADER / DISABLE_NONESSENTIAL_TRAFFIC / EFFORT_LEVEL 保留给 worktree 会话', () => {
    const out = buildWorktreeGatewayEnv(undefined, {
      ANTHROPIC_BASE_URL: 'https://api.amux.ai',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    });
    assert.equal(out.ANTHROPIC_BASE_URL, '', '网关键仍须中和');
    assert.equal('CLAUDE_CODE_ATTRIBUTION_HEADER' in out, false);
    assert.equal('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' in out, false);
    assert.equal('CLAUDE_CODE_EFFORT_LEVEL' in out, false);
  });

  test('未知的 ANTHROPIC_/CLAUDE_CODE_ 键仍按网关处理（宁可多中和，不可漏网关）', () => {
    const out = buildWorktreeGatewayEnv(undefined, {
      ANTHROPIC_SOME_FUTURE_GATEWAY_VAR: 'x',
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
    assert.equal(out.ANTHROPIC_SOME_FUTURE_GATEWAY_VAR, '');
    assert.equal(out.CLAUDE_CODE_USE_BEDROCK, '');
  });

  test('worktree 自己显式配了非路由键 → 照常下发（排除清单只挡「中和」，不挡 worktree 自己的意图）', () => {
    const out = buildWorktreeGatewayEnv(
      { CLAUDE_CODE_ATTRIBUTION_HEADER: '1' },
      { ANTHROPIC_BASE_URL: 'https://api.amux.ai' },
    );
    assert.equal(out.CLAUDE_CODE_ATTRIBUTION_HEADER, '1');
    assert.equal(out.ANTHROPIC_BASE_URL, '');
  });
});

// 日志判据（2026-08-01）：buildWorktreeGatewayEnv 返回 undefined 曾被当成「本该隔离却没隔离」而 warn，
// 但那个分支恰恰只在「两边都没有网关键」时到达——报的是正常状态，每开一次会话刷一次噪音。
// 本函数把「canonical 是否真有污染源」单独提出来，让调用方只对真故障报警。
test.describe('countNeutralizableGatewayKeys（污染源计数：只数会污染 worktree 的键）', () => {
  test('无 env / 空 env / 非对象 → 0', () => {
    assert.equal(countNeutralizableGatewayKeys(undefined), 0);
    assert.equal(countNeutralizableGatewayKeys(null), 0);
    assert.equal(countNeutralizableGatewayKeys({}), 0);
    assert.equal(countNeutralizableGatewayKeys('nope'), 0);
    assert.equal(countNeutralizableGatewayKeys(['ANTHROPIC_BASE_URL']), 0);
  });

  test('网关键逐个计数', () => {
    assert.equal(countNeutralizableGatewayKeys({
      ANTHROPIC_BASE_URL: 'https://api.amux.ai',
      ANTHROPIC_AUTH_TOKEN: 'sk-xxx',
    }), 2);
  });

  test('只有非路由偏好键 → 0（canonical 只配了 CLI 偏好同样属于「无需隔离」，不该报警）', () => {
    assert.equal(countNeutralizableGatewayKeys({
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    }), 0);
  });

  test('非白名单键不计（安全边界同 buildWorktreeGatewayEnv：绝不碰服务端变量）', () => {
    assert.equal(countNeutralizableGatewayKeys({
      PORT: '3000', AUTH_TOKEN: 'real', CCM_DATA_DIR: '/real', anthropic_base_url: 'https://evil',
    }), 0);
  });

  test('与 buildWorktreeGatewayEnv 判据一致：计数 > 0 ⟺ 一定产出中和块（等价性一旦被打破，app.js 的哨兵 warn 就会响）', () => {
    const cases = [
      { ANTHROPIC_BASE_URL: 'x' },
      { CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
      { CLAUDE_CODE_ATTRIBUTION_HEADER: '0', ANTHROPIC_DEFAULT_OPUS_MODEL: 'grok-4.5' },
      { PORT: '3000' },
      {},
    ];
    for (const canonical of cases) {
      assert.equal(
        countNeutralizableGatewayKeys(canonical) > 0,
        buildWorktreeGatewayEnv(undefined, canonical) !== undefined,
        `判据漂移：${JSON.stringify(canonical)}`,
      );
    }
  });
});

// 隔离文件的处置决策（2026-08-01 code review 抓出的真 bug 促成）：
// 「判定失败」与「判定为无需隔离」在 resolveWorktreeGatewayEnv 里同为 undefined 返回，
// 而两者动作相反——前者必须什么都不做，后者才该清文件。不区分就会在 canonical settings
// 读取瞬时失败那一次，把一份仍然有效的中和文件删掉，隔离静默失效直到下次 force 刷新，
// 期间 worktree 会话重新被主 checkout 的网关污染（正是 7/30 那个 503）。
test.describe('decideWorktreeSettingsAction（write / prune / skip 三态）', () => {
  test('记录缺失（尚未判定 / ensureCliDefaults 未写缓存）→ skip', () => {
    assert.equal(decideWorktreeSettingsAction(undefined), 'skip');
    assert.equal(decideWorktreeSettingsAction(null), 'skip');
  });

  test('★判定失败（settled=false）→ skip，绝不 prune——这一条正是防误删有效隔离文件', () => {
    assert.equal(decideWorktreeSettingsAction({ gatewayEnvSettled: false }), 'skip');
    assert.equal(
      decideWorktreeSettingsAction({ gatewayEnvSettled: false, gatewayEnv: undefined }),
      'skip',
      'canonical settings 读失败时 gatewayEnv 同样是 undefined，只能靠 settled 区分',
    );
  });

  test('缺 settled 字段的旧形状 → skip（保守：宁可留残留，不可误删）', () => {
    assert.equal(decideWorktreeSettingsAction({ mode: 'default', gatewayEnv: undefined }), 'skip');
  });

  test('已判定 + 有中和块 → write', () => {
    assert.equal(
      decideWorktreeSettingsAction({ gatewayEnvSettled: true, gatewayEnv: { ANTHROPIC_BASE_URL: '' } }),
      'write',
    );
  });

  test('已判定 + 无需隔离 → prune（清掉旧的明文快照）', () => {
    assert.equal(decideWorktreeSettingsAction({ gatewayEnvSettled: true, gatewayEnv: undefined }), 'prune');
  });

  test('空对象按无需隔离处理（buildWorktreeGatewayEnv 不会返回它，但空 env 写进文件毫无意义）', () => {
    assert.equal(decideWorktreeSettingsAction({ gatewayEnvSettled: true, gatewayEnv: {} }), 'prune');
  });
});
