# 硬性规则与技术债索引

> **定位**：维护者在改代码前应对照的「产品 + 架构 + 工程」硬约束清单。  
> **产品立场（2026-08 仍有效）**：**n=1 自托管**——单机主、权限等同本机账号，不做多租户 / 多账号隔离。  
> **与其它文档的关系**：
>
> | 文档 | 管什么 |
> |------|--------|
> | [架构说明](architecture.md) | Web/CLI 双通道、单驾驶员、事件信封 |
> | [展示契约](display-contracts.md) | 模型 / effort / statusline 允许的变换 |
> | [仓库地图](repository-map.md) | 文件归属与 inventory |
> | 本文 | **不变量、n=1 取舍、已决「不做」、门禁锚点** |
>
> 历史 design 规格文档已下线。代码注释里残留的 design 文档路径 / `AD-*` / `NFR-*` / `SP-*` 引用，以**本文 + 当前实现 + 单测**为准，不必再找那份文件。

---

## 1. 产品边界（改这些等于换产品）

| 规则 | 说明 | 锚点 |
|------|------|------|
| 终端等价 | Web ≈ 本机对 claude 打字；CLI 有什么 Web 就有什么 | `CLAUDE.md`、Agent SDK |
| 单用户 = 机主 | 无多用户/租户隔离；鉴权通过 ≈ 本机启动 claude 的权限 | [README 安全模型](../README.md#安全模型) |
| 不是远程桌面 / 共享 TTY / 多租户托管 | 不附着终端 stdin/stdout | [architecture.md](architecture.md) |
| 尽量不重复造轮子 | 功能先看 Claude Code CLI / Agent SDK | `CLAUDE.md` |

---

## 2. n=1 取舍（有意瘦身，不是漏做）

下列设计在 **「每实例单用户 / 一人为主」** 下成立。若目标变成多租户、团队账号、或「一人多机同时看不同会话且互不串台」，应**先改本文立场**再开大改，而不是在局部打补丁。

### 2.1 全局查看上下文

| 单例 | 含义 | 代码 |
|------|------|------|
| `viewingInstanceId` | 服务端当前查看 tab；全员共享 | `src/server/app.js` |
| `viewingCwd` | 当前工作区上下文；新建会话 / statusline / 白名单缺省 | 同上 |
| `mirrorReadonly` + 全局广播 | 只读镜像锁是**全局单值**，非 per-连接 | `src/server/mirror-engine.js` |
| 前端镜像视图 | 按 `viewingInstanceId` 分流渲染 | `public/js/app.js` |

**已知缺陷（n=1 接受）**：两台设备同时看不同会话时，会话 B 的 `mirror_state` 可能误解锁正看 A 的一端。见 §5 AD-5。

### 2.2 进程内易失态

| 状态 | 取舍 |
|------|------|
| 鉴权限速 Map | 内存；重启清零（残余风险可接受） |
| `/metrics` 计数 | 内存；重启清零；**JSON 快照**，非 Prometheus 文本（单机主无 scraper 的默认运维面） |
| 额度 / rate 快照 | 单例、不分账号 |
| 消息去重等 | 内存即可 |

**硬约束**：历史回显走鉴权 `session:history`；**不开无鉴权 HTTP 数据端点**。

### 2.3 安全哲学

| 规则 | 说明 |
|------|------|
| 已鉴权 ≠ 限操作面 | 限速只挡鉴权口暴破；机主即 root，对操作面限速违背产品目的 |
| 工作区白名单 | 路径门，不决定 Claude 工具是否自动放行 |
| 范围内文件不敏感过滤 | `.env` 等照读——与「机主即 root」一致 |
| 子进程 env 不做白名单裁剪 | 指**继承环境**：与终端 claude 一致，第三方网关靠 shell `ANTHROPIC_*`。`src/shared/child-env.js` 只有两处例外——滤掉值为空串的键、追加 `CCM_STATUSLINE_ORIGIN` / `CCM_HOOKS_ORIGIN` 两个 origin 标记（后者是 hooks 桥判「这是 web 驱动的子进程、别重复推送」的依据）。另有一个**叠加层**方向相反：worktree 网关隔离读出的 `resolvedEnv` 经 `agent.js` 的 `filterSafeResolvedEnv` 只放行 `ANTHROPIC_*` / `CLAUDE_CODE_*` 才叠加上去，防 worktree settings 覆盖 `PORT` / `AUTH_TOKEN` / `CCM_DATA_DIR` 等服务端变量 |

---

## 3. 架构不变量

### 3.1 单驾驶员

详见 [架构说明 · 单驾驶员模型](architecture.md#单驾驶员模型)。摘要：

1. Web 驾驶时该 `AgentSession` 写入；前端一轮一条。  
2. 检测到 CLI 外部写入 → Web 只读镜像。  
3. CLI 仍在跑 → Web 不向同一会话发消息。  
4. 终端静默后解锁；Web 接管前若有 external 增长 → dispose + resume 吸收再发。  

**有意不修的边界**：本地 turn 的 busy→idle 吸收窗口内撞进的终端写入可能被吞（须切会话重载）。完整闭合见 §5 SP-10。

### 3.2 事件契约

| 项 | 规则 |
|----|------|
| 出向 | 唯一信封 `agent:event`（`type` + `seq` + `epoch` + …） |
| type 白名单 | **`src/shared/protocol.js` 的 `AGENT_EVENT_TYPES` 为唯一真相源**（当前 26 种） |
| 入向 | 同文件 `INBOUND_SOCKET_EVENTS`（当前 42 个） |
| 门禁 | `npm run check` → `scripts/contract-check.js` / `agent-event-contract.js` |
| 改 type | 必须同时改 protocol + 真实 emit 路径 + mock + 前端 handler（否则 check 红） |

### 3.3 状态落点与模块边界

| 规则 | 门禁 |
|------|------|
| 新状态**不要**再进 `public/js/app.js` / `src/server/app.js` 顶层 | 约定 + review |
| 前端：`public/js/app/*` 工厂 + context | 样板 `event-dispatch.js` |
| 后端：所属域模块；`src/server` 仅组装根；`src/shared` 叶子 | `scripts/check-import-boundaries.js` |
| 运行时不得 import `scripts/` / `tests/` | 同上 |
| 零循环依赖 | 同上 |

### 3.4 展示（摘要，细节见 display-contracts）

- 条数/语义对齐 TUI；禁止偷偷合并、用 Web 偏好冒充 CLI 态。  
- Statusline **禁止** CLI/Web 字段混拼（额度账号级回落是唯一例外且须标非实时）。  
- 改契约：先改 `tests/unit/display-contracts.test.mjs`。

---

## 4. 工程硬规则

### 4.1 分支

- 日常只在 **`dev`**；不在 `master` 直接改。  
- 发版：`dev` ff → `master` + `scripts/release.sh`。  
- 其它分支 worktree 在仓库外兄弟目录，不是本树源码。

### 4.2 测试跑在哪（白名单，非黑名单）

**宿主机只允许**：`npm run lint` · `npm run check` · `npm run test:unit` · `npm run test:e2e`（及 visual/playwright 同源别名）。

**其余一律容器**：`test:docker` · `mutate:docker` 等。

**单独授权例外**：`RUN_CLAUDE_INTEGRATION=1` · `npm run test:smoke`。

根因：2026-08-02 宿主机 `mutate` 误删 `~/.claude/projects`。钩子实现见 `scripts/guard-host-tests.js`。

### 4.3 `npm run check` 包

ESLint · import 边界 · 双向事件契约 · 文档一致性 · i18n 孤儿 key · 破坏性删除 · visual mock registry · Playwright 禁止模式 · inventory。

删除豁免标记（不通用）：

- 测试 recursive：`// safe-rm: 理由`（须可追溯 mkdtemp）  
- 生产单文件路径难审计：`// safe-path: 理由`  
- **为单文件批的豁免不放行 recursive**

Playwright 禁止：`test.only` / `skip` / `fixme` · `networkidle` · `waitForTimeout`。

### 4.4 生产运维

- 常驻服务占端口：**勿再手动 `npm start` 撞端口**。  
- 改 `.env`/代码须**重启**常驻进程。  
- **例外**：`workdirs.json` 热加载；被移除目录仅拒新开。

### 4.5 产品 UX 已决

- 重启/空闲回收后停**空首页**，只展示最近列表，**不自动** `session:switch`。  
- dispose / resume 失败默认**禁止跨工作区闪回**（用户主动关 tab 可允许）。  
- 忙碌中禁止 externalDirty 的 dispose+resume 置换（SRV-003）。  
- 服务状态面板只渲染判定化告警，不展示裸计数器（原始数留 `/metrics`）。  
- 推送 body 最小化（SEC-04）；完成类通知在前台在线时可不推。

---

## 5. 已评估不做的技术债（无新证据别重开）

| ID | 内容 | 决定 | 登记处 |
|----|------|------|--------|
| **AD-5** | per-(sessionId, connId) 镜像锁 + `readonly_changed` 定向下发 | **不做**（2026-07-12 机主确认，Phase 8） | `mirror-engine.js`、`app.js` 注释 |
| **SP-10** | busy→idle 吸收完整闭合（前端 uuid 幂等 + live 记 uuid） | **不做**（同上） | `history.js` `catchUpStep` 头注 |
| **OQ-09** | 审批时延等「人机/价值」埋点遥测 | **拒绝**；管道健康指标可走 `/metrics` | `metrics.js` |
| **UP-1** | 让 web 端 slash 像终端那样 inline 跑（见 §5.1） | **做不到**（上游约束，2026-08-05 查证） | `agent.js#_claimSessionIdEarly` 注释 |

**重开条件（任一条）**：

1. 产品明确放弃 n=1，或实测「一人多机看不同会话」成为常态痛点；或  
2. 有可测复现 + 愿意承担 AD-5 / SP-10 全链路改动面。  

否则：**别因「设计验证通过」或「理论上更干净」重启这两项。**

### 5.1 web 端 slash 命令恒 fork（UP-1，上游既定行为，不是 bug）

`/code-review` 这类内置 skill 在 web 端**从来没有 inline 跑过**，也不会有。CLI 2.1.222 的判据：

```js
$Dl(e) = printOutputFormat ∉ {text,json}
       && CLAUDE_CODE_REPORT_FINDINGS
       && options.tools.some(r => r.name === "ReportFindings" || r.aliases?.includes(…))
// 真 → getContext 返回 "inline"；否则 "fork"
```

**判据是「宿主有没有 `ReportFindings` 工具」**（其描述原文：*so the host UI can render them*）。
终端有 → 结果直接渲染进对话；ccm 作为 SDK host 没有 → CLI 认定渲染不了 → fork 出去跑完只给一坨文本。

| 事实 | 证据 |
|---|---|
| web 14 次全 fork、终端 1 次 inline，**同为 xhigh 档** | 全盘 15 次调用扫描（2026-08-05） |
| 不是回归、不是档位、不是 ccm 代码 | 同上 |
| 整轮 `stream_event` = 0（两个转发开关都开着） | 隔离 SDK 探针 |
| `init` 132s 才到，`rate_limit_event` 9.5s 就带 `session_id` | 同上 |

**接不上的原因**（查过，别重开）：工具名匹配是精确匹配，SDK 自定义工具走 MCP、名字带 `mcp__` 前缀；
`CLAUDE_CODE_REPORT_FINDINGS` 是内部 flag，`sdk.d.ts` 未暴露。要通得等上游开口子。

**因此 fork 是既成前提**，我们只在此前提下改善可见性（三处，均已落地）：
sessionId 不独等 `init`（`_claimSessionIdEarly`）· 看门狗豁免本地命令在途（45 分钟上限）·
扫 `<sessionId>/subagents/` 喂既有 `bgTasks`（只喂进度不喂正文——单文件可达 762KB）。

> **判据陷阱**：判 inline/fork 只看「slash 之后**紧接着的下一条**主链条目」。
> 用「主链 assistant 累计数」会把用户后续对话算进来，得出不存在的回归转变点（2026-08-05 踩过）。

---

## 6. 安全分层（互不替代）

```text
HTTP/Socket 鉴权（AUTH_TOKEN 或 CF Access）
        ↓
设备信任（本机 / CF Access JWT 可豁免）
        ↓
WORK_DIR / workdirs.json 范围门
        ↓
CLI permissions.allow + Web 当前权限档
        ↓
Agent canUseTool 审批  ‖  用户文件编辑器直写（独立范围/大小/哈希/审计）
```

Fail-closed 要点：路径不可达、审批指纹不符、审批/提问 TTL 到期、重启后 pending 审批。

---

## 7. 改规则时怎么动

| 你想改的 | 动作 |
|----------|------|
| 展示语义 | `display-contracts` 测试 → 实现 → [display-contracts.md](display-contracts.md) |
| 事件名/type | `src/shared/protocol.js` → emit/handler/mock → `npm run check` |
| 模块分层 | `check-import-boundaries` 规则 + 拆依赖 |
| n=1 立场 / AD-5 / SP-10 | **先改本文 §2 / §5 与机主确认**，再开实现 |
| 仅措辞 | 改本文 + 必要时 `CLAUDE.md` / README 导航；跑 `npm run check` |

---

## 8. 速查

```
产品：n=1 机主 · 终端等价 · 非多租户 · 非共享 TTY
架构：单驾驶员 · agent:event 闭合（protocol.js）· viewing 全局单值
状态：新逻辑不进 app.js 顶层 · import 边界硬闸
安全：五层分立 · fail-closed · 推送 body 最小化
展示：不混拼 · 不猜 · 先改 display-contracts 测试
工程：dev 分支 · 宿主机四白名单 · 其余 docker · check 全绿
债：AD-5 / SP-10 在 n=1 下不做；无新证据不重开
上游：web slash 恒 fork（UP-1，判据＝宿主无 ReportFindings）；只改可见性，别当 bug 修
```
