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

/** server 是否会绑 0.0.0.0（对外可达）。与下方 resolveBindHost 是同一个判断的两种问法。 */
export function bindsPublicly(authToken) {
  return Boolean(authToken);
}

/** 实际监听地址。app.js 的启动路径直接用它，别再写内联三元。 */
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
