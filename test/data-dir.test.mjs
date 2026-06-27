// test/data-dir.test.mjs —— CCM_DATA_DIR 状态隔离单测
// 守卫的不变量：设了 CCM_DATA_DIR，则 server/devices/sessions 的所有状态文件落在该目录，
// **绝不写真实 data/**。这是 E2E 与生产 data/ 解耦的硬约束——生产常驻 server 正读写 data/，
// 测试一旦漏隔离就污染线上会话/设备审批状态。
//
// devices.js/sessions.js 在模块初始化时即读 env 并锚定路径，故用动态 import 在 before() 设 env 后再加载。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = import.meta.dirname;
const REAL_DATA = join(HERE, '..', 'data');           // 生产真实 data/，整个测试不许碰
const TEST_TOKEN = 'ccm-datadir-test-token-ZZZ-勿入生产';  // 生产 data/ 里绝不会有的哨兵 token

let TMP, D, S;

test.describe('CCM_DATA_DIR 状态隔离', () => {
  test.before(async () => {
    TMP = mkdtempSync(join(tmpdir(), 'ccm-datadir-test-'));
    process.env.CCM_DATA_DIR = TMP;
    delete process.env.CCM_SESSIONS_FILE; // 确保走 CCM_DATA_DIR 回退而非独立覆盖
    D = await import('../devices.js');
    S = await import('../sessions.js');
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
