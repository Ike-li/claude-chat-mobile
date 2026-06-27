// models-cache.js —— 按 cwd 归键的「可用模型清单」缓存。
//
// 为什么按 cwd（而非单个全局）：模型清单来自 SDK supportedModels()，而 agent 用
// settingSources:['user','project','local'] 起 query——工作区 .claude/settings.local.json 的 env 块
// 可覆盖 ANTHROPIC_BASE_URL / ANTHROPIC_DEFAULT_*_MODEL，改写网关与自定义模型名（如某区映射
// opus→deepseek-v4-pro[1m]）。故模型清单是【随工作区变】的量，绝非账号级全局。单全局缓存会把上个
// 工作区的模型泄漏进当前工作区视图（实测 bug：切到 claude-chat-mobile 点新会话冒出 deepseek 名）。
// 同 cwd 多会话共享同一 settings → 同一清单，故 cwd 是正确的归键维度（同 lastInit 的 per-cwd 治理）。
//
// 有界：cwd 数受 workDirs 白名单约束（通常 < 20），仍设上限防御异常增长；超限淘汰最旧（LRU-on-write）。
// 可序列化：toJSON/load 跨重启持久化进 data/init-cache.json（缓存可弃，损坏即当空）。
export function createModelsCache({ max = 32 } = {}) {
  const byCwd = new Map(); // cwd → models payload（形如 { models: [...] }）

  return {
    // 记录某 cwd 的模型清单。cwd 落空（未知工作区）直接忽略——绝不存进无键桶。
    set(cwd, payload) {
      if (!cwd) return;
      byCwd.delete(cwd);            // 删后重插：刷新到尾部（最近使用），配合下方淘汰=LRU
      byCwd.set(cwd, payload);
      while (byCwd.size > max) byCwd.delete(byCwd.keys().next().value); // 淘汰最旧
    },
    // 取某 cwd 的模型清单；未知 cwd 返回 null——诚实的「不知道」，绝不回退别区清单（那正是 bug）。
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
