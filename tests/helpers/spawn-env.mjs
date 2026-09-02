// tests/helpers/spawn-env.mjs —— 起被测 server 子进程时的环境隔离清单。
// smoke（tests/smoke/runner.js + managesServer 的 scenario）与集成测（tests/integration/_spawn-server.mjs）
// 共用这一份，避免两边各写一份、日后只更新其中一边。
//
// 【为什么需要】两边都用 `{...process.env}` 继承调用者的环境，而调用者未必是一个干净的 shell。
// 2026-09-01 实测：从 CCM web 端启动的 Claude Code 会话，继承的是**生产 server 进程的整份环境**
// （指纹是 `CCM_HOOKS_ORIGIN=web-sdk`），于是 CF_ACCESS_* / VAPID_* 原样流进每个被测实例——
// 实例真的启用了 Access 并对外拉生产 team 的 JWKS，推送密钥也一并带上。
//
// 隔离一直是靠「显式传 WORK_DIR/CCM_DATA_DIR/PORT」做的，但那只覆盖列出的键，**没列到的默认继承**。
// 此前两边已各自为 LOG_TERMINAL / DEV_MODE 打过单点补丁，本清单是同一动机的系统化版本。

export const SPAWN_ENV_BLOCKLIST = Object.freeze([
  'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD',   // 启用后改鉴权路径 + 对外拉 JWKS
  'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT',  // 生产推送密钥，被测实例不该持有
  'PUBLIC_URL',                                              // 通知深链会指向生产域名
  'NTFY_URL', 'NTFY_TOPIC',                                  // 外部通知通道
  'WORK_DIRS_FILE',                                          // 会盖掉显式传入的 WORK_DIRS
  'BIND_MODE', 'BIND_HOST',                                  // 改 listen 计划；custom 且空 host 会让实例拒绝启动
  'CCM_HOOKS_ORIGIN', 'CCM_STATUSLINE_ORIGIN',               // 两个桥的血统标记，继承会让来源判定失真
]);

/**
 * 从继承环境里摘掉不该带进被测实例的键。
 *
 * 删除而不是置空串：loadRuntimeEnvironment 确实会把空串当「未设置」删掉，但在它跑到之前
 * 任何一个消费者若先读到空串，语义就分叉了（见 src/ops/config.js 的 SH-001 注释）。
 * 调用方的 envOverrides 应排在本函数结果【之后】展开——摘的是「继承来的」，不是「显式要的」，
 * cf-access-gate 那批用例正要显式构造 CF 场景。
 */
export function stripInheritedEnv(env, blocklist = SPAWN_ENV_BLOCKLIST) {
  const out = { ...env };
  for (const key of blocklist) delete out[key];
  return out;
}
