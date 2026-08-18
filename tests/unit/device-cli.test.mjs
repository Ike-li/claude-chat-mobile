import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dirname, '..', '..');

// 每个用例一份一次性 CCM_DATA_DIR：device.js 直接读写 trusted/pending 两个 JSON，
// 共用目录会让"批准"跨用例串味。dataDir 来自 mkdtemp，recursive 删除可追溯。
async function withDataDir(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccm-device-cli-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function runCli(dataDir, args) {
  // preload-env 把 devices.js 的两个数据文件重定向到共享临时目录（TC-001），而在 devices.js 里
  // 这两个文件级变量【优先于】CCM_DATA_DIR。子进程继承它们的话，CLI 会写去 preload 那份共享文件，
  // 而断言读的是本用例的 dataDir——空的。这里跑的是真实 CLI 进程，要的就是生产形态：显式剥掉。
  const { CCM_TRUSTED_DEVICES_FILE: _t, CCM_PENDING_DEVICES_FILE: _p, ...env } = process.env;
  return spawnSync(process.execPath, ['scripts/device.js', ...args], {
    cwd: REPO,
    env: { ...env, CCM_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

const seedPending = (dataDir, list) =>
  writeFile(join(dataDir, 'pending-devices.json'), JSON.stringify(list));

test('device CLI reads trusted devices from CCM_DATA_DIR', async t => {
  const dataDir = await withDataDir(t);
  await writeFile(join(dataDir, 'trusted-devices.json'), JSON.stringify(['trusted-from-external-data-dir']));

  const result = runCli(dataDir, ['list']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /trusted-from-external-data-dir/);
});

// ── list --json：桌面端菜单栏的数据源 ───────────────────────────────────────
// 菜单栏 app 不能解析给人看的那版输出（含表情/缩进/中文标签，改文案就崩）。与 service.js
// 的 STATUS_SCHEMA_VERSION 同款契约：带 schemaVersion，Swift 侧据此判能否解析。
test.describe('device.js list --json', () => {
  test('输出机读 JSON：pending 用 deviceId 命名（与 socket 侧 pendingDevicesPayload 一致）', async t => {
    const dataDir = await withDataDir(t);
    await seedPending(dataDir, [{ deviceToken: 'tok-pending-1', ip: '192.168.1.5', userAgent: 'iPhone', ts: 1700000000000 }]);
    await writeFile(join(dataDir, 'trusted-devices.json'), JSON.stringify(['tok-trusted-1']));

    const r = runCli(dataDir, ['list', '--json']);
    assert.equal(r.status, 0, r.stderr);

    const out = JSON.parse(r.stdout);
    assert.equal(out.schemaVersion, 1);
    assert.deepEqual(out.pending, [{ deviceId: 'tok-pending-1', ip: '192.168.1.5', userAgent: 'iPhone', ts: 1700000000000 }]);
    assert.deepEqual(out.trusted, ['tok-trusted-1']);
  });

  test('空状态输出合法 JSON 的空数组，不是空串（Swift 侧解析不能靠特判）', async t => {
    const dataDir = await withDataDir(t);
    const r = runCli(dataDir, ['list', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.pending, []);
    assert.deepEqual(out.trusted, []);
  });

  test('--json 时 stdout 只有 JSON：混入人类文案会让 JSONDecoder 直接失败', async t => {
    const dataDir = await withDataDir(t);
    await seedPending(dataDir, [{ deviceToken: 'tok-1', ip: '10.0.0.2', userAgent: 'X', ts: 1 }]);
    const r = runCli(dataDir, ['list', '--json']);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout 应是纯 JSON，实际：${r.stdout}`);
  });
});

// ── approve / deny：此前一行未测，而这正是所有审批路径的公共底座 ──────────────
test.describe('device.js approve / deny', () => {
  test('approve 待审设备 → 退出 0，设备移入 trusted 且离开 pending', async t => {
    const dataDir = await withDataDir(t);
    await seedPending(dataDir, [{ deviceToken: 'tok-approve-me', ip: '10.0.0.9', userAgent: 'X', ts: 1 }]);

    const r = runCli(dataDir, ['approve', 'tok-approve-me']);
    assert.equal(r.status, 0, r.stderr);

    const trusted = JSON.parse(await readFile(join(dataDir, 'trusted-devices.json'), 'utf8'));
    const pending = JSON.parse(await readFile(join(dataDir, 'pending-devices.json'), 'utf8'));
    assert.deepEqual(trusted, ['tok-approve-me']);
    assert.deepEqual(pending, [], '批准后应移出待审列表，否则菜单里会留一张点不掉的卡片');
  });

  test('approve 不在待审列表的 ID → 退出 1 且不写信任表（防打错 ID 静默放行陌生 token）', async t => {
    const dataDir = await withDataDir(t);
    await seedPending(dataDir, [{ deviceToken: 'tok-real', ip: '10.0.0.9', userAgent: 'X', ts: 1 }]);

    const r = runCli(dataDir, ['approve', 'tok-typo']);
    assert.equal(r.status, 1, '应以非零码退出');

    const trusted = JSON.parse(await readFile(join(dataDir, 'trusted-devices.json'), 'utf8').catch(() => '[]'));
    assert.deepEqual(trusted, [], '未在待审列表的 token 绝不能进信任表');
  });

  test('approve 不带 ID → 退出 1', async t => {
    const dataDir = await withDataDir(t);
    assert.equal(runCli(dataDir, ['approve']).status, 1);
  });

  test('deny 已批准设备 → 退出 0 且移出信任表（吊销路径）', async t => {
    const dataDir = await withDataDir(t);
    await writeFile(join(dataDir, 'trusted-devices.json'), JSON.stringify(['tok-revoke-me', 'tok-keep']));

    const r = runCli(dataDir, ['deny', 'tok-revoke-me']);
    assert.equal(r.status, 0, r.stderr);

    const trusted = JSON.parse(await readFile(join(dataDir, 'trusted-devices.json'), 'utf8'));
    assert.deepEqual(trusted, ['tok-keep'], '只该移除目标设备，其余保留');
  });

  test('deny 不带 ID → 退出 1', async t => {
    const dataDir = await withDataDir(t);
    assert.equal(runCli(dataDir, ['deny']).status, 1);
  });
});
