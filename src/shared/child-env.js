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
export function sdkChildEnv(base = process.env) {
  return {
    ...Object.fromEntries(Object.entries(base || {}).filter(([, value]) => value !== '')),
    // statusline wrapper 据此只转发 renderer、不捕获：防 Web SDK 子进程覆盖真实终端 session 快照。
    CCM_STATUSLINE_ORIGIN: 'web-sdk',
    // hooks runner 据此直接静默退出。SDK 会话的 settingSources 含 'user'，会加载用户全局 hooks——
    // 不抑制的话，web 自己驱动的每一轮都会经「SDK result」和「Stop hook」两条路各推一次通知。
    CCM_HOOKS_ORIGIN: 'web-sdk',
  };
}
