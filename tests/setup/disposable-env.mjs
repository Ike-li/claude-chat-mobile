// tests/setup/disposable-env.mjs —— 「当前执行位是不是一次性环境」的判据（纯函数、无副作用）
//
// 【为什么与 require-disposable-env.mjs 分文件】那份入口在模块顶层就 process.exit()，
// 单测 import 它会把测试进程一起带走。判据留在这里，才能被 tests/unit 直接 import 逐档验。
//
// 【失败方向：检测不到就拒绝】本仓的 fail-closed 是逐条选过的（docs/testing.md），这一条选「拒绝」：
// 误拒的代价是多跑一次容器，误放的代价是 2026-08-02 那种打在真实家目录上的 rmSync。代价不对称，
// 所以 existsSync 抛异常（只读 fs、权限、被 stub 坏）一律归入「不是一次性环境」，由调用方 catch 成 false。

import { existsSync } from 'node:fs';

/** 显式后门。名字写长、写难听，是为了让它在 shell history 与 CI 配置里一眼可见——
 *  后门必须存在（否则容器外没有任何调试出口），但不能像 CI=1 那样顺手就打上。 */
export const BYPASS_VAR = 'CCM_ALLOW_HOST_DESTRUCTIVE_TESTS';

/**
 * @param {object}  opts
 * @param {object}  opts.env           环境变量表（可注入）
 * @param {boolean} opts.hasDockerEnv  /.dockerenv 是否存在（可注入；调用方负责 catch）
 * @returns {{ok: boolean, slot: 'container'|'ci'|'bypass'|'host'}}
 */
export function resolveExecutionSlot({ env = process.env, hasDockerEnv = false } = {}) {
  // 容器：Dockerfile.test 把 HOME 指到容器内一次性目录，这道隔离不依赖任何被测代码的正确性。
  if (hasDockerEnv === true) return { ok: true, slot: 'container' };

  // GitHub Actions 的 runner 是一次性 VM，隔离强于本机容器（.github/workflows/test.yml 里
  // invariants:server / invariants:env 两步就是这么跑的，不加 container:）。
  //
  // 判 GITHUB_ACTIONS 而不是 CI：`CI=true npm test` 是【在开发机上模拟 CI】的常见写法，
  // 拿 CI 当执行位判据，等于谁在本机 export 一次就把这道守卫永久关掉了。
  if (env?.GITHUB_ACTIONS === 'true') return { ok: true, slot: 'ci' };

  if (env?.[BYPASS_VAR] === '1') return { ok: true, slot: 'bypass' };

  return { ok: false, slot: 'host' };
}

/** 测试文件那一档的缺省说明。CLI 工具（mutate）的风险形态不同，自己传 detail。 */
export const TEST_FILE_DETAIL = [
  '   这一层的隔离【依赖被测代码认注入的 home/root/appPath】：回落到 homedir() 就会',
  '   打在真实家目录上。它不像纯函数测试那样「跑错了顶多报错」。',
  '',
  '   改跑：npm run test:docker          （容器，unit + invariants 三档 + 集成）',
  '         docker compose -f tests/infra/docker-compose.test.yml run --rm test \\',
  '           npm run test:invariants:env   （只跑这一档）',
].join('\n');

/** 拒绝时打给人看的说明。判据表变了这段也要跟着变，所以和判据放同一个文件。 */
export function formatRefusal(specifier, detail = TEST_FILE_DETAIL) {
  return [
    '',
    `⛔ ${specifier} 只能在一次性环境里跑，当前执行位是开发机本身。`,
    '',
    detail,
    '',
    `   确知自己在做什么、且愿意承担后果：${BYPASS_VAR}=1 <原命令>`,
    '',
  ].join('\n');
}

/** 走后门时的提醒。放行不等于安静放行——否则后门会悄悄变成常规用法。 */
export function formatBypassWarning(specifier) {
  return `⚠️  ${BYPASS_VAR}=1：${specifier} 正在【开发机】上跑，真实家目录对它可写。\n`;
}

/** /.dockerenv 探测。catch → false：见文件头的失败方向说明。 */
export function detectDockerEnv() {
  try {
    // 延迟到调用期再解析，模块加载本身保持零副作用（mutate.js 被单测静态 import 时会走到这里）。
    return existsSync('/.dockerenv');
  } catch { return false; }
}

/**
 * 不在一次性环境就打印说明并以 1 退出；走后门则放行但打警告。
 *
 * 【为什么要这个函数，而不是让每个调用方都 import require-disposable-env.mjs】
 * 那份入口在【模块顶层】执行，适合测试文件——它就该在 import 的那一刻拦下。
 * 但 tests/gates/mutate.js 被 tests/unit/mutate.test.mjs 静态 import 了 8 个纯函数，
 * 顶层拦截会让宿主机上的 npm run test:unit 整个红掉。那种 CLI 工具只能在 main() 里拦。
 * 两种用法共用这一份判据与文案，避免第二份实现悄悄漂移。
 */
export function enforceDisposableEnv(specifier, {
  env = process.env,
  hasDockerEnv,
  detail,
  stderr = process.stderr,
  exit = process.exit,
} = {}) {
  const slot = resolveExecutionSlot({ env, hasDockerEnv: hasDockerEnv ?? detectDockerEnv() });
  if (!slot.ok) {
    stderr.write(formatRefusal(specifier, detail));
    exit(1);
    return slot;                 // 注入 exit 的测试会走到这里；真实 process.exit 不返回
  }
  if (slot.slot === 'bypass') stderr.write(formatBypassWarning(specifier));
  return slot;
}
