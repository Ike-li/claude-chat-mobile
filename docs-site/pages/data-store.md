# 数据全景
> CCM_DATA_DIR、transcript、上传与忽略态文件。

- **Part**: 第五部分 · 数据与集成
- **Reading Time**: ~12 min
- **Estimated Tokens**: ~1235

---

控制面状态、CLI Transcript、附件存储与内存态在物理上分属不同目录。备份与清理磁盘前，必须分清「受管控制面数据」与「CLI 原生记录」。

## 存储体系全景

| 数据存储路径 | 职责角色 | 归属与生命周期 |
| --- | --- | --- |
| $CCM_DATA_DIR/sessions.json | 会话控制元数据（当前激活指针、重命名、隐藏列表、跨设备已读位点等） | 持久化元数据；仅存展示偏好，非对话正文 |
| …/approval-requests.json | 工具审批台账记录 | 持久化审计记录（内存执行闸门为真实判权源） |
| …/trusted-devices.json | 已授权设备指纹与签名 Token（TOFU 机制） | 核心安全状态；删除后手机接入需重新在电脑端点击批准 |
| …/pending-devices.json | 等待批准的外部设备连接队列 | 临时待审批列表 |
| …/uploads/ / | 受管附件目录 ：手机端上传的图片与文档原件 | 受管持久化数据；通过 --add-dir 自动授权给 CLI |
| …/audit-records.json | 系统安全审计日志（限速、封禁与越界访问等） | 持久化环形审计 |
| ccm.config.json （仓库顶级根） | 统一结构化配置文件 （端口、Token、工作区、网络拓扑等） | 由 config-file.js 统管； WORKDIRS 支持热重载 |
| ~/.claude/projects/ /*.jsonl | 真实对话 Transcript ：完整对话流与工具执行记录 | 完全由本机 claude CLI 维护，不随 CCM 搬家 |
| 内存 Ring Buffer (2000条) | 在途事件流与近期信封缓存 | 进程易失，用于断线快速补发 |

> **WARNING:** 附件已完成搬家 — 历史版本中附件位于各项目工作区下的 .ccm-uploads/。当前版本已全部统一收敛至受管数据根下的 $CCM_DATA_DIR/uploads/，避免向用户 Git 仓库写入脏文件，旧目录仅作为只读兼容回落。

## 双层事实源 (Double SoT) 与备份边界

 
   
    
#### CCM 控制面 ($CCM_DATA_DIR)

    
管理「Web 端如何看待会话、哪些设备被授权连入、附件文件保存在哪」。丢失仅导致设备需重新认证、会话标题回退，不会破坏聊天事实。

   
   
    
#### CLI Transcript (~/.claude/projects/)

    
管理「历史说了什么、执行了哪些代码、Token 开销多少」。由 CLI 原生写入，CCM 仅执行追平与安全追加。

   
 

## 全量迁移与灾备建议

- 完整迁移清单： 停止服务进程 → 拷贝 $CCM_DATA_DIR → 拷贝 ~/.claude/projects/ → 导出 ccm.config.json 。
- 敏感文件权限防护： 建议配置数据目录文件权限为 0600 ，目录权限为 0700 ，防范本地非特权用户读取。
- 自动化测试沙箱隔离： 执行破坏性测试或运行变异测试时，必须通过 Docker 容器隔离，容器内 HOME 为虚拟空壳，彻底隔绝真实数据。
