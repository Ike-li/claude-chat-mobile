// logic/device-id.js —— 本机设备指纹的短形式。数据进数据出，不碰 DOM/window/socket。

// 32 位 hex 在任何界面里都既放不下也读不出来，截成 `前8…后4`。
//
// ★ 同一判据有三份实现，跨语言 + 前后端禁止互相 import，合不了一份：
//   本文件（浏览器：显示"这台就是我"）、app/src/auth/devices.js（服务端：下发信任列表时算）、
//   desktop/CCMCore.swift（菜单栏那一列）。截断规则三份必须逐字一致——用户要拿手机上这串
//   跟菜单/面板上那串对上，对不上这个功能就等于没有。
//   前两份由 tests/unit/logic-device-id.test.mjs 直接比对钉住；Swift 那份靠同一批字面量。
//   唯一有意的差异：空串在 Swift 侧回落成「（无 ID）」占位，两份 JS 返回空串、由调用方决定怎么显示。
export function shortDeviceId(id) {
  if (typeof id !== 'string' || !id) return '';
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

// 批准时间 → 列表里那一小段。**相对天数而不是绝对时间戳**：这一行要回答的问题是
// 「这台是不是我早就不用了的那台」，绝对时间还得人自己做减法。
//
// ★ 与 desktop/CCMCore.swift 的 approvedAtLabel 互为镜像（跨语言没法共用，两边各写一份
//   同样的断言：本仓 tests/unit/logic-device-id.test.mjs 与 desktop/ccm-menubar-tests.swift）。
// ★ now 必须可注入，否则断言会随运行日期漂——跑一次绿、下周再跑就红。
// ms 为空/0 表示这条是【本功能上线之前】批准的：元数据只在批准那一刻记得下来，
// 事后无从补，所以如实说「无批准记录」而不是编一个时间。
export function formatRelativeApprovedAt(ms, now = Date.now()) {
  if (typeof ms !== 'number' || !(ms > 0)) return '无批准记录';
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return '今天批准';   // 含时钟回拨造出的负数
  if (days === 1) return '昨天批准';
  if (days < 30) return `${days} 天前批准`;
  return `${Math.floor(days / 30)} 个月前批准`;
}
