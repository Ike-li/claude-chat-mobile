// tests/unit/devices.test.mjs —— 设备信任表的状态机（DEVICE-02 的存储侧）
// 覆盖：pending 增删与最新优先排序 · 批准/拒绝 · pending 容量上限（防随机指纹刷盘）
//       · persistTrustedChange 落盘成功才提交（BE-011）——写盘失败返回 null 而不是谎报成功，
//         原集合也不得被就地修改，否则内存与磁盘会分叉
//       · 旁挂 device-profiles.json 的故障隔离两侧：profiles 写失败【不得】判败准入；
//         信任表写失败时 profile【不得】被剔除。两条的正确方向都是「不拒绝 / 不删除」，
//         按「异常一律拒绝」写会把它们测反
// 门禁接线与 socket 失权在 tests/invariants/device-gate.test.mjs 与 server/device-gate.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, unlinkSync, rmdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// 导入 devices 函数
import {
  loadTrustedDevices,
  loadPendingDevices,
  isDeviceTrusted,
  addPendingDevice,
  removePendingDevice,
  getPendingDevices,
  getLatestPendingDevice,
  approveDevice,
  denyDevice,
  persistTrustedChange,
  getTrustedDeviceProfiles,
  shortDeviceId,
  resolveShortDeviceId,
  decideRevokeByShortId,
  MAX_PENDING_DEVICES
} from '../../app/src/auth/devices.js';

// 路径
const HERE = import.meta.dirname;
// TC-001：优先用 preload 注入的 CCM_*_DEVICES_FILE（临时目录），回退真实 data/——与 devices.js 同源，
// 保证测试断言/备份的路径 = 模块实际写入路径，且 npm test 下彻底不碰生产 data/。
const TRUSTED_DEVICES_FILE = process.env.CCM_TRUSTED_DEVICES_FILE || join(HERE, '..', '..', 'data', 'trusted-devices.json');
const PENDING_DEVICES_FILE = process.env.CCM_PENDING_DEVICES_FILE || join(HERE, '..', '..', 'data', 'pending-devices.json');
const DEVICE_PROFILES_FILE = process.env.CCM_DEVICE_PROFILES_FILE || join(HERE, '..', '..', 'data', 'device-profiles.json');

// ★ 结构性护栏：没有 preload 注入时【拒绝运行】，而不是静默操作生产文件。
//
// 上面那个 `||` 回退是本仓唯一一处「测试路径可能落在生产 data/ 上」的地方，而本文件随后会
// renameSync 它做备份/还原。隔离此前完全依赖 `--import ./tests/setup/preload-env.mjs` 被带上——
// 那是调用方的习惯，不是结构保证。一句 `node --test tests/unit/devices.test.mjs` 就绕过了它：
// 真实的 data/trusted-devices.json 被 rename 走，中途中断则只剩 .bak，
// 表现为所有已批准设备集体失权、而且没有任何报错说明发生了什么。
//
// 判据锚在「路径是不是被注入的」而不是「路径长什么样」：注入即视为隔离环境，
// 未注入则一律拒绝，不去猜某个具体路径安不安全。
if (!process.env.CCM_TRUSTED_DEVICES_FILE || !process.env.CCM_PENDING_DEVICES_FILE
  || !process.env.CCM_DEVICE_PROFILES_FILE) {
  throw new Error(
    '[devices.test.mjs] 拒绝在未隔离的环境下运行：CCM_TRUSTED_DEVICES_FILE / CCM_PENDING_DEVICES_FILE'
    + ' / CCM_DEVICE_PROFILES_FILE 未注入，'
    + '本文件会 rename 这两个路径，未注入时它们指向生产 data/。\n'
    + '请用 `npm run test:unit`（已带 --import ./tests/setup/preload-env.mjs），'
    + '或自行注入这两个环境变量指向一次性目录。',
  );
}

const TRUSTED_BACKUP = TRUSTED_DEVICES_FILE + '.bak';
const PENDING_BACKUP = PENDING_DEVICES_FILE + '.bak';
const PROFILES_BACKUP = DEVICE_PROFILES_FILE + '.bak';

test.describe('devices.js 单元测试', () => {
  // 备份原有数据
  test.before(() => {
    mkdirSync(dirname(TRUSTED_DEVICES_FILE), { recursive: true }); // 隔离目录（preload 临时）或回退真实 data/
    if (existsSync(TRUSTED_DEVICES_FILE)) {
      renameSync(TRUSTED_DEVICES_FILE, TRUSTED_BACKUP);
    }
    if (existsSync(PENDING_DEVICES_FILE)) {
      renameSync(PENDING_DEVICES_FILE, PENDING_BACKUP);
    }
    if (existsSync(DEVICE_PROFILES_FILE)) {
      renameSync(DEVICE_PROFILES_FILE, PROFILES_BACKUP);
    }
  });

  // 恢复原有数据
  test.after(() => {
    // 删掉测试残留
    if (existsSync(TRUSTED_DEVICES_FILE)) {
      try { unlinkSync(TRUSTED_DEVICES_FILE); } catch {}
    }
    if (existsSync(PENDING_DEVICES_FILE)) {
      try { unlinkSync(PENDING_DEVICES_FILE); } catch {}
    }
    if (existsSync(DEVICE_PROFILES_FILE)) {
      try { unlinkSync(DEVICE_PROFILES_FILE); } catch {}
    }

    if (existsSync(TRUSTED_BACKUP)) {
      renameSync(TRUSTED_BACKUP, TRUSTED_DEVICES_FILE);
    }
    if (existsSync(PENDING_BACKUP)) {
      renameSync(PENDING_BACKUP, PENDING_DEVICES_FILE);
    }
    if (existsSync(PROFILES_BACKUP)) {
      renameSync(PROFILES_BACKUP, DEVICE_PROFILES_FILE);
    }
  });

  test('初始化状态：未授权，待处理列表为空', () => {
    // 强制重新加载以使用刚刚建立的干净空环境
    loadTrustedDevices();
    loadPendingDevices();

    assert.equal(isDeviceTrusted('non-existent-device'), false);
    assert.deepEqual(getPendingDevices(), []);
    assert.equal(getLatestPendingDevice(), null);
  });

  test('添加待审批设备并获取最新设备', () => {
    addPendingDevice('device-1', { ip: '192.168.1.100', userAgent: 'iPhone' });
    
    const pending = getPendingDevices();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].deviceToken, 'device-1');
    assert.equal(pending[0].ip, '192.168.1.100');
    assert.equal(pending[0].userAgent, 'iPhone');
    assert.ok(pending[0].ts > 0);
    
    assert.equal(getLatestPendingDevice(), 'device-1');
    assert.equal(isDeviceTrusted('device-1'), false);
  });

  test('添加多个待审批设备，保持最新排在前面', () => {
    addPendingDevice('device-2', { ip: '192.168.1.200', userAgent: 'iPad' });
    
    const pending = getPendingDevices();
    assert.equal(pending.length, 2);
    assert.equal(pending[0].deviceToken, 'device-2'); // 排序后最新在最前面
    assert.equal(getLatestPendingDevice(), 'device-2');
  });

  test('批准待审批设备', () => {
    const ok = approveDevice('device-2');
    assert.equal(ok, true);

    // 检查是否已被加入受信任列表
    assert.equal(isDeviceTrusted('device-2'), true);
    assert.equal(isDeviceTrusted('device-1'), false);

    // 检查是否已被移出待审批
    const pending = getPendingDevices();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].deviceToken, 'device-1');
    assert.equal(getLatestPendingDevice(), 'device-1');
  });

  test('拒绝并移除设备', () => {
    // 拒绝未批准的 pending 设备
    const ok1 = denyDevice('device-1');
    assert.equal(ok1, true);
    assert.equal(getPendingDevices().length, 0);
    assert.equal(getLatestPendingDevice(), null);

    // 拒绝已批准的 trusted 设备
    const ok2 = denyDevice('device-2');
    assert.equal(ok2, true);
    assert.equal(isDeviceTrusted('device-2'), false);
  });

  test('处理边缘无效输入安全', () => {
    assert.equal(isDeviceTrusted(null), false);
    assert.equal(isDeviceTrusted(undefined), false);
    assert.equal(isDeviceTrusted(''), false);

    addPendingDevice(null, { ip: '1.1.1.1' });
    assert.equal(getPendingDevices().length, 0);

    assert.equal(approveDevice(null), false);
    assert.equal(denyDevice(null), false);
  });

  // F1（code-review #5）：pendingDevices 有容量上限，防 LAN-authenticated flood 撑爆文件/刷屏。
  test('pendingDevices 有容量上限，超出丢最旧（防 flood）', () => {
    loadPendingDevices();
    for (const d of getPendingDevices()) removePendingDevice(d.deviceToken); // 清干净
    assert.equal(getPendingDevices().length, 0);

    const N = MAX_PENDING_DEVICES + 5;
    for (let i = 0; i < N; i++) addPendingDevice(`flood-${i}`, { ip: '10.0.0.1', userAgent: 'x' });

    const pending = getPendingDevices();
    assert.equal(pending.length, MAX_PENDING_DEVICES, '超上限被裁到 MAX');
    assert.equal(pending.some(d => d.deviceToken === 'flood-0'), false, '最早插入的被丢');
    assert.equal(pending.some(d => d.deviceToken === `flood-${N - 1}`), true, '最新的保留');

    for (const d of getPendingDevices()) removePendingDevice(d.deviceToken); // 清理
    assert.equal(getPendingDevices().length, 0);
  });
});

// BE-011：吊销/批准的持久化失败必须可观测——落盘失败时不得把变更提交到内存、更不得谎报成功
// （isDeviceTrusted 每次重读磁盘，谎报成功会让被吊销设备下次检查复活）。纯函数，注入 fake persist，不碰文件系统。
test.describe('persistTrustedChange（BE-011：落盘成功才提交变更）', () => {
  test('persist 成功 → 返回应用了变更的新集合，原集合不被就地修改', () => {
    const cur = new Set(['a', 'b']);
    const next = persistTrustedChange(cur, s => s.delete('a'), () => true);
    assert.ok(next instanceof Set);
    assert.equal(next.has('a'), false);
    assert.equal(next.has('b'), true);
    assert.equal(cur.has('a'), true, '原集合不被就地修改（在副本上变更）');
  });

  test('persist 返回 false → 返回 null（变更未提交，调用方据此报失败、不谎报）', () => {
    const cur = new Set(['a']);
    const next = persistTrustedChange(cur, s => s.delete('a'), () => false);
    assert.equal(next, null);
    assert.equal(cur.has('a'), true, '落盘失败原集合保持不变');
  });

  test('persist 抛错（EACCES/ENOSPC 等）→ 返回 null，视为落盘失败不提交', () => {
    const cur = new Set(['a']);
    const next = persistTrustedChange(cur, s => s.add('b'), () => { throw new Error('EACCES'); });
    assert.equal(next, null);
  });

  test('add 变更同理：persist 成功才含新成员', () => {
    const next = persistTrustedChange(new Set(), s => s.add('x'), () => true);
    assert.equal(next.has('x'), true);
  });

  // ── 旁挂展示元数据 device-profiles.json ────────────────────────────────────
  // 准入判决的事实源只有 trusted-devices.json；profiles 丢了只退化成裸 ID。
  // 下面两条守的正是这个立场的【两个方向】，而它们的正确答案都不是「拒绝」。
  //
  // 注入手法：把目标路径占成一个目录。writeOwnerOnlyFile 是 tmp + rename 原子写，
  // renameSync(普通文件, 目录) 在 POSIX 上必然 EISDIR（本机实测）。这是真实的 I/O 失败，
  // 不是把内部模块 mock 掉——被测的正是"写真的失败了会怎样"。
  test.describe('device-profiles.json（展示元数据旁挂）', () => {
    test('批准后记下 UA / IP / 批准时间，取自待审记录而非调用方', () => {
      addPendingDevice('device-p1', { ip: '192.168.1.77', userAgent: 'iPhone' });
      assert.equal(approveDevice('device-p1'), true);

      const row = getTrustedDeviceProfiles().find(d => d.deviceId === 'device-p1');
      assert.ok(row, '已信任设备必须出现在列表里');
      assert.equal(row.ua, 'iPhone');
      assert.equal(row.ip, '192.168.1.77');
      assert.ok(row.approvedAt > 0);

      assert.equal(denyDevice('device-p1'), true);
      assert.equal(getTrustedDeviceProfiles().some(d => d.deviceId === 'device-p1'), false,
        '吊销后条目必须一起消失');
    });

    test('待审记录缺失时以 null 落条目，不抛错、不阻断审批', () => {
      // 直调（无 pending 记录）——单测与预置设备走的就是这条路
      assert.equal(approveDevice('device-p2'), true);
      const row = getTrustedDeviceProfiles().find(d => d.deviceId === 'device-p2');
      assert.deepEqual([row.ua, row.ip], [null, null]);
      assert.ok(row.approvedAt > 0, '批准时间总是知道的');
      denyDevice('device-p2');
    });

    test('BE-011：profiles 写盘失败【不得】把 approveDevice 判为失败', () => {
      addPendingDevice('device-p3', { ip: '10.0.0.3', userAgent: 'iPad' });
      const saved = existsSync(DEVICE_PROFILES_FILE) ? readFileSync(DEVICE_PROFILES_FILE, 'utf8') : null;
      if (saved !== null) unlinkSync(DEVICE_PROFILES_FILE);
      mkdirSync(DEVICE_PROFILES_FILE); // 占成目录 → writeOwnerOnlyFile 的 rename 必 EISDIR
      try {
        assert.equal(approveDevice('device-p3'), true,
          '信任表已落盘、准入已生效——用展示层的写失败去否定它，等于让面板故障能踢掉设备');
        assert.equal(isDeviceTrusted('device-p3'), true);
      } finally {
        rmdirSync(DEVICE_PROFILES_FILE);
        if (saved !== null) writeFileSync(DEVICE_PROFILES_FILE, saved);
        denyDevice('device-p3');
      }
    });

    test('信任表写盘失败时 profile【不得】被剔除（否则留下一台匿名幽灵设备）', () => {
      addPendingDevice('device-p4', { ip: '10.0.0.4', userAgent: 'Android' });
      approveDevice('device-p4');
      assert.equal(getTrustedDeviceProfiles().find(d => d.deviceId === 'device-p4').ua, 'Android');

      const saved = readFileSync(TRUSTED_DEVICES_FILE, 'utf8');
      unlinkSync(TRUSTED_DEVICES_FILE);
      mkdirSync(TRUSTED_DEVICES_FILE); // 让 writeTrustedSet 的 rename EISDIR
      try {
        assert.equal(denyDevice('device-p4'), false, '信任表没落盘就不得谎报吊销成功');
      } finally {
        rmdirSync(TRUSTED_DEVICES_FILE);
        writeFileSync(TRUSTED_DEVICES_FILE, saved);
      }

      assert.equal(getTrustedDeviceProfiles().find(d => d.deviceId === 'device-p4')?.ua, 'Android',
        '吊销没生效，元数据就必须还在——先删 profile 会造出一台查不出来路的设备');
      denyDevice('device-p4');
    });

    test('展示以信任表为准做左连接：profiles 里的孤儿条目被忽略', () => {
      approveDevice('device-p5');
      // 手工塞一条不在信任表里的（模拟手改信任表 / 从备份恢复后的残留）
      const raw = JSON.parse(readFileSync(DEVICE_PROFILES_FILE, 'utf8'));
      raw['orphan-token-not-trusted'] = { ua: 'Ghost', ip: '1.1.1.1', approvedAt: 1 };
      writeFileSync(DEVICE_PROFILES_FILE, JSON.stringify(raw));

      const ids = getTrustedDeviceProfiles().map(d => d.deviceId);
      assert.equal(ids.includes('device-p5'), true);
      assert.equal(ids.includes('orphan-token-not-trusted'), false, '孤儿不该被展示出来');
      denyDevice('device-p5');
    });
  });

  // ── 短 ID：三份实现（后端 / 浏览器 logic / Swift）共用的判据 ────────────────
  test.describe('shortDeviceId 与 resolveShortDeviceId', () => {
    const FULL = 'a3f21b09c4d5e6f7a8b9c0d1e2f3a4b5'; // 32 位

    test('32 位截成 前8…后4；不超过 16 位的原样返回', () => {
      assert.equal(shortDeviceId(FULL), 'a3f21b09\u2026a4b5');
      assert.equal(shortDeviceId('0123456789abcdef'), '0123456789abcdef', '恰好 16 位不截（与 Swift 的 count > 16 同判据）');
      assert.equal(shortDeviceId('0123456789abcdef0'), '01234567\u2026def0', '17 位才开始截');
      assert.equal(shortDeviceId(''), '');
      assert.equal(shortDeviceId(null), '');
    });

    test('反查：恰好 1 命中才返回，0 命中与多命中一律 null', () => {
      const other = 'ffffffffffffffffffffffffffffffff';
      assert.equal(resolveShortDeviceId(shortDeviceId(FULL), [FULL, other]), FULL);
      assert.equal(resolveShortDeviceId('deadbeef\u20260000', [FULL, other]), null, '0 命中');

      // 多命中：构造两个前 8 后 4 相同、中间不同的 token。下游是吊销，猜错等于吊错设备。
      const twinA = 'a3f21b09' + '1111111111111111' + 'a4b5';
      const twinB = 'a3f21b09' + '2222222222222222' + 'a4b5';
      assert.equal(shortDeviceId(twinA), shortDeviceId(twinB), '前置条件：这两个短 ID 确实相同');
      assert.equal(resolveShortDeviceId(shortDeviceId(twinA), [twinA, twinB]), null, '多命中必须拒绝，不得任选一条');
    });

    test('非法输入不炸', () => {
      assert.equal(resolveShortDeviceId(null, [FULL]), null);
      assert.equal(resolveShortDeviceId('x', null), null);
    });
  });

  // ── Web 吊销的准入判定（纯函数，不碰 socket）────────────────────────────────
  // 三个出口各自对应一种「不能吊」的理由，调用方要能按理由给不同文案：
  // 「找不到」多半是列表过期，「就是你自己」则必须拦住——Web 上这一项是一键可达的，
  // 而 denyDevice 之后 disconnectDeviceSockets 是无条件执行的：吊销自己会当场把自己踢下线，
  // 若那是当时唯一在线的可信端，就只能回到电脑前（TTY / CLI / 菜单栏 / 本机直连）才能重批。
  test.describe('decideRevokeByShortId', () => {
    const ME = 'aaaaaaaa' + '0'.repeat(20) + 'mine';
    const OTHER = 'bbbbbbbb' + '0'.repeat(20) + 'othr';
    const ids = [ME, OTHER];

    test('命中别人 → 放行，返回全量 token', () => {
      const r = decideRevokeByShortId({ shortId: shortDeviceId(OTHER), requesterToken: ME, trustedIds: ids });
      assert.deepEqual(r, { ok: true, token: OTHER });
    });

    test('命中自己 → 拒绝，理由 self', () => {
      const r = decideRevokeByShortId({ shortId: shortDeviceId(ME), requesterToken: ME, trustedIds: ids });
      assert.deepEqual(r, { ok: false, reason: 'self' });
    });

    test('0 命中 → 拒绝，理由 not_found', () => {
      assert.deepEqual(
        decideRevokeByShortId({ shortId: 'deadbeef…9999', requesterToken: ME, trustedIds: ids }),
        { ok: false, reason: 'not_found' });
    });

    test('多命中 → 拒绝（走 not_found，绝不任选一条）', () => {
      const twinA = 'cccccccc' + '1'.repeat(20) + 'twin';
      const twinB = 'cccccccc' + '2'.repeat(20) + 'twin';
      assert.equal(shortDeviceId(twinA), shortDeviceId(twinB), '前置条件：两个短 ID 确实撞了');
      assert.deepEqual(
        decideRevokeByShortId({ shortId: shortDeviceId(twinA), requesterToken: ME, trustedIds: [twinA, twinB] }),
        { ok: false, reason: 'not_found' });
    });

    test('请求方没有 deviceToken（本机直连 / CF Access 走 bypass）时不误判成 self', () => {
      // bypass 连接的 handshake 里可以完全没有 deviceToken。若拿 undefined 去比，
      // 任何 profile 缺失的条目都可能被判成「就是你自己」而拒绝——那会让这类连接吊不动任何设备。
      const r = decideRevokeByShortId({ shortId: shortDeviceId(OTHER), requesterToken: undefined, trustedIds: ids });
      assert.deepEqual(r, { ok: true, token: OTHER });
    });
  });
});
