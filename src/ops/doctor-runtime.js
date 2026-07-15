// doctor-runtime.js —— UI 安全体检（④）的运行时编排：读合并白名单 + 6 项检查 + 脱敏聚合。
// server 的 doctor:run 事件调 runDoctor(ctx)，ctx 由 server 喂（env + 已在内存的 workDirs/版本/pushEnabled/设备数）。
// 脱敏原则：绝不回显明文 token / 绝对路径 / AUD / 密钥——只出布尔、计数、以及危险白名单规则串（用户须据此收紧）。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isOwnerOnly } from '../files/file-security.js';
import { statuslineConfigDiagnostic, classifyAuthToken, summarizeDangerous, computeReadiness } from '../../scripts/doctor-checks.js';

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
];

// BE-013：统计权限过宽（非 0600）的配置文件数，供 UI doctor 传入 runDoctor。
// 返回 number（已检查，0=全干净）或 null（平台无 POSIX 权限位、无法检查）。
// 关键：Windows 下 isOwnerOnly 恒 true 会把「无法检查」伪装成「0 处过宽」→ 假绿；故此处先按平台短路返回 null，
// 让 runDoctor 显 warn/未知而非 ok。rootDir 缺省项目根（server 侧传 import.meta.dirname）。
export function countConfigPermProblems(rootDir, { platform = process.platform } = {}) {
  if (platform === 'win32') return null; // 无法真正检查 → 不可假报 0
  let problems = 0;
  for (const name of CONFIG_FILE_NAMES) {
    const p = join(rootDir, name);
    if (!existsSync(p)) continue;      // 文件不存在不算问题
    if (!isOwnerOnly(p)) problems++;   // 存在但非 0600 → 过宽
  }
  return problems;
}

// 读并合并 permissions.allow（~/.claude/settings.json + 各 workDir 的 .claude/settings.json[.local]），标注 scope。
// 容错：读/解析失败的源 skip（比照 workdirs.js 的「坏配置不清空」），坏 JSON 不让体检崩。
export function readMergedPermissions({ home, workDirs = [] } = {}) {
  const sources = [];
  const read = (file, scope) => {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      const rules = j?.permissions?.allow;
      if (Array.isArray(rules)) sources.push({ scope, file, rules });
    } catch { /* 缺文件 / 坏 JSON → skip */ }
  };
  if (home) read(join(home, '.claude', 'settings.json'), 'global');
  for (const dir of workDirs || []) {
    read(join(dir, '.claude', 'settings.json'), 'project');
    read(join(dir, '.claude', 'settings.local.json'), 'local');
  }
  const allow = [];
  for (const s of sources) for (const rule of s.rules) allow.push({ rule, scope: s.scope, file: s.file });
  return { allow, sources };
}

// 编排 6 项运行时安全检查 + 危险白名单审查，产出【已脱敏】报告。
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

  checks.push({ id: 'PUSH_VAPID', status: ctx.pushEnabled ? 'ok' : 'warn', detail: ctx.pushEnabled ? '已配置' : '未配置（推送优雅缺席）', safe: { enabled: !!ctx.pushEnabled } }); // 密钥仅布尔

  checks.push({ id: 'DEVICES', status: (ctx.pendingDevices || 0) > 0 ? 'warn' : 'ok', detail: `信任 ${ctx.trustedDevices || 0} 台 / 待批 ${ctx.pendingDevices || 0} 台`, safe: { trusted: ctx.trustedDevices || 0, pending: ctx.pendingDevices || 0 } });

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
