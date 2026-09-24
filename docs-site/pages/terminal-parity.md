# 终端等价性
> CLI 有什么 Web 就有什么；权限与配置同源。

- **Part**: 第三部分 · 方法论
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~2299

---

核心产品目标是终端等价：终端 CLI 有什么，手机上的 Web 就有什么。实现上不重造 Agent 调度，而是由 Agent SDK 驱动本机的 `claude` CLI，共用同一套配置、权限与 transcript。

## 等价原则与心智模型

 
当你不知道某个功能该怎么做时：CLI 有什么 web 就有什么，先去找 claude code CLI 是怎么实现的。—— `CLAUDE.md`
 

本项目不是远程桌面投屏，也不是另一个平行实现的 Claude 客户端。在手机上发一条提示词、批准一次工具调用、切一次模型或思考强度，底层都要等价于坐在电脑前敲终端。「Web 还缺什么功能」的默认动作是去找 CLI 的原生实现对接，不在桥接层私造平行逻辑。

 
    01 
#### 驱动同源

经官方 Agent SDK 驱动本机的 `claude` 二进制，不自写工具循环；CLI 怎么配（官方订阅、API key、第三方网关）就怎么用。
 
    02 
#### 配置同源

`settingSources: ['user','project','local']`，按 CLI 的配置分层继承，并按工作区目录加载。
 
    03 
#### 会话同源

transcript 统一在 `~/.claude/projects/`，与 CLI `/resume` 指向同一份记录文件。
 
 

## 终端里的事，手机上怎么做

| 终端里 | 手机上 |
| --- | --- |
| 工具审批（y / n） | 审批卡：允许 / 拒绝 / 中止本轮（对齐 Esc ）；可勾「总是允许」，选仅本会话或永久 |
| AskUserQuestion | 选项直接点；多选、「其他…」自己填、「跳过并中止本轮」都在 |
| claude / --resume | 顶栏 + 新建（选工作区、分支、是否开在新 worktree）；侧栏列出该工作区全部会话 |
| /model 、权限档、思考强度 | 底栏 chip 点开就改，下一条起效；思考强度在回合进行中也能切 |
| @ 引用文件、 / 斜杠命令 | 输入 @ 搜工作区文件；输入 / 列候选，含你装的 skills。只能在终端里用的命令不进手机菜单；会话中途命令变化时同步到手机 |
| /rewind 与分叉 | /rewind 两步面板（Web 上是分叉出新会话，原会话不动）；assistant 气泡常驻「分叉」入口 |
| statusline、后台任务 | 底栏常驻摘要；任务横幅显示耗时与用量，可单独停掉某一个，完成后能查看 CLI 落盘的输出 |
| 终端里开着的会话 | 能看，也能接着驾驶；同一时刻只有一个驾驶端，接管时会提示 |

## 权限放行：不注入 allowedTools

创建 SDK 实例时**不注入** `options.allowedTools`，放行集合完全来自 settings 里 `permissions.allow` 的并集，与终端 CLI 的逻辑相同：

| 层级 | 触发 | 处理 |
| --- | --- | --- |
| settings permissions.allow | 命中用户配置 | SDK 直接放行，不触发 canUseTool ，手机不弹窗 |
| canUseTool 回调 | 白名单外的操作 | 由 CCM 按当前权限档决定放行、拒绝，或推到手机弹审批卡 |
| 「总是允许」 | 审批时勾选 | 「仅本会话」只改本会话、不落盘；「永久」把 CLI 给出的建议规则原样交回 SDK，按各自目的地写进 CLI 自己的 settings（实测为工作区的 .claude/settings.local.json ），CCM 不另建白名单 |

「设置」里有审批规则的只读面，能看到哪些工具不弹审批。

> **WARNING:** 公网暴露前的安全审查 — 公网暴露前，仔细检查 ~/.claude/settings.json 与各工作区的 settings。终端里长期积累的过宽 Bash(...) 放行规则，手机连上之后同样会自动放行，不会弹窗二次确认。手机端安全体检会列出其中的危险项。

## 六档权限模式

运行时支持六档，可随时切换，差分决定是否调 `setPermissionMode`：

| 模式 | 语义 | 实现要点 |
| --- | --- | --- |
| default （Manual） | 危险操作弹审批卡 | 与 CLI 默认交互等价 |
| plan | 只规划，不执行工具 | 与 CLI Plan 模式一致 |
| acceptEdits | 自动放行文件编辑类操作 | 对齐 CLI |
| dontAsk | 白名单外一律拒绝，不弹窗 | CLI 的非交互严格档，原样透传给 SDK；白名单外在终端层直接拒绝，不走 canUseTool |
| auto | 由模型分类器判定批准或拒绝 | 对接 SDK 的自动判权 |
| bypassPermissions | 跳过审批 | 给 SDK 映射为 default ，由 CCM 的闸门直接放行，避免传全局危险标志；从 bypass 降档立即在本地生效，不等 SDK 回包 |

## 模型与思考强度

模型与思考强度都能在底栏随时切换。思考强度的档位分两层（语义以产品仓 `docs/display-contracts.md` 为准）：

- SDK 档： low 、 medium 、 high 、 xhigh 、 max ，真正传给 Agent SDK。
- UI 额外的档： ultracode 等于 xhigh 加 Settings.ultracode: true ，只在支持 xhigh 的模型上出现； auto 用模型内置的默认档，对齐 CLI 的 /effort auto （dev 已合入，尚未发版）；「没指定」继承 settings 里为该模型存的档。 auto 与「没指定」是两档，不能互相冒充。
- 切换路径： 具体档与 auto 经控制请求（ applyFlagSettings ）即刻生效，不重建实例，回合进行中也能切；切回「没指定」没有对应的控制请求，要重开实例。

新会话（FRESH）默认采用 CLI 设置合并后的基线，与直接新起命令行一致。
