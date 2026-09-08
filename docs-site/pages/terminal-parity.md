# 终端等价性
> CLI 有什么 Web 就有什么；权限与配置同源。

- **Part**: 第三部分 · 方法论
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~1747

---

Claude Chat Mobile 的核心产品目标是终端等价：终端 CLI 有什么，移动端 Web 就有什么。实现上不重造 Agent 调度，而是直接由 Agent SDK 驱动本机已登录的 `claude` CLI，并共用同一套配置、权限与 Transcript 历史。

## 等价原则与心智模型

 
当你不知道某个功能该怎么做时：CLI 有什么 web 就有什么，先去找 claude code CLI 是怎么实现的。—— `CLAUDE.md`
 

本项目不是远程桌面投屏，更不是另一个平行实现的 Claude 客户端。在手机上发送一条提示词、批准一次工具调用、切换一次模型或调整思考强度，在底层必须等价于坐在电脑前直接敲击终端命令。任何「Web 还需要什么新功能」的需求，默认动作是寻找 CLI 原生实现进行对接，严禁在桥接层私造平行逻辑。

 
    01 
#### 驱动同源

依托官方 Agent SDK 与本机已登录的 `claude` 二进制建立 IPC 通信，而非自写工具循环。
 
    02 
#### 配置同源

`settingSources: ['user','project','local']`，完整遵循 CLI 的配置分层继承顺序。
 
    03 
#### 会话同源

Transcript 统一持久化在 `~/.claude/projects/`，与 CLI `/resume` 指向完全一致的记录文件。
 
 

## 配置加载与权限体系

系统启动 Agent 时显式声明：

```
settingSources: ['user', 'project', 'local']
```

这意味着用户在电脑端 `~/.claude/settings.json` 或当前项目 `.claude/settings.json` 中配置的自定义规则、API 环境变量、自定义 MCP 服务器和 Hooks 会自动对 Web 端生效。

## 权限放行：绝不注入 allowedTools

在创建 SDK 实例时，系统**坚决不注入** `options.allowedTools`。放行集合完全依托于 settings 中 `permissions.allow` 的并集（与终端 CLI 逻辑逐字相同）：

| 层级 | 触发行为 | 处理策略 |
| --- | --- | --- |
| settings permissions.allow | 与用户本地配置命中 | SDK 内部底层直接放行，不触发 canUseTool 回调，手机不弹窗 |
| canUseTool 拦截闸 | 未在白名单中的操作（如非只读 Bash） | 由 CCM 捕获，根据当前权限档位决定直接放行、拒绝或推送到手机界面弹窗审批 |
| 桥接层自设规则 | 禁止建立独立的白名单配置 | 严格避免 Web 端与 CLI 终端规则分叉 |

> **WARNING:** 公网暴露前的安全审查 — 公网暴露服务前，必须仔细审查全局 ~/.claude/settings.json。如果在终端中长期积累了过宽的 Bash(...) 自动放行规则，移动端连接后同样会自动放行，而不会弹窗二次确认。

## 六档权限模式

系统在运行时支持 6 档权限模式（通过 `setPermissionMode` 动态切换）：

| 模式枚举 | 语义与行为 | 与 CLI 的对应关系 |
| --- | --- | --- |
| default | 默认安全档：白名单外操作通过 canUseTool 弹出手机卡片审批 | 与 CLI 默认交互行为完全等价 |
| plan | 计划模式：禁止破坏性写操作，仅允许规划与只读探索 | 与 CLI Plan 模式语义一致 |
| acceptEdits | 接受编辑档：自动放行常规文件修改与编辑工具 | 对齐 CLI 接受编辑档位 |
| bypassPermissions | 跳过审批档：给 SDK 映射为 default，由 CCM 内部直接放行，避免传全局危险标志 | 等价于 CLI --dangerously-skip-permissions |
| dontAsk | 静默拒绝档：白名单外工具一律自动拒绝，手机绝不弹窗打扰 | Web 独有安全档，CLI Transcript 不会产生此标记 |
| auto | 自动模型裁决档：依托 SDK 内部模型分类器自动判定批准或拒绝 | 对接 SDK 实验性智能判权特性 |

## 模型切换与思考强度 (effort) 控制

用户可以在移动端输入框随时切换活跃模型（如 Sonnet / Opus / Haiku / Fable）与思考强度（`effort`）。得益于 SDK 升级，思考强度支持通过 `applyFlagSettings({effortLevel})` 运行时即刻生效，无需销毁重建实例。新开会话（FRESH）默认采用 CLI 设置合并后的基线配置，保证与直接新起命令行体验完全一致。
