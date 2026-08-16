# 部署与运维：常驻服务 + 固定公网入口

> 本文给出一套常驻部署参考：macOS LaunchAgent 常驻 + Cloudflare Tunnel 固定域名 + Cloudflare Access 双因素。
>
> 下文用占位符 `<your-domain>`、`<your-team>`、`<UUID>` 等，替换为你自己的值。Linux/systemd 用户把 LaunchAgent 部分换成 systemd unit，思路一致。

首次本地安装先看[首次使用指南](getting-started.md)；Web/CLI 双通道与单驾驶员边界见[架构说明](architecture.md)。

## 架构

```
手机 → <your-domain>  →  Cloudflare 边缘（Access 验 2FA）  →  命名隧道  →  localhost:3000 → server
```

- **公网入口**：固定域名，Cloudflare Access 把守（Email OTP 或 Google/Microsoft 2FA），公网**不带 `#token=`**。
- **两个常驻进程**（随登录自启、崩溃自重启、关终端不掉）：
  - server：`node server.js`，**经登录 shell（`zsh -lc` / `bash -lc`）启动**，保证 claude 的 PATH / 登录态与你终端一致。
  - tunnel：`cloudflared` 命名隧道，把 `:3000` 投到公网域名。
- **鉴权分层**：公网走 Access JWT（服务端 `src/auth/cf-access.js` fail-closed 校验）；局域网/本机 `http://<lan-ip>:3000/#token=…` 仍走 `AUTH_TOKEN`。
  > 设备审批不会只凭 socket peer 是 loopback 就跳过：server 还会检查 Host。公网 Host（含 cloudflared/nginx/SSH 反代到 `127.0.0.1`）仍需设备 token；只有真实本机 Host，或已经通过 Cloudflare Access JWT 的连接，才跳过这层。

## ⚠️ 最容易忘的一点

生产实例由常驻服务占着 3000 端口，**不要再手动 `npm start`**（会撞端口）。改了配置或拉了新代码后，**重启 server 进程**才生效：

```bash
# macOS LaunchAgent
launchctl kickstart -k gui/$(id -u)/<your-server-label>
# systemd
systemctl --user restart <your-server-service>
```

💡 若已设 `DEV_MODE`（见 `.env.example` 的配置项说明），web 端齿轮面板会出现「重启服务」按钮，可免上电脑一键 kickstart（优雅退出后由 LaunchAgent/systemd 的 KeepAlive 自动拉起）——生产对外部署建议留空该变量，避免误触重启对外服务。

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
4. 取应用的 **AUD tag**，连同 team 名填进项目 `ccm.config.json`（三项必须同时设置或同时留空）：
   ```json
   {
     "CF_ACCESS_HOSTNAME": "<your-domain>",
     "CF_ACCESS_TEAM": "<your-team>",
     "CF_ACCESS_AUD": "<aud-tag>"
   }
   ```
5. **登录有效期（Session Duration）**：过一次 OTP 后多久内免重复验（默认约 24h）。改法：Zero Trust → Access → Applications → 选中该应用 → **Configure / Edit → Session Duration**，下拉选 15 分钟 ~ 1 个月，或「No duration, expires immediately」每次都验；某条 Policy 内也能单独设，覆盖应用级。
   > 换浏览器 / 无痕窗口 / 清除站点数据都会**重新触发 OTP**——Access 会话是按浏览器隔离的 `CF_Authorization` cookie，与这个时长无关（同浏览器、没清数据、未过期才免验）。
6. **给 PWA 图标开 Bypass**，否则 Android 装出来的是快捷方式而不是真应用（见下方「Android PWA 装成快捷方式」）。

### 2b. Android PWA：图标必须对匿名可达

装到 Android 主屏有两种结果，差别很大：

| | WebAPK（真应用） | Shortcut（快捷方式） |
|---|---|---|
| 长按图标 | 有 ⓘ 应用信息 | 只有「移除」 |
| 系统设置里 | 独立条目 | 点进去是 Chrome |
| 通知 / 存储 | 独立管理 | 全归 Chrome 名下 |

**WebAPK 不是本地生成的**：Chrome 把 manifest 和**图标 URL** 交给 Google 的云端 minting server，由它打包签名一个真 APK 再装回来。这台服务器是匿名的、不可能有 `CF_Authorization` cookie——所以只要 Access 拦住了 `/icons/*`，它抓到的就是一张 HTML 登录页而非 PNG，打包失败，Chrome **静默回退**成 shortcut，不报任何错。

判断当前处于哪种状态（这比看长按菜单权威）：

```bash
# 部署机上跑，模拟 Google 服务器视角。要的是 image/png；
# 返回 text/html 就是被 Access 拦了 → 现在装出来必然是 shortcut
curl -sSL -o /dev/null -w "%{http_code} %{content_type}\n" https://<your-domain>/icons/icon-192.png
```

手机侧：Chrome 地址栏输 `chrome://webapks`，列表里有本应用才是 WebAPK。

**修法**——给图标建一条 Bypass 应用（Access 按最长路径优先，它会覆盖根应用的 2FA 策略，其余路径不受影响）：

Zero Trust → Access → Applications → Add → Self-hosted，Domain 填 `<your-domain>`、Path 填 `icons`，策略选 **Bypass / Everyone**。路径应用自动覆盖其下所有子路径，不用写 `/*`。

> 策略生效有**传播延迟**：刚建完立刻 `curl` 多半还是 `text/html`，等几十秒到一两分钟再测。别据此以为没配对。

> **暴露面**：公网能拿到的只有那几张图标（外加你若一并放行 `manifest.webmanifest` 时的应用名与主题色）。不涉及任何数据、会话或 API 通道。代价是站点用途对外可见——域名本身已能从 CT log 查到，实际增量很小。
>
> `manifest.webmanifest` 一般**不必**放行：Chrome 读它时带 cookie（`index.html` 里 `<link rel="manifest" crossorigin="use-credentials">` 就是干这个的），只有图标是服务器去抓的。先只放行 `icons`，仍失败再补。

改完必须**删掉主屏图标重新安装**——Chrome 缓存了失败结果，不会自己重试。

### 3. 常驻（macOS LaunchAgent）

四个 unit 都能一条命令装好，**不用碰 plist**：

```bash
npm run service:install -- server      # node server.js，RunAtLoad + KeepAlive
npm run service:install -- tunnel      # cloudflared tunnel run（读 §1 的 config.yml）
npm run service:install -- logrotate   # 每天 03:47 轮转日志
npm run service:install -- menubar     # 桌面控制台随登录自启（可选）
npm run service:status                 # 装了哪些、在不在跑、有没有漂移
```

macOS 桌面控制台里勾「开机自启（菜单栏）」走的是同一条路径。装出来的 label 固定是 `com.ccm.<unit>`。

<details>
<summary>手工渲染 plist（想自己掌控内容时）</summary>

仓库 `deploy/` 下有四份**占位符 plist 模板**——它们同时是上面 `service:install` 的数据源
（`scripts/service.js:71` 直接读它们渲染），不是可以删掉的文档附件。

- [`deploy/server.plist.template`](../deploy/server.plist.template) —— `node server.js`，经 `zsh -lc 'cd <repo> && exec <node> server.js'` 登录 shell 启动（保 PATH/登录态与终端一致），`RunAtLoad`+`KeepAlive`，stdout/stderr 合并到 `~/Library/Logs/`。
- [`deploy/tunnel.plist.template`](../deploy/tunnel.plist.template) —— `cloudflared tunnel run <tunnel-name>`（读 §1 写好的 `~/.cloudflared/config.yml`）。
- [`deploy/log-rotate.plist.template`](../deploy/log-rotate.plist.template) —— 每天 03:47 跑 `scripts/rotate-logs.sh` 做日志轮转（copy-truncate：launchd 持 O_APPEND fd，rename 式的 newsyslog/logrotate 转出来的新文件永远是空的，机制见脚本头注；默认超 20MB 才转、gzip 保留 5 份）。
- [`deploy/menubar.plist.template`](../deploy/menubar.plist.template) —— `/usr/bin/open CCM.app`。刻意不设 `KeepAlive`（设了的话用户从菜单点「退出」会被 launchd 立刻拉起，再也关不掉）。

每份模板顶部的 XML 注释列出占位符与一行可直接跑的 `node scripts/render-plist.js` 替换示例（字面量替换 + XML 转义，不用裸 `sed`——审计 TC-009：路径若含空格/`&`/`#`/引号等特殊字符，裸 `sed` 可能破坏替换或生成非法 plist）。替换后加载：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccm.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccm.tunnel.plist
```

⚠️ **label 一定要用 `com.ccm.<unit>`。** `service:status`、`adopt`、桌面控制台**只扫 `com.ccm.*`
前缀**，换个前缀装出来的那份它们看都看不到——手工装完再用工具装一次，就是两个 LaunchAgent
抢同一个端口，而工具只报告得出其中一个。手工装好之后跑一次
`npm run service:adopt -- server` 让工具接管（只写 manifest，一个字节都不碰 plist）。

</details>

> LaunchAgent 在**登录后**启动。若要"开机未登录也跑"（headless），需要改成 root LaunchDaemon。

#### 控制面数据放在仓库外

`CCM_DATA_DIR` 是受支持的状态根目录；不设置时仍兼容 `./data`。常驻部署建议把它设为绝对路径，避免切分支、清理仓库或测试脚本碰到生产状态：

```bash
mkdir -p "$HOME/Library/Application Support/claude-chat-mobile/data"
chmod 700 "$HOME/Library/Application Support/claude-chat-mobile" \
  "$HOME/Library/Application Support/claude-chat-mobile/data"

# 写进项目配置（示例值请换成你的绝对路径）
# ccm.config.json: { "CCM_DATA_DIR": "/Users/you/Library/Application Support/claude-chat-mobile/data" }
```

目录保存 CCM 的会话指针/偏好、设备信任、审批、审计、推送和缓存，文件应保持 `0600`。Claude 原始 transcript 仍在 `~/.claude/projects/`，不会迁入这里；上传附件仍在各工作目录的 `.ccm-uploads/`。迁移前停止常驻服务并备份，迁移后运行 `node scripts/doctor.js` 再重启。`scripts/device.js`、server 与 doctor 都读取同一 `CCM_DATA_DIR`。

### 4. 通知（可选：ntfy + 深链）

移动端锁屏 / 息屏时，Web Push 在 iOS 上受限（须先"添加到主屏幕"、且局域网 http 下不可用）。配 ntfy 可绕开：server 端一行 POST 到 ntfy 服务，手机装 ntfy app 订阅 topic 即收锁屏通知。全在启动 shell 或配置文件注入：

```
NTFY_URL=https://ntfy.example.com   # 你自托管的 ntfy 实例
NTFY_TOPIC=<私密-topic>
NTFY_TOKEN=<可选：私有实例的访问令牌>
PUBLIC_URL=https://<your-domain>    # 点通知深链回该会话；留空回退 CF_ACCESS_HOSTNAME
```

- 不配 ntfy 则优雅缺席、仍走 Web Push。
- ⚠️ ntfy 的**正文恒最小化**（不含命令、参数、问题正文或 summary——`previewBody` 只发给 Web Push，见 `src/server/app.js` 的 notify 分发）；但**标题会带工作区目录名**（`basename(cwd)`），且明文经第三方。故仍务必**自托管 ntfy 或用私密 topic + `NTFY_TOKEN`**，勿用公共 `ntfy.sh` 的裸 topic。
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
| OTP 登录过了但 app 连不上 | JWT 校验失败：server 日志搜「Access JWT 校验失败」，核对配置里的 `CF_ACCESS_TEAM/AUD` 与 CF 应用是否一致 |
| 手机进不去登录页 | 检查 DNS / 隧道日志有无 `Registered tunnel connection` |
| Android 装的 PWA 长按只有「移除」、系统设置点进去是 Chrome | 装成了 shortcut 而非 WebAPK：Access 拦了 `/icons/*`，Google 打包服务器抓不到图标。见 §2b，给图标加 Bypass 后删图标重装 |
| 改了配置不生效 | 忘了重启 server 进程（见上方「最容易忘的一条」） |
| 公网 1033 且部署机开着全局代理/VPN | 代理的 TUN 模式劫持了 `cloudflared` 到 Cloudflare edge 的出站连接：先临时关闭系统代理/VPN 复测确认；长期共存则在代理软件里给 `cloudflared` 进程或 `*.trycloudflare.com` / `*.cloudflareaccess.com` / 你的隧道域名配置直连(bypass)规则 |
| 经第三方网关报 `model_not_found` | 模型名可能需后缀（如 `<model>[1m]`）：在启动 shell `export ANTHROPIC_MODEL=<带后缀名>` 后重启，或 web 端 `/model <带后缀名>` 切换（配置文件里的 `ANTHROPIC_*` 启动期被剥除，只能来自 shell） |
| 回复只有工具卡片、无正文 | 网关可能不流式 → `src/agent/agent.js` `map()` 已有全文兜底；仍复现则带 `LOG_STDERR=1` 看子进程日志 |


## 最简替代（仅测试用）

不想搭固定域名时，用随机隧道临时对外（每次地址变、官方仅测试用）：

```bash
cloudflared tunnel --url http://localhost:3000
# 手机打开 https://<随机域名>.trycloudflare.com/#token=<你的 AUTH_TOKEN>
```

此时不启用 Access（`CF_ACCESS_*` 留空），鉴权纯靠 `AUTH_TOKEN`。

## 看日志的两条路（都可选，都只在 macOS）

同名不同物，别混：

| | `LOG_TERMINAL`（下面这节） | 桌面控制台的「查看日志」 |
|---|---|---|
| 由谁开 | **server 自己**，每次启动时 | 你在 app 里点的时候 |
| 窗口是什么 | 真的 Terminal.app 窗口，里面跑 `tail -f` | app 内嵌的滚动视图，2 秒刷新读文件尾 |
| 需要授权 | 要，系统「自动化」控制终端 | 不要 |
| server 挂了还能用吗 | 不能（它靠 server 启动时去开） | 能，日志文件还在就读得到 |

想要「一开机就有个窗口在滚日志」用 `LOG_TERMINAL`；只是偶尔查一下用桌面控制台。

### `LOG_TERMINAL`：server 启动时自动开 Terminal 窗口

常驻部署的日志写进文件（`~/Library/Logs/ccm-server.log`），要看得先自己 `tail -f`。在配置里设
`LOG_TERMINAL` 后，server 每次启动会自动开一个 Terminal 窗口跟随该日志，停止/重启时自动关掉它：

```bash
node scripts/config.js set LOG_TERMINAL=on    # 默认关闭
node scripts/config.js set LOG_FILE=/绝对/路径 # 不设 = ~/Library/Logs/ccm-server.log
```

（直接改 `ccm.config.json` 也行：`"LOG_TERMINAL": true`。JSON 里写布尔值，
落到进程环境时会由 schema 归一成这个键实际认的字面量。）

- **仅 macOS**（靠 osascript 驱动 Terminal.app）；Linux 留空即可，设了会打一行"已跳过"。
- **首次会弹系统「自动化」授权框**，需允许控制「终端」；拒绝后 server 照常跑，只是开不出窗口（日志会提示怎么开）。
- 只关自己开的那个窗口（按窗口 id 记在 `<CCM_DATA_DIR>/log-terminal.json`），绝不碰你自己的终端窗口。
- 窗口里带一个看门狗：server 被 `kill -9` 或崩掉时，窗口内的 `tail` 会自行退出并留一行「server 已停止」，
  不会假装还在跑；那个窗口会在下次启动时被清掉。
