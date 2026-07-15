# 设计与需求

> 本文记录产品要做什么，以及为什么这么做。

本文已吸收历史产品需求、高层架构和详细设计中仍与当前实现一致的内容；需求、架构边界和状态语义以后以本文为准，接口细节以 [interfaces.md](interfaces.md) 与 [event-contract.md](event-contract.md) 为准。

## 0. 需求判据

> **把"坐在电脑前对着 claude CLI 打字"变成"在手机上打字"，效果一样。**

唯一判据是**终端等价性**：对任何一次交互，问"此刻我若坐在终端前，会得到什么？"移动端必须给出**语义等价物**（形态可以不同：聊天气泡代替 TUI，弹窗代替 y/n）。

判据既是下界也是上界：

- **少于它 = 残缺**：claude 在终端能改文件跑命令，移动端只能聊天 → 不合格。
- **多于它 = 膨胀**：多用户、速率限制、自建消息数据库 → 终端没有这些，本项目也不许有。

**时间维度**：等价性不仅约束"注视时刻看到什么"，也约束**"agent 需要我"到"我知道"的延迟**。坐在终端前时，这个延迟近似为 0；移动端注意力是间歇的，没有主动触达就可能一直等下去。

**对象维度**：等价的对象是 **agent 能力**（对话、工具、技能、审批、上下文管理、resume、模型切换；SDK 全部暴露，`init` 事件的 `slash_commands` 是其机器可读边界），**不包括终端客户端自己的 UI**（`/plugin`、`/config` 等面板）。后者用 app 自己的 UI 或自然语言替代，不复刻终端面板。

### 验收剧本（最终验收以此为准）

> 22:30，躺在床上，手机发出："把 utils 里重复的日期处理合并成一个函数，跑通测试"。
> 屏幕上流式出现 claude 的回复，夹着 `Read`、`Edit`、`Bash(npm test)` 的工具调用卡片。
> 22:31 锁屏，刷十分钟视频。
> 22:39 解锁，页面自动重连并补上错过的全部输出：测试已通过，有一条待批准的权限请求——弹窗里是完整命令 `git commit -m "..."` 和工作目录。点"允许"。
> 22:40 回复："再给 CHANGELOG 补一行"。claude 记得它刚才改了什么，直接续上。

这个剧本同时检验流式输出、工具过程可见、断线任务存活、重连续传、权限审批和真实会话连续，全部属于 P0。

## 1. 用户与信任模型

- **每实例单用户**：每个自托管部署的用户 = 部署者 = 管理员。项目面向所有人开放自托管，但单个实例被设计为一个人用。
- **机主即 root**：通过鉴权的请求拥有与"本人坐在终端前"完全相同的权力。这是产品目的，不是漏洞；漏洞是"未通过鉴权的人获得这个权力"。
- 单个实例不做"多 X"（多用户、多租户、用户名体系、配额）。那是另一类产品；每个部署都是单用户的。

## 2. 终端等价性清单

每条 `E#` 是一项功能需求，是验收剧本与实现的需求主体。

| # | 终端里你拥有的 | 移动端规格 | 优先级 |
|---|---|---|---|
| E1 | 同一会话连续，claude 记得读过/改过什么 | claude 原生 session：首条消息捕获 `session_id`，后续 resume | P0 |
| E2 | 真的干活：改文件、跑命令 | 权限统一闸门：claude cli 是什么就是什么，外推审批弹窗 | P0 |
| E3 | 权限确认 y/n | SDK 审批回调 → 弹窗（完整命令 + cwd + 参数）→ 允许/拒绝/本会话总是允许 | P0 |
| E4 | 看着它逐字输出 | 流式事件增量转发渲染 | P0 |
| E5 | 看到它在调用什么工具 | 工具调用/结果渲染为折叠卡片（工具名 + 参数摘要 + 状态） | P0 |
| E6 | Esc 中断生成 | 停止按钮 → SDK `interrupt()`；会话状态不受损，之后仍可 resume | P0 |
| E7 | claude 反问选择题 | 选项按钮组（`canUseTool` 特判 `AskUserQuestion`，`deny+message` 作答案回传） | P1 |
| E8 | `/skill`、自定义命令、`/model` | 斜杠命令透传：`init.slash_commands` 列出的直接执行；TUI 命令前端拦截或自然语言替代 | P1 |
| E9 | 加载我的 CLAUDE.md / MCP / hooks / skills | 完整加载本机配置——操作的是"我的 Claude Code" | P0 |
| E10 | 离开再回来，任务还在跑、输出还在 | 任务挂在服务端、与 socket 解耦；事件带单调 `seq`，重连按 seq 续传 | P0 |
| E11 | Ctrl+C 后 `--continue` 接着聊 | session 元数据持久化（含权限档/思考强度），服务重启后可恢复列表并 resume；web 端续接恢复会话最后生效的档（终端不恢复权限/effort，是 web 增强） | P0 |
| E12 | Markdown/代码可读 | marked + highlight.js + DOMPurify，小屏适配，代码块横向滚动 | P0 |
| E13 | `claude -r` 选择和管理历史会话 | 会话列表 + 新建 + 切换 + 关闭 tab；L1 从 CCM 列表隐藏，L2 经二次确认与活跃保护后调用官方 SDK 删除 transcript | P1 |
| E14 | resume 时看到历史消息 | 切换/恢复会话时回显完整历史消息（流式读完整 CLI JSONL，与 /resume 同源；仅极端超大会话按防爆上限取尾） | P0 |
| E15 | 坐在终端前，审批/提问出现即被看到 | 推送触达：`permission_request`/`question`/断连期 `result` 三类触发 | P0 |
| E16 | 终端底部 statusLine（模型/ctx/成本/git 等状态感知） | **app 自有状态栏 UI + 单一来源路由**：Web 驾驶时取 SDK usage；CLI 驾驶时可经显式安装的透明 bridge 取该 session 的 CLI 快照。两源不混拼；CLI 快照不可用就显示未知，不拿 SDK 陈值冒充 | P2 |
| E17 | 把文件/截图丢给 claude | 文件/图片上传：落盘 `.ccm-uploads/` + 路径注入 + claude `Read` | P2 |
| E18 | 滚动回看并选中复制历史输出 | 消息体「⧉ 复制」按钮，拷原始 Markdown 源文 | P3 |
| E19 | 了解底层通信和调试诊断 | 交互与系统日志面板：前端 logs 面板通过 `logs:get` 调取，并通过 `session_log` 实时投影系统消息、过滤决策和底层 Socket 事件，方便排错 | P2 |

**终端有、但明确不追求的**：tab 补全（无意义）、TUI 视觉形态（聊天 UI 是有意替代）、提示历史召回（终端 ↑ 键，微摩擦）。statusLine 的账号级配额段在 SDK 路径仍不可得；显式启用 CLI bridge 后，只在 CLI 快照实际携带时展示。

## 3. 移动端独有的四个问题（终端没有的）

它们是下方不变量的来源：

1. **公网暴露**：终端的信任边界是"物理坐在机器前"；隧道把边界搬到公网。本项目一旦对外暴露，就是**暴露在公网上的任意代码执行通道**，安全优先级最高。
2. **会话碎片化**：手机使用模式是"看 30 秒 → 锁屏 → 10 分钟后再看"。**断线重连是主路径，不是异常分支**。
3. **小屏与弱网**：渲染与传输效率。
4. **注意力非对称**：agent 可以一直等，人不一定知道它在等。**不超时 + 无触达 = 无界死等**（E15 的来源）。

### 用户可观察状态

| 状态 | 含义与判定边界 |
|---|---|
| 运行中 | Agent 正在推进当前轮次 |
| 等待我审批 | 存在未决 `permission_request`，需要操作者决定 |
| 等待我输入 | 存在未决 `question`，需要操作者回答 |
| 已完成 / 已失败 / 已中止 | 由真实 `result` 或显式中断产生的终态 |
| 主机离线 | 客户端无法确认主机状态；不得把失联推断为已完成 |

后端从运行时信号派生前四类，`host_offline` 由客户端心跳/连接状态判定。恢复连接后必须按服务端真实状态重判；任何不可确认状态都按 fail-closed 原则显示为不确定。

## 4. 安全模型

本项目本质上是一条**把本机 shell 暴露到公网的代码执行通道**。安全模型由此而来：

- **漏洞的定义** = "未通过鉴权的人获得这个权力"。一切防护都围绕"鉴权边界"展开，而不是限制已鉴权用户能做什么；终端本身也不会有这层限制。

### 安全不变量（违反即回退）

1. **不设 token 则不出本机**：未设置 `AUTH_TOKEN` 时，服务**只监听 `127.0.0.1` 并在启动时醒目警告**；要对外（隧道）服务必须设 token。**不存在"留空 = 公网裸奔"路径。**
2. **token 卫生**：token 经 `/#token=<值>` 首次注入后**立即从地址栏清除**并存 localStorage；token 可通过改 `.env` 重启轮换。等值比较用 `crypto.timingSafeEqual`（防计时侧信道）。
3. **审批信息完整性**：审批弹窗必须展示**完整命令 + cwd + 关键参数**，不得只显示工具名——移动端审批的上下文密度低于终端，信息完整性是硬约束。
4. **透明性**：中间层不加工 claude 的语义输出（不删改、不摘要、不"优化"）；上下文管理是 claude 自己的事。
5. **物理性**：任务生命周期 ≥ 连接生命周期（socket 断开不中断任务）；等待用户输入（审批/提问）时不超时；agent 静默超过 `IDLE_TIMEOUT_MS` 视为挂死 → 中断并报告。
6. **`bypassPermissions` 护栏**：默认关、无自动进入路径、须 UI 显式切换 + 一次危险确认。机主已选择可对外开放（含公网）时，**该档下审批缓解失效，开启即接受爆炸半径 = 整机**。代码里不得加任何自动进入 bypass 的路径。
7. **公网 fail-closed**（启用 Cloudflare Access 时）：经 CF 的公网请求**强制验签 Access JWT、不接受 token 回退**；按 Host 判定鉴权，堵死"不发头改走 token 路"的后门。
8. **不开无鉴权数据端点**：历史回显走鉴权的 `session:history` socket 事件；`/health` 在设 token 时也需鉴权——避免对外泄漏运行状态。
9. **TOFU 设备信赖（纵深防御）**：非本地（localhost）且非 Cloudflare Access 验证通过的连接，必须通过机主在主机端的一次性显式授权。未授权连接的**所有上行 Socket 事件均被拦截丢弃**，从 `src/server/socket.js` 统一事件过滤点 fail-closed 执行。
10. **预览只读且不越界**：`tool:preview` 经 `attributePath` 唯一闸门（路径归属 + symlink + realpath 二核）只读白名单工作目录内文件；**即便 claude 曾按 `permissions.allow` 读过白名单外文件，预览一律拒绝**，绝不借预览通道退化成任意文件读。
11. **诊断输出脱敏**：`doctor:run` 安全体检**只回显布尔 / 计数 / 危险规则串**，绝不外泄明文 token / 密钥 / 绝对路径 / AUD——体检是防御工具，其报告本身不得成为新的泄露面。
12. **statusline 来源不混用**：Web 驾驶只信 SDK，CLI 驾驶只信通过 session/cwd/TTL/权限校验的新鲜 CLI 快照。快照目录须为 `0700`、文件须为 `0600`；缺失、过期、超限或校验失败一律显示不可用，不按字段回退另一来源。

### 威胁矩阵

资产：本机 shell / 文件系统 / 代码库 / Anthropic 凭据。

| 入口 | 攻击 | 缓解 |
|---|---|---|
| 隧道 URL 泄漏 | 拿到 URL 即尝试连接 | `AUTH_TOKEN` 强制（不变量 1）；进阶：命名隧道 + Cloudflare Access |
| token 泄漏 | 浏览器历史 / 截图 | 注入后清 URL；token 轮换；**纵深防御：TOFU 设备授权** |
| 未授权设备仿冒 | 恶意构造 `deviceToken` 暴力破解 | `src/auth/devices.js` 0600 持久化；未批准设备上行事件全部丢弃 |
| 提示注入 | claude 读到的恶意内容诱导执行危险操作 | 白名单保守 + 审批弹窗完整展示命令。**`bypassPermissions` 档下此缓解失效** |
| 默认白名单自放行链 | `Write` + `Bash(npm run *)` 可组合成自动执行链 | 高风险/公网应收紧白名单；审批弹窗始终是最后闸门 |
| 输出 XSS | claude 输出含恶意 HTML | DOMPurify + CSP（`script-src 'self'`，无内联脚本） |
| 参数注入 | 消息文本被解析为 CLI 参数 | 经 SDK 结构化传参（不拼 shell 字符串） |
| 路径穿越 | `session:switch`/上传借 `../` 越界读写 | session id 字符集守卫 `^[0-9a-zA-Z_-]+$`；上传 O_NOFOLLOW/O_EXCL + 落点校验；`WORK_DIRS` 精确白名单匹配（支持热加载：改 `workdirs.json` 即时重载，移除目录不终止已开实例、仅拒新开；条目支持 `{path, sessionLimit}` 配置每区会话显示条数） |
| 工具预览越界读 | 诱导 `tool:preview` 读白名单外文件（含 claude 曾按 `permissions.allow` 读过的越界文件） | `attributePath` 唯一闸门 + symlink + realpath 二核（不变量 10）；非白名单一律拒，只读不成为任意文件读 |
| 同机他用户读配置 | 多用户机器上偷 `sessions.json` 等 | 配置文件 0600 + 真原子写（tmp→fsync→rename） |
| 安全体检泄敏 | `doctor:run` 回显明文 token / 密钥 / 路径 | 全程脱敏，只出布尔 / 计数 / 危险规则串（不变量 11，`src/ops/doctor-runtime.js`） |
| CLI statusline 快照串会话 / 陈值冒充 | 读到别的 session/cwd 或过期状态后仍展示 | 文件名按 session 哈希隔离；内容再验 session/cwd/schema/source/TTL/大小/权限；失败不混入 SDK（不变量 12） |

### 部署加固建议

- 公网常驻：上 Cloudflare Access 双因素，不要长期裸用随机隧道。
- 收紧 `.claude/settings.json` 的 `permissions.allow`：移除 `Write`、`Bash(npm run *)` 等可组合成自放行链的项。
- 把 `WORK_DIR` 固定到具体项目目录，不要用 `$HOME`。
- VAPID/Anthropic 凭据只从启动 shell 注入，不写 `.env`。

## 5. 验收

验收 = 可手工执行、结果可观察的剧本（不是单元测试覆盖率）。**P0 全过 + 剧本完整通过 = 项目完成。**

### 验收纪律

针对 SDK/CLI 能力的假设（"某选项存在"、"某字段有效"）必须有**语义级断言**。脚本要观察实际行为（如 `result.models` 含目标模型、选题弹窗回答后 assistant 正确引用答案），不能只断言"轮次完成"。

### 验收剧本

| # | 验收 | 剧本 | 通过判据 |
|---|---|---|---|
| A1 | 会话连续（E1） | 发"创建 /tmp/a.txt 写入 hello" → 完成后发"刚才那个文件里写了什么" | 第二问直接答 hello，全程无复述；重启 server 后第三问仍接得上 |
| A2 | 干活能力（E2） | 发"在 WORK_DIR 新建 demo.md 写两行" | 文件真实出现在磁盘 |
| A3 | 审批闸门（E3） | 发"git push"（白名单外） | 手机弹窗显示完整命令与 cwd；拒绝后 claude 报告"用户拒绝" |
| A4 | 过程可见（E5） | 剧本 | 能看到 Read / Edit / Bash 卡片依次出现 |
| A5 | 锁屏续传（E10） | 发起 ≥1 分钟任务 → 立即锁屏 2 分钟 → 解锁 | 自动重连，错过的输出完整补上，无重复无丢失 |
| A5b | 迟到观察者 | 任一轮完成后：新设备连接、**不发任何消息**；重启 server 后再来一遍 | 连接后 2s 内收到 `epoch:'server'` 的 init 与非空 models |
| A6 | 中断不毁会话（E6） | 任务进行中点停止 → 再发"继续刚才的" | 中断即时生效；新消息在同一会话上下文中继续 |
| A7 | 鉴权（安全不变量） | 不设 `AUTH_TOKEN` 启动；设 token 后用错误 token 握手 | 前者只听 localhost 并警告；后者握手被拒 |
| A8 | 审批挂起跨锁屏 | 触发审批 → 不响应锁屏 10 分钟 → 解锁 | 弹窗仍在（不超时），批准后任务继续 |
| A9 | 环境预检 | 在无 claude 命令的环境启动 | 启动失败并给出可读的原因与修复提示 |
| A10 | **北极星** | §0 剧本 | 完整通过 |
| A11 | 触达（E15） | 触发审批 → 锁屏/杀掉浏览器 → 等待 | 手机秒级收到系统推送，点开直达审批弹窗 |
| A12 | 状态栏投送（E16） | Web 发一轮验证 SDK source；显式安装 bridge 后在 CLI 发一轮并从 Web 只读查看；再让快照过期，最后以 `WEB_STATUSLINE=off` 重启 | Web 驾驶只显示 SDK 值；CLI 驾驶显示同 session 的 CLI 值（含实际携带的 effort/额度）；过期时明确不可用且不混 SDK 陈值；关闭后无 UI 痕迹 |
| A13 | 多 repo 切目录 | 设 `WORK_DIRS=dirA,dirB` → 切到 dirB 建会话 → 切回 dirA | 会话列表按 cwd 隔离；非白名单 cwd 被拒 |
| A14 | 同仓库会话并发 | 会话 1 发长任务（在跑）→ 同 cwd 开会话 2 → 切回会话 1 | 会话 1 仍在跑、未被中断；两 tab 权限档独立 |
| A15 | TOFU 设备信赖 | 公网新设备首次接入，注入正确 `AUTH_TOKEN` | 提示"等待主机授权"；未授权消息被丢弃；授权后恢复正常 |

### 冒烟脚本

> ⚠️ 除 `--list` 外都会调用真实 Claude CLI 并可能消耗 token。runner 自动使用随机端口、临时工作目录和临时 `CCM_DATA_DIR`；零 token 行为优先由 Node/Playwright 自动化覆盖。

```bash
npm run test:smoke -- --list
npm run test:smoke -- --scenario core
npm run test:smoke -- --all
```

场景说明、执行边界与历史 runner 覆盖映射见 [testing.md](testing.md)。

### 提交前自检

> 跑测试需先完整 `npm install`（含 devDependencies；首次全装会为视觉测试拉取 chrome）。用户端只需 `npm install --omit=dev`。

```bash
npm run check              # JS 语法 + 文档/清单/visual mock 守卫（零 token、最快）
node scripts/doctor.js     # 启动前配置自检；含文档一致性、前端 JS 语法、覆盖率提示
npm run test:unit         # 纯逻辑单测（node:test，零 token）
npm run test:e2e          # Playwright 移动端 UI 回归（零 token，连接测试 Mock）
```

## 6. 非目标（与 P0 同等用力维护）

| 不做 | 理由 |
|---|---|
| 多用户 / 登录 / 用户名 | 每实例单用户；终端不会问你"你是谁" |
| 业务配额 / 用量限流 | 单用户实例不做产品配额；鉴权失败限速是安全边界，必须保留 |
| 自建消息数据库（SQLite/消息表） | Claude 原生 transcript 是唯一消息事实源；服务端只存控制面元数据。会话删除直接作用于可见引用或官方 transcript API，不另造消息表 |
| 消息搜索 / 导出 / 统计面板 | 终端没有；需要时 `~/.claude/projects/` 里都有 |
| 中间层智能（摘要、自动重试编排、上下文管理） | 中间层只转发；上下文管理是 claude 自己的事 |
| 终端模拟器（xterm.js / PTY） | 形态非目标，聊天 UI 是有意选择 |
| 原生 App / 离线模式 | 浏览器 +（可选）PWA 足够。禁的是 App 化与离线缓存；service worker 仅为 Web Push 服务不在此禁令内 |
| 通用工具库 / "企业级"日志体系 | 管子不需要脑子；`console` + 时间戳够用 |
| 前端框架 / 打包器 | 零构建是规格的一部分（原生 ESM、无 bundle）；Playwright 与 Node test 只属于开发验证，不进入运行时 |
| 真实 Claude CI | CI 只跑零 token Node 与 Playwright Mock 测试；需要本机 Claude 的 smoke 必须显式 opt-in |

**最终成功度量**：连续一周，晚上想让 claude 干活时，不再需要走到电脑前。

## 7. 分支与发布模型

> 每个部署实例是单用户的（§1），但源码是面向所有人的开源产品：大家会 clone、fork、自托管和贡献。分支模型服务后者，用来区分"稳定/已发布"和"开发中"。

- **`master`** — 稳定发布线，也是 GitHub 默认分支，`git clone` 默认拿到的就是它。只在发版时经 `dev` → `master` 更新。
- **`dev`** — 日常开发集成线。feature 分支从 `dev` 切，PR 合回 `dev`。
- **发版** — `dev` → `master` + 打 `vX.Y.Z` tag + GitHub Release（使用者的稳定引用）。
- **CI**（`.github/workflows/test.yml`）：`push` 到 `master` / `dev` 与所有 PR 都跑 `npm test` 和 mock-only `npm run test:e2e`。
- 自己的常驻服务（见 `deployment.md`）想尝鲜 pull `dev`、想稳 pull `master`，不强制。

## 8. Workflow / 子 Agent 的 Web 端行为

> Claude 的 workflow（工作流）会 spawn 子 agent，产生多路并发的消息流。本节记录它们在 web 端的显示行为，以及 web 端续接一个 CLI 正在跑的 workflow 会话时能看到什么、不能看到什么。
>
> 📎 **接口参考**：前后端完整接口（HTTP 端点、Socket.IO 双向事件、内部模块 API）见 [interfaces.md](interfaces.md)；出向 `agent:event` 26 类的可执行契约见 [event-contract.md](event-contract.md)。

### 运行中（web 端发起的 workflow）

- **子 agent 内部流不外露**：带有 `parent_tool_use_id` 的消息（subagent 的流式输出、中间 assistant/user 记录）在后端统一过滤，不进入主会话消息流。这与终端行为等价：终端也不把 workflow 子进程的逐字输出合并到主 tty 上。
- **进度横幅**：`task_progress` 系统事件在输入框上方显示瞬时横幅（不占 seq、不进历史）：
  - 启动 `Agent`/`Task` 工具时 → 🤖 横幅（显示 subagent 的 description）；全部完成后隐藏
  - workflow 阶段（无 subagent_type）→ ⏳ 横幅（如 "Synthesize: 合并结果"）
- **完成通知**：轮次结束时以 `task_notification` 卡片展示任务摘要（截断至 600 字符）；同步触发 web-push，使 web 端发起的任务能在后台完成时送达手机。

### 续接含 Workflow 历史的会话

- **历史回显过滤**：`src/sessions/history.js` 读取 CLI JSONL 时跳过 `type:mode`（web 自身 resume 写入的）、`<task-notification>` 系统注入、以及 content 全为 tool_use/tool_result block 的纯工具条目。历史里只剩主线文字气泡和工具调用卡片。
- **subagent 记录不回显**：运行期 `src/agent/agent.js` 按 `parent_tool_use_id` 跳过子 agent 消息；历史侧 `src/sessions/history.js` 按磁盘 JSONL 的 `isSidechain` 标记过滤（`parent_tool_use_id` 是 SDK 运行时流字段、不落盘，故防御性一并挡），两侧等效。含带正文的子 agent 记录也不回显。

### 续接 CLI 活跃 Workflow 会话（只读追平）

- **已完成部分可见**：只读追平轮询 transcript 文件（每 2.5s），有新行即追加到消息流并置只读状态。轮次完成后的内容可见。
- **进行中的内容不可见**：CLI 活跃轮次的中间输出不落盘（JSONL 只在轮次结束后写入），追平无法看到 workflow 各阶段的实时进度。这是架构限制，不是 bug（见 [[web-resume-cannot-mirror-live-cli]]）。
- **无 web-push**：只读追平续接的是 CLI 发起的任务，server 端没有 pending 的 socket session，后台完成推送不触发。

## 9. 当前架构与数据归属

当前实现按职责分层，根目录 `server.js` 只负责兼容启动；运行时组合位于 `src/server/app.js`：

| 边界 | 职责 |
|---|---|
| `src/agent/` | Agent SDK 会话、审批、CLI 镜像与模型/消息辅助状态 |
| `src/auth/` | Cloudflare Access、设备信任、指纹和限速 |
| `src/files/` | 工作目录边界、浏览/预览与上传 |
| `src/sessions/` | CLI 历史、会话元数据、工作目录与注意力投影 |
| `src/ops/` | 审计、指标、通知、doctor 与 statusline bridge |
| `src/server/` | 配置预检、HTTP、Socket、实例生命周期与服务组合 |
| `src/shared/` | 跨域且无业务归属的原子写入与脱敏工具 |
| `public/js/app/` | 原生 ESM 客户端领域模块，通过显式 app context 共享 DOM、状态、Socket 与依赖 |

数据事实源只有三类：

1. `~/.claude/projects/` 中的 Claude transcript 是消息与原始对话事实源，项目不复制为消息数据库。
2. `CCM_DATA_DIR`（默认 `./data`）只保存会话指针/偏好、设备信任、审批、审计、推送与缓存等 CCM 控制面数据。
3. 各工作目录内的 `.ccm-uploads/` 保存用户主动上传给 Claude 的附件，可清理但历史消息中的旧附件路径会随之失效。

写入必须保持 owner-only 权限和原子替换；不同领域仍保留独立存储接口，仅共享 `src/shared/serial-writer.js` 的串行写入原语。目录与文件的逐项用途、生成方式和保留策略见 [repository-map.md](repository-map.md)。
