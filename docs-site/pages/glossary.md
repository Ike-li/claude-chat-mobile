# 术语表
> instance、envelope、mirror、TOFU 等高频词。

- **Part**: 第三部分 · 方法论
- **Reading Time**: ~6 min
- **Estimated Tokens**: ~1112

---

高频专有名词与概念定义。在阅读系统核心实现前，建议先快速通读本表，以拉齐心智模型与语境。

| 核心术语 | 标准定义与架构语义 |
| --- | --- |
| instanceId | 运行时代号（如 inst_1 ），代表内存中活跃的 AgentSession 实体。每次会话重启或切换思考强度时递增。 |
| sessionId | Claude CLI 原生会话标识符，对应磁盘 ~/.claude/projects/ / .jsonl 文件名。 |
| epoch | 实例世代标识。当服务端置换实例后自增，客户端收到新 epoch 必须重置消息去重基准。 |
| seq | 单实例生命周期内单调递增的事件序号，用于网络闪断后的 sync:since 增量补发与断点续传。 |
| agent:event Envelope | 统一出向事件信封，标准外壳： {seq, epoch, sessionId, instanceId, cwd, ts, type, payload} 。 |
| mirrorReadonly | 单驾驶员模型中施加的只读互斥锁。当终端正在执行写入时，Web 端强制处于只读态。 |
| externalDirty | 外部变脏标记。指磁盘 Transcript 已经超前于内存 SDK 会话，Web 端下次发送必须强制销毁置换。 |
| terminalWaiting | 终端等待态。指终端 CLI 正在执行耗时工具（如跑测试）且尚未落盘，提示 Web 端保持镜像锁锁定。 |
| Tail Attribution | 尾部归因。在识别会话繁忙状态时，准确将悬挂的在途消息归因为「Web 自身」还是「外部终端/桌面端」。 |
| TOFU (Trust On First Use) | 首次接入信赖机制。新外部设备即使持有正确 Token，首次连接也必须在物理电脑上显式点击批准。 |
| ACCESS_PROFILE | 网络接入拓扑声明（ cloudflare , reverse-proxy , lan ），决定反代采信与设备审批分支。 |
| CCM_DATA_DIR | 持久化数据根目录（仓库根下 data/ ），管理会话元数据、设备指纹、附件上传与审计日志。 |
| canUseTool | SDK 权限回调拦截点。当操作未命中预设白名单时，触发向手机端投递 permission_request 。 |
| Ring Buffer (环形缓冲) | 每实例分配的循环事件队列，固定上限 2000 条，支撑高速重连补发。 |
| settingSources | SDK 加载本地配置的层级，固定为 ['user', 'project', 'local'] ，完整继承命令行配置。 |
| applyFlagSettings | 运行时标志应用机制。无需销毁实例，直接中途热修改 SDK 的 effortLevel 思考强度。 |
| guard-host-tests | 测试运行保护门禁。宿主机只允许运行只读或纯内存测试脚本，其余所有测试强制在容器沙箱中跑。 |
