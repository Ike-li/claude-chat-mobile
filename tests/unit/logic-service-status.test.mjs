// tests/unit/logic-service-status.test.mjs —— 服务状态面板纯函数单测（零 DOM/零 token）。
// 面板三段：基础(formatUptime/serviceStatusBasicRows) + 指标(serviceMetricsRows) + 告警(复用 formatServiceNotices)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUptime, serviceStatusBasicRows, serviceMetricsRows, formatServiceNotices } from '../../public/js/logic.js';

test.describe('formatUptime：运行时长分档', () => {
  test('非法/负 → 空串（接线层据此显「未知」）', () => {
    assert.equal(formatUptime(), '');
    assert.equal(formatUptime(null), '');
    assert.equal(formatUptime(NaN), '');
    assert.equal(formatUptime(-1), '');
    assert.equal(formatUptime('120'), '');
  });
  test('秒/分钟/小时+分/天+小时 各档', () => {
    assert.equal(formatUptime(0), '0 秒');
    assert.equal(formatUptime(59_000), '59 秒');
    assert.equal(formatUptime(61_000), '1 分钟');
    assert.equal(formatUptime(59 * 60_000), '59 分钟');
    assert.equal(formatUptime(90 * 60_000), '1 小时 30 分');
    assert.equal(formatUptime(25 * 3_600_000), '1 天 1 小时');
    assert.equal(formatUptime(3 * 86_400_000 + 14 * 3_600_000), '3 天 14 小时');
  });
});

test.describe('serviceStatusBasicRows：基础段四行', () => {
  const now = Date.UTC(2026, 6, 17, 12, 0, 0); // 固定 now，避免真实时钟
  const startedAt = now - 26 * 60_000;
  const base = { startedAt, versions: { server: '1.2.1', cli: '2.1.193', sdk: '0.3.201' }, connected: true, rttMs: 42, now };

  test('四行齐全：运行时长/启动于/版本/连接', () => {
    const rows = serviceStatusBasicRows(base);
    assert.deepEqual(rows.map(r => r.label), ['运行时长', '启动于', '版本', '连接']);
    assert.equal(rows[0].value, '26 分钟');
    assert.match(rows[1].value, /\d{1,2}\/\d{1,2} \d{2}:\d{2}/); // 本地时区，形如 7/17 12:00
    assert.equal(rows[2].value, 'server 1.2.1 · CLI 2.1.193 · SDK 0.3.201');
    assert.equal(rows[3].value, '已连接 · 延迟 42ms');
  });
  test('versions 缺字段 → unknown 占位；整个缺 → 三个 unknown', () => {
    const rows = serviceStatusBasicRows({ ...base, versions: { cli: '2.1.193' } });
    assert.equal(rows[2].value, 'server unknown · CLI 2.1.193 · SDK unknown');
    const rows2 = serviceStatusBasicRows({ ...base, versions: null });
    assert.equal(rows2[2].value, 'server unknown · CLI unknown · SDK unknown');
  });
  test('未连接 → 「未连接」且不含延迟；rttMs 非法 → 只显「已连接」', () => {
    assert.equal(serviceStatusBasicRows({ ...base, connected: false })[3].value, '未连接');
    assert.equal(serviceStatusBasicRows({ ...base, rttMs: null })[3].value, '已连接');
  });
  test('startedAt 非法 → 时长/启动于均「未知」', () => {
    const rows = serviceStatusBasicRows({ ...base, startedAt: undefined });
    assert.equal(rows[0].value, '未知');
    assert.equal(rows[1].value, '未知');
  });
  test('logging 存在 → 第五行「日志开关」；SDK 调试开着才标 alert（忘关事故观测点）', () => {
    const rows = serviceStatusBasicRows({ ...base, logging: { interactions: true, sdkDebug: false, stderr: true } });
    assert.equal(rows.length, 5);
    assert.equal(rows[4].label, '日志开关');
    assert.equal(rows[4].value, '交互日志 开 · SDK 调试 关 · stderr 开');
    assert.equal(rows[4].alert, false);
    const hot = serviceStatusBasicRows({ ...base, logging: { interactions: false, sdkDebug: true, stderr: false } });
    assert.equal(hot[4].value, '交互日志 关 · SDK 调试 开 · stderr 关');
    assert.equal(hot[4].alert, true);
  });
  test('logging 缺席（旧 server ack）→ 维持四行优雅缺席', () => {
    assert.equal(serviceStatusBasicRows(base).length, 4);
    assert.equal(serviceStatusBasicRows({ ...base, logging: null }).length, 4);
  });
});

test.describe('serviceMetricsRows：指标段九行固定顺序', () => {
  const full = { activeSessions: 2, events: 1841, catchUpHits: 12, catchUpReloads: 1, rateLimitLockouts: 0, pushSuccess: 57, pushFailure: 3, ntfyFailure: 0, clientErrors: 0 };

  test('九行固定顺序 + 中文 label + 数值透传', () => {
    const rows = serviceMetricsRows(full);
    assert.deepEqual(rows.map(r => r.key), ['activeSessions', 'events', 'catchUpHits', 'catchUpReloads', 'rateLimitLockouts', 'pushSuccess', 'pushFailure', 'ntfyFailure', 'clientErrors']);
    assert.deepEqual(rows.map(r => r.label), ['活跃会话', '事件总数', '断线补发命中', '补发降级重载', '限速锁定', '推送成功', '推送失败', 'ntfy 失败', '前端错误']);
    assert.deepEqual(rows.map(r => r.value), [2, 1841, 12, 1, 0, 57, 3, 0, 0]);
  });
  test('失败/锁定类 >0 才标 alert（接线层据此标红），成功类不标', () => {
    const rows = serviceMetricsRows({ ...full, clientErrors: 2 });
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
    assert.equal(byKey.pushFailure.alert, true);
    assert.equal(byKey.clientErrors.alert, true); // 前端错误 >0 标红：手机端唯一可见性入口
    assert.equal(byKey.ntfyFailure.alert, false); // 值为 0 不标
    assert.equal(byKey.rateLimitLockouts.alert, false);
    assert.equal(byKey.events.alert, false); // 非失败类，1841 也不标
    assert.equal(byKey.activeSessions.alert, false);
  });
  test('缺字段/非数 → 0；非对象入参 → 全 0（旧 server 无 clientErrors 也走这条显 0）', () => {
    const rows = serviceMetricsRows({ activeSessions: '3', events: NaN });
    assert.deepEqual(rows.map(r => r.value), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(serviceMetricsRows(null).map(r => r.value), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(serviceMetricsRows().map(r => r.value), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

test.describe('告警段复用 formatServiceNotices（ack 形状入参）', () => {
  test('无失败无重启 → 空数组（接线层渲染「无异常」）', () => {
    assert.deepEqual(formatServiceNotices({ service: { deliveryFailure: null }, restartChanged: false, now: 1000 }), []);
  });
  test('重启 + 投递失败 → 两行，文案与抽屉一致', () => {
    const now = 100 * 60_000;
    const notices = formatServiceNotices({ service: { deliveryFailure: { channel: 'push', at: now - 18 * 60_000, count: 3 } }, restartChanged: true, now });
    assert.equal(notices.length, 2);
    assert.match(notices[0], /^🔄 服务自上次连接后已重启/);
    assert.equal(notices[1], '🔔 推送最近失败于 18 分钟前（push，累计 3 次）');
  });
});
