# 环境变量参考
> 从 ccm.config.json 与 env-schema 核对的配置表。

- **Part**: 第七部分 · 参考与规范
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~1163

---

配置体系以仓库顶级根目录的 `ccm.config.json`（单一真相源 Schema 由 `app/src/ops/env-schema.js` 定义）与 `config-file.js` 为准。传统 `.env` 仍受向后兼容支持，新文件存在时优先。

## 核心配置项全览

| 配置键名 | 默认值 / 类型 | 功能与安全语义 | 生效与重载机制 |
| --- | --- | --- | --- |
| AUTH_TOKEN | 必填随机字符串 | 核心共享密钥；未配置时服务恒定只绑定 127.0.0.1 | 需重启生效 |
| PORT | 3000 (number) | 服务监听端口 | 需重启生效 |
| ACCESS_PROFILE | lan (enum) | 网络拓扑： cloudflare （Cloudflare 隧道）、 reverse-proxy （纯反代）或 lan | 需重启生效 |
| WORKDIRS | [] (string[]) | 工作区白名单路径数组 | 支持热重载 (Hot Reload) ，修改保存即刻生效 |
| TRUSTED_PROXY | '' / 'loopback' (enum) | 采信 loopback 反代追加的 X-Forwarded-For 末跳（AUTH-04）；默认空不采信任何头 | 需重启生效 |
| CCM_DATA_DIR | ./data (path) | 持久化控制面数据根目录（建议生产外置绝对路径） | 需重启生效 |
| CLAUDE_BIN | which claude (path) | 本机 claude CLI 可执行二进制物理路径 | 需重启生效 |
| IDLE_TIMEOUT_MS | 600000 (ms) | 长耗时无输出任务的静默看门狗超时时间（默认 10 分钟） | 需重启生效 |
| INSTANCE_IDLE_RECLAIM_MS | 1800000 (ms) | 空闲 AgentSession 内存回收超时时间（默认 30 分钟） | 需重启生效 |
| APPROVAL_TTL_MS | 1800000 (ms) | 移动端工具审批卡片未决定的失效过期超时 | 需重启生效 |
| NOTIFY_THROTTLE_MS | 60000 (ms) | 同一会话连续通知的防轰炸抑制窗口 | 需重启生效 |
| CF_ACCESS_HOSTNAME / CF_ACCESS_TEAM / CF_ACCESS_AUD | 空 (string) | Cloudflare Access 三项配置，三项同时设置或同时留空 | 需重启生效 |
| VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT | 空 (string) | Web Push 协议所需的公私钥与联系主题，三项全齐才启用 | 需重启生效 |
| NTFY_URL / NTFY_TOPIC / NTFY_TOKEN | 空 (string) | ntfy 服务的地址、主题与私有凭据 | 需重启生效 |

## CLI 配置管理工具

在无头（Headless）服务器上，推荐通过官方 CLI 脚本统一管理配置，避免手写 JSON 产生语法错误：

```
node scripts/config.js get <KEY>           # 读取配置项值（秘密值默认打码）
node scripts/config.js get <KEY> --reveal  # 明文读取 Token 等机密信息
node scripts/config.js set <KEY> <VALUE>   # 经过 Schema 严格校验后写入配置
node scripts/config.js check               # 校验当前配置是否符合 Schema 规范
```
