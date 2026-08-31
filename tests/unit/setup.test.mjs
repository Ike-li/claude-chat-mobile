// tests/unit/setup.test.mjs —— setup 向导的纯逻辑单测（零 token、零交互）
// 交互壳（readline 提问 / 写文件）不在此测，靠手动跑 `npm run setup` 验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken, buildConfigContent, parseSetupArgs, resolveSetupPlan, normalizeSetupWorkDir, promptWorkDir, promptWorkDirs, describeOverwrite, runInteractive, runNonInteractive, MESSAGES } from '../../scripts/setup.js';

const SETUP = new URL('../../scripts/setup.js', import.meta.url);

// ── P1b：默认生成 ccm.config.json ────────────────────────────────────────────
//
// 结构化构造：写出去的就是数据本身，不存在旧模板替换时代「正则没匹配上就静默不生效」的
// 失败模式（buildEnvContent + .env.example 已于 2026-08-17 随「生成旧格式」能力退役）。
test.describe('buildConfigContent —— 结构化生成，不再依赖模板匹配', () => {
  test('产出合法 JSON，带 schema 版本与两个必填项', () => {
    const parsed = JSON.parse(buildConfigContent({ authToken: 'abc123', workDir: '/Users/you/code' }));
    assert.equal(parsed.AUTH_TOKEN, 'abc123');
    assert.equal(parsed.WORK_DIR, '/Users/you/code');
    assert.equal(typeof parsed.$schemaVersion, 'number');
  });

  test('省略 workDir 时不写这个 key —— 缺省回落到 $HOME 由 config.js:66 负责', () => {
    const parsed = JSON.parse(buildConfigContent({ authToken: 'abc123' }));
    assert.equal(Object.hasOwn(parsed, 'WORK_DIR'), false);
  });

  // 曾经的 .env 时代有一整套字符白名单（含单引号 / 反斜杠结尾一律拒绝），因为值要同时
  // 满足 dotenv 与 shell 两个解析器。JSON 没有第二个消费者，转义由 JSON.stringify 负责。
  test('路径含空格、引号、反斜杠都能原样往返', () => {
    const nasty = "/Users/you/it's a \\ dir";
    const parsed = JSON.parse(buildConfigContent({ authToken: 'x', workDir: nasty }));
    assert.equal(parsed.WORK_DIR, nasty);
  });

  test('末尾带换行（POSIX 文本文件惯例）', () => {
    assert.ok(buildConfigContent({ authToken: 'x' }).endsWith('\n'));
  });
});

test('generateToken: 十六进制、长度=2×bytes、每次不同', () => {
  const t = generateToken(32);
  assert.match(t, /^[0-9a-f]+$/);
  assert.equal(t.length, 64);
  assert.notEqual(generateToken(32), generateToken(32));
});

// ── 非交互模式（编程 agent 代装用）─────────────────────────────
// 背景实证：无 TTY 时 stdin 立刻 EOF → rl.question 的 promise 永不 settle → 进程静默退出 0、
// .env 一个字没写，却已经先打印过「✓ 已生成 AUTH_TOKEN（已写入 .env）」。agent 照这个输出
// 判定必然误报成功。故非交互路径必须由参数完整表达意图，且危险默认一律不许静默生效。

test('parseSetupArgs: 已退役的 --env 按未知参数处理（生成旧格式的能力已移除，拒绝而非静默忽略）', () => {
  assert.ok(parseSetupArgs(['--env=/tmp/b/.env']).unknown.includes('--env=/tmp/b/.env'));
  assert.ok(parseSetupArgs(['--env', '/tmp/a/.env']).unknown.includes('--env'));
});

test('parseSetupArgs: 解析全部开关', () => {
  const a = parseSetupArgs(['--yes', '--work-dir=/tmp/w', '--hooks=on', '--force']);
  assert.equal(a.yes, true);
  assert.equal(a.workDir, '/tmp/w');
  assert.equal(a.hooks, 'on');
  assert.equal(a.force, true);
  assert.deepEqual(a.unknown, []);
  assert.equal(parseSetupArgs(['-y']).yes, true);
});

test('parseSetupArgs: 未知参数被收集而非静默忽略', () => {
  // --workdir 少了连字符：静默忽略会让 WORK_DIR 悄悄回落成 $HOME（= 把整个家目录挂给 agent）
  assert.deepEqual(parseSetupArgs(['--yes', '--workdir=/tmp/w']).unknown, ['--workdir=/tmp/w']);
});

test('resolveSetupPlan: 非交互缺 --work-dir 时拒绝，不静默用 $HOME', () => {
  const plan = resolveSetupPlan({ args: parseSetupArgs(['--yes']), envExists: false });
  assert.equal(plan.refuse?.code, 'work_dir_required');
});

test('resolveSetupPlan: 非交互默认不装 hooks（不擅自写全局 ~/.claude/settings.json）', () => {
  const plan = resolveSetupPlan({ args: parseSetupArgs(['--yes', '--work-dir=/tmp/w']), envExists: false });
  assert.equal(plan.refuse, undefined);
  assert.equal(plan.mode, 'noninteractive');
  assert.equal(plan.hooks, 'off');
  assert.equal(plan.workDir, '/tmp/w');
});

test('resolveSetupPlan: 非交互显式 --hooks=on 才装', () => {
  const plan = resolveSetupPlan({ args: parseSetupArgs(['--yes', '--work-dir=/tmp/w', '--hooks=on']), envExists: false });
  assert.equal(plan.hooks, 'on');
});

test('resolveSetupPlan: 非交互遇已存在 .env 拒绝覆盖，除非 --force', () => {
  const args = ['--yes', '--work-dir=/tmp/w'];
  assert.equal(resolveSetupPlan({ args: parseSetupArgs(args), envExists: true }).refuse?.code, 'env_exists');
  assert.equal(resolveSetupPlan({ args: parseSetupArgs([...args, '--force']), envExists: true }).refuse, undefined);
});

test('resolveSetupPlan: --hooks 取值非法时拒绝', () => {
  const plan = resolveSetupPlan({ args: parseSetupArgs(['--yes', '--work-dir=/tmp/w', '--hooks=maybe']), envExists: false });
  assert.equal(plan.refuse?.code, 'invalid_hooks');
});

test('resolveSetupPlan: 未知参数一律拒绝', () => {
  const plan = resolveSetupPlan({ args: parseSetupArgs(['--yes', '--work-dir=/tmp/w', '--nope']), envExists: false });
  assert.equal(plan.refuse?.code, 'unknown_flag');
});

test('resolveSetupPlan: 交互模式不要求 --work-dir，未给的项留 undefined 待询问', () => {
  const plan = resolveSetupPlan({ args: parseSetupArgs([]), envExists: true });
  assert.equal(plan.refuse, undefined);
  assert.equal(plan.mode, 'interactive');
  assert.equal(plan.workDir, undefined);
  assert.equal(plan.hooks, undefined);
});

test('resolveSetupPlan: 交互模式下已给的参数直接生效、不再问', () => {
  const plan = resolveSetupPlan({ args: parseSetupArgs(['--work-dir=/tmp/w', '--hooks=off']), envExists: false });
  assert.equal(plan.mode, 'interactive');
  assert.equal(plan.workDir, '/tmp/w');
  assert.equal(plan.hooks, 'off');
});

// ── 桌面控制台的装机选项 ────────────────────────────────────────────────────
//
// 用户装完 CLI 才知道有个桌面端、还得自己去翻文档找 `npm run app:build` —— 装机时问一句
// 更自然。与 hooks 同一心智：**默认不装**（它要跑 swiftc、可能要用户先装 CLT），
// 且非交互模式必须显式给值，不猜。
test.describe('--desktop：桌面控制台', () => {
  test('解析 on / off', () => {
    assert.equal(parseSetupArgs(['--desktop=on']).desktop, 'on');
    assert.equal(parseSetupArgs(['--desktop', 'off']).desktop, 'off');
    assert.equal(parseSetupArgs([]).desktop, undefined, '不给就是待询问');
  });

  test('取值非法时拒绝 —— 同 --hooks，不猜用户意图', () => {
    const r = resolveSetupPlan({ args: parseSetupArgs(['--yes', '--work-dir=/x', '--desktop=yes']) });
    assert.ok(r.refuse);
    assert.equal(r.refuse.code, 'invalid_desktop');
  });

  // platform 显式钉 darwin：这两条测的是 macOS 上的装/不装决策。不钉的话在 Linux CI 上
  // --desktop=on 会走 desktop_unsupported 拒绝分支（r.desktop=undefined），
  // 而「默认不装」则与拒绝分支恰好同值 'off'，空过。
  test('非交互模式默认不装 —— 它要跑 swiftc，不该擅自做', () => {
    const r = resolveSetupPlan({ args: parseSetupArgs(['--yes', '--work-dir=/x']), platform: 'darwin' });
    assert.equal(r.desktop, 'off');
  });

  test('非交互显式 on 才装', () => {
    const r = resolveSetupPlan({ args: parseSetupArgs(['--yes', '--work-dir=/x', '--desktop=on']), platform: 'darwin' });
    assert.equal(r.desktop, 'on');
  });

  // 非 macOS 上没有桌面端可装。静默忽略会让用户以为装上了，明确拒绝才有信息量 ——
  // 同 src/ops/log-terminal.js 那条「返回 reason 而不是假装成功」。
  test('非 macOS 上显式 --desktop=on 被拒绝并说明原因', () => {
    const r = resolveSetupPlan({
      args: parseSetupArgs(['--yes', '--work-dir=/x', '--desktop=on']),
      platform: 'linux',
    });
    assert.ok(r.refuse);
    assert.equal(r.refuse.code, 'desktop_unsupported');
  });

  test('非 macOS 上不给 --desktop 则正常走完，不报错', () => {
    const r = resolveSetupPlan({
      args: parseSetupArgs(['--yes', '--work-dir=/x']),
      platform: 'linux',
    });
    assert.equal(r.refuse, undefined);
    assert.equal(r.desktop, 'off');
  });

  test('交互模式不预设，留 undefined 待询问', () => {
    const r = resolveSetupPlan({ args: parseSetupArgs([]) });
    assert.equal(r.desktop, undefined);
  });
});

// ── 新用户踩过的装机坑 ────────────────────────────────────────────────────
// 无 TTY 的 `npm run setup` 曾对着已有配置打出覆盖提示后 exit 0，成功信号几乎没有。
// 家目录回车默认曾与文档「不要把整个家目录交给远程入口」对不上。

test('parseSetupArgs: --help / -h 不当未知参数', () => {
  assert.equal(parseSetupArgs(['--help']).help, true);
  assert.equal(parseSetupArgs(['-h']).help, true);
  assert.deepEqual(parseSetupArgs(['--help']).unknown, []);
});

test('resolveSetupPlan: --help 直接进入 help，不要求 TTY 或 --yes', () => {
  const plan = resolveSetupPlan({ args: parseSetupArgs(['--help']), isTty: false });
  assert.equal(plan.mode, 'help');
  assert.equal(plan.refuse, undefined);
});

test('resolveSetupPlan: 非 TTY 且未给 --yes → 拒绝，不走进交互提问', () => {
  const plan = resolveSetupPlan({ args: parseSetupArgs([]), isTty: false });
  assert.equal(plan.refuse?.code, 'tty_required');
});

test('normalizeSetupWorkDir: 空串 / 家目录 / 相对路径拒绝，绝对项目路径通过', () => {
  const home = '/Users/you';
  assert.equal(normalizeSetupWorkDir('', { home }).code, 'work_dir_required');
  assert.equal(normalizeSetupWorkDir('   ', { home }).code, 'work_dir_required');
  assert.equal(normalizeSetupWorkDir(home, { home }).code, 'work_dir_is_home');
  assert.equal(normalizeSetupWorkDir('~', { home }).code, 'work_dir_is_home');
  assert.equal(normalizeSetupWorkDir('code/project', { home }).code, 'work_dir_not_absolute');
  const ok = normalizeSetupWorkDir('/Users/you/code/project', { home });
  assert.equal(ok.ok, true);
  assert.equal(ok.workDir, '/Users/you/code/project');
  const fromHome = normalizeSetupWorkDir('~/code/project', { home });
  assert.equal(fromHome.ok, true);
  assert.equal(fromHome.workDir, '/Users/you/code/project');
});

test('resolveSetupPlan: 非交互 --work-dir 等于家目录时拒绝', () => {
  const plan = resolveSetupPlan({
    args: parseSetupArgs(['--yes', '--work-dir=/Users/you', '--hooks=off']),
    home: '/Users/you',
  });
  assert.equal(plan.refuse?.code, 'work_dir_is_home');
});

test('向导文案不再把配置文件叫 .env', () => {
  for (const lang of ['zh', 'en']) {
    assert.doesNotMatch(MESSAGES[lang].cancelled, /\.env/);
    assert.doesNotMatch(MESSAGES[lang].tokenWrittenSuffix, /\.env/);
    assert.match(MESSAGES[lang].refuse.tty_required(), /--yes/);
  }
});

test('CLI：无 TTY 且未给 --yes → exit 2，不写配置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-setup-tty-'));
  const config = join(dir, 'ccm.config.json');
  try {
    const res = spawnSync(process.execPath, [SETUP.pathname, `--config=${config}`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LANG: 'C' },
    });
    assert.equal(res.status, 2, res.stderr || res.stdout);
    assert.match(`${res.stderr}\n${res.stdout}`, /--yes/);
    assert.equal(existsSync(config), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI：--config 写到别处时，仓库根已有 ccm.config.json 不挡', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-setup-cfg-'));
  const work = join(dir, 'work');
  const config = join(dir, 'ccm.config.json');
  try {
    const res = spawnSync(process.execPath, [
      SETUP.pathname, '--yes', `--work-dir=${work}`, '--hooks=off', `--config=${config}`,
    ], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LANG: 'C' },
      cwd: new URL('../..', import.meta.url).pathname,
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(existsSync(config), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 覆盖提示：说的必须是「将写入哪个文件」，不是「搜到了哪个文件」───────────
//
// runInteractive 此前自己又搜了一遍 [outPath, ccm.config.json, .env]，与 main() 已经算好的
// existingConfig 分岔，同一处错配长出两个症状：
//   · legacy 部署被问「/repo/.env 已存在，覆盖它?」，答 y 写的却是 ccm.config.json ——
//     .env 原样留在磁盘上、但从此被更高优先级的新文件完全架空（CCM_DATA_DIR 失效 ⇒ 会话与
//     设备信任全部孤儿化，CF_ACCESS_* 失效 ⇒ 公网 2FA 关闭），而用户看文件还在，以为没事。
//   · `--config <path>` 隔离装机被问「仓库的 ccm.config.json 会被覆盖」，而它根本不会被碰；
//     默认答 N 于是取消了一次本来完全安全的安装。
test.describe('describeOverwrite —— 覆盖提示的判定', () => {
  test('没有既有配置 → 根本不问', () => {
    assert.equal(describeOverwrite({ existingConfig: undefined, outPath: '/repo/ccm.config.json' }), null);
  });

  test('检测到的就是将写入的 → 普通覆盖', () => {
    const d = describeOverwrite({ existingConfig: '/repo/ccm.config.json', outPath: '/repo/ccm.config.json' });
    assert.equal(d.shadows, false);
    assert.equal(d.target, '/repo/ccm.config.json');
  });

  test('★ legacy .env + 将写 ccm.config.json → 必须判成影子化，不能当普通覆盖问', () => {
    const d = describeOverwrite({ existingConfig: '/repo/.env', outPath: '/repo/ccm.config.json' });
    assert.equal(d.shadows, true, '.env 不会被覆盖，而是被架空——这比覆盖更隐蔽，提示必须分开说');
    assert.equal(d.existing, '/repo/.env');
    assert.equal(d.target, '/repo/ccm.config.json');
  });

  test('★ 影子化文案要点名后果与迁移出路，两种语言都要', () => {
    for (const lang of ['zh', 'en']) {
      const msg = MESSAGES[lang].shadowWarning('/repo/.env', '/repo/ccm.config.json');
      assert.match(msg, /\/repo\/\.env/, '要说清是哪个旧文件');
      assert.match(msg, /ccm\.config\.json/, '要说清将写入哪个新文件');
      assert.match(msg, /CCM_DATA_DIR/, '后果里最贵的一项必须点名');
      assert.match(msg, /config\.js migrate/, '要给出迁移出路，不能只拦不指路');
    }
  });
});

// ★ 影子化的后果与走哪条路径无关。交互路径拿到了整段警告，而 `--yes --force` 一声不吭 ——
// 而那恰恰是「照着文档敲一行命令」的人会用的形式，出事时更没有线索。
// --force 的语义是「我知道有既有配置，继续」，不是「别告诉我会发生什么」。
test.describe('runNonInteractive —— --yes --force 也要说清影子化', () => {
  const run = (existingConfig, outPath) => {
    const warns = [];
    runNonInteractive(
      { plan: { workDir: '/tmp/ccm-work', hooks: 'off', desktop: 'off' }, outPath, existingConfig, t: MESSAGES.zh },
      { writeFile: () => {}, buildDesktop: () => {}, installHooks: () => {}, warn: (m) => warns.push(m) },
    );
    return warns.join('\n');
  };

  test('★ legacy .env + 写 ccm.config.json → 后果与出路都要说出来', () => {
    const w = run('/repo/.env', '/repo/ccm.config.json');
    assert.match(w, /CCM_DATA_DIR/, '最贵的那一项后果必须点名');
    assert.match(w, /config\.js migrate/, '要给出迁移这条正路');
  });

  test('覆盖的就是同一个文件 → 不是影子化，别多嘴', () => {
    assert.equal(run('/repo/ccm.config.json', '/repo/ccm.config.json'), '');
  });

  test('全新安装 → 不警告', () => {
    assert.equal(run(undefined, '/repo/ccm.config.json'), '');
  });
});

// ── 交互向导：问了就必须用 ────────────────────────────────────────────────
// 「编译 macOS 桌面控制台?」问完把答案丢了：desktop 变量赋值后再没被读过，buildDesktopApp
// 只在非交互路径被调用。答 y 的用户什么也没等到，连一句「已跳过」都没有。
test.describe('runInteractive —— 桌面控制台的回答必须生效', () => {
  // answer: (question) => string —— 按问题内容作答，模拟真人敲键盘
  const baseDeps = (answer = () => '') => {
    const calls = [];
    const asked = [];
    return {
      calls,
      asked,
      deps: {
        createRl: () => ({
          question: async (q) => { asked.push(q); return answer(q); },
          close: () => {},
        }),
        writeFile: () => calls.push('write'),
        buildDesktop: () => calls.push('desktop'),
        installHooks: () => calls.push('hooks'),
      },
    };
  };

  const PLAN = { plan: { workDir: '/tmp/ccm-work', hooks: 'off', desktop: undefined }, outPath: '/tmp/ccm.config.json', existingConfig: undefined, t: MESSAGES.zh };

  test('★ 答 y → 真的去编译（此前一声不吭什么也不做）', async () => {
    const { calls, deps } = baseDeps((q) => (/桌面控制台/.test(q) ? 'y' : ''));
    await runInteractive(PLAN, { ...deps, platform: 'darwin' });
    assert.ok(calls.includes('desktop'), '答 y 就必须编译');
  });

  test('答 n → 不编译', async () => {
    const { calls, deps } = baseDeps(() => 'n');
    await runInteractive(PLAN, { ...deps, platform: 'darwin' });
    assert.equal(calls.includes('desktop'), false);
  });

  test('非 macOS → 不问也不编译', async () => {
    const { calls, asked, deps } = baseDeps();
    await runInteractive(PLAN, { ...deps, platform: 'linux' });
    assert.equal(calls.includes('desktop'), false);
    assert.equal(asked.some((q) => /桌面控制台/.test(q)), false, '非 macOS 上问了也没用，别问');
  });

  test('★ --config 隔离装机：existingConfig 由调用方给定，向导不再自己去仓库根搜一遍', async () => {
    const { calls, asked, deps } = baseDeps();
    await runInteractive(
      { plan: { workDir: '/tmp/ccm-work', hooks: 'off', desktop: 'off' }, outPath: '/tmp/isolated.json', existingConfig: undefined, t: MESSAGES.zh },
      { ...deps, platform: 'linux' },
    );
    assert.equal(asked.some((q) => /覆盖它|仍要继续/.test(q)), false, '目标文件不存在就不该问覆盖');
    assert.ok(calls.includes('write'), '不问覆盖也要照常写');
  });

  test('★ legacy .env → 弹的是影子化警告，不是「覆盖它?」', async () => {
    const { asked, deps } = baseDeps(() => 'y');
    await runInteractive(
      { plan: { workDir: '/tmp/ccm-work', hooks: 'off', desktop: 'off' }, outPath: '/repo/ccm.config.json', existingConfig: '/repo/.env', t: MESSAGES.zh },
      { ...deps, platform: 'linux' },
    );
    const q = asked.find((s) => /\.env/.test(s));
    assert.ok(q, '必须就 .env 问一次');
    assert.match(q, /CCM_DATA_DIR/, '后果要摆出来，不能只说「已存在，覆盖它?」');
    assert.match(q, /config\.js migrate/, '要指出迁移这条正路');
  });
});

// ── 交互向导：输错一个字符不该让人重跑整个向导 ─────────────────────────────
// 拒空回车/家目录是对的，但第一版实现拒完就 return——用户已经答过「覆盖现有配置? y」，
// 一个 typo 就得从头再来。这里把「问一次」换成「问到对或到上限」，上限是必须的：
// 没有上限时，ask 若因 stdin 关闭恒返回空串就成了死循环（文件头注释记的正是这类 EOF 事故）。
test('promptWorkDir：输错可以重来，逐次报出具体原因', async () => {
  const answers = ['', '/Users/you', '/Users/you/code/app'];
  const seen = [];
  let asked = 0;

  const r = await promptWorkDir(async () => answers[asked++], {
    home: '/Users/you',
    onInvalid: ({ code }) => seen.push(code),
  });

  assert.equal(r.ok, true);
  assert.equal(r.workDir, '/Users/you/code/app');
  assert.equal(asked, 3);
  assert.deepEqual(seen, ['work_dir_required', 'work_dir_is_home'], '每次拒绝的理由要各自报出来，不能只报最后一次');
});

test('promptWorkDir：连错到上限就停，不无限追问', async () => {
  let asked = 0;
  const r = await promptWorkDir(async () => { asked += 1; return 'code/project'; }, {
    home: '/Users/you',
    maxAttempts: 3,
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'work_dir_not_absolute', '返回最后一次的具体原因，不是笼统的 required');
  assert.equal(asked, 3, '到上限必须停——ask 恒返回空串时（stdin 关闭）没有上限就是死循环');
});

test('promptWorkDir：第一次就对则只问一次', async () => {
  let asked = 0;
  const r = await promptWorkDir(async () => { asked += 1; return '~/code/app'; }, { home: '/Users/you' });

  assert.equal(r.ok, true);
  assert.equal(r.workDir, '/Users/you/code/app');
  assert.equal(asked, 1);
});

test('CLI：--help 在无 TTY 下 exit 0 并打印用法', () => {
  const res = spawnSync(process.execPath, [SETUP.pathname, '--help'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LANG: 'C' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /--work-dir=/);
});

test.describe('promptWorkDirs —— 向导支持一次登记多个工作区', () => {
  test('首个必填；追加可选，空回车结束；写入顺序保持、重复去重', async () => {
    const first = ['/Users/you/code/app'];
    const extras = ['/Users/you/code/tools', '/Users/you/code/app', '   ', '不会问到这里'];
    let f = 0; let e = 0;
    const r = await promptWorkDirs(
      async () => first[f++],
      async () => extras[e++],
      { home: '/Users/you' },
    );
    assert.equal(r.ok, true);
    assert.equal(r.workDir, '/Users/you/code/app', 'WORK_DIR = 第一个（默认工作区）');
    assert.deepEqual(r.workDirs, ['/Users/you/code/app', '/Users/you/code/tools'], '重复项去重、空回车即止');
    assert.equal(e, 3, '空回车后不再追问');
  });

  test('追加目录无效（相对路径/家目录）→ 报原因后继续问，不炸整个向导', async () => {
    const invalids = [];
    const extras = ['relative/path', '~', '/Users/you/code/b', ''];
    let e = 0;
    const r = await promptWorkDirs(
      async () => '/Users/you/code/a',
      async () => extras[e++],
      { home: '/Users/you', onInvalid: ({ code }) => invalids.push(code) },
    );
    assert.deepEqual(r.workDirs, ['/Users/you/code/a', '/Users/you/code/b']);
    assert.deepEqual(invalids, ['work_dir_not_absolute', 'work_dir_is_home']);
  });

  test('首个就不合法且重试耗尽 → 失败原样上抛（与 promptWorkDir 同契约）', async () => {
    const r = await promptWorkDirs(async () => '', async () => '', { home: '/Users/you', maxAttempts: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'work_dir_required');
  });
});

test('buildConfigContent：给了 workDirs 就写 WORKDIRS 数组（自文档化，供日后手动增删），WORK_DIR 仍是默认那个', () => {
  const parsed = JSON.parse(buildConfigContent({
    authToken: 'x',
    workDir: '/Users/you/code/app',
    workDirs: ['/Users/you/code/app', '/Users/you/code/tools'],
  }));
  assert.equal(parsed.WORK_DIR, '/Users/you/code/app');
  assert.deepEqual(parsed.WORKDIRS, ['/Users/you/code/app', '/Users/you/code/tools']);
});

// ── R45(2026-08-30 拍板)：文件编辑器直写进配置向导 ─────────────────────────
// 默认值不动（FILE_EDIT 缺省=开，机主即 root，hard-rules §2.3）；但它是唯一绕过
// Agent 审批链的写入通道，hard-rules §1「可选功能逐项问」的名单此前漏了它——
// 补上询问：答「n」才写 FILE_EDIT=off，回车维持默认。非交互路径行为不变（不新增必填项）。
test.describe('setup 向导 —— 文件编辑器直写要问一句（R45）', () => {
  test('buildConfigContent：fileEdit off 才写 FILE_EDIT 键，默认不写（缺省开由 schema 负责）', () => {
    // ccm.config.json 是类型化存储：toggle 落盘为布尔 false，读取时 projectToEnv 投影回
    // 'off' 字面量进 process.env（消费点 app.js 判 === 'off'）。写字符串 'off' 会在每次
    // 加载时刷一条类型转换 warning——走 applyConfigChanges 归一正是为了读写同源。
    const off = JSON.parse(buildConfigContent({ authToken: 'x', workDir: '/tmp/w', fileEdit: 'off' }));
    assert.equal(off.FILE_EDIT, false);
    const def = JSON.parse(buildConfigContent({ authToken: 'x', workDir: '/tmp/w' }));
    assert.equal(Object.hasOwn(def, 'FILE_EDIT'), false, '默认开由 schema 负责，配置文件不写多余键');
  });

  const seqDeps = (answer) => {
    const seq = [];
    let written;
    return {
      seq,
      written: () => written,
      deps: {
        createRl: () => ({
          question: async (q) => {
            if (/文件编辑/.test(q)) seq.push('ask-file-edit');
            return answer(q);
          },
          close: () => {},
        }),
        writeFile: (args) => { seq.push('write'); written = args; },
        buildDesktop: () => {},
        installHooks: () => {},
        platform: 'linux',
      },
    };
  };
  const PLAN = { plan: { workDir: '/tmp/ccm-work', hooks: 'off', desktop: 'off' }, outPath: '/tmp/ccm.config.json', existingConfig: undefined, t: MESSAGES.zh };

  test('★ 答 n → 写入 FILE_EDIT=off，且问题必须在写文件之前（它要进配置文件，不是装完再问的安装动作）', async () => {
    const { seq, written, deps } = seqDeps((q) => (/文件编辑/.test(q) ? 'n' : ''));
    await runInteractive(PLAN, deps);
    assert.ok(seq.includes('ask-file-edit'), '必须问');
    assert.ok(seq.indexOf('ask-file-edit') < seq.indexOf('write'), '问晚了答案就进不了配置文件');
    assert.equal(written().fileEdit, 'off');
  });

  test('回车（默认）→ 不写 FILE_EDIT，维持默认开', async () => {
    const { written, deps } = seqDeps(() => '');
    await runInteractive(PLAN, deps);
    assert.equal(written().fileEdit, undefined);
  });

  test('两种语言的提示都存在，且点名「不经审批链」这个关键差异', () => {
    assert.match(MESSAGES.zh.fileEditPrompt, /审批/);
    assert.match(MESSAGES.en.fileEditPrompt, /approval/i);
  });
});
