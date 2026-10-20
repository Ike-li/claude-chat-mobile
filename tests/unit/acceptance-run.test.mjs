// tests/unit/acceptance-run.test.mjs —— 验收入口 run.mjs 的命令行契约与执行位判据
// 契约：node tests/acceptance/run.mjs [--check] [--list] [--tier A|B|C|D|E[,…]] [--cases AC-01-01,…] [--changed <git-ref>]
//   不带 --tier 只选 A；C（真模型）必须显式写出来。
// 档位语法刻意收窄（只认大写、只许写一次、不认 -t 简写）：不认识的写法一律拒绝，不猜意图。
// C 档 run.mjs 只列清单不执行，额度闸在起 E3 那一步（env/up.mjs，钩子 guard-host-tests.js 请人确认）。
// A 档跑完对照 Playwright 的 JSON 报告：选中了却没跑到的编号要红，不能因为「没匹配上」就报绿。
// 执行位方向与 tests/setup/disposable-env.mjs 相反：那边只许在一次性环境跑，这边只许在机主本机跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handoffNotice, missingReplays, parseArgs, refusalReason, runTimestamp } from '../../tests/acceptance/run.mjs';

const RUN = fileURLToPath(new URL('../acceptance/run.mjs', import.meta.url));

test('不带 --tier 时只选 A', () => {
  assert.deepEqual(parseArgs([]).tiers, ['A']);
  assert.deepEqual(parseArgs(['--list']).tiers, ['A']);
});

test('--tier 认空格与等号两种写法、逗号列表', () => {
  assert.deepEqual(parseArgs(['--tier', 'C']).tiers, ['C']);
  assert.deepEqual(parseArgs(['--tier=A,C']).tiers, ['A', 'C']);
  assert.deepEqual(parseArgs(['--tier', 'B,D,E']).tiers, ['B', 'D', 'E']);
});

test('--tier 的非法写法一律拒绝：小写、多字母、空值、写两次、-t 简写', () => {
  for (const argv of [
    ['--tier', 'c'], ['--tier', 'CC'], ['--tier=AC'], ['--tier', ''], ['--tier'],
    ['--tier', 'A', '--tier', 'C'], ['-t', 'C'], ['--tier', 'A,,C'],
  ]) {
    assert.throws(() => parseArgs(argv), undefined, `应拒绝 ${JSON.stringify(argv)}`);
  }
});

test('--cases 只认 AC-NN-NN 列表；--changed 必须带 ref；未知参数拒绝', () => {
  assert.deepEqual(parseArgs(['--cases', 'AC-01-01,AC-02-13']).ids, ['AC-01-01', 'AC-02-13']);
  assert.throws(() => parseArgs(['--cases', 'AC-1-1']));
  assert.equal(parseArgs(['--changed', 'origin/dev']).changed, 'origin/dev');
  assert.throws(() => parseArgs(['--changed']));
  assert.throws(() => parseArgs(['--changed', '--list']), undefined, '--changed 后面紧跟另一个参数，说明 ref 漏写了');
  assert.throws(() => parseArgs(['--all']));
});

test('执行位：CI（GITHUB_ACTIONS 或任何 CI=…）与容器拒跑，机主本机放行', () => {
  assert.match(refusalReason({ env: { GITHUB_ACTIONS: 'true' }, hasDockerEnv: false }), /CI/);
  assert.match(refusalReason({ env: { CI: 'true' }, hasDockerEnv: false }), /CI/);
  assert.match(refusalReason({ env: { CI: '1' }, hasDockerEnv: false }), /CI/);
  assert.match(refusalReason({ env: {}, hasDockerEnv: true }), /容器/);
  assert.equal(refusalReason({ env: {}, hasDockerEnv: false }), null);
  assert.equal(refusalReason({ env: { CI: 'false' }, hasDockerEnv: false }), null);
  // 宿主机破坏性测试的后门不改变「这里是机主本机」这个事实
  assert.equal(refusalReason({ env: { CCM_ALLOW_HOST_DESTRUCTIVE_TESTS: '1' }, hasDockerEnv: false }), null);
});

// resolveExecutionSlot 先判容器：同时是 CI 又在容器里时它只报 container。这里要的是 CI 文案——
// 下一条用例在 Dockerfile.test 容器里跑时正是这个组合（容器 + 显式 GITHUB_ACTIONS=true）
test('执行位：CI 先于容器判，CI 里的容器报的是 CI', () => {
  assert.match(refusalReason({ env: { GITHUB_ACTIONS: 'true' }, hasDockerEnv: true }), /CI/);
  assert.doesNotMatch(refusalReason({ env: { GITHUB_ACTIONS: 'true' }, hasDockerEnv: true }), /容器/);
  assert.match(refusalReason({ env: { CI: 'true' }, hasDockerEnv: true }), /CI/);
});

test('入口真的接上了执行位判据：GITHUB_ACTIONS=true 时连 --list 都以 1 退出', () => {
  const r = spawnSync(process.execPath, [RUN, '--list'], {
    env: { PATH: process.env.PATH, GITHUB_ACTIONS: 'true' }, encoding: 'utf8',
  });
  assert.equal(r.status, 1, `应拒跑，实际退出码 ${r.status}；stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /⛔/);
  assert.match(r.stderr, /CI/);
});

// 额度闸在起 E3 那一步（env/up.mjs --env E3… --yes 由钩子请机主确认），不在 run.mjs：
// 它对 C 档只列清单，所以清单旁边必须说清「要先起 E3、起它要人点头」，否则 agent 不知道闸在哪
test('选中 C 档时提示由 skill 执行、先用 env/up.mjs 起用例要的 E3 系环境；没有 C 档时不提', () => {
  const c = (id, tier, env) => ({ id, tier, env, p: 'P1', t: '标题' });
  const notice = handoffNotice([c('AC-01-01', 'C', ['E3', 'E4']), c('AC-01-02', 'C', ['E3cf']), c('AC-02-01', 'B', ['E2'])]);
  assert.match(notice, /C 档 2 条由 skill 里的 agent 执行/);
  assert.match(notice, /node tests\/acceptance\/env\/up\.mjs --env E3,E3cf --yes/, '命令要点名这几条用例要的 E3 系环境，不多不少');
  assert.match(notice, /钩子会请机主确认/);
  assert.match(notice, /AC-01-01[\s\S]*AC-01-02[\s\S]*AC-02-01/, 'B–E 档清单照列');

  const noC = handoffNotice([c('AC-02-01', 'B', ['E2'])]);
  assert.match(noC, /AC-02-01/);
  assert.doesNotMatch(noC, /up\.mjs/, '没选 C 档时不该提起 E3');
  assert.equal(handoffNotice([]), '');
});

// 夹具按 Playwright json reporter 的真实形状写（node_modules/playwright/types/testReporter.d.ts 的 JSONReport*）：
// 顶层 suites 是文件，describe 是嵌套的 suites，spec.tests[].status 取 skipped / expected / unexpected / flaky。
// --grep 匹配的是整条标题路径，所以编号写在 describe 上也算
const spec = (title, status) => ({ title, ok: status !== 'unexpected', tags: [], id: title, file: 'd01.accept.ts', line: 1, column: 1,
  tests: [{ timeout: 60000, annotations: [], expectedStatus: status === 'skipped' ? 'skipped' : 'passed', projectId: 'p', projectName: 'p', results: [], status }] });
const REPORT = {
  config: {}, errors: [], stats: {},
  suites: [{
    title: 'd01.accept.ts', file: 'd01.accept.ts', line: 0, column: 0,
    specs: [spec('AC-01-01 通过的', 'expected'), spec('AC-01-02 失败的也算跑到了', 'unexpected'), spec('AC-01-03 被 skip 的', 'skipped')],
    suites: [{ title: 'AC-01-04 编号写在 describe 上', file: 'd01.accept.ts', line: 9, column: 1, specs: [spec('第一步', 'flaky')] }],
  }],
};

test('A 档跑完对照 JSON 报告：选中了却没跑到（没匹配上、被 skip）的编号列出来', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ccm-accept-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'replay.json');
  await writeFile(path, JSON.stringify(REPORT));
  const selected = ['AC-01-01', 'AC-01-02', 'AC-01-03', 'AC-01-04', 'AC-01-05'];
  assert.deepEqual(missingReplays(selected, path), { missing: ['AC-01-03', 'AC-01-05'], error: null });
  assert.deepEqual(missingReplays(['AC-01-01', 'AC-01-04'], path), { missing: [], error: null });
});

test('报告不存在或不是 JSON：一条都证明不了跑过，全部算没跑到', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ccm-accept-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const absent = missingReplays(['AC-01-01'], join(dir, 'replay.json'));
  assert.deepEqual(absent.missing, ['AC-01-01']);
  assert.match(absent.error, /replay\.json/);
  await writeFile(join(dir, 'broken.json'), '{');
  assert.deepEqual(missingReplays(['AC-01-01'], join(dir, 'broken.json')).missing, ['AC-01-01']);
});

test('运行目录名：UTC 时间戳，到秒，文件名安全', () => {
  assert.equal(runTimestamp(new Date('2026-10-18T17:05:09.123Z')), '2026-10-18T170509Z');
});
