// doctor-runtime.js —— UI 安全体检（④）的运行时编排：读合并白名单 + 6 项检查 + 脱敏聚合。
// server 的 doctor:run 事件调 runDoctor(ctx)，ctx 由 server 喂（env + 已在内存的 workDirs/版本/pushEnabled/设备数）。
// 脱敏原则：绝不回显明文 token / 绝对路径 / AUD / 密钥——只出布尔、计数、以及危险白名单规则串（用户须据此收紧）。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isOwnerOnly } from '../files/file-security.js';
import { statuslineConfigDiagnostic, classifyAuthToken, summarizeDangerous, computeReadiness, classifyDeviceGateTopology, modelSettingsConflictDiagnostic } from './doctor-checks.js';

// 敏感配置文件清单（相对项目根）——CLI doctor（scripts/doctor.js）与本运行时 doctor 共用同一事实源，
// 防两处各自维护再漏同步。列表新增项须同时被 CLI 检查/自动修复与 UI 体检覆盖。
export const CONFIG_FILE_NAMES = [
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
  // 清单项以【项目根】为基准（'data/sessions.json'），但生产部署普遍用 CCM_DATA_DIR 把数据目录移出仓库。
  // 必须剥掉 data/ 前缀再挂到真实数据目录上——此前 server 侧直接把 CCM_DATA_DIR 当 rootDir 传入，拼出
  // <CCM_DATA_DIR>/data/sessions.json 这个永不存在的路径，一个文件都扫不到 → 恒 0 → 体检恒报绿（BE-013 假绿）。
  // CLI doctor（scripts/doctor.js effectiveConfigFiles）一直用同一套剥前缀逻辑，这里与它对齐。
  const dataRoot = dataDir || join(rootDir, 'data');
  let problems = 0;
  for (const name of CONFIG_FILE_NAMES) {
    const p = name === '.env'
      ? join(rootDir, name)
      : join(dataRoot, name.replace(/^data[/\\]/, ''));
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
export function readSettingsChain({ home, workDirs = [] } = {}) {
  const parse = (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;                       // 缺文件 / 坏 JSON → skip
    }
  };
  const out = [];
  if (home) {
    const file = join(home, '.claude', 'settings.json');
    out.push({ scope: 'global', dir: null, file, json: parse(file) });
  }
  for (const dir of workDirs || []) {
    for (const [scope, name] of [['project', 'settings.json'], ['local', 'settings.local.json']]) {
      const file = join(dir, '.claude', name);
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
// `assert.equal(rep.checks.length, 11)` 硬锁——增删项会让那条断言红，据它更新即可。
// （此前注释写死的「6 项」在陆续加到 11 项后一直没人更新，是没有任何闸门盯着的注释计数。）
export function runDoctor(ctx = {}) {
  const checks = [];

  const tok = classifyAuthToken(ctx.authToken);
  checks.push({ id: 'AUTH_TOKEN', status: tok.status, detail: tok.isSet ? `已设置（长度 ${tok.length ?? '?'}）` : '未设置——不设则仅绑 127.0.0.1', safe: { isSet: tok.isSet, length: tok.length } });

  checks.push({ id: 'CLAUDE_BIN', status: ctx.claudeVersion ? 'ok' : 'warn', detail: ctx.claudeVersion || '未采集到 CLI 版本', safe: { found: !!ctx.claudeVersion, version: ctx.claudeVersion || null } });

  const wc = (ctx.workDirs || []).length;
  checks.push({ id: 'WORK_DIRS', status: wc ? 'ok' : 'warn', detail: `${wc} 个工作目录`, safe: { count: wc } }); // 不回显路径

  const sl = statuslineConfigDiagnostic(ctx.webStatuslineOff);
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

  // AUTH-003：token 公网 + 无 CF Access 时，localhost 反代/隧道会跳过设备指纹门——显式 warn，不改运行时默认。
  const gate = classifyDeviceGateTopology({ authTokenSet: tok.isSet && tok.status !== 'fail', cfEnabled: !!ctx.cfEnabled });
  checks.push({ id: 'DEVICE_GATE', status: gate.status, detail: gate.detail, safe: gate.safe });

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
