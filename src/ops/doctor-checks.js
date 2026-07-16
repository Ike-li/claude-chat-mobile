// off：调用方传入的 `process.env.WEB_STATUSLINE === 'off'`（本模块不直接读 env，保持纯函数可测）。
// 两态都是合法配置、非风险，status 恒 ok；detail 如实反映当前生效状态，不再是恒定文案。
export function statuslineConfigDiagnostic(off = false) {
  return {
    status: 'ok',
    name: 'WEB_STATUSLINE',
    detail: off
      ? '已通过 WEB_STATUSLINE=off 关闭 web 状态栏。'
      : 'web 状态栏自包含：使用 SDK usage + 本机 git + CLI 版本，默认启用；设 WEB_STATUSLINE=off 可关闭。',
  };
}

export function statuslineBridgeDiagnostic({ webOff = false, bridgeOff = false, installState = 'not-installed' } = {}) {
  if (webOff) {
    return { status: 'ok', name: 'CLI_STATUSLINE_BRIDGE', detail: 'WEB_STATUSLINE=off，CLI bridge 不参与运行。' };
  }
  if (bridgeOff) {
    return { status: 'ok', name: 'CLI_STATUSLINE_BRIDGE', detail: '已通过 CLI_STATUSLINE_BRIDGE=off 回滚为 SDK-only 状态栏。' };
  }
  if (installState === 'installed') {
    return { status: 'ok', name: 'CLI_STATUSLINE_BRIDGE', detail: '已安装：CLI 驾驶时按 session 同步 statusline；Web 驾驶时使用 SDK。' };
  }
  if (installState === 'drifted') {
    return { status: 'warn', name: 'CLI_STATUSLINE_BRIDGE', detail: '安装记录与当前 Claude statusLine.command 已漂移/被改写；先运行 `npm run statusline:status` 检查，勿强行覆盖。' };
  }
  return { status: 'warn', name: 'CLI_STATUSLINE_BRIDGE', detail: '未安装；Web 驾驶的 SDK 状态栏可用，但 CLI 镜像 statusline 不同步。运行 `npm run statusline:install` 显式启用。' };
}

// ④ 安全体检核心：危险白名单判定。解析 permissions.allow 里的 `Tool(specifier)` 规则，判其宽严。
//   danger = 公网暴露前必须收紧；warn = 偏宽需留意；ok = 有界。识别不了的一律不误报 danger。
export function classifyPermissionRule(rule) {
  const r = String(rule ?? '').trim();
  const m = r.match(/^([A-Za-z_][\w]*)(?:\(([\s\S]*)\))?$/);
  if (!m) return { rule: r, severity: 'ok', reason: '无法解析，按低风险处理' };
  const tool = m[1];
  const spec = m[2] === undefined ? null : m[2].trim();
  const wildcard = spec === null || spec === '' || spec === '*' || spec === ':*';

  if (tool === 'Bash') {
    if (wildcard) return { rule: r, severity: 'danger', reason: '任意命令放行（等于放开 shell）' };
    const s = spec.toLowerCase();
    if (/^(sudo|rm(\s|$)|chmod|chown|mkfs|dd\s|:\(\)\s*\{)/.test(s)) return { rule: r, severity: 'danger', reason: '破坏性 / 提权命令' };
    if (/^(curl|wget|nc|ncat|ssh|scp|telnet)/.test(s)) return { rule: r, severity: 'danger', reason: '可外联 / 数据外泄' };
    if (/^\S+\*/.test(s)) return { rule: r, severity: 'warn', reason: '通配命令族，注意范围' }; // 命令名直接跟*=宽
    return { rule: r, severity: 'ok', reason: '限定命令' };
  }
  // 宽路径通配（** / ~/** / /** / ../** …）：读与写共用——此前 Write 只认 null/''/'*' /':*' 为
  // wildcard，Write(**) 被当成「限定路径的写」→ ok，doctor readiness 假绿（OPS-1）。
  const broadPathGlob = /^(\.\.\/)*~?\/?\*\*/.test(spec);
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    if (wildcard || broadPathGlob) return { rule: r, severity: 'danger', reason: '可写任意文件（无路径限定）' };
    return { rule: r, severity: 'ok', reason: '限定路径的写' };
  }
  if (tool === 'Read') {
    // (\.\.\/)* 兜住相对父目录穿越（如 ../** / ../../**）——之前只认 ~/、/、裸 ** 开头，会漏判这类同样宽泛的通配。
    if (wildcard || broadPathGlob) return { rule: r, severity: 'warn', reason: '可读大范围文件' };
    return { rule: r, severity: 'ok', reason: '限定路径的读' };
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') return { rule: r, severity: 'warn', reason: '可访问外部网络' };
  return { rule: r, severity: 'ok', reason: '常规工具' };
}

// 汇总白名单：ruleCount 全量 + dangerous 仅危险条（scope / 源文件由 doctor-runtime 附加，让用户知道改哪个文件）。
export function summarizeDangerous(rules = []) {
  const list = rules || [];
  const dangerous = list.map(classifyPermissionRule).filter(c => c.severity === 'danger');
  return { ruleCount: list.length, dangerous };
}

// AUTH_TOKEN 判定：绝不回显明文，只出 isSet + length。空 = fail（未保护）；<8 = warn（弱）；否则 ok。
export function classifyAuthToken(token) {
  if (token === undefined || token === null) return { status: 'warn', isSet: false };
  const t = String(token);
  if (t === '') return { status: 'fail', isSet: false };
  if (t.length < 8) return { status: 'warn', isSet: true, length: t.length };
  return { status: 'ok', isSet: true, length: t.length };
}

// AUTH-003：localhost / 反代到 127.0.0.1 的隧道会跳过设备指纹审批（trustBasis=bypass），
// 公网只剩 AUTH_TOKEN 一层。CF Access 已开则 JWT 是公网门，不警告。
// 返回 { status, detail, safe } 供 runDoctor 挂 checks。
export function classifyDeviceGateTopology({ authTokenSet, cfEnabled } = {}) {
  if (cfEnabled) {
    return {
      status: 'ok',
      detail: '公网经 CF Access 2FA；本机/Access 跳过设备门为设计路径',
      safe: { risk: 'none', cfEnabled: true },
    };
  }
  if (authTokenSet) {
    return {
      status: 'warn',
      detail: 'AUTH_TOKEN 已设但未开 CF Access：cloudflared/SSH/nginx 反代到 127.0.0.1 时会跳过设备指纹审批，公网只靠 token。建议开 CF Access，或勿把未批设备暴露到公网',
      safe: { risk: 'tunnel_skips_device_gate', cfEnabled: false, authTokenSet: true },
    };
  }
  return {
    status: 'ok',
    detail: '未设 AUTH_TOKEN（仅绑 127.0.0.1），无公网设备门问题',
    safe: { risk: 'none', authTokenSet: false },
  };
}

// 公网暴露就绪度聚合。blocked = 有 fail，或（危险白名单 + 无 CF Access 兜底 + token 弱）；
// caution = 有危险白名单 / 任一 warn；ready = 关键项皆净。
export function computeReadiness(checks = []) {
  const list = checks || [];
  const byId = Object.fromEntries(list.map(c => [c.id, c]));
  const anyFail = list.some(c => c.status === 'fail');
  const dangerous = byId.WHITELIST?.safe?.dangerous;
  const hasDanger = Array.isArray(dangerous) && dangerous.length > 0;
  const cfEnabled = byId.CF_ACCESS?.safe?.enabled === true;
  const tokenWeak = byId.AUTH_TOKEN?.status !== 'ok';
  if (anyFail || (hasDanger && !cfEnabled && tokenWeak)) return { level: 'blocked', summary: '公网暴露前需修复高风险项' };
  if (hasDanger || list.some(c => c.status === 'warn')) return { level: 'caution', summary: '可用，但有需留意的偏宽项' };
  return { level: 'ready', summary: '关键项就绪' };
}
