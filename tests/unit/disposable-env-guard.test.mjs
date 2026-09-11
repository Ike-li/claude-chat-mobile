// tests/unit/disposable-env-guard.test.mjs —— 执行位守卫的判据表与真实拦截行为
//
// 【为什么判据要单独测，而不是「跑一次容器跑一次宿主机」就算验过】
// 那两次只覆盖判据表的两个格子。真正会出事的是【第三个格子】：CI 跑在裸 ubuntu-latest 上
// （.github/workflows/test.yml 的 invariants:server / invariants:env 两步都不带 container:），
// 判错它 = 守卫把 CI 全打红，而那是合法执行位。这一档没法用真跑验——在开发机上把
// GITHUB_ACTIONS 打开再跑那个文件，等于真的执行破坏性测试，正是守卫要拦的事。
//
// 【不测什么】守卫挡不住「有人删掉那行 import」——它和被守的测试住同一个仓库。
// 那一类归 check 链的接线完整性检查（铺开时接），不归本文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveExecutionSlot, BYPASS_VAR } from '../setup/disposable-env.mjs';

const GUARD = fileURLToPath(new URL('../setup/require-disposable-env.mjs', import.meta.url));

/** 在干净环境里跑一次守卫入口（不加载任何被测模块，所以本身零破坏性）。 */
function runGuard(env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import ${JSON.stringify(GUARD)}`], {
    encoding: 'utf8',
    // 显式给全环境：继承 process.env 会把宿主机真实的 CI/GITHUB_ACTIONS 带进来，
    // 那样断言测的就是「跑测试的这台机器」而不是判据本身。
    env: { PATH: process.env.PATH, ...env },
  });
}

test.describe('判据表：哪些执行位算一次性环境', () => {
  test('容器（/.dockerenv 存在）→ 放行', () => {
    assert.deepEqual(resolveExecutionSlot({ env: {}, hasDockerEnv: true }), { ok: true, slot: 'container' });
  });

  test('GitHub Actions 的一次性 runner → 放行（不带 container: 也合法）', () => {
    assert.deepEqual(resolveExecutionSlot({ env: { GITHUB_ACTIONS: 'true' }, hasDockerEnv: false }),
      { ok: true, slot: 'ci' });
  });

  test('开发机（三个条件都不成立）→ 拒绝', () => {
    assert.deepEqual(resolveExecutionSlot({ env: {}, hasDockerEnv: false }), { ok: false, slot: 'host' });
  });

  test('显式后门 → 放行，但 slot 标成 bypass（调用方据此打警告）', () => {
    assert.deepEqual(resolveExecutionSlot({ env: { [BYPASS_VAR]: '1' }, hasDockerEnv: false }),
      { ok: true, slot: 'bypass' });
  });

  // ★ 这条是判据表里最容易写错的一格：`CI=true npm test` 是在开发机上模拟 CI 的常见写法。
  // 若把 CI 当执行位判据，任何人 export 一次就把守卫永久关掉了，而且毫无提示。
  test('CI=true 但不是 GitHub Actions → 仍然拒绝（本机模拟 CI 不是一次性环境）', () => {
    assert.deepEqual(resolveExecutionSlot({ env: { CI: 'true' }, hasDockerEnv: false }),
      { ok: false, slot: 'host' });
  });

  // fail-closed：判据只认确切取值，模糊取值一律归「不安全」。
  test('GITHUB_ACTIONS 的非 "true" 取值一律拒绝', () => {
    for (const v of ['false', '1', 'TRUE', '', undefined]) {
      assert.equal(resolveExecutionSlot({ env: { GITHUB_ACTIONS: v }, hasDockerEnv: false }).ok, false,
        `GITHUB_ACTIONS=${JSON.stringify(v)} 不该放行`);
    }
  });

  test('后门只认字面 "1"：写成 true/yes/on 都不算数', () => {
    for (const v of ['true', 'yes', 'on', '0', '']) {
      assert.equal(resolveExecutionSlot({ env: { [BYPASS_VAR]: v }, hasDockerEnv: false }).ok, false,
        `${BYPASS_VAR}=${JSON.stringify(v)} 不该放行`);
    }
  });

  // hasDockerEnv 由调用方 catch 成 boolean；非 true 的任何值都不该被当成「在容器里」。
  test('hasDockerEnv 非严格 true（undefined/字符串）不算容器', () => {
    for (const v of [undefined, null, 'yes', 1]) {
      assert.equal(resolveExecutionSlot({ env: {}, hasDockerEnv: v }).ok, false,
        `hasDockerEnv=${JSON.stringify(v)} 不该放行`);
    }
  });
});

test.describe('入口的真实行为：import 它就会拦', () => {
  test('开发机上 import 守卫 → 进程以 1 退出，且说清改跑什么', () => {
    const r = runGuard({});
    assert.equal(r.status, 1, `必须非 0 退出，否则 npm/CI 认不出失败：${r.stderr}`);
    assert.match(r.stderr, /只能在一次性环境里跑/);
    assert.match(r.stderr, /test:docker/, '拒绝信息必须给出可直接照抄的替代命令');
  });

  test('GitHub Actions 环境下 import 守卫 → 放行且静默（CI 不会被这道守卫打红）', () => {
    const r = runGuard({ GITHUB_ACTIONS: 'true' });
    assert.equal(r.status, 0, `CI 是合法执行位，必须放行：${r.stderr}`);
    assert.equal(r.stderr, '', 'CI 上不该有噪音输出');
  });

  test('走后门 → 放行，但 stderr 必须留下警告（后门不能安静）', () => {
    const r = runGuard({ [BYPASS_VAR]: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, new RegExp(BYPASS_VAR), '放行也要指名是哪个后门开的');
    assert.match(r.stderr, /开发机/);
  });
});
