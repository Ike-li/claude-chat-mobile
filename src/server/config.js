import { readFileSync } from 'node:fs';

import dotenv from 'dotenv';

import { loadConfigSources, projectToEnv, resolveConfigValues } from '../ops/config-file.js';
import { resolveDataDir } from '../shared/data-dir.js';
import { DEFAULT_PORT } from '../ops/env-schema.js';

const positiveNumber = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const nonNegativeNumber = (value, fallback) => {
  if (value === '' || value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

// dotenv is loaded by the composition root. This pure normalization step keeps
// an empty .env value equivalent to "unset" and prevents .env from silently
// overriding provider credentials that were not already present in the shell.
export function normalizeLoadedEnvironment(env, shellAnthropicKeys) {
  for (const key of Object.keys(env)) {
    if (env[key] === '') delete env[key];
    else if (key.startsWith('ANTHROPIC_') && !shellAnthropicKeys.has(key)) delete env[key];
  }
  return env;
}

// 投影**之前**的 shell 环境快照。消费者是配置面板（逐行标「这一行被 env 压过了，改了不生效」）
// 与手机端安全体检的 D18；两处都只用它做「设没设」判定，绝不回显值——被压住的可能正是
// AUTH_TOKEN / VAPID 私钥。
//
// 为什么由 loadRuntimeEnvironment 自己在第一行拍，而不是像 scripts/doctor.js:673 那样让调用方拍：
// 这个快照唯一的正确时机是「文件值投影回 env 之前」，投影之后来源就分不开了（面板会把每一项
// 都标成被覆盖）。让调用方守一句注释是可以写错的；写在这里，顺序由构造保证。
// app.js 也拿不到别的时机——它是被 server.js 在 loadRuntimeEnvironment 之后才动态 import 的。
let shellEnvSnapshot = {};
export function getShellEnvSnapshot() {
  return shellEnvSnapshot;
}

// Must run in the thin launcher before importing app.js. Several state modules
// resolve their file paths at module evaluation time, so loading .env inside
// app.js would be too late for CCM_DATA_DIR. Provider variables remain shell-only.
export function loadRuntimeEnvironment(env = process.env, { envFile, dir, quiet = false } = {}) {
  // 浅拷贝而非引用：下面的投影会往 env 上写，引用会让快照跟着长出文件值。
  shellEnvSnapshot = { ...env };
  const shellAnthropicKeys = new Set(Object.keys(env).filter(key => key.startsWith('ANTHROPIC_')));
  // OPS/SH-001：dotenv 默认不覆盖已存在的 key——含空串。上层若 export AUTH_TOKEN=
  // 或 CCM_DATA_DIR=，会挡住 .env 填入，normalize 再删空串 → 进程当「未设置」跑（绑 127.0.0.1 /
  // 落盘到仓库 data/）。空串 ≡ 未设置，加载前清掉，让 .env 能补全。
  // 集成测试 child 以 CCM_TEST_PRESERVE_EMPTY_ENV=1 明确声明空认证/CF 配置：保留到 dotenv 完成，
  // 防主 .env 回填；normalizeLoadedEnvironment 随后照常删空串。该标记不改变普通启动的 SH-001 语义。
  // 但 ANTHROPIC_* 必须排除在外：这条预清空会让 dotenv 把 .env 里的 ANTHROPIC_* 填进来，而
  // shellAnthropicKeys（下面 normalizeLoadedEnvironment 用于判断"是否真是 shell 声明"）此刻已把
  // 这个空串 key 记成"shell 有"，导致 .env 值绕过守卫存活——违反"ANTHROPIC_* 只认真实 shell 值"。
  if (env.CCM_TEST_PRESERVE_EMPTY_ENV !== '1') {
    for (const key of Object.keys(env)) {
      if (env[key] === '' && !key.startsWith('ANTHROPIC_')) delete env[key];
    }
  }

  // 配置源：默认扫 cwd（headless 在仓库目录里 npm start；桌面端的 plist 也是
  // `cd "__REPO__" && exec node server.js`，两条入口 cwd 都落在仓库根），
  // ccm.config.json 优先、缺失回落 .env。显式 envFile 走兼容路径 —— doctor 的 `--env=prod.env`
  // 与单测都指向一个具体文件，那时不该再去扫目录。
  const sources = envFile
    ? { fileValues: dotenv.parse(readFileSync(envFile)), warnings: [] }
    : loadConfigSources({ dir: dir ?? process.cwd() });

  const { values, warnings } = resolveConfigValues({
    fileValues: sources.fileValues,
    shellEnv: env,
    source: envFile ? 'env' : sources.source,
  });
  if (!quiet) {
    for (const w of [...sources.warnings, ...warnings]) console.warn(`[config] ${w}`);
  }

  // 投影回 process.env：**只填 env 里还没有的 key**。这一条就是 dotenv「不覆盖已存在的 key」
  // 语义的等价物 —— 换格式不改变谁赢。已在 env 里的要么是真 shell 值，要么是
  // CCM_TEST_PRESERVE_EMPTY_ENV 下被刻意保留的空串（随后由 normalizeLoadedEnvironment 删掉）。
  //
  // 类型化到此为止：投影出去的是字符串，现有 7 处消费点的字面量判据一行不改。
  // 等 P1b/P1c 把消费点迁到结构化值，这一层才退场。
  for (const [key, value] of Object.entries(values)) {
    if (Object.hasOwn(env, key)) continue;
    const projected = projectToEnv(key, value);
    if (projected !== null) env[key] = projected;
  }

  return normalizeLoadedEnvironment(env, shellAnthropicKeys);
}

export function parseServerConfig(env, {
  home,
  projectRoot,
} = {}) {
  return {
    port: positiveNumber(env.PORT, DEFAULT_PORT),
    authToken: env.AUTH_TOKEN || '',
    idleTimeoutMs: positiveNumber(env.IDLE_TIMEOUT_MS, 600_000),
    // Zero explicitly disables fully-idle instance reclamation.
    instanceIdleReclaimMs: nonNegativeNumber(env.INSTANCE_IDLE_RECLAIM_MS, 1_800_000),
    approvalTtlMs: positiveNumber(env.APPROVAL_TTL_MS, 1_800_000),
    notifyThrottleMs: positiveNumber(env.NOTIFY_THROTTLE_MS, 60_000),
    sessionDeleteQuietMs: positiveNumber(env.SESSION_DELETE_QUIET_MS, 300_000),
    devMode: env.DEV_MODE === '1',
    workDir: env.WORK_DIR || home,
    // 走带参重载而非无参形式：本函数是可注入纯函数（单测传 projectRoot 断言回落），
    // 且它在 .env 加载前就被求值，绝不能让状态根解析退化成读 process.env。
    dataDir: resolveDataDir(env, projectRoot),
  };
}
