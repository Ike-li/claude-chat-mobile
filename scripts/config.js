#!/usr/bin/env node
// scripts/config.js —— 配置的命令行入口（headless 用户的唯一配置手段，也是 desktop 端的数据源）。
//
// 用法:
//   node scripts/config.js init                     # 生成 ccm.config.json（含随机 AUTH_TOKEN）
//   node scripts/config.js get [KEY] [--json] [--reveal]
//   node scripts/config.js set KEY=VAL [KEY=VAL...]
//   node scripts/config.js unset KEY [KEY...]
//   node scripts/config.js check                    # 校验现有配置（手写文件的唯一防线）
//   node scripts/config.js migrate                  # .env → ccm.config.json（含 workdirs 内联）
//   node scripts/config.js schema [--json]          # 表单描述，给 GUI 渲染
//
// ## 三条纪律
//
// 1. **判定全在 app/src/ops**（env-schema 的校验、config-file 的类型归一）。本文件只做参数解析、
//    IO 与呈现 —— 同 scripts/service.js ↔ app/src/ops/service-units.js 的分工。CLI 若自带一套判据，
//    「面板能存进去的值 CLI 存不进去」这类分叉是迟早的事。
//
// 2. **CLI 不是配置文件的特权通道。** 写入必须过 validateEnvChanges，挡住面板的东西照样挡住它。
//    立场是全或无：任何一项 error 就整体拒写，半生效的配置比不写更糟。
//
// 3. **secret 明文绝不默认离开进程。** get 只出「设了没 + 多长」，须显式 --reveal。
//    同 buildEnvView 的脱敏纪律与 CCMCore.swift 那条「刻意不拼 #token=」。
import { randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeOwnerOnlyFile } from '../app/src/files/file-security.js';
import {
  applyConfigChanges,
  CONFIG_FILE_NAME,
  CONFIG_SCHEMA_VERSION,
  loadConfigSources,
  migrateEnvValues,
  PASSTHROUGH_KEYS,
  projectToEnv,
  readConfigFileValues,
  reloadKindOf,
  structuredToStringValues,
} from '../app/src/ops/config-file.js';
import { isSerializableEnvValue } from '../app/src/ops/env-file.js';
import { resolveWorkdirsFilePath } from '../app/src/sessions/workdirs.js';
import { buildEnvView, ENV_SCHEMA, validateEnvChanges } from '../app/src/ops/env-schema.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const schemaDef = (key) => (Object.hasOwn(ENV_SCHEMA, key) ? ENV_SCHEMA[key] : null);
const isSecret = (def) => !!def?.secret || def?.kind === 'secret';

// ──────────────────────── 纯逻辑（可单测）────────────────────────

// ★ CLI 输入 → schema 类型。**刻意不复用 config-file.js 的 coerceToSchemaType。**
//
// 那个函数的输入是「.env / shell env 里的字面量」，方向由 TOGGLE_* 三套约定决定：
// WEB_STATUSLINE 默认开、只有 'off' 才算关。于是 coerce('false') 会得到 **true**
// （'false' !== 'off'）。而人在终端敲 `set WEB_STATUSLINE=false` 时意思毫无疑问是关掉 ——
// 复用它就是把 log-terminal.js:32 那个经典脚枪（`LOG_STDERR=false` 反而是开）搬到 CLI 层。
//
// 两个函数服务两种输入来源，必须分开。看不懂的值一律报错：猜错的后果是静默反向生效。
export function parseCliValue(key, raw) {
  const def = schemaDef(key);
  if (!def) return { error: `不认识的配置项 ${key}（本命令不是通用配置编辑器）` };
  if (def.kind === 'readonly') return { error: `${key} 只读：${def.help?.zh || ''}`.trim() };

  const s = String(raw ?? '').trim();

  if (def.kind === 'toggle') {
    const lower = s.toLowerCase();
    if (['true', 'on', 'yes', '1'].includes(lower)) return { value: true };
    if (['false', 'off', 'no', '0'].includes(lower)) return { value: false };
    return { error: `${key} 是开关，只接受 true/false（或 on/off、yes/no、1/0），收到：${raw}` };
  }

  if (def.kind === 'number') {
    const n = Number(s);
    if (s === '' || !Number.isInteger(n)) return { error: `${key} 必须是整数，收到：${raw}` };
    return { value: n };
  }

  if (def.kind === 'list') {
    // 逗号串**不猜**：含逗号的目录名会被静默裂成两个不存在的路径，而白名单多一个不存在的
    // 路径不会报错（realpath 校验只 warn-skip）。宁可要求显式 JSON。
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch {
      return { error: `${key} 需要 JSON 数组字面量，例如 '["/path/a","/path/b"]'` };
    }
    if (!Array.isArray(parsed)) return { error: `${key} 需要 JSON 数组，收到：${raw}` };
    return { value: parsed };
  }

  return { value: s };
}

// 参数解析。未知 flag 收集起来由上层拒绝——`--revael` 这种 typo 若被忽略，
// 用户会以为自己看到的是明文，实际拿到的是脱敏值。
export function parseConfigArgs(argv = []) {
  const out = { command: undefined, positionals: [], assignments: [], flags: {}, unknownFlags: [] };
  const KNOWN_FLAGS = new Set(['json', 'reveal', 'force', 'yes']);

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (KNOWN_FLAGS.has(name)) out.flags[name] = true;
      else out.unknownFlags.push(arg);
      continue;
    }
    if (out.command === undefined) {
      out.command = arg;
      continue;
    }
    // 只按**首个** `=` 切分：ntfy token 之类的值本身可能含 `=`。
    const eq = arg.indexOf('=');
    if (eq > 0) out.assignments.push([arg.slice(0, eq), arg.slice(eq + 1)]);
    else out.positionals.push(arg);
  }
  return out;
}

// 呈现单个值。secret 默认只出「设了没 + 多长」。
export function formatValueForDisplay(key, value, { reveal = false } = {}) {
  if (value === undefined || value === null) return '';
  if (isSecret(schemaDef(key)) && !reveal) {
    const len = String(value).length;
    return len > 0 ? `<已设置，${len} 字符>` : '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

// ──────────────────────── 命令实现（IO 注入）────────────────────────

const configPathOf = (dir) => join(dir, CONFIG_FILE_NAME);

function readStructured(dir) {
  const p = configPathOf(dir);
  if (!existsSync(p)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`${CONFIG_FILE_NAME} 解析失败：${err.message}`, { cause: err });
  }
  // 与 loadConfigSources 同一道检查。少了它，顶层是数组时 set 会写出
  // {"0":1,"1":2,"$schemaVersion":1,...} —— 读路径 fail-loud、写路径静默捣碎。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILE_NAME} 顶层必须是一个 JSON 对象`);
  }
  return parsed;
}

function writeStructured(dir, config, { write = writeOwnerOnlyFile } = {}) {
  write(configPathOf(dir), `${JSON.stringify(config, null, 2)}\n`);
}

// 结构化 changes → validateEnvChanges 认得的字符串态。
// list 原样传（P1b 已给它专门的分流），其余走 projectToEnv；投影成 null（= 该 key 的默认态）
// 时用空串，那对每个 toggle 恰好都是某一侧的合法字面量。
function toValidationShape(changes) {
  const out = {};
  for (const [key, value] of Object.entries(changes)) {
    if (schemaDef(key)?.kind === 'list') {
      out[key] = value;
      continue;
    }
    // ★ 保留 null 而不是折成 ''：null 在 validateEnvChanges 里是「删除」（跳过类型校验），
    // 而 '' 是「填了个空值」——后者会让 `set LOG_FILE=` 收到「必须是绝对路径」这种
    // 与意图完全无关的错误，且全或无会把同批次其他改动一起挡掉。
    // applyConfigChanges 对 null 与 '' 都按删除处理，所以写入侧语义不变。
    out[key] = projectToEnv(key, value);
  }
  return out;
}

// ★★ 写入前的配置源守卫 —— 本文件最重要的一道闸。
//
// 缺陷实录：读取侧走 loadConfigSources（**会回落 .env**），而写入侧的 readStructured 只认
// ccm.config.json。于是在一台只有 .env 的既有部署上 `config set PORT=4100` 会生成一份
// 只含 PORT 的新文件，而它优先级更高 —— 整份 .env 被遮蔽，重启后 AUTH_TOKEN / WORK_DIR /
// CCM_DATA_DIR / CF_ACCESS_* 全部消失：手机连不上、agent 作用域变成整个家目录、
// 数据孤儿化、公网 2FA 静默关闭。而 CLI 报的是「已写入 / 需重启生效」，重启正是引爆动作。
//
// 这与本文件头部第 2 条纪律「CLI 不是配置文件的特权通道」直接冲突：面板路径做对了
// （app.js 的 usingConfigJson 读写同源），新写的 CLI 反而成了那个能绕过一切的通道。
//
// 判据必须是「两个文件都看」，与 loadConfigSources 完全同源。--force 留给明确要覆盖的人。
function guardWriteTarget(dir, flags = {}) {
  if (existsSync(configPathOf(dir))) return null;        // 已迁移：正常写
  if (!existsSync(join(dir, '.env'))) return null;       // 全新安装：正常建
  if (flags.force) return null;                          // 用户明确要覆盖
  return `检测到 .env 但还没有 ${CONFIG_FILE_NAME}。现在写会生成一份只含本次改动的新配置，`
    + `而它的优先级高于 .env —— 里面的 AUTH_TOKEN / WORK_DIR / CCM_DATA_DIR 等会被整份遮蔽，`
    + `重启后手机将连不上。请先跑 migrate 完成迁移，或确认要丢弃 .env 再加 --force。`;
}

// 校验依赖：与 server 的 env:set 喂给 validateEnvChanges 的是同一组判据。
//
// 只有 probePort 被有意桩掉：它需要真连一次，而 CLI 常在 server 正跑着时运行，无条件探测
// 会把「自家 server 占着」误报成冲突（doctor D4 修过同一个 bug）。
//
// isWritable / isExecutable **不适用那条理由**——它们是纯 fs 判断，没有「自己干扰自己」的问题。
// 早前把这两个也一并桩成 `() => true`，于是 `config set CLAUDE_BIN=/etc/hosts` 被判「已写入」
// 且 `config check` 报「配置检查通过」，而手机面板对同一个值会以「文件不可执行」拒绝、
// server preflight 随后起不来。CLI 不是配置文件的特权通道，判据必须与面板同源。
const canAccessPath = (p, mode) => {
  try {
    accessSync(p, mode);
    return true;
  } catch {
    return false;
  }
};

const validationDeps = (current) => ({
  current,
  fileExists: existsSync,
  isWritable: p => canAccessPath(p, fsConstants.W_OK),
  isExecutable: p => canAccessPath(p, fsConstants.X_OK),
  probePort: () => false,
});

function cmdInit(dir, flags, io) {
  const guard = guardWriteTarget(dir, flags);
  if (guard) return { ok: false, problems: [guard] };
  if (existsSync(configPathOf(dir)) && !flags.force) {
    return { ok: false, problems: [`${CONFIG_FILE_NAME} 已存在（里面可能有正在用的 AUTH_TOKEN）。确认要重建再加 --force。`] };
  }
  const config = applyConfigChanges({}, { AUTH_TOKEN: generateToken() });
  writeStructured(dir, config, io);
  return {
    ok: true,
    messages: [
      `已生成 ${CONFIG_FILE_NAME}（权限 0600）`,
      '下一步：set WORK_DIR=<项目绝对路径>，然后跑 node scripts/doctor.js',
    ],
  };
}

function cmdGet(dir, positionals, flags) {
  const { values, source, error } = readConfigFileValues(dir);
  if (error) return { ok: false, problems: [error] };

  const structured = source === 'config' ? (readStructured(dir) ?? {}) : values;
  const wanted = positionals.length ? positionals : Object.keys(structured).filter(k => k !== '$schemaVersion');

  // 显式点名了一个不认识的 key 时报错。此前打印 `PROT=` 然后退 0 ——
  // 与 check 里「拼错的 key 是静默失效」的立场正好相反，而 get 恰恰是用来确认值的。
  if (positionals.length) {
    const unknown = wanted.filter(k => !schemaDef(k) && !PASSTHROUGH_KEYS.includes(k));
    if (unknown.length) {
      return { ok: false, problems: unknown.map(k => `不认识的配置项 ${k}`) };
    }
  }

  const rows = wanted.map(key => ({
    key,
    value: formatValueForDisplay(key, structured[key], { reveal: !!flags.reveal }),
    reload: reloadKindOf(key),
  }));
  return { ok: true, data: { source, rows }, messages: rows.map(r => `${r.key}=${r.value}`) };
}

function cmdSet(dir, assignments, io, flags = {}) {
  if (!assignments.length) return { ok: false, problems: ['用法：set KEY=VAL [KEY=VAL...]'] };
  const guard = guardWriteTarget(dir, flags);
  if (guard) return { ok: false, problems: [guard] };

  // ① CLI 层解析：把人写的 true/false/JSON 转成 schema 类型
  const changes = {};
  const problems = [];
  for (const [key, raw] of assignments) {
    const parsed = parseCliValue(key, raw);
    if (parsed.error) problems.push(parsed.error);
    else changes[key] = parsed.value;
  }
  if (problems.length) return { ok: false, problems };

  // ② 与面板同一份校验。CLI 不是特权通道。
  //
  // 校验用**字符串态**、写入用结构化：validateEnvChanges 是按 .env 时代写的，除 list 外
  // 一律要求字符串（`typeof value !== 'string'` 直接判错）。与其为 CLI 再写一套判据
  // ——那正是「面板能存的值 CLI 存不进去」这类分叉的来源——不如在边界上投影一次。
  const current = structuredToStringValues(readStructured(dir) ?? {});
  const verdict = validateEnvChanges(toValidationShape(changes), validationDeps(current));
  const errors = verdict.results.filter(r => r.level === 'error');
  if (errors.length) return { ok: false, problems: errors.map(r => `${r.key}: ${r.message}`) };

  // ③ 全或无：走到这里才写盘，一个 error 都不能落地半份配置
  const next = applyConfigChanges(readStructured(dir) ?? {}, changes);
  writeStructured(dir, next, io);

  const keys = Object.keys(changes);
  const restartRequired = keys.filter(k => reloadKindOf(k) === 'restart').sort();
  return {
    ok: true,
    restartRequired,
    warnings: verdict.results.filter(r => r.level === 'warn').map(r => `${r.key}: ${r.message}`),
    messages: [
      `已写入 ${keys.length} 项：${keys.join(', ')}`,
      ...(restartRequired.length
        ? [`需重启 server 才生效：${restartRequired.join(', ')}`]
        : ['全部为热加载项，改完即生效']),
    ],
  };
}

function cmdUnset(dir, positionals, io, flags = {}) {
  if (!positionals.length) return { ok: false, problems: ['用法：unset KEY [KEY...]'] };
  const guard = guardWriteTarget(dir, flags);
  if (guard) return { ok: false, problems: [guard] };
  const current = readStructured(dir);
  if (!current) return { ok: false, problems: [`${CONFIG_FILE_NAME} 不存在`] };

  const changes = Object.fromEntries(positionals.map(k => [k, null]));

  // ★ 删除同样要过校验，与 set 用同一份判据。
  // env-schema 特意把 readonly 判断放在 `value === null` 之前，就是为了让「删除只读项」也被拦；
  // checkTogether 会认出「CF_ACCESS_* 只剩 2/3」；checkCfAccessTeardown 会对拆除公网 2FA 出 warn。
  // 此前这条路径完全不过校验 —— 实测 `unset AUTH_TOKEN` 直接删成功，而同一个 key 用 set 会被拒绝。
  const verdict = validateEnvChanges(changes, validationDeps(structuredToStringValues(current)));
  const errors = verdict.results.filter(r => r.level === 'error');
  if (errors.length) return { ok: false, problems: errors.map(r => `${r.key}: ${r.message}`) };

  writeStructured(dir, applyConfigChanges(current, changes), io);
  const restartRequired = positionals.filter(k => reloadKindOf(k) === 'restart').sort();
  return {
    ok: true,
    restartRequired,
    warnings: verdict.results.filter(r => r.level === 'warn').map(r => `${r.key}: ${r.message}`),
    messages: [`已删除：${positionals.join(', ')}`],
  };
}

function cmdMigrate(dir, flags, io) {
  if (existsSync(configPathOf(dir)) && !flags.force) {
    return { ok: false, problems: [`${CONFIG_FILE_NAME} 已存在——迁移不是覆盖。确认要重建再加 --force。`] };
  }
  const envPath = join(dir, '.env');
  if (!existsSync(envPath)) {
    return { ok: false, problems: ['没有找到 .env，无需迁移。全新安装请用 init。'] };
  }

  const { fileValues } = loadConfigSources({ dir, configName: '__none__' }); // 强制走 .env 分支

  // 外部 workdirs.json 一并内联：留着它是最糟的中间态 —— 内联的 WORKDIRS 优先级更高，
  // 那个还躺在盘上的文件会变成「看起来是事实源、实际已失效」，下次排障必被误导。
  let workdirsEntries;
  if (fileValues.WORK_DIRS_FILE) {
    // 用仓库既有的解析器：裸 join 对绝对路径会拼成 <dir>/tmp/... 读不到，
    // 于是落进「读不出来，已原样保留」分支 —— 告警把用户引向一个根本没坏的文件。
    // server preflight / 热加载 / doctor D3 三处都用这个函数，migrate 是唯一漏的。
    const wp = resolveWorkdirsFilePath(fileValues.WORK_DIRS_FILE, dir);
    try {
      const parsed = JSON.parse(readFileSync(wp, 'utf8'));
      workdirsEntries = Array.isArray(parsed) ? parsed : null;
    } catch {
      workdirsEntries = null; // 读不出来 → migrateEnvValues 会保留原 key 并告警
    }
  }

  const { config, warnings } = migrateEnvValues(fileValues, { workdirsEntries });
  writeStructured(dir, config, io);
  return {
    ok: true,
    warnings,
    messages: [
      `已迁移到 ${CONFIG_FILE_NAME}（权限 0600）`,
      // 不删原文件：迁移出错时用户还得靠它回滚，删掉等于把退路一起拿走。
      '原 .env 已保留且不再被读取；确认服务正常后可自行删除。',
      '下一步：node scripts/doctor.js 确认配置被正确识别，然后重启 server。',
    ],
  };
}

// check 存在的主要理由：**手写文件绕过了写入侧的全部校验**。
// 面板与 set 都过 validateEnvChanges，而用编辑器直接改的人没有任何防线。
function cmdCheck(dir) {
  const problems = [];
  const warnings = [];
  const { values, source, error } = readConfigFileValues(dir);
  if (error) return { ok: false, problems: [error] };
  if (source === 'none') return { ok: false, problems: ['没有找到配置文件（ccm.config.json 或 .env）。跑 init 生成。'] };

  if (source === 'config') {
    const structured = readStructured(dir) ?? {};
    const changes = {};
    for (const [key, value] of Object.entries(structured)) {
      if (key === '$schemaVersion') continue;
      const def = schemaDef(key);
      if (!def) {
        // passthrough 项（CCM_DATA_DIR 等）不在 ENV_SCHEMA 里但完全合法，别报成拼写错误
        if (PASSTHROUGH_KEYS.includes(key)) continue;
        // ★ 提出来但**不判红**。判据必须与读取侧同源：resolveConfigValues 是有意宽容的，
        // 它把未登记 key 原样传给 server 与 claude 子进程，并发一句一模一样的 warning
        // （config-file.js:191 及其上方那段注释）。migrate 也照迁。
        // 早前这里 push 进 problems，于是：`.env` 里有 HTTPS_PROXY → migrate 成功 →
        // check exit 1 说「server 永远读不到它」，而同一份文件 config get 打得出、server 也
        // 确实读得到——一句与运行时事实相反的解释，外加一个红的 npm run config:check。
        // 拼错的 key（AUTH_TOEKN）与有意的第三方变量在这里无法自动区分，所以只陈述、不裁决。
        warnings.push(`${key} 未登记在配置 schema 内，会被原样传给 server 与 claude 子进程（若是拼错的 key，它就是这样静默失效的）`);
        continue;
      }
      // readonly 的含义是「不能从面板改」，不是「值非法」。check 校验的是现有配置合不合法，
      // 把 AUTH_TOKEN 这类项当错误报出来，会让每一份正常配置都检查不通过。
      if (def.kind === 'readonly') continue;
      changes[key] = value;
    }
    const verdict = validateEnvChanges(toValidationShape(changes), validationDeps(structuredToStringValues(structured)));
    for (const r of verdict.results.filter(x => x.level === 'error')) problems.push(`${r.key}: ${r.message}`);
  } else {
    // 旧格式特有的两个转义地雷。JSON 没有这个失败模式，所以只在这条分支查。
    for (const [key, value] of Object.entries(values)) {
      if (isSerializableEnvValue(value)) continue;
      problems.push(String(value).endsWith('\\')
        ? `${key}: 值以反斜杠结尾——dotenv 会把它与结尾引号读成转义，从而吞掉 .env 里后面的配置项`
        : `${key}: 值含单引号，.env 无法安全表达（迁移到 ccm.config.json 即可解决）`);
    }
  }

  return problems.length
    ? { ok: false, problems, warnings }
    : { ok: true, warnings, messages: [`配置检查通过（${source === 'config' ? CONFIG_FILE_NAME : '.env'}）`] };
}

// schema 是**表单描述**，不是配置快照：GUI 拿它渲染控件，不该顺带拿到 secret 明文。
// 传空 values 而不是当前配置 —— 值由 get 命令单独取（且默认脱敏）。
//
// 不带 --json 时输出人类可读的配置项清单。这份清单**从 ENV_SCHEMA 生成**，所以永远不会与
// 代码分叉 —— 曾经的 .env.example 那 123 行注释是手写的第二事实源，加配置项必须记得同步它，
// 正因如此 2026-08-17 已随旧格式生成能力一并退役，schema 自此是配置项文档的唯一出处。
function cmdSchema() {
  const view = buildEnvView({});
  const lines = [];
  for (const group of view.groups) {
    if (!group.items.length) continue;
    lines.push('', `【${group.label.zh}】`);
    for (const item of group.items) {
      // ★ 判据用 kind 而不是 item.readonly：后者是**给手机面板的**渲染提示，list 项被标成
      // readonly 只是因为前端没有数组编辑器。在 CLI 上照搬会告诉用户「WORKDIRS 只读」——
      // 而他此刻正拿着能改它的那个命令。
      const tags = [
        item.kind === 'readonly' ? '只读' : null,
        item.kind === 'list' ? '仅 CLI / 桌面端可改' : null,
        item.default !== undefined ? `默认 ${item.default}${item.unit || ''}` : null,
        reloadKindOf(item.key) === 'hot' ? '热加载' : null,
      ].filter(Boolean);
      lines.push(`  ${item.key.padEnd(24)} ${item.label.zh}${tags.length ? `  [${tags.join(' · ')}]` : ''}`);
      if (item.help?.zh) lines.push(`  ${' '.repeat(24)} ${item.help.zh}`);
    }
  }
  for (const d of view.readonlyDiagnostics) {
    lines.push('', `【只读诊断】${d.key} —— ${d.label.zh}`, `  ${d.help.zh}`);
  }
  return {
    ok: true,
    data: { schemaVersion: CONFIG_SCHEMA_VERSION, ...view },
    messages: lines,
  };
}

const USAGE = [
  '用法:',
  '  node scripts/config.js init [--force]              # 生成配置文件（含随机 AUTH_TOKEN）',
  '  node scripts/config.js get [KEY...] [--json] [--reveal]',
  '  node scripts/config.js set KEY=VAL [KEY=VAL...]',
  '  node scripts/config.js unset KEY [KEY...]',
  '  node scripts/config.js check                       # 校验现有配置',
  '  node scripts/config.js migrate [--force]           # .env → ccm.config.json',
  '  node scripts/config.js schema [--json]             # 表单描述（供 GUI）',
].join('\n');

export function runConfigCommand(args, { dir = ROOT, ...io } = {}) {
  const { command, positionals, assignments, flags = {}, unknownFlags = [] } = args;
  if (unknownFlags.length) return { ok: false, problems: [`无法识别的参数：${unknownFlags.join(' ')}`], usage: USAGE };

  try {
    switch (command) {
      case 'init': return cmdInit(dir, flags, io);
      case 'get': return cmdGet(dir, positionals, flags);
      case 'set': return cmdSet(dir, assignments, io, flags);
      case 'unset': return cmdUnset(dir, positionals, io, flags);
      case 'migrate': return cmdMigrate(dir, flags, io);
      case 'check': return cmdCheck(dir);
      case 'schema': return cmdSchema();
      default: return { ok: false, problems: [command ? `未知命令：${command}` : '缺少命令'], usage: USAGE };
    }
  } catch (err) {
    return { ok: false, problems: [String(err?.message || err)] };
  }
}

// ──────────────────────── CLI 外壳 ────────────────────────

function main() {
  const args = parseConfigArgs(process.argv.slice(2));
  const result = runConfigCommand(args);

  if (args.flags.json) {
    // 形状统一：**永远**带 ok。此前 get/schema 直接吐 data（无 ok 字段），
    // 而其余五个命令吐整个 result（有 ok）——按 .ok 判断的消费方会把成功当失败。
    console.log(JSON.stringify({ ok: result.ok, ...(result.data ?? {}), ...(result.data ? {} : result) }, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  for (const m of result.messages ?? []) console.log(m);
  for (const w of result.warnings ?? []) console.warn(`⚠️  ${w}`);
  for (const p of result.problems ?? []) console.error(`✗ ${p}`);
  if (result.usage) console.error(`\n${result.usage}`);
  process.exit(result.ok ? 0 : 1);
}

// 仅直接运行时执行；被测试 import 时不跑。
// 不能只比字符串：node 加载模块时会解析符号链接，import.meta.url 可能是 realpath 而 argv[1]
// 是调用者原样传进来的（macOS 的 /var → /private/var 就会踩到）。两者不等时 main 从不执行、
// 命令静默退出 0 什么都不做 —— 同 scripts/setup.js:290 的教训，实现也照它。
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  if (self === resolve(process.argv[1])) return true;
  try {
    return self === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
