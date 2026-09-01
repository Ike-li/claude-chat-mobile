// bind-host.js —— 「这台 server 会不会对外可达」的唯一判据。
//
// 【为什么要单独一个文件】这个判断此前是 src/server/app.js 里的一行内联三元
// （`const host = AUTH_TOKEN ? '0.0.0.0' : '127.0.0.1'`），而**两个 doctor 各自猜它**：
//
//   AUTH_TOKEN='   '（纯空白）时实测三方分叉：
//     · server 事实   → '   ' 是 truthy → 绑 0.0.0.0，公网可达，认证形同虚设
//     · scripts/doctor.js → ✗「已设置但为空 → 仅监听 127.0.0.1」← 安全语义正好说反了
//     · doctor-runtime.js → warn「弱 token（3 字符）」← 更接近但没说清后果
//
//   用户看到 doctor 说「只绑本机」就放心了，实际那台机器正开着公网端口。
//
// 判据只能有一份。抽到 shared（叶子层，前后端各域都能 import）之后，server 与两个 doctor
// 调的是同一个函数——不是「两份保持一致」，而是同一份代码，没有分叉的余地。
//
// 归属 shared 而不是 ops：它是纯判定、零依赖，且 src/server 与 src/ops 都要用
// （ops 反向 import server 会撞模块边界闸）。

// 合法的 BIND_MODE 字面量（env-schema 的 options 与它同源；此处不 import 那边——
// shared 是叶子层，反向 import 会撞 check-import-boundaries 的 shared-is-leaf 闸）。
export const BIND_MODES = Object.freeze(['loopback', 'lan', 'custom']);

const LOOPBACK_NAMES = new Set(['localhost', '::1']);

/**
 * 这个监听地址是不是「只有本机能连」。127/8 整段都是 loopback（不止 127.0.0.1），
 * 而 0.0.0.0 / :: 是通配符——绑它们就是对外可达，绝不能算本地。
 */
export function isLoopbackBindHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return false;
  if (LOOPBACK_NAMES.has(h)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * 监听计划：绑哪个地址、是否对外可达、要不要拒绝启动。
 *
 * 【不变量】配不出「对外可达但无鉴权」。实现方式是两条互补的路：
 *   · 未声明 BIND_MODE（默认）→ 沿用旧语义，无 token 时**静默降级**到 loopback。
 *     这条必须保持：现有部署全在这条路上，且「本地试用不设 token」是合法用法。
 *   · 显式声明要绑外网（lan / custom+非loopback）却没有 AUTH_TOKEN → **拒绝启动**。
 *     不静默降级的理由：用户明确要求了做不到的事，而静默降级的后果是
 *     「手机全部连不上，却没有任何错误信息」——config-file.js 已把这种形态判为必须消除。
 *
 * 未知 BIND_MODE 一律拒绝，不回落「按 token 推断」：在监听面这种安全关键项上，
 * 猜一个的后果是「用户以为自己收窄了监听面，实际绑着 0.0.0.0」。
 *
 * @returns {{host: string, publiclyReachable: boolean, refuse: null | {code: string, detail: string}}}
 */
export function resolveBindPlan({ authToken, bindMode, bindHost } = {}) {
  const mode = String(bindMode ?? '').trim().toLowerCase();
  // 与默认分支所用的 bindsPublicly()（纯 Boolean，'   ' 算「有」）**刻意不同**：
  // 默认分支必须逐字节保持旧语义（纯空白 token 照样绑 0.0.0.0，那一格由 doctor 判 fail 并点名）；
  // 而用户显式要求绑外网时，形同虚设的空白 token 不该被当成「有鉴权」放行。
  const hasRealToken = Boolean(authToken) && !isBlankToken(authToken);
  const deny = (code, detail) => ({ host: '127.0.0.1', publiclyReachable: false, refuse: { code, detail } });
  const allow = (host) => ({ host, publiclyReachable: !isLoopbackBindHost(host), refuse: null });

  if (mode === '') return allow(bindsPublicly(authToken) ? '0.0.0.0' : '127.0.0.1');
  if (mode === 'loopback') return allow('127.0.0.1');

  if (mode === 'lan') {
    if (!hasRealToken) {
      return deny('lan_requires_token',
        'BIND_MODE=lan 要求先设置 AUTH_TOKEN——否则这个端口会对整个局域网/公网敞开且无人把守。'
        + '跑 npm run setup 生成一个，或改用 BIND_MODE=loopback 只绑本机。');
    }
    return allow('0.0.0.0');
  }

  if (mode === 'custom') {
    const host = String(bindHost ?? '').trim();
    if (!host) {
      return deny('custom_requires_host', 'BIND_MODE=custom 必须同时设置 BIND_HOST（例如 :: 表示 IPv4/IPv6 双栈）。');
    }
    if (!isLoopbackBindHost(host) && !hasRealToken) {
      return deny('custom_requires_token',
        `BIND_HOST=${host} 会让这个端口对外可达，要求先设置 AUTH_TOKEN。`
        + '跑 npm run setup 生成一个，或把 BIND_HOST 改成 127.0.0.1 只绑本机。');
    }
    return allow(host);
  }

  return deny('unknown_bind_mode',
    `不认识的 BIND_MODE：${bindMode}（合法值：${BIND_MODES.join(' / ')}，留空 = 按 AUTH_TOKEN 推断）。`);
}

/** server 是否会绑 0.0.0.0（对外可达）。与下方 resolveBindHost 是同一个判断的两种问法。 */
export function bindsPublicly(authToken) {
  return Boolean(authToken);
}

/**
 * 实际监听地址（只按 token 推导的旧签名）。别再写内联三元。
 *
 * 保留它是因为两个 doctor 的 classifyAuthToken 与 single-source-of-truth 的门禁都盯着它；
 * 需要把 BIND_MODE 一并算进来的调用点用 resolveBindPlan。
 */
export function resolveBindHost(authToken) {
  return bindsPublicly(authToken) ? '0.0.0.0' : '127.0.0.1';
}

/**
 * token 里全是空白 —— 最危险的那一格：既绑了公网，认证又几乎不设防
 * （攻击者不必猜中「三个空格」，而是**机主自己以为没设 token**，于是不会去想公网暴露的事）。
 *
 * 之所以能走到这一步：loadRuntimeEnvironment 只删严格空串 `''`，不 trim，所以 '   ' 活到运行时。
 */
export function isBlankToken(authToken) {
  return typeof authToken === 'string' && authToken !== '' && authToken.trim() === '';
}
