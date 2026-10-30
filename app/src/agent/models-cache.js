// models-cache.js —— 按 cwd 归键的「可用模型清单 / 斜杠命令」缓存。
//
// 为什么按 cwd（而非单个全局）：模型清单来自 SDK supportedModels()，而 agent 用
// settingSources:['user','project','local'] 起 query——工作区 .claude/settings.local.json 的 env 块
// 可覆盖 ANTHROPIC_BASE_URL / ANTHROPIC_DEFAULT_*_MODEL，改写网关与自定义模型名（如某区映射
// opus→deepseek-v4-pro[1m]）。故模型清单是【随工作区变】的量，绝非账号级全局。单全局缓存会把上个
// 工作区的模型泄漏进当前工作区视图（实测 bug：切到 claude-chat-mobile 点新会话冒出 deepseek 名）。
// 斜杠命令同理：init.slash_commands 含 project/local skill，跨 cwd 重放会串仓。
// 同 cwd 多会话共享同一 settings → 同一清单，故 cwd 是正确的归键维度（同 lastInit 的 per-cwd 治理）。
//
// 有界：cwd 数受 workDirs 白名单约束（通常 < 20），仍设上限防御异常增长；超限淘汰最旧（LRU-on-write）。
// 可序列化：toJSON/load 跨重启持久化进 data/init-cache.json（缓存可弃，损坏即当空）。

import { setLru } from '../shared/bounded-map.js';

// 通用 per-cwd 有界 Map。models / slashCommands 共用同一形状（cwd → payload）。
export function createCwdKeyedCache({ max = 32 } = {}) {
  const byCwd = new Map(); // cwd → payload

  return {
    // 记录某 cwd 的 payload。cwd 落空（未知工作区）直接忽略——绝不存进无键桶。
    set(cwd, payload) {
      if (!cwd) return;
      // 写入即刷新到尾部（最近使用）；超上限淘汰最久未写的——LRU-on-write。
      setLru(byCwd, cwd, payload, max);
    },
    // 取某 cwd 的 payload；未知 cwd 返回 null——诚实的「不知道」，绝不回退别区清单（那正是 bug）。
    get(cwd) {
      return cwd && byCwd.has(cwd) ? byCwd.get(cwd) : null;
    },
    toJSON() {
      return Object.fromEntries(byCwd);
    },
    // 从持久化对象灌入。非「cwd→payload」对象（null/数组/字符串/损坏）一律安全忽略，不抛。
    load(obj) {
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [cwd, payload] of Object.entries(obj)) this.set(cwd, payload);
      }
    },
    get size() { return byCwd.size; },
    delete(cwd) { byCwd.delete(cwd); },
  };
}

// 模型清单缓存（历史 API 名保留；实现 = createCwdKeyedCache）。
export function createModelsCache(opts) {
  return createCwdKeyedCache(opts);
}

// 一条命令 → { name, description?, argumentHint?, aliases? }（字段名照 SDK SlashCommand，空字段不带）。
// 裸字符串来自 init.slash_commands 与 #456 之前落盘的缓存，只有名字。
function normalizeSlashCommand(item) {
  if (typeof item === 'string') return item ? { name: item } : null;
  if (!item || typeof item.name !== 'string' || !item.name) return null;
  const cmd = { name: item.name };
  if (typeof item.description === 'string' && item.description) cmd.description = item.description;
  if (typeof item.argumentHint === 'string' && item.argumentHint) cmd.argumentHint = item.argumentHint;
  const aliases = Array.isArray(item.aliases) ? item.aliases.filter(a => typeof a === 'string' && a) : [];
  if (aliases.length) cmd.aliases = aliases;
  return cmd;
}

// 可缓存、可下发的斜杠命令列表。非数组 / 空 → null（不缓存空列表，避免抹掉更好的缓存）。
// 同名多行只留一行：SDK 说 /name 执行标了 builtin 的那行，菜单上的说明要跟它一致。
export function normalizeSlashCommands(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const byName = new Map();
  for (const item of raw) {
    const cmd = normalizeSlashCommand(item);
    if (cmd && (!byName.has(cmd.name) || item.builtin === true)) byName.set(cmd.name, cmd);
  }
  return byName.size ? [...byName.values()] : null;
}

// 只要名字的那几处（terminal 隐藏名单）：仍是 string[]。
export function slashCommandNames(raw) {
  return normalizeSlashCommands(raw)?.map(c => c.name) ?? null;
}

// init.slash_commands 只有名字，直接覆盖会把 supportedCommands() 拿到的说明抹掉（每轮 init 都会）。
// 成员以 init 为准，只有名字的那几条沿用缓存里同名命令的详情；init 里没有的不残留（skill 删了就该消失）。
export function mergeInitSlashCommands(initList, cachedList) {
  const next = normalizeSlashCommands(initList);
  if (!next) return null;
  const known = new Map((normalizeSlashCommands(cachedList) ?? []).map(c => [c.name, c]));
  return next.map(c => (Object.keys(c).length === 1 ? known.get(c.name) ?? c : c));
}

// 解析某 cwd 应下发的斜杠命令：优先 per-cwd 缓存；仅当 lastInit.cwd 命中当前 cwd 才回落 lastInit
// （防全局 lastInit 把 A 区命令塞进 B 区视图——这正是旧 #5 整字段剥离的动机）。
//
// 返回 `{ slashCommands, terminalSlashCommands }` 或 null（无可用清单）。
// 【为什么两者一起返回而不是两个函数】terminalSlashCommands 是 slashCommands 的子集，两者必须
// 取自同一来源。拆成两个各自回落的函数，就能拼出「命令来自 A 区缓存、隐藏名单来自 B 区 lastInit」
// 的错配——名单里的名字在命令列表里根本不存在，于是该隐藏的没隐藏。同源是这个返回形状的全部理由。
//
// terminalSlashCommands 没有时返回 `[]` 而非 null：下游语义是「空名单 = 没有要隐藏的」，
// 而 null 会让 server 省略该字段、前端继续沿用上一份陈旧名单。
export function resolveSlashCommandsForCwd(cache, cwd, lastInit = null) {
  const hit = cache?.get?.(cwd);
  const fromCache = normalizeSlashCommands(hit?.slashCommands ?? hit);
  if (fromCache) {
    return { slashCommands: fromCache, terminalSlashCommands: slashCommandNames(hit?.terminalSlashCommands) ?? [] };
  }
  if (cwd && lastInit?.cwd === cwd) {
    const cmds = normalizeSlashCommands(lastInit.slashCommands);
    if (!cmds) return null;
    return { slashCommands: cmds, terminalSlashCommands: slashCommandNames(lastInit.terminalSlashCommands) ?? [] };
  }
  return null;
}

// 判断某次启动上报的 init.model 是否 = cwd 真实默认模型（可否入 defaultModelByCwd 缓存、供新会话预显）。
// 只有「未 resume（resumeId==null）且未 pin model（pinnedModel===undefined）」的启动，其 init.model 才等于
// 「不带 --model 时 CLI 自选的默认」——scout 与 fresh 新会话首 init 属此。
// resume-no-record 虽未 pin，但 init.model 是 CLI 从 jsonl 恢复的会话模型（可能被终端 /model 改过）≠ cwd 默认 →
// 必须拒，否则污染缓存把别的会话模型误当 cwd 默认。空 reportedModel 亦拒（不缓存空值）。
export function isCwdDefaultModel({ resumeId, pinnedModel, reportedModel } = {}) {
  return resumeId == null && pinnedModel === undefined && !!reportedModel;
}

// 模型清单的稳定签名：判断某 cwd 的清单是否变了——那是「该区 CLI 配置已变」（换网关、改模型别名）
// 唯一拿得到的可观测代理信号。scout 只走 supportedModels() 这条控制请求通道，拿不到 init
// （见 app.js openScoutInstance 的 onSessionId 注释），所以配置变更没有别的地方能被察觉。
// 只取模型标识、排序后拼接：按【集合】而非顺序比较——SDK 返回顺序不保证稳定，顺序抖动不该被
// 当成配置变更（那会让 defaultModelByCwd 被反复无意义地作废）。
// 兼容三种元素形态（mock 与不同 SDK 版本都出现过）：裸字符串、{value}、{displayName}。
// 空/非法 payload → 空串。调用方据此【跳过】比较：拿不到清单是「不知道」，不等于「变了」。
export function modelListSignature(payload) {
  const arr = Array.isArray(payload) ? payload
    : (Array.isArray(payload?.models) ? payload.models : null);
  if (!arr) return '';
  const names = [];
  for (const m of arr) {
    const name = typeof m === 'string' ? m : (m?.value ?? m?.displayName ?? '');
    if (name) names.push(String(name));
  }
  return names.length ? names.sort().join('\n') : '';
}

// 每个 cwd 的 CLI 配置代数（验收 O85）。确认该区配置变过就加一：采纳了影响默认模型的新 settings 快照、
// ↻ 强制重读、scout 发现清单在外面变了。实例构造时抄下当时的代数，之后它每轮 init 报的模型只描述它自己
// 那套旧配置——代数对不上就不再当「本目录的默认模型」记。不落盘：重启后所有实例都是新 spawn 的。
//
// 清单出处（listGen）：缓存里那份模型清单是第几代 spawn 的实例报的。scout 用它分辨清单变化有没有被解释过
// （#260 review）：中间已经采纳新快照 / ↻ 过的，再按「清单变了」加一次代数，会把同一代 spawn 的 fresh 实例
// 当成旧配置拒掉。没记过出处（启动时从磁盘读回的清单）按第 0 代算。cwd 数受连接清单约束，不设上限。
export function createCliConfigGen() {
  const genByCwd = new Map();
  const listGenByCwd = new Map();
  const current = cwd => genByCwd.get(cwd) ?? 0;
  return {
    current,
    bump(cwd) { genByCwd.set(cwd, current(cwd) + 1); },
    noteListGen(cwd, gen) { listGenByCwd.set(cwd, gen); },
    listChangeUnexplained(cwd, reporterGen) { return (listGenByCwd.get(cwd) ?? 0) === reporterGen; },
  };
}

// 采纳的 settings 快照（ensureCliDefaults 的结果）里决定「不带 --model 时 CLI 用哪个模型」的部分：
// model、env 块（网关地址、模型别名映射）、worktree 网关隔离注入的 gatewayEnv。权限档 / 思考档不影响模型，
// 不算进来，免得改个默认档就把默认模型作废。env 按键排序，键序不同不算变。
export function cliDefaultsModelSignature(defaults) {
  const sorted = obj => (obj && typeof obj === 'object' ? Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : null);
  return JSON.stringify([defaults?.model ?? null, sorted(defaults?.env), sorted(defaults?.gatewayEnv)]);
}
