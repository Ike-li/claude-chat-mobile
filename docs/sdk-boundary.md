# SDK 边界、接口清单与官方 `/bridge` 战略锚点

> 本文记录本项目与 `@anthropic-ai/claude-agent-sdk` 的关系：SDK 暴露了哪些接口/能力、
> 我们用了哪些、哪些是"重复实现了 SDK 已有能力"、本项目版本与历史对照版本的差异、
> 官方 `/bridge`+`/browser`（远程接入）竞品、以及影响本项目定位的官方治理条款。
> **每次升级 SDK 前先读这份文档。**

## 0. 用途与数据来源

- **两个来源**：① `node_modules/@anthropic-ai/claude-agent-sdk` 的 `.d.ts`（编译器级契约，权威、完整）；② 官方 [overview 文档](https://code.claude.com/docs/en/agent-sdk/overview)（能力叙述、治理条款）。接口以 `.d.ts` 为准（文档会滞后/不全），治理与能力语义以官方文档为准。
- **当前项目版本**：`@anthropic-ai/claude-agent-sdk` 0.3.201（与 `package.json` 和本机安装版本一致）。§7 是 2026-07-13 留下的历史版本对照，不代表今天的 npm `latest`；本轮结构整理不升级依赖。
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
| 顶层函数 | `query`（`src/agent/agent.js`）、`deleteSession` / `resolveSettings`（`src/server/app.js`） | 3 / 17 |
| `Query` 方法 | `interrupt` · `setModel` · `setPermissionMode` · `supportedModels` · `getContextUsage` · `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` · `stopTask`（均经 `src/agent/agent.js`） | 7 / 27 |
| **可调用接口合计** | **10** | **≈ 20%** |
| `Options` 字段 | `cwd` · `pathToClaudeCodeExecutable` · `model` · `resume` · `abortController` · `includePartialMessages` · `forwardSubagentText` · `effort` · `permissionMode` · `canUseTool` · `settingSources` · `systemPrompt` · `env` · `stderr` | 14 / 63 ≈ **22%** |
| Hooks | 无 | 0 / 30 |
| 子入口 `/browser` `/bridge` `/sdk-tools` | 无 | 0% |

**结论**：项目使用 SDK 可调用能力的约 1/5、配置面的约 1/5、hooks 零。依赖仍然**深而窄**——调用面有限，但 `query` 是不可替代的主消息泵；见 `docs/interfaces.md` 的触点清单。

## 3. 重复实现审计

"项目自己实现了、而 SDK 已暴露"的接口。每条判定是否为**无谓重复**：

| # | 项目自己实现 | SDK 已有 | 判定 |
|---|---|---|---|
| 1 | `src/sessions/history.js` `getSessionHistory`（读 transcript、按 parentUuid 建链） | `getSessionMessages()` | **重叠但有理由**。SDK 返回的 `SessionMessage` 极简 `{type,uuid,session_id,message:unknown,parent_tool_use_id}`——**不含 `isMeta`/`isSidechain`**，而项目过滤 CLI 噪音依赖这两个字段和 `isCliSystemLine`。 |
| 2 | `src/sessions/history.js` `listSessions` / `listSessionsPage`（扫目录 + 分页） | `listSessions()` | **重叠但有定制**。项目版叠加 `readHeadMeta` 标题、`hiddenIds` 过滤和目录缓存；升级 SDK 时仍应复核是否值得迁移。 |
| 3 | `src/ops/statusline.js` 从消息 usage 计算上下文信息 | `Query.getContextUsage()` | **已采用权威值并保留降级**。活跃实例通过 `getContextUsage()` 取 `maxTokens` / `percentage`；无活 `q`、超时或异常时回退静态模型窗口映射。SDK categories 不属于 CLI statusline 字段，当前有意不向 Web payload 透传。见 §6。 |
| 4 | `src/agent/agent.js` `bgTasks` 注册表 + TTL 清扫 | `Query.backgroundTasks()` / `stopTask()` | **非重复**。SDK `backgroundTasks()` 只返回 boolean，项目需要逐任务 type/message 驱动角标和卡片；单任务停止已经通过 `stopTask(taskId)` 接入，整体 `interrupt()` 仍保留独立语义。 |

**小结**：没有纯粹的无谓重复；#3、#4 已复用 SDK 能力，#1、#2 仍因 transcript 过滤和产品元数据保留项目适配层。

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

- [x] `getContextUsage()`（#3）——已接入 `src/ops/statusline.js`；权威 `maxTokens` / `percentage` 优先，1.5s 超时或无活实例时回退，categories 有意不透传。
- [x] `stopTask()`（#4）——已由 `src/agent/agent.js` 接入，并通过 `task:stop` Socket 事件暴露单任务停止；与整轮 `interrupt()` 分离。
- [ ] `listSessions()`（#2）——`src/sessions/history.js` 的扫盘是否该改用它？确认 `SDKSessionInfo` 是否已含项目要的标题/隐藏过滤。
- [ ] `getSessionMessages()`（#1）——`SessionMessage` 是否已补 `isMeta`/`isSidechain`？补了则 #1 的"不迁"理由失效。
- [ ] `/bridge` 是否脱离 `@alpha`？转正即意味官方远程接入商品化到位，需重估本项目远程部分的护城河。
- [ ] 项目在用的 10 个可调用接口（§2）签名有无 breaking：`query` / `deleteSession` / `resolveSettings` / `interrupt` / `setModel` / `setPermissionMode` / `supportedModels` / `getContextUsage` / `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` / `stopTask`。

> 复查方法：`grep -nE "^export (declare )?(function|class)" node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 看顶层导出；
> `sed -n` 读 `Query` interface（`interface Query extends AsyncGenerator`）看运行时方法；
> 版本 diff 见 §7 的 `npm pack` 方法。

## 6. `getContextUsage()` 的当前实现边界

状态：**已实施**。

- `src/ops/statusline.js#getContextUsageSafe` 对活跃 Query 发起最多 1.5s 的 RPC；无方法、超时或异常均返回 `null`，不会阻断状态栏。
- `buildWebStatusLine` 优先采用 SDK 的 `maxTokens` 与官方 `percentage`，避免 1M 上下文被静态映射误判为 200k；无活 Query 时仍使用 `contextWindowSize(model)` 兼容历史和 idle 会话。
- token 明细继续取消息流 `lastUsage`；成本、git、缓存命中倒计时仍由项目实现，因为 `getContextUsage()` 不提供这些口径。
- categories 是 CLI `/context` 的展开明细，不是 CLI statusline 字段；当前契约有意不下发，避免把历史方案误当成现有协议。
- 行为由 `tests/unit/statusline.test.mjs` 覆盖：权威值、无 Query、异常、超时降级和 categories 不透传。

## 7. 历史版本对照（2026-07-13 快照）

- **本项目**：`package.json` 声明 + `node_modules` 实装均 **0.3.201**。
- **当日 registry 快照**（仅代表 2026-07-13）：`latest` = **0.3.207**、`next` = **0.3.208**。不要据此判断今天的最新版。

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

**该快照的结论**：0.3.201→0.3.207 之间，当时项目使用的 `query` / `Query` / `Options` / hooks 接口无签名变化。新增类型是消息流和控制协议的增量，`src/agent/agent.js` 的 `map()` 默认分支会记录未知消息而不使消息泵崩溃。本结论不是对更新版本的兼容性承诺。

- **升级动作**（若决定升）：`npm i @anthropic-ai/claude-agent-sdk@latest --omit=optional`（`--omit=optional` 避二进制 optionalDependency 的 EBADMACHO 坑），改后**重启常驻 server**。
- **复查方法**：升级前在隔离临时目录 `npm pack @anthropic-ai/claude-agent-sdk@<目标版本>`，解包后将 `sdk.d.ts` 与本地版本逐面 diff；同时运行本项目完整检查，不直接依赖历史 `latest` 数字。

## 8. 官方治理条款（约束本项目使用方式）

从 overview 页面摘取，直接影响本项目定位/合规：

- **第三方订阅禁令（关键）**：官方原文——"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." → 本项目**自用**（机主自己的订阅 + 自己的机器）**不违反**；但**若变成 hosted SaaS、让别人用机主订阅额度就违反**。这是"不做 SaaS 中转"定位的**官方铁证**（见 `docs/design.md §1`）。
- **Agent SDK vs Managed Agents**：官方另有 **Managed Agents**（hosted REST API：Anthropic 跑 agent + sandbox、session 存 Anthropic event log）。本项目属 **Agent SDK** 路线（你的进程、你的文件、JSONL 在你的文件系统）。§4 的 `/bridge` 疑似其底层传输。二者对立正是本项目价值支点。
- **Branding**：不得用 "Claude Code" / "Claude Code Agent" 命名或模仿其 ASCII art；可用 "Claude Agent" / "Powered by Claude"。本项目名 `claude-chat-mobile` 合规。
- **License**：SDK 使用受 Anthropic Commercial Terms of Service 约束（独立于本项目自身的 AGPL-3.0-only，见 `docs/design.md`）。
- **认证矩阵**：API key（`ANTHROPIC_API_KEY`）/ Bedrock（`CLAUDE_CODE_USE_BEDROCK`）/ Vertex（`CLAUDE_CODE_USE_VERTEX`）/ Foundry（`CLAUDE_CODE_USE_FOUNDRY`）/ AWS。本项目走**本机 CLI 已登录的订阅认证**（`pathToClaudeCodeExecutable` 指本机 claude），不在此矩阵内——这也是它必须"单机自托管"的技术根因。
