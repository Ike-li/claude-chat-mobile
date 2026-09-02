// tests/unit/logic-service-status.test.mjs —— 服务状态面板纯函数单测（零 DOM/零 token）。
// 面板两段：基础(formatUptime/serviceStatusBasicRows) + 告警(复用 formatServiceNotices)。
// 裸计数器段已判定化撤除（serviceMetricsRows 删除）：原始计数留 /metrics 巡检端点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUptime, serviceStatusBasicRows, formatServiceNotices, formatHooksBridgeRow, describeRateLimitSource, formatAuditEntry } from '../../public/js/logic.js';

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

test.describe('告警段复用 formatServiceNotices（ack 形状入参）', () => {
  test('无失败 → 空数组（接线层渲染「无异常」）', () => {
    assert.deepEqual(formatServiceNotices({ service: { deliveryFailure: null }, now: 1000 }), []);
  });
  test('投递失败 → 一行，文案与抽屉一致', () => {
    const now = 100 * 60_000;
    const notices = formatServiceNotices({ service: { deliveryFailure: { channel: 'push', at: now - 18 * 60_000, count: 3 } }, now });
    assert.deepEqual(notices, ['🔔 推送最近失败于 18 分钟前（push，累计 3 次）']);
  });
  // reason 由后端 describeDeliveryError 清洗过（保证不含 endpoint URL），前端只负责拼上去。
  // 少了它，「推送失败」在 UI 上无从下钻——分不清是网络不通（改代理）还是 VAPID 配错（改配置）。
  test('投递失败带原因 → 追加在行尾', () => {
    const now = 100 * 60_000;
    assert.deepEqual(
      formatServiceNotices({ service: { deliveryFailure: { channel: 'push', at: now - 3 * 60 * 60_000, count: 6, reason: 'HTTP 502' } }, now }),
      ['🔔 推送最近失败于 3 小时前（push，累计 6 次）：HTTP 502']
    );
  });
  test('reason 缺席/空串（旧 server ack、或进程重启后 label 已清）→ 不留孤零零的冒号', () => {
    const now = 100 * 60_000;
    for (const reason of [undefined, null, '', '  ']) {
      assert.deepEqual(
        formatServiceNotices({ service: { deliveryFailure: { channel: 'push', at: now - 60_000, count: 1, reason } }, now }),
        ['🔔 推送最近失败于 1 分钟前（push，累计 1 次）'],
        String(reason)
      );
    }
  });
  // 来源缺席（旧 server ack）才回落到无条件的「可能有人在暴力尝试」——带 source 时按来源分叉，见下一个 describe。
  test('限速锁定且来源未知 → ⛔ 行：多久之前 + 累计次数 + 保守措辞', () => {
    const now = 100 * 60_000;
    assert.deepEqual(
      formatServiceNotices({ service: { rateLimitLockout: { at: now - 42 * 60_000, count: 2 } }, now }),
      ['⛔ 登录限速锁定于 42 分钟前（累计 2 次）——可能有人在暴力尝试你的入口']
    );
  });
  test('前端错误 → 🐞 行：多久之前 + 累计次数 + 指向日志面板', () => {
    const now = 100 * 60_000;
    assert.deepEqual(
      formatServiceNotices({ service: { clientError: { at: now - 3 * 60_000, count: 5 } }, now }),
      ['🐞 前端错误发生于 3 分钟前（累计 5 次），详见日志面板']
    );
  });
  test('count 缺失（防御性）→ 不显示累计后缀', () => {
    const now = 100 * 60_000;
    assert.deepEqual(
      formatServiceNotices({ service: { rateLimitLockout: { at: now - 60_000 } }, now }),
      ['⛔ 登录限速锁定于 1 分钟前——可能有人在暴力尝试你的入口']
    );
    assert.deepEqual(
      formatServiceNotices({ service: { clientError: { at: now - 60_000 } }, now }),
      ['🐞 前端错误发生于 1 分钟前，详见日志面板']
    );
  });
  test('全类命中 → 固定顺序：限速锁定 → 投递失败 → 前端错误', () => {
    const now = 100 * 60_000;
    const notices = formatServiceNotices({
      service: {
        deliveryFailure: { channel: 'ntfy', at: now - 1000, count: 1 },
        rateLimitLockout: { at: now - 2000, count: 1 },
        clientError: { at: now - 3000, count: 1 },
      },
      now,
    });
    assert.deepEqual(notices.map(l => [...l][0]), ['⛔', '🔔', '🐞']);
  });
  test('旧 server ack 无新字段 → 优雅缺席不报错', () => {
    assert.deepEqual(formatServiceNotices({ service: { deliveryFailure: null }, now: 1000 }), []);
    assert.deepEqual(formatServiceNotices({ service: {}, now: 1000 }), []);
  });
  test('at 非数（脏字段）→ 该行跳过', () => {
    assert.deepEqual(
      formatServiceNotices({ service: { rateLimitLockout: { at: 'bad', count: 1 }, clientError: { count: 2 } }, now: 1000 }),
      []
    );
  });
});

// ---- 限速来源画像（2026-09-02）----
// 起因：机主看到「⛔ 可能有人在暴力尝试你的入口」被吓到，翻 audit-records.json 才发现两次锁定的
// target 都是 ip:127.0.0.1 —— 本机自己的旧 token。那句话此前是无条件拼上去的，不看来源。
// 判据用限速桶 key（rlSourceKey 的产物：'ip:<桶>' / 'cfip:<桶>'），与后端计数用的是同一个值，
// 不另算一套「客户端 IP」。
test.describe('describeRateLimitSource：限速桶 key → 来源画像', () => {
  test('loopback → local', () => {
    assert.deepEqual(describeRateLimitSource('ip:127.0.0.1'), { scope: 'local', addr: '127.0.0.1' });
    assert.deepEqual(describeRateLimitSource('ip:::1'), { scope: 'local', addr: '::1' });
  });
  test('私网 / CGNAT / Tailscale 100.64/10 / IPv6 ULA·link-local → lan', () => {
    for (const [key, addr] of [
      ['ip:192.168.1.5', '192.168.1.5'], ['ip:10.0.0.9', '10.0.0.9'],
      ['ip:172.16.0.1', '172.16.0.1'], ['ip:172.31.255.1', '172.31.255.1'],
      ['ip:169.254.1.1', '169.254.1.1'], ['ip:100.101.7.3', '100.101.7.3'],
      ['ip:fd00:1:2:3::/64', 'fd00:1:2:3::/64'], ['ip:fe80::/64', 'fe80::/64'],
    ]) assert.deepEqual(describeRateLimitSource(key), { scope: 'lan', addr }, key);
  });
  test('公网 IPv4/IPv6 → public（IPv6 保留 /64 桶写法，那正是被限的粒度）', () => {
    assert.deepEqual(describeRateLimitSource('ip:203.0.113.7'), { scope: 'public', addr: '203.0.113.7' });
    assert.deepEqual(describeRateLimitSource('ip:2408:8207:1:2::/64'), { scope: 'public', addr: '2408:8207:1:2::/64' });
  });
  test('cfip: 前缀（CF 边缘注入的真实客户端 IP）同样剥前缀后判定', () => {
    assert.deepEqual(describeRateLimitSource('cfip:203.0.113.7'), { scope: 'public', addr: '203.0.113.7' });
  });
  test('172.15/172.32 是公网（私网段边界不能多吃）', () => {
    assert.equal(describeRateLimitSource('ip:172.15.0.1').scope, 'public');
    assert.equal(describeRateLimitSource('ip:172.32.0.1').scope, 'public');
    assert.equal(describeRateLimitSource('ip:100.63.0.1').scope, 'public');
    assert.equal(describeRateLimitSource('ip:100.128.0.1').scope, 'public');
  });
  test('缺席/空/纯前缀 → unknown（旧 server ack 无 source 字段）', () => {
    for (const v of [undefined, null, '', '   ', 'ip:', 'cfip:']) {
      assert.deepEqual(describeRateLimitSource(v), { scope: 'unknown', addr: '' }, String(v));
    }
  });
});

test.describe('限速告警文案按来源分叉（不再无条件说「有人在暴力尝试」）', () => {
  const now = 100 * 60_000;
  const line = source => formatServiceNotices({
    service: { rateLimitLockout: { at: now - 9 * 60_000, count: 1, source } }, now,
  })[0];

  test('本机 → 指出是本机，并给出最可能的原因（自己的旧 token）', () => {
    assert.equal(line('ip:127.0.0.1'), '⛔ 登录限速锁定于 9 分钟前（累计 1 次）——来自本机 127.0.0.1，多半是你自己的旧 token');
  });
  test('局域网 → 只陈述事实，不升级成安全事件', () => {
    assert.equal(line('ip:192.168.1.5'), '⛔ 登录限速锁定于 9 分钟前（累计 1 次）——来自局域网 192.168.1.5');
  });
  test('公网 → 保留告警措辞，并把 IP 写出来（这才是真该警觉的那一类）', () => {
    assert.equal(line('ip:203.0.113.7'), '⛔ 登录限速锁定于 9 分钟前（累计 1 次）——公网 203.0.113.7 在暴力尝试你的入口');
  });
});

// 「终端会话推送」段：唯一暴露 CLI hooks 桥安装态的界面（手机上没法跑 npm，这是唯一入口）。
// 旧 server 不带 hooksBridge 字段 → 整段优雅缺席，不显示误导性的"未安装"。
test('formatHooksBridgeRow：四态文案 + 按钮动作，旧 server 缺字段则不渲染', () => {
  assert.equal(formatHooksBridgeRow(undefined), null, '旧 server 无此字段 → 不渲染整段');
  assert.equal(formatHooksBridgeRow({ state: 'unknown' }), null, '读不出安装态 → 宁可不显示，也不误报未装');

  const off = formatHooksBridgeRow({ state: 'installed', off: true });
  assert.match(off.value, /已停用|off/i);
  assert.equal(off.action, null, '被 env 停用时不给按钮——改 .env 才是正确解法，点按钮解决不了');

  const installed = formatHooksBridgeRow({ state: 'installed' });
  assert.match(installed.value, /已启用/);
  assert.equal(installed.action, 'uninstall');
  assert.equal(installed.tone, 'ok');

  const missing = formatHooksBridgeRow({ state: 'not-installed' });
  assert.match(missing.value, /未启用/);
  assert.equal(missing.action, 'install');

  const drifted = formatHooksBridgeRow({ state: 'drifted' });
  assert.equal(drifted.tone, 'warn');
  assert.equal(drifted.action, null, '漂移时不给一键覆盖——用户自己动过配置，得他自己决断');
});

// ---- 安全日志段（2026-09-02）----
// 起因：审计记录自始就写在 data/audit-records.json（限速来源、设备批准/拒绝、越界访问…），
// 但整个 public/ 对 "audit" 零命中——web 端没有任何读取面。于是「⛔ 有人在暴力尝试你的入口」
// 这条告警在手机上无从下钻：既看不到是哪个 IP，也看不到历史上发生过几次、是不是同一个来源。
// 本函数把一条记录译成一行人话 + severity，接线层只管渲染。
test.describe('formatAuditEntry：审计记录 → 一行人话', () => {
  test('限速锁定：来源画像决定措辞与 severity（公网才是真警报）', () => {
    const pub = formatAuditEntry({ ts: 1, action: 'auth_rate_limited', target: 'ip:203.0.113.7', outcome: 'locked', meta: { via: 'http' } });
    assert.equal(pub.text, '登录限速锁定 · 公网 203.0.113.7 · http');
    assert.equal(pub.severity, 'danger');

    const local = formatAuditEntry({ ts: 1, action: 'auth_rate_limited', target: 'ip:127.0.0.1', outcome: 'locked', meta: { via: 'socket' } });
    assert.equal(local.text, '登录限速锁定 · 本机 127.0.0.1 · socket');
    assert.equal(local.severity, 'warning', '本机连试八次是手滑不是入侵，不配 danger');

    const lan = formatAuditEntry({ ts: 1, action: 'auth_rate_limited', target: 'ip:192.168.1.5', outcome: 'locked', meta: { via: 'http' } });
    assert.equal(lan.text, '登录限速锁定 · 局域网 192.168.1.5 · http');
    assert.equal(lan.severity, 'warning');
  });

  test('设备生命周期三态', () => {
    assert.equal(formatAuditEntry({ action: 'device_approved', target: 'abcdef1234567890', meta: { via: 'web' } }).text, '批准设备 abcdef12 · web');
    assert.equal(formatAuditEntry({ action: 'device_denied', target: 'abcdef1234567890', meta: { via: 'web' } }).text, '拒绝设备 abcdef12 · web');
    const revoked = formatAuditEntry({ action: 'device_revoked', target: 'abcdef1234567890' });
    assert.equal(revoked.text, '吊销设备 abcdef12');
    assert.equal(revoked.severity, 'warning');
  });

  test('越界访问 → danger（工作区范围门拦下的那一类）', () => {
    const r = formatAuditEntry({ action: 'scope_violation', target: '/etc/passwd', outcome: 'denied' });
    assert.equal(r.text, '越界访问被拒 · /etc/passwd');
    assert.equal(r.severity, 'danger');
  });

  test('审批完整性校验失败 → danger', () => {
    const r = formatAuditEntry({ action: 'approval_integrity_mismatch', target: 'req_88', outcome: 'denied', meta: { tool: 'Bash' } });
    assert.equal(r.text, '审批完整性校验失败 · req_88 · Bash');
    assert.equal(r.severity, 'danger');
  });

  test('配置修改 → warning，并列出键名（不含值）', () => {
    const r = formatAuditEntry({ action: 'env_changed', target: 'AUTH_TOKEN,PORT', meta: { keys: ['AUTH_TOKEN', 'PORT'] } });
    assert.equal(r.text, '修改配置 · AUTH_TOKEN,PORT');
    assert.equal(r.severity, 'warning');
  });

  test('中性事件：重启 / 永久删除会话 / 留存清理 / 文件写入', () => {
    assert.equal(formatAuditEntry({ action: 'server_restart', outcome: 'allowed', meta: { via: 'supervised' } }).text, '重启服务 · supervised');
    assert.equal(formatAuditEntry({ action: 'server_restart', outcome: 'denied', meta: { reason: 'not-supervised' } }).severity, 'warning');
    assert.equal(formatAuditEntry({ action: 'session_delete_l2', target: 'sess_1' }).text, '永久删除会话 sess_1');
    assert.equal(formatAuditEntry({ action: 'retention_cleanup' }).severity, 'neutral');
    assert.equal(formatAuditEntry({ action: 'file_write', target: '/a/b/c/notes.md' }).text, '写入文件 notes.md');
  });

  test('outcome 非成功 → 追加结果（同一个 action 成功与失败必须看得出区别）', () => {
    assert.equal(
      formatAuditEntry({ action: 'session_delete_l2', target: 'sess_1', outcome: 'partial_failure' }).text,
      '永久删除会话 sess_1（partial_failure）'
    );
  });

  test('未知 action → 兜底不吞掉（延续 formatDiagLogEntry 的原则）', () => {
    const r = formatAuditEntry({ ts: 7, action: 'brand_new_thing', target: 'x', outcome: 'allowed' });
    assert.match(r.text, /brand_new_thing/);
    assert.equal(r.severity, 'neutral');
  });

  test('ts 原样透传（接线层用它算「多久之前」）', () => {
    assert.equal(formatAuditEntry({ ts: 12345, action: 'retention_cleanup' }).ts, 12345);
  });

  test('空入参不抛', () => {
    assert.equal(typeof formatAuditEntry().text, 'string');
    assert.equal(typeof formatAuditEntry({}).text, 'string');
  });
});
