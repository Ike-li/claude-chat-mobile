// tests/unit/smoke-runner.test.mjs —— 真 Claude 冒烟 runner 的准入约束（不跑真回合）
// 那批用例要花真 token，所以 runner 必须：需要显式点名场景（不许默认全跑）、
// 不硬编码模型名、复用与集成测试同一份环境隔离清单（少一件就可能写到真实 HOME）。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parseSmokeArgs, smokeEnv, smokeScenarioNames, stripInheritedEnv, SPAWN_ENV_BLOCKLIST } from '../smoke/runner.js';

const SCENARIO_DIR = join(import.meta.dirname, '..', 'smoke', 'scenarios');

test('real Claude smoke runner requires an explicit list, scenario, or all action', () => {
  assert.deepEqual(parseSmokeArgs(['--list']), { action: 'list', names: [], model: null });
  assert.deepEqual(parseSmokeArgs(['--scenario', 'core']), { action: 'run', names: ['core'], model: null });
  assert.deepEqual(parseSmokeArgs(['--all', '--model', 'mimo-v2.5']), {
    action: 'run',
    names: smokeScenarioNames(),
    model: 'mimo-v2.5',
  });
  assert.throws(() => parseSmokeArgs([]), /--list/);
  assert.throws(() => parseSmokeArgs(['--scenario', 'missing']), /Unknown smoke scenario/);
});

test('real Claude smoke scenarios do not hard-code the historical shared work directory', () => {
  const dir = join(import.meta.dirname, '..', 'smoke', 'scenarios');
  const names = readdirSync(dir);
  // 扫描面塌了不是"没有违规"：目录被改名/搬空/清空时上面的 for 循环一次都不执行，
  // 断言从未被调用过，测试照样绿——同 gate-wiring.test.mjs:40 的既有护栏写法。
  assert.ok(names.length > 0, `${dir} 下扫不到任何 scenario 文件，扫描面塌了`);
  for (const name of names) {
    const source = readFileSync(join(dir, name), 'utf8');
    assert.doesNotMatch(source, /\/tmp\/ccm-test/, `${name} must use runner-provided WORK_DIR`);
  }
});

// runner 与 scenario 之间的约定只有环境变量这一条线，而 scenario 只在花真 token 时才跑——约定断了
// 没有任何零 token 的东西会红。2026-09-08 WORK_DIR 退役（f1a06950）后 runner 不再传它，读它的 5 个
// scenario 一启动就抛，到 09-23 真机验证才被发现。所以在这里静态对账：scenario 读的每个变量，
// 要么在 runner 给的环境里，要么是调用方可选透传的旋钮。
const OPTIONAL_SCENARIO_ENV = new Set([
  'ANTHROPIC_MODEL', // 两个权限场景的模型覆盖（不设就用 CLI 默认）
  'CLAUDE_BIN',      // slash-command 直接调 SDK 时的 CLI 路径（不设就 which claude）
  'DEBUG_SERVER',    // concurrency 自起 server 时是否把 server 输出打到终端
]);

test('scenario 读的环境变量都由 runner 提供（或是显式列出的可选旋钮）', () => {
  const provided = new Set(Object.keys(smokeEnv({ root: '/tmp/ccm-smoke-x', port: 1 }, {})));
  const names = readdirSync(SCENARIO_DIR);
  let reads = 0;
  for (const name of names) {
    const source = readFileSync(join(SCENARIO_DIR, name), 'utf8');
    for (const [, key] of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      reads++;
      assert.ok(
        provided.has(key) || OPTIONAL_SCENARIO_ENV.has(key),
        `${name} 读 process.env.${key}，但 runner 不提供它——这个场景在真跑时会拿到 undefined`,
      );
    }
  }
  // 扫描面塌了不是"没有违规"：正则或目录一变，循环一次都不执行，测试照样绿。
  assert.ok(reads > 0, `${SCENARIO_DIR} 下没扫到任何 process.env 读取，扫描面塌了`);
});

// runner 在仓库根起 server，server 默认读 cwd 下的 ccm.config.json / .env——维护者的生产配置就在
// 那里。环境变量摘得再干净，文件照样把 DEVICE_APPROVAL_SCOPE=all 之类补回来（loadRuntimeEnvironment
// 只填 env 里没有的键）。容器那边靠把 /work/ccm.config.json 清空解决，冒烟在宿主机上跑，不能动那份文件。
test('runner 起的 server 不读仓库根的配置文件：两个配置路径都指进本场景的一次性目录', () => {
  const root = '/tmp/ccm-smoke-x';
  const env = smokeEnv({ root, port: 1 }, {});
  for (const key of ['CCM_CONFIG_FILE_PATH', 'CCM_ENV_FILE_PATH']) {
    assert.ok(env[key]?.startsWith(`${root}/`), `${key} 必须落在一次性目录里，实际 ${env[key]}`);
  }
});

// smoke 侧只需确认它确实接上了共享清单；清单本身的行为由 tests/unit/spawn-env.test.mjs 覆盖。
test('runner 复用共享的环境隔离清单（与集成测同一份）', async () => {
  const shared = await import('../helpers/spawn-env.mjs');
  assert.equal(SPAWN_ENV_BLOCKLIST, shared.SPAWN_ENV_BLOCKLIST, '必须是同一个对象，不能各写一份');
  assert.equal(stripInheritedEnv, shared.stripInheritedEnv);
});
