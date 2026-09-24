# 环境变量参考
> 从 ccm.config.json 与 env-schema 核对的配置表。

- **Part**: 第七部分 · 参考与规范
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~2483

---

配置统一放在仓库根的 `ccm.config.json`，Schema 的单一事实源是 `app/src/ops/env-schema.js`，读写与类型归一在 `app/src/ops/config-file.js`。旧版 `.env` 仍受支持：新文件存在时优先，缺失才回落。环境变量始终压过配置文件。下表只列常用项，完整清单以 `node scripts/config.js schema` 的输出为准。

## 核心配置项

| 配置键名 | 默认值 / 类型 | 功能与安全语义 | 生效方式 |
| --- | --- | --- | --- |
| AUTH_TOKEN | 必填随机字符串（面板只读） | 访问令牌。留空服务拒绝启动，任何访问都要令牌，本机也一样；更换请在电脑上跑 npm run setup | 需重启 |
| PORT | 3000 | 监听端口 | 需重启 |
| BIND_MODE / BIND_HOST | 空（= 对外监听 0.0.0.0 ） | loopback ：只监听 127.0.0.1，自己用 SSH / Tailscale / 反代转发； lan ：对外监听； custom ：配合 BIND_HOST 指定地址，填 :: 为 IPv6 双栈。缺令牌时没有降级绑本机的路径 | 需重启 |
| ACCESS_PROFILE | 空（未声明） | 声明从手机怎么访问： cloudflare / vpn / reverse-proxy / direct / lan 。纯声明，不改变运行时行为；doctor 与手机端安全体检据此做针对性检查。托管隧道归 reverse-proxy | 需重启 |
| WORKDIRS | 列表（绝对路径或 {path, sessionLimit} ） | 工作区白名单， 第一项就是手机端默认打开的目录 。不能填家目录本身，也不能填 / 、 /Users 、 /home 这类过宽的根。旧的单值 WORK_DIR 已并入首项；旧版 WORK_DIRS_FILE 指向外部 workdirs.json ，挂着时拒写 WORKDIRS | 热加载 ：改完即生效，被移除目录上已开的会话继续运行、仅拒新开 |
| DEVICE_APPROVAL_SCOPE | 空 | 默认：经 Cloudflare Access 验过的连接跳过设备审批。 all ：所有路径都要审批，含 Access 与本机样 Host；用 ssh -R 、frp tcp 这类纯 TCP 转发暴露时必需，因为 Host 是客户端自己填的头 | 需重启 |
| TRUSTED_PROXY | 空 | 默认不采信任何转发头，反代下所有公网客户端共用一个登录限速桶； loopback ：采信 loopback 反代追加的 X-Forwarded-For 末跳（AUTH-04）。只决定限速分桶，不参与鉴权 | 需重启 |
| CCM_DATA_DIR | ./data | 控制面数据根（会话指针、设备信任、审批、审计、推送、附件、缓存），建议生产外置为仓库外的绝对路径。它不在 Schema 里：可写进 ccm.config.json 或设为环境变量，但 config set 与面板写不了 | 需重启 |
| CLAUDE_BIN | 空（从 PATH 查找） | claude 可执行文件路径 | 需重启 |
| FILE_EDIT | 开 | 内置文件编辑器直写。它 不经过 Agent 的工具审批链 （有范围校验、大小限制、哈希冲突检测与审计）；设 off 关闭，长期公网暴露建议关 | 需重启 |
| CCM_AUTO_CONTINUE_AT_LIMIT | 开（dev 已合入，尚未发版） | 撞上用量额度墙后，到重置时刻自动发一句「继续」。重置点远于 24 小时只给按钮；上游只回 429、不给重置时间时无法自动继续；等待期间重启服务会作废。设 0 关闭，撞墙时仍有按钮可点 | 需重启 |
| IDLE_TIMEOUT_MS | 600000（10 分钟） | 无输出判挂死 | 需重启 |
| INSTANCE_IDLE_RECLAIM_MS | 1800000（30 分钟） | 空闲 AgentSession 实例回收；0 为不回收 | 需重启 |
| APPROVAL_TTL_MS | 1800000（30 分钟） | 审批卡未决定时自动过期 | 需重启 |
| NOTIFY_THROTTLE_MS | 60000 | 同类通知最小间隔，可显式设为 0 | 需重启 |
| SESSION_DELETE_QUIET_MS | 300000（5 分钟） | 彻底删除会话前的静默期，可显式设为 0 | 需重启 |
| PUBLIC_URL | 空 | 通知深链用的公网地址。配了 Cloudflare Access 时留空回退到它的域名；Tailscale / 反代 / 直连必须填手机可达的 https 地址，否则通知能收到、点开不跳转 | 需重启 |
| CF_ACCESS_HOSTNAME / CF_ACCESS_TEAM / CF_ACCESS_AUD | 空 | Cloudflare Access 三项，三项同时设置或同时留空；留空即整层关闭 | 需重启 |
| VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT | 空 | Web Push 的公私钥与联系主题，三项全齐才启用 | 需重启 |
| NTFY_URL / NTFY_TOPIC / NTFY_TOKEN | 空 | ntfy 的地址、主题与私有凭据；标题带工作区与会话标题，请自托管或用私密 topic | 需重启 |

## 几条读写规则

- 优先级： shell 环境变量 > 配置文件 > 内置默认。 ANTHROPIC_* 只认真实的 shell export 或 CLI settings 文件的 env 块；写进 ccm.config.json / .env 会在启动期被剥除，并在启动日志里逐个点名。
- 读写同源： 面板与 CLI 写入的文件必须与启动时读的是同一份，写错源不报错而是「假成功」。 CCM_CONFIG_FILE_PATH / CCM_ENV_FILE_PATH 可覆盖配置文件路径，启动侧与写入侧都认。
- 未登记的键读宽写严： 读取侧原样放进 process.env （claude 子进程继承， HTTPS_PROXY 、 CLAUDE_CONFIG_DIR 这类才有效）；写入侧只认 Schema 登记过的可写键。
- 迁移是显式动作： 没有代码路径会自动创建 ccm.config.json ，只有 setup 与 config migrate 会写。

## CLI 配置管理工具

在无头服务器上，推荐用配置 CLI 统一管理，避免手写 JSON 出错：

```
node scripts/config.js schema              # 打印当前全部配置项定义
node scripts/config.js get <KEY>           # 读取配置项（秘密值默认打码）
node scripts/config.js get <KEY> --reveal  # 明文读取令牌等秘密值，须显式带 --reveal
node scripts/config.js set <KEY> <VALUE>   # 经 Schema 校验后写入
node scripts/config.js unset <KEY>
node scripts/config.js check               # 校验当前配置
node scripts/config.js migrate             # 从旧版 .env 迁到 ccm.config.json
```
