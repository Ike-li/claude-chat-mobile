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

import { ENV_SCHEMA } from '../../app/src/ops/env-schema.js';

export const SPAWN_ENV_BLOCKLIST = Object.freeze([
  'CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD',   // 启用后改鉴权路径 + 对外拉 JWKS
  'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT',  // 生产推送密钥，被测实例不该持有
  'PUBLIC_URL',                                              // 通知深链会指向生产域名
  'NTFY_URL', 'NTFY_TOPIC',                                  // 外部通知通道
  'WORK_DIRS_FILE',                                          // 会盖掉显式传入的 WORK_DIRS
  'BIND_MODE', 'BIND_HOST',                                  // 改 listen 计划；custom 且空 host 会让实例拒绝启动
  'CCM_HOOKS_ORIGIN', 'CCM_STATUSLINE_ORIGIN',               // 两个桥的血统标记，继承会让来源判定失真
]);

// 【配置面整体不继承】上面那份逐条列的清单漏过 DEVICE_APPROVAL_SCOPE：2026-09-23 在 CCM 驱动的会话里
// 跑冒烟，shell 继承了生产 server 投影进环境的配置（DEVICE_APPROVAL_SCOPE=all / DEV_MODE /
// ASSET_HOT_RELOAD / LOG_*），被测 server 要求设备审批，冒烟客户端卡在 pending、120s 超时——看着像
// SDK 挂了。所以按 env-schema 整体摘，新配置项进了 schema 就自动在内。例外只有三个：AUTH_TOKEN /
// PORT 调用方随后一定显式覆盖；CLAUDE_BIN 是 CI 与容器把被测实例指向 fake-claude 的开关
// （.github/workflows/test.yml、tests/infra/docker-compose.test.yml 都靠继承传进来）。
const INHERITABLE_CONFIG_KEYS = new Set(['AUTH_TOKEN', 'PORT', 'CLAUDE_BIN']);
const INHERITED_CONFIG_KEYS = Object.keys(ENV_SCHEMA).filter(key => !INHERITABLE_CONFIG_KEYS.has(key));

// 【启动者那个 Claude 会话的身份变量】从 Claude 会话里起被测实例时 shell 带着这些。核实过影响的只有
// CLAUDE_CODE_ENTRYPOINT：SDK 只在它未设置时才填 sdk-ts，继承到终端会话的 cli 时，被测实例写的每一行
// 都会被 CCM 当成终端写的（history.js 的 isOwnSdkTail 只认 sdk-ts）。其余没有逐个核实，但描述的都是
// 启动者那个会话，新起的被测实例没有理由带着。不按 CLAUDE_CODE_ 前缀一刀切：那里也有用户自己配的
// （CLAUDE_CODE_OAUTH_TOKEN 等），冒烟要靠它们打真模型。
const CLAUDE_SESSION_KEYS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_EFFORT',
];

/**
 * 从继承环境里摘掉不该带进被测实例的键。
 *
 * 删除而不是置空串：loadRuntimeEnvironment 确实会把空串当「未设置」删掉，但在它跑到之前
 * 任何一个消费者若先读到空串，语义就分叉了（见 app/src/ops/config.js 的 SH-001 注释）。
 * 调用方的 envOverrides 应排在本函数结果【之后】展开——摘的是「继承来的」，不是「显式要的」，
 * cf-access-gate 那批用例正要显式构造 CF 场景。
 */
export function stripInheritedEnv(env, blocklist = SPAWN_ENV_BLOCKLIST) {
  const out = { ...env };
  for (const key of [...blocklist, ...INHERITED_CONFIG_KEYS, ...CLAUDE_SESSION_KEYS]) delete out[key];
  return out;
}
