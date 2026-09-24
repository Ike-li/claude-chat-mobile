# 术语表
> instance、envelope、mirror、TOFU 等高频词。

- **Part**: 第三部分 · 方法论
- **Reading Time**: ~6 min
- **Estimated Tokens**: ~1753

---

高频专有名词与概念定义。阅读核心实现前，建议先通读本表，拉齐心智模型与语境。

| 核心术语 | 定义与架构语义 |
| --- | --- |
| instanceId | 运行时代号（如 inst_1 ），代表内存里一个活跃的 AgentSession 实例。实例重建（dispose + resume）时换新；切具体思考强度走控制请求，不重建实例。 |
| sessionId | Claude CLI 原生会话标识，对应磁盘上 ~/.claude/projects/ / .jsonl 的文件名。 |
| epoch | 实例世代标识。服务端置换实例后自增，客户端收到新 epoch 必须重置去重基线。 |
| seq | 单实例生命周期内单调递增的事件序号，用于断线后 sync:since 的增量补发。 |
| agent:event 信封 | 唯一的出向事件信封： {seq, epoch, sessionId, instanceId, cwd, ts, type, payload} ； type 白名单在 protocol.js （31 种）。 |
| 驾驶端 / 单驾驶员 | 同一会话同一时刻只有一个写入方：Web 的 AgentSession，或终端里的 CLI。另一端只读镜像，接管要显式续接，可能分叉。 |
| mirrorReadonly | 单驾驶员模型的只读镜像锁：终端在驾驶时，Web 端输入被锁住。 |
| externalDirty | 外部变脏标记：磁盘 transcript 已经超前于内存里的 SDK 会话，Web 下次发送前要先 dispose 旧实例再 resume 吸收。 |
| terminalWaiting | 终端等待态：终端 CLI 在会话注册表里自报 waiting ，也就是停在审批或提问上。抽屉的会话行与目录行会标出来，折叠着也看得见；它不进顶栏的「需要你」聚合，要即时通知得靠可选的 hooks bridge。 |
| 尾部归因（Tail Attribution） | 判断会话尾部那条未完结记录是谁写的。transcript 逐条自报写入方（CLI 写 cli ，本项目 SDK 写 sdk-ts ）；镜像锁的静默判定只认终端写的尾部。 |
| entrypoint-marker | CCM 往 claude 的 jsonl 里追加的唯一一行，让终端的 /resume 看得到 Web 建的会话。这是「CCM 不存消息」原则的唯一反向例外。 |
| 设备审批（TOFU） | 首次信任：持正确令牌的新设备首次接入仍要批准一次，可在电脑终端、菜单栏或另一台已信任设备上批。本机样 Host 的直连与已过 Cloudflare Access 的连接默认免审批， DEVICE_APPROVAL_SCOPE=all 时也要批。 |
| ACCESS_PROFILE | 「打算怎么从手机访问」的纯声明（ cloudflare / vpn / reverse-proxy / direct / lan ），不改运行时行为，只供 doctor 与手机端安全体检做针对性检查。鉴权分支按请求的 Host 决定，与它无关。 |
| BIND_MODE | 监听地址模式：默认 0.0.0.0 ， loopback 只听本机， custom 配合 BIND_HOST 。缺令牌时不存在降级绑本机的路径。 |
| CCM_DATA_DIR | 控制面数据根，默认仓库下的 ./data ，长期实例建议设成仓库外的绝对路径；存会话索引、已读位点、设备信任、审批台账、审计、附件与缓存。 |
| 「需要你(N)」 | 顶栏 chip 与角标只表达点一下就能处理的待办：审批与提问。服务告警是另一条轴，只出现在抽屉「服务」小节与服务状态面板。 |
| canUseTool | SDK 的权限回调。命中 settings 放行规则的调用根本不会走到这里；只有白名单外的调用才由 CCM 按权限档裁决或推审批卡。 |
| 环形缓冲（Ring Buffer） | 每个实例的事件循环队列，上限 2000 条（ BUFFER_CAP ），支撑重连补发；瞬态进度不进缓冲。 |
| settingSources | SDK 加载配置的层级，固定为 ['user', 'project', 'local'] ，按工作区目录继承 CLI 配置。 |
| applyFlagSettings | 运行时设置控制请求。切具体思考强度档与 auto 时用它即刻生效，不销毁实例。 |
| /rewind （Web 语义） | 对齐终端的两步回退面板；Web 上涉及对话的模式都是分叉出一个回到那一刻的新会话，原会话不动，与终端的原地回退是两套语义。 |
| guard-host-tests | 宿主机测试白名单钩子：agent 在宿主机上只能跑 lint / check / test:unit / test:e2e 这几档，其余测试一律进容器。它防手滑，不是物理隔离。 |
