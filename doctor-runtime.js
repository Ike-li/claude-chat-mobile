// doctor-runtime.js —— UI 安全体检（④）的运行时编排：读合并白名单 + 6 项检查 + 脱敏聚合。
// server 的 doctor:run 事件调 runDoctor(ctx)，ctx 由 server 喂（env + 已在内存的 workDirs/版本/pushEnabled/设备数）。
// 脱敏原则：绝不回显明文 token / 绝对路径 / AUD / 密钥——只出布尔、计数、以及危险白名单规则串（用户须据此收紧）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { statuslineConfigDiagnostic, classifyAuthToken, summarizeDangerous, computeReadiness } from './scripts/doctor-checks.js';

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

  checks.push({ id: 'CONFIG_PERMS', status: ctx.configPermsProblems ? 'warn' : 'ok', detail: ctx.configPermsProblems ? `${ctx.configPermsProblems} 处权限过宽（应 0600）` : '配置文件权限 0600', safe: { problemCount: ctx.configPermsProblems || 0 } });

  checks.push({ id: 'CF_ACCESS', status: ctx.cfEnabled ? 'ok' : 'warn', detail: ctx.cfEnabled ? '已启用公网 2FA' : '未启用（回退纯 AUTH_TOKEN）', safe: { enabled: !!ctx.cfEnabled, audSet: !!ctx.cfAudSet } }); // AUD 仅布尔

  checks.push({ id: 'PUSH_VAPID', status: ctx.pushEnabled ? 'ok' : 'warn', detail: ctx.pushEnabled ? '已配置' : '未配置（推送优雅缺席）', safe: { enabled: !!ctx.pushEnabled } }); // 密钥仅布尔

  checks.push({ id: 'DEVICES', status: (ctx.pendingDevices || 0) > 0 ? 'warn' : 'ok', detail: `信任 ${ctx.trustedDevices || 0} 台 / 待批 ${ctx.pendingDevices || 0} 台`, safe: { trusted: ctx.trustedDevices || 0, pending: ctx.pendingDevices || 0 } });

  // 危险白名单：读合并 permissions.allow，危险条附 scope（让用户知道改哪个文件），非危险不列。
  const merged = readMergedPermissions({ home: ctx.home, workDirs: ctx.workDirs || [] });
  const sum = summarizeDangerous(merged.allow.map(a => a.rule));
  const dangerous = sum.dangerous.map(d => ({ rule: d.rule, reason: d.reason, scope: merged.allow.find(a => a.rule === d.rule)?.scope }));
  checks.push({ id: 'WHITELIST', status: dangerous.length ? 'warn' : 'ok', detail: dangerous.length ? `${dangerous.length} 条危险规则（共 ${sum.ruleCount} 条）` : `${sum.ruleCount} 条规则，无危险项`, safe: { ruleCount: sum.ruleCount, dangerous } });

  return { checks, readiness: computeReadiness(checks) };
}
