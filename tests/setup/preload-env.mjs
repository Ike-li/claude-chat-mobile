// tests/setup/preload-env.mjs —— node --test 的 --import 预加载脚本。
// 把几个"落盘路径由模块级常量在加载时锁定"的模块重定向到一次性临时目录，在它们被任何测试文件的
// 静态 import 求值前生效。
//
// 为什么需要这个而不是在测试文件里设环境变量：ESM 的静态 import 在模块链接阶段求值，早于该文件自身
// 任何顶层语句执行——哪怕把 `process.env.X = ...` 写在 `import` 语句上面，被 import 的模块（agent.js →
// approval-store.js、history.js 等）也已经先跑完模块顶层代码、锁定了落盘/扫盘路径。sessions.js/
// devices.js 至今没撞到这个坑是因为它们只被"动态 import"的测试文件（sessions.test.mjs）或"实测接受写
// 真实文件+备份还原"的测试文件（devices.test.mjs）用到；但 agent.js/history.js 被 tests/unit/*.test.mjs 大量
// 用例静态 import，若不在此处提前重定向，每次 npm test 都会污染真实文件。
// - CCM_APPROVAL_STORE_FILE / CCM_AUDIT_FILE（Phase 4）：否则堆进真实 data/*.json。
// - CCM_TRUSTED_DEVICES_FILE / CCM_PENDING_DEVICES_FILE（TC-001）：devices.test.mjs 直接 rename 真实
//   data/trusted-devices.json 做备份/还原，中断会留残留并触发生产 watcher；重定向到临时目录彻底隔离。
// 不碰 CCM_DATA_DIR——集成测试各自显式设置的 CCM_DATA_DIR 隔离方式不受影响（故用文件级覆盖而非目录级）。
// 注：transcript 目录（~/.claude/projects）不在此隔离——L2 删除走 SDK deleteSession 只认真实根，隔离
// 本模块的读只会和 SDK 的删分叉（见 history.js CLAUDE_DIR 注释）；session-delete 集成测试改用真实目录
// 下的一次性随机子目录 + before 扫清 + after 清理自保。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'ccm-test-data-'));

// ★ 把 TMPDIR 收进本进程的一次性目录，让所有测试文件的 mkdtemp 都落在它下面。
//
// 为什么需要这一层，而不是让每个测试文件自己清干净：多数文件【已经】有 before/after 里的 rmSync，
// 却照样漏——因为被测模块的异步/防抖落盘发生在 after 【之后】，其 mkdirSync(..., {recursive:true})
// 把刚删掉的目录重建出来（sessions.js 的 200ms 防抖是实证过的一例，见 tests/unit/sessions.test.mjs
// 的 after 注释）。逐个去找每个模块的 flush API 只能一次修一个，而下一个引入防抖写的模块又会漏。
// 把根收在这里，exit 时连根删——那时 JS 已不再执行，没有任何东西能再重建它。
//
// 路径仍在系统临时区下（只多一层），macOS 的 /var→/private/var 语义不变；
// 长度只增约 30 字节，本仓没有走 tmpdir() 的 unix socket（CLI 的 cc-socks 在 /tmp 下、不经这里）。
process.env.TMPDIR = join(dir, 'tmp');
mkdirSync(process.env.TMPDIR, { recursive: true });

// 退出时回收。本脚本在【每个测试子进程】里都跑一次（node --test 逐文件 fork），而此前只建不删：
// 2026-09-05 查出时 /tmp 下已攒了 9781 个 ccm-test-data-*，一次 npm run test:unit 就加 150+ 个。
// 无害但确实是泄漏，且与本仓「删除必须可追溯到一次性目录」的纪律方向相反——这里正好是最好追溯的
// 那一种：dir 就是上一行 mkdtemp 出来的，同文件同作用域。
//
// 用 'exit' 而不是 SIGINT/SIGTERM：它对正常结束与 process.exit()（--test-force-exit 走这条）都触发，
// 且只允许同步操作 —— rmSync 正好是同步的。被 SIGKILL 时收不到，那种情况留残留可以接受。
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true }); // safe-rm: 本文件上一行 mkdtemp 建的一次性目录
  } catch { /* 退出路径不抛：清理失败顶多留个空目录，不该把测试进程的退出码搞脏 */ }
});
// ★ 数据根收进一次性目录。
//
// 下面那几条 CCM_*_FILE 是【逐个文件点名】的白名单，只覆盖 6 个；而 data/ 下还有 sessions.json、
// init-cache.json、push-subscription.json、cf-access-certs.json、service-{events,install,snapshot}.json、
// uploads/、worktree-settings/ —— 它们此前全裸：2026-09-11 实测，单测环境里 resolveDataDir()
// 解析到的就是仓库根那个【真实 data/】。
//
// 没出事，是因为碰它们的测试各自记得自己设变量（sessions.test.mjs 设 CCM_SESSIONS_FILE、
// cf-access.test.mjs 设 CCM_DATA_DIR）。那是「每个调用点都要记得注入」，而那正是会失败的一步——
// 白名单漏一个文件、或新来一个模块开始写 data/，都不会有任何东西变红。收在这里之后，
// 新测试无论 import 什么、记不记得设变量，都够不到真实 data/。
//
// 【原先不设它的理由已过期】此前这里写「不碰 CCM_DATA_DIR——集成测试各自显式设置的 CCM_DATA_DIR
// 隔离方式不受影响（故用文件级覆盖而非目录级）」。两点都不再成立：
//   ① 测试文件自己设的值本就覆盖这里的缺省（env 后写覆盖先写），从来不冲突；
//   ② 集成测试现在由 tests/setup/require-disposable-env.mjs 强制进容器，容器里 data/ 本就是容器内的。
// 实测：加这一行后 4002 个单测 0 红。
//
// 文件级覆盖保留不删：它优先级更高，是第二层；而且 tests/unit/data-dir.test.mjs 要 delete 掉
// 那几条来验证「走 CCM_DATA_DIR 回退」这条路径，删了它就没有靶子了。
process.env.CCM_DATA_DIR = join(dir, 'data');
mkdirSync(process.env.CCM_DATA_DIR, { recursive: true });

process.env.CCM_APPROVAL_STORE_FILE = join(dir, 'approval-requests.json');
process.env.CCM_AUDIT_FILE = join(dir, 'audit-records.json');
process.env.CCM_TRUSTED_DEVICES_FILE = join(dir, 'trusted-devices.json');
process.env.CCM_PENDING_DEVICES_FILE = join(dir, 'pending-devices.json');
// CCM_DEVICE_PROFILES_FILE：设备展示元数据（旁挂）。同上——devices.test.mjs 也 rename 它做备份，
// 且 approveDevice/denyDevice 现在会写它，不重定向就会改真实 data/device-profiles.json。
process.env.CCM_DEVICE_PROFILES_FILE = join(dir, 'device-profiles.json');
// CCM_READ_STATE_FILE（2026-09-03 跨设备已读位点）：read-state.js 的默认实例在 import 时锁定路径，
// 任何静态 import 到 server/app.js 的用例一旦触发写入就会改真实 data/read-state.json——那是使用者
// 各设备共享的未读位点，被单测覆盖等于凭空清掉一屏未读。
process.env.CCM_READ_STATE_FILE = join(dir, 'read-state.json');
// 桌面日志窗：集成测 in-process import app/server.js 时也会走 startLogTerminal。
// 本机 .env 常 LOG_TERMINAL=on；dotenv 不覆盖已存在的非空 key，钉 'off' 挡住回填（见 _spawn-server）。
process.env.LOG_TERMINAL = 'off';
