# 会话与历史
> sessions.json、transcript 冷读、worktree 会话发现。

- **Part**: 第四部分 · 核心实现
- **Reading Time**: ~12 min
- **Estimated Tokens**: ~1112

---

会话数据存在清晰的双层事实源（SoT）：Web 端元数据保存在 `data/sessions.json`；而完整的对话记录则保存在 CLI Transcript（jsonl）中。理清两者边界是理解系统持久化的关键。

## 双层事实源 (Double SoT)

| 层次 | 物理存储路径 | 负责记录的内容 | 生命周期特性 |
| --- | --- | --- | --- |
| 元数据 SoT | $CCM_DATA_DIR/sessions.json | 各工作区当前激活会话、会话自定义标题、模型与权限档记忆、隐藏列表、跨设备已读位点 | 受控于 CCM 控制面，丢失仅影响界面展示偏好 |
| 消息正文 SoT | ~/.claude/projects/ / .jsonl | 完整对话历史、ToolUse 参数、命令输出、Token 开销全量快照 | 与本机 claude CLI 共享；CCM 仅作读写追加，绝不篡改历史格式 |

## 会话发现与 Worktree 触达

- 会话发现机制。 优先调用 SDK listSessions ，当遇到文件锁或异常时平滑回落扫盘，并与 sessions.json 元数据深度合并。
- Git Worktree 隔离与触达。 系统通过 git worktree list 动态感知各个 Worktree 分支。合法工作目录包含显式配置的 WORKDIRS 本身及其合法 Worktree。当主仓库被移出配置时，其衍生 Worktree 即刻失效。
- 父子目录归属过滤。 SDK 的目录检索会向下匹配子目录导致混入，系统通过针对 Transcript 真实路径的精准过滤，确保每个会话严格归属于其对应的分支工作区。

## 冷启动与实例恢复

1. FRESH（新建独立会话）。 通过 session:new 触发，或者在空首页直接键入第一条消息。不会盲目继承上次残留的复杂权限，保证与直接新起命令行体验完全一致。
2. Resume（恢复已有会话）。 点击历史会话切入，先执行 prepareSessionForWebResume 解除后台冲突，再基于原有 sessionId 恢复 SDK 会话。
3. 空闲实例自动回收 (Idle Reclaim)。 当会话持续空闲超过 INSTANCE_IDLE_RECLAIM_MS （默认 30 分钟）后，系统平滑断开 SDK 进程释放系统内存；磁盘 Transcript 永久保留，下次用户在手机端发言时自动无感 Resume。

## 会话分层删除策略

- L1 隐藏 (Hide)。 在移动端左滑点击隐藏，仅在 sessions.json 中打上隐藏标记，磁盘 Transcript 保持完好，可随时通过 CLI 重新找回。
- L2 彻底物理销毁 (Delete)。 物理移除磁盘文件。执行前受严格保护：如果会话活跃时间在静默窗口内（ SESSION_DELETE_QUIET_MS 默认 5 分钟），或检测到仍有活体终端连接，拒绝删除，防止误删电脑端正在跑的任务。
