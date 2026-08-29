// data-dir.js —— 运行时状态根（CCM_DATA_DIR）的唯一解析点。
//
// 此前 sessions/approval-store/audit/devices/cf-access 各写一遍 `process.env.CCM_DATA_DIR || join(…, 'data')`，
// 回落规则（目录名、相对模块的层级）散在 5 处，改一处就得记得改另外四处。
//
// 【为什么 env 只能在函数体内读】src/ops/config.js 在 .env 加载【之前】就被 server.js import
// （瘦启动器必须先拿到 loadRuntimeEnvironment 才能加载 .env），若本模块在顶层求值 process.env.CCM_DATA_DIR，
// config.js 会拿到加载前的空环境 → CCM_DATA_DIR 静默失效 → 生产状态写回仓库 data/。
// 默认参数 `env = process.env` 在【调用期】求值，天然满足；PROJECT_ROOT 只用 import.meta.dirname，与 env 无关。
//
// 【为什么保留 env 形参】parseServerConfig(env, { projectRoot }) 是可注入的纯函数且单测断言了注入行为，
// 不能改成内部直读 process.env，否则纯度和既有测试一起丢。
import { join } from 'node:path';

const PROJECT_ROOT = join(import.meta.dirname, '..', '..');

// 空串按「未设置」处理，与 config.js 的 normalizeLoadedEnvironment 同口径（.env 里写 CCM_DATA_DIR= 不应把状态根打空）。
export function resolveDataDir(env = process.env, projectRoot = PROJECT_ROOT) {
  return (env && env.CCM_DATA_DIR) || join(projectRoot, 'data');
}

// 各状态模块的 CCM_*_FILE 文件级覆盖仍由调用方保持在更高优先级——tests/setup/preload-env.mjs 全靠那几个
// 变量把单测写盘隔离到临时目录，优先级一旦反转，npm test 会写进真实 data/。
export function dataFile(name, env = process.env) {
  return join(resolveDataDir(env), name);
}
