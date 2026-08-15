// tests/unit/setup.test.mjs —— setup 向导的纯逻辑单测（零 token、零交互）
// 交互壳（readline 提问 / 写文件）不在此测，靠手动跑 `npm run setup` 验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateToken, buildConfigContent, buildEnvContent, parseSetupArgs, resolveSetupPlan } from '../../scripts/setup.js';

// ── P1b：默认生成 ccm.config.json ────────────────────────────────────────────
//
// buildEnvContent 那套是「正则替换 .env.example 模板的赋值行」，它自己的兜底逻辑就写着
// 「模板格式一旦变了就静默不替换」—— setup.js:166 因此还得回头校验一次替换是否真的生效。
// 结构化构造没有这个失败模式：写出去的就是数据本身，不存在「没匹配上」。
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

test('buildEnvContent: 填入 AUTH_TOKEN，其余行原样不动', () => {
  const tpl = 'AUTH_TOKEN=\nPORT=3000\nWORK_DIR=\n';
  const out = buildEnvContent(tpl, { authToken: 'abc123' });
  assert.match(out, /^AUTH_TOKEN=abc123$/m);
  assert.match(out, /^PORT=3000$/m);
});

test('buildEnvContent: 填入 WORK_DIR', () => {
  const tpl = 'AUTH_TOKEN=\nWORK_DIR=\n';
  const out = buildEnvContent(tpl, { authToken: 'x', workDir: '/tmp/work' });
  assert.match(out, /^WORK_DIR=\/tmp\/work$/m);
});

test('buildEnvContent: 省略 workDir 时保持 WORK_DIR= 空（默认 $HOME）', () => {
  const tpl = 'AUTH_TOKEN=\nWORK_DIR=\n';
  const out = buildEnvContent(tpl, { authToken: 'x' });
  assert.match(out, /^WORK_DIR=$/m);
});

test('buildEnvContent: 只替换首个匹配行、不重复注入', () => {
  const tpl = '# AUTH_TOKEN 说明\nAUTH_TOKEN=\n';
  const out = buildEnvContent(tpl, { authToken: 'tok' });
  assert.match(out, /^AUTH_TOKEN=tok$/m);
  assert.match(out, /^# AUTH_TOKEN 说明$/m); // 注释行不被当成赋值行改掉
});

// ── 非交互模式（编程 agent 代装用）─────────────────────────────
// 背景实证：无 TTY 时 stdin 立刻 EOF → rl.question 的 promise 永不 settle → 进程静默退出 0、
// .env 一个字没写，却已经先打印过「✓ 已生成 AUTH_TOKEN（已写入 .env）」。agent 照这个输出
// 判定必然误报成功。故非交互路径必须由参数完整表达意图，且危险默认一律不许静默生效。

test('parseSetupArgs: --env 支持空格与等号两种写法', () => {
  assert.equal(parseSetupArgs(['--env', '/tmp/a/.env']).envPath, '/tmp/a/.env');
  assert.equal(parseSetupArgs(['--env=/tmp/b/.env']).envPath, '/tmp/b/.env');
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
