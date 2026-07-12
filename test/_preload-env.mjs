// test/_preload-env.mjs —— node --test 的 --import 预加载脚本。
// 只做一件事：把 approval-store.js/audit.js（Phase 4 新增的持久化模块）的落盘路径重定向到一次性
// 临时目录，在这两个模块被任何测试文件的静态 import 求值前生效。
//
// 为什么需要这个而不是在测试文件里设环境变量：ESM 的静态 import 在模块链接阶段求值，早于该文件自身
// 任何顶层语句执行——哪怕把 `process.env.X = ...` 写在 `import` 语句上面，agent.js（及其依赖的
// approval-store.js）也已经先跑完模块顶层代码、锁定了落盘路径。sessions.js/devices.js 至今没撞到这个
// 坑是因为它们只被"动态 import"的测试文件（sessions.test.mjs）或"实测接受写真实文件+备份还原"的测试
// 文件（devices.test.mjs）用到；但 agent.js 被 test/agent.test.mjs 大量测试用例静态 import，若不在此处
// 提前重定向，每次 npm test 都会往真实 data/approval-requests.json 里堆测试垃圾数据。
// 只重定向这两个新变量，不碰 CCM_DATA_DIR——集成测试各自显式设置的 CCM_DATA_DIR 隔离方式不受影响
// （CCM_APPROVAL_STORE_FILE/CCM_AUDIT_FILE 优先级高于 CCM_DATA_DIR，但集成测试从未依赖 CCM_DATA_DIR
// 落到这两个新文件上，故无冲突）。
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'ccm-test-data-'));
process.env.CCM_APPROVAL_STORE_FILE = join(dir, 'approval-requests.json');
process.env.CCM_AUDIT_FILE = join(dir, 'audit-records.json');
