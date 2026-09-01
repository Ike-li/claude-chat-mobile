// auth-strategy.js —— 「公网身份提供方」策略层。
//
// 【为什么有这一层】此前核心代码分四处各自取用 cf-access.js：HTTP 鉴权（src/server/http.js
// 的 createHttpAuth）已经是**注入式**——它收 isPublicHost/verifyAccessJwt 两个函数，压根不认识
// Cloudflare；而 socket 握手（app.js 的 io.use）、index.html 的 data-cf-access 注入、doctor ctx
// 与启动横幅则是**直接 import 调用**。同一份判据两种拿法，加第二种 IdP 时要在四个地方各改一遍，
// 而其中任何一处漏改都是「一条通道仍按旧判据放行」——鉴权分叉从来不会自己报错。
//
// 收敛之后核心只认这个对象的形状，具体实现（当前只有 Cloudflare Access）由组装根注入。
//
// 【它不是插件机制】策略仍住在仓内、仍受 check-import-boundaries 与全部门禁约束。
// 2026-08-14 已正式否决插件化：代码一旦出仓库，模块边界守卫 / 事件契约 / 文档一致性三道闸
// 全部照不到它。这里要的只是「核心不再直接依赖某个具体 IdP」，不是「让实现可以搬走」。
//
// 【接口契约】
//   id             具体实现的标识，供日志与诊断认人
//   init()         读 env 完成初始化，返回是否启用；必须在 loadRuntimeEnvironment 之后调
//   isEnabled()    这层公网鉴权当前是否生效
//   ownsHost(host) 这个 Host 是否归本策略管（归它管 ⇒ 只能走它验，不得回退 AUTH_TOKEN）
//   verifyRequest(headers)  验签；**抛错即 fail-closed**，调用方据此拒绝
//   publicHostname()        对外域名（展示用，已 trim + 小写归一）
import { initCfAccess, isAccessEnabled, isPublicHost, verifyAccessJwt } from './cf-access.js';

// Cloudflare Access 策略。deps 全部可注入：本层要能在不触碰 cf-access 模块级可变状态
// （那份状态由 initCfAccess 写、靠 cache-busting 重载才能重置）的前提下被单测覆盖。
export function createCfAccessStrategy({
  init = initCfAccess,
  isEnabled = isAccessEnabled,
  ownsHost = isPublicHost,
  verify = verifyAccessJwt,
  env = process.env,
} = {}) {
  return {
    id: 'cf-access',
    init: () => init(),
    isEnabled: () => isEnabled(),
    ownsHost: (host) => ownsHost(host),
    // 头名是 Cloudflare 侧的外部契约。写错不会报错，只会永远拿 undefined 去验签 —— 而那条路
    // 恰好也是「验签失败 ⇒ 拒绝」，于是表现为「公网怎么都进不去」而非任何一条错误信息。
    verifyRequest: (headers) => verify(headers?.['cf-access-jwt-assertion']),
    // 与 cf-access.js:89 的 hostname 同一口径（trim + 小写）。此前启动横幅直读 process.env
    // 打印，未归一 ⇒ 屏幕上的域名可能与实际参与判定的那个字面不同。
    publicHostname: () => (env.CF_ACCESS_HOSTNAME || '').trim().toLowerCase(),
  };
}

// 没有配置任何公网 IdP 时的策略。三个查询恒 false（不认领任何 Host ⇒ 全部走 AUTH_TOKEN 路），
// verifyRequest 必抛 —— 失败方向只能是拒绝：一个「返回成功」的空策略会把公网请求直接放进来。
export const NULL_AUTH_STRATEGY = Object.freeze({
  id: 'none',
  init: () => false,
  isEnabled: () => false,
  ownsHost: () => false,
  verifyRequest: async () => { throw new Error('no auth strategy configured'); },
  publicHostname: () => '',
});
