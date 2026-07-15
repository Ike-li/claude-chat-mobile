# SDK 边界、接口清单与官方 `/bridge` 战略锚点

> 本文记录本项目与 `@anthropic-ai/claude-agent-sdk` 的关系：SDK 暴露了哪些接口/能力、
> 我们用了哪些、哪些是"重复实现了 SDK 已有能力"、本项目版本与 npm 最新版的差异、
> 官方 `/bridge`+`/browser`（远程接入）竞品、以及影响本项目定位的官方治理条款。
> **每次升级 SDK 前先读这份文档。**

## 0. 用途与数据来源

- **两个来源**：① `node_modules/@anthropic-ai/claude-agent-sdk` 的 `.d.ts`（编译器级契约，权威、完整）；② 官方 [overview 文档](https://code.claude.com/docs/en/agent-sdk/overview)（能力叙述、治理条款）。接口以 `.d.ts` 为准（文档会滞后/不全），治理与能力语义以官方文档为准。
- **版本快照**：本项目 `@anthropic-ai/claude-agent-sdk` 0.3.201（与 `package.json` 一致）；npm 最新版见 §7。核查于 2026-07-13。
- **为什么需要它**：本项目刻意只用 SDK 一小片能力（终端等价性 = 不重造 agent，只透传，见 `docs/design.md`）。"当年 SDK 没有、我们自己实现"的判断会随版本固化成错误前提——这份文档就是防漂移的复查基线。

## 1. SDK 暴露的接口与能力全景

### 视图 A —— 官方 overview 的能力叙述（开发者视角）

官方一句话："Everything that makes Claude Code powerful is available in the SDK."

| 能力 | 官方描述 | 对应 SDK 入口 | 本项目 |
|---|---|---|---|
| **内置工具** | Read/Write/Edit/Bash/Monitor/Glob/Grep/WebSearch/WebFetch/AskUserQuestion | CLI 内置，`allowedTools` 放行 | 透传（`AskUserQuestion` 另做 deny+message 适配） |
| **Hooks** | agent 生命周期回调（校验/记录/拦截/改写） | `Options.hooks` + 30 个 `HOOK_EVENTS` | 未用 |
| **Subagents** | 委派专项子 agent，`parent_tool_use_id` 溯源 | `Options.agents`(`AgentDefinition`) + `Agent` 工具 | 透传（靠 `parent_tool_use_id` 分流子 agent 消息） |
| **MCP** | 连数据库/浏览器/API 等外部系统 | `Options.mcpServers` + `createSdkMcpServer`/`tool` | 透传（`settingSources` 加载用户 MCP 配置） |
| **Permissions** | 控制工具可用性（放行/拦截/审批） | `Options.allowedTools`/`canUseTool`/`permissionMode` | ✅ 核心（`canUseTool` 移动端审批） |
| **Sessions** | 跨轮上下文、resume、fork | `resume`/`forkSession` + `get/list/delete/rename/tagSession` | 部分（`resume`/`deleteSession`，历史读取自实现，见 §3） |
| **Claude Code 配置** | Skills/Commands/Memory/Plugins（文件系统） | `settingSources` + `Options.plugins` | 透传（`settingSources:['user','project','local']`） |
| **认证** | API key / Bedrock / Vertex / Foundry / AWS | 环境变量 | 走本机 CLI 已登录订阅（`pathToClaudeCodeExecutable`） |
| **远程传输** | 浏览器/桥接接入 | 子入口 `/browser`(SSE/WS) + `/bridge` | ❌ 未用（本项目自建，见 §4） |

### 视图 B —— `.d.ts` 完整枚举（0.3.201，编译器契约）

**主入口 17 个顶层函数**（按用途分组，全列）：
- 会话读写：`getSessionInfo` · `getSessionMessages` · `getSubagentMessages` · `listSessions` · `listSubagents` · `renameSession` · `tagSession` · `deleteSession` · `forkSession` · `importSessionToStore` · `foldSessionSummary`
- 引擎/工具/设置：`query`（心脏） · `createSdkMcpServer` · `tool` · `resolveSettings` · `filterEscalatingDefaultMode` · `startup`

**`Query` 对象 27 个运行时方法**（全列）：
`interrupt` · `setModel` · `setPermissionMode` · `setMcpPermissionModeOverride` · `setMaxThinkingTokens` · `applyFlagSettings` · `initializationResult` · `reinitialize` · `supportedCommands` · `supportedModels` · `supportedAgents` · `mcpServerStatus` · `getContextUsage` · `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` · `readFile` · `reloadPlugins` · `reloadSkills` · `accountInfo` · `rewindFiles` · `seedReadState` · `reconnectMcpServer` · `toggleMcpServer` · `setMcpServers` · `streamInput` · `stopTask` · `backgroundTasks` · `close`

**`Options` 63 个配置字段**（全列）：
`abortController · additionalDirectories · agent · agents · allowedTools · canUseTool · continue · cwd · disallowedTools · toolAliases · tools · env · executable · executableArgs · extraArgs · fallbackModel · enableFileCheckpointing · toolConfig · forkSession · betas · hooks · onElicitation · onUserDialog · supportedDialogKinds · persistSession · sessionStore · sessionStoreFlush · loadTimeoutMs · includeHookEvents · includePartialMessages · forwardSubagentText · thinking · effort · maxThinkingTokens · maxTurns · maxBudgetUsd · taskBudget · mcpServers · model · outputFormat · pathToClaudeCodeExecutable · permissionMode · planModeInstructions · allowDangerouslySkipPermissions · permissionPromptToolName · plugins · promptSuggestions · agentProgressSummaries · resume · sessionId · resumeSessionAt · sandbox · settings · managedSettings · settingSources · skills · debug · debugFile · stderr · strictMcpConfig · systemPrompt · title · spawnClaudeCodeProcess`

**30 个 `HOOK_EVENTS`**（全列）：
`PreToolUse · PostToolUse · PostToolUseFailure · PostToolBatch · Notification · UserPromptSubmit · UserPromptExpansion · SessionStart · SessionEnd · Stop · StopFailure · SubagentStart · SubagentStop · PreCompact · PostCompact · PermissionRequest · PermissionDenied · Setup · TeammateIdle · TaskCreated · TaskCompleted · Elicitation · ElicitationResult · ConfigChange · WorktreeCreate · WorktreeRemove · InstructionsLoaded · CwdChanged · FileChanged · MessageDisplay`

**205 个纯类型契约**：`SDKMessage` 家族（消息流形状）、Hook input/output 家族、`Mcp*` 家族、`Options`/`PermissionResult`/`SDKControl*` 展开等——数据形状，非可调用能力。

**3 个子入口**：`/browser`（1 函数）· `/bridge`（4 函数，见 §4）· `/sdk-tools`（内置工具 I/O schema，3515 行）。

**"可调用能力接口"合计 ≈ 49**（17 函数 + 27 `Query` 方法 + 5 子入口函数）；类型契约不计。

## 2. 项目实际利用率

| 类别 | 项目用到 | 占比 |
|---|---|---|
| 顶层函数 | `query`（`agent.js`）、`deleteSession`（`server.js`） | 2 / 17 |
| `Query` 方法 | `interrupt` · `setModel` · `setPermissionMode` · `supportedModels`（均在 `agent.js`） | 4 / 27 |
| **可调用接口合计** | **6** | **≈ 12%** |
| `Options` 字段 | `prompt` · `cwd` · `pathToClaudeCodeExecutable` · `model` · `resume` · `abortController` · `includePartialMessages` · `effort` · `permissionMode` · `canUseTool` · `settingSources` · `systemPrompt` · `env` · `stderr` | 14 / 63 ≈ **22%** |
| Hooks | 无 | 0 / 30 |
| 子入口 `/browser` `/bridge` `/sdk-tools` | 无 | 0% |

**结论**：项目吃了 SDK 可调用能力的约 1/8、配置面的约 1/5、hooks 零。依赖**深而窄**——窄（点极少），深（`query` 一个点是不可替代的心脏；见 `docs/interfaces.md` 的触点清单）。

## 3. 重复实现审计

"项目自己实现了、而 SDK 已暴露"的接口。每条判定是否为**无谓重复**：

| # | 项目自己实现 | SDK 已有 | 判定 |
|---|---|---|---|
| 1 | `history.js` `getSessionHistory`（读 transcript、按 parentUuid 建链） | `getSessionMessages()` | **重叠但有理由**。SDK 返回的 `SessionMessage` 极简 `{type,uuid,session_id,message:unknown,parent_tool_use_id}`——**不含 `isMeta`/`isSidechain`**，而项目过滤 CLI 噪音全靠这俩 + `isCliSystemLine`。`history.js` 顶部注释"故不迁官方 API"**站得住**（已核类型）。 |
| 2 | `history.js` `listSessions` / `listSessionsPage`（扫目录 + 分页） | `listSessions()` | **重叠，SDK 版更全**（自带 `includeWorktrees`/`includeProgrammatic`/分页/offset）。项目版叠了 `readHeadMeta` 取标题、`hiddenIds` 过滤已删、目录缓存——仍有定制，但理由弱于 #1。**四条里最接近"可以考虑迁"。** |
| 3 | `statusline.js` 从 raw `usage` 自算 ctx% / 缓存倒计时 | `Query.getContextUsage()` | **实测确认可迁，且修真 bug**。2026-07-13 probe（CLI 2.1.207，haiku）：`getContextUsage()` init 后 4.6s 返回 `maxTokens:1000000` + `percentage` + `categories`(Skills/Compact buffer/Free space)。而 `statusline.js` `contextWindowSize('…haiku…')` 猜 **200k** → 该会话 ctx% **偏高 5 倍**。根因：静态 model→窗口映射追不上运行时配置（1M beta / 账号差异）。⚠️ 约束**不是** async（`buildWebStatusLine` 本就 async、走 `status_line` socket 事件、非 CLI stdin——上一版本文档此处判断有误，已更正），而是 **`q` 可用性**（idle/历史/dispose 时无活 `q`）+ **RPC 延迟**（cold ~3.8s）。迁移须混合+降级，见 §6。 |
| 4 | `agent.js` `bgTasks` 注册表 + TTL 清扫 | `Query.backgroundTasks()` / `stopTask()` | **非重复**。SDK `backgroundTasks()` 只返回 boolean，项目要每任务的 type/message 做 ⏳/🤖 角标，粒度不同。但 `stopTask(taskId)` 是项目**未利用**的 SDK 能力（现靠整体 abort）。 |

**小结**：无"纯粹的无谓重复"——每处项目版都叠了 SDK 不给的定制。但 #2、#3 的前提已被 SDK 追上，**升级时应重新评估**。

## 4. 官方 `/bridge` + `/browser`：远程接入竞品

`.d.ts` 注释白纸黑字表明，这两个子模块是 **Anthropic 官方版的"从浏览器/手机远程驱动本地 Claude Code"**：

- **`/browser`**：浏览器里的 `query()`，经 **SSE 或 WebSocket** 连到 `…/v1/code/sessions/{id}/events/stream`——即"web 端直接说 SDK 协议"。
- **`/bridge`**：`createCodeSession`（`POST /v1/code/sessions`）+ `attachBridgeSession` + `fetchRemoteCredentials`，把本地 CLI 注册成 **claude.ai 的一个 worker**，远端 UI 经云端驱动。

它已经内建了**本项目自研的每一样机制**：

| 本项目自研 | SDK `/bridge` 对应物 |
|---|---|
| 镜像 / 单驾驶员模型（远端只看不驱动） | `AttachBridgeSessionOptions.outboundOnly`（"mirror-mode … see but not drive"） |
| seq 断线重放 | `getSequenceNum()` / `initialSequenceNum`（"resume instead of replaying full history"） |
| 设备信任审批 | `worker_jwt` / `X-Trusted-Device-Token` / `untrusted_device`（"enroll"） |
| 审批转发 + busy 状态 | `sendControlRequest`（"forward permission to claude.ai"）/ `sendResult`（"stop the working spinner"） |

**但信任模型根本不同——这是本项目唯一、也是最硬的护城河：**

| | 数据路径 | 谁托管中转 |
|---|---|---|
| **SDK `/bridge` `/browser`** | 手机 → **claude.ai（CCR 云端）** ← bridge ← 你的 CLI | **Anthropic 托管**，worker JWT 由其后端签发 |
| **本项目** | 手机 → **你自己的 `server.js`（本机）** → 本机 CLI | **零第三方中转**，走自己的域名 + Cloudflare Access |

`/bridge` 标注为 `@alpha`（"separate versioning universe … breaking changes do NOT bump the package major"）。官方文档另把这条托管路线命名为 **Managed Agents**（hosted REST API，见 §8）。**它是本项目远程接入部分的直接竞品，只是绑定 claude.ai 云中转。** 本项目的存在意义因此收敛为一条：**自托管、代码会话数据不经第三方云。** 这条守得住，项目有长期意义；守不住，价值只剩 UX 差异化。定位背景见 `docs/design.md §1`。

## 5. 每次 SDK 升级的复查清单

- [x] `getContextUsage()`（#3）——**已实测可迁且修真 bug**（2026-07-13，见 §3）。迁移方案（混合+降级）：活跃会话（`agent.q` 存在、未 dispose）调 `await q.getContextUsage()` 取权威 `maxTokens`/`percentage`/`categories`；无 `q`（idle/历史/dispose）或 RPC 超时(~1.5s)/抛错 → 回退现有 `contextWindowSize(model)` 猜测；靠 `lastStatusLine` 缓存兜 RPC 延迟（先发陈旧值、回来补发）。**不迁**：缓存失效倒计时（SDK 无 TTL 字段）、成本段、git 段。
- [ ] `listSessions()`（#2）——`history.js` 的扫盘是否该改用它？确认 `SDKSessionInfo` 是否已含项目要的标题/隐藏过滤。
- [ ] `getSessionMessages()`（#1）——`SessionMessage` 是否已补 `isMeta`/`isSidechain`？补了则 #1 的"不迁"理由失效。
- [ ] `/bridge` 是否脱离 `@alpha`？转正即意味官方远程接入商品化到位，需重估本项目远程部分的护城河。
- [ ] 项目在用的 6 个可调用接口（§2）签名有无 breaking：`query` / `deleteSession` / `interrupt` / `setModel` / `setPermissionMode` / `supportedModels`。

> 复查方法：`grep -nE "^export (declare )?(function|class)" node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 看顶层导出；
> `sed -n` 读 `Query` interface（`interface Query extends AsyncGenerator`）看运行时方法；
> 版本 diff 见 §7 的 `npm pack` 方法。

## 6. #3 完整迁移实现方案（`getContextUsage()` → statusline）

> **状态：待实施（方案已定，代码未动）。** ⚠️ 实施前先确认 `statusline.js` / `app.js` 无并发改动——
> 2026-07-13 `git status` 显示 `statusline.js` 为 `M`、`app.js` 历史上被并发会话占用。方案分两阶段，
> **后端阶段一可独立先上**（修真 bug 优先）；前端阶段二等占用 `app.js` 的会话落定后再动。

### 阶段一：后端 —— `statusline.js`（修 ctx% 偏高 + 附 categories）

目标：活跃会话用 `getContextUsage()` 的权威 `maxTokens`/`percentage`；无 `q` / 超时 / 抛错则降级回现算法。

1. 新增带超时的安全包装：
   ```js
   async function getContextUsageSafe(q, timeoutMs = 1500) {
     if (!q?.getContextUsage) return null;
     try {
       return await Promise.race([
         q.getContextUsage(),
         new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
       ]);
     } catch { return null; } // 超时/抛错 → 静默降级，绝不让 statusline 崩
   }
   ```
2. `buildWebStatusLine` 的 ctx 段改混合：
   - `agent?.q && !agent.disposed` 且 `getContextUsageSafe` 返回非空 → 用 `ctx.maxTokens` 作 `p.ctx.windowSize`、`ctx.percentage` 作 `p.ctx.usedPercent`、`ctx.categories` 附到 `p.ctx.categories`。
   - 否则 → 现有 `contextWindowSize(model)` + `lastUsage` 路径**一行不动**，作 fallback。
   - `p.ctx.tokens`（in/w/r 明细）仍从 `lastUsage` 出——categories 是另一维度，不替代 in/w/r。
3. `server.js` **无需改**：`buildWebStatusLine({ agent: va, … })` 已传 viewing agent，`va.q` 现成；RPC 延迟由现有 `lastStatusLine` 缓存即时上屏机制（先发陈旧值、build 完补发新值）自然吸收。**这条降低了与并发会话的冲突面——阶段一只碰 `statusline.js` 一个文件。**
4. **口径一致性（实现须定死一种）**：probe 实测 `percentage=0` 而 `totalTokens=4508`/`maxTokens=1e6`——`percentage` 是官方口径（对 compact buffer / skills 基线另有折算）。**建议直接用 `ctx.percentage`**，勿自己 `tokens/maxTokens` 重算，避免与官方 `/context` 显示分叉。

**TDD（`test/statusline.test.mjs`）**：mock `q = { getContextUsage: async () => ({maxTokens,percentage,categories}) }` →
- 有 q 且返回有效 → payload 用权威值；
- q 抛错 / 永挂（测 1.5s 超时）→ 回退 `contextWindowSize(model)`；
- `agent.q` 缺失（历史/idle）→ 回退；
- categories 透传到 `p.ctx.categories`。

**部署**：改 `statusline.js` 须**重启常驻 server**（`launchctl kickstart`）才生效。

### 阶段二：前端 —— `app.js` + `logic.js`（categories 明细 UI）

依赖阶段一 payload 的 `p.ctx.categories`，补 web statusline 相对 CLI `/context` 的等价缺口。

5. `logic.js` 加纯函数格式化 categories（Skills / MCP tools / Memory files / Compact buffer / Free space → 显示行）+ 单测。
6. `app.js` `status_line` handler：ctx pill 加可展开明细，渲染 categories 分解。
   - ⚠️ **`app.js` 4434 行、当前被并发会话占用——此阶段等其他会话落定后再动。**

### 不迁（SDK 不提供）
- 缓存失效倒计时（`getContextUsage` 无 TTL 字段，仍靠 `lastCacheHitAt + CACHE_TTL_MS` 推算）；
- 成本段（`totalCostUsd`）、git 段（本机 `spawn git`）。

### 已知口径差异（实现须知）
- `getContextUsage` 反映 CLI 主会话上下文真值，比 web 从消息流攒的 `lastUsage` 更权威；两者可能细微差，以前者为准。
- probe 实测（2026-07-13，CLI 2.1.207，haiku）：`maxTokens=1_000_000`，而 `contextWindowSize()` 猜 200k → 现状 ctx% 偏高 5×，正是本迁移要修的核心。

## 7. 版本状态：本项目 vs npm 最新版

- **本项目**：`package.json` 声明 + `node_modules` 实装均 **0.3.201**。
- **npm 最新版**（2026-07-13 查 registry）：`latest` = **0.3.207**、`next` = **0.3.208**。本项目**落后 6 个 patch**（0.3.202–0.3.207）。

**精确接口 diff**（`npm pack` 拉 0.3.207 的 `sdk.d.ts` 逐面比对本地 0.3.201）：

| 维度 | 0.3.201 | 0.3.207 | 差异 |
|---|---|---|---|
| 顶层函数 | 17 | 17 | **无** |
| `Query` 方法 | 27 | 27 | **无** |
| `Options` 字段 | 63 | 63 | **无** |
| `HOOK_EVENTS` | 30 | 30 | **无** |
| 类型契约 | 205 | 210 | **+5** |
| `sdk.d.ts` 行数 | 6762 | 6923 | +161 |

**新增的 5 个类型**（全是 `SDKMessage` 家族/控制协议，纯增量、无删除、无签名变更）：
`SDKActiveGoalMessage` · `SDKBackgroundTasksChangedMessage` · `SDKControlInterruptResponse` · `SDKControlRequestProgressMessage` · `SDKConversationResetMessage`

**结论**：**本项目在用的接口面（`query`/`Query` 方法/`Options`/hooks）在 0.3.201→0.3.207 之间一个字没变。** 升级到 0.3.207 **无 breaking、且不解锁任何项目在用的新能力**——新增类型只是消息流/控制协议的周边扩充，`agent.js` `map()` 的 `default` 分支本就兜未识别消息类型（记入交互日志、不崩）。故"是否升级"是纯运维选择，非功能驱动。

- **升级动作**（若决定升）：`npm i @anthropic-ai/claude-agent-sdk@latest --omit=optional`（`--omit=optional` 避二进制 optionalDependency 的 EBADMACHO 坑），改后**重启常驻 server**。
- **CHANGELOG 说明**：官方 CHANGELOG 原文抓取受网络策略限制（`raw.githubusercontent.com` 被拦），本节以 `.d.ts` diff 为准——它是比 CHANGELOG 叙述更权威的编译器真相。
- **复现命令**：`cd /tmp && npm pack @anthropic-ai/claude-agent-sdk@latest && tar xzf *.tgz`，再 `diff` 其 `package/sdk.d.ts` 与本地。

## 8. 官方治理条款（约束本项目使用方式）

从 overview 页面摘取，直接影响本项目定位/合规：

- **第三方订阅禁令（关键）**：官方原文——"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." → 本项目**自用**（机主自己的订阅 + 自己的机器）**不违反**；但**若变成 hosted SaaS、让别人用机主订阅额度就违反**。这是"不做 SaaS 中转"定位的**官方铁证**（见 `docs/design.md §1`）。
- **Agent SDK vs Managed Agents**：官方另有 **Managed Agents**（hosted REST API：Anthropic 跑 agent + sandbox、session 存 Anthropic event log）。本项目属 **Agent SDK** 路线（你的进程、你的文件、JSONL 在你的文件系统）。§4 的 `/bridge` 疑似其底层传输。二者对立正是本项目价值支点。
- **Branding**：不得用 "Claude Code" / "Claude Code Agent" 命名或模仿其 ASCII art；可用 "Claude Agent" / "Powered by Claude"。本项目名 `claude-chat-mobile` 合规。
- **License**：SDK 使用受 Anthropic Commercial Terms of Service 约束（独立于本项目自身的 AGPL-3.0-only，见 `docs/design.md`）。
- **认证矩阵**：API key（`ANTHROPIC_API_KEY`）/ Bedrock（`CLAUDE_CODE_USE_BEDROCK`）/ Vertex（`CLAUDE_CODE_USE_VERTEX`）/ Foundry（`CLAUDE_CODE_USE_FOUNDRY`）/ AWS。本项目走**本机 CLI 已登录的订阅认证**（`pathToClaudeCodeExecutable` 指本机 claude），不在此矩阵内——这也是它必须"单机自托管"的技术根因。
