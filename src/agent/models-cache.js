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

// 通用 per-cwd 有界 Map。models / slashCommands 共用同一形状（cwd → payload）。
export function createCwdKeyedCache({ max = 32 } = {}) {
  const byCwd = new Map(); // cwd → payload

  return {
    // 记录某 cwd 的 payload。cwd 落空（未知工作区）直接忽略——绝不存进无键桶。
    set(cwd, payload) {
      if (!cwd) return;
      byCwd.delete(cwd);            // 删后重插：刷新到尾部（最近使用），配合下方淘汰=LRU
      byCwd.set(cwd, payload);
      while (byCwd.size > max) byCwd.delete(byCwd.keys().next().value); // 淘汰最旧
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
    get size() { return byCwd.size; }
  };
}

// 模型清单缓存（历史 API 名保留；实现 = createCwdKeyedCache）。
export function createModelsCache(opts) {
  return createCwdKeyedCache(opts);
}

// 从 init payload 抽出可缓存的斜杠命令列表。非数组 / 空 → null（不缓存空列表，避免抹掉更好的缓存）。
// 元素归一为字符串名（兼容 mock 的 {name, description} 与 SDK 的 string[]）。
export function normalizeSlashCommands(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const names = [];
  for (const item of raw) {
    if (typeof item === 'string' && item) names.push(item);
    else if (item && typeof item.name === 'string' && item.name) names.push(item.name);
  }
  return names.length ? names : null;
}

// 解析某 cwd 应下发的 slashCommands：优先 per-cwd 缓存；仅当 lastInit.cwd 命中当前 cwd 才回落 lastInit
// （防全局 lastInit 把 A 区命令塞进 B 区视图——这正是旧 #5 整字段剥离的动机）。
export function resolveSlashCommandsForCwd(cache, cwd, lastInit = null) {
  const hit = cache?.get?.(cwd);
  const fromCache = normalizeSlashCommands(hit?.slashCommands ?? hit);
  if (fromCache) return fromCache;
  if (cwd && lastInit?.cwd === cwd) {
    return normalizeSlashCommands(lastInit.slashCommands);
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
