// test/_preload-env.mjs —— node --test 的 --import 预加载脚本。
// 把几个"落盘路径由模块级常量在加载时锁定"的模块重定向到一次性临时目录，在它们被任何测试文件的
// 静态 import 求值前生效。
//
// 为什么需要这个而不是在测试文件里设环境变量：ESM 的静态 import 在模块链接阶段求值，早于该文件自身
// 任何顶层语句执行——哪怕把 `process.env.X = ...` 写在 `import` 语句上面，被 import 的模块（agent.js →
// approval-store.js、history.js 等）也已经先跑完模块顶层代码、锁定了落盘/扫盘路径。sessions.js/
// devices.js 至今没撞到这个坑是因为它们只被"动态 import"的测试文件（sessions.test.mjs）或"实测接受写
// 真实文件+备份还原"的测试文件（devices.test.mjs）用到；但 agent.js/history.js 被 test/*.test.mjs 大量
// 用例静态 import，若不在此处提前重定向，每次 npm test 都会污染真实文件。
// - CCM_APPROVAL_STORE_FILE / CCM_AUDIT_FILE（Phase 4）：否则堆进真实 data/*.json。
// 不碰 CCM_DATA_DIR——集成测试各自显式设置的 CCM_DATA_DIR 隔离方式不受影响。
// 注：transcript 目录（~/.claude/projects）不在此隔离——L2 删除走 SDK deleteSession 只认真实根，隔离
// 本模块的读只会和 SDK 的删分叉（见 history.js CLAUDE_DIR 注释）；session-delete 集成测试改用真实目录
// 下的一次性随机子目录 + before 扫清 + after 清理自保。
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'ccm-test-data-'));
process.env.CCM_APPROVAL_STORE_FILE = join(dir, 'approval-requests.json');
process.env.CCM_AUDIT_FILE = join(dir, 'audit-records.json');
