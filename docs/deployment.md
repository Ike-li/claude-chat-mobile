# 部署与运维：常驻服务 + 固定公网入口

> 本文给出一套常驻部署参考：macOS LaunchAgent 常驻 + Cloudflare Tunnel 固定域名 + Cloudflare Access 双因素。
>
> 下文用占位符 `<your-domain>`、`<your-team>`、`<UUID>` 等，替换为你自己的值。Linux/systemd 用户把 LaunchAgent 部分换成 systemd unit，思路一致。

## 架构

```
手机 → <your-domain>  →  Cloudflare 边缘（Access 验 2FA）  →  命名隧道  →  localhost:3000 → server
```

- **公网入口**：固定域名，Cloudflare Access 把守（Email OTP 或 Google/Microsoft 2FA），公网**不带 `#token=`**。
- **两个常驻进程**（随登录自启、崩溃自重启、关终端不掉）：
  - server：`node server.js`，**经登录 shell（`zsh -lc` / `bash -lc`）启动**，保证 claude 的 PATH / 登录态与你终端一致。
  - tunnel：`cloudflared` 命名隧道，把 `:3000` 投到公网域名。
- **鉴权分层**：公网走 Access JWT（服务端 `src/auth/cf-access.js` fail-closed 校验）；局域网/本机 `http://<lan-ip>:3000/#token=…` 仍走 `AUTH_TOKEN`。
  > ⚠️ **反代拓扑会静默关掉设备审批层**。设备指纹审批按 socket 直连 peer 的 IP 判定「本机」。本配方里 Cloudflare 隧道在 `localhost:3000` 落地，连接显成 `127.0.0.1`，但公网路径已由 Access JWT 兜底，所以可接受。**若你换成任何在本机落地的其他反代**（nginx/Caddy 的 `proxy_pass localhost`、SSH 端口转发、frp 等），所有客户端都会显成本机，设备审批层会被跳过，**防线只剩 `AUTH_TOKEN`**。这类拓扑下务必设强 `AUTH_TOKEN`，不要指望设备审批纵深。

## ⚠️ 最容易忘的一点

生产实例由常驻服务占着 3000 端口，**不要再手动 `npm start`**（会撞端口）。改了 `.env` 或拉了新代码后，**重启 server 进程**才生效：

```bash
# macOS LaunchAgent
launchctl kickstart -k gui/$(id -u)/<your-server-label>
# systemd
systemctl --user restart <your-server-service>
```

💡 若已设 `DEV_MODE=1`（见 `.env.example`），web 端齿轮面板会出现「重启服务」按钮，可免上电脑一键 kickstart（优雅退出后由 LaunchAgent/systemd 的 KeepAlive 自动拉起）——生产对外部署建议留空该变量，避免误触重启对外服务。

## 从零搭建

### 1. 隧道（Cloudflare Tunnel）

```bash
cloudflared tunnel login                          # 浏览器选你的域名 zone
cloudflared tunnel create <tunnel-name>           # 生成 <UUID>.json 凭据
cloudflared tunnel route dns <tunnel-name> <your-domain>   # 建代理 CNAME
# 写 ~/.cloudflared/config.yml：
#   tunnel: <UUID>
#   credentials-file: ~/.cloudflared/<UUID>.json
#   ingress:
#     - hostname: <your-domain>
#       service: http://localhost:3000
#     - service: http_status:404
```

> ⚠️ `~/.cloudflared/<UUID>.json` 与 `cert.pem` 是凭据，**勿提交/泄露**。

### 2. Access（Cloudflare Zero Trust 控制台）

1. Zero Trust → Access → Applications → Add → **Self-hosted**，域填 `<your-domain>`。
2. 登录法选 **One-time PIN（Email OTP）** 或接 Google/Microsoft IdP。
3. 策略 Allow 指定邮箱。
4. 取应用的 **AUD tag**，连同 team 名填进项目 `.env`：
   ```
   CF_ACCESS_HOSTNAME=<your-domain>
   CF_ACCESS_TEAM=<your-team>
   CF_ACCESS_AUD=<aud-tag>
   ```
5. **登录有效期（Session Duration）**：过一次 OTP 后多久内免重复验（默认约 24h）。改法：Zero Trust → Access → Applications → 选中该应用 → **Configure / Edit → Session Duration**，下拉选 15 分钟 ~ 1 个月，或「No duration, expires immediately」每次都验；某条 Policy 内也能单独设，覆盖应用级。
   > 换浏览器 / 无痕窗口 / 清除站点数据都会**重新触发 OTP**——Access 会话是按浏览器隔离的 `CF_Authorization` cookie，与这个时长无关（同浏览器、没清数据、未过期才免验）。

### 3. 常驻（macOS LaunchAgent 示例）

仓库 `deploy/` 下有三份**占位符 plist 模板**，复制、替换占位符后放到 `~/Library/LaunchAgents/`：

- [`deploy/server.plist.template`](../deploy/server.plist.template) —— `node server.js`，经 `zsh -lc 'cd <repo> && exec <node> server.js'` 登录 shell 启动（保 PATH/登录态与终端一致），`RunAtLoad`+`KeepAlive`，stdout/stderr 合并到 `~/Library/Logs/`。
- [`deploy/tunnel.plist.template`](../deploy/tunnel.plist.template) —— `cloudflared tunnel run <tunnel-name>`（读 §1 写好的 `~/.cloudflared/config.yml`）。
- [`deploy/log-rotate.plist.template`](../deploy/log-rotate.plist.template) —— 每天 03:47 跑 `scripts/rotate-logs.sh` 做日志轮转（copy-truncate：launchd 持 O_APPEND fd，rename 式的 newsyslog/logrotate 转出来的新文件永远是空的，机制见脚本头注；默认超 20MB 才转、gzip 保留 5 份）。

每份模板顶部的 XML 注释列出占位符（`__LABEL__`/`__REPO__`/`__NODE__`/`__LOG__` 等）与一行可直接跑的 `node scripts/render-plist.js` 替换示例（字面量替换 + XML 转义，不用裸 `sed`——审计 TC-009：路径若含空格/`&`/`#`/引号等特殊字符，裸 `sed` 可能破坏替换或生成非法 plist）。替换后加载：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<your-server-label>.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<your-tunnel-label>.plist
```

> LaunchAgent 在**登录后**启动。若要"开机未登录也跑"（headless），需要改成 root LaunchDaemon。

#### 控制面数据放在仓库外

`CCM_DATA_DIR` 是受支持的状态根目录；不设置时仍兼容 `./data`。常驻部署建议把它设为绝对路径，避免切分支、清理仓库或测试脚本碰到生产状态：

```bash
mkdir -p "$HOME/Library/Application Support/claude-chat-mobile/data"
chmod 700 "$HOME/Library/Application Support/claude-chat-mobile" \
  "$HOME/Library/Application Support/claude-chat-mobile/data"

# 写入项目 .env（示例值请换成你的绝对路径）
CCM_DATA_DIR=/Users/you/Library/Application Support/claude-chat-mobile/data
```

目录保存 CCM 的会话指针/偏好、设备信任、审批、审计、推送和缓存，文件应保持 `0600`。Claude 原始 transcript 仍在 `~/.claude/projects/`，不会迁入这里；上传附件仍在各工作目录的 `.ccm-uploads/`。迁移前停止常驻服务并备份，迁移后运行 `node scripts/doctor.js` 再重启。`scripts/device.js`、server 与 doctor 都读取同一 `CCM_DATA_DIR`。

### 4. 通知（可选：ntfy + 深链）

移动端锁屏 / 息屏时，Web Push 在 iOS 上受限（须先"添加到主屏幕"、且局域网 http 下不可用）。配 ntfy 可绕开：server 端一行 POST 到 ntfy 服务，手机装 ntfy app 订阅 topic 即收锁屏通知。全在启动 shell 或 `.env` 注入：

```
NTFY_URL=https://ntfy.example.com   # 你自托管的 ntfy 实例
NTFY_TOPIC=<私密-topic>
NTFY_TOKEN=<可选：私有实例的访问令牌>
PUBLIC_URL=https://<your-domain>    # 点通知深链回该会话；留空回退 CF_ACCESS_HOSTNAME
```

- 不配 ntfy 则优雅缺席、仍走 Web Push。
- ⚠️ 通知正文可能含命令 / 审批详情 → 务必**自托管 ntfy 或用私密 topic + `NTFY_TOKEN`**，勿用公共 `ntfy.sh` 的裸 topic。
- 改这些 env 后须**重启常驻 server 进程**才生效（见下「运维速查」的 `kickstart`）。

## 运维速查

```bash
# 实时日志（轮转归档在同目录 <name>.0.gz…<name>.4.gz，最新的是 .0）
tail -f ~/Library/Logs/<your-server-log>.log

# 重启 / 停 / 起（macOS）
launchctl kickstart -k gui/$(id -u)/<your-server-label>
launchctl bootout    gui/$(id -u)/<your-server-label>
launchctl bootstrap  gui/$(id -u) ~/Library/LaunchAgents/<your-server-label>.plist

# 是否在跑（有 "PID" = 在跑）
launchctl list <your-server-label> | grep -E '"PID"|LastExitStatus'

# 临时本地调试：先让出 3000，调完再 bootstrap 回去
launchctl bootout gui/$(id -u)/<your-server-label>
npm start
```

## 排错速查

| 现象 | 处理 |
|---|---|
| 公网 502 / 1033 | server 没跑：看 server 日志、重启；或隧道挂了：看 tunnel 日志 |
| OTP 登录过了但 app 连不上 | JWT 校验失败：server 日志搜「Access JWT 校验失败」，核对 `.env` 的 `CF_ACCESS_TEAM/AUD` 与 CF 应用是否一致 |
| 手机进不去登录页 | 检查 DNS / 隧道日志有无 `Registered tunnel connection` |
| 改了 `.env` 不生效 | 忘了重启 server 进程（见上方「最容易忘的一条」） |
| 公网 1033 且部署机开着全局代理/VPN | 代理的 TUN 模式劫持了 `cloudflared` 到 Cloudflare edge 的出站连接：先临时关闭系统代理/VPN 复测确认；长期共存则在代理软件里给 `cloudflared` 进程或 `*.trycloudflare.com` / `*.cloudflareaccess.com` / 你的隧道域名配置直连(bypass)规则 |
| 经第三方网关报 `model_not_found` | 模型名可能需后缀（如 `<model>[1m]`）：在启动 shell `export ANTHROPIC_MODEL=<带后缀名>` 后重启，或 web 端 `/model <带后缀名>` 切换（`.env` 里的 `ANTHROPIC_*` 启动期被剥除，配置只能来自 shell） |
| 回复只有工具卡片、无正文 | 网关可能不流式 → `src/agent/agent.js` `map()` 已有全文兜底；仍复现则带 `LOG_STDERR=1` 看子进程日志 |


## 最简替代（仅测试用）

不想搭固定域名时，用随机隧道临时对外（每次地址变、官方仅测试用）：

```bash
cloudflared tunnel --url http://localhost:3000
# 手机打开 https://<随机域名>.trycloudflare.com/#token=<你的 AUTH_TOKEN>
```

此时不启用 Access（`CF_ACCESS_*` 留空），鉴权纯靠 `AUTH_TOKEN`。
