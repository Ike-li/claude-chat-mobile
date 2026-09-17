// child-env.js —— ccm 派生 claude 子进程时的环境变量漏斗（唯一事实源）。
//
// 放在 src/shared（叶子层、不 import 任何后端域）的原因：两个消费方分处不同域且已有单向依赖——
// src/agent/agent.js（SDK query 的子进程）与 src/ops/cli-bg-session-lock.js（`claude agents` 探测
// 子进程）。agent.js 已经 import 了 cli-bg-session-lock.js，若把本函数留在 agent.js 再让 ops 反向
// import 就构成循环依赖（npm run check 的模块边界守卫会拦下）。
//
// 刻意**不做**白名单裁剪：本项目的哲学是子进程环境与用户终端里的 claude 一致（终端等价性），
// 走第三方网关的用户靠 shell 里 export 的 ANTHROPIC_* 生效，裁掉就等于砍掉这条支持路径。
// 启动期已由 src/ops/config.js 的 normalizeLoadedEnvironment 处理过 .env 侧的污染
// （删空串 key、剥除非 shell 来源的 ANTHROPIC_*），这里只补两个进程身份标记。
//
// 【唯一的例外：CCM 自己的控制面密钥】（H1，2026-09-17 安全审查）
// 上面那条"不裁剪"曾被执行成"整份 process.env 原样传出去"，而 server 会把 ccm.config.json 的值
// 投影进 process.env（src/ops/config.js 的投影循环）。结果是 AUTH_TOKEN / VAPID 私钥 / ntfy 令牌
// 全进了 claude 子进程——**这比终端更宽，不是等宽**：在普通终端里跑 claude，进程环境里根本没有
// 这几个键，它们只存在于 CCM 自己的配置文件里。
//
// 后果不是"又一次本地 shell"（那本来就是产品）：工作区里的提示注入 + 一次已放行的 Bash，模型就能
// `echo $AUTH_TOKEN`。拿到的是 Web 控制面钥匙，公网绑着时等于远程入口凭据。
//
// 所以剥掉它们是**恢复**终端等价性而不是削弱它。判据是"这个键属于 CCM 还是属于 claude"：
// ANTHROPIC_* / CLAUDE_CODE_* / 代理变量属于 claude，一律原样透传（网关路径全靠它们）。
//
// 按**整组前缀**剥而不是逐个列密钥：VAPID_ 里只有私钥标了 secret，但公钥与 subject（可能是真实
// 邮箱）对 claude 同样零用途；NTFY_TOPIC 没标 secret，可在公共 ntfy.sh 上 topic 名本身就是能力
// ——能读到你的通知、也能往你手机上发。整组剥掉不需要在"哪个算密钥"上逐个赌对。
//
// 这份清单是硬编码的：本文件在 src/shared（叶子层），import src/ops 的 env-schema 会被模块边界
// 守卫拦下。清单随 schema 新增密钥而过期时**不会有任何报错**（新密钥照样进子进程），
// 那道闸由 tests/unit/agent-core.test.mjs 的漂移用例充当：schema 里标了密钥的键必须在这里被剥掉。
const CCM_CONTROL_PLANE_KEYS = new Set(['AUTH_TOKEN']);
const CCM_CONTROL_PLANE_PREFIXES = ['VAPID_', 'NTFY_', 'CF_ACCESS_'];

function isCcmControlPlaneKey(key) {
  return CCM_CONTROL_PLANE_KEYS.has(key)
    || CCM_CONTROL_PLANE_PREFIXES.some(prefix => key.startsWith(prefix));
}

export function sdkChildEnv(base = process.env) {
  return {
    ...Object.fromEntries(Object.entries(base || {})
      .filter(([key, value]) => value !== '' && !isCcmControlPlaneKey(key))),
    // statusline wrapper 据此只转发 renderer、不捕获：防 Web SDK 子进程覆盖真实终端 session 快照。
    CCM_STATUSLINE_ORIGIN: 'web-sdk',
    // hooks runner 据此直接静默退出。SDK 会话的 settingSources 含 'user'，会加载用户全局 hooks——
    // 不抑制的话，web 自己驱动的每一轮都会经「SDK result」和「Stop hook」两条路各推一次通知。
    CCM_HOOKS_ORIGIN: 'web-sdk',
  };
}
