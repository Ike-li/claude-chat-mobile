# 部署与运维：公网入口 + 两条启动路径

> 启动只有两条入口，互不相关：
>
> 1. **headless**：终端里 `npm start`（全平台基线）。进程怎么保活（tmux / 自己的 systemd / docker）自己定，本仓库不提供官方 unit。
> 2. **macOS desktop**：`CCM.app`。常驻、崩溃拉起、看日志、改配置、重启都在菜单里。
>
> 下文的 Tunnel / Access 是公网怎么进来，不是第三条启动方式。
>
> 占位符 `<your-domain>`、`<your-team>`、`<UUID>` 换成你自己的值。

首次本地安装先看[首次使用指南](getting-started.md)；Web/CLI 双通道与单驾驶员边界见[架构说明](architecture.md)。

## 架构

```
手机 → <your-domain>  →  Cloudflare 边缘（Access 验 2FA）  →  命名隧道  →  localhost:3000 → server
```

- **公网入口**：固定域名，Cloudflare Access 把守（Email OTP 或 Google/Microsoft 2FA），公网**不带 `#token=`**。
- **两个要一直跑着的进程**（桌面端会帮你拉；headless 自己保持）：
  - server：`node server.js`，**经登录 shell（`zsh -lc` / `bash -lc`）启动**，保证 claude 的 PATH / 登录态与你终端一致。
  - tunnel：`cloudflared` 命名隧道，把 `:3000` 投到公网域名。
- **鉴权分层**：公网走 Access JWT（服务端 `src/auth/cf-access.js` fail-closed 校验）；局域网/本机 `http://<lan-ip>:3000/#token=…` 仍走 `AUTH_TOKEN`。
  > 设备审批不会只凭 socket peer 是 loopback 就跳过：server 还会检查 Host。公网 Host（含 cloudflared/nginx/SSH 反代到 `127.0.0.1`）仍需设备 token；只有真实本机 Host，或已经通过 Cloudflare Access JWT 的连接，才跳过这层。

> **Cloudflare 是默认路径，不是硬依赖。** `CF_ACCESS_*` 三项留空即整层关闭，server 侧零改动，
> 换加密隧道、自建反代或只用局域网都能跑。各拓扑的明文可见方、CCM 侧的连带变化与通用配置要点，
> 见 [不用 Cloudflare 的公网入口](#不用-cloudflare-的公网入口)。

## ⚠️ 最容易忘的一点

桌面端一旦把 server 拉起来，3000 就被占着，**不要再手动 `npm start`**。改了配置或拉了新代码后，从菜单里 server 一行点「重启」。

headless 没有桌面端：在跑 `npm start` 的那个终端里停掉再起。

💡 若已设 `DEV_MODE`（配置项说明见 `node scripts/config.js schema`），web 端齿轮面板会出现「重启服务」按钮，可免上电脑一键重启——只适合本机调试，生产对外部署建议留空，避免误触。

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

### 3. 让 server 一直跑着

**macOS 走桌面端。** `npm run app:install` 把 `CCM.app` 装进 `/Applications`，用菜单安装并启动 server，需要的话再勾「开机自启（菜单栏）」。不要把下面的 `service:install` 当成第三条入口——那是桌面端背后的同一条 CLI。

**headless**（Linux，或 Mac 上不用 GUI）：终端里 `npm start`，窗口别关。要关终端也能活，用你自己的保活方式。

桌面端和 `npm start` 都要用户登录后的会话。开机未登录就跑，不在这两条入口里。

<details>
<summary>桌面端背后的 CLI（一般不用手敲）</summary>

菜单里的安装 / 启停调的就是这些命令。SSH 上机器、人不在 GUI 前时才直接跑。

```bash
npm run service:install -- server      # node server.js，RunAtLoad + KeepAlive
npm run service:install -- tunnel      # cloudflared tunnel run（读 §1 的 config.yml）
npm run service:install -- logrotate   # 每天 03:47 轮转日志
npm run service:install -- menubar     # 桌面控制台随登录自启
npm run service:status
```

装出来的 label 固定是 `com.ccm.<unit>`。

</details>

<details>
<summary>手工渲染 plist（想自己掌控内容时）</summary>

仓库 `desktop/launchd/` 下有四份占位符模板，是桌面端 / `service.js` 的数据源（`scripts/service.js` 直接读它们渲染），不是可以删掉的附件。

- [`desktop/launchd/server.plist.template`](../desktop/launchd/server.plist.template) —— `node server.js`，经 `zsh -lc 'cd <repo> && exec <node> server.js'` 登录 shell 启动（保 PATH/登录态与终端一致），`RunAtLoad`+`KeepAlive`，stdout/stderr 合并到 `~/Library/Logs/`。
- [`desktop/launchd/tunnel.plist.template`](../desktop/launchd/tunnel.plist.template) —— `cloudflared tunnel run <tunnel-name>`（读 §1 写好的 `~/.cloudflared/config.yml`）。
- [`desktop/launchd/log-rotate.plist.template`](../desktop/launchd/log-rotate.plist.template) —— 每天 03:47 跑 `scripts/rotate-logs.sh` 做日志轮转（copy-truncate：launchd 持 O_APPEND fd，rename 式的 newsyslog/logrotate 转出来的新文件永远是空的，机制见脚本头注；默认超 20MB 才转、gzip 保留 5 份）。
- [`desktop/launchd/menubar.plist.template`](../desktop/launchd/menubar.plist.template) —— `/usr/bin/open CCM.app`。刻意不设 `KeepAlive`（设了的话用户从菜单点「退出」会被 launchd 立刻拉起，再也关不掉）。

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

#### 控制面数据放在仓库外

`CCM_DATA_DIR` 是受支持的状态根目录；不设置时仍兼容 `./data`。长期跑着的实例建议把它设为绝对路径，避免切分支、清理仓库或测试脚本碰到生产状态：

```bash
mkdir -p "$HOME/Library/Application Support/claude-chat-mobile/data"
chmod 700 "$HOME/Library/Application Support/claude-chat-mobile" \
  "$HOME/Library/Application Support/claude-chat-mobile/data"

# 写进项目配置（示例值请换成你的绝对路径）
# ccm.config.json: { "CCM_DATA_DIR": "/Users/you/Library/Application Support/claude-chat-mobile/data" }
```

目录保存 CCM 的会话指针/偏好、设备信任、审批、审计、推送和缓存，文件应保持 `0600`。Claude 原始 transcript 仍在 `~/.claude/projects/`，不会迁入这里；上传附件仍在各工作目录的 `.ccm-uploads/`。迁移前先停掉 server（桌面端菜单或 headless 那个终端）并备份，迁完跑 `node scripts/doctor.js` 再按原入口拉起。`scripts/device.js`、server 与 doctor 都读取同一 `CCM_DATA_DIR`。

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
- 改这些 env 后须**重启 server** 才生效（见下「运维速查」）。

## 运维速查

按你用的那条入口操作，不要手敲 `launchctl`。

```bash
# headless：停掉当前 npm start，再起
# 桌面端：菜单里 server 一行点「重启」；日志用「查看日志」

# 人在 SSH 里、服务却是桌面端装的（不是第三条入口）
npm run service:status
npm run service:restart -- server
npm run service:logs -- server
node scripts/service.js stop server
node scripts/service.js start server
```

<details>
<summary>service.js 失灵时（直接问 launchd）</summary>

工具自己坏了才走这里。label 必须是 `com.ccm.<unit>`，见上面手工装那节。

```bash
launchctl print gui/$(id -u)/com.ccm.server
launchctl kickstart -k gui/$(id -u)/com.ccm.server
launchctl bootout    gui/$(id -u)/com.ccm.server
launchctl bootstrap  gui/$(id -u) ~/Library/LaunchAgents/com.ccm.server.plist
```

</details>

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


## 不用 Cloudflare 的公网入口

`CF_ACCESS_HOSTNAME/TEAM/AUD` 三项留空时，`src/auth/cf-access.js` 整层关闭（`isPublicHost` 恒 false），
server 不需要任何代码改动。本节只给判断依据和 CCM 侧的硬约束，各方案自身的安装配置以其官方文档为准。

选定方案后建议声明 `ACCESS_PROFILE=vpn|reverse-proxy|lan`（Cloudflare 用户可声明 `cloudflare`；装机向导
会问这一项，手机「设置」与 `node scripts/config.js set` 也能改）：它是纯声明、不改变任何运行时行为，
但 `doctor` 与手机端安全体检会按它做针对性检查——声明与 `CF_ACCESS_*`/`PUBLIC_URL`/`AUTH_TOKEN`/通知配置
互相矛盾时当场指出，而不是等到用不了才发现。四个值就够覆盖全部拓扑：**托管隧道（ngrok、Quick Tunnel、
Tailscale Funnel…）归 `reverse-proxy`**，判据见下面「托管隧道归哪一档」。

### 收窄监听面：BIND_MODE / BIND_HOST

默认情况下 server 在设了 `AUTH_TOKEN` 时绑 `0.0.0.0`（同 WiFi 的手机可直连），未设时只绑 `127.0.0.1`。
若你打算「本机只开 loopback，公网入口完全由自己转发」（SSH `-L`、Tailscale Serve、反代等），可以显式收窄：

| 配置 | 实际监听 | 适用 |
|---|---|---|
| 不设（默认） | `0.0.0.0` | 绝大多数情况（`AUTH_TOKEN` 是启动前提，没有它 server 直接拒绝启动） |
| `BIND_MODE=loopback` | `127.0.0.1` | 自己用 SSH/Tailscale/反代转发，不想让端口出现在局域网上 |
| `BIND_MODE=lan` | `0.0.0.0` | 显式声明要对外监听（等价于默认，但意图写在配置里） |
| `BIND_MODE=custom` + `BIND_HOST=::` | `::`（IPv4/IPv6 双栈） | 需要 IPv6 访问（默认的 `0.0.0.0` 只监听 IPv4） |
| `BIND_MODE=custom` + `BIND_HOST=<网卡地址>` | 该地址 | 只对某一块网卡开放 |

**不变量**：`AUTH_TOKEN` 是**所有**模式的共同前提，`loopback` 也不例外——本机浏览器打开同样是 web
访问（[hard-rules §1「鉴权是启动前提」](hard-rules.md)）。没有它 **server 拒绝启动**并说明原因，
而不是静默降级成 `127.0.0.1`：后者会让你以为配好了、实际手机全部连不上却毫无提示。
`BIND_MODE` 拼错、或 `custom` 没给 `BIND_HOST`，同样拒绝启动。改这两项都要重启；
`doctor` 与手机端安全体检有单独一项报告当前绑到哪、以及配置会不会导致启动失败。

### 各拓扑的明文可见方

现状下 TLS 在 Cloudflare 边缘终止，那一跳能看到明文对话与代码。若这是要消除的暴露点：

| 拓扑 | 中间节点能看到明文 | 机制 |
|---|---|---|
| Cloudflare Tunnel + Access（现状） | 能：Cloudflare | TLS 在边缘终止后回源 |
| 加密隧道 / VPN（WireGuard、Tailscale tailnet、ZeroTier、Netbird、Headscale…） | 不能 | 端到端加密；中继只转发密文，协调节点只交换公钥 |
| 自建反代（VPS + nginx / Caddy / Traefik，打洞用 frp、SSH `-R`、WireGuard 等） | 能：VPS 主机商 | TLS 在你租的那台机器上终止 |
| 托管隧道（ngrok、Cloudflare Quick Tunnel、Tailscale Funnel、localtunnel…） | **看 TLS 在哪终止**，见下节 | 服务商托管入口，本机跑一个 agent 回连 |
| 不做公网，只用局域网 | 无中间节点 | 手机与 server 同网段直连 |

第三行是事实陈述而非取舍建议：自建反代**更换**了信任对象（Cloudflare → 主机商），不**消除**中间节点。
若目标是消除，只有加密隧道 / VPN 与局域网两类做得到。

### 托管隧道（ngrok / Quick Tunnel / Funnel…）归哪一档

**归 `ACCESS_PROFILE=reverse-proxy`，不新增枚举值。** 判据是下一节那四条连带变化在托管隧道下**逐条相同**：
`CF_ACCESS_*` 留空导致 Access 层整层消失、设备审批自动顶上、TLS 终止在对方那边、
本机 agent 回连 3000 使所有公网客户端的连接 IP 都是 `127.0.0.1` 从而**共用一个限速桶**。
既然判据没有一条不同，多一个枚举值只会多一份要同步维护的检查矩阵。

明文可见方**看 TLS 在哪一跳终止，不看厂商是不是"隧道"**：终止在服务商那边，服务商就能看到明文
（ngrok、Cloudflare Quick Tunnel 都是这样）；终止在你本机，中间只过密文。
具体到某一家请去它自己的文档里确认这一条，别按"它叫隧道所以是加密的"推断——
上表第二行的"不能"成立是因为那类方案本身就是端到端加密的 overlay 网络，不是因为名字里有隧道。

**Tailscale 一个产品名对应两种语义相反的拓扑，这是本节唯一真会让人选错的地方：**

| 用法 | 手机怎么连上 | 声明成 | 有没有公网面 |
|---|---|---|---|
| 设备加入 tailnet | 手机也装 Tailscale，走隧道内地址（`100.64/10`） | `vpn` | 无——未入网的设备根本触达不到 |
| Tailscale Funnel | 任何浏览器打开公开 URL | `reverse-proxy` | **有，全公网可达** |

选错的方向恰好朝放松：`vpn` 不在 doctor 的公网信号集里（`fileEditExposureDiagnostic` 只认
`cloudflare` 与 `reverse-proxy`），于是文件编辑器直写不会提示关闭、体检还会说"入网资格由隧道承担"——
对 Funnel 是假话。手机「设置」里的选项与装机向导都点名了这一条，改声明的时候别按产品名对号入座。

**托管隧道特有的一条：URL 会漂。** Quick Tunnel 和 ngrok 免费档每次启动分配的域名可能不同。
`PUBLIC_URL` 是通知深链的来源（见下节），域名一变就指向失效地址——通知照常送达，点开却打不开。
要长期用，选带固定域名的档位；临时用则每次改 `PUBLIC_URL`，或干脆别配通知。
另外这类入口**没有入网门槛**：URL 泄露即全公网可达，上一段说的"限速桶全塌"在这里比自建反代更值得在意
（自建反代至少还能在入口层加一道认证）。

### 换掉入口后，CCM 侧的四处连带变化

这四条对**所有**非 Cloudflare 方案共通，与选哪种拓扑无关。

| | 现状（Access 开启） | `CF_ACCESS_*` 留空后 |
|---|---|---|
| 公网 2FA | Access JWT，fail-closed | **整层消失**，需自行在入口层补 |
| `AUTH_TOKEN` | LAN/本机走它 | 不变，全部请求走它 |
| 设备审批 | 被 Access 跳过 | **自动顶上**，每台新设备批准一次 |
| 登录限速粒度 | per 真实来源（IPv6 按 /64） | **退化为按连接 IP** |

后两行需要展开：

**设备审批会自己回来。** `shouldBypassDeviceApproval`（`src/auth/rate-limiter.js`）第一行是
`if (accessEnabled) return true`——Access 与设备审批是替代关系而非叠加。失去 Access 不等于防护归零。
反代进来的请求也会被正确判成「非本机」：peer 虽是 `127.0.0.1`，但 Host 是公网域名，不满足 bypass 条件。

**限速桶会合并。** `shouldTrustCfConnectingIp` 要求 `publicHost` 为真，而该条件在三项留空时恒
false，于是 `rlSourceKey` 回落到连接 IP。**反代终止在 loopback 后，所有公网客户端的连接 IP
都是 `127.0.0.1`，共用同一个限速桶**——一个来源试错触发的退避会波及其余客户端。这是刻意取舍
（宁可粒度粗，也不采信可伪造的 `X-Forwarded-For`，见 `rlSourceKey` 头注），不是配置错误，
也无法通过加转发头绕开。VPN 类拓扑不受影响：手机的连接 IP 是隧道内地址，天然分桶。

限速桶还有第二个合并维度，与选哪种拓扑无关：**IPv6 客户端按 /64 前缀归桶**（`ipRateBucket`）。
终端用户拿到的最小分配就是一整个 /64，逐地址计桶等于换个源地址就重置失败计数、暴破限速形同虚设。
代价是同一 /64 内的多台设备共用一个桶——一台连错到阈值会连累同网段其他设备锁 15 分钟。
IPv4 不受影响，仍按整地址分桶。

### 通用落地要点

**共通前提**（三类拓扑都适用）：

- 必须设 `AUTH_TOKEN`。未设时 server **拒绝启动**（hard-rules §1「鉴权是启动前提」），
  不是降级绑 `127.0.0.1`——任何拓扑都得先有令牌。
- PWA 与 Web Push 需要安全上下文（HTTPS，或 `localhost`）。裸 IP 的 `http://` 能正常聊天，
  但装不了 PWA、收不到 Web Push，通知只能退回 ntfy（见上节）。
- `CF_ACCESS_*` 三项留空。配置面板清空时会警告「公网域名退化成只靠 AUTH_TOKEN 校验」
  （`src/ops/env-schema.js` 的 `checkTogether`），这条警告在此处是预期行为。若声明了 `ACCESS_PROFILE`，
  切换方案时面板还会提醒把它一并更新，避免声明指着旧方案。
- **要用通知就必须显式设 `PUBLIC_URL`。** 深链地址是 `PUBLIC_URL` 优先、回落 `CF_ACCESS_HOSTNAME`
  （`src/ops/notify-channels.js:32`）——两个都没有时通知仍正常送达，但**不带 click，点了不跳转**。
  该项的配置说明写的是「留空回退到 CF_ACCESS_HOSTNAME」，对本节场景等同于「留空即没有」。
- **启动日志的「可访问」几行会列出隧道内地址。** 地址枚举（`src/server/http.js` 的 `reachableIPv4s`）
  按**地址段**判定、不看接口名，所以 macOS 上 WireGuard / Tailscale 的 `utun*` 地址会和局域网地址
  一起列出。TUN 代理占用的 RFC 2544 假段（198.18/15）与 link-local 仍被排除。
  隧道地址没出现，说明隧道本身没起来，不是日志不显示它。

**加密隧道 / VPN 类**：server 照常跑在 3000，手机经隧道内地址访问
`http://<隧道内 IP>:3000/#token=<AUTH_TOKEN>`。入网资格由隧道本身承担，未入网的设备根本触达不到端口。
要 PWA / Web Push 则需给隧道内主机名配证书——部分方案自带签发能力，其余需自行处理。

**反向代理类**：Mac 侧用任意方式把 3000 暴露给反代所在主机（frp、SSH `-R`、VPN 内网互通均可），
反代对外终止 TLS。CCM 对反代只有两条硬要求：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    # 硬要求 1：Host 原样透传。设备审批的判据读它，配成空值或写死会打穿这层
    proxy_set_header Host $host;

    # 硬要求 2：WebSocket 升级。Socket.io 靠它，缺了会退化成长轮询或直接连不上
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # 长连接，读超时别设过短（Socket.io 有心跳，但空闲会话仍可能被过短的超时切断）
    proxy_read_timeout 3600s;
}
```

单个 `location /` 全量代理即可，不必为 `/socket.io/` 另开一段。Caddy / Traefik 等价配置同理，
关键仍是这两条。**不要**依赖 `X-Forwarded-For`：CCM 不读该头（理由见上一节），配了不生效。

由于公网 2FA 层已消失，反代层建议自行补一层认证（mTLS、OIDC / forward auth、Basic Auth 等均可），
否则公网只剩 `AUTH_TOKEN` + 设备审批。

**托管隧道类**（同属 `reverse-proxy` 档，归类判据见上文）：不用写上面这段配置——Host 透传与
WebSocket 升级由服务商那端负责，主流几家默认就满足。本机只需 `<工具> http://localhost:3000` 之类的一条命令。
需要额外做的只有两件：`PUBLIC_URL` 填分配到的地址（换了地址要跟着改），以及尽量在入口层加一道
该服务商提供的认证（多数家有 Basic Auth / OAuth 选项，免费档常常没有）——没有的话公网就只剩
`AUTH_TOKEN` + 设备审批，而这个 URL 是任何人打开浏览器就能触达的。

**只用局域网**：不配任何入口，手机与电脑同 Wi-Fi 时访问 `http://<lan-ip>:3000/#token=<AUTH_TOKEN>`。
无中间节点，代价是离开这张网就用不了。

<details>
<summary>把入口选型与配置交给编程 agent</summary>

在仓库目录中把下面内容交给 Claude Code、Codex CLI 或其他本机编程 agent：

```text
帮我给 claude-chat-mobile 配一个不经过 Cloudflare 的公网入口。
先做选型，再落地，不要跳过选型直接开始配。

第一步，先问我这几件事，等我回答后再继续：
- 我有没有可用的 VPS / 公网 IP / 域名？
- 我需不需要 PWA 安装和 Web Push（需要就必须有 HTTPS）？
- 我能不能在手机上装客户端 app（VPN 类方案需要）？
- 我要消除中间节点，还是只要换掉 Cloudflare 就行？这两者结论不同。

第二步，基于回答在这四类拓扑里选一类，说明理由和代价，不要默认选最流行的：
- 加密隧道 / VPN（无中间节点能看到明文）
- 自建反向代理（TLS 终止在我的 VPS 上，主机商能看到明文）
- 托管隧道 ngrok / Quick Tunnel / Tailscale Funnel 等（零运维，但入口在服务商手里，
  免费档地址还会漂；明文可见方看 TLS 在哪终止，去对应文档确认，别假定）
- 只用局域网（无中间节点，出门用不了）

第三步，落地。以下是 CCM 的硬约束，配置必须满足，不满足就是错的：
1. server 监听 3000。AUTH_TOKEN 是启动前提，没设它 server 直接拒绝启动（不是降级绑 127.0.0.1）。
2. 反代必须原样透传 Host 头（nginx 里是 proxy_set_header Host $host;）。
   设备审批的判据读这个头，配成空值或写死会打穿一层防护。
3. 反代必须支持 WebSocket 升级（Upgrade / Connection 头），Socket.io 依赖它。
4. CCM 不读 X-Forwarded-For，配了不生效，不要靠它传递真实来源 IP。
5. CF_ACCESS_* 三项要留空，此时公网 2FA 层关闭、设备审批自动生效。
   如果选了反代类拓扑，提醒我在反代层补一层认证。
6. PWA 与 Web Push 需要 HTTPS 或 localhost，裸 IP 的 http 下不可用。
7. 如果我要用通知，PUBLIC_URL 必须显式设成入口地址。它平时回落 CF_ACCESS_HOSTNAME，
   而这个场景下没有该值，不设就会变成「通知能收到、点击不跳转」。
8. 启动日志里「可访问」那几行会列出所有可达地址，隧道内地址（WireGuard、Tailscale）也在其中。
   如果隧道地址没出现在那里，是隧道没起来，不要绕过它去别处找地址。
9. 配完提醒我声明 ACCESS_PROFILE（vpn / reverse-proxy / lan，托管隧道也是 reverse-proxy），
   doctor 与手机端安全体检按它做针对性检查。注意 Tailscale 分两种：设备进 tailnet 是 vpn，
   用 Funnel 暴露到公网是 reverse-proxy，按产品名对号入座会声明错。

护栏：
- 不要修改本仓库任何源码，这件事纯配置即可完成。
- 不要改 ~/.claude 下的任何文件。
- 不要把 AUTH_TOKEN 写进任何会外传的文件、日志或报告。
- 涉及安装系统级服务、改防火墙、开端口时，先告诉我要做什么，等我确认。
- 配完用鉴权后的 /health JSON 验证连通性，不要只看进程存在或端口监听。
- 第一次从新设备连接后，运行 node scripts/device.js list，让我核对再 approve。

背景与判据见 docs/deployment.md 的「不用 Cloudflare 的公网入口」一节。
```

</details>

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

桌面端把日志写进文件（`~/Library/Logs/ccm-server.log`）；headless 默认打到终端。要文件尾跟随，在配置里设
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
