// tests/unit/config-file.test.mjs —— src/ops/config-file.js（统一配置文件 ccm.config.json）
//
// P1a 的验证面。这一层替换的是「.env + dotenv」，而被替换的那套有过两次 fail-open 事故
// （值以 `\` 结尾 / 含单引号时 dotenv 与 shell 解析分叉），所以这里的断言重点不是「能读能写」，
// 而是三条**换格式之后必须仍然成立**的不变量：
//
//   ① 优先级链 shell env > 配置文件 > 内置默认 —— 与 dotenv「不覆盖已存在 key」的语义等价
//   ② ANTHROPIC_* 只认真实 shell export —— 配置文件里写了照样剥除（src/server/config.js:21 的立场）
//   ③ 投影回 process.env 之后，现有那 7 处消费点的字面量判据一字不变地成立
//      （app.js:1229 `=== 'off'`、config.js:65 `=== '1'`、log-terminal.js:33 `!== 'on'` …）
//
// ③ 是 P1a「零破坏」的全部依据：类型化只发生在配置层内部，消费点一行不改。
import test from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyConfigChanges,
  CONFIG_SCHEMA_VERSION,
  coerceToSchemaType,
  createConfigReloader,
  diffReloadKinds,
  loadConfigSources,
  migrateEnvValues,
  projectToEnv,
  readConfigFileValues,
  reloadKindOf,
  resolveConfigValues,
  structuredToStringValues,
} from '../../src/ops/config-file.js';

// safe-rm: mkdtemp 一次性目录，路径由 mkdtempSync 返回值直接传入，不经任何拼接
const withTempDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-config-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test.describe('coerceToSchemaType —— 手写文件要容错，但类型必须归一', () => {
  test('number：字符串数字被收编，非数字保持原样交给校验层报错', () => {
    assert.equal(coerceToSchemaType('PORT', '3000').value, 3000);
    assert.equal(coerceToSchemaType('PORT', 3000).value, 3000);
    assert.equal(coerceToSchemaType('PORT', 'abc').value, 'abc'); // 不猜，交给 validate
  });

  test('number 被 coerce 时要报 warning —— 静默改写用户写的东西是另一种分叉', () => {
    assert.ok(coerceToSchemaType('PORT', '3000').warning);
    assert.equal(coerceToSchemaType('PORT', 3000).warning, null);
  });

  // ★ 这一组是整个类型化最容易写反的地方，也是换格式最大的收益点。
  //
  // .env 时代有三套真值字面量（env-schema.js:26-28 的 TOGGLE_ONE/OFF/ON），根因是 .env 只能存
  // 字符串。方向由「哪一侧是空串」决定，而不是由字面量本身：
  //   TOGGLE_ONE {on:'1', off:''}   → 默认关，只有 '1' 才是开
  //   TOGGLE_OFF {on:'', off:'off'} → 默认开，只有 'off' 才是关
  // 写反的后果有先例：log-terminal.js:32 记着 `LOG_STDERR=false` 反而是「开」（truthy 判定下
  // 'false' 是非空字符串）。JSON 里 true 就是 true，但**从 shell env 读进来时仍然是字符串**，
  // 所以这条转换规则一天都省不掉。
  test('toggle：默认关的项（TOGGLE_ONE）只认 on 字面量', () => {
    assert.equal(coerceToSchemaType('DEV_MODE', '1').value, true);
    assert.equal(coerceToSchemaType('DEV_MODE', '').value, false);
    assert.equal(coerceToSchemaType('DEV_MODE', 'true').value, false); // 不是 '1' 就是关
    assert.equal(coerceToSchemaType('DEV_MODE', 'false').value, false);
  });

  test('toggle：默认开的项（TOGGLE_OFF）只认 off 字面量', () => {
    assert.equal(coerceToSchemaType('WEB_STATUSLINE', 'off').value, false);
    assert.equal(coerceToSchemaType('WEB_STATUSLINE', '').value, true);
    assert.equal(coerceToSchemaType('WEB_STATUSLINE', 'anything').value, true);
  });

  test('toggle：LOG_TERMINAL 用第三套字面量（on/空），方向仍由空串侧决定', () => {
    assert.equal(coerceToSchemaType('LOG_TERMINAL', 'on').value, true);
    assert.equal(coerceToSchemaType('LOG_TERMINAL', '').value, false);
  });

  test('toggle：JSON 原生 boolean 直通，零 warning', () => {
    assert.equal(coerceToSchemaType('WEB_STATUSLINE', false).value, false);
    assert.equal(coerceToSchemaType('WEB_STATUSLINE', false).warning, null);
  });
});

// ── P1b：list 类型（WORKDIRS）────────────────────────────────────────────────
//
// 这是第一个**投影不回去**的 kind：数组塞不进 process.env 的字符串。P1a 那层兼容投影对它
// 不适用，消费方必须直接读结构化配置 —— 所以这里的断言重点是「投影必须明确放弃」，
// 而不是悄悄投成 "[object Object]" 或 JSON 串让下游解析出一个假白名单。
test.describe('list 类型 —— 工作区列表', () => {
  test('数组原样保留，字符串与对象条目混用都接受', () => {
    const entries = ['/a', { path: '/b', sessionLimit: 3 }];
    const { value, warning } = coerceToSchemaType('WORKDIRS', entries);
    assert.deepEqual(value, entries);
    assert.equal(warning, null);
  });

  test('非数组不猜，原样交给校验层报错', () => {
    assert.equal(coerceToSchemaType('WORKDIRS', '/a,/b').value, '/a,/b');
  });

  // ★ 投影必须返回 null（= 不设这个 env key）。
  // 若投成字符串，app.js:191 的 `(process.env.WORK_DIRS || '').split(',')` 会把
  // "[object Object]" 当成一个目录名塞进白名单 —— 一个不存在的路径进白名单是安全边界问题，
  // 而且 realpath 校验失败只会 warn-skip，用户看不到任何异常。
  test('投影明确放弃：数组不投进 process.env', () => {
    assert.equal(projectToEnv('WORKDIRS', ['/a', '/b']), null);
  });

  test('structuredToStringValues 跳过 list，不污染字符串态视图', () => {
    const out = structuredToStringValues({ WORKDIRS: ['/a'], PORT: 3000 });
    assert.equal(Object.hasOwn(out, 'WORKDIRS'), false);
    assert.equal(out.PORT, '3000');
  });

  test('写入侧原样落盘', () => {
    const next = applyConfigChanges({}, { WORKDIRS: ['/a', { path: '/b', sessionLimit: 2 }] });
    assert.deepEqual(next.WORKDIRS, ['/a', { path: '/b', sessionLimit: 2 }]);
  });

  test('空数组是合法值（= 只有 WORK_DIR 一个工作区），不当成删除', () => {
    const next = applyConfigChanges({ WORKDIRS: ['/a'] }, { WORKDIRS: [] });
    assert.deepEqual(next.WORKDIRS, []);
  });
});

test.describe('reload 标记 —— 热加载 vs 需重启', () => {
  test('WORKDIRS 是 hot，PORT 是 restart', () => {
    assert.equal(reloadKindOf('WORKDIRS'), 'hot');
    assert.equal(reloadKindOf('PORT'), 'restart');
  });

  test('未标记的项缺省需重启 —— 保守方向：误报重启只是多一次操作，漏报是配置没生效', () => {
    assert.equal(reloadKindOf('AUTH_TOKEN'), 'restart');
    assert.equal(reloadKindOf('不存在的KEY'), 'restart');
  });

  test('diffReloadKinds 把一批变更分成两类', () => {
    const r = diffReloadKinds({ WORKDIRS: ['/a'], PORT: 3000 }, { WORKDIRS: ['/a', '/b'], PORT: 4000 });
    assert.deepEqual(r.hot, ['WORKDIRS']);
    assert.deepEqual(r.restart, ['PORT']);
  });

  test('值没变的 key 不算变更（深比较，数组换个新引用不算改）', () => {
    const r = diffReloadKinds({ WORKDIRS: ['/a'], PORT: 3000 }, { WORKDIRS: ['/a'], PORT: 3000 });
    assert.deepEqual(r.hot, []);
    assert.deepEqual(r.restart, []);
  });

  test('新增与删除都算变更', () => {
    assert.deepEqual(diffReloadKinds({}, { PORT: 3000 }).restart, ['PORT']);
    assert.deepEqual(diffReloadKinds({ PORT: 3000 }, {}).restart, ['PORT']);
  });
});

// ★ 热加载的 glue 层单独可测。
//
// 教训来源：service-sampler.js:10 记着上一次同类改造的复盘 —— 判定层测得不错，出问题的**全是
// glue**（快照只在内存、写盘前没 mkdir、推进顺序反了），因为它当时整个住在 app.js 里、进不去单测。
// 所以这里照 createServiceManager 的范式：IO 全部注入，宿主机零成本可测。
test.describe('createConfigReloader —— 文件变更的分类处理', () => {
  const makeReloader = (reads) => {
    const hot = [];
    const restart = [];
    let i = 0;
    const r = createConfigReloader({
      readConfig: () => reads[Math.min(i++, reads.length - 1)],
      onHot: (keys) => hot.push(keys),
      onRestart: (keys) => restart.push(keys),
    });
    return { r, hot, restart };
  };

  test('hot 项变化 → 触发热加载，不提示重启', () => {
    const { r, hot, restart } = makeReloader([{ WORKDIRS: ['/a'] }, { WORKDIRS: ['/a', '/b'] }]);
    r.prime();
    r.handleChange();
    assert.deepEqual(hot, [['WORKDIRS']]);
    assert.deepEqual(restart, []);
  });

  test('restart 项变化 → 只提示，不热加载（热应用一个需重启的项是假生效）', () => {
    const { r, hot, restart } = makeReloader([{ PORT: 3000 }, { PORT: 4000 }]);
    r.prime();
    r.handleChange();
    assert.deepEqual(hot, []);
    assert.deepEqual(restart, [['PORT']]);
  });

  test('两类同时变 → 各走各的', () => {
    const { r, hot, restart } = makeReloader([
      { WORKDIRS: ['/a'], PORT: 3000 },
      { WORKDIRS: ['/b'], PORT: 4000 },
    ]);
    r.prime();
    r.handleChange();
    assert.deepEqual(hot, [['WORKDIRS']]);
    assert.deepEqual(restart, [['PORT']]);
  });

  // ★ 没变化就什么都不做。fs.watch 在 macOS 上一次保存能连发数个事件，而 reloadWorkdirs
  // 末尾会 broadcastInstances() → 前端目录面板全量重建。不做这条守卫就是每次保存闪好几下。
  test('内容没变 → 零回调', () => {
    const { r, hot, restart } = makeReloader([{ WORKDIRS: ['/a'] }]);
    r.prime();
    r.handleChange();
    r.handleChange();
    assert.deepEqual(hot, []);
    assert.deepEqual(restart, []);
  });

  // 读失败保留旧快照：与 reloadWorkdirs 的「读取失败保留旧白名单」同一立场。
  // 若把 null 当成空配置，一次编辑器写到一半的读取就会把整个白名单判成「全部删除」。
  test('读失败 → 保留旧快照，且不误判成全部删除', () => {
    const { r, hot, restart } = makeReloader([{ WORKDIRS: ['/a'] }, null, { WORKDIRS: ['/a'] }]);
    r.prime();
    r.handleChange(); // null
    r.handleChange(); // 恢复成与 prime 时相同的内容
    assert.deepEqual(hot, []);
    assert.deepEqual(restart, []);
  });

  test('prime 之前就来变更事件也不炸（watch 早于首次读取的竞态）', () => {
    const { r, hot } = makeReloader([{ WORKDIRS: ['/a'] }]);
    assert.doesNotThrow(() => r.handleChange());
    assert.deepEqual(hot, [['WORKDIRS']]); // 空快照 → 视为新增
  });
});

// ★ 这一组锁的是「零破坏」本身：投影结果必须让现有消费点的字面量判据原样成立。
// 每条断言后面括号里是真实消费点，改坏了那里就会静默失效（而不是报错）。
test.describe('projectToEnv —— 结构化值投影回 process.env 字符串', () => {
  test('默认开的项：false 投成 off、true 投成删除 key', () => {
    // app.js:1229 `process.env.WEB_STATUSLINE === 'off'`
    assert.equal(projectToEnv('WEB_STATUSLINE', false), 'off');
    // 判据是 `=== 'off'`，所以「开」只要不是 'off' 即可；投成 null（删 key）最干净，
    // 也与 normalizeLoadedEnvironment 删空串的既有行为一致。
    assert.equal(projectToEnv('WEB_STATUSLINE', true), null);
  });

  test('默认关的项：true 投成 on 字面量、false 投成删除 key', () => {
    assert.equal(projectToEnv('DEV_MODE', true), '1');    // config.js:65 `=== '1'`
    assert.equal(projectToEnv('DEV_MODE', false), null);
    assert.equal(projectToEnv('LOG_TERMINAL', true), 'on'); // log-terminal.js:33 `!== 'on'`
    assert.equal(projectToEnv('LOG_TERMINAL', false), null);
  });

  test('number 投成十进制字符串', () => {
    assert.equal(projectToEnv('PORT', 3000), '3000');
  });

  test('空字符串投成 null —— 空串 ≡ 未设置（config.js:31-33 的 SH-001）', () => {
    assert.equal(projectToEnv('WORK_DIR', ''), null);
    assert.equal(projectToEnv('WORK_DIR', '/tmp/x'), '/tmp/x');
  });

  // 往返一致性：coerce(project(v)) === v。写反其中一边就会在这里断。
  test('round-trip：投影出去再读回来，值不变', () => {
    for (const [key, value] of [
      ['WEB_STATUSLINE', false], ['WEB_STATUSLINE', true],
      ['DEV_MODE', true], ['DEV_MODE', false],
      ['LOG_TERMINAL', true], ['LOG_TERMINAL', false],
      ['PORT', 3000],
    ]) {
      const projected = projectToEnv(key, value);
      // null 表示「不设这个 key」，读回来时对应空串
      const back = coerceToSchemaType(key, projected === null ? '' : projected).value;
      assert.equal(back, value, `${key}=${JSON.stringify(value)} 往返不一致`);
    }
  });
});

test.describe('resolveConfigValues —— 优先级链', () => {
  test('shell env 覆盖配置文件', () => {
    const { values } = resolveConfigValues({
      fileValues: { PORT: 3000, WEB_STATUSLINE: true },
      shellEnv: { PORT: '4000' },
    });
    assert.equal(values.PORT, 4000);          // shell 胜出且已类型化
    assert.equal(values.WEB_STATUSLINE, true); // 文件项保留
  });

  test('shell 未设的 key 不会凭空出现', () => {
    const { values } = resolveConfigValues({ fileValues: {}, shellEnv: {} });
    assert.equal(Object.hasOwn(values, 'PORT'), false);
  });

  // ② ANTHROPIC_* 只认真实 shell export。写进配置文件是静默失效 —— 与其让用户以为配好了，
  // 不如剥除并明确 warn（env-schema.js:14-16 已经把这条钉成硬边界）。
  test('配置文件里的 ANTHROPIC_* 被剥除并 warn', () => {
    const { values, warnings } = resolveConfigValues({
      fileValues: { ANTHROPIC_BASE_URL: 'https://x' },
      shellEnv: {},
    });
    assert.equal(Object.hasOwn(values, 'ANTHROPIC_BASE_URL'), false);
    assert.ok(warnings.some(w => w.includes('ANTHROPIC_')));
  });

  test('shell 里的 ANTHROPIC_* 原样保留', () => {
    const { values } = resolveConfigValues({
      fileValues: {},
      shellEnv: { ANTHROPIC_BASE_URL: 'https://real' },
    });
    assert.equal(values.ANTHROPIC_BASE_URL, 'https://real');
  });

  // 【立场变更记录】此前这里断言的是「未知 key 被丢弃」，理由写作「这不是通用配置编辑器」。
  // 那句话对**写入侧**成立（面板/CLI 至今仍拒绝未知 key），但被错用到了读取侧：
  // dotenv 时代 .env 是全量灌进 process.env 的，claude 子进程靠继承它拿到 HTTPS_PROXY 之类。
  // 白名单过滤等于替用户掐掉那些变量，且常驻部署看不到那行 warn。
  test('schema 之外的 key 放行并报出来（读取侧宽容，写入侧仍严格）', () => {
    const { values, warnings } = resolveConfigValues({
      fileValues: { NOT_A_REAL_KEY: 'x' },
      shellEnv: {},
    });
    assert.equal(values.NOT_A_REAL_KEY, 'x');
    assert.ok(warnings.some(w => w.includes('NOT_A_REAL_KEY')));
  });

  test('$schemaVersion 不当成配置项', () => {
    const { values, warnings } = resolveConfigValues({
      fileValues: { $schemaVersion: 1, PORT: 3000 },
      shellEnv: {},
    });
    assert.equal(Object.hasOwn(values, '$schemaVersion'), false);
    assert.equal(warnings.filter(w => w.includes('schemaVersion')).length, 0);
  });

  // ★ 决策时值 ENV_SCHEMA 只有 31 个 key，而 .env.example（已退役）有 35 个 —— 差的 4 个是**真实被消费的**
  // 配置项，只是没进 UI 可改的那张表（CCM_DATA_DIR 是 readonly diagnostic，另三个是遗漏）。
  // 若按「schema 白名单」一刀切，它们会在迁移时静默消失：用户的 CCM_DATA_DIR 没了 ⇒ 全部
  // 会话/设备信任/审批台账一次性孤儿化，而且报的是「迁移成功」。
  test('passthrough：schema 之外但真实消费的 key 要原样保住且不 warn', () => {
    const passthrough = {
      CCM_DATA_DIR: '/external/data',   // shared/data-dir.js
      WORK_DIRS: '/a,/b',               // app.js:180（P1b 将并入结构化 WORKDIRS）
      CLI_HOOKS_DIR: '/h',              // cli-hooks-bridge.js:51
      CLI_STATUSLINE_DIR: '/s',         // app.js:1078
    };
    const { values, warnings } = resolveConfigValues({ fileValues: passthrough, shellEnv: {} });
    assert.deepEqual(values, passthrough);
    assert.deepEqual(warnings, []);
  });

  test('passthrough key 同样受 shell 覆盖', () => {
    const { values } = resolveConfigValues({
      fileValues: { CCM_DATA_DIR: '/from-file' },
      shellEnv: { CCM_DATA_DIR: '/from-shell' },
    });
    assert.equal(values.CCM_DATA_DIR, '/from-shell');
  });
});

// ★ P1a 的安全边界：**没有任何代码路径会自动创建 ccm.config.json**。
//
// 这条性质是「P1a 对现有部署零影响」的全部依据。迁移只能由用户显式发起（P1c 的 config migrate），
// 在那之前 loadConfigSources 恒走 .env 分支，行为与改造前逐字节相同。
//
// 为什么值得一条断言：仓库里还有 5 个**独立读 .env** 的 CLI 消费者（scripts/doctor.js:468、
// scripts/service.js:699、scripts/device.js:9、scripts/hooks-bridge-setup.js:254、
// src/ops/doctor-runtime.js:12），它们尚未接入统一配置层。若有人在 P1b 顺手加个「启动时自动建
// ccm.config.json」，那 5 个消费者会当场进入「读一个已被忽略的文件」的状态 —— 而且是静默的：
// doctor 会对着空 .env 报「未设置 AUTH_TOKEN」，用户照着改了却毫无效果。
//
// 这 5 个消费者是 P1c 的前置条件，不是 P1a 的遗漏。
test('安全边界：写入侧不会凭空创建 ccm.config.json（迁移必须是显式动作）', () => withTempDir((dir) => {
  writeFileSync(join(dir, '.env'), 'PORT=3000\n');

  // 反复读取不产生副作用
  loadConfigSources({ dir });
  loadConfigSources({ dir });

  assert.equal(existsSync(join(dir, 'ccm.config.json')), false);
  assert.equal(loadConfigSources({ dir }).source, 'env');
}));

// （曾有一条「.env.example 每个 key 须被 schema 或 passthrough 认领」的覆盖面门禁——
// 2026-08-17 .env.example 随「生成旧格式」能力退役后，schema 成为配置项的唯一事实源，
// 「第二事实源漂移」这个被防的轴不复存在，该门禁随之退役。）

test.describe('loadConfigSources —— 新文件优先，回落 .env', () => {
  test('只有 ccm.config.json 时读它', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({ $schemaVersion: 1, PORT: 3000 }));
    const r = loadConfigSources({ dir });
    assert.equal(r.source, 'config');
    assert.equal(r.fileValues.PORT, 3000);
  }));

  test('只有 .env 时回落读它，并提示可迁移', () => withTempDir((dir) => {
    writeFileSync(join(dir, '.env'), 'PORT=3000\nWEB_STATUSLINE=off\n');
    const r = loadConfigSources({ dir });
    assert.equal(r.source, 'env');
    assert.equal(r.fileValues.PORT, '3000');  // 原始字符串，类型化在 resolve 阶段
    assert.ok(r.warnings.some(w => w.includes('migrate')));
  }));

  test('两者都在时新文件优先，且明确告知 .env 已被忽略', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({ PORT: 4000 }));
    writeFileSync(join(dir, '.env'), 'PORT=3000\n');
    const r = loadConfigSources({ dir });
    assert.equal(r.source, 'config');
    assert.equal(r.fileValues.PORT, 4000);
    assert.ok(r.warnings.some(w => w.includes('.env')));
  }));

  test('两个都没有：空配置 + 零 warning（全新安装是正常状态，不该报警）', () => withTempDir((dir) => {
    const r = loadConfigSources({ dir });
    assert.equal(r.source, 'none');
    assert.deepEqual(r.fileValues, {});
    assert.deepEqual(r.warnings, []);
  }));

  // 坏 JSON 必须 fail-loud。回落到空配置会让 server 以「未设 AUTH_TOKEN」启动 ——
  // 那等于把 0.0.0.0 悄悄降级成 127.0.0.1，手机全部连不上却没有任何错误信息。
  test('ccm.config.json 语法错误时抛错，不静默回落', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'ccm.config.json'), '{ broken');
    assert.throws(() => loadConfigSources({ dir }), /ccm\.config\.json/);
  }));

  test('顶层不是对象时抛错', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'ccm.config.json'), '[1,2,3]');
    assert.throws(() => loadConfigSources({ dir }), /ccm\.config\.json/);
  }));
});

// ★ 读写必须指向同一个文件，否则引入的缺陷比解决的问题更严重。
//
// 迁移之后 loadConfigSources 读的是 ccm.config.json，而设置面板若仍写 .env，用户会看到
// 「已写入」但重启后毫无变化 —— 这正是 CF_ACCESS_* 被吞那次的失效形态（fail-open + 假成功）。
test.describe('applyConfigChanges —— 面板/CLI 的写入侧', () => {
  test('字符串态的 changes 按 schema 类型落盘', () => {
    const next = applyConfigChanges({}, { PORT: '4000', WEB_STATUSLINE: 'off', DEV_MODE: '1' });
    assert.equal(next.PORT, 4000);
    assert.equal(next.WEB_STATUSLINE, false);
    assert.equal(next.DEV_MODE, true);
  });

  test('原生类型直接接受（CLI 与 desktop 会直接发结构化值）', () => {
    const next = applyConfigChanges({}, { PORT: 4000, WEB_STATUSLINE: false });
    assert.equal(next.PORT, 4000);
    assert.equal(next.WEB_STATUSLINE, false);
  });

  test('null 与空串都是删除 —— 空串 ≡ 未设置，不该留一个空值占位', () => {
    const next = applyConfigChanges({ WORK_DIR: '/x', CLAUDE_BIN: '/y' }, { WORK_DIR: null, CLAUDE_BIN: '' });
    assert.equal(Object.hasOwn(next, 'WORK_DIR'), false);
    assert.equal(Object.hasOwn(next, 'CLAUDE_BIN'), false);
  });

  test('未提及的项原样保留', () => {
    const next = applyConfigChanges({ AUTH_TOKEN: 'keep', PORT: 3000 }, { PORT: 4000 });
    assert.equal(next.AUTH_TOKEN, 'keep');
  });

  test('总是带上当前 $schemaVersion', () => {
    assert.equal(applyConfigChanges({}, {}).$schemaVersion, CONFIG_SCHEMA_VERSION);
  });

  test('passthrough key 原样写入，不做类型转换', () => {
    const next = applyConfigChanges({}, { CCM_DATA_DIR: '/external' });
    assert.equal(next.CCM_DATA_DIR, '/external');
  });

  // 写盘产物必须能被自己读回来 —— 两侧用不同判据是这个仓库出过事的经典形态。
  test('round-trip：写出去的 JSON 读回来值不变', () => {
    const written = applyConfigChanges({}, { PORT: '4000', WEB_STATUSLINE: 'off', LOG_TERMINAL: 'on' });
    const { values, warnings } = resolveConfigValues({
      fileValues: JSON.parse(JSON.stringify(written)),
      shellEnv: {},
    });
    assert.equal(values.PORT, 4000);
    assert.equal(values.WEB_STATUSLINE, false);
    assert.equal(values.LOG_TERMINAL, true);
    assert.deepEqual(warnings, []); // 自己写的文件读回来不该有任何 coerce 警告
  });
});

// ★ 供 5 个不走 server 启动路径的 CLI 共用（doctor / service / device / hooks-setup / doctor-runtime）。
//
// 它们各自 `readFileSync(join(ROOT, '.env'))` 了五年，setup.js 一改默认格式，这 5 处全部会对着
// 一个不存在的文件工作 —— 最刺眼的是新装用户跑 doctor 会被告知「未设置 AUTH_TOKEN」，
// 照着改了还是没用。这个函数是它们的统一入口。
test.describe('readConfigFileValues —— CLI 侧的配置读取', () => {
  test('新格式：结构化值投影成字符串态，CLI 拿到的与 server 看到的一致', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({
      PORT: 4100, WEB_STATUSLINE: false, AUTH_TOKEN: 'tok',
    }));
    const r = readConfigFileValues(dir);
    assert.equal(r.source, 'config');
    assert.equal(r.values.PORT, '4100');
    assert.equal(r.values.WEB_STATUSLINE, 'off');
    assert.equal(r.values.AUTH_TOKEN, 'tok');
    assert.equal(r.error, null);
  }));

  test('旧格式：.env 原样读出（它本来就是字符串态）', () => withTempDir((dir) => {
    writeFileSync(join(dir, '.env'), 'PORT=3000\nAUTH_TOKEN=old\n');
    const r = readConfigFileValues(dir);
    assert.equal(r.source, 'env');
    assert.equal(r.values.PORT, '3000');
  }));

  test('两者都没有：空值 + source=none，不报错（全新克隆是正常状态）', () => withTempDir((dir) => {
    const r = readConfigFileValues(dir);
    assert.equal(r.source, 'none');
    assert.deepEqual(r.values, {});
    assert.equal(r.error, null);
  }));

  // ★ 坏 JSON 在 CLI 侧**不能抛**：doctor 的职责恰恰是诊断这种情况，崩掉就什么都报不了。
  // 但也不能静默当空 —— 那会让 doctor 报「未设置 AUTH_TOKEN」，把「文件坏了」误诊成「没配」。
  // 所以走 error 出口，由调用方决定怎么呈现。
  test('坏 JSON：不抛异常，经 error 出口如实报出', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'ccm.config.json'), '{ broken');
    const r = readConfigFileValues(dir);
    assert.ok(r.error);
    assert.match(r.error, /ccm\.config\.json/);
    assert.deepEqual(r.values, {});
  }));

  test('显式 envFile 覆盖目录扫描（doctor --env=prod.env 的语义）', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'ccm.config.json'), JSON.stringify({ PORT: 4100 }));
    writeFileSync(join(dir, 'prod.env'), 'PORT=9999\n');
    const r = readConfigFileValues(dir, { envFile: join(dir, 'prod.env') });
    assert.equal(r.values.PORT, '9999');
  }));
});

test.describe('migrateEnvValues —— .env 字符串态转结构化', () => {
  test('三类字面量各自转对', () => {
    const { config } = migrateEnvValues({
      PORT: '3000',
      WEB_STATUSLINE: 'off',
      DEV_MODE: '1',
      LOG_TERMINAL: 'on',
      WORK_DIR: '/Users/you/code',
    });
    assert.equal(config.PORT, 3000);
    assert.equal(config.WEB_STATUSLINE, false);
    assert.equal(config.DEV_MODE, true);
    assert.equal(config.LOG_TERMINAL, true);
    assert.equal(config.WORK_DIR, '/Users/you/code');
  });

  test('带上 $schemaVersion', () => {
    const { config } = migrateEnvValues({ PORT: '3000' });
    assert.equal(typeof config.$schemaVersion, 'number');
  });

  test('ANTHROPIC_* 不迁移（它本来就不该在文件里）', () => {
    const { config, warnings } = migrateEnvValues({ ANTHROPIC_BASE_URL: 'https://x' });
    assert.equal(Object.hasOwn(config, 'ANTHROPIC_BASE_URL'), false);
    assert.ok(warnings.some(w => w.includes('ANTHROPIC_')));
  });

  // 【立场变更记录】同上：此前断言「未知 key 不迁移」，那会让用户迁完就丢掉代理等设置 ——
  // 而迁移的承诺是「1:1 转换」，丢东西与那个承诺直接冲突。
  test('未知 key 一并迁移并报出来', () => {
    const { config, warnings } = migrateEnvValues({ MY_CUSTOM: 'x' });
    assert.equal(config.MY_CUSTOM, 'x');
    assert.ok(warnings.some(w => w.includes('MY_CUSTOM')));
  });

  test('空串视为未设置，不迁移成空值', () => {
    const { config } = migrateEnvValues({ WORK_DIR: '' });
    assert.equal(Object.hasOwn(config, 'WORK_DIR'), false);
  });

  // ── 工作区三合一（P1b）──────────────────────────────────────────────────
  //
  // 迁移后只应剩 WORKDIRS 一条路径。留着 WORK_DIRS_FILE / WORK_DIRS 不删是最糟的中间态：
  // 用户在配置面板里改 WORKDIRS，而 app.js 的优先级链让内联的赢 —— 那个仍然存在的
  // workdirs.json 会变成一份「看起来是事实源、实际已失效」的文件，下次排障时误导人。
  test('外部 workdirs.json 内联进 WORKDIRS，且 WORK_DIRS_FILE 被移除', () => {
    const { config, warnings } = migrateEnvValues(
      { WORK_DIRS_FILE: 'workdirs.json', PORT: '3000' },
      { workdirsEntries: ['/a', { path: '/b', sessionLimit: 3 }] },
    );
    assert.deepEqual(config.WORKDIRS, ['/a', { path: '/b', sessionLimit: 3 }]);
    assert.equal(Object.hasOwn(config, 'WORK_DIRS_FILE'), false);
    assert.ok(warnings.some(w => w.includes('workdirs')));
  });

  test('逗号串 WORK_DIRS 拆成数组，且原 key 被移除', () => {
    const { config } = migrateEnvValues({ WORK_DIRS: '/a, /b ,/c' });
    assert.deepEqual(config.WORKDIRS, ['/a', '/b', '/c']);
    assert.equal(Object.hasOwn(config, 'WORK_DIRS'), false);
  });

  // WORK_DIRS_FILE 指着一个读不出来的文件时**不能**静默丢掉工作区配置 —— 那会让用户迁移后
  // 只剩 WORK_DIR 一个工作区，而迁移过程报的是成功。保留原 key 并明确 warn，让用户自己决定。
  test('workdirs.json 读不出来时保留 WORK_DIRS_FILE 并告警，不假装迁移成功', () => {
    const { config, warnings } = migrateEnvValues(
      { WORK_DIRS_FILE: 'workdirs.json' },
      { workdirsEntries: null },
    );
    assert.equal(config.WORK_DIRS_FILE, 'workdirs.json');
    assert.equal(Object.hasOwn(config, 'WORKDIRS'), false);
    assert.ok(warnings.some(w => w.includes('WORK_DIRS_FILE')));
  });

  test('两条旧路径都在时，文件路径优先（与 app.js 的既有优先级一致）', () => {
    const { config } = migrateEnvValues(
      { WORK_DIRS_FILE: 'workdirs.json', WORK_DIRS: '/ignored' },
      { workdirsEntries: ['/from-file'] },
    );
    assert.deepEqual(config.WORKDIRS, ['/from-file']);
    assert.equal(Object.hasOwn(config, 'WORK_DIRS'), false);
  });

  test('两条旧路径都没有时不凭空造 WORKDIRS', () => {
    const { config } = migrateEnvValues({ PORT: '3000' });
    assert.equal(Object.hasOwn(config, 'WORKDIRS'), false);
  });
});

// ★ 安全断言，不是行为测试。
//
// ccm.config.json 与 .env 同等敏感（AUTH_TOKEN / VAPID 私钥 / ntfy token 都在里面），而本仓是
// **public repo**。setup.js 现在默认把它生成在项目根，用户一个 `git add -A` 就会把自己的入口
// 密钥推上公网 —— 实测确认过：加 .gitignore 之前 `git status` 确实把它列为待追踪。
//
// 这条性质不能靠「记得」：它在 .gitignore 里只是一行，删掉不会有任何测试变红，除非有这一条。
test('安全：ccm.config.json 必须被 gitignore（含 AUTH_TOKEN，且本仓 public）', () => {
  const repoRoot = new URL('../../', import.meta.url).pathname;

  // 容器/无 git 环境跳过：check-ignore 需要真实工作树
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot, encoding: 'utf8' });
  if (probe.status !== 0) return;

  for (const name of ['ccm.config.json', 'ccm.config.prod.json']) {
    const r = spawnSync('git', ['check-ignore', name], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(r.status, 0, `${name} 未被 .gitignore 覆盖 —— 用户 git add -A 会把 AUTH_TOKEN 提交到 public repo`);
  }
});

// ★★ 读取侧放行未登记的 key，写入侧仍然拒绝。
//
// dotenv 时代 `.env` 是**全量**灌进 process.env 的，而 claude 子进程继承 process.env ——
// 所以写在 .env 里的 HTTPS_PROXY / CLAUDE_CONFIG_DIR 之类一直是生效的。改成 schema 白名单
// 过滤之后它们被静默丢弃（只留一行 warn，而常驻部署的 stdout 被进程管理器重定向，看不到）。
//
// 两侧立场不同是刻意的：
//   · 读取侧宽容 —— 用户往配置里放什么是他的自由，子进程该拿到就拿到
//   · 写入侧严格 —— 面板/CLI 拒绝未知 key，那是「不做通用配置编辑器」的产品边界
//
// 代价：拼错的 key（AUTH_TOEKN）不再被当成错误。无法自动区分「有意的第三方变量」和
// 「拼错的自家变量」，所以 warn 的措辞要让两种情况都读得懂 —— 说「已原样传递」而不是
// 「已忽略」，用户看到自己没打算传的东西出现在这一行就会发现拼错了。
test.describe('未登记 key：读取侧放行', () => {
  test('配置文件里的未知 key 进入生效配置', () => {
    const { values } = resolveConfigValues({
      fileValues: { AUTH_TOKEN: 't', HTTPS_PROXY: 'http://127.0.0.1:7890' },
      shellEnv: {},
    });
    assert.equal(values.HTTPS_PROXY, 'http://127.0.0.1:7890');
  });

  test('放行但要报出来 —— 措辞得让「拼错了」也看得出来', () => {
    const { warnings } = resolveConfigValues({ fileValues: { AUTH_TOEKN: 'typo' }, shellEnv: {} });
    assert.ok(warnings.some(w => w.includes('AUTH_TOEKN')));
    assert.ok(warnings.some(w => /传递|passed/.test(w)), '不能再说「已忽略」——它现在确实生效了');
  });

  test('已登记的 passthrough 项不 warn（它们是已知的）', () => {
    const { warnings } = resolveConfigValues({ fileValues: { CCM_DATA_DIR: '/x' }, shellEnv: {} });
    assert.deepEqual(warnings, []);
  });

  test('ANTHROPIC_* 仍然剥除 —— 那是硬边界，不受本次放行影响', () => {
    const { values } = resolveConfigValues({ fileValues: { ANTHROPIC_BASE_URL: 'https://x' }, shellEnv: {} });
    assert.equal(Object.hasOwn(values, 'ANTHROPIC_BASE_URL'), false);
  });

  test('未知 key 不做类型归一，原样传递', () => {
    const { values } = resolveConfigValues({ fileValues: { SOME_FLAG: 'false' }, shellEnv: {} });
    assert.equal(values.SOME_FLAG, 'false');
  });

  // 迁移必须带上它们，否则用户迁完就丢了代理设置
  test('migrate 保留未登记的 key', () => {
    const { config, warnings } = migrateEnvValues({ AUTH_TOKEN: 't', HTTPS_PROXY: 'http://p' });
    assert.equal(config.HTTPS_PROXY, 'http://p');
    assert.ok(warnings.some(w => w.includes('HTTPS_PROXY')));
  });

  test('结构化投影也带上它们（否则 server 起来后子进程还是拿不到）', () => {
    const out = structuredToStringValues({ HTTPS_PROXY: 'http://p', PORT: 3000 });
    assert.equal(out.HTTPS_PROXY, 'http://p');
    assert.equal(out.PORT, '3000');
  });
});
