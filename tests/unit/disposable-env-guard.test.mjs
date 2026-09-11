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
import { existsSync } from 'node:fs';
import { resolveExecutionSlot, formatRefusal, formatBypassWarning, BYPASS_VAR } from '../setup/disposable-env.mjs';

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

test.describe('入口的真实行为：import 它就会按判据行事', () => {
  // 【为什么这两条要自适应，而不是写死「必须 exit 1」】/.dockerenv 是文件系统状态，runGuard
  // 注入不掉。写死「开发机」假设的话，同一条用例在 npm run test:docker 里必红——而容器里
  // 跑单测是常规路径（test:docker 第一档就是 test:unit）。所以断言的是【入口的行为与判据一致】：
  // 开发机上验拒绝路径，容器/CI 上验放行路径，两边都在验真实的 spawn 行为，没有一边是 skip。
  // 判据表本身的全部组合由上面那个 describe 覆盖，与执行位无关。
  const hereHasDockerEnv = existsSync('/.dockerenv');

  test('退出码与判据一致；拒绝时必须说清改跑什么，放行时必须安静', () => {
    const expected = resolveExecutionSlot({ env: {}, hasDockerEnv: hereHasDockerEnv });
    const r = runGuard({});
    assert.equal(r.status, expected.ok ? 0 : 1,
      `执行位判为 ${expected.slot}，入口却以 ${r.status} 退出：${r.stderr}`);
    if (expected.ok) {
      assert.equal(r.stderr, '', '合法执行位不该有噪音输出');
    } else {
      assert.match(r.stderr, /只能在一次性环境里跑/);
      assert.match(r.stderr, /test:docker/, '拒绝信息必须给出可直接照抄的替代命令');
    }
  });

  test('GitHub Actions 环境下放行且静默（CI 不会被这道守卫打红）', () => {
    const r = runGuard({ GITHUB_ACTIONS: 'true' });
    assert.equal(r.status, 0, `CI 是合法执行位，必须放行：${r.stderr}`);
    assert.equal(r.stderr, '');
  });

  test('走后门 → 放行', () => {
    assert.equal(runGuard({ [BYPASS_VAR]: '1' }).status, 0);
  });
});

// 文案是拒绝路径上唯一给人看的东西，但它在容器里 spawn 不出来（那边恒放行）。
// 拆成纯函数断言，任何执行位都验得到 —— 否则 test:docker 那一轮等于没测文案。
test.describe('文案', () => {
  test('拒绝信息点名了替代命令与后门变量', () => {
    const t = formatRefusal('x.test.mjs');
    assert.match(t, /x\.test\.mjs/, '必须点名是谁被拦了');
    assert.match(t, /test:docker/);
    assert.match(t, new RegExp(BYPASS_VAR));
  });

  test('后门警告点名是哪个变量开的，且说明真实家目录可写', () => {
    const t = formatBypassWarning('x.test.mjs');
    assert.match(t, new RegExp(BYPASS_VAR));
    assert.match(t, /开发机/);
  });
});
