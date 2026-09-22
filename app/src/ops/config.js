import { readFileSync } from 'node:fs';

import dotenv from 'dotenv';

import { loadConfigSources, projectToEnv, resolveConfigValues } from './config-file.js';
import { resolveDataDir } from '../shared/data-dir.js';
import {
  ACCESS_PROFILES, DEFAULT_PORT,
  DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_INSTANCE_IDLE_RECLAIM_MS, DEFAULT_APPROVAL_TTL_MS,
  DEFAULT_NOTIFY_THROTTLE_MS, DEFAULT_SESSION_DELETE_QUIET_MS,
} from './env-schema.js';

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
  // 或 CCM_DATA_DIR=，会挡住 .env 填入，normalize 再删空串 → 进程当「未设置」跑
  // （无 AUTH_TOKEN 拒绝启动 / 落盘到仓库 data/）。空串 ≡ 未设置，加载前清掉，让 .env 能补全。
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
  // CCM_CONFIG_FILE_PATH / CCM_ENV_FILE_PATH 必须在这一侧也认：app/src/server/app.js 的
  // CONFIG_FILE_PATH/ENV_FILE_PATH（面板 env:get/env:set 的读写目标）已经认它们，启动侧不认
  // 就会变成「进程启动读仓库根、面板读写临时目录」——两条独立的路径解析，正是 CLAUDE.md
  // 「读写必须同源，写错源＝假成功」点名的那条。覆盖只在测试/演练里设，生产两侧都回落同一目录。
  const sources = envFile
    ? { fileValues: dotenv.parse(readFileSync(envFile)), warnings: [] }
    : loadConfigSources({
      dir: dir ?? process.cwd(),
      configPath: env.CCM_CONFIG_FILE_PATH,
      envPath: env.CCM_ENV_FILE_PATH,
    });

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
  projectRoot,
} = {}) {
  return {
    port: positiveNumber(env.PORT, DEFAULT_PORT),
    authToken: env.AUTH_TOKEN || '',
    idleTimeoutMs: positiveNumber(env.IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
    // Zero explicitly disables fully-idle instance reclamation.
    instanceIdleReclaimMs: nonNegativeNumber(env.INSTANCE_IDLE_RECLAIM_MS, DEFAULT_INSTANCE_IDLE_RECLAIM_MS),
    approvalTtlMs: positiveNumber(env.APPROVAL_TTL_MS, DEFAULT_APPROVAL_TTL_MS),
    // env-schema.js 里这两项都声明 min:0（配置面板接受 0），必须走 nonNegativeNumber——
    // 用 positiveNumber 会把用户存的 "0" 静默换成默认值，且没有任何报错提示。
    notifyThrottleMs: nonNegativeNumber(env.NOTIFY_THROTTLE_MS, DEFAULT_NOTIFY_THROTTLE_MS),
    sessionDeleteQuietMs: nonNegativeNumber(env.SESSION_DELETE_QUIET_MS, DEFAULT_SESSION_DELETE_QUIET_MS),
    devMode: env.DEV_MODE === '1',
    // 监听地址的两个输入原样透传，判定留给 src/shared/bind-host.js 的 resolveBindPlan
    //（server 与两个 doctor 共用那一份，此处再判一次就又有分叉余地了）。
    bindMode: env.BIND_MODE || '',
    bindHost: env.BIND_HOST || '',
    // 采信 X-Forwarded-For 的开关：只认字面量 'loopback'，其余一律归空 = 不采信（AUTH-04，fail-closed）。
    // 这里归一一次，app.js 两个限速调用点与 doctor 共用同一个值——不留「truthy 就算开」的口子。
    trustedProxy: env.TRUSTED_PROXY === 'loopback' ? 'loopback' : '',
    // 同 trustedProxy：只认一个字面量，写错一律落回默认（＝维持现有部署的行为）。
    deviceApprovalScope: env.DEVICE_APPROVAL_SCOPE === 'all' ? 'all' : '',
    // 声明的公网方案：未知值归空，与 doctor「未知按未声明」同口径。此前 app.js 两处裸读 process.env。
    accessProfile: ACCESS_PROFILES.includes(String(env.ACCESS_PROFILE || '').trim()) ? String(env.ACCESS_PROFILE).trim() : '',
    // 【这里曾经是 `workDir: env.WORK_DIR || home`】2026-09-08 删除。WORK_DIR 已并入 WORKDIRS
    // （主工作目录 = 工作区列表首项），而那个 `|| home` 回落是一条实测可达的静默塌陷：手工删掉
    // 配置里的 WORK_DIR 行，整个家目录就成了工作区首位，零报错。README 明写「不要把整个 Home
    // 目录加入工作区」，装机向导也有 work_dir_is_home 专门拒绝这种输入 —— 只有这条路绕开了两者。
    // 工作区列表现在只有一个来源：workdirs.js 的 resolveWorkdirSource（守护：SCOPE-03）。
    // 走带参重载而非无参形式：本函数是可注入纯函数（单测传 projectRoot 断言回落），
    // 且它在 .env 加载前就被求值，绝不能让状态根解析退化成读 process.env。
    dataDir: resolveDataDir(env, projectRoot),
  };
}
