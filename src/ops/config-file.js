// config-file.js —— 统一配置文件 ccm.config.json 的读取、类型归一与优先级合并。
//
// ## 为什么从 .env 换成 JSON
//
// `.env` 有**两个**消费者：dotenv（server 读）与 shell（用户 `source .env` 调试）。两边转义规则
// 不同却必须同时满足，而这个仓库为此付出过两次 fail-open 事故（值含单引号 / 以 `\` 结尾时
// dotenv 与 shell 解析分叉，详见 src/ops/env-file.js 的长注释）。防线是一整套字符白名单
// （BARE_SAFE）+ 拿 dotenv parser 当 oracle 的 round-trip property test。
//
// 换成 JSON 之后这一整类问题**不是被修好，是不再存在** —— JSON.stringify 正确转义一切，
// 且没有第二个消费者。同理消失的还有三套 toggle 真值字面量（env-schema.js:26-28 的
// TOGGLE_ONE/OFF/ON），它们的根因只是「.env 只能存字符串」；JSON 里 true 就是 true。
//
// ## 但字面量转换一天都省不掉
//
// shell env 仍然只能传字符串，而优先级链要求 shell 能覆盖文件值。所以 coerceToSchemaType /
// projectToEnv 这对函数是**跨越两种世界的边界**，不是历史包袱。方向由「哪一侧字面量是空串」
// 决定而不是由字面量本身 —— 见 toggleLiterals 的注释。
//
// ## 为什么保留 projectToEnv（投影回 process.env）
//
// P1a 的目标是零破坏：类型化只发生在配置层内部，现有那 7 处消费点
// （app.js:1229/2688/841/1136/1142/1074、config.js:65、log-terminal.js:33）继续读
// process.env 的字符串，一行不改。等 P1b/P1c 把消费点逐个迁到结构化值，这层投影才退场。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import dotenv from 'dotenv';

import { ENV_SCHEMA } from './env-schema.js';

// 跨语言契约版本：desktop app 与 CLI 都按它判断能不能解码这份配置。
// 与 scripts/service.js 的 STATUS_SCHEMA_VERSION 同一心智。
export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_FILE_NAME = 'ccm.config.json';

// 版本键用 `$` 前缀而不是 `_version`：它不是配置项，前缀让它在 schema 白名单校验里
// 一眼可辨，也不可能与未来某个真配置项撞名（env key 不允许 `$`）。
const VERSION_KEY = '$schemaVersion';

// ENV_SCHEMA 只收「UI 上可改的」配置项，但 .env 里还有几个**真实被消费、只是不该出现在设置面板**
// 的 key。它们必须原样透传：按 schema 白名单一刀切的话，用户的 CCM_DATA_DIR 会在迁移时消失，
// 后果是全部会话 / 设备信任 / 审批台账一次性孤儿化 —— 而且报的是「迁移成功」。
//
// 之所以是显式名单而不是「非大写开头就放行」：白名单要求每个新 key 被有意识地归类一次，
// 而 tests/unit/config-file.test.mjs 有一条断言拿 .env.example 与这里做差集，忘了登记会红。
export const PASSTHROUGH_KEYS = Object.freeze([
  'CCM_DATA_DIR',        // src/shared/data-dir.js —— 改它是迁移不是设置，故意不进 UI
  'WORK_DIRS',           // src/server/app.js:180 —— 逗号分隔的内联工作区（P1b 并入结构化 WORKDIRS）
  'CLI_HOOKS_DIR',       // src/ops/cli-hooks-bridge.js:51
  'CLI_STATUSLINE_DIR',  // src/server/app.js:1078
]);

const isPassthrough = (key) => PASSTHROUGH_KEYS.includes(key);

const schemaDef = (key) => (Object.hasOwn(ENV_SCHEMA, key) ? ENV_SCHEMA[key] : null);

// ── toggle 的方向推导 ────────────────────────────────────────────────────────
//
// 三套字面量约定里，**空串那一侧就是默认值那一侧**，因为 config.js:31-33 的 SH-001 会把空串
// 当作「未设置」删掉 —— 一个值永远写不进 .env 的开关，只可能是默认态。
//
//   TOGGLE_ONE {on:'1',  off:''}    → off 空 → 默认关，只有 '1' 是开   （DEV_MODE / LOG_*）
//   TOGGLE_OFF {on:'',   off:'off'} → on 空  → 默认开，只有 'off' 是关 （WEB_STATUSLINE / FILE_EDIT / CLI_*）
//   TOGGLE_ON  {on:'on', off:''}    → off 空 → 默认关，只有 'on' 是开  （LOG_TERMINAL）
//
// 这与消费点的判据严格对应（`=== '1'` / `=== 'off'` / `!== 'on'`）。**别改成统一 truthy 判定**：
// log-terminal.js:32 记着那个经典脚枪 —— truthy 下 `LOG_STDERR=false` 反而是「开」，
// 因为 'false' 是个非空字符串。
function toggleDefaultsOn(def) {
  return def.values.on === '';
}

// 外部字符串 → schema 声明的 JS 类型。**手写文件要容错，但类型必须归一**。
// 转不动的值原样返回，交给 env-schema 的校验层去报错 —— 这里猜一个值出来，
// 用户看到的会是「我明明写了 X，怎么生效的是 Y」。
export function coerceToSchemaType(key, raw) {
  const def = schemaDef(key);
  if (!def) return { value: raw, warning: null };

  if (def.kind === 'toggle') {
    if (typeof raw === 'boolean') return { value: raw, warning: null };
    const s = String(raw ?? '');
    const value = toggleDefaultsOn(def) ? s !== def.values.off : s === def.values.on;
    return { value, warning: `${key}：字符串 ${JSON.stringify(s)} 已按开关语义读作 ${value}` };
  }

  if (def.kind === 'number') {
    if (typeof raw === 'number') return { value: raw, warning: null };
    const s = String(raw ?? '').trim();
    const n = Number(s);
    if (s !== '' && Number.isFinite(n)) {
      return { value: n, warning: `${key}：字符串 ${JSON.stringify(s)} 已读作数字 ${n}` };
    }
    return { value: raw, warning: null };
  }

  // list 不做任何形状猜测：把逗号串拆成数组听起来友好，但那会让「一个含逗号的目录名」
  // 静默裂成两个不存在的路径。非数组原样下传，由 workdirs.js 的 normalizeWorkdirEntries
  // 出具体的 warn-skip 理由（它本来就是这批数据的唯一校验者）。
  if (def.kind === 'list') {
    return { value: raw, warning: null };
  }

  return { value: raw, warning: null };
}

// 这个 key 改了要不要重启。**缺省 restart 是刻意的保守方向**：误报重启只是让用户多操作一次，
// 漏报则是「改了没生效还以为生效了」—— 与本仓一贯的 fail-closed 立场一致。
export function reloadKindOf(key) {
  return schemaDef(key)?.reload === 'hot' ? 'hot' : 'restart';
}

// 两份配置的差异按 reload 类别分组。热加载路径据此决定：能就地应用，还是只能提示需重启。
export function diffReloadKinds(prev = {}, next = {}) {
  const hot = [];
  const restart = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);

  for (const key of keys) {
    if (key === VERSION_KEY) continue;
    // 深比较：热加载每次都重读文件，数组/对象必然是新引用，按引用比会把「没改」判成「改了」，
    // 于是每次文件事件都广播一轮，前端目录面板反复重建。
    if (JSON.stringify(prev[key]) === JSON.stringify(next[key])) continue;
    (reloadKindOf(key) === 'hot' ? hot : restart).push(key);
  }

  return { hot: hot.sort(), restart: restart.sort() };
}

// schema 类型 → process.env 字符串。返回 null 表示**不设这个 key**。
//
// 空串一律折叠成 null：SH-001 立场是「空串 ≡ 未设置」，留一行 `KEY=` 既无意义，
// 又会挡住从 shell export 同名变量。
export function projectToEnv(key, value) {
  const def = schemaDef(key);
  if (!def) {
    // passthrough 项没有 schema 声明，按字符串原样投影（空串仍折叠成 null）。
    const s = String(value ?? '');
    return isPassthrough(key) && s !== '' ? s : null;
  }

  if (def.kind === 'toggle') {
    const literal = value ? def.values.on : def.values.off;
    return literal === '' ? null : literal;
  }
  if (def.kind === 'number') {
    return value == null ? null : String(value);
  }
  // list **明确放弃投影**，不是遗漏。投成字符串的话，app.js:191 的
  // `(process.env.WORK_DIRS || '').split(',')` 会把 "[object Object]" 当目录名塞进白名单；
  // 而 realpath 校验失败只 warn-skip，用户看不到任何异常。消费方必须直接读结构化配置。
  if (def.kind === 'list') return null;
  const s = String(value ?? '');
  return s === '' ? null : s;
}

// 优先级链：shell env > 配置文件 > 内置默认（默认值不在这里填，由各消费点的 ?? 负责，
// 与 parseServerConfig 现有分工一致）。
//
// 这条链与 dotenv 的「不覆盖已存在 key」语义等价 —— 换格式不改变谁赢。
export function resolveConfigValues({ fileValues = {}, shellEnv = {} } = {}) {
  const values = {};
  const warnings = [];

  for (const [key, raw] of Object.entries(fileValues)) {
    if (key === VERSION_KEY) continue;
    // 模型网关配置只认真实 shell export（env-schema.js:14-16 的硬边界）。写进文件是静默失效，
    // 剥除并明说比让用户以为配好了强。
    if (key.startsWith('ANTHROPIC_')) {
      warnings.push(`已忽略配置文件里的 ${key}：ANTHROPIC_* 只能从启动 shell export`);
      continue;
    }
    if (isPassthrough(key)) {
      values[key] = raw;
      continue;
    }
    if (!schemaDef(key)) {
      warnings.push(`已忽略未知配置项 ${key}（本文件不是通用配置编辑器）`);
      continue;
    }
    const { value, warning } = coerceToSchemaType(key, raw);
    if (warning) warnings.push(warning);
    values[key] = value;
  }

  for (const [key, raw] of Object.entries(shellEnv)) {
    if (raw === '' || raw == null) continue; // 空串 ≡ 未设置
    if (key.startsWith('ANTHROPIC_') || isPassthrough(key)) {
      values[key] = raw;
      continue;
    }
    // shell 里本来就有一堆与本项目无关的变量，不认识就跳过，**不 warn**。
    if (!schemaDef(key)) continue;
    // shell 只能传字符串，这里的类型转换是常态而非异常 —— 丢弃 warning。
    values[key] = coerceToSchemaType(key, raw).value;
  }

  return { values, warnings };
}

// 读盘：新文件优先，缺失时回落 .env。
//
// **坏 JSON 必须 fail-loud。** 回落到空配置会让 server 以「未设 AUTH_TOKEN」启动，
// 而 app.js:3152 会据此把监听地址从 0.0.0.0 悄悄降级成 127.0.0.1 —— 手机全部连不上，
// 却没有任何错误信息。这正是「配置层出错要吵，不要静默降级」的典型。
export function loadConfigSources({ dir, configName = CONFIG_FILE_NAME, envName = '.env' } = {}) {
  const configPath = join(dir, configName);
  const envPath = join(dir, envName);
  const warnings = [];

  if (existsSync(configPath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`${configName} 解析失败（${err.message}）——修好它，或删掉让 config init 重建`, { cause: err });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${configName} 顶层必须是一个 JSON 对象`);
    }
    if (existsSync(envPath)) {
      warnings.push(`检测到旧的 .env，已被 ${configName} 取代并忽略；确认无误后可删除`);
    }
    return { source: 'config', fileValues: parsed, path: configPath, warnings };
  }

  if (existsSync(envPath)) {
    warnings.push(`正在读取旧格式 .env —— 跑 config migrate 转成 ${configName}`);
    return { source: 'env', fileValues: dotenv.parse(readFileSync(envPath)), path: envPath, warnings };
  }

  // 全新安装是正常状态，不该报警。
  return { source: 'none', fileValues: {}, path: null, warnings: [] };
}

// 配置文件变更的处理器：持快照、算差异、按 reload 类别分派。
//
// IO 全部注入（readConfig 由调用方给），所以这层在宿主机零成本可测 —— 上一次同类改造的复盘
// 写在 service-sampler.js:10：判定层测得不错，出问题的**全是 glue**，因为 glue 住在 app.js 里、
// 进不去单测。
//
// readConfig 返回 null 表示读失败：**保留旧快照**，与 reloadWorkdirs 的「读取失败保留旧白名单」
// 同一立场。把 null 当空配置的话，一次编辑器写到一半的读取会把整个白名单判成「全部删除」。
export function createConfigReloader({ readConfig, onHot, onRestart }) {
  let snapshot = null;

  const refresh = () => {
    const next = readConfig();
    if (next === null || next === undefined) return null;
    return next;
  };

  return {
    // 启动时调一次，建立基线。不调也不会炸：空快照下首次变更把所有项算作新增。
    prime() {
      const next = refresh();
      if (next !== null) snapshot = next;
    },
    handleChange() {
      const next = refresh();
      if (next === null) return;
      const { hot, restart } = diffReloadKinds(snapshot ?? {}, next);
      snapshot = next;
      // 顺序要紧：先推进快照再回调，回调里抛错也不会让下一次事件重复处理同一批变更。
      if (hot.length) onHot?.(hot);
      if (restart.length) onRestart?.(restart);
    },
  };
}

// 结构化配置 → 字符串态，供 buildEnvView / validateEnvChanges 消费。
//
// 那两个函数是按 .env 时代的字符串态写的（PORT 比较、checkTogether、CF_ACCESS 拆除告警全是
// 字符串判断）。与其为 JSON 再写一套校验（两套判据分叉正是本仓踩过的坑），不如在边界上投影一次。
// 前端行为因此完全不变：toggle 仍按 `value === values.on` 渲染，而默认态投影成缺席 ≡ 空串 ≡ on 侧。
export function structuredToStringValues(structured = {}) {
  const out = {};
  for (const [key, value] of Object.entries(structured)) {
    if (key === VERSION_KEY) continue;
    const s = projectToEnv(key, value);
    if (s !== null) out[key] = s;
  }
  return out;
}

// 写入侧：把一批 changes 合并进现有配置，返回**新对象**（不就地改，调用方可以先 dry-run 比对）。
//
// changes 的值有三种形态，全部要接：
//   · 字符串   —— 设置面板发来的（前端表单只有字符串），按 schema 类型归一
//   · 原生类型 —— CLI 与 desktop 直接发结构化值
//   · null/''  —— 删除。空串 ≡ 未设置（SH-001），留一个空值占位既无意义又会挡住 shell export
export function applyConfigChanges(current = {}, changes = {}) {
  const next = { ...current, [VERSION_KEY]: CONFIG_SCHEMA_VERSION };

  for (const [key, raw] of Object.entries(changes)) {
    if (raw === null || raw === undefined || raw === '') {
      delete next[key];
      continue;
    }
    next[key] = isPassthrough(key) ? raw : coerceToSchemaType(key, raw).value;
  }

  return next;
}

// CLI 侧的配置读取入口（doctor / service / device / hooks-setup 共用）。
//
// 这些工具不走 server.js 的启动路径，各自 readFileSync('.env') 了很久。setup.js 一改默认格式，
// 它们全都会对着一个不存在的文件工作 —— 新装用户跑 doctor 会被告知「未设置 AUTH_TOKEN」，
// 照着改还是没用。
//
// 返回**字符串态**：调用方拿它当 env 用（拼 manifest 路径、判端口、灌 process.env）。
// list 类型不在其中（投影不回去），需要工作区列表的调用方走 readConfigFileRaw。
//
// **不抛异常**：doctor 的职责就是诊断坏配置，崩掉等于什么都报不了。但也不静默当空 ——
// 那会把「文件坏了」误诊成「没配过」。坏文件走 error 出口，由调用方决定怎么呈现。
export function readConfigFileValues(dir, { envFile } = {}) {
  try {
    if (envFile) {
      return { values: dotenv.parse(readFileSync(envFile)), source: 'env', path: envFile, error: null };
    }
    const { fileValues, source, path } = loadConfigSources({ dir });
    if (source !== 'config') return { values: fileValues, source, path, error: null };
    const { values } = resolveConfigValues({ fileValues, shellEnv: {} });
    return { values: structuredToStringValues(values), source, path, error: null };
  } catch (err) {
    return { values: {}, source: 'error', path: null, error: String(err?.message || err) };
  }
}

// 结构化原文（含 list）。需要工作区列表的调用方用它 —— doctor 的 D3 要检查 WORKDIRS 里的每个目录。
export function readConfigFileRaw(dir) {
  try {
    const { fileValues, source } = loadConfigSources({ dir });
    return source === 'config' ? fileValues : null;
  } catch {
    return null;
  }
}

// 工作区三条旧路径 → 统一的 WORKDIRS 数组（P1b）。
//
// 迁移后只留一条路径。留着旧 key 是最糟的中间态：用户在面板里改 WORKDIRS（内联的优先级最高），
// 而那个仍然存在的 workdirs.json 变成一份「看起来是事实源、实际已失效」的文件 —— 下次排障
// 必然被它误导。
//
// workdirsEntries === null 表示外部文件读不出来：**保留 WORK_DIRS_FILE 并告警**，不静默丢弃。
// 丢掉的后果是用户迁移后只剩 WORK_DIR 一个工作区，而迁移过程报的是成功。
function foldWorkdirs(config, envValues, workdirsEntries, warnings) {
  if (envValues.WORK_DIRS_FILE) {
    if (Array.isArray(workdirsEntries)) {
      config.WORKDIRS = workdirsEntries;
      delete config.WORK_DIRS_FILE;
      delete config.WORK_DIRS; // 文件优先，与 app.js 的既有优先级一致
      warnings.push(`已把 ${envValues.WORK_DIRS_FILE} 的 ${workdirsEntries.length} 个工作区内联进 WORKDIRS，该文件不再被读取（可自行删除）`);
    } else {
      warnings.push(`WORK_DIRS_FILE 指向的文件读不出来，已原样保留 —— 请手工确认工作区列表后再删除它`);
    }
    return;
  }

  if (envValues.WORK_DIRS) {
    // 按逗号拆分是**保真**的：旧格式本来就以逗号分隔，含逗号的路径在旧格式下同样不被支持。
    config.WORKDIRS = envValues.WORK_DIRS.split(',').map(s => s.trim()).filter(Boolean);
    delete config.WORK_DIRS;
    warnings.push(`WORK_DIRS 已拆成 WORKDIRS 数组（${config.WORKDIRS.length} 个工作区）`);
  }
}

// .env 的字符串态 → 结构化配置。丢弃的每一项都要报出来：用户得知道自己那行去哪了。
export function migrateEnvValues(envValues = {}, { workdirsEntries } = {}) {
  const config = { [VERSION_KEY]: CONFIG_SCHEMA_VERSION };
  const warnings = [];

  for (const [key, raw] of Object.entries(envValues)) {
    if (raw === '' || raw == null) continue; // 空串 ≡ 未设置，不迁成空值
    if (key.startsWith('ANTHROPIC_')) {
      warnings.push(`${key} 未迁移：ANTHROPIC_* 只认真实 shell export，写进配置文件是静默失效`);
      continue;
    }
    if (isPassthrough(key)) {
      config[key] = raw;
      continue;
    }
    if (!schemaDef(key)) {
      warnings.push(`${key} 未迁移：不在配置 schema 内`);
      continue;
    }
    config[key] = coerceToSchemaType(key, raw).value;
  }

  foldWorkdirs(config, envValues, workdirsEntries, warnings);

  return { config, warnings };
}
