// doctor-runtime.js —— UI 安全体检（④）的运行时编排：读合并白名单 + 6 项检查 + 脱敏聚合。
// server 的 doctor:run 事件调 runDoctor(ctx)，ctx 由 server 喂（env + 已在内存的 workDirs/版本/pushEnabled/设备数）。
// 脱敏原则：绝不回显明文 token / 绝对路径 / AUD / 密钥——只出布尔、计数、以及危险白名单规则串（用户须据此收紧）。
import { readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { isOwnerOnly, resolveExecutableViaPath } from '../files/file-security.js';
import { ALL_CONFIG_KEYS } from './config-file.js';
import { ACCESS_PROFILES } from './env-schema.js';
import { statuslineConfigDiagnostic, authTokenDiagnostic, claudeBinDiagnostic, summarizeDangerous, computeReadiness, classifyDeviceGateTopology, modelSettingsConflictDiagnostic, envOverrideDiagnostic, fileEditExposureDiagnostic, accessProfileDiagnostic, bindDiagnostic } from './doctor-checks.js';
import { claudeHome, claudeSettingsPath } from '../shared/claude-home.js';

// claude CLI 的实时探测。**有副作用**（which + 跑一次 --version），所以不在 doctor-checks.js 里
// —— 那一层是纯判定。判定用 claudeBinDiagnostic(probeClaudeBin())，CLI 与 web 两个 doctor 同一对。
//
// 住在 src/ops 而不是 scripts/doctor.js：server 也要调它，而运行时代码禁止 import scripts/（边界闸）。
//
// execFileSync 传 argv 数组，不拼 shell 字符串：路径含空格/引号/`$(...)` 时前者由系统保证边界，
// 后者要靠手写转义（本仓已经为这类拼装出过命令注入，见 service-units 的 plist 渲染注释）。
export function probeClaudeBin({ env = process.env } = {}) {
  const explicit = env.CLAUDE_BIN || '';
  const resolvedPath = explicit ? '' : resolveExecutableViaPath('claude'); // POSIX which / win32 where
  const path = explicit || resolvedPath;
  if (!path) return { explicit, resolvedPath };
  if (!existsSync(path)) return { explicit, resolvedPath, exists: false };
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return { explicit, resolvedPath, exists: true, executable: false };
  }
  try {
    const version = String(execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 3000 })).trim();
    return { explicit, resolvedPath, exists: true, executable: true, version };
  } catch (err) {
    return { explicit, resolvedPath, exists: true, executable: true, versionError: err.message };
  }
}

// 敏感配置文件清单（相对项目根）——CLI doctor（scripts/doctor.js）与本运行时 doctor 共用同一事实源，
// 防两处各自维护再漏同步。列表新增项须同时被 CLI 检查/自动修复与 UI 体检覆盖。
export const CONFIG_FILE_NAMES = [
  // 统一配置文件（P1a 起的默认格式）。它和 .env 一样装着 AUTH_TOKEN / VAPID 私钥 / ntfy token，
  // 不进这张清单的话 CLI doctor 查不到、--fix 也修不了 —— 而 setup.js 现在默认生成的就是它。
  'ccm.config.json',
  '.env',
  join('data', 'sessions.json'),
  join('data', 'init-cache.json'),
  join('data', 'trusted-devices.json'),
  join('data', 'pending-devices.json'),
  join('data', 'cf-access-certs.json'),
  join('data', 'approval-requests.json'),
  join('data', 'audit-records.json'),
  // 含 p256dh/auth 推送密钥材料（notify-channels.js 自己写着「绝不能裸 writeFileSync」），
  // 却一直不在权限清单里 —— CLI doctor 查不到、--fix 也修不了。
  join('data', 'push-subscription.json'),
];

// BE-013：统计权限过宽（非 0600）的配置文件数，供 UI doctor 传入 runDoctor。
// 返回 number（已检查，0=全干净）或 null（平台无 POSIX 权限位、无法检查）。
// 关键：Windows 下 isOwnerOnly 恒 true 会把「无法检查」伪装成「0 处过宽」→ 假绿；故此处先按平台短路返回 null，
// 让 runDoctor 显 warn/未知而非 ok。rootDir 缺省项目根（server 侧传 import.meta.dirname）。
export function countConfigPermProblems(rootDir, { platform = process.platform, dataDir = null } = {}) {
  if (platform === 'win32') return null; // 无法真正检查 → 不可假报 0
  // 清单项以【项目根】为基准（'data/sessions.json'），但长期跑着的实例普遍用 CCM_DATA_DIR 把数据目录移出仓库。
  // 必须剥掉 data/ 前缀再挂到真实数据目录上——此前 server 侧直接把 CCM_DATA_DIR 当 rootDir 传入，拼出
  // <CCM_DATA_DIR>/data/sessions.json 这个永不存在的路径，一个文件都扫不到 → 恒 0 → 体检恒报绿（BE-013 假绿）。
  // CLI doctor（scripts/doctor.js effectiveConfigFiles）一直用同一套剥前缀逻辑，这里与它对齐。
  const dataRoot = dataDir || join(rootDir, 'data');
  let problems = 0;
  for (const name of CONFIG_FILE_NAMES) {
    // 判据从「是不是 .env」换成「在不在 data/ 下」：清单里现在有两个项目根文件
    // （ccm.config.json 与 .env），按名字逐个列举迟早漏掉新加的那个。
    const p = name.startsWith('data')
      ? join(dataRoot, name.replace(/^data[/\\]/, ''))
      : join(rootDir, name);
    if (!existsSync(p)) continue;      // 文件不存在不算问题
    if (!isOwnerOnly(p)) problems++;   // 存在但非 0600 → 过宽
  }
  return problems;
}

// CLI 的 settings 三层链：user(global) → 各 workDir 的 project → 同目录的 local（后者覆盖前者）。
// 权限合并与模型体检【共用这一份】：两处各写一套遍历时，链一变化（CLI 新增作用域、要支持
// managed-settings）只会有一个被更新，另一个继续基于陈旧视图出报告——而 doctor 的职责恰恰是
// 告诉用户配置是否自洽。本次「模型体检丢了用户级 env」正是重复遍历的直接产物。
// 容错：读/解析失败的源 json 为 null（比照 workdirs.js 的「坏配置不清空」），坏 JSON 不让体检崩。
function readSettingsChain({ home, workDirs = [] } = {}) {
  const parse = (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;                       // 缺文件 / 坏 JSON → skip
    }
  };
  const out = [];
  if (home) {
    const file = claudeSettingsPath(home);
    out.push({ scope: 'global', dir: null, file, json: parse(file) });
  }
  for (const dir of workDirs || []) {
    for (const [scope, name] of [['project', 'settings.json'], ['local', 'settings.local.json']]) {
      const file = join(claudeHome(dir), name);
      out.push({ scope, dir, file, json: parse(file) });
    }
  }
  return out;
}

// 读并合并 permissions.allow（~/.claude/settings.json + 各 workDir 的 .claude/settings.json[.local]），标注 scope。
export function readMergedPermissions({ home, workDirs = [] } = {}) {
  const sources = [];
  for (const { scope, file, json } of readSettingsChain({ home, workDirs })) {
    const rules = json?.permissions?.allow;
    if (Array.isArray(rules)) sources.push({ scope, file, rules });
  }
  const allow = [];
  for (const s of sources) for (const rule of s.rules) allow.push({ rule, scope: s.scope, file: s.file });
  return { allow, sources };
}

// 读 user 的 model + 各 workDir 的 project/local 里 model 与 ANTHROPIC_DEFAULT_<档位>_MODEL（只抽字段，不回显 token）。
// 按目录分组返回：多网关并存时（本机 9 个目录各配各的），混成一个扁平数组比对会让归属随机、
// 建议指向错误的目录。档位名从 env key 提取，值只用于判「该档位是否已映射」。
export function readModelSettingsSnapshot({ home, workDirs = [] } = {}) {
  const collectTiers = (j, into) => {
    const env = j?.env && typeof j.env === 'object' ? j.env : null;
    if (!env) return into;
    for (const [k, v] of Object.entries(env)) {
      const m = /^ANTHROPIC_DEFAULT_(.+)_MODEL$/i.exec(k);
      if (!m) continue;
      const t = v != null ? String(v).trim() : '';
      if (t) into[m[1].toLowerCase()] = t;
    }
    return into;
  };
  const modelOf = (j) => (j?.model != null ? String(j.model).trim() : '');

  const chain = readSettingsChain({ home, workDirs });
  const global = chain.find(s => s.scope === 'global');
  const userModel = modelOf(global?.json);
  // 用户级 env 是【每个目录的基底】：CLI 把 ~/.claude/settings.json 的 env 合并进所有目录，
  // 所以「全局配一个网关、各项目不单独配」这个最常见布局下，每个 dir 都带着这份映射。
  // 漏掉它是双向错的——全局配网关时整条检查恒绿假 OK，全局+目录混合时反过来误报 warn。
  const userTiers = collectTiers(global?.json, {});

  const byDir = new Map();
  for (const { scope, dir, json } of chain) {
    if (!dir) continue;
    if (!byDir.has(dir)) byDir.set(dir, { dir, projectModel: '', localModel: '', tierTargets: { ...userTiers } });
    const entry = byDir.get(dir);
    collectTiers(json, entry.tierTargets);               // project 覆盖 global，local 再覆盖 project
    if (scope === 'project') entry.projectModel = modelOf(json);
    if (scope === 'local') entry.localModel = modelOf(json);
  }
  return { userModel, dirs: [...byDir.values()] };
}

// 编排运行时安全检查 + 危险白名单审查，产出【已脱敏】报告。
// 项数以下方 checks.push 为准，并由 tests/unit/doctor-runtime.test.mjs 的
// `assert.equal(rep.checks.length, 12)` 硬锁——增删项会让那条断言红，据它更新即可。
// （此前注释写死的「6 项」在陆续加到 11 项后一直没人更新，是没有任何闸门盯着的注释计数。）
export function runDoctor(ctx = {}) {
  const checks = [];

  // 分类与措辞都走共用的 authTokenDiagnostic —— 与 scripts/doctor.js 同一份判定。
  // 此前这里是内联三元拼文案，纯空白 token 只说「已设置（长度 3）」，看不出它绑着公网。
  // bindPlan 由 server 侧算好传入（它拿得到实际生效的 BIND_MODE/BIND_HOST）；
  // 没传时 authTokenDiagnostic 内部按 token 推导 = 改造前的行为。
  const tok = authTokenDiagnostic({ token: ctx.authToken, bindPlan: ctx.bindPlan || null, lang: ctx.lang });
  checks.push({ id: 'AUTH_TOKEN', status: tok.status, detail: tok.detail, safe: tok.safe });

  // 监听面（D22 的手机端出口）：BIND_MODE 配错会让 server 拒绝启动，而这台正在跑的实例
  // 用的是旧配置——面板上看到 fail 就是「下次重启会起不来」的预警。
  const bindChk = bindDiagnostic({ bindPlan: ctx.bindPlan || null, lang: ctx.lang });
  checks.push({ id: 'BIND', status: bindChk.status, detail: bindChk.detail, safe: bindChk.safe });

  // 实时探测 + 与启动快照对比。此前这里只回放 ctx.claudeVersion（server 启动那一刻的字符串），
  // 于是 claude 被升级/卸载/移走之后，web 体检照样绿到下次重启为止。
  // ctx.probeClaudeBin 由 server 注入（可被测试替换），缺省时自己探。
  const probe = (ctx.probeClaudeBin || probeClaudeBin)();
  const cb = claudeBinDiagnostic({ ...probe, startupVersion: ctx.claudeVersion || '', lang: ctx.lang });
  checks.push({ id: 'CLAUDE_BIN', status: cb.status, detail: cb.detail, safe: cb.safe });

  const wc = (ctx.workDirs || []).length;
  checks.push({ id: 'WORK_DIRS', status: wc ? 'ok' : 'warn', detail: `${wc} 个工作目录`, safe: { count: wc } }); // 不回显路径

  const sl = statuslineConfigDiagnostic(ctx.webStatuslineOff, ctx.lang);
  checks.push({ id: 'WEB_STATUSLINE', status: sl.status, detail: sl.detail });

  // BE-013：区分「未检查」（undefined/null）与「已检查、0 处过宽」（0）。旧实现把缺省 undefined 当 0 → 恒显
  // 「配置文件权限 0600」ok 假绿（server 生产调用从不传此字段）。未检查必须显 warn/未知，绝不显 ok。
  const cpp = ctx.configPermsProblems;                       // number=已检查 · null=平台不可查 · undefined=未传
  const cppChecked = typeof cpp === 'number';
  checks.push({
    id: 'CONFIG_PERMS',
    status: cppChecked ? (cpp ? 'warn' : 'ok') : 'warn',      // 未检查 → warn（不假绿）
    detail: cppChecked ? (cpp ? `${cpp} 处权限过宽（应 0600）` : '配置文件权限 0600') : '配置文件权限未检查（未知）',
    safe: { problemCount: cppChecked ? cpp : null, checked: cppChecked },
  });

  checks.push({ id: 'CF_ACCESS', status: ctx.cfEnabled ? 'ok' : 'warn', detail: ctx.cfEnabled ? '已启用公网 2FA' : '未启用（回退纯 AUTH_TOKEN）', safe: { enabled: !!ctx.cfEnabled, audSet: !!ctx.cfAudSet } }); // AUD 仅布尔

  // D21 的手机端出口：方案声明（ACCESS_PROFILE）就住在 web 配置面板里，切换后的自洽核对
  // 也该在手机上看得到。判定与 scripts/doctor.js D21 共用 accessProfileDiagnostic；
  // cfConfigured 用 ctx.cfEnabled（auth 层权威判定，比 CLI 侧「三键齐设」更准）。
  // safe 只出布尔/枚举字面量：publicUrl 的值绝不进报告（会被贴进 issue/聊天）。
  const apProfile = String(ctx.accessProfile || '').trim();
  const ap = accessProfileDiagnostic({
    profile: apProfile,
    cfConfigured: !!ctx.cfEnabled,
    publicUrl: ctx.publicUrl || '',
    authTokenSet: tok.safe.isSet && tok.status !== 'fail',
    notifyConfigured: !!ctx.notifyConfigured,
    lang: ctx.lang,
  });
  checks.push({
    id: 'ACCESS_PROFILE', status: ap.status, detail: ap.detail,
    safe: {
      declared: apProfile !== '',
      // 未知值归一成 'unknown'：safe 只出枚举字面量，用户手写的任意串不进结构化字段（detail 里已点名）。
      profile: !apProfile || ACCESS_PROFILES.includes(apProfile) ? apProfile : 'unknown',
      cfConfigured: !!ctx.cfEnabled,
      publicUrlSet: !!String(ctx.publicUrl || '').trim(),
      notifyConfigured: !!ctx.notifyConfigured,
    },
  });

  // token 公网 + 无 CF Access 时，localhost 反代/隧道会跳过设备指纹门——显式 warn，不改运行时默认。
  // 纯空白 token 现在判 fail（绑了公网却不设防），于是这里也正确地不再把它当成一道认证门 ——
  // 此前它是 warn/isSet=true，DEVICE_GATE 会以为公网侧有 AUTH_TOKEN 保护着。
  const gate = classifyDeviceGateTopology({ authTokenSet: tok.safe.isSet && tok.status !== 'fail', cfEnabled: !!ctx.cfEnabled });
  checks.push({ id: 'DEVICE_GATE', status: gate.status, detail: gate.detail, safe: gate.safe });

  // D20 的手机端出口（R45，2026-08-30）：FILE_EDIT 是唯一绕过 Agent 审批链的写入通道，而它的
  // 开关就住在这个配置面板里——web 体检的受众与该提示的受众重合度比装机时跑一次的 CLI doctor 高。
  // 判定与 scripts/doctor.js D20 同一份纯函数；公网信号 = CF Access 实际启用（ctx.cfEnabled，
  // auth 层权威判定，比 CLI 侧「三键齐设」更准）或 PUBLIC_URL 已声明。safe 不回显 URL 值，只出布尔。
  const fe = fileEditExposureDiagnostic({ fileEditOff: !!ctx.fileEditOff, cfConfigured: !!ctx.cfEnabled, publicUrl: ctx.publicUrl || '', accessProfile: ctx.accessProfile || '', lang: ctx.lang });
  checks.push({
    id: 'FILE_EDIT', status: fe.status, detail: fe.detail,
    safe: { off: !!ctx.fileEditOff, publicSignal: !!ctx.cfEnabled || !!String(ctx.publicUrl || '').trim() },
  });

  checks.push({ id: 'PUSH_VAPID', status: ctx.pushEnabled ? 'ok' : 'warn', detail: ctx.pushEnabled ? '已配置' : '未配置（推送优雅缺席）', safe: { enabled: !!ctx.pushEnabled } }); // 密钥仅布尔

  checks.push({ id: 'DEVICES', status: (ctx.pendingDevices || 0) > 0 ? 'warn' : 'ok', detail: `信任 ${ctx.trustedDevices || 0} 台 / 待批 ${ctx.pendingDevices || 0} 台`, safe: { trusted: ctx.trustedDevices || 0, pending: ctx.pendingDevices || 0 } });

  // 模型设置冲突：全局 model vs local ANTHROPIC_DEFAULT_*（不回显 env 密钥，只报 model 名与映射目标）
  const modelSnap = readModelSettingsSnapshot({ home: ctx.home, workDirs: ctx.workDirs || [] });
  const modelDiag = modelSettingsConflictDiagnostic(modelSnap);
  checks.push({
    id: 'MODEL_SETTINGS',
    status: modelDiag.status,
    detail: modelDiag.detail,
    safe: {
      userModel: modelSnap.userModel || null,
      // 不回显路径/映射目标值：只出「配了网关的目录数」与「目录内是否 pin 了 model」的计数。
      gatewayDirCount: modelSnap.dirs.filter(d => Object.keys(d.tierTargets).length > 0).length,
      pinnedDirCount: modelSnap.dirs.filter(d => d.localModel || d.projectModel).length,
    },
  });

  // D18 的手机端出口。「env 恒压过配置文件而被压侧无症状」这句话写在 scripts/doctor.js:23 ——
  // 产品自己承认它危险，可此前唯一的消费者是维护者 CLI，而 ccm 的主场景恰恰在手机上。
  // ctx.shellEnv 必须是 loadRuntimeEnvironment **之前**的快照（src/ops/config.js
  // getShellEnvSnapshot），加载后文件值也进了 process.env、来源就分不开了。
  // 缺省不假绿：调用方没传快照 = 这项没查过，与 BE-013 的 CONFIG_PERMS 同一条纪律。
  const envOvChecked = !!ctx.shellEnv && typeof ctx.shellEnv === 'object';
  const envOv = envOverrideDiagnostic({ shellEnv: ctx.shellEnv || {}, keys: ALL_CONFIG_KEYS, lang: ctx.lang });
  checks.push({
    id: 'ENV_OVERRIDE',
    status: envOvChecked ? envOv.status : 'warn',
    detail: envOvChecked ? envOv.detail : '环境变量覆盖未检查（未知）',
    // 只出键名 —— 值可能是 AUTH_TOKEN / VAPID 私钥，而体检报告会被贴进 issue / 聊天。
    safe: { checked: envOvChecked, keys: envOvChecked ? envOv.keys : [] },
  });

  // 危险白名单：读合并 permissions.allow，危险条附 scope（让用户知道改哪个文件），非危险不列。
  const merged = readMergedPermissions({ home: ctx.home, workDirs: ctx.workDirs || [] });
  const sum = summarizeDangerous(merged.allow.map(a => a.rule));
  // SONNET-BUG-1：旧实现 `merged.allow.find(a => a.rule === d.rule)?.scope` 只取首个匹配——同一危险规则若同时
  // 出现在 global 与 project，恒被标成 global（首命中），项目级重复规则误标；且 summarizeDangerous 逐条 map，
  // 重复规则会产生多条相同 dangerous。此处按 rule 去重 + 聚合【所有】出现过的 scope。
  const dangerous = [];
  const seenRules = new Set();
  for (const d of sum.dangerous) {
    if (seenRules.has(d.rule)) continue;               // 去重：同一条不重复列
    seenRules.add(d.rule);
    const scopes = [...new Set(merged.allow.filter(a => a.rule === d.rule).map(a => a.scope))];
    dangerous.push({ rule: d.rule, reason: d.reason, scope: scopes.join(', ') }); // scope 聚合成串（前端直接展示）
  }
  checks.push({ id: 'WHITELIST', status: dangerous.length ? 'warn' : 'ok', detail: dangerous.length ? `${dangerous.length} 条危险规则（共 ${sum.ruleCount} 条）` : `${sum.ruleCount} 条规则，无危险项`, safe: { ruleCount: sum.ruleCount, dangerous } });

  return { checks, readiness: computeReadiness(checks) };
}
