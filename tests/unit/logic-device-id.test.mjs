// tests/unit/logic-device-id.test.mjs —— 本机设备指纹的短形式（纯函数，浏览器与 node 共用）
// 语义红线：截断规则必须与另两份实现【逐字一致】——app/src/auth/devices.js 的 shortDeviceId
// （服务端下发信任列表时算的那份）与 desktop/CCMCore.swift 的 shortDeviceId（菜单栏那份）。
// 三份对不上，用户就没法拿手机上这串跟菜单/面板上那串核对，而核对是这个功能存在的唯一理由。
//
// 与后端那份的【逐字节对照】不在本文件，在 tests/unit/cross-side-parity.test.mjs 的 PAIRS
// （那道闸会自动发现前后端同名 export，漏登记就红）。本文件只管这一侧的行为，
// 两处各写一份对照只会造出两份会漂的清单。
import test from 'node:test';
import assert from 'node:assert/strict';
import { shortDeviceId, formatRelativeApprovedAt } from '../../app/public/js/logic/device-id.js';
import { setLang } from '../../app/public/js/i18n.js';

const FULL = '0123456789abcdef0123456789abcdef'; // 32 位，与 app.js 生成的形状一致（16 字节 hex）

test.describe('shortDeviceId', () => {
  test('32 位截成 前8…后4', () => {
    assert.equal(shortDeviceId(FULL), '01234567…cdef');
  });

  test('恰好 16 位不截，17 位才开始截（与 Swift 的 count > 16 同判据）', () => {
    assert.equal(shortDeviceId('0123456789abcdef'), '0123456789abcdef');
    assert.equal(shortDeviceId('0123456789abcdef0'), '01234567…def0');
  });

  test('空 / 非字符串返回空串，由调用方决定怎么显示', () => {
    assert.equal(shortDeviceId(''), '');
    assert.equal(shortDeviceId(null), '');
    assert.equal(shortDeviceId(undefined), '');
    assert.equal(shortDeviceId(123), '');
  });
});

// 批准时间怎么显示。**相对天数而不是绝对时间戳**：这一行要回答的是「这台我还在用吗」，
// 绝对时间还得人自己做减法。与 desktop/CCMCore.swift 的 approvedAtLabel 互为镜像
// （同一批边界，跨语言没法 import 对方，只能两边各写一份同样的断言）。
test.describe('formatRelativeApprovedAt', () => {
  const NOW = 1_800_000_000_000; // 固定 now，否则断言会随运行日期漂：跑一次绿、下周再跑就红
  const DAY = 86_400_000;

  test('没有批准记录时如实说，不编时间', () => {
    assert.equal(formatRelativeApprovedAt(null, NOW), '无批准记录');
    assert.equal(formatRelativeApprovedAt(0, NOW), '无批准记录');
    assert.equal(formatRelativeApprovedAt(undefined, NOW), '无批准记录');
  });

  test('按天分档：今天 / 昨天 / N 天前 / N 个月前', () => {
    assert.equal(formatRelativeApprovedAt(NOW - 3_600_000, NOW), '今天批准');
    assert.equal(formatRelativeApprovedAt(NOW - DAY * 1.2, NOW), '昨天批准');
    assert.equal(formatRelativeApprovedAt(NOW - DAY * 5, NOW), '5 天前批准');
    assert.equal(formatRelativeApprovedAt(NOW - DAY * 95, NOW), '3 个月前批准');
  });

  test('时钟回拨造出的未来时间不显示成负数天', () => {
    assert.equal(formatRelativeApprovedAt(NOW + DAY, NOW), '今天批准');
  });

  // 设备列表那一行直接显示返回值。此前这里写死中文、没走 t()，英文界面的设备列表整列都是中文；
  // 词典里其实早有「今天批准」三条译文，只是没人用上（「N 天前 / N 个月前」连译文都没有）。
  test('英文界面下每一档都是英文', t => {
    setLang('en');
    t.after(() => setLang('zh'));
    assert.equal(formatRelativeApprovedAt(null, NOW), 'No approval record');
    assert.equal(formatRelativeApprovedAt(NOW - 3_600_000, NOW), 'Approved today');
    assert.equal(formatRelativeApprovedAt(NOW - DAY * 1.2, NOW), 'Approved yesterday');
    assert.equal(formatRelativeApprovedAt(NOW - DAY * 5, NOW), 'Approved 5 day(s) ago');
    assert.equal(formatRelativeApprovedAt(NOW - DAY * 95, NOW), 'Approved 3 month(s) ago');
  });
});
