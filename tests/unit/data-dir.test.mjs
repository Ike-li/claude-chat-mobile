// tests/unit/data-dir.test.mjs —— CCM_DATA_DIR 状态隔离单测
// 守卫的不变量：设了 CCM_DATA_DIR，则 server/devices/sessions 的所有状态文件落在该目录，
// **绝不写真实 data/**。这是 E2E 与生产 data/ 解耦的硬约束——生产常驻 server 正读写 data/，
// 测试一旦漏隔离就污染线上会话/设备审批状态。
//
// devices.js/sessions.js 在模块初始化时即读 env 并锚定路径，故用动态 import 在 before() 设 env 后再加载。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = import.meta.dirname;
const REAL_DATA = join(HERE, '..', '..', 'data');     // 生产真实 data/，整个测试不许碰
const TEST_TOKEN = 'ccm-datadir-test-token-ZZZ-勿入生产';  // 生产 data/ 里绝不会有的哨兵 token

let TMP, D, S;

// ★ preload-env 在【进程启动时】设的数据根。必须在模块顶层捕获——下面 describe 的 before
// 会把 process.env.CCM_DATA_DIR 改成它自己的临时目录。
const PRELOAD_DATA_DIR = process.env.CCM_DATA_DIR;
const REPO_ROOT = join(HERE, '..', '..');

// 为什么单列一条，而不是并进下面那个 describe：
// 下面守的是【被测代码的行为】——设了 CCM_DATA_DIR，状态文件就落在那儿。
// 这一条守的是【测试基建的行为】——有没有替所有单测把它设上。
// 两者的失效方式不同且互不遮蔽：代码完全正确、而 preload-env 少了那一行时，
// 下面整个 describe 照常全绿，与此同时每个单测都在写真实 data/。
test('preload-env 把数据根收进一次性目录（缺了它，所有单测默认写真实 data/）', () => {
  assert.ok(PRELOAD_DATA_DIR,
    'preload-env 必须设 CCM_DATA_DIR：不设则 resolveDataDir() 回落到仓库根的真实 data/，'
    + '而文件级 CCM_*_FILE 白名单只点名了 6 个文件，其余（sessions/init-cache/push-subscription/'
    + 'cf-access-certs/service-*/uploads/worktree-settings）全裸');
  assert.ok(!resolve(PRELOAD_DATA_DIR).startsWith(resolve(REPO_ROOT)),
    `数据根落在仓库内，等于没隔离：${PRELOAD_DATA_DIR}`);
});


test.describe('CCM_DATA_DIR 状态隔离', () => {
  test.before(async () => {
    TMP = mkdtempSync(join(tmpdir(), 'ccm-datadir-test-'));
    process.env.CCM_DATA_DIR = TMP;
    delete process.env.CCM_SESSIONS_FILE; // 确保走 CCM_DATA_DIR 回退而非独立覆盖
    delete process.env.CCM_TRUSTED_DEVICES_FILE; // 同理：验证 CCM_DATA_DIR 隔离本身，设备文件须走 CCM_DATA_DIR 回退
    delete process.env.CCM_PENDING_DEVICES_FILE;
    delete process.env.CCM_DEVICE_PROFILES_FILE; // 同理：approveDevice 现在会写 profiles，不删就落到 preload 那份共享临时文件、本文件守的隔离出现无声的洞
    D = await import('../../app/src/auth/devices.js');
    S = await import('../../app/src/sessions/sessions.js');
  });

  test.after(() => {
    delete process.env.CCM_DATA_DIR;
    if (TMP) rmSync(TMP, { recursive: true, force: true });
  });

  test('devices: addPendingDevice 写入 CCM_DATA_DIR/pending-devices.json', () => {
    D.addPendingDevice(TEST_TOKEN, { ip: '1.2.3.4', userAgent: 'e2e-test' });
    assert.ok(existsSync(join(TMP, 'pending-devices.json')), 'pending 文件应落在 TMP');
    assert.ok(readFileSync(join(TMP, 'pending-devices.json'), 'utf8').includes(TEST_TOKEN));
  });

  test('devices: approveDevice 写入 CCM_DATA_DIR/trusted-devices.json', () => {
    D.approveDevice(TEST_TOKEN);
    assert.ok(existsSync(join(TMP, 'trusted-devices.json')), 'trusted 文件应落在 TMP');
    assert.equal(D.isDeviceTrusted(TEST_TOKEN), true);
  });

  test('sessions: CCM_DATA_DIR 回退（未设 CCM_SESSIONS_FILE）写入 CCM_DATA_DIR/sessions.json', () => {
    S.upsertSession({ id: 'datadir-sess-1', title: 'e2e', cwd: '/proj/e2e', model: null });
    S.flushSaveSync(); // 防抖异步写 → 强制同步落盘后再断言
    assert.ok(existsSync(join(TMP, 'sessions.json')), 'sessions 文件应落在 TMP');
    assert.ok(readFileSync(join(TMP, 'sessions.json'), 'utf8').includes('datadir-sess-1'));
  });

  // ── 隔离铁证：测试数据绝不泄漏到生产 data/（不依赖 mtime，因生产 server 可能并发写）──
  test('隔离铁证：哨兵 token 不出现在真实 data/trusted-devices.json', () => {
    const realFile = join(REAL_DATA, 'trusted-devices.json');
    if (existsSync(realFile)) {
      assert.ok(
        !readFileSync(realFile, 'utf8').includes(TEST_TOKEN),
        '❌ 测试 token 泄漏到生产 data/trusted-devices.json —— CCM_DATA_DIR 隔离失败！'
      );
    }
  });

  test('隔离铁证：哨兵 token 不出现在真实 data/pending-devices.json', () => {
    const realFile = join(REAL_DATA, 'pending-devices.json');
    if (existsSync(realFile)) {
      assert.ok(
        !readFileSync(realFile, 'utf8').includes(TEST_TOKEN),
        '❌ 测试 token 泄漏到生产 data/pending-devices.json —— CCM_DATA_DIR 隔离失败！'
      );
    }
  });

  test('隔离铁证：测试会话 id 不出现在真实 data/sessions.json', () => {
    const realFile = join(REAL_DATA, 'sessions.json');
    if (existsSync(realFile)) {
      assert.ok(
        !readFileSync(realFile, 'utf8').includes('datadir-sess-1'),
        '❌ 测试会话泄漏到生产 data/sessions.json —— CCM_DATA_DIR 隔离失败！'
      );
    }
  });
});
