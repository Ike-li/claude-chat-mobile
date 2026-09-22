// tests/unit/check-container-config-isolation.test.mjs —— 容器配置隔离闸自身
// 覆盖：扫描面为空必须报错（不是"全部合规"）；仓库根卷挂载判据按路径归一化比较，
// 不再只认字面量 '../..'——等价但字面不同的写法（'../../'、'./../..'、逐子目录挂载）同样要被抓住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkContainerConfigIsolation } from '../../tests/gates/check-container-config-isolation.js';

async function makeInfraDir(compose) {
  const root = await mkdtemp(join(tmpdir(), 'ccm-container-isolation-'));
  await mkdir(root, { recursive: true });
  if (compose !== null) await writeFile(join(root, 'docker-compose.test.yml'), compose);
  return root;
}

test('扫描面为空（目录里没有任何 docker-compose*.yml）→ 报错，不是"全部合规"', async t => {
  const root = await makeInfraDir(null);
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = checkContainerConfigIsolation({ infraDir: root });

  assert.equal(result.scanned, 0);
  assert.ok(result.violations.length > 0, '扫描面塌了必须报违规，不能悄悄判过');
  assert.match(result.violations[0], /扫描面塌了/);
});

test('working_dir 挂了仓库根 —— 字面量 "../.." 仍然被抓住（重构后不得回归）', async t => {
  const root = await makeInfraDir([
    'services:',
    '  test:',
    '    working_dir: /repo',
    '    volumes:',
    '      - ../..:/repo:ro',
    '    entrypoint:',
    '      sh -c "echo no-clear"',
  ].join('\n'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = checkContainerConfigIsolation({ infraDir: root });

  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /working_dir/);
});

test('仓库根挂载写成等价但字面不同的形式（"../../"，多一个斜杠）→ 同样被抓住', async t => {
  const root = await makeInfraDir([
    'services:',
    '  test:',
    '    working_dir: /repo',
    '    volumes:',
    '      - ../../:/repo:ro',
    '    entrypoint:',
    '      sh -c "echo no-clear"',
  ].join('\n'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = checkContainerConfigIsolation({ infraDir: root });

  assert.equal(result.violations.length, 1, '"../../" 与 "../.." 指向同一个仓库根，必须同样被判定为仓库根挂载');
  assert.match(result.violations[0], /working_dir/);
});

test('仓库根挂载写成中间多一层 "./" 的形式（"./../.."）→ 同样被抓住', async t => {
  const root = await makeInfraDir([
    'services:',
    '  test:',
    '    working_dir: /repo',
    '    volumes:',
    '      - ./../..:/repo:ro',
    '    entrypoint:',
    '      sh -c "echo no-clear"',
  ].join('\n'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = checkContainerConfigIsolation({ infraDir: root });

  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /working_dir/);
});

test('仓库根挂载不落在 working_dir、entrypoint 也清空了配置 → 合规，不报违规', async t => {
  const root = await makeInfraDir([
    'services:',
    '  test:',
    '    working_dir: /app',
    '    volumes:',
    '      - ../..:/repo:ro',
    '    entrypoint:',
    '      sh -c "printf \'{}\' > /app/ccm.config.json && exec node app/server.js"',
  ].join('\n'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = checkContainerConfigIsolation({ infraDir: root });

  assert.deepEqual(result.violations, []);
  assert.equal(result.guarded, 1);
});

test('挂载目标以 /ccm.config.json 结尾（覆盖挂载）→ 报违规（规则 C，路径归一化改动不应影响）', async t => {
  const root = await makeInfraDir([
    'services:',
    '  test:',
    '    volumes:',
    '      - ./fixture.json:/app/ccm.config.json:ro',
  ].join('\n'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = checkContainerConfigIsolation({ infraDir: root });

  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /virtiofs/);
});

test('非仓库根的普通相对路径挂载（如 "./fixture"）→ 不触发仓库根判据', async t => {
  const root = await makeInfraDir([
    'services:',
    '  test:',
    '    working_dir: /app',
    '    volumes:',
    '      - ./fixture:/app/fixture:ro',
  ].join('\n'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = checkContainerConfigIsolation({ infraDir: root });

  assert.deepEqual(result.violations, []);
  assert.equal(result.guarded, 0);
});
