# 展示契约（Display Contracts）

> **目的**：锁定「TUI 怎么显 · SDK 怎么拿 · Web 怎么显」中**允许的变换**与**禁止的改写**。  
> **可执行锚点**：`tests/unit/display-contracts.test.mjs`（改契约先改测试，再改实现）。  
> **范围（v1）**：模型 · 思考强度 effort · statusline。其它面（工具卡/历史/权限 pill）见文末扩展清单。

项目入口见 [README](../README.md)；首次运行见[首次使用指南](getting-started.md)；整体数据路径见[架构说明](architecture.md)；产品不变量与 n=1 取舍见[硬性规则索引](hard-rules.md)。

**原则**

1. **不是 100% 字节透传**。每条契约写明「源 → 允许变换 → 屏幕上应是什么」。
2. **条数 / 语义对齐 TUI**；展示层可做可读化，不得偷偷合并、猜测、用 Web 偏好冒充 CLI 态。
3. **单测锚点**是回归闸；本文是给人读的索引。冲突时以**测试 + 实现**为准，再回来改本文。
   注意**代码注释不是仲裁依据**：注释和文档一样会过时（已实测到多处旧决策注释与现行分支相反）。
   历史设计规格文档（`design.md` 及其编号体系）已下线，注释里对它的引用已于 2026-08-16 清理，
   现存编号锚点只认 docs/hard-rules.md 在册的（AD-5 / SP-10 / OQ-09 / UP-1 等）与历次审查修复标记。
   注释可以帮你理解「当初为什么这么做」，但「现在到底怎么做」只由被测试覆盖的实现回答。

---

## 总链路

```
TUI / CLI 用户可见          Agent SDK / 磁盘              CCM server                 Web FE
─────────────────          ─────────────────            ──────────                 ──────
菜单 / statusline /        supportedModels              agent:event 信封            logic/ 纯函数
transcript 事实            stream / control / usage     status_line 组装            app.js DOM
```

| 层 | 职责 | 典型文件 |
|----|------|----------|
| SDK 边界 | 拉真值、映射 subtype → emit | `src/agent/agent.js` |
| Server 合成 | statusline 组装、effort 归一、缓存重放 | `src/server/app.js`, `src/ops/statusline.js` |
| FE 展示 | 可读化、磁贴/pill 策略 | `public/js/logic/`（`logic.js` 是 re-export barrel）, `public/js/app.js` |

---

## §1 模型（Models）

### 1.1 列表（设置磁贴 / 候选）

| 项 | 契约 |
|----|------|
| **TUI** | `/model` 菜单条数 = CLI 支持档；档位名 + 底层映射 |
| **SDK** | `query.supportedModels()` → `{ value, displayName, description?, resolvedModel?, supportedEffortLevels? }[]` |
| **Server** | `fetchModels` **原样** `emit('models', { models })`，不叠友好名、不删档、不合并 |
| **FE 条数** | `tiles.length === models.length`（**禁止**按 wire / displayName 去重合并） |
| **FE 标题** | 有 `resolvedModel` → **标题 = wire id**；无 → `displayName` 或 `value` |
| **FE 副标题** | 有 wire 时用档位 id / displayName（同 wire 多卡可区分） |
| **FE value** | 保持 SDK `value`（`default`/`opus`/…），供选中与 data-model |
| **锚点** | `resolveModelTileDisplay` · `tests/unit/display-contracts.test.mjs` · `logic-ui-ux-remaining.test.mjs` |

### 1.2 发送 model id

| 项 | 契约 |
|----|------|
| **意图** | 用户点的是档位；发出去的应是**网关认的 wire**，避免 alias 再被 env 映射错 |
| **规则** | `resolveSendModel`：空/`default` → `default` 条目的 `resolvedModel`（无则 `undefined` 让 CLI 自选）；其它档位有 `resolvedModel` 则 **pin wire**；无列表则原样 |
| **禁止** | 前端自造模型 id；把 displayName 当 send value |
| **锚点** | `resolveSendModel` · `logic-session.test.mjs` · display-contracts |

### 1.3 当前模型文案（底栏 pill / compose）

| 项 | 契约 |
|----|------|
| **有选中 + 有 resolved** | 显示 **wire**（`resolveGatewayModelName` / `resolveModelPillText`） |
| **有选中无 resolved** | 原值 + 网关后缀（如 `[1m]`） |
| **未选** | `default.resolvedModel` → CLI default 文案 → cwd 默认 →「默认」 |
| **禁止** | 无 `resolvedModel` 时用 displayName **覆盖** pill（历史 P0 锁：诊断/原值语义） |
| **锚点** | `resolveModelPillText` · `logic-session.test.mjs` · E2E P0-09\* |

### 1.4 字段变换矩阵

| 字段 | Server | FE 列表磁贴 | FE pill | FE 发送 |
|------|--------|-------------|---------|--------|
| `value` | 原样 | data-model / 选中 id | 输入 | 可能 pin 成 wire |
| `displayName` | 原样 | 副标题 / 无 wire 时标题 | 仅 fallback 链 | 不用 |
| `resolvedModel` | 原样 | **标题优先** | **优先显示** | **优先 pin** |
| 条数 | N | N | — | — |

---

## §2 思考强度（Effort / Ultracode）

### 2.1 档位集合

| 集合 | 值 | 用途 |
|------|-----|------|
| **SDK `Options.effort`** | `low` `medium` `high` `xhigh` `max` | 真正传给 Agent SDK |
| **UI 档** | 上列 + **`ultracode`** + `null`（模型默认） | 设置磁贴 / pill / `effort_mode` 广播 |
| **settings.effortLevel** | 通常无 max；`normalizeEffortLevel` **不认** ultracode | L3 CLI 默认 |

### 2.2 UI → SDK 映射（硬契约）

| UI 入参 | `normalizeEffortUiLevel` 结果 | Agent 行为 |
|---------|------------------------------|------------|
| `null` / `''` | `{ ui:null, sdk:null, ultracode:false }` | 不传 effort |
| `low`…`max` | `{ ui, sdk 同值, ultracode:false }` | `Options.effort = 该档` |
| **`ultracode`** | `{ ui:'ultracode', sdk:'xhigh', ultracode:true }` | `Options.effort=xhigh` + **`Settings.ultracode: true`** |
| 非法 | `null` | 拒切 / 回落 |

| **禁止** | 把字面量 `ultracode` 塞进 `Options.effort`；靠改写用户正文注入 `ultracode` 关键词（关键词仅用户自写时保留） |
| **允许** | 切档 dispose+resume 换实例（SDK 无 runtime setEffort） |
| **日志/chip** | UI 显 `ultracode` 时 `logMeta().effort === 'ultracode'`；SDK 实际仍是 xhigh |
| **锚点** | `normalizeEffortUiLevel` · `AgentSession` ultracode 构造 · display-contracts · E2E P0-02e |

### 2.3 候选列表与展示态

| 项 | 契约 |
|----|------|
| **候选来源** | 当前模型条目的 `supportedEffortLevels`；解析不到 → 全候选并集；明确不支持 → 隐藏整行 |
| **未知档** | `effortUiState` **不得**把 `null` 猜成 `low` |
| **CLI 镜像** | `mirrorReadonly` 时 null 文案为「CLI 档位未知」，与 FRESH「模型默认」分开 |
| **面板数据源** | `resolvePanelState`：镜像态**整组**只用 CLI 观察值，禁止 Web 偏好补空 |
| **锚点** | `effortLevelsFor` `effortUiState` `resolvePanelState` · `logic-session.test.mjs` |

### 2.4 Statusline 中的 effort

| 项 | 契约 |
|----|------|
| Web 驾驶 | `buildWebStatusLine`：`agent.effort` 有值才带 `p.effort`；null 不放字段（对齐 CLI 空 effort 不打印） |
| CLI 驾驶 | 仅 bridge 快照里的 effort；**禁止**与 Web agent.effort 混拼 |

---

## §3 Statusline

### 3.1 产品形态

| 项 | 契约 |
|----|------|
| **不是** | CLI statusline 脚本 stdout 原文字符串透传 |
| **是** | Server 组装**结构化 payload** → `status_line` 事件 → FE 原生 DOM（对齐 CLI **字段语义**，非 ANSI） |
| **双源** | Web 驾驶：`buildWebStatusLine`（SDK + 本机 git）；CLI 驾驶：`buildCliStatusLine`（bridge 快照 + 本机 git） |
| **禁止混拼** | CLI owner 缺/陈旧 → `source.kind=cli-unavailable`，**不得**把上一份 SDK 的 model/ctx/cost 填进来（额度账号级快照回落是**唯一**例外，且须标非实时） |

### 3.2 字段契约（payload → 含义）

| 字段 | 源（Web） | 源（CLI bridge） | FE 展示要点 |
|------|-----------|------------------|-------------|
| `model` | `activeModel \|\| reportedModel`（wire/裸 id） | snapshot：`displayName` 优先，否则 `id` | 展开态；底栏 pill **另算**（Web pill 偏 wire） |
| `effort` | agent.effort 有则带 | snapshot.effort | 有则显 |
| `ctx.tokens` / in out w r | `lastUsage` 真值（单轮口径；可缺） | context_window | 绝对 token 不猜；**不**单独拿来算 left；`message_delta` 残缺帧须 `mergeMessageUsage` |
| `ctx.totalTokens` | SDK `getContextUsage().totalTokens`（全量占用） | —（CLI 无此字段，mock 可补） | left 最优先；与 usedPercent 同源 |
| `ctx.usedPercent` / windowSize | **只认真值**：`getContextUsage()`（**无 lastUsage 也可**）→ 失败则垫会话缓存 `agent.ctxWindowCache`（同 model 才有效）；**不按模型名猜** | CLI 给的 used_percentage / size | 两级真值都没有则只显绝对 token（不编造分母）；`left` 见 `formatStatuslineCtxLeft`（totalTokens → %×window → tokens；有 % 时**禁止**用 lastUsage 单轮 tokens） |
| `cost` / `duration` | 会话累计 | snapshot.cost | est $ / 时长 |
| `rate` 5h/7d | `fetchUsage` rate_limits | snapshot.rate | 颜色阈值；可标 snapshot |
| `git` | 本机 `git status` 三分 | 同（cwd 事实） | `+staged !mod ?untracked ↑↓` |
| `lines` | usage.session 改行 | cost.total_lines_* | 会话工具 +/− |
| `turn` | turnStartedAt / outTokens | — | 动态 ✻ 秒表行 |
| `session.id` / `version` | sessionId / versions.cli | bridge | sid / v |
| `source.kind` | 组装时标注 | `cli` / `cli-unavailable` | 不可用文案 |

### 3.3 折叠摘要

| 项 | 契约 |
|----|------|
| **文案** | `formatStatuslineCollapsedSummary` = `git · ctx`（有则拼）；皆无 → 字面 `statusline` |
| **不含** | model/effort（已在底栏 pill） |
| **锚点** | `logic-statusline-summary.test.mjs` · `statusline.test.mjs` · display-contracts |

### 3.4 ctx 窗口来源（只认真值，不猜）

| 优先级 | 规则 |
|--------|------|
| 1 | SDK `getContextUsage().maxTokens` + `percentage`（运行时权威；拿到即写进会话缓存） |
| 2 | 会话缓存 `agent.ctxWindowCache`（本会话此前拿到过的**真值**，带 model 指纹，模型一变即作废） |
| 3 | 两级都没有 → **不出** `windowSize` / `usedPercent`，只显绝对 token |

**禁止**：按 model 名推断窗口大小。这里曾有一张 model→窗口 的静态映射表（`[1m]`→1M、认出 claude/opus/sonnet/haiku→200k 兜底），
已于 2026-07-29 删除——它漏了 opus-5，RPC 一超时就回落 200k，真机上 ctx 在「532k/1M=53%」与「532k/200k 封顶 100%」之间反复跳。
静态表有三个不可修复的缺陷：新模型上线要人工补表、窗口升级要改代码、第三方网关的模型别名根本无从判断。
**宁可短暂看不到百分比，也不显示一个错的。**

**锚点**：`src/ops/statusline.js` `getContextUsageSafe` / `readCachedCtxWindow` / `cacheCtxWindow` · `tests/unit/display-contracts.test.mjs`（「ctx 窗口：无运行时真值时不出 %（不按模型名硬造分母）」）

---

## §4 改契约时怎么动

1. 改 `tests/unit/display-contracts.test.mjs`（红）  
2. 改对应纯函数 / server 映射（绿）  
3. 同步改本节表格与「禁止」句  
4. 若涉及 E2E 可见行为，补 `tests/e2e/p0/*`  
5. `npm run test:unit` + 相关文件 eslint  

---

## §5 扩展清单（未进 v1 硬闸、仍有意策略）

| 面 | 策略摘要 | 主要代码 |
|----|----------|----------|
| 权限档 pill | bypass 对 SDK 映射 default，UI 仍显 bypass；不进 status_line | `agent.sdkPermissionMode` `setPermMode` |
| 工具卡 | 截断 600/Bash 2000、脱敏 base64、标题抽 path | `agent` truncate · `formatTool*` |
| 审批 sheet | ExitPlanMode → markdown plan；input 不截断 | `formatPermInputDisplay` |
| 历史回显 | 滤 CLI 系统行；非 jsonl 全量 | `history.js` |
| 会话列表 | **生产走 SDK `listSessions` 快路径**（判据 `baseDir === CLAUDE_DIR`）+ 按 jsonl 存在做归属过滤 + readdir 补 SDK 漏报；隔离测试注入别的 baseDir 时回落自造扫盘。`hasMore` / `hiddenIds`(L1) / TTL 缓存仍由 `listSessionsPage` 自己维护 | `listSessionsPage` · `scanSessionsViaSdk` |
| 系统条中文 | compacting 等 agent 写死中文 | `agent.map` system |

后续若某面反复踩坑，升格进 display-contracts 测试块即可。

---

## 锚点索引（快速跳转）

| 契约 | 实现 | 测试 |
|------|------|------|
| 模型磁贴 N + wire 标题 | `public/js/logic/models-effort.js` `resolveModelTileDisplay` | `display-contracts` · `logic-ui-ux-remaining` |
| 发送 pin wire | `resolveSendModel` | `display-contracts` · `logic-session` |
| Pill 显 wire | `resolveModelPillText` | `logic-session` · E2E P0-09 |
| Effort UI→SDK | `normalizeEffortUiLevel` | `display-contracts` · `cli-settings-defaults` |
| Ultracode 不改正文 | agent Settings.ultracode | E2E P0-02e |
| Effort 不猜 low | `effortUiState` | `logic-session` |
| Statusline 双源不混拼 | `buildWeb*` `buildCli*` `selectStatusSource` | `statusline.test` · smoke statusline |
| 折叠摘要 | `formatStatuslineCollapsedSummary` | `logic-statusline-summary` |
| ctx 窗口只认真值 | `getContextUsageSafe` `readCachedCtxWindow` `cacheCtxWindow` | `statusline.test` |
