# 数据全景
> CCM_DATA_DIR、transcript、上传与忽略态文件。

- **Part**: 第五部分 · 数据与集成
- **Reading Time**: ~12 min
- **Estimated Tokens**: ~1741

---

控制面状态、CLI transcript、附件与内存态在物理上分属不同位置。备份与清理磁盘前，先分清「CCM 受管的控制面数据」与「CLI 原生记录」。

## 存储全景

| 位置 | 是什么 | 性质 |
| --- | --- | --- |
| $CCM_DATA_DIR/sessions.json | 会话索引与指针：各工作区当前会话、模型 / 权限档 / 思考强度等偏好 | 持久；不存对话正文，可从 transcript 重建 |
| …/read-state.json | 已读位点，跨设备共享 | 持久；丢了只是未读标记重新亮起 |
| …/approval-requests.json | 工具审批台账 | 持久审计记录；执行闸门以内存判权为准，重启时挂着的审批不可再执行 |
| …/trusted-devices.json | 已信任的设备 | 核心安全状态；删了之后所有设备都要重新批准 |
| …/pending-devices.json | 等待批准的新设备 | 临时待审队列 |
| …/device-profiles.json | 设备元数据：机型、浏览器、别名 | 持久；只影响设备的显示名 |
| …/push-subscription.json | Web Push 订阅 | 持久；存浏览器的推送订阅（endpoint 与加密密钥），不存设备令牌 |
| …/audit-records.json | 安全审计：限速锁定、越界访问、设备审批与吊销、删除被拒等 | 持久；只经鉴权后的 audit:get 读取，不开 HTTP 端点 |
| …/uploads/ / | 手机上传的附件原件 | 持久；经 additionalDirectories 交给 CLI，免审批读取 |
| …/service-events.json 、 service-snapshot.json | 重启记录与服务状态快照 | 运维用，供服务状态面板的重启记录与 flapping 判定 |
| …/init-cache.json 、 cf-access-certs.json | 启动水合缓存、Access 公钥缓存 | 缓存：可随时删除，损坏就当作没有 |
| ccm.config.json （仓库根） | 统一结构化配置 | 由 config-file.js 统管；与 .env 同等敏感，已在 .gitignore 里；不在源码归档里，覆盖升级碰不到 |
| ~/.claude/projects/ /*.jsonl | 对话 transcript：完整对话与工具执行记录 | 由本机 claude CLI 维护，不随 CCM 搬家；CCM 只追加一行 entrypoint-marker |
| ~/.claude/ccm/hooks-v1/ | hooks bridge 的文件投递箱（装了才有） | 加速触发器；server 消费后删除，过期文件定期清理；transcript 仍是真相源 |
| 内存环形缓冲（2000 条） | 近期事件信封，按 seq + epoch 编号 | 进程易失，断线重连时按序补发 |

没有设置 `CCM_DATA_DIR` 时，数据根是仓库下的 `./data`。长期跑着的实例建议设成仓库外的绝对路径，免得切分支、清理仓库或测试脚本碰到生产状态。

> **WARNING:** 附件已完成搬家 — 早期附件位于各工作区的 .ccm-uploads/。2026-09-06 起统一落在 $CCM_DATA_DIR/uploads/，不再往用户的 git 仓库写文件；旧目录既不迁移也不删除，历史消息预览会自动回落过去读。

## 备份边界

 
   
    
#### CCM 控制面（$CCM_DATA_DIR）

    
管「Web 端怎么看待会话、哪些设备被授权、附件放在哪」。丢了会让设备需要重新批准、界面偏好回到默认，但不会破坏聊天记录本身。

   
   
    
#### CLI transcript（~/.claude/projects/）

    
管「说了什么、执行了什么、花了多少」。由 CLI 原生写入，CCM 只读取追平，外加那一行 `entrypoint-marker`。注意 Claude Code 会按修改时间清理 30 天前的 transcript。

   
 

## 迁移与灾备

- 迁移数据目录： 先停掉 server（桌面端菜单或 headless 那个终端）并备份，拷贝 $CCM_DATA_DIR ，在 ccm.config.json 里写上新的 CCM_DATA_DIR ，跑一遍 node scripts/doctor.js ，再按原入口拉起。 scripts/device.js 、server 与 doctor 都读同一个 CCM_DATA_DIR 。
- 权限： 数据目录文件保持 0600 ，目录 0700 ，防本机其他用户读取。
- 卸载： npm run uninstall 只删产品自己装的东西，manifest 之外的 unit、 ~/.cloudflared 与 ~/.claude/projects 永远不碰。
- 测试隔离： 破坏性测试与变异检查一律进容器，容器里的 HOME 是一次性目录，真实数据碰不到。
