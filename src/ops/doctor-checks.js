// 模型配置「永不打架」体检：user/global 的 model 字段 vs local 的 ANTHROPIC_DEFAULT_*_MODEL 映射。
// local 只写 env 映射、不写 model 时，CLI 默认仍用全局 model 全名，网关常不认 → 重试失败；
// 与 UI 上 default.resolvedModel 显示成映射目标叠在一起会误导。
// 入参均为已脱敏的字符串 / 对象（doctor-runtime 读盘后只传必要字段）。
export function modelSettingsConflictDiagnostic({
  userModel = '',
  localModel = '',
  projectModel = '',
  defaultEnvTargets = [], // local env 里 ANTHROPIC_DEFAULT_*_MODEL 的去重目标列表
} = {}) {
  const u = String(userModel || '').trim();
  const l = String(localModel || '').trim();
  const p = String(projectModel || '').trim();
  const targets = [...new Set((defaultEnvTargets || []).map(x => String(x || '').trim()).filter(Boolean))];
  // local/project 已 pin 明确 model → 覆盖链清晰，不告警
  if (l || p) {
    return {
      status: 'ok',
      name: 'MODEL_SETTINGS',
      detail: l
        ? `项目 local 已设 model=${l}（覆盖全局默认）`
        : `项目 project 已设 model=${p}`,
    };
  }
  if (!u || !targets.length) {
    return {
      status: 'ok',
      name: 'MODEL_SETTINGS',
      detail: targets.length
        ? '已配置 ANTHROPIC_DEFAULT_* 映射，全局未设 model（CLI 自选）'
        : '未检测到 model / ANTHROPIC_DEFAULT_* 冲突信号',
    };
  }
  // 全局 model 已是映射目标之一（或以其为前缀，如 grok-4.5 vs grok-4.5[1m]）→ 对齐
  const aligned = targets.some(t => u === t || u.startsWith(t) || t.startsWith(u.replace(/\[[^\]]+\]$/, '')));
  if (aligned) {
    return {
      status: 'ok',
      name: 'MODEL_SETTINGS',
      detail: `全局 model=${u} 与 DEFAULT 映射目标一致`,
    };
  }
  const sample = targets.slice(0, 3).join(', ');
  return {
    status: 'warn',
    name: 'MODEL_SETTINGS',
    detail: `全局 model=${u}，但 local 的 ANTHROPIC_DEFAULT_* 映射到 ${sample}；Default/不 pin 仍用全局 ID。请在 .claude/settings.local.json 写 "model": "${targets[0]}" 或改全局 model。`,
  };
}

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

// D12: CLI hooks 桥安装态（同 D6：只消费 status 子命令的 state，不回显任何命令内容）。
export function hooksBridgeDiagnostic({ bridgeOff = false, installState = 'not-installed' } = {}) {
  if (bridgeOff) {
    return { status: 'ok', name: 'CLI_HOOKS_BRIDGE', detail: '已通过 CLI_HOOKS_BRIDGE=off 停用（安装保留，事件不消费）。' };
  }
  if (installState === 'installed') {
    return { status: 'ok', name: 'CLI_HOOKS_BRIDGE', detail: '已安装：终端会话回合结束/需要你时即时刷新并推送。' };
  }
  if (installState === 'drifted') {
    return { status: 'warn', name: 'CLI_HOOKS_BRIDGE', detail: '安装记录与 settings.json 的 hooks 条目已漂移；先运行 `npm run hooks:status` 检查，勿强行覆盖。' };
  }
  return { status: 'warn', name: 'CLI_HOOKS_BRIDGE', detail: '未安装；终端直跑的会话仅靠 2.5s 轮询、无推送。运行 `npm run hooks:install` 显式启用。' };
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
    // 与 shouldBypassDeviceApproval 对齐（A2）：peer loopback 且 Host 为公网域名时**不会** bypass 设备门；
    // 仅「真本机直连」(Host 本机样) 或 CF Access 已验才跳过。旧文案夸大了隧道跳过风险。
    return {
      status: 'ok',
      detail: 'AUTH_TOKEN 已设；设备门对公网 Host（含 tunnel 反代到 127.0.0.1）仍生效，仅本机直连或 CF Access 跳过。未开 CF Access 时公网仍建议加 2FA 加深防护',
      safe: { risk: 'none', cfEnabled: false, authTokenSet: true, note: 'host_aware_device_gate' },
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
